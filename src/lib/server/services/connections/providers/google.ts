// Google OAuth 2.0 (auth-code, offline access) connect flow for Calendar/
// Contacts (read-first — write scopes land in Phase 6). This module owns:
// signed, stateless CSRF state (no DB row); the connect/finish/refresh
// lifecycle; and the connection-health adapter. Every network call accepts
// an injectable `fetch` so the whole module is testable against mocked
// Google endpoints — nothing here ever talks to live Google in tests.
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

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

// Signed-state TTL — short-lived on purpose: the state only needs to survive
// the round trip through Google's consent screen, not persist like a session.
const STATE_TTL_SECONDS = 10 * 60;

export type GoogleOAuthErrorCode =
	| "not_configured"
	| "invalid_state"
	| "invalid_grant"
	| "token_exchange_failed"
	| "userinfo_failed"
	| "connection_not_found"
	| "needs_reauth";

export class GoogleOAuthError extends Error {
	constructor(
		message: string,
		public readonly code: GoogleOAuthErrorCode,
	) {
		super(message);
		this.name = "GoogleOAuthError";
	}
}

// Read-first scope map (1 capability -> 1 Google scope). Write scopes are
// added incrementally in Phase 6 rather than requested up front.
const CAPABILITY_SCOPES: Partial<Record<Capability, string>> = {
	calendar: "https://www.googleapis.com/auth/calendar.readonly",
	contacts: "https://www.googleapis.com/auth/contacts.readonly",
};

// Always requested regardless of capability — needed to resolve the
// account's email as the connection's accountIdentifier.
const BASE_SCOPES = [
	"openid",
	"https://www.googleapis.com/auth/userinfo.email",
];

function scopesForCapabilities(capabilities: Capability[]): string[] {
	const mapped = capabilities
		.map((capability) => CAPABILITY_SCOPES[capability])
		.filter((scope): scope is string => Boolean(scope));
	return [...new Set([...BASE_SCOPES, ...mapped])];
}

// Reverses CAPABILITY_SCOPES against the space-delimited `scope` string
// Google returns from the token endpoint, so the connection only ends up
// with capabilities it was actually granted (not merely requested).
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
	return `${origin}/api/oauth/google/callback`;
}

function requireGoogleCredentials(): {
	clientId: string;
	clientSecret: string;
} {
	const cfg = getConfig();
	const clientId = cfg.googleOauthClientId.trim();
	const clientSecret = cfg.googleOauthClientSecret.trim();
	if (!clientId || !clientSecret) {
		throw new GoogleOAuthError(
			"Google OAuth is not configured (missing GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET)",
			"not_configured",
		);
	}
	return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Stateless, signed CSRF state. Deliberately mirrors the HMAC
// payload.signature scheme verifyServiceAssertion uses in
// src/lib/server/auth/hooks.ts (same signing secret, same base64url +
// timingSafeEqual shape) rather than inventing a second convention — the
// state is never written to the DB, so verification must be self-contained.
// ---------------------------------------------------------------------------

export type OAuthStatePayload = {
	userId: string;
	capabilities: Capability[];
	nonce: string;
	exp: number; // epoch seconds
};

function requireSigningKey(): string {
	const key = envConfig.alfyaiApiSigningKey.trim();
	if (!key) {
		throw new GoogleOAuthError(
			"ALFYAI_API_SIGNING_KEY is not configured; cannot sign OAuth state",
			"not_configured",
		);
	}
	return key;
}

function isValidStatePayload(value: unknown): value is OAuthStatePayload {
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
	const payload: OAuthStatePayload = {
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

export function verifyOAuthState(state: string): OAuthStatePayload {
	const key = requireSigningKey();
	const [payloadPart, signaturePart, ...rest] = state.split(".");
	if (!payloadPart || !signaturePart || rest.length > 0) {
		throw new GoogleOAuthError("Malformed OAuth state", "invalid_state");
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
		throw new GoogleOAuthError(
			"Invalid OAuth state signature",
			"invalid_state",
		);
	}

	let json: string;
	try {
		json = Buffer.from(payloadPart, "base64url").toString("utf8");
	} catch {
		throw new GoogleOAuthError("Invalid OAuth state encoding", "invalid_state");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new GoogleOAuthError("Invalid OAuth state payload", "invalid_state");
	}

	if (!isValidStatePayload(parsed)) {
		throw new GoogleOAuthError(
			"OAuth state payload has an unexpected shape",
			"invalid_state",
		);
	}
	if (parsed.exp <= Math.floor(Date.now() / 1000)) {
		throw new GoogleOAuthError("OAuth state has expired", "invalid_state");
	}

	return parsed;
}

// ---------------------------------------------------------------------------
// connectStart
// ---------------------------------------------------------------------------

export async function googleConnectStart(params: {
	userId: string;
	origin: string;
	capabilities: Capability[];
}): Promise<{ authUrl: string }> {
	const { clientId } = requireGoogleCredentials();
	const state = signOAuthState({
		userId: params.userId,
		capabilities: params.capabilities,
	});

	const url = new URL(GOOGLE_AUTH_URL);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUriFor(params.origin));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("include_granted_scopes", "true");
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

type GoogleTokenResponse = {
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

function isValidTokenResponse(value: unknown): value is GoogleTokenResponse {
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

function isValidUserinfo(value: unknown): value is { email: string } {
	if (!value || typeof value !== "object") return false;
	const email = (value as Record<string, unknown>).email;
	return typeof email === "string" && email.length > 0;
}

type StoredGoogleSecret = {
	refreshToken: string | null;
	accessToken: string;
};

function parseStoredSecret(raw: string): StoredGoogleSecret | null {
	try {
		const parsed = JSON.parse(raw) as Partial<StoredGoogleSecret>;
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

async function upsertGoogleConnection(params: {
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
		"google",
		params.email,
	);

	// Google only returns refresh_token on the first consent (or when
	// prompt=consent forces re-consent); if it's omitted here, keep whatever
	// refresh token is already stored rather than overwriting it with null.
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
	} satisfies StoredGoogleSecret);

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
			throw new Error("Failed to update existing Google connection");
		}
		return updated;
	}

	return createConnection({
		userId: params.userId,
		provider: "google",
		label: "Google",
		accountIdentifier: params.email,
		capabilities: params.capabilities,
		status: "connected",
		secret,
		config: {},
		oauthScopes: grantedScopes,
		tokenExpiresAt,
	});
}

export async function googleConnectFinish(
	params: {
		code: string;
		state: string;
		origin: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	const fetchImpl = params.fetch ?? fetch;
	const statePayload = verifyOAuthState(params.state);
	const { clientId, clientSecret } = requireGoogleCredentials();

	const tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
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
		throw new GoogleOAuthError("Google token exchange failed", code);
	}

	const userinfoResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
		headers: { Authorization: `Bearer ${tokenBody.access_token}` },
	});
	const userinfoBody: unknown = await userinfoResponse.json().catch(() => null);
	if (!userinfoResponse.ok || !isValidUserinfo(userinfoBody)) {
		throw new GoogleOAuthError(
			"Failed to fetch the Google account's email",
			"userinfo_failed",
		);
	}

	const connection = await upsertGoogleConnection({
		userId: statePayload.userId,
		email: userinfoBody.email,
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

type GoogleRefreshResponse = { access_token: string; expires_in: number };

function isValidRefreshResponse(
	value: unknown,
): value is GoogleRefreshResponse {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.access_token === "string" &&
		v.access_token.length > 0 &&
		typeof v.expires_in === "number" &&
		Number.isFinite(v.expires_in)
	);
}

export async function googleRefreshAccessToken(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<string> {
	const fetchImpl = opts?.fetch ?? fetch;

	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new GoogleOAuthError(
			"Google connection not found",
			"connection_not_found",
		);
	}

	const secretRaw = await getConnectionSecret(userId, connectionId);
	const secret = secretRaw ? parseStoredSecret(secretRaw) : null;
	if (!secret?.refreshToken) {
		await updateConnection(userId, connectionId, {
			status: "needs_reauth",
			statusDetail: "No refresh token stored for this Google connection",
		});
		throw new GoogleOAuthError(
			"No refresh token stored for this Google connection",
			"needs_reauth",
		);
	}

	const { clientId, clientSecret } = requireGoogleCredentials();

	const response = await fetchImpl(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: secret.refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
		}).toString(),
	});
	const body: unknown = await response.json().catch(() => null);

	if (!response.ok) {
		if (isErrorBody(body) && body.error === "invalid_grant") {
			// Message matches the thrown error below verbatim: checkHealth
			// surfaces err.message as the health detail and health.ts persists
			// it again, so keeping the two strings identical avoids the row's
			// statusDetail flapping between two different descriptions of the
			// same event.
			const detail = "Google rejected the stored refresh token";
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail: detail,
			});
			throw new GoogleOAuthError(detail, "invalid_grant");
		}
		throw new GoogleOAuthError(
			"Google token refresh request failed",
			"token_exchange_failed",
		);
	}
	if (!isValidRefreshResponse(body)) {
		throw new GoogleOAuthError(
			"Google token refresh returned a malformed response",
			"token_exchange_failed",
		);
	}

	const tokenExpiresAt = Math.floor(Date.now() / 1000) + body.expires_in;
	await setConnectionSecret(
		userId,
		connectionId,
		JSON.stringify({
			refreshToken: secret.refreshToken,
			accessToken: body.access_token,
		} satisfies StoredGoogleSecret),
		tokenExpiresAt,
	);

	return body.access_token;
}

// ---------------------------------------------------------------------------
// Adapter — a real token refresh is the cheapest call that fully exercises
// the stored credential, but it's still a network round trip that mutates
// the stored access token, so it's only worth doing when the current access
// token is actually missing or close to expiring. Otherwise the existing
// token is still good and the connection is reported healthy without
// touching the network. `_secret` is unused (the refresh path re-derives its
// own decrypted secret from conn.userId/conn.id) but kept in the signature
// to match ConnectionAdapter.
// ---------------------------------------------------------------------------

// How close to `tokenExpiresAt` a health check must be before it bothers
// refreshing — comfortably larger than any single health-check round trip,
// small enough that scheduled health checks (which run far more often than
// tokens expire) don't refresh on every call.
const HEALTH_CHECK_REFRESH_WINDOW_SECONDS = 60;

async function checkHealth(
	_secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	const now = Math.floor(Date.now() / 1000);
	const tokenIsFreshEnough =
		conn.tokenExpiresAt != null &&
		conn.tokenExpiresAt - now > HEALTH_CHECK_REFRESH_WINDOW_SECONDS;
	if (tokenIsFreshEnough) {
		return { status: "connected", detail: null };
	}

	try {
		await googleRefreshAccessToken(conn.userId, conn.id, {
			fetch: opts?.fetch,
		});
		return { status: "connected", detail: null };
	} catch (err) {
		if (err instanceof GoogleOAuthError) {
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

export const googleAdapter = {
	provider: "google" as const,
	checkHealth,
};

registerConnectionAdapter(googleAdapter satisfies ConnectionAdapter);
