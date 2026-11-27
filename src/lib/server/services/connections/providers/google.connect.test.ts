import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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
	"DRIVE_TEST_USER_IDS",
	"GMAIL_TEST_USER_IDS",
	"GOOGLE_OAUTH_CLIENT_ID",
	"GOOGLE_OAUTH_CLIENT_SECRET",
	"ALFYAI_API_SIGNING_KEY",
	"GOOGLE_CALENDAR_WRITE_REVIEW_USER_IDS",
	"GOOGLE_CALENDAR_EVENT_EDITING_ENABLED",
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

	dbPath = `${tmpdir()}/alfyai-test-connections-google-${randomUUID()}.db`;
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
		expect(scope.split(" ")).not.toContain(
			"https://www.googleapis.com/auth/calendar.events",
		);

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

describe("Google Calendar incremental write consent", () => {
	it("offers initial editing consent to an unlisted user only on opt-in during general rollout", async () => {
		setConfiguredEnv();
		process.env.GOOGLE_CALENDAR_WRITE_REVIEW_USER_IDS = "";
		process.env.GOOGLE_CALENDAR_EVENT_EDITING_ENABLED = "true";
		const { googleConnectStart, verifyOAuthState } = await import("./google");
		const request = {
			userId: "general-rollout-user",
			origin: "https://app.example.com",
			capabilities: ["calendar" as const],
		};
		const write = "https://www.googleapis.com/auth/calendar.events";
		const ordinary = new URL((await googleConnectStart(request)).authUrl);
		expect(ordinary.searchParams.get("scope")?.split(" ")).not.toContain(write);
		const optedIn = new URL(
			(await googleConnectStart({ ...request, requestCalendarEditing: true }))
				.authUrl,
		);
		expect(optedIn.searchParams.get("scope")?.split(" ")).toContain(write);
		const state = verifyOAuthState(optedIn.searchParams.get("state") ?? "");
		expect(state).toMatchObject({
			userId: request.userId,
			requestCalendarEditing: true,
		});
		expect(state.calendarWriteConnectionId).toBeUndefined();
	});
	it("can request calendar editing with first consent but enables only explicitly granted reads and keeps local writes off", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { googleConnectStart, googleConnectFinish, verifyOAuthState } =
			await import("./google");
		const read = "https://www.googleapis.com/auth/calendar.readonly",
			write = "https://www.googleapis.com/auth/calendar.events",
			contacts = "https://www.googleapis.com/auth/contacts.readonly";
		const request = {
			userId: "userA",
			origin: "https://app.example.com",
			capabilities: ["calendar", "contacts"] as ("calendar" | "contacts")[],
			requestCalendarEditing: true,
		};
		await expect(googleConnectStart(request)).rejects.toMatchObject({
			code: "write_review_unavailable",
		});
		process.env.GOOGLE_CALENDAR_WRITE_REVIEW_USER_IDS = "userA";
		await expect(
			googleConnectStart({ ...request, capabilities: ["contacts"] }),
		).rejects.toMatchObject({ code: "invalid_write_target" });
		const auth = new URL((await googleConnectStart(request)).authUrl);
		expect(auth.searchParams.get("scope")?.split(" ")).toEqual(
			expect.arrayContaining([read, write, contacts]),
		);
		const state = auth.searchParams.get("state") || "";
		expect(verifyOAuthState(state).requestCalendarEditing).toBe(true);
		const finish = async (email: string, scope: string) =>
			googleConnectFinish({
				code: "code",
				origin: request.origin,
				state,
				fetch: async (url) =>
					String(url) === TOKEN_URL
						? jsonResponse(200, {
								access_token: "token",
								refresh_token: "rt",
								expires_in: 3600,
								scope,
								token_type: "Bearer",
							})
						: jsonResponse(200, { email }),
			});
		const full = await finish(
			"accepted@example.com",
			[read, write, contacts].join(" "),
		);
		expect(full.connection.allowWrites).toBe(false);
		expect(full.connection.oauthScopes).toContain(write);
		const partial = await finish("partial@example.com", read);
		expect(partial.connection.allowWrites).toBe(false);
		expect(partial.connection.oauthScopes).not.toContain(write);
		expect(partial.connection.capabilities).toEqual(["calendar"]);
		const { updateConnection } = await import("../store");
		await updateConnection("userA", full.connection.id, {
			allowWrites: true,
			capabilities: ["calendar"],
		});
		const again = await finish(
			"accepted@example.com",
			[read, write, contacts].join(" "),
		);
		expect(again.connection.allowWrites).toBe(true);
		expect(again.connection.capabilities).toEqual(["calendar"]);
		await expect(finish("accepted@example.com", read)).rejects.toMatchObject({
			code: "write_grant_missing",
		});
		delete process.env.GOOGLE_CALENDAR_WRITE_REVIEW_USER_IDS;
		const disabled = await finish(
			"rollout-disabled@example.com",
			[read, write].join(" "),
		);
		expect(disabled.connection.oauthScopes).not.toContain(write);
	});
	it("binds opt-in to the enabled, owned calendar and preserves the account on denied or misdirected consent", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { googleConnectStart, googleConnectFinish, verifyOAuthState } =
			await import("./google");
		const {
			createConnection,
			getConnection,
			getConnectionSecret,
			listConnectionsForUser,
		} = await import("../store");
		const read = "https://www.googleapis.com/auth/calendar.readonly";
		const write = "https://www.googleapis.com/auth/calendar.events";
		const contacts = "https://www.googleapis.com/auth/contacts.readonly";
		const originalSecret = JSON.stringify({
			refreshToken: "retained",
			accessToken: "original",
		});
		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Work",
			accountIdentifier: "work@example.com",
			capabilities: ["calendar"],
			oauthScopes: [read, contacts],
			secret: originalSecret,
		});
		const request = {
			userId: "userA",
			origin: "https://app.example.com",
			capabilities: ["calendar" as const],
			calendarWriteConnectionId: conn.id,
		};
		await expect(googleConnectStart(request)).rejects.toMatchObject({
			code: "write_review_unavailable",
		});
		process.env.GOOGLE_CALENDAR_EVENT_EDITING_ENABLED = "true";
		expect(
			new URL((await googleConnectStart(request)).authUrl).searchParams
				.get("scope")
				?.split(" "),
		).toContain(write);
		expect(
			new URL(
				(
					await googleConnectStart({
						...request,
						calendarWriteConnectionId: undefined,
					})
				).authUrl,
			).searchParams
				.get("scope")
				?.split(" "),
		).not.toContain(write);
		delete process.env.GOOGLE_CALENDAR_EVENT_EDITING_ENABLED;
		process.env.GOOGLE_CALENDAR_WRITE_REVIEW_USER_IDS = " userA , userB ";
		await expect(
			googleConnectStart({ ...request, userId: "userB" }),
		).rejects.toMatchObject({ code: "invalid_write_target" });
		await expect(
			googleConnectStart({ ...request, capabilities: ["contacts"] }),
		).rejects.toMatchObject({ code: "invalid_write_target" });
		const { authUrl } = await googleConnectStart(request);
		const params = new URL(authUrl).searchParams;
		expect(params.get("login_hint")).toBe(conn.accountIdentifier);
		expect(params.get("scope")?.split(" ")).toContain(write);
		const state = params.get("state") ?? "";
		expect(verifyOAuthState(state).calendarWriteConnectionId).toBe(conn.id);
		const finish = (email: string, scope: string) =>
			googleConnectFinish({
				code: "test",
				state,
				origin: request.origin,
				fetch: async (input) =>
					String(input) === TOKEN_URL
						? jsonResponse(200, {
								access_token: "upgraded",
								expires_in: 3600,
								scope,
								token_type: "Bearer",
							})
						: jsonResponse(200, { email }),
			});
		const granted = [read, contacts, write].join(" ");
		await expect(finish("personal@example.com", granted)).rejects.toMatchObject(
			{ code: "wrong_account" },
		);
		await expect(finish(conn.accountIdentifier, read)).rejects.toMatchObject({
			code: "write_grant_missing",
		});
		await expect(
			finish(conn.accountIdentifier, [read, write].join(" ")),
		).rejects.toMatchObject({ code: "write_grant_missing" });
		expect(await listConnectionsForUser("userA")).toHaveLength(1);
		expect((await getConnection("userA", conn.id))?.allowWrites).toBe(false);
		expect(await getConnectionSecret("userA", conn.id)).toBe(originalSecret);
		process.env.GOOGLE_CALENDAR_WRITE_REVIEW_USER_IDS = "";
		await expect(finish(conn.accountIdentifier, granted)).rejects.toMatchObject(
			{ code: "write_review_unavailable" },
		);
		process.env.GOOGLE_CALENDAR_WRITE_REVIEW_USER_IDS = "userA";
		const { connection } = await finish(conn.accountIdentifier, granted);
		expect(connection).toMatchObject({
			id: conn.id,
			label: "Work",
			allowWrites: true,
			capabilities: ["calendar"],
		});
		expect(connection.oauthScopes).toContain(write);
		expect(
			JSON.parse((await getConnectionSecret("userA", conn.id)) ?? "{}"),
		).toEqual({ refreshToken: "retained", accessToken: "upgraded" });
	});
});

describe("native Gmail pilot on the existing Google account", () => {
	const origin = "https://app.example.com";
	const read = "https://www.googleapis.com/auth/gmail.readonly";
	const modify = "https://www.googleapis.com/auth/gmail.modify";
	const calendar = "https://www.googleapis.com/auth/calendar.readonly";
	const events = "https://www.googleapis.com/auth/calendar.events";
	beforeEach(() => {
		setConfiguredEnv();
		seedUser("pilot");
		process.env.GMAIL_TEST_USER_IDS = "pilot";
	});
	it("requests only the selected mail scope and rejects forged Gmail consent for other users", async () => {
		const { googleConnectStart, verifyOAuthState } = await import("./google");
		for (const editing of [false, true]) {
			const { authUrl } = await googleConnectStart({
				userId: "pilot",
				origin,
				capabilities: ["email", "calendar"],
				requestGmailEditing: editing,
			});
			const u = new URL(authUrl);
			const scopes = u.searchParams.get("scope")?.split(" ");
			expect(scopes).toContain(calendar);
			expect(scopes).toContain(editing ? modify : read);
			expect(scopes).not.toContain(editing ? read : modify);
			expect(scopes).not.toContain(events);
			expect(u.searchParams.get("redirect_uri")).toBe(
				`${origin}/api/oauth/google/callback`,
			);
			expect(u.searchParams.get("client_id")).toBe("test-client-id");
			expect(
				verifyOAuthState(u.searchParams.get("state") ?? "").requestGmailEditing,
			).toBe(editing || undefined);
		}
		await expect(
			googleConnectStart({
				userId: "ordinary",
				origin,
				capabilities: ["email"],
			}),
		).rejects.toMatchObject({ code: "write_review_unavailable" });
		await expect(
			googleConnectStart({
				userId: "pilot",
				origin,
				capabilities: ["calendar"],
				requestGmailEditing: true,
			}),
		).rejects.toMatchObject({ code: "invalid_write_target" });
	});
	it("keeps a reconnect's fresh credential when an older Google refresh finishes afterwards", async () => {
		const { googleRefreshAccessToken } = await import("./google");
		const { createConnection, getConnectionSecret, updateConnection } =
			await import("../store");
		const connection = await createConnection({
			userId: "pilot",
			provider: "google",
			label: "Google",
			accountIdentifier: "test@example.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: JSON.stringify({
				accessToken: "old-access",
				refreshToken: "old-refresh",
			}),
		});
		const fetch = vi.fn(async () => {
			await updateConnection("pilot", connection.id, {
				secret: JSON.stringify({
					accessToken: "new-access",
					refreshToken: "new-refresh",
				}),
			});
			return jsonResponse(200, {
				access_token: "stale-access",
				refresh_token: "stale-refresh",
				expires_in: 3600,
			});
		});
		await expect(
			googleRefreshAccessToken("pilot", connection.id, { fetch }),
		).rejects.toMatchObject({ code: "token_exchange_failed" });
		expect(
			JSON.parse((await getConnectionSecret("pilot", connection.id)) ?? "{}"),
		).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });
	});
	it("upgrades the selected verified mailbox while retaining its calendar and refresh token; enforces consent and current eligibility at access", async () => {
		const { googleConnectStart, googleConnectFinish } = await import(
			"./google"
		);
		const { getConnectionSecret, updateConnection } = await import("../store");
		const { gmailCanModify, gmailGetAccessToken } = await import("./gmail");
		async function finish(
			state: string,
			scope: string,
			email: string,
			refresh?: string,
		) {
			const fetch = vi.fn(async (input: RequestInfo | URL) =>
				String(input) === TOKEN_URL
					? jsonResponse(200, {
							access_token: "new-access",
							refresh_token: refresh,
							expires_in: 3600,
							scope,
							token_type: "Bearer",
						})
					: jsonResponse(200, { email, verified_email: true }),
			);
			return (await googleConnectFinish({ state, code: "code", origin, fetch }))
				.connection;
		}
		const initial = await googleConnectStart({
			userId: "pilot",
			origin,
			capabilities: ["calendar"],
		});
		const old = await finish(
			new URL(initial.authUrl).searchParams.get("state") ?? "",
			[calendar, read, modify].join(" "),
			"test@example.com",
			"old-refresh",
		);
		expect(old.capabilities).toEqual(["calendar"]);
		expect(old.oauthScopes).not.toContain(modify);
		const add = await googleConnectStart({
			userId: "pilot",
			origin,
			capabilities: ["email"],
			googleConnectionId: old.id,
			requestGmailEditing: true,
		});
		const url = new URL(add.authUrl);
		expect(url.searchParams.get("login_hint")).toBe("test@example.com");
		const state = url.searchParams.get("state") ?? "";
		await expect(
			finish(state, modify, "other@example.com"),
		).rejects.toMatchObject({ code: "wrong_account" });
		await expect(
			finish(state, modify, "test@example.com"),
		).rejects.toMatchObject({ code: "write_grant_missing" });
		const joined = await finish(
			state,
			[calendar, modify].join(" "),
			"test@example.com",
		);
		expect(joined.id).toBe(old.id);
		expect(joined.capabilities).toEqual(["calendar", "email"]);
		expect(joined.allowWrites).toBe(false);
		expect(
			JSON.parse((await getConnectionSecret("pilot", joined.id)) ?? "{}")
				.refreshToken,
		).toBe("old-refresh");
		expect(await gmailGetAccessToken(joined)).toBe("new-access");
		await expect(gmailGetAccessToken(joined, {}, "modify")).rejects.toThrow();
		const writes = await updateConnection("pilot", joined.id, {
			allowWrites: true,
		});
		if (!writes) throw new Error("Missing Gmail account");
		expect(gmailCanModify(writes)).toBe(true);
		delete process.env.GMAIL_TEST_USER_IDS;
		expect(gmailCanModify(writes)).toBe(false);
		await expect(gmailGetAccessToken(writes)).rejects.toThrow();
	});
});

describe("Drive uses its own explicit pilot permissions on the same Google credential", () => {
	const origin = "https://app.example.com";
	const readonly = "https://www.googleapis.com/auth/drive.readonly";
	const full = "https://www.googleapis.com/auth/drive";
	const calendar = "https://www.googleapis.com/auth/calendar.readonly";
	const mail = "https://www.googleapis.com/auth/gmail.modify";
	beforeEach(() => {
		setConfiguredEnv();
		seedUser("drive-owner");
		process.env.DRIVE_TEST_USER_IDS = "drive-owner";
	});
	it("keeps Drive separate from Gmail and Calendar, signs the choice, and rejects a request outside its pilot", async () => {
		const { googleConnectStart, verifyOAuthState } = await import("./google");
		for (const manage of [false, true]) {
			const start = await googleConnectStart({
				userId: "drive-owner",
				origin,
				capabilities: ["files", "calendar"],
				requestDriveEditing: manage,
			});
			const url = new URL(start.authUrl);
			const scopes = url.searchParams.get("scope")?.split(" ");
			expect(scopes).toContain(manage ? full : readonly);
			expect(scopes).not.toContain(manage ? readonly : full);
			expect(scopes).toContain(calendar);
			expect(scopes).not.toContain(mail);
			expect(
				verifyOAuthState(url.searchParams.get("state") ?? "")
					.requestDriveEditing,
			).toBe(manage || undefined);
		}
		await expect(
			googleConnectStart({ userId: "other", origin, capabilities: ["files"] }),
		).rejects.toMatchObject({ code: "write_review_unavailable" });
		await expect(
			googleConnectStart({
				userId: "drive-owner",
				origin,
				capabilities: ["email", "files"],
			}),
		).rejects.toMatchObject({ code: "write_review_unavailable" });
		await expect(
			googleConnectStart({
				userId: "drive-owner",
				origin,
				capabilities: ["calendar"],
				requestDriveEditing: true,
			}),
		).rejects.toMatchObject({ code: "invalid_write_target" });
	});
	it("does not promote extra Drive scopes on a Calendar grant and enables only explicitly granted Drive permissions", async () => {
		const { googleConnectStart, googleConnectFinish } = await import(
			"./google"
		);
		const { googleDriveGetAccessToken } = await import("./google-drive-auth");
		const { updateConnection } = await import("../store");
		async function finish(
			state: string,
			scope: string,
			email = "owner@example.com",
		) {
			const fetch = vi.fn(async (input: RequestInfo | URL) =>
				String(input) === TOKEN_URL
					? jsonResponse(200, {
							access_token: "token",
							refresh_token: "refresh",
							expires_in: 3600,
							scope,
							token_type: "Bearer",
						})
					: jsonResponse(200, { email, verified_email: true }),
			);
			return (await googleConnectFinish({ state, origin, code: "code", fetch }))
				.connection;
		}
		const original = await googleConnectStart({
			userId: "drive-owner",
			origin,
			capabilities: ["calendar"],
		});
		const old = await finish(
			new URL(original.authUrl).searchParams.get("state") ?? "",
			[calendar, readonly, full].join(" "),
		);
		expect(old.capabilities).toEqual(["calendar"]);
		expect(old.oauthScopes).not.toContain(full);
		const add = await googleConnectStart({
			userId: "drive-owner",
			origin,
			capabilities: ["files"],
			requestDriveEditing: true,
			googleConnectionId: old.id,
		});
		const state = new URL(add.authUrl).searchParams.get("state") ?? "";
		await expect(
			finish(state, full, "other@example.com"),
		).rejects.toMatchObject({ code: "wrong_account" });
		await expect(finish(state, full)).rejects.toMatchObject({
			code: "write_grant_missing",
		});
		const account = await finish(state, [full, calendar, mail].join(" "));
		expect(account.id).toBe(old.id);
		expect(account.capabilities).toEqual(["calendar", "files"]);
		expect(account.oauthScopes).not.toContain(mail);
		expect(account.allowWrites).toBe(false);
		await expect(googleDriveGetAccessToken(account)).resolves.toBe("token");
		await expect(
			googleDriveGetAccessToken(account, {}, "modify"),
		).rejects.toThrow();
		await updateConnection("drive-owner", account.id, { allowWrites: true });
		await expect(
			googleDriveGetAccessToken(account, {}, "modify"),
		).resolves.toBe("token");
		delete process.env.DRIVE_TEST_USER_IDS;
		await expect(googleDriveGetAccessToken(account)).rejects.toThrow();
	});
});
