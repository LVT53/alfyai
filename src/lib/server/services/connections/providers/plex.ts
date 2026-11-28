// Plex (self-hosted media server) connect + read (5.6). Watch-history,
// library-metadata, on-deck/continue-watching, and library search/catalog
// lookups ONLY — this module is, and must always remain, **strictly
// read-only**: Plex never gets a write path, not in this issue and not in a
// later phase. There is deliberately no function here that mutates anything
// on the user's Plex server (no scrobble/markWatched/markPlayed/etc) — a
// dedicated test in plex.test.ts asserts the module's exported surface never
// grows one.
//
// Hosted sign-in uses the selected server and the user's encrypted Plex
// device grant.

import { registerConnectionAdapter } from "../adapters";
import { ConnectionHttpError } from "../provider-http";
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
	linkedHeaders,
	linkedPlexGet,
	locateLinkedPlexServer,
	renewLinkedPlexServer,
} from "./plex-linked";

type FetchOpt = { fetch?: typeof fetch };

export type PlexErrorCode =
	| "history_unavailable"
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

export type PlexConnectionConfig = {
	origin: string;
	machineIdentifier: string;
	linked: true;
	// Hosted sign-in sets the local owner account only on a claimed server.
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
		linked: true,
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
// `container`, when supplied, sets the
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
	if (conn.config.linked !== true) {
		const detail = "Sign in with Plex to reconnect this server";
		await updateConnection(
			userId,
			connectionId,
			{ status: "needs_reauth", statusDetail: detail },
			credential.version,
		);
		throw new PlexError(detail, "needs_reauth");
	}
	const config = plexConfig(conn);
	let saved: LinkedPlexSecret;
	try {
		saved = JSON.parse(credential.value);
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
	const read = (origin: string, path: string, token: string) =>
		linkedPlexGet(origin, opts)(path, {
			...linkedHeaders(token, saved.device.clientId),
			...(container
				? {
						"X-Plex-Container-Size": String(container.size),
						"X-Plex-Container-Start": String(container.start),
					}
				: {}),
		});
	const path = buildPath(config);
	let initial: Response | undefined;
	try {
		initial = await read(config.origin, path, saved.serverToken);
	} catch {
		// A changed home address can retire the origin before its token expires.
	}
	if (initial && initial.status !== 401 && initial.status !== 498)
		return initial;
	const renewed = await refreshLinkedCredential(
		conn,
		config,
		saved,
		credential.version,
		opts,
	);
	return read(renewed.config.origin, buildPath(renewed.config), renewed.token);
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
// connection has one resolved — without it,
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
			linkedAccount = config.accountId;
			if (linkedAccount === undefined)
				throw new PlexError(
					"Plex history is unavailable for this account",
					"history_unavailable",
				);
			let queryString = `sort=viewedAt:desc&limit=${limit}&accountID=${linkedAccount}`;
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
				linkedAccount !== undefined && entry.accountID === linkedAccount,
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
// Health uses the same authenticated library read and renewal path as chat.
async function checkHealth(
	_secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	try {
		const response = await plexAuthorizedRequest(
			conn.userId,
			conn.id,
			() => "/library/sections",
			opts,
		);
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
			detail:
				err instanceof ConnectionHttpError
					? err.message
					: "Plex health check failed",
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
