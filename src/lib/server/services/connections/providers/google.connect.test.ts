import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function seedUser(userId: string) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

const ENV_KEYS = [
	"GOOGLE_OAUTH_CLIENT_ID",
	"GOOGLE_OAUTH_CLIENT_SECRET",
	"ALFYAI_API_SIGNING_KEY",
];

function setConfiguredEnv() {
	process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
	process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
	process.env.ALFYAI_API_SIGNING_KEY = "test-signing-key";
}

function setSigningKeyOnly() {
	process.env.ALFYAI_API_SIGNING_KEY = "test-signing-key";
}

beforeEach(() => {
	vi.resetModules();
	for (const key of ENV_KEYS) delete process.env[key];

	dbPath = `./data/test-connections-google-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
	for (const key of ENV_KEYS) delete process.env[key];
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

describe("googleConnectStart", () => {
	it("throws a typed not_configured error when client id/secret are unset", async () => {
		setSigningKeyOnly();
		const { googleConnectStart, GoogleOAuthError } = await import("./google");

		await expect(
			googleConnectStart({
				userId: "userA",
				origin: "https://app.example.com",
				capabilities: ["calendar"],
			}),
		).rejects.toThrow();

		try {
			await googleConnectStart({
				userId: "userA",
				origin: "https://app.example.com",
				capabilities: ["calendar"],
			});
			throw new Error("expected googleConnectStart to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GoogleOAuthError);
			expect((err as InstanceType<typeof GoogleOAuthError>).code).toBe(
				"not_configured",
			);
		}
	});

	it("builds an authUrl with client_id, redirect_uri, access_type=offline, prompt=consent, mapped scopes and a state when configured", async () => {
		setConfiguredEnv();
		const { googleConnectStart } = await import("./google");

		const { authUrl } = await googleConnectStart({
			userId: "userA",
			origin: "https://app.example.com",
			capabilities: ["calendar", "contacts"],
		});

		const url = new URL(authUrl);
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(url.searchParams.get("client_id")).toBe("test-client-id");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://app.example.com/api/oauth/google/callback",
		);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("include_granted_scopes")).toBe("true");

		const scope = url.searchParams.get("scope") ?? "";
		expect(scope).toContain(
			"https://www.googleapis.com/auth/calendar.readonly",
		);
		expect(scope).toContain(
			"https://www.googleapis.com/auth/contacts.readonly",
		);
		expect(scope).toContain("https://www.googleapis.com/auth/userinfo.email");
		expect(scope).toContain("openid");

		expect(url.searchParams.get("state")).toBeTruthy();
	});
});

describe("signOAuthState / verifyOAuthState", () => {
	it("verifies a freshly signed state and returns its payload", async () => {
		setSigningKeyOnly();
		const { signOAuthState, verifyOAuthState } = await import("./google");

		const state = signOAuthState({
			userId: "userA",
			capabilities: ["calendar"],
		});
		const payload = verifyOAuthState(state);

		expect(payload.userId).toBe("userA");
		expect(payload.capabilities).toEqual(["calendar"]);
		expect(typeof payload.nonce).toBe("string");
		expect(payload.nonce.length).toBeGreaterThan(0);
	});

	it("throws on a tampered state", async () => {
		setSigningKeyOnly();
		const { signOAuthState, verifyOAuthState } = await import("./google");

		const state = signOAuthState({
			userId: "userA",
			capabilities: ["calendar"],
		});
		const [payloadPart, signaturePart] = state.split(".");
		const tampered = `${payloadPart}tampered.${signaturePart}`;

		expect(() => verifyOAuthState(tampered)).toThrow();
	});

	it("throws on an expired state", async () => {
		setSigningKeyOnly();
		vi.useFakeTimers();
		try {
			const { signOAuthState, verifyOAuthState } = await import("./google");
			const state = signOAuthState({
				userId: "userA",
				capabilities: ["calendar"],
			});
			vi.advanceTimersByTime(11 * 60 * 1000);
			expect(() => verifyOAuthState(state)).toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("googleConnectFinish", () => {
	it("creates a google connection from mocked token+userinfo responses; DTO is secret-free and the stored secret decrypts to the refresh+access tokens", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { signOAuthState, googleConnectFinish } = await import("./google");
		const { getConnectionSecret } = await import("../store");

		const state = signOAuthState({
			userId: "userA",
			capabilities: ["calendar"],
		});

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === TOKEN_URL) {
					expect(init?.method).toBe("POST");
					const body = new URLSearchParams(String(init?.body));
					expect(body.get("grant_type")).toBe("authorization_code");
					expect(body.get("code")).toBe("auth-code-123");
					expect(body.get("client_id")).toBe("test-client-id");
					expect(body.get("client_secret")).toBe("test-client-secret");
					expect(body.get("redirect_uri")).toBe(
						"https://app.example.com/api/oauth/google/callback",
					);
					return jsonResponse(200, {
						access_token: "access-abc",
						refresh_token: "refresh-xyz",
						expires_in: 3600,
						scope:
							"openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly",
						token_type: "Bearer",
					});
				}
				if (url === USERINFO_URL) {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe("Bearer access-abc");
					return jsonResponse(200, { email: "alice@example.com" });
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const { connection } = await googleConnectFinish({
			code: "auth-code-123",
			state,
			origin: "https://app.example.com",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.provider).toBe("google");
		expect(connection.accountIdentifier).toBe("alice@example.com");
		expect(connection.capabilities).toEqual(["calendar"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);

		const serialized = JSON.stringify(connection);
		expect(serialized).not.toContain("refresh-xyz");
		expect(serialized).not.toContain("access-abc");

		const decrypted = await getConnectionSecret("userA", connection.id);
		expect(decrypted).not.toBeNull();
		const parsedSecret = JSON.parse(decrypted as string);
		expect(parsedSecret.refreshToken).toBe("refresh-xyz");
		expect(parsedSecret.accessToken).toBe("access-abc");
	});

	// The user-binding guard itself (rejecting a state signed for a different
	// user than the session presenting it) lives in the callback route, not in
	// googleConnectFinish — it is exercised end to end, against the real route
	// handler, in
	// src/routes/api/oauth/google/callback/callback.test.ts.
});

describe("googleConnectFinish re-connect", () => {
	it("updates (not duplicates) the existing connection for the same email and preserves the stored refresh token when Google omits a new one", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { signOAuthState, googleConnectFinish } = await import("./google");
		const { listConnectionsForUser, getConnectionSecret } = await import(
			"../store"
		);

		const firstFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "access-1",
					refresh_token: "refresh-1",
					expires_in: 3600,
					scope:
						"openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly",
					token_type: "Bearer",
				});
			}
			return jsonResponse(200, { email: "alice@example.com" });
		});
		const first = await googleConnectFinish({
			code: "code-1",
			state: signOAuthState({ userId: "userA", capabilities: ["calendar"] }),
			origin: "https://app.example.com",
			fetch: firstFetch as unknown as typeof fetch,
		});

		const secondFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "access-2",
					// no refresh_token this time (already consented)
					expires_in: 3600,
					scope:
						"openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/contacts.readonly",
					token_type: "Bearer",
				});
			}
			return jsonResponse(200, { email: "alice@example.com" });
		});
		const second = await googleConnectFinish({
			code: "code-2",
			state: signOAuthState({ userId: "userA", capabilities: ["contacts"] }),
			origin: "https://app.example.com",
			fetch: secondFetch as unknown as typeof fetch,
		});

		expect(second.connection.id).toBe(first.connection.id);
		expect([...second.connection.capabilities].sort()).toEqual([
			"calendar",
			"contacts",
		]);

		const rows = await listConnectionsForUser("userA");
		expect(rows).toHaveLength(1);

		const decrypted = await getConnectionSecret("userA", second.connection.id);
		const parsedSecret = JSON.parse(decrypted as string);
		expect(parsedSecret.refreshToken).toBe("refresh-1");
		expect(parsedSecret.accessToken).toBe("access-2");
	});
});

describe("googleRefreshAccessToken", () => {
	async function seedConnection() {
		seedUser("userA");
		const { createConnection } = await import("../store");
		return createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			accountIdentifier: "alice@example.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: JSON.stringify({
				refreshToken: "refresh-xyz",
				accessToken: "old-access",
			}),
			config: {},
			oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
			tokenExpiresAt: Math.floor(Date.now() / 1000) - 10,
		});
	}

	it("stores a fresh access token and updates tokenExpiresAt on success", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { googleRefreshAccessToken } = await import("./google");
		const { getConnection, getConnectionSecret } = await import("../store");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(TOKEN_URL);
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("grant_type")).toBe("refresh_token");
				expect(body.get("refresh_token")).toBe("refresh-xyz");
				return jsonResponse(200, {
					access_token: "new-access",
					expires_in: 3600,
					token_type: "Bearer",
				});
			},
		);

		const beforeCall = Math.floor(Date.now() / 1000);
		const token = await googleRefreshAccessToken("userA", conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(token).toBe("new-access");

		const updated = await getConnection("userA", conn.id);
		expect(updated?.tokenExpiresAt).toBeGreaterThanOrEqual(beforeCall + 3600);

		const decrypted = await getConnectionSecret("userA", conn.id);
		const parsedSecret = JSON.parse(decrypted as string);
		expect(parsedSecret.accessToken).toBe("new-access");
		expect(parsedSecret.refreshToken).toBe("refresh-xyz");
	});

	it("marks the connection needs_reauth and throws a typed error on invalid_grant", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { googleRefreshAccessToken, GoogleOAuthError } = await import(
			"./google"
		);
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () =>
			jsonResponse(400, { error: "invalid_grant" }),
		);

		try {
			await googleRefreshAccessToken("userA", conn.id, {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected googleRefreshAccessToken to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GoogleOAuthError);
			expect((err as InstanceType<typeof GoogleOAuthError>).code).toBe(
				"invalid_grant",
			);
		}

		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});

	it("persists needs_reauth on the connection row when no refresh token is stored, before throwing", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { createConnection } = await import("../store");
		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			accountIdentifier: "alice@example.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: JSON.stringify({
				refreshToken: null,
				accessToken: "old-access",
			}),
			config: {},
			oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
			tokenExpiresAt: Math.floor(Date.now() / 1000) - 10,
		});

		const { googleRefreshAccessToken, GoogleOAuthError } = await import(
			"./google"
		);
		const { getConnection } = await import("../store");
		const fetchMock = vi.fn();

		try {
			await googleRefreshAccessToken("userA", conn.id, {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected googleRefreshAccessToken to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GoogleOAuthError);
			expect((err as InstanceType<typeof GoogleOAuthError>).code).toBe(
				"needs_reauth",
			);
		}

		// No refresh token means no network call should even be attempted.
		expect(fetchMock).not.toHaveBeenCalled();

		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

describe("googleAdapter.checkHealth", () => {
	it("connected when a refresh succeeds", async () => {
		seedUser("userA");
		setConfiguredEnv();
		const { createConnection } = await import("../store");
		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			accountIdentifier: "alice@example.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: JSON.stringify({
				refreshToken: "refresh-xyz",
				accessToken: "old-access",
			}),
			config: {},
			oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
			tokenExpiresAt: Math.floor(Date.now() / 1000) - 10,
		});

		const { googleAdapter } = await import("./google");
		const fetchMock = vi.fn(async () =>
			jsonResponse(200, { access_token: "new-access", expires_in: 3600 }),
		);

		const health = await googleAdapter.checkHealth("refresh-xyz", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("connected");
	});

	it("needs_reauth when the refresh returns invalid_grant, with no secret in the detail", async () => {
		seedUser("userA");
		setConfiguredEnv();
		const { createConnection } = await import("../store");
		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			accountIdentifier: "alice@example.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: JSON.stringify({
				refreshToken: "refresh-xyz",
				accessToken: "old-access",
			}),
			config: {},
			oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
			tokenExpiresAt: Math.floor(Date.now() / 1000) - 10,
		});

		const { googleAdapter } = await import("./google");
		const fetchMock = vi.fn(async () =>
			jsonResponse(400, { error: "invalid_grant" }),
		);

		const health = await googleAdapter.checkHealth("refresh-xyz", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("needs_reauth");
		expect(health.detail).not.toContain("refresh-xyz");
	});

	it("skips the network refresh entirely when the access token is nowhere near expiry", async () => {
		seedUser("userA");
		setConfiguredEnv();
		const { createConnection } = await import("../store");
		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			accountIdentifier: "alice@example.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: JSON.stringify({
				refreshToken: "refresh-xyz",
				accessToken: "still-good",
			}),
			config: {},
			oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
			// Far from expiry — well outside the health-check refresh window.
			tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
		});

		const { googleAdapter } = await import("./google");
		const fetchMock = vi.fn();

		const health = await googleAdapter.checkHealth("refresh-xyz", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(health.status).toBe("connected");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
