// Todoist REST v2 read connector (Task 9a — "tasks" capability, provider 1
// of 2). Auth is a user-pasted "API token" (Todoist Settings -> Integrations
// -> Developer) — there is no OAuth/login flow: the token is validated with
// a cheap `GET /projects` probe and then persisted (encrypted) exactly as
// pasted, the same posture as providers/github.ts's Personal Access Token.
// It is never logged, never included in an error message, and every network
// call accepts an injectable `fetch` so the whole module is testable against
// mocked Todoist REST responses — nothing here ever talks to a live Todoist
// server in tests.
//
// Read-only by construction for v1: every exported read function only ever
// issues GET requests. There is no write path here.
//
// Todoist's REST v2 API has no "who am I" / user-profile endpoint (that only
// exists in the separate Sync API) — so unlike github.ts (which keys its
// upsert on the GitHub login) this connector keys on a fixed
// accountIdentifier ("todoist"), meaning one Todoist connection per AlfyAI
// user, same posture as providers/contacts.ts's generic CardDAV provider.
import { registerConnectionAdapter } from "../adapters";
import type { ConnectionAdapter } from "../registry";
import {
	type ConnectionPublic,
	createConnection,
	findConnectionByAccount,
	getConnection,
	getConnectionSecret,
	setConnectionSecret,
	updateConnection,
} from "../store";

type FetchOpt = { fetch?: typeof fetch };

const REQUEST_TIMEOUT_MS = 15_000;
const API_ROOT = "https://api.todoist.com/rest/v2";
const TODOIST_ACCOUNT_IDENTIFIER = "todoist";

export type TodoistErrorCode =
	| "invalid_token"
	| "invalid_config"
	| "needs_reauth"
	| "not_found"
	| "request_failed"
	| "connection_not_found";

export class TodoistError extends Error {
	constructor(
		message: string,
		public readonly code: TodoistErrorCode,
	) {
		super(message);
		this.name = "TodoistError";
	}
}

// ---------------------------------------------------------------------------
// Shared request plumbing
// ---------------------------------------------------------------------------

// Bounds every Todoist HTTP call to ~15s via AbortController so a
// reachable-but-hung API endpoint can't stall a chat turn indefinitely —
// mirrors the same pattern in providers/github.ts/providers/immich.ts.
async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new TodoistError(
				`Todoist request timed out after ${timeoutMs}ms`,
				"request_failed",
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

// The token is sent as a Bearer header (never a query string) so it never
// ends up in server access logs.
function todoistHeaders(token: string): HeadersInit {
	return { Authorization: `Bearer ${token}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Token probe
// ---------------------------------------------------------------------------

async function todoistProbeProjects(
	fetchImpl: typeof fetch,
	token: string,
): Promise<void> {
	let response: Response;
	try {
		response = await fetchWithTimeout(fetchImpl, `${API_ROOT}/projects`, {
			headers: todoistHeaders(token),
		});
	} catch (err) {
		if (err instanceof TodoistError) throw err;
		throw new TodoistError("Could not reach the Todoist API", "request_failed");
	}
	if (response.status === 401) {
		throw new TodoistError("Invalid Todoist API token", "invalid_token");
	}
	if (!response.ok) {
		throw new TodoistError("Could not reach the Todoist API", "request_failed");
	}
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function upsertTodoistConnection(params: {
	userId: string;
	secret: string;
}): Promise<ConnectionPublic> {
	const existing = await findConnectionByAccount(
		params.userId,
		"todoist",
		TODOIST_ACCOUNT_IDENTIFIER,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.secret);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
		});
		if (!updated)
			throw new Error("Failed to update existing Todoist connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "todoist",
			label: "Todoist",
			accountIdentifier: TODOIST_ACCOUNT_IDENTIFIER,
			capabilities: ["tasks"],
			status: "connected",
			secret: params.secret,
			config: {},
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent connect attempt — same pattern as
		// github.ts's/immich.ts's upsert helper.
		const raced = await findConnectionByAccount(
			params.userId,
			"todoist",
			TODOIST_ACCOUNT_IDENTIFIER,
		);
		if (!raced) throw err;
		await setConnectionSecret(params.userId, raced.id, params.secret);
		const updated = await updateConnection(params.userId, raced.id, {
			status: "connected",
			statusDetail: null,
		});
		if (!updated) throw err;
		return updated;
	}
}

export async function todoistConnect(
	params: {
		userId: string;
		token: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	const token = params.token.trim();
	if (!token) {
		throw new TodoistError("An API token is required", "invalid_config");
	}
	const fetchImpl = params.fetch ?? fetch;

	await todoistProbeProjects(fetchImpl, token);

	const connection = await upsertTodoistConnection({
		userId: params.userId,
		secret: token,
	});
	return { connection };
}

// ---------------------------------------------------------------------------
// Authorized request plumbing
// ---------------------------------------------------------------------------

// Loads the connection + decrypted token, marking the connection
// needs_reauth on a 401 before rethrowing — the one chokepoint every
// authorized Todoist call routes through. Never logs or throws the token:
// thrown TodoistError messages are always static strings, and non-2xx
// bodies are never surfaced to the caller (no raw response text is read for
// an error path — only response.status is inspected).
async function todoistAuthorizedRequest(
	userId: string,
	connectionId: string,
	path: string,
	init: RequestInit,
	opts?: FetchOpt,
): Promise<Response> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new TodoistError(
			"Todoist connection not found",
			"connection_not_found",
		);
	}
	const token = await getConnectionSecret(userId, connectionId);
	if (!token) {
		throw new TodoistError(
			"No token stored for this Todoist connection",
			"needs_reauth",
		);
	}
	const fetchImpl = opts?.fetch ?? fetch;

	let response: Response;
	try {
		response = await fetchWithTimeout(fetchImpl, `${API_ROOT}${path}`, {
			...init,
			headers: { ...todoistHeaders(token), ...(init.headers ?? {}) },
		});
	} catch (err) {
		if (err instanceof TodoistError) throw err;
		throw new TodoistError("Failed to reach the Todoist API", "request_failed");
	}
	if (response.status === 401) {
		const detail = "Todoist rejected the stored token";
		await updateConnection(userId, connectionId, {
			status: "needs_reauth",
			statusDetail: detail,
		});
		throw new TodoistError(detail, "needs_reauth");
	}
	return response;
}

// Shared non-2xx -> TodoistError mapping for every read call below. Never
// reads/forwards the response body on an error path — only the static
// `label` and (for 404) a fixed not_found message are ever surfaced, so a
// Todoist-hosted error page or leaked internal detail can never reach the
// model.
function assertOk(response: Response, label: string): void {
	if (response.ok) return;
	if (response.status === 404) {
		throw new TodoistError(
			"That project or task couldn't be found",
			"not_found",
		);
	}
	throw new TodoistError(`${label} failed`, "request_failed");
}

async function parseJson(response: Response, label: string): Promise<unknown> {
	const body = await response.json().catch(() => null);
	if (body === null) {
		throw new TodoistError(
			`${label} returned an unexpected response`,
			"request_failed",
		);
	}
	return body;
}

// ---------------------------------------------------------------------------
// Read — projects
// ---------------------------------------------------------------------------

export type TodoistProject = {
	id: string;
	name: string;
	isFavorite: boolean;
};

function toProject(entry: Record<string, unknown>): TodoistProject | null {
	const id = entry.id;
	const name = entry.name;
	if (typeof id !== "string" && typeof id !== "number") return null;
	if (typeof name !== "string") return null;
	return {
		id: String(id),
		name,
		isFavorite: entry.is_favorite === true,
	};
}

export async function todoistListProjects(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<TodoistProject[]> {
	const response = await todoistAuthorizedRequest(
		userId,
		connectionId,
		"/projects",
		{ method: "GET" },
		opts,
	);
	assertOk(response, "Todoist project list request");
	const body = await parseJson(response, "Todoist project list");
	if (!Array.isArray(body)) {
		throw new TodoistError(
			"Todoist project list returned an unexpected response",
			"request_failed",
		);
	}
	return body
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map(toProject)
		.filter((project): project is TodoistProject => project !== null);
}

// ---------------------------------------------------------------------------
// Read — tasks
// ---------------------------------------------------------------------------

export type TodoistTask = {
	id: string;
	content: string;
	description: string;
	projectId: string;
	priority: number;
	url: string;
	due?: string;
	labels: string[];
};

function toDueDate(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const date = value.date;
	return typeof date === "string" && date ? date : undefined;
}

function toLabels(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((label): label is string => typeof label === "string");
}

function toTask(entry: Record<string, unknown>): TodoistTask | null {
	const id = entry.id;
	const content = entry.content;
	const projectId = entry.project_id;
	const url = entry.url;
	if (
		(typeof id !== "string" && typeof id !== "number") ||
		typeof content !== "string" ||
		(typeof projectId !== "string" && typeof projectId !== "number") ||
		typeof url !== "string"
	) {
		return null;
	}
	const description = entry.description;
	const priority = entry.priority;
	const due = toDueDate(entry.due);
	return {
		id: String(id),
		content,
		description: typeof description === "string" ? description : "",
		projectId: String(projectId),
		priority: typeof priority === "number" ? priority : 1,
		url,
		...(due ? { due } : {}),
		labels: toLabels(entry.labels),
	};
}

function buildQuery(params: Record<string, string | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (!value) continue;
		search.set(key, value);
	}
	const query = search.toString();
	return query ? `?${query}` : "";
}

export async function todoistListTasks(
	userId: string,
	connectionId: string,
	params: { projectId?: string; filter?: string } = {},
	opts?: FetchOpt,
): Promise<TodoistTask[]> {
	const query = buildQuery({
		project_id: params.projectId,
		filter: params.filter,
	});
	const response = await todoistAuthorizedRequest(
		userId,
		connectionId,
		`/tasks${query}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "Todoist task list request");
	const body = await parseJson(response, "Todoist task list");
	if (!Array.isArray(body)) {
		throw new TodoistError(
			"Todoist task list returned an unexpected response",
			"request_failed",
		);
	}
	return body
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map(toTask)
		.filter((task): task is TodoistTask => task !== null);
}

export async function todoistGetTask(
	userId: string,
	connectionId: string,
	taskId: string,
	opts?: FetchOpt,
): Promise<TodoistTask> {
	const response = await todoistAuthorizedRequest(
		userId,
		connectionId,
		`/tasks/${encodeURIComponent(taskId)}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "Todoist task read request");
	const body = await parseJson(response, "Todoist task read");
	if (!isRecord(body)) {
		throw new TodoistError(
			"Todoist task read returned an unexpected response",
			"request_failed",
		);
	}
	const task = toTask(body);
	if (!task) {
		throw new TodoistError(
			"Todoist task read returned an unexpected response",
			"request_failed",
		);
	}
	return task;
}

// ---------------------------------------------------------------------------
// Adapter — a cheap GET /projects confirms the stored token still works,
// without touching any task data.
// ---------------------------------------------------------------------------

async function checkHealth(
	secret: string,
	_conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	try {
		const response = await fetchWithTimeout(fetchImpl, `${API_ROOT}/projects`, {
			headers: todoistHeaders(secret),
		});
		if (response.status === 401) {
			return {
				status: "needs_reauth",
				detail: "Todoist rejected the stored token",
			};
		}
		if (!response.ok) {
			return {
				status: "error",
				detail: `Todoist health check failed with status ${response.status}`,
			};
		}
		return { status: "connected", detail: null };
	} catch (err) {
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// Not annotated as `: ConnectionAdapter` — that would narrow checkHealth's
// call signature to the interface's (secret, conn) shape and break the
// mocked-fetch tests that pass a third `{ fetch }` opts arg, same rationale
// as githubAdapter in providers/github.ts.
export const todoistAdapter = {
	provider: "todoist" as const,
	requiresSecret: true,
	checkHealth,
};

registerConnectionAdapter(todoistAdapter satisfies ConnectionAdapter);
