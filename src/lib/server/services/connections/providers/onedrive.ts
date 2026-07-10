// OneDrive (Microsoft Graph) connector — Task 8 — a second provider under
// the existing "files" capability, alongside Nextcloud. READ-ONLY for v1:
// every exported read function only ever issues GET requests, and there is
// no write path here at all (see normal-chat-tools/files.ts's provider
// dispatch, which refuses every write action against a "onedrive"
// connection with a clean not-supported message before this module is ever
// touched).
//
// OAuth2 (auth-code + refresh) mirrors providers/google.ts's connect/finish/
// refresh lifecycle and stateless signed-state scheme byte-for-byte (own
// copy, not a shared import — every provider adapter in this directory is
// self-contained, see nextcloud-files.ts/github.ts). One difference from
// Google: Microsoft ROTATES refresh tokens on every use (a refresh response
// commonly carries a new refresh_token that must replace the stored one) —
// see onedriveRefreshAccessToken's doc comment below.
//
// Read methods (list/search/read/stat) mirror nextcloud-files.ts's shape
// (same NcFile-like item fields: name/path/isDir/size/mtime/contentType/
// etag) so normal-chat-tools/files.ts can dispatch between the two
// providers through one common `FileEntry` shape. Every network call
// accepts an injectable `fetch` so this whole module is testable against
// mocked Microsoft/Graph endpoints — nothing here ever talks to a live
// Microsoft server in tests.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "$lib/server/config-store";
import { config as envConfig } from "$lib/server/env";
import { registerConnectionAdapter } from "../adapters";
import type { Capability, ConnectionAdapter } from "../registry";
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

const MS_AUTH_URL =
	"https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN_URL =
	"https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_READ_BYTES = 25 * 1024 * 1024; // 25 MB — chat-context reads only, same cap as Nextcloud.
const MAX_LIST_ITEMS = 500; // Defensive cap while following `@odata.nextLink` pagination.

// Signed-state TTL — mirrors google.ts: short-lived on purpose, only needs
// to survive the round trip through Microsoft's consent screen.
const STATE_TTL_SECONDS = 10 * 60;

export type OneDriveErrorCode =
	| "not_configured"
	| "invalid_state"
	| "invalid_grant"
	| "token_exchange_failed"
	| "userinfo_failed"
	| "connection_not_found"
	| "needs_reauth"
	| "not_found"
	| "too_large"
	| "invalid_path"
	| "invalid_config"
	| "request_failed";

export class OneDriveError extends Error {
	constructor(
		message: string,
		public readonly code: OneDriveErrorCode,
	) {
		super(message);
		this.name = "OneDriveError";
	}
}

// Read-only v1 — Files.Read only (no Files.ReadWrite). User.Read resolves
// the account's email/UPN for the connection's accountIdentifier;
// offline_access is required for Microsoft to ever issue a refresh_token.
const CAPABILITY_SCOPES: Partial<Record<Capability, string>> = {
	files: "Files.Read",
};

const BASE_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"User.Read",
];

function scopesForCapabilities(capabilities: Capability[]): string[] {
	const mapped = capabilities
		.map((capability) => CAPABILITY_SCOPES[capability])
		.filter((scope): scope is string => Boolean(scope));
	return [...new Set([...BASE_SCOPES, ...mapped])];
}

function capabilitiesFromScope(scope: string): Capability[] {
	const granted = new Set(scope.split(/\s+/).filter(Boolean));
	const capabilities: Capability[] = [];
	for (const [capability, requiredScope] of Object.entries(
		CAPABILITY_SCOPES,
	) as [Capability, string][]) {
		if (granted.has(requiredScope)) capabilities.push(capability);
	}
	return capabilities;
}

function redirectUriFor(origin: string): string {
	return `${origin}/api/oauth/onedrive/callback`;
}

function requireOneDriveCredentials(): {
	clientId: string;
	clientSecret: string;
} {
	const cfg = getConfig();
	const clientId = cfg.onedriveClientId.trim();
	const clientSecret = cfg.onedriveClientSecret.trim();
	if (!clientId || !clientSecret) {
		throw new OneDriveError(
			"OneDrive is not configured on this server (missing ONEDRIVE_CLIENT_ID/ONEDRIVE_CLIENT_SECRET)",
			"not_configured",
		);
	}
	return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Stateless, signed CSRF state — same HMAC payload.signature scheme as
// google.ts's signOAuthState/verifyOAuthState (own copy; see module doc).
// ---------------------------------------------------------------------------

export type OneDriveOAuthStatePayload = {
	userId: string;
	capabilities: Capability[];
	nonce: string;
	exp: number; // epoch seconds
};

function requireSigningKey(): string {
	const key = envConfig.alfyaiApiSigningKey.trim();
	if (!key) {
		throw new OneDriveError(
			"ALFYAI_API_SIGNING_KEY is not configured; cannot sign OAuth state",
			"not_configured",
		);
	}
	return key;
}

function isValidStatePayload(
	value: unknown,
): value is OneDriveOAuthStatePayload {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.userId === "string" &&
		candidate.userId.length > 0 &&
		Array.isArray(candidate.capabilities) &&
		candidate.capabilities.every((c) => typeof c === "string") &&
		typeof candidate.nonce === "string" &&
		candidate.nonce.length > 0 &&
		typeof candidate.exp === "number" &&
		Number.isFinite(candidate.exp)
	);
}

export function signOAuthState(params: {
	userId: string;
	capabilities: Capability[];
}): string {
	const key = requireSigningKey();
	const payload: OneDriveOAuthStatePayload = {
		userId: params.userId,
		capabilities: params.capabilities,
		nonce: randomBytes(16).toString("hex"),
		exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
	};
	const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString(
		"base64url",
	);
	const signature = createHmac("sha256", key)
		.update(payloadPart)
		.digest("base64url");
	return `${payloadPart}.${signature}`;
}

export function verifyOAuthState(state: string): OneDriveOAuthStatePayload {
	const key = requireSigningKey();
	const [payloadPart, signaturePart, ...rest] = state.split(".");
	if (!payloadPart || !signaturePart || rest.length > 0) {
		throw new OneDriveError("Malformed OAuth state", "invalid_state");
	}

	const expectedSignature = createHmac("sha256", key)
		.update(payloadPart)
		.digest("base64url");
	const expectedBuffer = Buffer.from(expectedSignature);
	const providedBuffer = Buffer.from(signaturePart);
	if (
		expectedBuffer.length !== providedBuffer.length ||
		!timingSafeEqual(expectedBuffer, providedBuffer)
	) {
		throw new OneDriveError("Invalid OAuth state signature", "invalid_state");
	}

	let json: string;
	try {
		json = Buffer.from(payloadPart, "base64url").toString("utf8");
	} catch {
		throw new OneDriveError("Invalid OAuth state encoding", "invalid_state");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new OneDriveError("Invalid OAuth state payload", "invalid_state");
	}

	if (!isValidStatePayload(parsed)) {
		throw new OneDriveError(
			"OAuth state payload has an unexpected shape",
			"invalid_state",
		);
	}
	if (parsed.exp <= Math.floor(Date.now() / 1000)) {
		throw new OneDriveError("OAuth state has expired", "invalid_state");
	}

	return parsed;
}

// ---------------------------------------------------------------------------
// connectStart
// ---------------------------------------------------------------------------

export async function onedriveConnectStart(params: {
	userId: string;
	origin: string;
	capabilities: Capability[];
}): Promise<{ authUrl: string }> {
	const { clientId } = requireOneDriveCredentials();
	const state = signOAuthState({
		userId: params.userId,
		capabilities: params.capabilities,
	});

	const url = new URL(MS_AUTH_URL);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUriFor(params.origin));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("response_mode", "query");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set(
		"scope",
		scopesForCapabilities(params.capabilities).join(" "),
	);
	url.searchParams.set("state", state);

	return { authUrl: url.toString() };
}

// ---------------------------------------------------------------------------
// connectFinish
// ---------------------------------------------------------------------------

type OneDriveTokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	scope: string;
	token_type: string;
	id_token?: string;
};

function isErrorBody(
	value: unknown,
): value is { error: string; error_description?: string } {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as Record<string, unknown>).error === "string"
	);
}

function isValidTokenResponse(value: unknown): value is OneDriveTokenResponse {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.access_token === "string" &&
		v.access_token.length > 0 &&
		typeof v.expires_in === "number" &&
		Number.isFinite(v.expires_in) &&
		typeof v.scope === "string"
	);
}

function isValidUserinfo(
	value: unknown,
): value is { mail?: string; userPrincipalName?: string } {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	const mail = typeof v.mail === "string" ? v.mail : "";
	const upn =
		typeof v.userPrincipalName === "string" ? v.userPrincipalName : "";
	return mail.length > 0 || upn.length > 0;
}

type StoredOneDriveSecret = {
	refreshToken: string | null;
	accessToken: string;
};

function parseStoredSecret(raw: string): StoredOneDriveSecret | null {
	try {
		const parsed = JSON.parse(raw) as Partial<StoredOneDriveSecret>;
		if (typeof parsed.accessToken !== "string") return null;
		return {
			refreshToken:
				typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
			accessToken: parsed.accessToken,
		};
	} catch {
		return null;
	}
}

async function upsertOneDriveConnection(params: {
	userId: string;
	email: string;
	capabilities: Capability[];
	refreshToken?: string;
	accessToken: string;
	scope: string;
	expiresIn: number;
}): Promise<ConnectionPublic> {
	const tokenExpiresAt = Math.floor(Date.now() / 1000) + params.expiresIn;
	const grantedScopes = params.scope.split(/\s+/).filter(Boolean);
	const existing = await findConnectionByAccount(
		params.userId,
		"onedrive",
		params.email,
	);

	// Microsoft only reliably returns refresh_token on first consent (or a
	// forced re-consent); if it's omitted here, keep whatever refresh token
	// is already stored rather than overwriting it with null — same posture
	// as google.ts's upsertGoogleConnection.
	let refreshToken = params.refreshToken ?? null;
	if (!refreshToken && existing) {
		const existingSecretRaw = await getConnectionSecret(
			params.userId,
			existing.id,
		);
		if (existingSecretRaw) {
			refreshToken = parseStoredSecret(existingSecretRaw)?.refreshToken ?? null;
		}
	}

	const secret = JSON.stringify({
		refreshToken,
		accessToken: params.accessToken,
	} satisfies StoredOneDriveSecret);

	if (existing) {
		const mergedCapabilities = [
			...new Set([...existing.capabilities, ...params.capabilities]),
		];
		const mergedScopes = [
			...new Set([...existing.oauthScopes, ...grantedScopes]),
		];
		await setConnectionSecret(
			params.userId,
			existing.id,
			secret,
			tokenExpiresAt,
		);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			capabilities: mergedCapabilities,
			oauthScopes: mergedScopes,
			tokenExpiresAt,
		});
		if (!updated) {
			throw new Error("Failed to update existing OneDrive connection");
		}
		return updated;
	}

	return createConnection({
		userId: params.userId,
		provider: "onedrive",
		label: "OneDrive",
		accountIdentifier: params.email,
		capabilities: params.capabilities,
		status: "connected",
		secret,
		config: {},
		oauthScopes: grantedScopes,
		tokenExpiresAt,
	});
}

export async function onedriveConnectFinish(
	params: {
		code: string;
		state: string;
		origin: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	const fetchImpl = params.fetch ?? fetch;
	const statePayload = verifyOAuthState(params.state);
	const { clientId, clientSecret } = requireOneDriveCredentials();

	const tokenResponse = await fetchImpl(MS_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: params.code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUriFor(params.origin),
		}).toString(),
	});
	const tokenBody: unknown = await tokenResponse.json().catch(() => null);

	if (!tokenResponse.ok || !isValidTokenResponse(tokenBody)) {
		const code =
			isErrorBody(tokenBody) && tokenBody.error === "invalid_grant"
				? "invalid_grant"
				: "token_exchange_failed";
		throw new OneDriveError("OneDrive token exchange failed", code);
	}

	const userinfoResponse = await fetchImpl(
		`${GRAPH_BASE}/me?$select=mail,userPrincipalName`,
		{ headers: { Authorization: `Bearer ${tokenBody.access_token}` } },
	);
	const userinfoBody: unknown = await userinfoResponse.json().catch(() => null);
	if (!userinfoResponse.ok || !isValidUserinfo(userinfoBody)) {
		throw new OneDriveError(
			"Failed to fetch the Microsoft account's email",
			"userinfo_failed",
		);
	}
	const email = userinfoBody.mail || userinfoBody.userPrincipalName || "";

	const connection = await upsertOneDriveConnection({
		userId: statePayload.userId,
		email,
		capabilities: capabilitiesFromScope(tokenBody.scope),
		refreshToken: tokenBody.refresh_token,
		accessToken: tokenBody.access_token,
		scope: tokenBody.scope,
		expiresIn: tokenBody.expires_in,
	});

	return { connection };
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

type OneDriveRefreshResponse = {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
};

function isValidRefreshResponse(
	value: unknown,
): value is OneDriveRefreshResponse {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.access_token === "string" &&
		v.access_token.length > 0 &&
		typeof v.expires_in === "number" &&
		Number.isFinite(v.expires_in)
	);
}

// Obtains a fresh access token, refreshing unconditionally (mirrors
// providers/google-calendar.ts's getAccessToken — always refresh rather than
// caching, since a refresh is a cheap request and this guarantees freshness
// without local clock-skew concerns). Microsoft ROTATES refresh tokens: a
// refresh response commonly carries a NEW refresh_token that must replace
// the stored one, unlike Google, which reuses the same refresh_token
// indefinitely — the persisted secret below always prefers a returned
// refresh_token, falling back to the existing one only when Microsoft omits
// it.
export async function onedriveRefreshAccessToken(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<string> {
	const fetchImpl = opts?.fetch ?? fetch;

	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new OneDriveError(
			"OneDrive connection not found",
			"connection_not_found",
		);
	}

	const secretRaw = await getConnectionSecret(userId, connectionId);
	const secret = secretRaw ? parseStoredSecret(secretRaw) : null;
	if (!secret?.refreshToken) {
		await updateConnection(userId, connectionId, {
			status: "needs_reauth",
			statusDetail: "No refresh token stored for this OneDrive connection",
		});
		throw new OneDriveError(
			"No refresh token stored for this OneDrive connection",
			"needs_reauth",
		);
	}

	const { clientId, clientSecret } = requireOneDriveCredentials();

	const response = await fetchImpl(MS_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: secret.refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
			scope: scopesForCapabilities(["files"]).join(" "),
		}).toString(),
	});
	const body: unknown = await response.json().catch(() => null);

	if (!response.ok) {
		if (
			isErrorBody(body) &&
			(body.error === "invalid_grant" || body.error === "interaction_required")
		) {
			// Message matches the thrown error below verbatim — see
			// google.ts's identical comment on why this matters for
			// checkHealth's persisted statusDetail.
			const detail = "Microsoft rejected the stored refresh token";
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail: detail,
			});
			throw new OneDriveError(detail, "invalid_grant");
		}
		throw new OneDriveError(
			"OneDrive token refresh request failed",
			"token_exchange_failed",
		);
	}
	if (!isValidRefreshResponse(body)) {
		throw new OneDriveError(
			"OneDrive token refresh returned a malformed response",
			"token_exchange_failed",
		);
	}

	const tokenExpiresAt = Math.floor(Date.now() / 1000) + body.expires_in;
	await setConnectionSecret(
		userId,
		connectionId,
		JSON.stringify({
			refreshToken: body.refresh_token ?? secret.refreshToken,
			accessToken: body.access_token,
		} satisfies StoredOneDriveSecret),
		tokenExpiresAt,
	);

	return body.access_token;
}

// ---------------------------------------------------------------------------
// Adapter — checkHealth (requiresSecret: true). Refreshes the access token
// only when it's missing/near expiry (mirrors google.ts), then makes a
// cheap `GET /me/drive` call to confirm the token actually works against
// Microsoft Graph right now — a successful refresh alone doesn't guarantee
// the resulting token has Files.Read still granted.
// ---------------------------------------------------------------------------

const HEALTH_CHECK_REFRESH_WINDOW_SECONDS = 60;

async function checkHealth(
	secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	const now = Math.floor(Date.now() / 1000);
	const tokenIsFreshEnough =
		conn.tokenExpiresAt != null &&
		conn.tokenExpiresAt - now > HEALTH_CHECK_REFRESH_WINDOW_SECONDS;

	let accessToken: string;
	if (tokenIsFreshEnough) {
		const stored = parseStoredSecret(secret);
		if (!stored) {
			return {
				status: "error",
				detail: "Connection is missing a stored access token",
			};
		}
		accessToken = stored.accessToken;
	} else {
		try {
			accessToken = await onedriveRefreshAccessToken(conn.userId, conn.id, {
				fetch: opts?.fetch,
			});
		} catch (err) {
			if (err instanceof OneDriveError) {
				if (err.code === "invalid_grant" || err.code === "needs_reauth") {
					return { status: "needs_reauth", detail: err.message };
				}
			}
			return {
				status: "error",
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	try {
		const response = await fetchImpl(`${GRAPH_BASE}/me/drive`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (response.status === 200) {
			return { status: "connected", detail: null };
		}
		if (response.status === 401) {
			return {
				status: "needs_reauth",
				detail: "Microsoft rejected the stored access token",
			};
		}
		return {
			status: "error",
			detail: `Microsoft Graph returned an unexpected status (${response.status})`,
		};
	} catch (err) {
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

export const onedriveAdapter = {
	provider: "onedrive" as const,
	requiresSecret: true,
	checkHealth,
};

registerConnectionAdapter(onedriveAdapter satisfies ConnectionAdapter);

// ---------------------------------------------------------------------------
// READ methods — list / search / read / stat over Microsoft Graph
// (`/me/drive`). Shape mirrors nextcloud-files.ts's NcFile so
// normal-chat-tools/files.ts can dispatch between the two providers through
// one common item shape. `webUrl` (Graph's own "open in the OneDrive web
// UI" link) rides along on each item — files.ts uses it directly for
// citations instead of trying to construct a deep link itself (unlike
// Nextcloud, which has no such field in its WebDAV PROPFIND response).
// ---------------------------------------------------------------------------

export type OneDriveItem = {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	mtime: string | null;
	contentType: string | null;
	etag: string | null;
	webUrl: string | null;
};

// Normalizes a caller-supplied relative path against the user's OneDrive
// root and rejects any attempt to escape it with `..` — same contract as
// nextcloud-files.ts's normalizeNextcloudPath (own copy; every path is
// routed through here before it is ever interpolated into a Graph URL).
export function normalizeOneDrivePath(path: string): string {
	const stack: string[] = [];
	for (const raw of path.split("/")) {
		const segment = raw.trim();
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (stack.length === 0) {
				throw new OneDriveError(
					"Path escapes the OneDrive root",
					"invalid_path",
				);
			}
			stack.pop();
			continue;
		}
		stack.push(segment);
	}
	return stack.join("/");
}

function encodePathSegments(normalizedPath: string): string {
	return normalizedPath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

// Bounds every Graph call to ~15s via AbortController — mirrors the same
// pattern in nextcloud-files.ts/github.ts.
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
			throw new OneDriveError(
				`Microsoft Graph request timed out after ${timeoutMs}ms`,
				"request_failed",
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function assertNotAuthFailure(response: Response): void {
	if (response.status === 401) {
		throw new OneDriveError(
			"Microsoft rejected the stored access token",
			"needs_reauth",
		);
	}
}

// Obtains a fresh access token for a read call — always refreshes (see
// onedriveRefreshAccessToken's doc comment on why this is unconditional,
// not expiry-gated like checkHealth).
async function getAccessTokenForRead(
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<string> {
	return onedriveRefreshAccessToken(conn.userId, conn.id, {
		fetch: opts?.fetch,
	});
}

type GraphDriveItem = {
	id?: string;
	name?: string;
	size?: number;
	eTag?: string;
	webUrl?: string;
	lastModifiedDateTime?: string;
	file?: { mimeType?: string };
	folder?: { childCount?: number };
	parentReference?: { path?: string };
	"@microsoft.graph.downloadUrl"?: string;
};

// Recovers the path relative to the OneDrive root from a driveItem's
// `parentReference.path` (e.g. "/drive/root:/Documents" or
// "/drives/{id}/root:/Documents") + its own `name`. Used by search, whose
// results can come from anywhere in the tree; list/stat instead derive the
// path directly from the request's own normalized path (simpler and
// independent of Graph's parentReference format — see onedriveListFolder).
function itemRelativePath(item: GraphDriveItem): string {
	const parentPath = item.parentReference?.path ?? "";
	const marker = "/root:";
	const idx = parentPath.indexOf(marker);
	let rel = "";
	if (idx !== -1) {
		const after = parentPath.slice(idx + marker.length);
		try {
			rel = decodeURIComponent(after).replace(/^\/+/, "");
		} catch {
			rel = after.replace(/^\/+/, "");
		}
	}
	const name = item.name ?? "";
	return rel ? `${rel}/${name}` : name;
}

function mapItem(item: GraphDriveItem, path: string): OneDriveItem {
	return {
		name: item.name ?? "",
		path,
		isDir: !!item.folder,
		size: typeof item.size === "number" ? item.size : 0,
		mtime: item.lastModifiedDateTime ?? null,
		contentType: item.file?.mimeType ?? null,
		etag: item.eTag ?? null,
		webUrl: item.webUrl ?? null,
	};
}

// Fetches a single item's metadata by path (Depth-0 equivalent). Returns
// null on 404 — "does this exist" is an expected outcome, not an error,
// same posture as nextcloud-files.ts's nextcloudStat.
async function getItemMetadata(
	accessToken: string,
	normalizedPath: string,
	opts?: FetchOpt,
): Promise<GraphDriveItem | null> {
	const fetchImpl = opts?.fetch ?? fetch;
	const url = normalizedPath
		? `${GRAPH_BASE}/me/drive/root:/${encodePathSegments(normalizedPath)}`
		: `${GRAPH_BASE}/me/drive/root`;

	const response = await fetchWithTimeout(fetchImpl, url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	assertNotAuthFailure(response);
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new OneDriveError(
			`Microsoft Graph request failed with status ${response.status}`,
			"request_failed",
		);
	}
	return (await response.json()) as GraphDriveItem;
}

// Follows `@odata.nextLink` pagination up to MAX_LIST_ITEMS. Returns null
// when the very first page 404s (folder doesn't exist); a subsequent page
// failing mid-walk is a hard error (`request_failed`) rather than a silent
// partial result.
async function collectChildren(
	url: string,
	accessToken: string,
	opts?: FetchOpt,
): Promise<GraphDriveItem[] | null> {
	const fetchImpl = opts?.fetch ?? fetch;
	let next: string | null = url;
	let first = true;
	const items: GraphDriveItem[] = [];

	while (next && items.length < MAX_LIST_ITEMS) {
		const response = await fetchWithTimeout(fetchImpl, next, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		assertNotAuthFailure(response);
		if (first && response.status === 404) return null;
		if (!response.ok) {
			throw new OneDriveError(
				`Microsoft Graph request failed with status ${response.status}`,
				"request_failed",
			);
		}
		first = false;
		const body = (await response.json()) as {
			value?: GraphDriveItem[];
			"@odata.nextLink"?: string;
		};
		items.push(...(body.value ?? []));
		next = body["@odata.nextLink"] ?? null;
	}
	return items;
}

// Lists the immediate children of `path` (empty path = OneDrive root).
// `_secret` is unused — OAuth reads always mint a fresh access token via
// getAccessTokenForRead (conn.userId/conn.id), never the caller-decrypted
// secret string — kept in the signature only so files.ts's provider
// dispatch can call this with the exact same (conn, secret, path) shape as
// nextcloudListFolder (mirrors google.ts checkHealth's `_secret` param for
// the same reason).
export async function onedriveListFolder(
	conn: ConnectionPublic,
	_secret: string,
	path: string,
	opts?: FetchOpt,
): Promise<OneDriveItem[]> {
	const accessToken = await getAccessTokenForRead(conn, opts);
	const normalizedPath = normalizeOneDrivePath(path);
	const url = normalizedPath
		? `${GRAPH_BASE}/me/drive/root:/${encodePathSegments(normalizedPath)}:/children`
		: `${GRAPH_BASE}/me/drive/root/children`;

	const items = await collectChildren(url, accessToken, opts);
	if (items === null) {
		throw new OneDriveError(
			`Folder not found: ${normalizedPath || "/"}`,
			"not_found",
		);
	}

	return items.map((item) =>
		mapItem(
			item,
			normalizedPath
				? `${normalizedPath}/${item.name ?? ""}`
				: (item.name ?? ""),
		),
	);
}

// Stats a single path. Returns null when the path doesn't exist. `_secret`
// is unused (see onedriveListFolder's doc comment above).
export async function onedriveStat(
	conn: ConnectionPublic,
	_secret: string,
	path: string,
	opts?: FetchOpt,
): Promise<OneDriveItem | null> {
	const accessToken = await getAccessTokenForRead(conn, opts);
	const normalizedPath = normalizeOneDrivePath(path);
	const item = await getItemMetadata(accessToken, normalizedPath, opts);
	if (!item) return null;
	return mapItem(item, normalizedPath);
}

// Server-side search, scoped to the user's drive (Microsoft Graph's own
// full-text/filename search — a single round trip, no client-side tree
// walk). Each result's path is derived from its own parentReference since
// matches can come from anywhere in the tree.
// `_secret` is unused (see onedriveListFolder's doc comment above).
export async function onedriveSearch(
	conn: ConnectionPublic,
	_secret: string,
	query: string,
	opts?: FetchOpt,
): Promise<OneDriveItem[]> {
	const accessToken = await getAccessTokenForRead(conn, opts);
	// OData string-literal escaping: a single quote inside the search text is
	// escaped by doubling it (`'` -> `''`) per OData syntax, then the whole
	// literal is percent-encoded as a URL path segment. encodeURIComponent
	// leaves `'` unescaped, so the doubled quotes survive intact inside the
	// `q='...'` wrapper built below.
	const escaped = encodeURIComponent(query.replace(/'/g, "''"));
	const url = `${GRAPH_BASE}/me/drive/root/search(q='${escaped}')`;

	const items = await collectChildren(url, accessToken, opts);
	return (items ?? []).map((item) => mapItem(item, itemRelativePath(item)));
}

// Reads a file's bytes: fetches metadata first (mirrors nextcloud-files.ts's
// doc-comment pattern of "stat then GET"), then downloads via the item's
// pre-authenticated `@microsoft.graph.downloadUrl` when present (no extra
// auth header needed — falls back to an authenticated GET on the `/content`
// endpoint otherwise). Refuses anything over MAX_READ_BYTES, checked against
// the metadata's reported size up front and again against the actual
// decoded size as a fallback.
// `_secret` is unused (see onedriveListFolder's doc comment above).
export async function onedriveReadFile(
	conn: ConnectionPublic,
	_secret: string,
	path: string,
	opts?: FetchOpt,
): Promise<{
	bytes: Uint8Array;
	etag: string | null;
	contentType: string | null;
	mtime: string | null;
	webUrl: string | null;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	const accessToken = await getAccessTokenForRead(conn, opts);
	const normalizedPath = normalizeOneDrivePath(path);
	if (!normalizedPath) {
		throw new OneDriveError(
			"Cannot read the OneDrive root as a file",
			"invalid_path",
		);
	}

	const item = await getItemMetadata(accessToken, normalizedPath, opts);
	if (!item) {
		throw new OneDriveError(`File not found: ${normalizedPath}`, "not_found");
	}
	if (item.folder) {
		throw new OneDriveError(
			`Cannot read a folder as a file: ${normalizedPath}`,
			"invalid_path",
		);
	}

	const maxMb = MAX_READ_BYTES / (1024 * 1024);
	if (typeof item.size === "number" && item.size > MAX_READ_BYTES) {
		throw new OneDriveError(
			`File exceeds the ${maxMb}MB read limit`,
			"too_large",
		);
	}

	const downloadUrl = item["@microsoft.graph.downloadUrl"];
	const contentResponse = downloadUrl
		? await fetchWithTimeout(fetchImpl, downloadUrl, {})
		: await fetchWithTimeout(
				fetchImpl,
				`${GRAPH_BASE}/me/drive/root:/${encodePathSegments(normalizedPath)}:/content`,
				{ headers: { Authorization: `Bearer ${accessToken}` } },
			);

	assertNotAuthFailure(contentResponse);
	if (!contentResponse.ok) {
		throw new OneDriveError(
			`Microsoft Graph download failed with status ${contentResponse.status}`,
			"request_failed",
		);
	}

	const buffer = await contentResponse.arrayBuffer();
	if (buffer.byteLength > MAX_READ_BYTES) {
		throw new OneDriveError(
			`File exceeds the ${maxMb}MB read limit`,
			"too_large",
		);
	}

	return {
		bytes: new Uint8Array(buffer),
		etag: item.eTag ?? null,
		contentType:
			item.file?.mimeType ?? contentResponse.headers.get("Content-Type"),
		mtime: item.lastModifiedDateTime ?? null,
		webUrl: item.webUrl ?? null,
	};
}

// Best-effort web URL for a citation. Every item Graph returns already
// carries its own `webUrl` (see OneDriveItem.webUrl); this is only a
// fallback for the rare case that field is absent.
export function onedriveWebUrl(item: { webUrl: string | null }): string {
	return item.webUrl ?? "https://onedrive.live.com/";
}
