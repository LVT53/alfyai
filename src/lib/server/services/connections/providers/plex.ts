// Plex (self-hosted media server) connect + read (5.6). Watch-history and
// library-metadata ONLY — this module is, and must always remain,
// **strictly read-only**: Plex never gets a write path, not in this issue
// and not in a later phase. There is deliberately no function here that
// mutates anything on the user's Plex server (no scrobble/markWatched/
// markPlayed/etc) — a dedicated test in plex.test.ts asserts the module's
// exported surface never grows one.
//
// Auth is a user-pasted `X-Plex-Token` + their own server's base URL (e.g.
// `https://plex.example.com`, or a plex.direct URL) — there is no OAuth/login
// step the way Immich has one; the token itself is validated with a cheap
// `GET /identity` call and then persisted (encrypted) exactly as pasted. It
// is never logged, never included in an error message, and every network
// call accepts an injectable `fetch` so the whole module is testable against
// mocked Plex endpoints — nothing here ever talks to a live Plex server in
// tests.
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
import { assertPublicHttpsUrl } from "./nextcloud-files";

type FetchOpt = { fetch?: typeof fetch };

export type PlexErrorCode =
	| "invalid_token"
	| "invalid_config"
	| "needs_reauth"
	| "request_failed"
	| "connection_not_found";

export class PlexError extends Error {
	constructor(
		message: string,
		public readonly code: PlexErrorCode,
	) {
		super(message);
		this.name = "PlexError";
	}
}

// ---------------------------------------------------------------------------
// Server URL normalization
// ---------------------------------------------------------------------------

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

// The user-pasted Plex server URL is fetched server-side with their token
// attached, exactly like the Immich/Nextcloud connector's serverUrl, so it
// needs the same SSRF guard: delegate the https + private/loopback/
// link-local host check to the shared `assertPublicHttpsUrl` (see
// nextcloud-files.ts) rather than reinventing it here.
function normalizeOrigin(serverUrl: string): string {
	const trimmed = serverUrl.trim();
	if (!trimmed) {
		throw new PlexError("A server URL is required", "invalid_config");
	}
	let validated: string;
	try {
		validated = assertPublicHttpsUrl(trimmed);
	} catch (err) {
		throw new PlexError(
			err instanceof Error ? err.message : String(err),
			"invalid_config",
		);
	}
	const origin = stripTrailingSlashes(validated);
	if (!origin) {
		throw new PlexError("A server URL is required", "invalid_config");
	}
	return origin;
}

// ---------------------------------------------------------------------------
// Shared request plumbing
// ---------------------------------------------------------------------------

// Plex defaults to XML; `Accept: application/json` gets JSON instead. The
// token is sent as a header (never a query string) so it never ends up in
// server access logs. X-Plex-Client-Identifier/X-Plex-Product are static
// (no per-request state, unlike X-Plex-Container-Size/-Start pagination
// headers, which Plex is also nudging clients toward — those would need
// request-specific wiring through plexAuthorizedRequest and are left out of
// this pass) — Plex has warned unauthenticated-client requests will stop
// being served, so every call identifies itself.
function plexHeaders(token: string): HeadersInit {
	return {
		"X-Plex-Token": token,
		Accept: "application/json",
		"X-Plex-Client-Identifier": "alfyai-plex-connector",
		"X-Plex-Product": "AlfyAI",
	};
}

type IdentityResponse = {
	MediaContainer: { machineIdentifier: string; version?: string };
};

function isValidIdentityResponse(value: unknown): value is IdentityResponse {
	if (!value || typeof value !== "object") return false;
	const mediaContainer = (value as Record<string, unknown>).MediaContainer;
	if (!mediaContainer || typeof mediaContainer !== "object") return false;
	const machineIdentifier = (mediaContainer as Record<string, unknown>)
		.machineIdentifier;
	return typeof machineIdentifier === "string" && machineIdentifier.length > 0;
}

async function plexIdentity(
	fetchImpl: typeof fetch,
	origin: string,
	token: string,
): Promise<IdentityResponse> {
	let response: Response;
	try {
		response = await fetchImpl(`${origin}/identity`, {
			headers: plexHeaders(token),
		});
	} catch {
		throw new PlexError(
			"Could not reach the Plex server. Check the server URL.",
			"request_failed",
		);
	}
	if (response.status === 401) {
		throw new PlexError("Invalid Plex token", "invalid_token");
	}
	if (!response.ok) {
		throw new PlexError(
			"Could not reach the Plex server. Check the server URL.",
			"request_failed",
		);
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidIdentityResponse(body)) {
		throw new PlexError(
			"Plex returned an unexpected response",
			"request_failed",
		);
	}
	return body;
}

// ---------------------------------------------------------------------------
// Owner account resolution (privacy) — `/status/sessions/history/all`
// returns EVERY household user's playback for an owner/admin token (the kind
// almost always pasted here), not just the pasting user's own. Resolving and
// storing the token owner's local Plex accountID at connect time lets every
// later history read scope itself with `&accountID=<id>` (see
// plexWatchHistory below), matching Plex's own account-scoped history filter.
// ---------------------------------------------------------------------------

type AccountsResponse = {
	MediaContainer: { Account?: { id?: number; name?: string }[] };
};

function isValidAccountsResponse(value: unknown): value is AccountsResponse {
	if (!value || typeof value !== "object") return false;
	const mediaContainer = (value as Record<string, unknown>).MediaContainer;
	if (!mediaContainer || typeof mediaContainer !== "object") return false;
	const account = (mediaContainer as Record<string, unknown>).Account;
	return account === undefined || Array.isArray(account);
}

// Best-effort: resolves the pasted token's own Plex account id from
// `GET {origin}/accounts` so watch-history reads can be scoped to it. Never
// throws — a server that can't be reached, returns something unexpected, or
// simply has no usable accounts data still connects successfully; the
// history read just can't be scoped to a single account in that (rare) case.
//
// `/accounts` lists every local account on the server (id, name), keyed the
// same way `HistoryMetadataEntry.accountID` is: a token that can only see its
// own account (a shared/managed-user token) gets exactly one entry back —
// unambiguous. An owner/admin token sees every household account, and the
// account actually linked/claimed to the server — the owner — is
// conventionally accountID 1 (id 0 is a synthetic "local network,
// unauthenticated" pseudo-account, never a real person; see Plex's own
// documented /accounts example, and every mainstream self-hosted-Plex tool —
// Tautulli, Varken, etc. — that infers "the owner" the same way).
async function resolvePlexOwnerAccountId(
	fetchImpl: typeof fetch,
	origin: string,
	token: string,
): Promise<number | undefined> {
	let response: Response;
	try {
		response = await fetchImpl(`${origin}/accounts`, {
			headers: plexHeaders(token),
		});
	} catch {
		return undefined;
	}
	if (!response.ok) return undefined;
	const body: unknown = await response.json().catch(() => null);
	if (!isValidAccountsResponse(body)) return undefined;
	const accounts = (body.MediaContainer.Account ?? []).filter(
		(account): account is { id: number; name?: string } =>
			typeof account.id === "number",
	);
	if (accounts.length === 1) return accounts[0]?.id;
	return accounts.find((account) => account.id === 1)?.id;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export type PlexConnectionConfig = {
	origin: string;
	machineIdentifier: string;
	// The token owner's local Plex account id (from `GET /accounts`),
	// resolved best-effort at connect time — see resolvePlexOwnerAccountId.
	// Optional: older connections (or a server whose /accounts call failed at
	// connect time) simply don't have it, and history reads fall back to the
	// unscoped query in that case.
	accountId?: number;
};

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function upsertPlexConnection(params: {
	userId: string;
	machineIdentifier: string;
	secret: string;
	config: PlexConnectionConfig;
}): Promise<ConnectionPublic> {
	const existing = await findConnectionByAccount(
		params.userId,
		"plex",
		params.machineIdentifier,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.secret);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated) throw new Error("Failed to update existing Plex connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "plex",
			label: "Plex",
			accountIdentifier: params.machineIdentifier,
			capabilities: ["media"],
			status: "connected",
			secret: params.secret,
			config: params.config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent connect attempt — same pattern as
		// immich.ts's upsertImmichConnection.
		const raced = await findConnectionByAccount(
			params.userId,
			"plex",
			params.machineIdentifier,
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

export async function plexConnect(
	params: {
		userId: string;
		serverUrl: string;
		token: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	const token = params.token.trim();
	if (!token) {
		throw new PlexError("A Plex token is required", "invalid_config");
	}
	const origin = normalizeOrigin(params.serverUrl);
	const fetchImpl = params.fetch ?? fetch;

	const identity = await plexIdentity(fetchImpl, origin, token);
	const machineIdentifier = identity.MediaContainer.machineIdentifier;
	const accountId = await resolvePlexOwnerAccountId(fetchImpl, origin, token);

	const connection = await upsertPlexConnection({
		userId: params.userId,
		machineIdentifier,
		secret: token,
		config: {
			origin,
			machineIdentifier,
			...(accountId !== undefined ? { accountId } : {}),
		},
	});
	return { connection };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type WatchEntry = {
	title: string;
	show?: string;
	season?: number;
	episode?: number;
	type: string;
	viewedAt: string;
	library?: string;
};

export type LibrarySection = { title: string; type: string };

type HistoryMetadataEntry = {
	title?: string;
	type?: string;
	grandparentTitle?: string;
	parentTitle?: string;
	index?: number;
	parentIndex?: number;
	viewedAt?: number;
	accountID?: number;
	librarySectionTitle?: string;
};

type HistoryResponse = {
	MediaContainer: { size: number; Metadata?: HistoryMetadataEntry[] };
};

function isValidHistoryResponse(value: unknown): value is HistoryResponse {
	if (!value || typeof value !== "object") return false;
	const mediaContainer = (value as Record<string, unknown>).MediaContainer;
	if (!mediaContainer || typeof mediaContainer !== "object") return false;
	const metadata = (mediaContainer as Record<string, unknown>).Metadata;
	return metadata === undefined || Array.isArray(metadata);
}

type SectionsResponse = {
	MediaContainer: {
		Directory?: { key?: string; title?: string; type?: string }[];
	};
};

function isValidSectionsResponse(value: unknown): value is SectionsResponse {
	if (!value || typeof value !== "object") return false;
	const mediaContainer = (value as Record<string, unknown>).MediaContainer;
	if (!mediaContainer || typeof mediaContainer !== "object") return false;
	const directory = (mediaContainer as Record<string, unknown>).Directory;
	return directory === undefined || Array.isArray(directory);
}

function plexConfig(conn: ConnectionPublic): PlexConnectionConfig {
	const origin =
		typeof conn.config.origin === "string" ? conn.config.origin : "";
	const machineIdentifier =
		typeof conn.config.machineIdentifier === "string"
			? conn.config.machineIdentifier
			: "";
	const accountId =
		typeof conn.config.accountId === "number"
			? conn.config.accountId
			: undefined;
	if (!origin) {
		throw new PlexError(
			"Connection is missing origin in its config",
			"invalid_config",
		);
	}
	return {
		origin,
		machineIdentifier,
		...(accountId !== undefined ? { accountId } : {}),
	};
}

// Loads the connection + decrypted token, marking the connection
// needs_reauth on a 401 before rethrowing — the one chokepoint every
// authorized Plex call routes through. Never logs or throws the token:
// thrown PlexError messages are always static strings.
//
// `buildPath` (rather than a plain string) gives the caller access to the
// connection's resolved config — e.g. plexWatchHistory needs `accountId` to
// build its query string — without a second, duplicate connection load.
async function plexAuthorizedRequest(
	userId: string,
	connectionId: string,
	buildPath: (config: PlexConnectionConfig) => string,
	opts?: FetchOpt,
): Promise<Response> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new PlexError("Plex connection not found", "connection_not_found");
	}
	const token = await getConnectionSecret(userId, connectionId);
	if (!token) {
		throw new PlexError(
			"No token stored for this Plex connection",
			"needs_reauth",
		);
	}
	const config = plexConfig(conn);
	const fetchImpl = opts?.fetch ?? fetch;
	const path = buildPath(config);

	let response: Response;
	try {
		response = await fetchImpl(`${config.origin}${path}`, {
			headers: plexHeaders(token),
		});
	} catch {
		throw new PlexError("Failed to reach the Plex server", "request_failed");
	}
	if (response.status === 401) {
		const detail = "Plex rejected the stored token";
		await updateConnection(userId, connectionId, {
			status: "needs_reauth",
			statusDetail: detail,
		});
		throw new PlexError(detail, "needs_reauth");
	}
	return response;
}

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
	const requested = limit ?? DEFAULT_HISTORY_LIMIT;
	if (!Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_HISTORY_LIMIT;
	}
	return Math.min(Math.floor(requested), MAX_HISTORY_LIMIT);
}

function toWatchEntry(entry: HistoryMetadataEntry): WatchEntry | null {
	if (!entry.title || !entry.type || entry.viewedAt === undefined) return null;
	return {
		title: entry.title,
		...(entry.grandparentTitle ? { show: entry.grandparentTitle } : {}),
		...(entry.parentIndex !== undefined ? { season: entry.parentIndex } : {}),
		...(entry.index !== undefined ? { episode: entry.index } : {}),
		type: entry.type,
		viewedAt: new Date(entry.viewedAt * 1000).toISOString(),
		...(entry.librarySectionTitle
			? { library: entry.librarySectionTitle }
			: {}),
	};
}

function matchesQuery(entry: WatchEntry, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	if (entry.title.toLowerCase().includes(needle)) return true;
	return Boolean(entry.show?.toLowerCase().includes(needle));
}

// `GET {origin}/status/sessions/history/all` — the query string is built by
// hand (not URLSearchParams) so the `viewedAt>=<unix>` filter matches the
// Plex API's exact key literally, since URLSearchParams would percent-encode
// the `>=` in the key. Also carries `accountID=<owner>` whenever the
// connection has one resolved (see resolvePlexOwnerAccountId) — without it,
// an owner/admin token gets every household user's history back, not just
// the token owner's (BUG1).
export async function plexWatchHistory(
	userId: string,
	connectionId: string,
	params: { since?: string; limit?: number; query?: string },
	opts?: FetchOpt,
): Promise<WatchEntry[]> {
	const limit = clampLimit(params.limit);

	const response = await plexAuthorizedRequest(
		userId,
		connectionId,
		(config) => {
			let queryString = `sort=viewedAt:desc&limit=${limit}`;
			if (config.accountId !== undefined) {
				queryString += `&accountID=${config.accountId}`;
			}
			if (params.since) {
				const sinceDate = new Date(params.since);
				if (!Number.isNaN(sinceDate.getTime())) {
					queryString += `&viewedAt>=${Math.floor(sinceDate.getTime() / 1000)}`;
				}
			}
			return `/status/sessions/history/all?${queryString}`;
		},
		opts,
	);
	if (!response.ok) {
		throw new PlexError("Plex watch history request failed", "request_failed");
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidHistoryResponse(body)) {
		throw new PlexError(
			"Plex returned an unexpected response",
			"request_failed",
		);
	}
	const entries = (body.MediaContainer.Metadata ?? [])
		.map(toWatchEntry)
		.filter((entry): entry is WatchEntry => entry !== null);
	const filtered = params.query
		? entries.filter((entry) => matchesQuery(entry, params.query as string))
		: entries;
	return filtered.slice(0, limit);
}

export async function plexLibrarySections(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<LibrarySection[]> {
	const response = await plexAuthorizedRequest(
		userId,
		connectionId,
		() => "/library/sections",
		opts,
	);
	if (!response.ok) {
		throw new PlexError(
			"Plex library sections request failed",
			"request_failed",
		);
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidSectionsResponse(body)) {
		throw new PlexError(
			"Plex returned an unexpected response",
			"request_failed",
		);
	}
	return (body.MediaContainer.Directory ?? [])
		.filter(
			(directory): directory is { title: string; type: string } =>
				typeof directory.title === "string" &&
				typeof directory.type === "string",
		)
		.map((directory) => ({ title: directory.title, type: directory.type }));
}

// ---------------------------------------------------------------------------
// Adapter — a cheap GET /identity confirms the stored token still works,
// without touching any watch-history or library data.
// ---------------------------------------------------------------------------

async function checkHealth(
	secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	let config: PlexConnectionConfig;
	try {
		config = plexConfig(conn);
	} catch (err) {
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	const fetchImpl = opts?.fetch ?? fetch;
	try {
		const response = await fetchImpl(`${config.origin}/identity`, {
			headers: plexHeaders(secret),
		});
		if (response.status === 401) {
			return {
				status: "needs_reauth",
				detail: "Plex rejected the stored token",
			};
		}
		if (!response.ok) {
			return {
				status: "error",
				detail: `Plex health check failed with status ${response.status}`,
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

// Not annotated as `: ConnectionAdapter` — same rationale as immichAdapter:
// that annotation would narrow checkHealth's call signature to the
// interface's (secret, conn) shape and break the mocked-fetch tests that pass
// a third `{ fetch }` opts arg.
export const plexAdapter = {
	provider: "plex" as const,
	checkHealth,
};

registerConnectionAdapter(plexAdapter satisfies ConnectionAdapter);
