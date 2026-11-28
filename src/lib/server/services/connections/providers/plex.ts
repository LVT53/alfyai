// Plex (self-hosted media server) connect + read (5.6). Watch-history,
// library-metadata, on-deck/continue-watching, and library search/catalog
// lookups ONLY — this module is, and must always remain, **strictly
// read-only**: Plex never gets a write path, not in this issue and not in a
// later phase. There is deliberately no function here that mutates anything
// on the user's Plex server (no scrobble/markWatched/markPlayed/etc) — a
// dedicated test in plex.test.ts asserts the module's exported surface never
// grows one.
//
// Hosted sign-in uses the selected server and the rider's encrypted Plex
// device grant. Older manually configured connections keep their original token.

import { registerConnectionAdapter } from "../adapters";
import { assertPublicHttpsUrl } from "../host-locality";
import { ConnectionHttpError, providerFetch } from "../provider-http";
import type { ConnectionAdapter } from "../registry";
import {
	type ConnectionPublic,
	createConnection,
	findConnectionByAccount,
	getConnectionWithCredential,
	updateConnection,
} from "../store";
import type { PlexDevice, PlexServerResource } from "./plex-cloud";
import {
	type LinkedPlexSecret,
	linkedPlexGet,
	locateLinkedPlexServer,
	renewLinkedPlexServer,
} from "./plex-linked";

type FetchOpt = { fetch?: typeof fetch };

export type PlexErrorCode =
	| "history_unavailable"
	| "invalid_token"
	| "invalid_config"
	| "needs_reauth"
	| "request_failed"
	| "connection_not_found";

export class PlexError extends ConnectionHttpError<PlexErrorCode> {
	constructor(message: string, code: PlexErrorCode) {
		super(message, code);
		this.name = "PlexError";
	}
}

// Timeout error for the health check now routed through providerFetch —
// previously this call had no timeout wrapper at all (B1 closes that gap so
// the ~15s bound is uniform with every other provider's health check).
const plexTimeout = (ms: number) =>
	new PlexError(`Plex request timed out after ${ms}ms`, "request_failed");

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
// server access logs. X-Plex-Client-Identifier/X-Plex-Product are static (no
// per-request state) — Plex has warned unauthenticated-client requests will
// stop being served, so every call identifies itself.
//
// `container`, when supplied, adds X-Plex-Container-Size/-Start: Plex is
// moving toward REQUIRING these on every container (paginated MediaContainer)
// response — currently a deprecation warning, but documented to start
// rejecting container requests without them with a 400. Only the calls that
// actually return a MediaContainer callers page through (watch history,
// library sections, on-deck, library search — all wired via
// plexAuthorizedRequest) pass this; the one-off /identity and /accounts calls
// don't take a `container` arg at all, since neither is a paginated listing a
// caller would ever page through.
function plexHeaders(
	token: string,
	container?: { size: number; start: number },
): HeadersInit {
	return {
		"X-Plex-Token": token,
		Accept: "application/json",
		"X-Plex-Client-Identifier": "alfyai-plex-connector",
		"X-Plex-Product": "AlfyAI",
		...(container
			? {
					"X-Plex-Container-Size": String(container.size),
					"X-Plex-Container-Start": String(container.start),
				}
			: {}),
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
	linked?: boolean;
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
	label?: string;
	repair?: { id: string; version: string };
	config: PlexConnectionConfig;
}): Promise<ConnectionPublic> {
	const patch = {
		status: "connected" as const,
		statusDetail: null,
		secret: params.secret,
		config: params.config,
		...(params.label ? { label: params.label } : {}),
	};
	if (params.repair) {
		const updated = await updateConnection(
			params.userId,
			params.repair.id,
			patch,
			params.repair.version,
		);
		if (!updated)
			throw new ConnectionHttpError(
				"The connection changed during setup",
				"expired",
			);
		return updated;
	}
	const existing = await findConnectionByAccount(
		params.userId,
		"plex",
		params.machineIdentifier,
	);
	if (!existing) {
		try {
			return await createConnection({
				userId: params.userId,
				provider: "plex",
				label: params.label ?? "Plex",
				accountIdentifier: params.machineIdentifier,
				capabilities: ["media"],
				...patch,
			});
		} catch (err) {
			if (!isUniqueConstraintError(err)) throw err;
		}
	}
	const current =
		existing ??
		(await findConnectionByAccount(
			params.userId,
			"plex",
			params.machineIdentifier,
		));
	const updated =
		current && (await updateConnection(params.userId, current.id, patch));
	if (!updated)
		throw new PlexError(
			"The connection changed during setup",
			"request_failed",
		);
	return updated;
}

export async function connectLinkedPlex(
	params: {
		userId: string;
		device: PlexDevice;
		accountToken: string;
		server: PlexServerResource;
		repair?: { id: string; version: string };
	} & FetchOpt,
) {
	const { server, device } = params;
	const { origin, token } = await locateLinkedPlexServer(
		server,
		device,
		params.accountToken,
		params,
	);
	// The owner is local account 1 on a claimed server; a shared user must
	// never be mapped to that owner, even when /accounts lists household users.
	const accountId = server.owned ? 1 : undefined;
	const secret: LinkedPlexSecret = {
		device,
		serverToken: token,
		tokenOrigin: origin,
	};
	return upsertPlexConnection({
		userId: params.userId,
		machineIdentifier: server.id,
		label: server.name,
		repair: params.repair,
		secret: JSON.stringify(secret),
		config: {
			origin,
			machineIdentifier: server.id,
			linked: true,
			...(accountId ? { accountId } : {}),
		},
	});
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
		...(conn.config.linked === true ? { linked: true } : {}),
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
//
// `container`, when supplied, is forwarded to plexHeaders as the
// X-Plex-Container-Size/-Start pair — callers pass the exact same
// size/start their own `buildPath` query string already encodes (limit=/no
// offset support yet), so the header and the query string can never drift
// apart.
const refreshing = new Map<
	string,
	Promise<{ config: PlexConnectionConfig; token: string }>
>();
function refreshLinkedCredential(
	conn: ConnectionPublic,
	config: PlexConnectionConfig,
	saved: LinkedPlexSecret,
	version: string,
	opts?: FetchOpt,
) {
	const key = `${conn.id}:${version}`;
	const inflight = refreshing.get(key);
	if (inflight) return inflight;
	const run = async () => {
		try {
			const renewed = await renewLinkedPlexServer(
				saved.device,
				config.machineIdentifier,
				opts,
			);
			const nextConfig = {
				...config,
				origin: renewed.origin,
				accountId: renewed.server.owned ? 1 : undefined,
			};
			const updated = await updateConnection(
				conn.userId,
				conn.id,
				{
					status: "connected",
					statusDetail: null,
					config: nextConfig,
					secret: JSON.stringify({
						...saved,
						tokenOrigin: renewed.origin,
						serverToken: renewed.token,
					}),
				},
				version,
			);
			if (!updated)
				throw new PlexError(
					"Plex connection changed during renewal",
					"request_failed",
				);
			return { config: nextConfig, token: renewed.token };
		} catch (err) {
			if (err instanceof ConnectionHttpError && err.code === "needs_reauth") {
				await updateConnection(
					conn.userId,
					conn.id,
					{ status: "needs_reauth", statusDetail: "Plex sign-in expired" },
					version,
				);
				throw new PlexError("Plex sign-in expired", "needs_reauth");
			}
			throw err;
		}
	};
	const pending = run().finally(() => refreshing.delete(key));
	refreshing.set(key, pending);
	return pending;
}

async function plexAuthorizedRequest(
	userId: string,
	connectionId: string,
	buildPath: (config: PlexConnectionConfig) => string,
	opts?: FetchOpt,
	container?: { size: number; start: number },
): Promise<Response> {
	const snapshot = await getConnectionWithCredential(userId, connectionId);
	if (snapshot?.connection.provider !== "plex") {
		throw new PlexError("Plex connection not found", "connection_not_found");
	}
	const { connection: conn, credential } = snapshot;
	if (!credential) {
		throw new PlexError(
			"No token stored for this Plex connection",
			"needs_reauth",
		);
	}
	const config = plexConfig(conn);
	const token = credential.value;
	if (!config.linked && token.trimStart().startsWith("{"))
		throw new PlexError(
			"Plex credentials changed during the request",
			"request_failed",
		);
	if (config.linked) {
		let saved: LinkedPlexSecret;
		try {
			saved = JSON.parse(token);
			if (
				typeof saved?.device?.clientId !== "string" ||
				typeof saved.serverToken !== "string"
			)
				throw Error();
		} catch {
			throw new PlexError("Invalid linked Plex credential", "needs_reauth");
		}
		if (saved.tokenOrigin !== config.origin)
			throw new PlexError("Plex server address changed", "request_failed");
		const read = (conf: PlexConnectionConfig, credential: string) =>
			linkedPlexGet(conf.origin, opts)(buildPath(conf), {
				...plexHeaders(credential, container),
				"X-Plex-Client-Identifier": saved.device.clientId,
			});
		// A DHCP or relay change can retire a saved origin before its token expires.
		let response: Response | undefined;
		const initialPath = buildPath(config);
		try {
			response = await linkedPlexGet(config.origin, opts)(initialPath, {
				...plexHeaders(saved.serverToken, container),
				"X-Plex-Client-Identifier": saved.device.clientId,
			});
		} catch {
			/* Rediscover once with the existing device grant. */
		}
		if (response && response.status !== 401 && response.status !== 498)
			return response;
		const renewed = await refreshLinkedCredential(
			conn,
			config,
			saved,
			credential.version,
			opts,
		);
		return read(renewed.config, renewed.token);
	}
	const fetchImpl = opts?.fetch ?? fetch;
	const path = buildPath(config);

	let response: Response;
	try {
		response = await fetchImpl(`${config.origin}${path}`, {
			headers: plexHeaders(token, container),
		});
	} catch {
		throw new PlexError("Failed to reach the Plex server", "request_failed");
	}
	if (response.status === 401) {
		const detail = "Plex rejected the stored token";
		await updateConnection(
			userId,
			connectionId,
			{
				status: "needs_reauth",
				statusDetail: detail,
			},
			credential.version,
		);
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
	let linkedAccount: number | undefined;

	const response = await plexAuthorizedRequest(
		userId,
		connectionId,
		(config) => {
			linkedAccount = config.linked ? config.accountId : undefined;
			if (config.linked && config.accountId === undefined)
				throw new PlexError(
					"Plex history is unavailable for this account",
					"history_unavailable",
				);
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
		// -Start is always 0: this call has no offset/pagination parameter of
		// its own (only `limit=`), so it only ever asks for the first page.
		{ size: limit, start: 0 },
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
		.filter(
			(entry) =>
				linkedAccount === undefined || entry.accountID === linkedAccount,
		)
		.map(toWatchEntry)
		.filter((entry): entry is WatchEntry => entry !== null);
	const filtered = params.query
		? entries.filter((entry) => matchesQuery(entry, params.query as string))
		: entries;
	return filtered.slice(0, limit);
}

// GET /library/sections has no limit/offset parameter of its own — a user's
// Plex library section count is always small (a handful, in practice) and
// this call has never paginated it. Plex's container-pagination headers are
// still required on every container request regardless, so this is a
// generous fixed ceiling (well above any real deployment) rather than a
// value derived from a query param this call doesn't have; -Start is always
// 0 for the same reason plexWatchHistory's is when it has no `since`/offset.
const LIBRARY_SECTIONS_CONTAINER_SIZE = 200;

// Shared by plexLibrarySections (public, key-stripped) and plexLibrarySearch
// (needs each section's `key` to query `/library/sections/{key}/all`) so the
// `GET /library/sections` call + response parsing lives in exactly one
// place.
async function fetchLibrarySectionsWithKeys(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<{ key: string; title: string; type: string }[]> {
	const response = await plexAuthorizedRequest(
		userId,
		connectionId,
		() => "/library/sections",
		opts,
		{ size: LIBRARY_SECTIONS_CONTAINER_SIZE, start: 0 },
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
	return (body.MediaContainer.Directory ?? []).filter(
		(directory): directory is { key: string; title: string; type: string } =>
			typeof directory.key === "string" &&
			typeof directory.title === "string" &&
			typeof directory.type === "string",
	);
}

export async function plexLibrarySections(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<LibrarySection[]> {
	const sections = await fetchLibrarySectionsWithKeys(
		userId,
		connectionId,
		opts,
	);
	return sections.map(({ title, type }) => ({ title, type }));
}

// ---------------------------------------------------------------------------
// GAP B2 — on-deck / continue-watching: `GET /library/onDeck`. Unlike
// `/status/sessions/history/all` (BUG1), on-deck is inherently computed from
// the requesting token's own account viewstate — Plex has no separate
// per-account "on deck" filter param because there is nothing to disambiguate
// (each managed/household user's watch progress is already tracked
// separately server-side, and the token identifies which one is asking) — so
// this call intentionally does NOT append `accountID=`.
// ---------------------------------------------------------------------------

export type ContinueWatchingItem = {
	title: string;
	show?: string;
	season?: number;
	episode?: number;
	type: string;
	// Milliseconds — Plex's own units for viewOffset/duration. `progress` is
	// derived (viewOffsetMs / durationMs, clamped to 1) only when both are
	// present and duration is positive, so callers don't have to redo that
	// arithmetic (and can't divide by a missing/zero duration).
	viewOffsetMs?: number;
	durationMs?: number;
	progress?: number;
	library?: string;
};

type OnDeckMetadataEntry = {
	title?: string;
	type?: string;
	grandparentTitle?: string;
	parentIndex?: number;
	index?: number;
	viewOffset?: number;
	duration?: number;
	librarySectionTitle?: string;
};

type OnDeckResponse = {
	MediaContainer: { size?: number; Metadata?: OnDeckMetadataEntry[] };
};

function isValidOnDeckResponse(value: unknown): value is OnDeckResponse {
	if (!value || typeof value !== "object") return false;
	const mediaContainer = (value as Record<string, unknown>).MediaContainer;
	if (!mediaContainer || typeof mediaContainer !== "object") return false;
	const metadata = (mediaContainer as Record<string, unknown>).Metadata;
	return metadata === undefined || Array.isArray(metadata);
}

const DEFAULT_ON_DECK_LIMIT = 20;
const MAX_ON_DECK_LIMIT = 100;

function clampOnDeckLimit(limit: number | undefined): number {
	const requested = limit ?? DEFAULT_ON_DECK_LIMIT;
	if (!Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_ON_DECK_LIMIT;
	}
	return Math.min(Math.floor(requested), MAX_ON_DECK_LIMIT);
}

function toContinueWatchingItem(
	entry: OnDeckMetadataEntry,
): ContinueWatchingItem | null {
	if (!entry.title || !entry.type) return null;
	const viewOffsetMs = entry.viewOffset;
	const durationMs = entry.duration;
	const progress =
		viewOffsetMs !== undefined && durationMs !== undefined && durationMs > 0
			? Math.min(viewOffsetMs / durationMs, 1)
			: undefined;
	return {
		title: entry.title,
		...(entry.grandparentTitle ? { show: entry.grandparentTitle } : {}),
		...(entry.parentIndex !== undefined ? { season: entry.parentIndex } : {}),
		...(entry.index !== undefined ? { episode: entry.index } : {}),
		type: entry.type,
		...(viewOffsetMs !== undefined ? { viewOffsetMs } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(progress !== undefined ? { progress } : {}),
		...(entry.librarySectionTitle
			? { library: entry.librarySectionTitle }
			: {}),
	};
}

// `GET {origin}/library/onDeck` — "continue watching"/"up next" across every
// library section, most-recently-updated first (Plex's own default sort for
// this endpoint). `limit=` is a documented generic Plex query param (same
// family as the container-size header); the header and query param are kept
// in lockstep exactly like plexWatchHistory's.
export async function plexOnDeck(
	userId: string,
	connectionId: string,
	params: { limit?: number } = {},
	opts?: FetchOpt,
): Promise<ContinueWatchingItem[]> {
	const limit = clampOnDeckLimit(params.limit);

	const response = await plexAuthorizedRequest(
		userId,
		connectionId,
		() => `/library/onDeck?limit=${limit}`,
		opts,
		{ size: limit, start: 0 },
	);
	if (!response.ok) {
		throw new PlexError("Plex on-deck request failed", "request_failed");
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidOnDeckResponse(body)) {
		throw new PlexError(
			"Plex returned an unexpected response",
			"request_failed",
		);
	}
	return (body.MediaContainer.Metadata ?? [])
		.map(toContinueWatchingItem)
		.filter((item): item is ContinueWatchingItem => item !== null)
		.slice(0, limit);
}

// ---------------------------------------------------------------------------
// GAP B3 — library search: the user's OWNED catalog, not their watch
// history. `GET /library/sections/{key}/all?title=<query>` is queried once
// per library section (bounded by MAX_SEARCH_SECTIONS below) rather than the
// hub-grouped `/hubs/search`, which mixes in actors/genres/related-but-
// unowned suggestions — the wrong shape for "do I have The Matrix?"/"how
// many movies do I own?". Omitting `query` entirely (Plex's own `title=`
// filter is optional) lists/counts a section's whole contents, which is what
// powers the "how many X do I own" case without requiring a text query.
// ---------------------------------------------------------------------------

export type LibrarySearchItem = {
	title: string;
	year?: number;
	type: string;
	section: string;
};

export type LibrarySearchResult = {
	items: LibrarySearchItem[];
	// The true match count across all searched sections (from each section's
	// MediaContainer size/totalSize), NOT capped by `limit` — `items` is
	// capped for readability, `totalCount` answers "how many do I own" even
	// when there are more matches than were returned.
	totalCount: number;
};

type LibrarySearchMetadataEntry = {
	title?: string;
	type?: string;
	year?: number;
};

type LibrarySearchResponse = {
	MediaContainer: {
		size?: number;
		totalSize?: number;
		Metadata?: LibrarySearchMetadataEntry[];
	};
};

function isValidLibrarySearchResponse(
	value: unknown,
): value is LibrarySearchResponse {
	if (!value || typeof value !== "object") return false;
	const mediaContainer = (value as Record<string, unknown>).MediaContainer;
	if (!mediaContainer || typeof mediaContainer !== "object") return false;
	const metadata = (mediaContainer as Record<string, unknown>).Metadata;
	return metadata === undefined || Array.isArray(metadata);
}

const DEFAULT_LIBRARY_SEARCH_LIMIT = 25;
const MAX_LIBRARY_SEARCH_LIMIT = 100;
// Request-bounds guard: a search fans out to one request per library
// section, in addition to the one `/library/sections` lookup — cap the
// number of sections walked so a server with an unusually large number of
// sections can't turn one tool call into an unbounded number of requests.
const MAX_SEARCH_SECTIONS = 25;

function clampLibrarySearchLimit(limit: number | undefined): number {
	const requested = limit ?? DEFAULT_LIBRARY_SEARCH_LIMIT;
	if (!Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_LIBRARY_SEARCH_LIMIT;
	}
	return Math.min(Math.floor(requested), MAX_LIBRARY_SEARCH_LIMIT);
}

export async function plexLibrarySearch(
	userId: string,
	connectionId: string,
	params: { query?: string; limit?: number },
	opts?: FetchOpt,
): Promise<LibrarySearchResult> {
	const limit = clampLibrarySearchLimit(params.limit);
	const query = params.query?.trim();

	const sections = (
		await fetchLibrarySectionsWithKeys(userId, connectionId, opts)
	).slice(0, MAX_SEARCH_SECTIONS);

	const items: LibrarySearchItem[] = [];
	let totalCount = 0;

	for (const section of sections) {
		const response = await plexAuthorizedRequest(
			userId,
			connectionId,
			() =>
				query
					? `/library/sections/${encodeURIComponent(section.key)}/all?title=${encodeURIComponent(query)}`
					: `/library/sections/${encodeURIComponent(section.key)}/all`,
			opts,
			{ size: MAX_LIBRARY_SEARCH_LIMIT, start: 0 },
		);
		// Best-effort per section: a section whose type doesn't support this
		// query shape shouldn't fail the whole cross-library search — skip it
		// and keep going. A 401 still propagates (plexAuthorizedRequest throws
		// before returning a response in that case), so an invalid/expired
		// token still surfaces as needs_reauth.
		if (!response.ok) continue;
		const body: unknown = await response.json().catch(() => null);
		if (!isValidLibrarySearchResponse(body)) continue;

		const entries = body.MediaContainer.Metadata ?? [];
		totalCount +=
			body.MediaContainer.totalSize ??
			body.MediaContainer.size ??
			entries.length;

		for (const entry of entries) {
			if (!entry.title || !entry.type) continue;
			if (items.length < limit) {
				items.push({
					title: entry.title,
					...(entry.year !== undefined ? { year: entry.year } : {}),
					type: entry.type,
					section: section.title,
				});
			}
		}
	}

	return { items, totalCount };
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
			status:
				err instanceof PlexError && err.code === "needs_reauth"
					? "needs_reauth"
					: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	const fetchImpl = opts?.fetch ?? fetch;
	try {
		if (!config.linked && secret.trimStart().startsWith("{"))
			throw new PlexError(
				"Plex credentials changed during the request",
				"request_failed",
			);
		const response = config.linked
			? await plexAuthorizedRequest(
					conn.userId,
					conn.id,
					() => "/library/sections",
					opts,
				)
			: await providerFetch(`${config.origin}/identity`, {
					headers: plexHeaders(secret),
					fetch: fetchImpl,
					timeoutError: plexTimeout,
				});
		if (response.status === 401 || response.status === 498) {
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
			status:
				err instanceof PlexError && err.code === "needs_reauth"
					? "needs_reauth"
					: "error",
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
