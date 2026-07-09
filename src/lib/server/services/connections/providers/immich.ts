// Immich (self-hosted photos) connect + read (5.5). Connect is a one-time
// email+password login against the user's own Immich server, which this
// module immediately trades for a **scoped, read-only API key** — only that
// key is ever persisted (encrypted); the password is used once, in memory,
// to obtain it, and is never stored or logged. Every network call accepts an
// injectable `fetch` so the whole module is testable against mocked Immich
// endpoints — nothing here ever talks to a live Immich server in tests.
//
// Read-only by construction: `READ_ONLY_IMMICH_PERMISSIONS` is the only
// permission set this module will ever request when minting a key, and
// `assertReadOnlyPermissions` is called on it before every mint — a future
// edit that widens the set (adds `all`, a `.delete`/`.update`/`.upload`/
// `.create`/`.write` scope) fails loudly at connect time instead of silently
// granting write access. A dedicated test pins this.
import { registerConnectionAdapter } from "../adapters";
import type { ConnectionAdapter } from "../registry";
import {
	type ConnectionPublic,
	createConnection,
	findConnectionByAccount,
	getConnection,
	getConnectionSecret,
	setConnectionSecret,
	setConnectionWriteSecret,
	updateConnection,
} from "../store";
import { assertPublicHttpsUrl } from "./nextcloud-files";

type FetchOpt = { fetch?: typeof fetch };

const REQUEST_TIMEOUT_MS = 15_000;

export type ImmichErrorCode =
	| "invalid_credentials"
	| "invalid_config"
	| "needs_reauth"
	| "request_failed"
	| "connection_not_found";

export class ImmichError extends Error {
	constructor(
		message: string,
		public readonly code: ImmichErrorCode,
	) {
		super(message);
		this.name = "ImmichError";
	}
}

// ---------------------------------------------------------------------------
// Structural read-only guard
// ---------------------------------------------------------------------------

export const READ_ONLY_IMMICH_PERMISSIONS = [
	"asset.read",
	"asset.view",
	"asset.download",
	"album.read",
] as const;

const FORBIDDEN_EXACT_PERMISSIONS = new Set([
	"all",
	"asset.delete",
	"asset.update",
	"asset.upload",
	"asset.replace",
]);
const FORBIDDEN_PERMISSION_SUFFIXES = [
	".delete",
	".update",
	".upload",
	".create",
	".write",
];

// Throws if `permissions` contains anything that isn't structurally
// read-only. Called on every key mint (not just in tests) so a future edit
// to READ_ONLY_IMMICH_PERMISSIONS — or a caller passing its own permission
// list — can't silently widen the key past read access.
export function assertReadOnlyPermissions(
	permissions: readonly string[],
): void {
	for (const permission of permissions) {
		const isForbidden =
			FORBIDDEN_EXACT_PERMISSIONS.has(permission) ||
			FORBIDDEN_PERMISSION_SUFFIXES.some((suffix) =>
				permission.endsWith(suffix),
			);
		if (isForbidden) {
			throw new Error(
				`Refusing to request a non-read-only Immich permission: ${permission}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Server URL normalization
// ---------------------------------------------------------------------------

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

// Accepts `https://host`, `https://host/`, or `https://host/api` (with or
// without a trailing slash) and always returns the bare origin the way the
// rest of this module expects to build `{origin}/api/...` calls. Delegates
// the https + private/loopback/link-local host guard to the shared
// `assertPublicHttpsUrl` (see nextcloud-files.ts) — the user-pasted server
// URL here is fetched server-side with the user's secret attached, exactly
// like the Nextcloud connector's serverUrl, so it needs the same SSRF guard.
function normalizeOrigin(serverUrl: string): string {
	const trimmed = serverUrl.trim();
	if (!trimmed) {
		throw new ImmichError("A server URL is required", "invalid_config");
	}
	let validated: string;
	try {
		validated = assertPublicHttpsUrl(trimmed);
	} catch (err) {
		throw new ImmichError(
			err instanceof Error ? err.message : String(err),
			"invalid_config",
		);
	}
	let origin = stripTrailingSlashes(validated);
	if (/\/api$/i.test(origin)) {
		origin = stripTrailingSlashes(origin.slice(0, -4));
	}
	if (!origin) {
		throw new ImmichError("A server URL is required", "invalid_config");
	}
	return origin;
}

// ---------------------------------------------------------------------------
// Shared request plumbing
// ---------------------------------------------------------------------------

// Bounds every Immich HTTP call to ~15s via AbortController so a
// reachable-but-hung Immich server can't stall a chat turn indefinitely —
// mirrors the same pattern in providers/nextcloud-files.ts and
// providers/google-calendar.ts. The injectable `fetchImpl` is passed straight
// through (with `signal` added), so every call site below — and every test
// that supplies its own mocked fetch — keeps working unchanged. Every call
// site already wraps its `fetchWithTimeout` call in its own try/catch that
// maps ANY thrown error (network failure or this timeout) to that call
// site's contextual ImmichError message, so a timeout surfaces through the
// exact same "couldn't reach the server" / request_failed path an ordinary
// network failure would.
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
			throw new ImmichError(
				`Immich request timed out after ${timeoutMs}ms`,
				"request_failed",
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Login + key mint
// ---------------------------------------------------------------------------

type LoginResponse = { accessToken: string; userId: string; userEmail: string };

function isValidLoginResponse(value: unknown): value is LoginResponse {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.accessToken === "string" &&
		v.accessToken.length > 0 &&
		typeof v.userId === "string" &&
		v.userId.length > 0 &&
		typeof v.userEmail === "string" &&
		v.userEmail.length > 0
	);
}

async function immichLogin(
	fetchImpl: typeof fetch,
	origin: string,
	email: string,
	password: string,
): Promise<LoginResponse> {
	let response: Response;
	try {
		response = await fetchWithTimeout(fetchImpl, `${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password }),
		});
	} catch {
		throw new ImmichError(
			"Could not reach the Immich server. Check the server URL.",
			"request_failed",
		);
	}
	if (response.status === 401) {
		throw new ImmichError("Invalid Immich credentials", "invalid_credentials");
	}
	if (!response.ok) {
		throw new ImmichError(
			"Could not reach the Immich server. Check the server URL.",
			"request_failed",
		);
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidLoginResponse(body)) {
		throw new ImmichError(
			"Immich login returned an unexpected response",
			"request_failed",
		);
	}
	return body;
}

type ApiKeyResponse = { secret: string };

function isValidApiKeyResponse(value: unknown): value is ApiKeyResponse {
	if (!value || typeof value !== "object") return false;
	const secret = (value as Record<string, unknown>).secret;
	return typeof secret === "string" && secret.length > 0;
}

const READ_ONLY_API_KEY_NAME = "AlfyAI (read-only)";

async function mintReadOnlyApiKey(
	fetchImpl: typeof fetch,
	origin: string,
	accessToken: string,
): Promise<string> {
	// Structural safety: assert before every request, not just at module
	// load — this is the one call site that actually mints a key.
	assertReadOnlyPermissions(READ_ONLY_IMMICH_PERMISSIONS);

	let response: Response;
	try {
		response = await fetchWithTimeout(fetchImpl, `${origin}/api/api-keys`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({
				name: READ_ONLY_API_KEY_NAME,
				permissions: READ_ONLY_IMMICH_PERMISSIONS,
			}),
		});
	} catch {
		throw new ImmichError(
			"Could not reach the Immich server to create an API key",
			"request_failed",
		);
	}
	if (!response.ok) {
		throw new ImmichError(
			"Failed to create a read-only Immich API key",
			"request_failed",
		);
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidApiKeyResponse(body)) {
		throw new ImmichError(
			"Immich API key creation returned an unexpected response",
			"request_failed",
		);
	}
	return body.secret;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export type ImmichConnectionConfig = {
	origin: string;
	immichUserId: string;
};

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function upsertImmichConnection(params: {
	userId: string;
	email: string;
	secret: string;
	config: ImmichConnectionConfig;
}): Promise<ConnectionPublic> {
	const existing = await findConnectionByAccount(
		params.userId,
		"immich",
		params.email,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.secret);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated)
			throw new Error("Failed to update existing Immich connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "immich",
			label: "Immich",
			accountIdentifier: params.email,
			capabilities: ["photos"],
			status: "connected",
			secret: params.secret,
			config: params.config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent connect attempt — same pattern as
		// imap.ts's upsertImapConnection / apple-caldav.ts's upsert helper.
		const raced = await findConnectionByAccount(
			params.userId,
			"immich",
			params.email,
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

export async function immichConnect(
	params: {
		userId: string;
		serverUrl: string;
		email: string;
		password: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	const email = params.email.trim();
	if (!email) {
		throw new ImmichError("An email address is required", "invalid_config");
	}
	if (!params.password) {
		throw new ImmichError("A password is required", "invalid_config");
	}
	const origin = normalizeOrigin(params.serverUrl);
	const fetchImpl = params.fetch ?? fetch;

	const login = await immichLogin(fetchImpl, origin, email, params.password);
	const secret = await mintReadOnlyApiKey(fetchImpl, origin, login.accessToken);

	const connection = await upsertImmichConnection({
		userId: params.userId,
		email: login.userEmail,
		secret,
		config: { origin, immichUserId: login.userId },
	});
	return { connection };
}

// ---------------------------------------------------------------------------
// Write-scoped key (Issue 6.4) — a SEPARATE key from the read-only one
// minted above. The 5.5 read key is structurally read-only and must stay
// that way (see READ_ONLY_IMMICH_PERMISSIONS/assertReadOnlyPermissions
// above, which forbids `.create` too — appropriate for a key that must
// never write anything at all). Album organization needs `album.create` +
// `albumAsset.create`, so those two CANNOT go through
// assertReadOnlyPermissions unchanged; instead this write key is asserted
// against a narrower, explicit danger-list: it must never carry
// delete/update/upload/`all` — the operations that could destroy or mutate
// an existing asset. `album.create`/`albumAsset.create`/`album.read` all
// pass this guard; nothing that deletes or overwrites a photo ever will.
// ---------------------------------------------------------------------------

export const WRITE_IMMICH_PERMISSIONS = [
	"album.create",
	"albumAsset.create",
	"album.read",
] as const;

const FORBIDDEN_WRITE_EXACT_PERMISSIONS = new Set(["all"]);
const FORBIDDEN_WRITE_PERMISSION_SUFFIXES = [".delete", ".update", ".upload"];

// Throws if `permissions` contains anything that could delete, overwrite, or
// upload/replace asset bytes. Deliberately narrower than
// assertReadOnlyPermissions (which also forbids `.create`) — this guard is
// for the write-scoped album key, which legitimately needs `album.create`/
// `albumAsset.create`. Called on every mint, not just in tests, so a future
// edit that widens WRITE_IMMICH_PERMISSIONS toward `asset.delete`,
// `asset.update`, `asset.upload`, or `all` fails loudly at mint time.
export function assertNoDangerousImmichWritePermissions(
	permissions: readonly string[],
): void {
	for (const permission of permissions) {
		const isForbidden =
			FORBIDDEN_WRITE_EXACT_PERMISSIONS.has(permission) ||
			FORBIDDEN_WRITE_PERMISSION_SUFFIXES.some((suffix) =>
				permission.endsWith(suffix),
			);
		if (isForbidden) {
			throw new Error(
				`Refusing to request a dangerous Immich write permission: ${permission}`,
			);
		}
	}
}

const WRITE_API_KEY_NAME = "AlfyAI (album write)";

async function mintWriteApiKey(
	fetchImpl: typeof fetch,
	origin: string,
	accessToken: string,
): Promise<string> {
	// Structural safety: assert before every request, not just at module
	// load — this is the one call site that actually mints this key.
	assertNoDangerousImmichWritePermissions(WRITE_IMMICH_PERMISSIONS);

	let response: Response;
	try {
		response = await fetchWithTimeout(fetchImpl, `${origin}/api/api-keys`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({
				name: WRITE_API_KEY_NAME,
				permissions: WRITE_IMMICH_PERMISSIONS,
			}),
		});
	} catch {
		throw new ImmichError(
			"Could not reach the Immich server to create an API key",
			"request_failed",
		);
	}
	if (!response.ok) {
		throw new ImmichError(
			"Failed to create a write-scoped Immich API key",
			"request_failed",
		);
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidApiKeyResponse(body)) {
		throw new ImmichError(
			"Immich API key creation returned an unexpected response",
			"request_failed",
		);
	}
	return body.secret;
}

// Provisions the write-scoped key for an EXISTING Immich connection (created
// earlier via immichConnect/5.5's read-only flow). Re-runs immichLogin with
// the password (used only in memory, never stored — same posture as
// immichConnect) to obtain a fresh access token, mints the write-scoped key,
// and stores it via setConnectionWriteSecret — entirely separate storage
// from the read-only key's columns. This does NOT touch `allowWrites`: that
// remains the user's own separate toggle (write-guard.ts's posture is that a
// key existing is not the same as writes being turned on).
export async function immichEnableWrites(
	params: {
		userId: string;
		connectionId: string;
		password: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	if (!params.password) {
		throw new ImmichError("A password is required", "invalid_config");
	}
	const conn = await getConnection(params.userId, params.connectionId);
	if (!conn || conn.provider !== "immich") {
		throw new ImmichError(
			"Immich connection not found",
			"connection_not_found",
		);
	}
	const { origin } = immichConfig(conn);
	const email = conn.accountIdentifier;
	const fetchImpl = params.fetch ?? fetch;

	const login = await immichLogin(fetchImpl, origin, email, params.password);
	const secret = await mintWriteApiKey(fetchImpl, origin, login.accessToken);
	await setConnectionWriteSecret(params.userId, params.connectionId, secret);

	const updated = await getConnection(params.userId, params.connectionId);
	if (!updated) {
		throw new ImmichError(
			"Immich connection not found",
			"connection_not_found",
		);
	}
	return { connection: updated };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// No `people` field: Immich's smart-search endpoint (SmartSearchDto) has no
// withPeople parameter and its repo path never joins faces, so a people list
// can never be honestly populated here — see peopleFromAsset's removal and
// the "never surfaces a 'people' field" regression test in immich.test.ts.
export type PhotoResult = {
	id: string;
	fileName: string;
	takenAt: string;
	type: "IMAGE" | "VIDEO";
	place?: string;
	description?: string;
	// A relative reference for the Sources-tab UI to render a thumbnail from
	// — never sent to the model (see the `photos` chat tool).
	thumbnailPath: string;
};

type ImmichAssetExif = {
	city?: string;
	state?: string;
	country?: string;
	description?: string;
	dateTimeOriginal?: string;
};

type ImmichAsset = {
	id: string;
	originalFileName: string;
	fileCreatedAt: string;
	type: "IMAGE" | "VIDEO";
	exifInfo?: ImmichAssetExif;
};

type SmartSearchResponse = { assets: { items: ImmichAsset[] } };

function isValidSmartSearchResponse(
	value: unknown,
): value is SmartSearchResponse {
	if (!value || typeof value !== "object") return false;
	const assets = (value as Record<string, unknown>).assets;
	if (!assets || typeof assets !== "object") return false;
	return Array.isArray((assets as Record<string, unknown>).items);
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
	const requested = limit ?? DEFAULT_SEARCH_LIMIT;
	if (!Number.isFinite(requested) || requested <= 0)
		return DEFAULT_SEARCH_LIMIT;
	return Math.min(Math.floor(requested), MAX_SEARCH_LIMIT);
}

function immichConfig(conn: ConnectionPublic): ImmichConnectionConfig {
	const origin =
		typeof conn.config.origin === "string" ? conn.config.origin : "";
	const immichUserId =
		typeof conn.config.immichUserId === "string"
			? conn.config.immichUserId
			: "";
	if (!origin) {
		throw new ImmichError(
			"Connection is missing origin in its config",
			"invalid_config",
		);
	}
	return { origin, immichUserId };
}

function placeFromExif(exif: ImmichAssetExif | undefined): string | undefined {
	if (!exif) return undefined;
	const parts = [exif.city, exif.state, exif.country].filter(
		(value): value is string => Boolean(value?.trim()),
	);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function toPhotoResult(asset: ImmichAsset): PhotoResult {
	const place = placeFromExif(asset.exifInfo);
	const description = asset.exifInfo?.description?.trim();
	return {
		id: asset.id,
		fileName: asset.originalFileName,
		takenAt: asset.exifInfo?.dateTimeOriginal ?? asset.fileCreatedAt,
		type: asset.type,
		...(place ? { place } : {}),
		...(description ? { description } : {}),
		thumbnailPath: `/api/assets/${asset.id}/thumbnail`,
	};
}

// Loads the connection + decrypted API key, marking the connection
// needs_reauth on a 401 before rethrowing — the one chokepoint every
// authorized Immich call routes through. Never logs or throws the key/
// password: thrown ImmichError messages are always static strings.
async function immichAuthorizedRequest(
	userId: string,
	connectionId: string,
	path: string,
	init: RequestInit,
	opts?: FetchOpt,
): Promise<Response> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new ImmichError(
			"Immich connection not found",
			"connection_not_found",
		);
	}
	const apiKey = await getConnectionSecret(userId, connectionId);
	if (!apiKey) {
		throw new ImmichError(
			"No API key stored for this Immich connection",
			"needs_reauth",
		);
	}
	const { origin } = immichConfig(conn);
	const fetchImpl = opts?.fetch ?? fetch;

	let response: Response;
	try {
		response = await fetchWithTimeout(fetchImpl, `${origin}${path}`, {
			...init,
			headers: { ...(init.headers ?? {}), "x-api-key": apiKey },
		});
	} catch {
		throw new ImmichError(
			"Failed to reach the Immich server",
			"request_failed",
		);
	}
	if (response.status === 401) {
		const detail = "Immich rejected the stored API key";
		await updateConnection(userId, connectionId, {
			status: "needs_reauth",
			statusDetail: detail,
		});
		throw new ImmichError(detail, "needs_reauth");
	}
	return response;
}

export async function immichSmartSearch(
	userId: string,
	connectionId: string,
	params: { query: string; limit?: number },
	opts?: FetchOpt,
): Promise<PhotoResult[]> {
	const limit = clampLimit(params.limit);
	const response = await immichAuthorizedRequest(
		userId,
		connectionId,
		"/api/search/smart",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// withExif is required: SmartSearchDto only joins the exif relation
			// (city/state/country/description/dateTimeOriginal) when this is set
			// — without it, place/description are always empty and takenAt always
			// falls back to fileCreatedAt (upload time, not capture time).
			body: JSON.stringify({
				query: params.query,
				size: limit,
				withExif: true,
			}),
		},
		opts,
	);
	if (!response.ok) {
		throw new ImmichError(
			"Immich smart search request failed",
			"request_failed",
		);
	}
	const body: unknown = await response.json().catch(() => null);
	if (!isValidSmartSearchResponse(body)) {
		throw new ImmichError(
			"Immich smart search returned an unexpected response",
			"request_failed",
		);
	}
	return body.assets.items.slice(0, limit).map(toPhotoResult);
}

export async function immichThumbnail(
	userId: string,
	connectionId: string,
	params: { assetId: string },
	opts?: FetchOpt,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
	const response = await immichAuthorizedRequest(
		userId,
		connectionId,
		`/api/assets/${encodeURIComponent(params.assetId)}/thumbnail`,
		{ method: "GET" },
		opts,
	);
	if (!response.ok) {
		throw new ImmichError(
			"Failed to fetch the photo thumbnail",
			"request_failed",
		);
	}
	const bytes = await response.arrayBuffer();
	const contentType =
		response.headers.get("content-type") ?? "application/octet-stream";
	return { bytes, contentType };
}

// ---------------------------------------------------------------------------
// Adapter — a cheap authorized call confirms the stored read-only key still
// works, without touching any photo data. Deliberately probes GET
// /api/albums rather than GET /api/users/me: /users/me requires the
// `user.read` permission, which READ_ONLY_IMMICH_PERMISSIONS deliberately
// omits, so a real read-only key gets a 403 from /users/me (not a 401) —
// this function only special-cases 401, so a 403 would fall through to
// "error" and health.ts would persist that, which drops the connection from
// resolveConnectionsForCapability even though the key works fine for
// searches. /api/albums only needs `album.read`, which the key has.
// ---------------------------------------------------------------------------

async function checkHealth(
	secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	let config: ImmichConnectionConfig;
	try {
		config = immichConfig(conn);
	} catch (err) {
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	const fetchImpl = opts?.fetch ?? fetch;
	try {
		const response = await fetchWithTimeout(
			fetchImpl,
			`${config.origin}/api/albums`,
			{ headers: { "x-api-key": secret } },
		);
		if (response.status === 401) {
			return {
				status: "needs_reauth",
				detail: "Immich rejected the stored API key",
			};
		}
		if (!response.ok) {
			return {
				status: "error",
				detail: `Immich health check failed with status ${response.status}`,
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

// Not annotated as `: ConnectionAdapter` — same rationale as imapAdapter/
// appleAdapter: that annotation would narrow checkHealth's call signature to
// the interface's (secret, conn) shape and break the mocked-fetch tests that
// pass a third `{ fetch }` opts arg.
export const immichAdapter = {
	provider: "immich" as const,
	checkHealth,
};

registerConnectionAdapter(immichAdapter satisfies ConnectionAdapter);
