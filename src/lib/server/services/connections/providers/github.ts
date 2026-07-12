// GitHub (and Gitea/GHE-compatible) read connector (Task 7 — "repos"
// capability). Auth is a user-pasted Personal Access Token (fine-grained or
// classic) — there is no OAuth/login flow: the token itself is validated
// with a cheap `GET /user` probe and then persisted (encrypted) exactly as
// pasted, the same posture as providers/plex.ts's `X-Plex-Token`. It is
// never logged, never included in an error message, and every network call
// accepts an injectable `fetch` so the whole module is testable against
// mocked GitHub REST responses — nothing here ever talks to a live GitHub
// server in tests.
//
// Read-only by construction for v1: every exported read function only ever
// issues GET requests. There is no write path here — not in this issue, and
// not until a later, explicitly confirm-gated follow-up.
//
// Base URL: defaults to `https://api.github.com`. A caller may instead
// supply a custom API root (Gitea, GitHub Enterprise Server) — validated via
// the shared `assertPublicHttpsUrl` SSRF guard (see nextcloud-files.ts),
// exactly like the Immich/Plex/Nextcloud server-URL fields. A custom base
// URL is treated as a "GitHub-compatible API root": this module keeps
// GitHub.com REST semantics (path shapes, response fields) and does not
// special-case Gitea's differences — that's future work if it's ever needed.
import { registerConnectionAdapter } from "../adapters";
import {
	bearerAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";
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
import { assertPublicHttpsUrl } from "./nextcloud-files";

type FetchOpt = { fetch?: typeof fetch };

const DEFAULT_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
// GitHub requires a User-Agent on every request or it 403s unauthenticated-
// looking clients — see https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#user-agent-required
const USER_AGENT = "AlfyAI-Connector";

export type GitHubErrorCode =
	| "invalid_token"
	| "invalid_config"
	| "needs_reauth"
	| "not_found"
	| "request_failed"
	| "connection_not_found";

export class GitHubError extends ConnectionHttpError<GitHubErrorCode> {
	constructor(message: string, code: GitHubErrorCode) {
		super(message, code);
		this.name = "GitHubError";
	}
}

// Timeout error for every GitHub call routed through providerFetch — matches
// the wording the private fetchWithTimeout produced. Call sites already treat
// a thrown GitHubError specially (rethrow unchanged), so a timeout surfaces
// through the same request_failed path.
const githubTimeout = (ms: number) =>
	new GitHubError(`GitHub request timed out after ${ms}ms`, "request_failed");

// ---------------------------------------------------------------------------
// Base URL normalization
// ---------------------------------------------------------------------------

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

// A caller-supplied base URL is fetched server-side with the user's token
// attached, exactly like the Immich/Plex/Nextcloud connector's serverUrl, so
// it needs the same SSRF guard: delegate the https + private/loopback/
// link-local host check to the shared `assertPublicHttpsUrl`. An omitted/
// blank base URL falls back to GitHub.com's own API root.
function normalizeBaseUrl(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return DEFAULT_BASE_URL;
	let validated: string;
	try {
		validated = assertPublicHttpsUrl(trimmed);
	} catch (err) {
		throw new GitHubError(
			err instanceof Error ? err.message : String(err),
			"invalid_config",
		);
	}
	const origin = stripTrailingSlashes(validated);
	return origin || DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------------------
// Shared request plumbing
// ---------------------------------------------------------------------------

// The token is sent as a Bearer header (never a query string) so it never
// ends up in server access logs. `X-GitHub-Api-Version` pins the REST
// response shape this module was written against; `User-Agent` is required
// by GitHub on every request (see USER_AGENT doc comment above).
function githubHeaders(token: string): HeadersInit {
	return {
		...bearerAuthHeader(token),
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": USER_AGENT,
	};
}

function buildQuery(
	params: Record<string, string | number | undefined>,
): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === "") continue;
		search.set(key, String(value));
	}
	const query = search.toString();
	return query ? `?${query}` : "";
}

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
	const requested = limit ?? DEFAULT_LIST_LIMIT;
	if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIST_LIMIT;
	return Math.min(Math.floor(requested), MAX_LIST_LIMIT);
}

// ---------------------------------------------------------------------------
// Token probe
// ---------------------------------------------------------------------------

type GitHubUserResponse = { login: string };

function isValidUserResponse(value: unknown): value is GitHubUserResponse {
	if (!value || typeof value !== "object") return false;
	const login = (value as Record<string, unknown>).login;
	return typeof login === "string" && login.length > 0;
}

async function githubProbeUser(
	fetchImpl: typeof fetch,
	baseUrl: string,
	token: string,
): Promise<GitHubUserResponse> {
	let response: Response;
	try {
		response = await providerFetch(`${baseUrl}/user`, {
			headers: githubHeaders(token),
			fetch: fetchImpl,
			timeoutError: githubTimeout,
		});
	} catch (err) {
		if (err instanceof GitHubError) throw err;
		throw new GitHubError(
			"Could not reach the GitHub API. Check the base URL.",
			"request_failed",
		);
	}
	if (response.status === 401) {
		throw new GitHubError("Invalid GitHub token", "invalid_token");
	}
	if (!response.ok) {
		throw new GitHubError(
			"Could not reach the GitHub API. Check the base URL.",
			"request_failed",
		);
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidUserResponse(body)) {
		throw new GitHubError(
			"GitHub returned an unexpected response",
			"request_failed",
		);
	}
	return body;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export type GitHubConnectionConfig = { baseUrl: string };

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function upsertGitHubConnection(params: {
	userId: string;
	login: string;
	secret: string;
	config: GitHubConnectionConfig;
}): Promise<ConnectionPublic> {
	const existing = await findConnectionByAccount(
		params.userId,
		"github",
		params.login,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.secret);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated)
			throw new Error("Failed to update existing GitHub connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "github",
			label: "GitHub",
			accountIdentifier: params.login,
			capabilities: ["repos"],
			status: "connected",
			secret: params.secret,
			config: params.config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent connect attempt — same pattern as
		// immich.ts's/plex.ts's upsert helper.
		const raced = await findConnectionByAccount(
			params.userId,
			"github",
			params.login,
		);
		if (!raced) throw err;
		await setConnectionSecret(params.userId, raced.id, params.secret);
		const updated = await updateConnection(params.userId, raced.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated) throw err;
		return updated;
	}
}

export async function githubConnect(
	params: {
		userId: string;
		token: string;
		baseUrl?: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	const token = params.token.trim();
	if (!token) {
		throw new GitHubError(
			"A personal access token is required",
			"invalid_config",
		);
	}
	const baseUrl = normalizeBaseUrl(params.baseUrl);
	const fetchImpl = params.fetch ?? fetch;

	const user = await githubProbeUser(fetchImpl, baseUrl, token);

	const connection = await upsertGitHubConnection({
		userId: params.userId,
		login: user.login,
		secret: token,
		config: { baseUrl },
	});
	return { connection };
}

// ---------------------------------------------------------------------------
// Authorized request plumbing
// ---------------------------------------------------------------------------

function githubConfig(conn: ConnectionPublic): GitHubConnectionConfig {
	const baseUrl =
		typeof conn.config.baseUrl === "string" && conn.config.baseUrl
			? conn.config.baseUrl
			: DEFAULT_BASE_URL;
	return { baseUrl };
}

// Loads the connection + decrypted token, marking the connection
// needs_reauth on a 401 before rethrowing — the one chokepoint every
// authorized GitHub call routes through. Never logs or throws the token:
// thrown GitHubError messages are always static strings, and non-2xx bodies
// are never surfaced to the caller (no raw response text is read for an
// error path — only response.status is inspected).
async function githubAuthorizedRequest(
	userId: string,
	connectionId: string,
	path: string,
	init: RequestInit,
	opts?: FetchOpt,
): Promise<Response> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new GitHubError(
			"GitHub connection not found",
			"connection_not_found",
		);
	}
	const token = await getConnectionSecret(userId, connectionId);
	if (!token) {
		throw new GitHubError(
			"No token stored for this GitHub connection",
			"needs_reauth",
		);
	}
	const { baseUrl } = githubConfig(conn);
	const fetchImpl = opts?.fetch ?? fetch;

	let response: Response;
	try {
		response = await providerFetch(`${baseUrl}${path}`, {
			...init,
			headers: { ...githubHeaders(token), ...(init.headers ?? {}) },
			fetch: fetchImpl,
			timeoutError: githubTimeout,
		});
	} catch (err) {
		if (err instanceof GitHubError) throw err;
		throw new GitHubError("Failed to reach the GitHub API", "request_failed");
	}
	if (response.status === 401) {
		const detail = "GitHub rejected the stored token";
		await updateConnection(userId, connectionId, {
			status: "needs_reauth",
			statusDetail: detail,
		});
		throw new GitHubError(detail, "needs_reauth");
	}
	return response;
}

// Shared non-2xx -> GitHubError mapping for every read call below. Never
// reads/forwards the response body on an error path — only the static
// `label` and (for 404) a fixed not_found message are ever surfaced, so a
// GitHub-hosted error page or leaked internal detail can never reach the
// model.
function assertOk(response: Response, label: string): void {
	if (response.ok) return;
	if (response.status === 404) {
		throw new GitHubError(
			"That repository, path, or resource couldn't be found",
			"not_found",
		);
	}
	throw new GitHubError(`${label} failed`, "request_failed");
}

async function parseJson(response: Response, label: string): Promise<unknown> {
	const body = await response.json().catch(() => null);
	if (body === null) {
		throw new GitHubError(
			`${label} returned an unexpected response`,
			"request_failed",
		);
	}
	return body;
}

// ---------------------------------------------------------------------------
// Read — list repos
// ---------------------------------------------------------------------------

export type GitHubRepoSummary = {
	name: string;
	fullName: string;
	private: boolean;
	description?: string;
	url: string;
	defaultBranch: string;
	pushedAt?: string;
	language?: string;
	fork: boolean;
};

function toRepoSummary(
	entry: Record<string, unknown>,
): GitHubRepoSummary | null {
	const name = entry.name;
	const fullName = entry.full_name;
	const url = entry.html_url;
	if (
		typeof name !== "string" ||
		typeof fullName !== "string" ||
		typeof url !== "string"
	) {
		return null;
	}
	const description = entry.description;
	const language = entry.language;
	const pushedAt = entry.pushed_at;
	return {
		name,
		fullName,
		private: entry.private === true,
		...(typeof description === "string" && description ? { description } : {}),
		url,
		defaultBranch:
			typeof entry.default_branch === "string" ? entry.default_branch : "main",
		...(typeof pushedAt === "string" ? { pushedAt } : {}),
		...(typeof language === "string" && language ? { language } : {}),
		fork: entry.fork === true,
	};
}

export async function githubListRepos(
	userId: string,
	connectionId: string,
	params: { limit?: number } = {},
	opts?: FetchOpt,
): Promise<GitHubRepoSummary[]> {
	const limit = clampLimit(params.limit);
	const query = buildQuery({ sort: "pushed", per_page: limit });
	const response = await githubAuthorizedRequest(
		userId,
		connectionId,
		`/user/repos${query}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "GitHub repository list request");
	const body = await parseJson(response, "GitHub repository list");
	if (!Array.isArray(body)) {
		throw new GitHubError(
			"GitHub repository list returned an unexpected response",
			"request_failed",
		);
	}
	return body
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map(toRepoSummary)
		.filter((repo): repo is GitHubRepoSummary => repo !== null)
		.slice(0, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Read — file / directory contents
// ---------------------------------------------------------------------------

export type GitHubFileContent = {
	type: "file";
	path: string;
	content: string;
	size: number;
	sha: string;
};

export type GitHubDirEntry = { name: string; path: string; type: string };
export type GitHubDirListing = {
	type: "dir";
	path: string;
	entries: GitHubDirEntry[];
};

export type GitHubContentResult = GitHubFileContent | GitHubDirListing;

const MAX_INLINE_FILE_BYTES = 500_000;

function decodeBase64Content(entry: Record<string, unknown>): string {
	const content = entry.content;
	if (typeof content !== "string") return "";
	// GitHub's contents API returns base64 with embedded newlines every 60
	// chars — Buffer.from tolerates that fine.
	return Buffer.from(content, "base64").toString("utf-8");
}

export async function githubReadFile(
	userId: string,
	connectionId: string,
	params: { owner: string; repo: string; path: string; ref?: string },
	opts?: FetchOpt,
): Promise<GitHubContentResult> {
	const query = buildQuery({ ref: params.ref });
	const response = await githubAuthorizedRequest(
		userId,
		connectionId,
		`/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${params.path
			.split("/")
			.map(encodeURIComponent)
			.join("/")}${query}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "GitHub file read request");
	const body = await parseJson(response, "GitHub file read");

	if (Array.isArray(body)) {
		const entries: GitHubDirEntry[] = body
			.filter((entry): entry is Record<string, unknown> => isRecord(entry))
			.map((entry) => ({
				name: typeof entry.name === "string" ? entry.name : "",
				path: typeof entry.path === "string" ? entry.path : "",
				type: typeof entry.type === "string" ? entry.type : "file",
			}))
			.filter((entry) => entry.name && entry.path);
		return { type: "dir", path: params.path, entries };
	}

	if (!isRecord(body)) {
		throw new GitHubError(
			"GitHub file read returned an unexpected response",
			"request_failed",
		);
	}
	if (body.type === "dir") {
		return { type: "dir", path: params.path, entries: [] };
	}
	const size = typeof body.size === "number" ? body.size : 0;
	if (size > MAX_INLINE_FILE_BYTES) {
		throw new GitHubError(
			"That file is too large for me to read right now",
			"request_failed",
		);
	}
	return {
		type: "file",
		path: typeof body.path === "string" ? body.path : params.path,
		content: decodeBase64Content(body),
		size,
		sha: typeof body.sha === "string" ? body.sha : "",
	};
}

// ---------------------------------------------------------------------------
// Read — issues
// ---------------------------------------------------------------------------

export type GitHubIssueSummary = {
	number: number;
	title: string;
	state: string;
	url: string;
	author?: string;
	createdAt: string;
	updatedAt: string;
	labels: string[];
};

function toLabelNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((label) => {
			if (typeof label === "string") return label;
			if (isRecord(label) && typeof label.name === "string") return label.name;
			return null;
		})
		.filter((label): label is string => label !== null);
}

function toIssueSummary(
	entry: Record<string, unknown>,
): GitHubIssueSummary | null {
	const number = entry.number;
	const title = entry.title;
	const url = entry.html_url;
	const state = entry.state;
	const createdAt = entry.created_at;
	const updatedAt = entry.updated_at;
	if (
		typeof number !== "number" ||
		typeof title !== "string" ||
		typeof url !== "string" ||
		typeof state !== "string" ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string"
	) {
		return null;
	}
	const user = entry.user;
	const author =
		isRecord(user) && typeof user.login === "string" ? user.login : undefined;
	return {
		number,
		title,
		state,
		url,
		...(author ? { author } : {}),
		createdAt,
		updatedAt,
		labels: toLabelNames(entry.labels),
	};
}

export async function githubListIssues(
	userId: string,
	connectionId: string,
	params: { owner: string; repo: string; state?: string; limit?: number },
	opts?: FetchOpt,
): Promise<GitHubIssueSummary[]> {
	const limit = clampLimit(params.limit);
	const query = buildQuery({
		state: params.state ?? "open",
		per_page: limit,
	});
	const response = await githubAuthorizedRequest(
		userId,
		connectionId,
		`/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues${query}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "GitHub issues list request");
	const body = await parseJson(response, "GitHub issues list");
	if (!Array.isArray(body)) {
		throw new GitHubError(
			"GitHub issues list returned an unexpected response",
			"request_failed",
		);
	}
	return (
		body
			.filter((entry): entry is Record<string, unknown> => isRecord(entry))
			// The /issues endpoint also returns pull requests (each carries a
			// `pull_request` key) — this connector has a dedicated list_prs action,
			// so PRs are filtered out here to keep list_issues issues-only.
			.filter((entry) => entry.pull_request === undefined)
			.map(toIssueSummary)
			.filter((issue): issue is GitHubIssueSummary => issue !== null)
			.slice(0, limit)
	);
}

// ---------------------------------------------------------------------------
// Read — pull requests
// ---------------------------------------------------------------------------

export type GitHubPullRequestSummary = {
	number: number;
	title: string;
	state: string;
	url: string;
	author?: string;
	draft: boolean;
	createdAt: string;
	updatedAt: string;
	headRef?: string;
	baseRef?: string;
};

function toPullRequestSummary(
	entry: Record<string, unknown>,
): GitHubPullRequestSummary | null {
	const number = entry.number;
	const title = entry.title;
	const url = entry.html_url;
	const state = entry.state;
	const createdAt = entry.created_at;
	const updatedAt = entry.updated_at;
	if (
		typeof number !== "number" ||
		typeof title !== "string" ||
		typeof url !== "string" ||
		typeof state !== "string" ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string"
	) {
		return null;
	}
	const user = entry.user;
	const author =
		isRecord(user) && typeof user.login === "string" ? user.login : undefined;
	const head = entry.head;
	const base = entry.base;
	const headRef =
		isRecord(head) && typeof head.ref === "string" ? head.ref : undefined;
	const baseRef =
		isRecord(base) && typeof base.ref === "string" ? base.ref : undefined;
	return {
		number,
		title,
		state,
		url,
		...(author ? { author } : {}),
		draft: entry.draft === true,
		createdAt,
		updatedAt,
		...(headRef ? { headRef } : {}),
		...(baseRef ? { baseRef } : {}),
	};
}

export async function githubListPullRequests(
	userId: string,
	connectionId: string,
	params: { owner: string; repo: string; state?: string; limit?: number },
	opts?: FetchOpt,
): Promise<GitHubPullRequestSummary[]> {
	const limit = clampLimit(params.limit);
	const query = buildQuery({
		state: params.state ?? "open",
		per_page: limit,
	});
	const response = await githubAuthorizedRequest(
		userId,
		connectionId,
		`/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls${query}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "GitHub pull request list request");
	const body = await parseJson(response, "GitHub pull request list");
	if (!Array.isArray(body)) {
		throw new GitHubError(
			"GitHub pull request list returned an unexpected response",
			"request_failed",
		);
	}
	return body
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map(toPullRequestSummary)
		.filter((pr): pr is GitHubPullRequestSummary => pr !== null)
		.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Read — commits
// ---------------------------------------------------------------------------

export type GitHubCommitSummary = {
	sha: string;
	message: string;
	author?: string;
	date?: string;
	url: string;
};

function toCommitSummary(
	entry: Record<string, unknown>,
): GitHubCommitSummary | null {
	const sha = entry.sha;
	const url = entry.html_url;
	const commit = entry.commit;
	if (typeof sha !== "string" || typeof url !== "string" || !isRecord(commit)) {
		return null;
	}
	const message = typeof commit.message === "string" ? commit.message : "";
	const commitAuthor = commit.author;
	const authorName =
		isRecord(commitAuthor) && typeof commitAuthor.name === "string"
			? commitAuthor.name
			: undefined;
	const date =
		isRecord(commitAuthor) && typeof commitAuthor.date === "string"
			? commitAuthor.date
			: undefined;
	return {
		sha,
		message,
		...(authorName ? { author: authorName } : {}),
		...(date ? { date } : {}),
		url,
	};
}

export async function githubListCommits(
	userId: string,
	connectionId: string,
	params: { owner: string; repo: string; path?: string; limit?: number },
	opts?: FetchOpt,
): Promise<GitHubCommitSummary[]> {
	const limit = clampLimit(params.limit);
	const query = buildQuery({ path: params.path, per_page: limit });
	const response = await githubAuthorizedRequest(
		userId,
		connectionId,
		`/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/commits${query}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "GitHub commit list request");
	const body = await parseJson(response, "GitHub commit list");
	if (!Array.isArray(body)) {
		throw new GitHubError(
			"GitHub commit list returned an unexpected response",
			"request_failed",
		);
	}
	return body
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map(toCommitSummary)
		.filter((commit): commit is GitHubCommitSummary => commit !== null)
		.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Read — CI status (Actions runs)
// ---------------------------------------------------------------------------

export type GitHubCiRunSummary = {
	id: number;
	name?: string;
	status: string;
	conclusion?: string;
	headBranch?: string;
	headSha: string;
	url: string;
	createdAt: string;
	updatedAt: string;
};

function toCiRunSummary(
	entry: Record<string, unknown>,
): GitHubCiRunSummary | null {
	const id = entry.id;
	const status = entry.status;
	const headSha = entry.head_sha;
	const url = entry.html_url;
	const createdAt = entry.created_at;
	const updatedAt = entry.updated_at;
	if (
		typeof id !== "number" ||
		typeof status !== "string" ||
		typeof headSha !== "string" ||
		typeof url !== "string" ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string"
	) {
		return null;
	}
	const name = entry.name;
	const conclusion = entry.conclusion;
	const headBranch = entry.head_branch;
	return {
		id,
		...(typeof name === "string" && name ? { name } : {}),
		status,
		...(typeof conclusion === "string" && conclusion ? { conclusion } : {}),
		...(typeof headBranch === "string" && headBranch ? { headBranch } : {}),
		headSha,
		url,
		createdAt,
		updatedAt,
	};
}

export async function githubCiStatus(
	userId: string,
	connectionId: string,
	params: { owner: string; repo: string; ref?: string; limit?: number },
	opts?: FetchOpt,
): Promise<GitHubCiRunSummary[]> {
	const limit = clampLimit(params.limit);
	const query = buildQuery({ branch: params.ref, per_page: limit });
	const response = await githubAuthorizedRequest(
		userId,
		connectionId,
		`/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/actions/runs${query}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "GitHub CI status request");
	const body = await parseJson(response, "GitHub CI status");
	if (!isRecord(body) || !Array.isArray(body.workflow_runs)) {
		throw new GitHubError(
			"GitHub CI status returned an unexpected response",
			"request_failed",
		);
	}
	return body.workflow_runs
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map(toCiRunSummary)
		.filter((run): run is GitHubCiRunSummary => run !== null)
		.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Read — code search
// ---------------------------------------------------------------------------

export type GitHubCodeSearchItem = {
	name: string;
	path: string;
	repository: string;
	url: string;
};

function toCodeSearchItem(
	entry: Record<string, unknown>,
): GitHubCodeSearchItem | null {
	const name = entry.name;
	const path = entry.path;
	const url = entry.html_url;
	const repository = entry.repository;
	if (
		typeof name !== "string" ||
		typeof path !== "string" ||
		typeof url !== "string" ||
		!isRecord(repository) ||
		typeof repository.full_name !== "string"
	) {
		return null;
	}
	return { name, path, repository: repository.full_name, url };
}

export async function githubSearchCode(
	userId: string,
	connectionId: string,
	params: { query: string; limit?: number },
	opts?: FetchOpt,
): Promise<GitHubCodeSearchItem[]> {
	const limit = clampLimit(params.limit);
	const query = buildQuery({ q: params.query, per_page: limit });
	const response = await githubAuthorizedRequest(
		userId,
		connectionId,
		`/search/code${query}`,
		{ method: "GET" },
		opts,
	);
	assertOk(response, "GitHub code search request");
	const body = await parseJson(response, "GitHub code search");
	if (!isRecord(body) || !Array.isArray(body.items)) {
		throw new GitHubError(
			"GitHub code search returned an unexpected response",
			"request_failed",
		);
	}
	return body.items
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map(toCodeSearchItem)
		.filter((item): item is GitHubCodeSearchItem => item !== null)
		.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Adapter — a cheap GET /user confirms the stored token still works, without
// touching any repository data.
// ---------------------------------------------------------------------------

async function checkHealth(
	secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	const { baseUrl } = githubConfig(conn);
	const fetchImpl = opts?.fetch ?? fetch;
	try {
		const response = await providerFetch(`${baseUrl}/user`, {
			headers: githubHeaders(secret),
			fetch: fetchImpl,
			timeoutError: githubTimeout,
		});
		if (response.status === 401) {
			return {
				status: "needs_reauth",
				detail: "GitHub rejected the stored token",
			};
		}
		if (!response.ok) {
			return {
				status: "error",
				detail: `GitHub health check failed with status ${response.status}`,
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

// Not annotated as `: ConnectionAdapter` — same rationale as immichAdapter/
// plexAdapter: that annotation would narrow checkHealth's call signature to
// the interface's (secret, conn) shape and break the mocked-fetch tests that
// pass a third `{ fetch }` opts arg.
export const githubAdapter = {
	provider: "github" as const,
	requiresSecret: true,
	checkHealth,
};

registerConnectionAdapter(githubAdapter satisfies ConnectionAdapter);
