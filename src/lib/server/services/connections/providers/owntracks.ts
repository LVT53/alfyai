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

export class OwnTracksError extends Error {
	constructor(
		message: string,
		public readonly code: OwnTracksErrorCode,
	) {
		super(message);
		this.name = "OwnTracksError";
	}
}

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
	const to = params.to?.trim() || formatDateOnly(now);
	const from =
		params.from?.trim() ||
		formatDateOnly(
			new Date(now.getTime() - DEFAULT_HISTORY_DAYS * 24 * 60 * 60 * 1000),
		);
	const limit = clampHistoryLimit(params.limit);

	const qs = `user=${encodeURIComponent(deviceConfig.otUser)}&device=${encodeURIComponent(deviceConfig.otDevice)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=json`;
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
	return body.data.filter(isValidPosition).map(toLocationFix).slice(0, limit);
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
		const response = await fetchImpl(
			`${server.origin}/api/0/last?user=${encodeURIComponent(deviceConfig.otUser)}&device=${encodeURIComponent(deviceConfig.otDevice)}`,
			{ headers: recorderHeaders(server.authHeader) },
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
	checkHealth,
};

registerConnectionAdapter(owntracksAdapter satisfies ConnectionAdapter);
