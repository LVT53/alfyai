// OwnTracks Recorder (on-box location) connect + read (5.7). Read-only.
//
// **STRICT PER-USER DEVICE ISOLATION IS THE POINT OF THIS MODULE.** The
// recorder is a single on-box instance that holds EVERY AlfyAI user's device
// under one `(otUser, otDevice)` keyspace — the recorder itself has no notion
// of "which AlfyAI user is asking". So the isolation boundary is enforced
// entirely here, in this module, by construction:
//   - `owntracksLastLocation`/`owntracksLocationHistory` take only
//     `(userId, connectionId)` — there is NO parameter anywhere that lets a
//     caller pass an otUser/otDevice/connection override.
//   - Both load the connection **user-scoped** via `getConnection(userId,
//     connectionId)` (the store's WHERE clause already scopes by userId), and
//     read `otUser`/`otDevice` ONLY from that connection's own stored
//     `config`. If the connection doesn't exist, isn't the caller's, or isn't
//     an `owntracks` connection, the function returns a graceful empty
//     result and — critically — never calls the recorder at all.
// A dedicated ISOLATION test in owntracks.test.ts pins exactly this: userA
// reading userB's connectionId gets nothing back and the recorder mock is
// never invoked with userB's device.
//
// Unlike Immich/Plex/Nextcloud (user pastes an external server URL that then
// needs the `assertPublicHttpsUrl` SSRF guard), the OwnTracks Recorder is an
// **on-box service** reachable at a loopback/LAN address the ADMIN
// configures once (`OWNTRACKS_RECORDER_URL`, see config-store.ts). The user
// never supplies this URL — they only self-select their `(otUser,
// otDevice)` — so there is no user-controlled server-side fetch target, and
// this is deliberately the one connector whose base URL is NOT run through
// the public-host SSRF guard.
import { getConfig } from "$lib/server/config-store";
import { registerConnectionAdapter } from "../adapters";
import { ConnectionHttpError, providerFetch } from "../provider-http";
import type { ConnectionAdapter } from "../registry";
import {
	type ConnectionPublic,
	createConnection,
	findConnectionByAccount,
	getConnection,
	updateConnection,
} from "../store";

type FetchOpt = { fetch?: typeof fetch };

export type OwnTracksErrorCode =
	| "not_configured"
	| "invalid_config"
	| "request_failed";

export class OwnTracksError extends ConnectionHttpError<OwnTracksErrorCode> {
	constructor(message: string, code: OwnTracksErrorCode) {
		super(message, code);
		this.name = "OwnTracksError";
	}
}

// Timeout error for the health check now routed through providerFetch —
// previously this call had no timeout wrapper at all (B1 closes that gap so
// the ~15s bound is uniform with every other provider's health check).
const owntracksTimeout = (ms: number) =>
	new OwnTracksError(
		`OwnTracks request timed out after ${ms}ms`,
		"request_failed",
	);

// ---------------------------------------------------------------------------
// Admin config gate — the recorder URL/creds are server config, never
// user-supplied. Empty URL => connector not configured on this server.
// ---------------------------------------------------------------------------

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

type OwnTracksServerConfig = { origin: string; authHeader?: string };

function requireOwntracksConfig(): OwnTracksServerConfig {
	const cfg = getConfig();
	const baseUrl = cfg.owntracksRecorderUrl?.trim();
	if (!baseUrl) {
		throw new OwnTracksError(
			"OwnTracks is not configured on this server",
			"not_configured",
		);
	}
	const origin = stripTrailingSlashes(baseUrl);
	const user = cfg.owntracksRecorderUser?.trim();
	if (!user) return { origin };
	const pass = cfg.owntracksRecorderPass ?? "";
	const authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
	return { origin, authHeader };
}

function recorderHeaders(authHeader: string | undefined): HeadersInit {
	return {
		Accept: "application/json",
		...(authHeader ? { Authorization: authHeader } : {}),
	};
}

// ---------------------------------------------------------------------------
// Shared recorder request plumbing
// ---------------------------------------------------------------------------

async function recorderGet(
	fetchImpl: typeof fetch,
	server: OwnTracksServerConfig,
	path: string,
): Promise<Response> {
	let response: Response;
	try {
		response = await fetchImpl(`${server.origin}${path}`, {
			headers: recorderHeaders(server.authHeader),
		});
	} catch {
		throw new OwnTracksError(
			"Failed to reach the OwnTracks recorder",
			"request_failed",
		);
	}
	if (!response.ok) {
		throw new OwnTracksError(
			`OwnTracks recorder request failed with status ${response.status}`,
			"request_failed",
		);
	}
	return response;
}

type ListResponse = { results: string[] };

function isValidListResponse(value: unknown): value is ListResponse {
	if (!value || typeof value !== "object") return false;
	const results = (value as Record<string, unknown>).results;
	return (
		Array.isArray(results) &&
		results.every((item): item is string => typeof item === "string")
	);
}

// ---------------------------------------------------------------------------
// Connect — two-step self-selection: list all (otUser, otDevice) pairs on
// the recorder so the UI can present a picker, then bind the one the user
// picked to a connection. Listing at connect time deliberately shows every
// device on the (trusted, single-org, on-box) recorder — the isolation
// guarantee that matters is enforced at READ time via the stored binding,
// not by hiding the picker. v1 scope; see the module doc comment above.
// ---------------------------------------------------------------------------

export async function owntracksListDevices(
	_userId: string,
	opts?: FetchOpt,
): Promise<{ otUser: string; otDevice: string }[]> {
	const server = requireOwntracksConfig();
	const fetchImpl = opts?.fetch ?? fetch;

	const usersResponse = await recorderGet(fetchImpl, server, "/api/0/list");
	const usersBody: unknown = await usersResponse.json().catch(() => null);
	if (!isValidListResponse(usersBody)) {
		throw new OwnTracksError(
			"OwnTracks recorder returned an unexpected response",
			"request_failed",
		);
	}

	const pairs: { otUser: string; otDevice: string }[] = [];
	for (const otUser of usersBody.results) {
		const devicesResponse = await recorderGet(
			fetchImpl,
			server,
			`/api/0/list?user=${encodeURIComponent(otUser)}`,
		);
		const devicesBody: unknown = await devicesResponse.json().catch(() => null);
		if (!isValidListResponse(devicesBody)) continue;
		for (const otDevice of devicesBody.results) {
			pairs.push({ otUser, otDevice });
		}
	}
	return pairs;
}

export type OwnTracksConnectionConfig = { otUser: string; otDevice: string };

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function upsertOwnTracksConnection(params: {
	userId: string;
	accountIdentifier: string;
	label: string;
	config: OwnTracksConnectionConfig;
}): Promise<ConnectionPublic> {
	const existing = await findConnectionByAccount(
		params.userId,
		"owntracks",
		params.accountIdentifier,
	);
	if (existing) {
		const updated = await updateConnection(params.userId, existing.id, {
			label: params.label,
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated)
			throw new Error("Failed to update existing OwnTracks connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "owntracks",
			label: params.label,
			accountIdentifier: params.accountIdentifier,
			capabilities: ["location"],
			status: "connected",
			// No secret: the recorder is admin-configured server-side; there is
			// no per-user credential to store for this connection.
			config: params.config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent connect attempt — same pattern as
		// plex.ts's/immich.ts's upsert helpers.
		const raced = await findConnectionByAccount(
			params.userId,
			"owntracks",
			params.accountIdentifier,
		);
		if (!raced) throw err;
		const updated = await updateConnection(params.userId, raced.id, {
			label: params.label,
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated) throw err;
		return updated;
	}
}

export async function owntracksConnect(
	params: {
		userId: string;
		otUser: string;
		otDevice: string;
		label?: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	// Even though this step doesn't itself call the recorder, gate on the
	// admin config here too so a client that skips owntracksListDevices can't
	// bind a connection when OwnTracks isn't configured on this server.
	requireOwntracksConfig();

	const otUser = params.otUser.trim();
	const otDevice = params.otDevice.trim();
	if (!otUser || !otDevice) {
		throw new OwnTracksError(
			"An OwnTracks user and device are required",
			"invalid_config",
		);
	}

	const accountIdentifier = `${otUser}/${otDevice}`;
	const connection = await upsertOwnTracksConnection({
		userId: params.userId,
		accountIdentifier,
		label: params.label?.trim() || "OwnTracks",
		config: { otUser, otDevice },
	});
	return { connection };
}

// ---------------------------------------------------------------------------
// Read — see the module doc comment: this is the isolation chokepoint.
// ---------------------------------------------------------------------------

export type LocationFix = {
	lat: number;
	lon: number;
	at: string;
	place?: string;
	battery?: number;
};

type Position = {
	lat?: unknown;
	lon?: unknown;
	tst?: unknown;
	addr?: unknown;
	batt?: unknown;
};

function isValidPosition(
	value: unknown,
): value is Position & { lat: number; lon: number; tst: number } {
	if (!value || typeof value !== "object") return false;
	const v = value as Position;
	return (
		typeof v.lat === "number" &&
		typeof v.lon === "number" &&
		typeof v.tst === "number"
	);
}

function toLocationFix(
	pos: Position & { lat: number; lon: number; tst: number },
): LocationFix {
	return {
		lat: pos.lat,
		lon: pos.lon,
		at: new Date(pos.tst * 1000).toISOString(),
		...(typeof pos.addr === "string" && pos.addr.trim()
			? { place: pos.addr }
			: {}),
		...(typeof pos.batt === "number" ? { battery: pos.batt } : {}),
	};
}

// ---------------------------------------------------------------------------
// B7 — place-based history & distance helpers. Pure functions: no recorder
// calls, no new persistence. They operate only on data already returned by
// owntracksLastLocation/owntracksLocationHistory (LocationFix[]) or already
// stored on the connection's own config (ConnectionPublic).
// ---------------------------------------------------------------------------

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}

// Great-circle distance between two lat/lon points, in meters. Used to
// answer "how far did I travel" / "how far is X from Y" once two points are
// known — it never itself resolves *which* two points to compare, that's the
// caller's job (see runLocationTool's "distance" action in location.ts).
export function haversineDistanceMeters(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	const dLat = toRadians(b.lat - a.lat);
	const dLon = toRadians(b.lon - a.lon);
	const lat1 = toRadians(a.lat);
	const lat2 = toRadians(b.lat);
	const sinDLat = Math.sin(dLat / 2);
	const sinDLon = Math.sin(dLon / 2);
	const h =
		sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
	const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
	return EARTH_RADIUS_METERS * c;
}

export type PlaceVisit = {
	place: string;
	from: string;
	to: string;
	fixCount: number;
};

const UNKNOWN_PLACE_LABEL = "Unknown location";

// Collapses a chronological (oldest->newest) LocationFix[] — e.g. the output
// of owntracksLocationHistory — into a compact "places visited" summary: a
// run of CONSECUTIVE fixes sharing the same place label becomes one visit
// with a from/to time span and a fix count, instead of the model having to
// wade through hundreds of raw points to answer "was I at the office
// yesterday". Deliberately consecutive-only (not a global group-by-place):
// re-visiting the same place later in the range is a second, distinct visit,
// which preserves the order/story of the day rather than merging separate
// trips into one bucket. Fixes with no reverse-geocoded place fall under a
// single "Unknown location" label, same consecutive-run rule.
export function groupFixesByPlace(fixes: LocationFix[]): PlaceVisit[] {
	const visits: PlaceVisit[] = [];
	for (const fix of fixes) {
		const label = fix.place?.trim() || UNKNOWN_PLACE_LABEL;
		const last = visits[visits.length - 1];
		if (last && last.place === label) {
			last.to = fix.at;
			last.fixCount += 1;
		} else {
			visits.push({ place: label, from: fix.at, to: fix.at, fixCount: 1 });
		}
	}
	return visits;
}

// Opportunistic read of a home/reference coordinate the connection's own
// config *already* carries (e.g. { otUser, otDevice, homeLat, homeLon}) —
// deliberately NOT a new persistence layer: none of the OwnTracks connect/
// read endpoints used by this module ever populate homeLat/homeLon, so in
// practice this returns null today. It exists so that if such a field is
// ever added to a connection's config (by an admin, a future settings UI,
// etc.) the "how far am I from home" distance action picks it up for free,
// without this module needing to change. See location.ts's "distance"
// action for the graceful "home isn't set" fallback when this returns null.
export function ownTracksHomeReference(
	conn: ConnectionPublic,
): { lat: number; lon: number } | null {
	const lat = conn.config.homeLat;
	const lon = conn.config.homeLon;
	if (typeof lat === "number" && typeof lon === "number") return { lat, lon };
	return null;
}

// Loads (userId, connectionId) as an OwnTracks connection the caller owns.
// Returns null (never throws, never fetches) when the connection doesn't
// exist, belongs to someone else, or isn't an owntracks connection at all —
// this is the single chokepoint every read function routes through, and the
// reason a caller can never reach another user's (or another provider's)
// device data via this module.
async function loadOwnedOwnTracksConnection(
	userId: string,
	connectionId: string,
): Promise<ConnectionPublic | null> {
	const conn = await getConnection(userId, connectionId);
	if (!conn || conn.provider !== "owntracks") return null;
	return conn;
}

function ownTracksConnConfig(
	conn: ConnectionPublic,
): OwnTracksConnectionConfig | null {
	const otUser =
		typeof conn.config.otUser === "string" ? conn.config.otUser : "";
	const otDevice =
		typeof conn.config.otDevice === "string" ? conn.config.otDevice : "";
	if (!otUser || !otDevice) return null;
	return { otUser, otDevice };
}

async function recorderGetForConnection(
	userId: string,
	connectionId: string,
	path: string,
	opts?: FetchOpt,
): Promise<Response> {
	const server = requireOwntracksConfig();
	const fetchImpl = opts?.fetch ?? fetch;
	try {
		return await recorderGet(fetchImpl, server, path);
	} catch (err) {
		if (err instanceof OwnTracksError && err.code === "request_failed") {
			await updateConnection(userId, connectionId, {
				status: "error",
				statusDetail: err.message,
			});
		}
		throw err;
	}
}

export async function owntracksLastLocation(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<LocationFix | null> {
	const conn = await loadOwnedOwnTracksConnection(userId, connectionId);
	if (!conn) return null;
	const deviceConfig = ownTracksConnConfig(conn);
	if (!deviceConfig) return null;

	const qs = `user=${encodeURIComponent(deviceConfig.otUser)}&device=${encodeURIComponent(deviceConfig.otDevice)}`;
	const response = await recorderGetForConnection(
		userId,
		connectionId,
		`/api/0/last?${qs}`,
		opts,
	);
	const body: unknown = await response.json().catch(() => null);
	if (!Array.isArray(body)) {
		throw new OwnTracksError(
			"OwnTracks recorder returned an unexpected response",
			"request_failed",
		);
	}
	const first = body.find(isValidPosition);
	return first ? toLocationFix(first) : null;
}

const DEFAULT_HISTORY_DAYS = 7;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 500;

function clampHistoryLimit(limit: number | undefined): number {
	const requested = limit ?? DEFAULT_HISTORY_LIMIT;
	if (!Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_HISTORY_LIMIT;
	}
	return Math.min(Math.floor(requested), MAX_HISTORY_LIMIT);
}

function formatDateOnly(date: Date): string {
	return date.toISOString().slice(0, 10);
}

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// BUG2 fix: the Recorder's make_times (storage.c) parses a bare `YYYY-MM-DD`
// as 00:00:00 (the START) of that day. Used as the upper (`to`) bound, that
// silently excludes every fix from that entire day — including "today", the
// most common case ("where was I today?" returns nothing). Bump a bare date
// to the last second of that day; `%Y-%m-%dT%H:%M:%S` is one of the
// Recorder's own documented accepted formats, so this is always parsed
// correctly. Anything that already carries a time component (or any other
// caller-supplied shape) is passed through untouched — only a bare date is
// ambiguous about which end of the day it means.
function toInclusiveDateBound(value: string): string {
	return BARE_DATE_RE.test(value) ? `${value}T23:59:59` : value;
}

type LocationsResponse = { count?: unknown; data: unknown[] };

function isValidLocationsResponse(value: unknown): value is LocationsResponse {
	if (!value || typeof value !== "object") return false;
	return Array.isArray((value as Record<string, unknown>).data);
}

export async function owntracksLocationHistory(
	userId: string,
	connectionId: string,
	params: { from?: string; to?: string; limit?: number },
	opts?: FetchOpt,
): Promise<LocationFix[]> {
	const conn = await loadOwnedOwnTracksConnection(userId, connectionId);
	if (!conn) return [];
	const deviceConfig = ownTracksConnConfig(conn);
	if (!deviceConfig) return [];

	const now = new Date();
	const to = toInclusiveDateBound(params.to?.trim() || formatDateOnly(now));
	const from =
		params.from?.trim() ||
		formatDateOnly(
			new Date(now.getTime() - DEFAULT_HISTORY_DAYS * 24 * 60 * 60 * 1000),
		);
	const limit = clampHistoryLimit(params.limit);

	// BUG3 fix, belt and suspenders: `limit` is sent to the Recorder itself —
	// it "reverse searches" the .rec files for it (see API.md), returning the
	// most recent N positions and shrinking the payload — *and* the response
	// is independently sorted newest-first and re-sliced below. The second
	// step is the one that actually guarantees correctness: the Recorder's
	// lsscan (storage.c) returns rows oldest-first, so a plain
	// `.slice(0, limit)` on the raw response — the original bug — silently
	// kept the OLDEST fixes over any range longer than `limit`, not the most
	// recent ones a "recent locations" query wants.
	const qs = `user=${encodeURIComponent(deviceConfig.otUser)}&device=${encodeURIComponent(deviceConfig.otDevice)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=json&limit=${limit}`;
	const response = await recorderGetForConnection(
		userId,
		connectionId,
		`/api/0/locations?${qs}`,
		opts,
	);
	const body: unknown = await response.json().catch(() => null);
	if (!isValidLocationsResponse(body)) {
		throw new OwnTracksError(
			"OwnTracks recorder returned an unexpected response",
			"request_failed",
		);
	}
	const positions = body.data.filter(isValidPosition);
	// Select the newest `limit` fixes, then restore chronological
	// (oldest→newest) order for the returned shape — a "history" listing
	// reads naturally in time order, and this round-trip is a no-op whenever
	// everything already fits under `limit`.
	const newestFirst = [...positions].sort((a, b) => b.tst - a.tst);
	return newestFirst
		.slice(0, limit)
		.sort((a, b) => a.tst - b.tst)
		.map(toLocationFix);
}

// ---------------------------------------------------------------------------
// Adapter — a cheap GET /api/0/last for the stored binding confirms the
// recorder is reachable and knows about this device, without pulling any
// history. `secret` is unused (owntracks connections never have one) but
// kept in the signature to match the shared ConnectionAdapter shape.
// ---------------------------------------------------------------------------

async function checkHealth(
	_secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	const deviceConfig = ownTracksConnConfig(conn);
	if (!deviceConfig) {
		return {
			status: "error",
			detail: "Connection is missing otUser/otDevice in its config",
		};
	}

	let server: OwnTracksServerConfig;
	try {
		server = requireOwntracksConfig();
	} catch (err) {
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	const fetchImpl = opts?.fetch ?? fetch;
	try {
		const response = await providerFetch(
			`${server.origin}/api/0/last?user=${encodeURIComponent(deviceConfig.otUser)}&device=${encodeURIComponent(deviceConfig.otDevice)}`,
			{
				headers: recorderHeaders(server.authHeader),
				fetch: fetchImpl,
				timeoutError: owntracksTimeout,
			},
		);
		if (!response.ok) {
			return {
				status: "error",
				detail: `OwnTracks health check failed with status ${response.status}`,
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

// Not annotated as `: ConnectionAdapter` — same rationale as plexAdapter/
// immichAdapter: that annotation would narrow checkHealth's call signature to
// the interface's (secret, conn) shape and break the mocked-fetch tests that
// pass a third `{ fetch }` opts arg.
export const owntracksAdapter = {
	provider: "owntracks" as const,
	requiresSecret: false,
	checkHealth,
};

registerConnectionAdapter(owntracksAdapter satisfies ConnectionAdapter);
