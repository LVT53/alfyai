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
	updateConnection,
} from "../store";

type FetchOpt = { fetch?: typeof fetch };

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
// rest of this module expects to build `{origin}/api/...` calls.
function normalizeOrigin(serverUrl: string): string {
	const trimmed = serverUrl.trim();
	if (!trimmed) {
		throw new ImmichError("A server URL is required", "invalid_config");
	}
	if (!/^https?:\/\//i.test(trimmed)) {
		throw new ImmichError(
			"Server URL must start with http:// or https://",
			"invalid_config",
		);
	}
	let origin = stripTrailingSlashes(trimmed);
	if (/\/api$/i.test(origin)) {
		origin = stripTrailingSlashes(origin.slice(0, -4));
	}
	if (!origin) {
		throw new ImmichError("A server URL is required", "invalid_config");
	}
	return origin;
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
		response = await fetchImpl(`${origin}/api/auth/login`, {
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
		response = await fetchImpl(`${origin}/api/api-keys`, {
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
// Read
// ---------------------------------------------------------------------------

export type PhotoResult = {
	id: string;
	fileName: string;
	takenAt: string;
	type: "IMAGE" | "VIDEO";
	place?: string;
	people?: string[];
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

type ImmichPerson = { name?: string };

type ImmichAsset = {
	id: string;
	originalFileName: string;
	fileCreatedAt: string;
	type: "IMAGE" | "VIDEO";
	exifInfo?: ImmichAssetExif;
	people?: ImmichPerson[];
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

function peopleFromAsset(asset: ImmichAsset): string[] | undefined {
	const names = (asset.people ?? [])
		.map((person) => person.name)
		.filter((name): name is string => Boolean(name?.trim()));
	return names.length > 0 ? names : undefined;
}

function toPhotoResult(asset: ImmichAsset): PhotoResult {
	const place = placeFromExif(asset.exifInfo);
	const people = peopleFromAsset(asset);
	const description = asset.exifInfo?.description?.trim();
	return {
		id: asset.id,
		fileName: asset.originalFileName,
		takenAt: asset.exifInfo?.dateTimeOriginal ?? asset.fileCreatedAt,
		type: asset.type,
		...(place ? { place } : {}),
		...(people ? { people } : {}),
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
		response = await fetchImpl(`${origin}${path}`, {
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
			body: JSON.stringify({ query: params.query, size: limit }),
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
// Adapter — a cheap authorized call (GET /api/users/me) confirms the stored
// read-only key still works, without touching any photo data.
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
		const response = await fetchImpl(`${config.origin}/api/users/me`, {
			headers: { "x-api-key": secret },
		});
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
