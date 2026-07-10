import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Task 8 — OneDrive (Microsoft Graph) adapter tests. Unlike google.ts
// (whose OAuth lifecycle lives separately from its capability reads in
// google-calendar.ts), onedrive.ts is a SINGLE self-contained file per the
// task brief, so read functions (list/search/read/stat) cannot have their
// internal token refresh mocked via a cross-module vi.mock the way
// google-calendar.test.ts mocks googleRefreshAccessToken — every read
// function here calls onedriveRefreshAccessToken as a same-module function
// reference, not a re-imported binding. Every read-function test therefore
// drives the mocked `fetch` end to end: it must answer BOTH the token
// refresh POST (MS_TOKEN_URL) the read function issues internally AND the
// subsequent Microsoft Graph call, exactly like a real Microsoft Graph
// round trip would.

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
	"ONEDRIVE_CLIENT_ID",
	"ONEDRIVE_CLIENT_SECRET",
	"ALFYAI_API_SIGNING_KEY",
];

function setConfiguredEnv() {
	process.env.ONEDRIVE_CLIENT_ID = "test-client-id";
	process.env.ONEDRIVE_CLIENT_SECRET = "test-client-secret";
	process.env.ALFYAI_API_SIGNING_KEY = "test-signing-key";
}

function setSigningKeyOnly() {
	process.env.ALFYAI_API_SIGNING_KEY = "test-signing-key";
}

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	for (const key of ENV_KEYS) delete process.env[key];

	dbPath = `./data/test-onedrive-${randomUUID()}.db`;
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
	vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

describe("onedriveConnectStart", () => {
	it("throws a typed not_configured error when client id/secret are unset", async () => {
		setSigningKeyOnly();
		const { onedriveConnectStart, OneDriveError } = await import("./onedrive");

		try {
			await onedriveConnectStart({
				userId: "userA",
				origin: "https://app.example.com",
				capabilities: ["files"],
			});
			throw new Error("expected onedriveConnectStart to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"not_configured",
			);
		}
	});

	it("builds an authUrl with client_id, redirect_uri, prompt=consent, mapped scopes and a state when configured", async () => {
		setConfiguredEnv();
		const { onedriveConnectStart } = await import("./onedrive");

		const { authUrl } = await onedriveConnectStart({
			userId: "userA",
			origin: "https://app.example.com",
			capabilities: ["files"],
		});

		const url = new URL(authUrl);
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		);
		expect(url.searchParams.get("client_id")).toBe("test-client-id");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://app.example.com/api/oauth/onedrive/callback",
		);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("prompt")).toBe("consent");

		const scope = url.searchParams.get("scope") ?? "";
		expect(scope).toContain("Files.Read");
		expect(scope).toContain("offline_access");
		expect(scope).toContain("User.Read");

		expect(url.searchParams.get("state")).toBeTruthy();
	});
});

describe("signOAuthState / verifyOAuthState", () => {
	it("verifies a freshly signed state and returns its payload", async () => {
		setSigningKeyOnly();
		const { signOAuthState, verifyOAuthState } = await import("./onedrive");

		const state = signOAuthState({ userId: "userA", capabilities: ["files"] });
		const payload = verifyOAuthState(state);

		expect(payload.userId).toBe("userA");
		expect(payload.capabilities).toEqual(["files"]);
		expect(typeof payload.nonce).toBe("string");
	});

	it("throws on a tampered state", async () => {
		setSigningKeyOnly();
		const { signOAuthState, verifyOAuthState } = await import("./onedrive");

		const state = signOAuthState({ userId: "userA", capabilities: ["files"] });
		const [payloadPart, signaturePart] = state.split(".");
		const tampered = `${payloadPart}tampered.${signaturePart}`;

		expect(() => verifyOAuthState(tampered)).toThrow();
	});

	it("throws on an expired state", async () => {
		setSigningKeyOnly();
		vi.useFakeTimers();
		try {
			const { signOAuthState, verifyOAuthState } = await import("./onedrive");
			const state = signOAuthState({
				userId: "userA",
				capabilities: ["files"],
			});
			vi.advanceTimersByTime(11 * 60 * 1000);
			expect(() => verifyOAuthState(state)).toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("onedriveConnectFinish", () => {
	it("creates a onedrive connection from mocked token+userinfo responses; DTO is secret-free and the stored secret decrypts to the refresh+access tokens", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { signOAuthState, onedriveConnectFinish } = await import(
			"./onedrive"
		);
		const { getConnectionSecret } = await import("../store");

		const state = signOAuthState({ userId: "userA", capabilities: ["files"] });

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
						"https://app.example.com/api/oauth/onedrive/callback",
					);
					return jsonResponse(200, {
						access_token: "access-abc",
						refresh_token: "refresh-xyz",
						expires_in: 3600,
						scope: "openid profile email offline_access User.Read Files.Read",
						token_type: "Bearer",
					});
				}
				if (url.startsWith(`${GRAPH_BASE}/me?`)) {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe("Bearer access-abc");
					return jsonResponse(200, { mail: "alice@example.com" });
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const { connection } = await onedriveConnectFinish({
			code: "auth-code-123",
			state,
			origin: "https://app.example.com",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.provider).toBe("onedrive");
		expect(connection.accountIdentifier).toBe("alice@example.com");
		expect(connection.capabilities).toEqual(["files"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);

		const serialized = JSON.stringify(connection);
		expect(serialized).not.toContain("refresh-xyz");
		expect(serialized).not.toContain("access-abc");

		const decrypted = await getConnectionSecret("userA", connection.id);
		const parsedSecret = JSON.parse(decrypted as string);
		expect(parsedSecret.refreshToken).toBe("refresh-xyz");
		expect(parsedSecret.accessToken).toBe("access-abc");
	});

	it("falls back to userPrincipalName when mail is absent (personal MSA accounts)", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { signOAuthState, onedriveConnectFinish } = await import(
			"./onedrive"
		);

		const state = signOAuthState({ userId: "userA", capabilities: ["files"] });
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "access-abc",
					refresh_token: "refresh-xyz",
					expires_in: 3600,
					scope: "offline_access Files.Read",
					token_type: "Bearer",
				});
			}
			return jsonResponse(200, { userPrincipalName: "alice@outlook.com" });
		});

		const { connection } = await onedriveConnectFinish({
			code: "auth-code-123",
			state,
			origin: "https://app.example.com",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.accountIdentifier).toBe("alice@outlook.com");
	});

	it("updates (not duplicates) the existing connection for the same email and preserves the stored refresh token when Microsoft omits a new one", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { signOAuthState, onedriveConnectFinish } = await import(
			"./onedrive"
		);
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
					scope: "offline_access Files.Read",
					token_type: "Bearer",
				});
			}
			return jsonResponse(200, { mail: "alice@example.com" });
		});
		const first = await onedriveConnectFinish({
			code: "code-1",
			state: signOAuthState({ userId: "userA", capabilities: ["files"] }),
			origin: "https://app.example.com",
			fetch: firstFetch as unknown as typeof fetch,
		});

		const secondFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "access-2",
					// no refresh_token this time
					expires_in: 3600,
					scope: "offline_access Files.Read",
					token_type: "Bearer",
				});
			}
			return jsonResponse(200, { mail: "alice@example.com" });
		});
		const second = await onedriveConnectFinish({
			code: "code-2",
			state: signOAuthState({ userId: "userA", capabilities: ["files"] }),
			origin: "https://app.example.com",
			fetch: secondFetch as unknown as typeof fetch,
		});

		expect(second.connection.id).toBe(first.connection.id);
		const rows = await listConnectionsForUser("userA");
		expect(rows).toHaveLength(1);

		const decrypted = await getConnectionSecret("userA", second.connection.id);
		const parsedSecret = JSON.parse(decrypted as string);
		expect(parsedSecret.refreshToken).toBe("refresh-1");
		expect(parsedSecret.accessToken).toBe("access-2");
	});
});

async function seedConnection(opts?: { tokenExpiresAt?: number }) {
	seedUser("userA");
	const { createConnection } = await import("../store");
	return createConnection({
		userId: "userA",
		provider: "onedrive",
		label: "OneDrive",
		accountIdentifier: "alice@example.com",
		capabilities: ["files"],
		status: "connected",
		secret: JSON.stringify({
			refreshToken: "refresh-xyz",
			accessToken: "old-access",
		}),
		config: {},
		oauthScopes: ["Files.Read"],
		tokenExpiresAt: opts?.tokenExpiresAt ?? Math.floor(Date.now() / 1000) - 10,
	});
}

describe("onedriveRefreshAccessToken", () => {
	it("stores a fresh access token and updates tokenExpiresAt on success", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveRefreshAccessToken } = await import("./onedrive");
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
		const token = await onedriveRefreshAccessToken("userA", conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(token).toBe("new-access");

		const updated = await getConnection("userA", conn.id);
		expect(updated?.tokenExpiresAt).toBeGreaterThanOrEqual(beforeCall + 3600);

		const decrypted = await getConnectionSecret("userA", conn.id);
		const parsedSecret = JSON.parse(decrypted as string);
		expect(parsedSecret.accessToken).toBe("new-access");
		// Microsoft omitted a refresh_token this time — the existing one is kept.
		expect(parsedSecret.refreshToken).toBe("refresh-xyz");
	});

	it("rotates the stored refresh token when Microsoft returns a new one", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveRefreshAccessToken } = await import("./onedrive");
		const { getConnectionSecret } = await import("../store");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, {
				access_token: "new-access",
				refresh_token: "rotated-refresh",
				expires_in: 3600,
			}),
		);

		await onedriveRefreshAccessToken("userA", conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		const decrypted = await getConnectionSecret("userA", conn.id);
		const parsedSecret = JSON.parse(decrypted as string);
		expect(parsedSecret.refreshToken).toBe("rotated-refresh");
	});

	it("marks the connection needs_reauth and throws a typed error on invalid_grant", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveRefreshAccessToken, OneDriveError } = await import(
			"./onedrive"
		);
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () =>
			jsonResponse(400, { error: "invalid_grant" }),
		);

		try {
			await onedriveRefreshAccessToken("userA", conn.id, {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected onedriveRefreshAccessToken to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"invalid_grant",
			);
		}

		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});

	it("persists needs_reauth when no refresh token is stored, before throwing, without a network call", async () => {
		setConfiguredEnv();
		seedUser("userA");
		const { createConnection } = await import("../store");
		const conn = await createConnection({
			userId: "userA",
			provider: "onedrive",
			label: "OneDrive",
			accountIdentifier: "alice@example.com",
			capabilities: ["files"],
			status: "connected",
			secret: JSON.stringify({ refreshToken: null, accessToken: "old-access" }),
			config: {},
			oauthScopes: ["Files.Read"],
			tokenExpiresAt: Math.floor(Date.now() / 1000) - 10,
		});

		const { onedriveRefreshAccessToken, OneDriveError } = await import(
			"./onedrive"
		);
		const { getConnection } = await import("../store");
		const fetchMock = vi.fn();

		try {
			await onedriveRefreshAccessToken("userA", conn.id, {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected onedriveRefreshAccessToken to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"needs_reauth",
			);
		}

		expect(fetchMock).not.toHaveBeenCalled();
		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

describe("onedriveAdapter.checkHealth", () => {
	it("skips the network refresh and confirms via GET /me/drive when the access token is nowhere near expiry", async () => {
		setConfiguredEnv();
		const conn = await seedConnection({
			tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
		});
		const { onedriveAdapter } = await import("./onedrive");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(`${GRAPH_BASE}/me/drive`);
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer old-access");
				return jsonResponse(200, { id: "drive-1" });
			},
		);

		const health = await onedriveAdapter.checkHealth(
			JSON.stringify({
				refreshToken: "refresh-xyz",
				accessToken: "old-access",
			}),
			conn,
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(health.status).toBe("connected");
	});

	it("refreshes first when the token is missing/near expiry, then confirms via GET /me/drive", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveAdapter } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-access",
					expires_in: 3600,
				});
			}
			if (url === `${GRAPH_BASE}/me/drive`) {
				return jsonResponse(200, { id: "drive-1" });
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const health = await onedriveAdapter.checkHealth("refresh-xyz", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("connected");
	});

	it("needs_reauth when the refresh returns invalid_grant, with no secret in the detail", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveAdapter } = await import("./onedrive");

		const fetchMock = vi.fn(async () =>
			jsonResponse(400, { error: "invalid_grant" }),
		);

		const health = await onedriveAdapter.checkHealth("refresh-xyz", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("needs_reauth");
		expect(health.detail).not.toContain("refresh-xyz");
	});

	it("needs_reauth when GET /me/drive itself returns 401 after a successful refresh", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveAdapter } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-access",
					expires_in: 3600,
				});
			}
			return new Response("", { status: 401 });
		});

		const health = await onedriveAdapter.checkHealth("refresh-xyz", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("needs_reauth");
	});

	it("error status on an unexpected GET /me/drive response", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveAdapter } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-access",
					expires_in: 3600,
				});
			}
			return new Response("", { status: 500 });
		});

		const health = await onedriveAdapter.checkHealth("refresh-xyz", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// Read methods — every test's fetchMock answers the internal token refresh
// (TOKEN_URL) plus the Graph call(s) under test.
// ---------------------------------------------------------------------------

function refreshHandler(accessToken = "fresh-access") {
	return async (input: RequestInfo | URL) => {
		if (String(input) === TOKEN_URL) {
			return jsonResponse(200, { access_token: accessToken, expires_in: 3600 });
		}
		return null;
	};
}

describe("onedriveListFolder", () => {
	it("lists the root when path is empty, deriving each child's path from name", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveListFolder } = await import("./onedrive");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const refreshed = await refreshHandler()(input);
				if (refreshed) return refreshed;
				const url = String(input);
				expect(url).toBe(`${GRAPH_BASE}/me/drive/root/children`);
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer fresh-access");
				return jsonResponse(200, {
					value: [
						{
							name: "report.pdf",
							size: 4096,
							eTag: "etag-1",
							lastModifiedDateTime: "2024-01-15T10:30:00Z",
							file: { mimeType: "application/pdf" },
							webUrl: "https://onedrive.live.com/report.pdf",
						},
						{
							name: "Documents",
							folder: { childCount: 2 },
						},
					],
				});
			},
		);

		const files = await onedriveListFolder(conn, "secret", "", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(files).toEqual([
			{
				name: "report.pdf",
				path: "report.pdf",
				isDir: false,
				size: 4096,
				mtime: "2024-01-15T10:30:00Z",
				contentType: "application/pdf",
				etag: "etag-1",
				webUrl: "https://onedrive.live.com/report.pdf",
			},
			{
				name: "Documents",
				path: "Documents",
				isDir: true,
				size: 0,
				mtime: null,
				contentType: null,
				etag: null,
				webUrl: null,
			},
		]);
	});

	it("lists a subfolder using the root:/{path}:/children form, URL-encoding segments", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveListFolder } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			const url = String(input);
			expect(url).toBe(`${GRAPH_BASE}/me/drive/root:/My%20Docs/Sub:/children`);
			return jsonResponse(200, { value: [] });
		});

		const files = await onedriveListFolder(conn, "secret", "My Docs/Sub", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(files).toEqual([]);
	});

	it("throws not_found when the folder's first page 404s", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveListFolder, OneDriveError } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			return new Response("", { status: 404 });
		});

		try {
			await onedriveListFolder(conn, "secret", "Missing", {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected onedriveListFolder to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"not_found",
			);
		}
	});

	it("follows @odata.nextLink pagination and merges every page's items", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveListFolder } = await import("./onedrive");

		const NEXT_URL = `${GRAPH_BASE}/me/drive/root/children?$skiptoken=abc`;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			const url = String(input);
			if (url === `${GRAPH_BASE}/me/drive/root/children`) {
				return jsonResponse(200, {
					value: [{ name: "a.txt", file: { mimeType: "text/plain" } }],
					"@odata.nextLink": NEXT_URL,
				});
			}
			if (url === NEXT_URL) {
				return jsonResponse(200, {
					value: [{ name: "b.txt", file: { mimeType: "text/plain" } }],
				});
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const files = await onedriveListFolder(conn, "secret", "", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
	});

	it("maps a 401 from Graph to needs_reauth", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveListFolder, OneDriveError } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			return new Response("", { status: 401 });
		});

		try {
			await onedriveListFolder(conn, "secret", "", {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected onedriveListFolder to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"needs_reauth",
			);
		}
	});
});

describe("onedriveStat", () => {
	it("returns the item for an existing path, echoing the requested path", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveStat } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			expect(String(input)).toBe(`${GRAPH_BASE}/me/drive/root:/notes/todo.txt`);
			return jsonResponse(200, {
				name: "todo.txt",
				size: 5,
				file: { mimeType: "text/plain" },
				lastModifiedDateTime: "2024-01-02T00:00:00Z",
			});
		});

		const result = await onedriveStat(conn, "secret", "notes/todo.txt", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(result).toEqual({
			name: "todo.txt",
			path: "notes/todo.txt",
			isDir: false,
			size: 5,
			mtime: "2024-01-02T00:00:00Z",
			contentType: "text/plain",
			etag: null,
			webUrl: null,
		});
	});

	it("returns null for a 404 (not an error)", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveStat } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			return new Response("", { status: 404 });
		});

		const result = await onedriveStat(conn, "secret", "missing.txt", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(result).toBeNull();
	});

	it("stats the root itself when path is empty", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveStat } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			expect(String(input)).toBe(`${GRAPH_BASE}/me/drive/root`);
			return jsonResponse(200, { name: "root", folder: { childCount: 3 } });
		});

		const result = await onedriveStat(conn, "secret", "", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(result?.isDir).toBe(true);
	});
});

describe("onedriveSearch", () => {
	it("escapes single quotes (OData) and derives each item's path from parentReference", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveSearch } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			const url = String(input);
			expect(url).toBe(`${GRAPH_BASE}/me/drive/root/search(q='budget%20''24')`);
			return jsonResponse(200, {
				value: [
					{
						name: "budget.xlsx",
						size: 1024,
						lastModifiedDateTime: "2024-01-03T00:00:00Z",
						file: { mimeType: "application/vnd.openxmlformats" },
						parentReference: { path: "/drive/root:/Documents" },
					},
				],
			});
		});

		const results = await onedriveSearch(conn, "secret", "budget '24", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(results).toEqual([
			{
				name: "budget.xlsx",
				path: "Documents/budget.xlsx",
				isDir: false,
				size: 1024,
				mtime: "2024-01-03T00:00:00Z",
				contentType: "application/vnd.openxmlformats",
				etag: null,
				webUrl: null,
			},
		]);
	});

	it("falls back to the bare name when parentReference is at the root", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveSearch } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			return jsonResponse(200, {
				value: [
					{
						name: "root-file.txt",
						file: { mimeType: "text/plain" },
						parentReference: { path: "/drive/root:" },
					},
				],
			});
		});

		const results = await onedriveSearch(conn, "secret", "root-file", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(results[0]?.path).toBe("root-file.txt");
	});
});

describe("onedriveReadFile", () => {
	it("reads via the item's pre-authenticated downloadUrl (no auth header needed on that request)", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveReadFile } = await import("./onedrive");

		const DOWNLOAD_URL = "https://blob.example.com/report.pdf?sig=abc";
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			const url = String(input);
			if (url === `${GRAPH_BASE}/me/drive/root:/report.pdf`) {
				return jsonResponse(200, {
					name: "report.pdf",
					size: 11,
					eTag: "etag-1",
					lastModifiedDateTime: "2024-01-15T10:30:00Z",
					file: { mimeType: "application/pdf" },
					webUrl: "https://onedrive.live.com/report.pdf",
					"@microsoft.graph.downloadUrl": DOWNLOAD_URL,
				});
			}
			if (url === DOWNLOAD_URL) {
				return new Response("hello world", {
					status: 200,
					headers: { "Content-Type": "application/pdf" },
				});
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const file = await onedriveReadFile(conn, "secret", "report.pdf", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(Buffer.from(file.bytes).toString("utf-8")).toBe("hello world");
		expect(file.etag).toBe("etag-1");
		expect(file.contentType).toBe("application/pdf");
		expect(file.mtime).toBe("2024-01-15T10:30:00Z");
		expect(file.webUrl).toBe("https://onedrive.live.com/report.pdf");
	});

	it("falls back to an authenticated GET on /content when downloadUrl is absent", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveReadFile } = await import("./onedrive");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const refreshed = await refreshHandler()(input);
				if (refreshed) return refreshed;
				const url = String(input);
				if (url === `${GRAPH_BASE}/me/drive/root:/notes.txt`) {
					return jsonResponse(200, {
						name: "notes.txt",
						size: 5,
						file: { mimeType: "text/plain" },
					});
				}
				if (url === `${GRAPH_BASE}/me/drive/root:/notes.txt:/content`) {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe("Bearer fresh-access");
					return new Response("hello", { status: 200 });
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const file = await onedriveReadFile(conn, "secret", "notes.txt", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(Buffer.from(file.bytes).toString("utf-8")).toBe("hello");
	});

	it("throws not_found for a missing file", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveReadFile, OneDriveError } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			return new Response("", { status: 404 });
		});

		try {
			await onedriveReadFile(conn, "secret", "missing.txt", {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected onedriveReadFile to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"not_found",
			);
		}
	});

	it("refuses to read a folder as a file", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveReadFile, OneDriveError } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			return jsonResponse(200, {
				name: "Documents",
				folder: { childCount: 1 },
			});
		});

		try {
			await onedriveReadFile(conn, "secret", "Documents", {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected onedriveReadFile to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"invalid_path",
			);
		}
	});

	it("refuses a file whose reported size exceeds the read cap, without downloading it", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveReadFile, OneDriveError } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			const url = String(input);
			if (url === `${GRAPH_BASE}/me/drive/root:/huge.bin`) {
				return jsonResponse(200, {
					name: "huge.bin",
					size: 26 * 1024 * 1024,
					file: { mimeType: "application/octet-stream" },
					"@microsoft.graph.downloadUrl": "https://blob.example.com/huge.bin",
				});
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		try {
			await onedriveReadFile(conn, "secret", "huge.bin", {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected onedriveReadFile to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"too_large",
			);
		}
		// Never downloaded — only the metadata call (+ token refresh) happened.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("throws invalid_path when asked to read the root", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveReadFile, OneDriveError } = await import("./onedrive");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const refreshed = await refreshHandler()(input);
			if (refreshed) return refreshed;
			throw new Error("should not reach Graph for an invalid path");
		});

		try {
			await onedriveReadFile(conn, "secret", "", {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected onedriveReadFile to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"invalid_path",
			);
		}
	});
});

// Task 8 Finding A — onedriveStat and onedriveReadFile each independently
// refreshed the access token via onedriveGetAccessTokenForRead (formerly a
// private getAccessTokenForRead). Because a single `read` tool action stats
// a path (onedriveStat, via files.ts's isDirectory guard) and then downloads
// it (onedriveReadFile), that meant TWO OAuth refreshes for one logical
// read — and since Microsoft ROTATES the refresh token on every use, the
// second refresh silently invalidated whatever the first one had just
// stored. The fix: both functions now accept an already-resolved
// `opts.accessToken` and use it as-is instead of refreshing again — see
// files.ts's readFileForConn/statForConn, which resolve one token up front
// (via onedriveGetAccessTokenForRead) and thread it into both calls.
describe("onedriveStat / onedriveReadFile — pre-resolved opts.accessToken (Task 8 Finding A)", () => {
	it("onedriveStat uses opts.accessToken as-is and never hits the token endpoint", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveStat } = await import("./onedrive");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === TOKEN_URL) {
					throw new Error(
						"onedriveStat should not refresh when opts.accessToken is supplied",
					);
				}
				expect(url).toBe(`${GRAPH_BASE}/me/drive/root:/notes/todo.txt`);
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer pre-resolved");
				return jsonResponse(200, {
					name: "todo.txt",
					size: 5,
					file: { mimeType: "text/plain" },
				});
			},
		);

		const result = await onedriveStat(conn, "secret", "notes/todo.txt", {
			fetch: fetchMock as unknown as typeof fetch,
			accessToken: "pre-resolved",
		});

		expect(result?.name).toBe("todo.txt");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("onedriveReadFile uses opts.accessToken as-is and never hits the token endpoint", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveReadFile } = await import("./onedrive");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === TOKEN_URL) {
					throw new Error(
						"onedriveReadFile should not refresh when opts.accessToken is supplied",
					);
				}
				if (url === `${GRAPH_BASE}/me/drive/root:/notes.txt`) {
					return jsonResponse(200, {
						name: "notes.txt",
						size: 5,
						file: { mimeType: "text/plain" },
					});
				}
				if (url === `${GRAPH_BASE}/me/drive/root:/notes.txt:/content`) {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe("Bearer pre-resolved");
					return new Response("hello", { status: 200 });
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const file = await onedriveReadFile(conn, "secret", "notes.txt", {
			fetch: fetchMock as unknown as typeof fetch,
			accessToken: "pre-resolved",
		});

		expect(Buffer.from(file.bytes).toString("utf-8")).toBe("hello");
		expect(fetchMock).not.toHaveBeenCalledWith(TOKEN_URL, expect.anything());
	});

	it("a stat-then-download sequence sharing one pre-resolved token hits the token endpoint exactly once (vs. twice before the fix)", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();
		const { onedriveGetAccessTokenForRead, onedriveStat, onedriveReadFile } =
			await import("./onedrive");

		let tokenCalls = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				tokenCalls += 1;
				return jsonResponse(200, {
					access_token: "fresh-access",
					expires_in: 3600,
				});
			}
			if (url === `${GRAPH_BASE}/me/drive/root:/notes.txt`) {
				return jsonResponse(200, {
					name: "notes.txt",
					size: 5,
					file: { mimeType: "text/plain" },
				});
			}
			if (url === `${GRAPH_BASE}/me/drive/root:/notes.txt:/content`) {
				return new Response("hello", { status: 200 });
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});
		const opts = { fetch: fetchMock as unknown as typeof fetch };

		// Mirrors files.ts's fixed read-path orchestration: resolve ONE token,
		// then thread it through both the stat and the download.
		const accessToken = await onedriveGetAccessTokenForRead(conn, opts);
		await onedriveStat(conn, "secret", "notes.txt", { ...opts, accessToken });
		await onedriveReadFile(conn, "secret", "notes.txt", {
			...opts,
			accessToken,
		});

		expect(tokenCalls).toBe(1);
	});
});

describe("normalizeOneDrivePath", () => {
	it("collapses slashes and drops '.' segments", async () => {
		const { normalizeOneDrivePath } = await import("./onedrive");
		expect(normalizeOneDrivePath("/Documents//Sub/./file.txt")).toBe(
			"Documents/Sub/file.txt",
		);
	});

	it("rejects a '..' that would escape the root", async () => {
		const { normalizeOneDrivePath, OneDriveError } = await import("./onedrive");
		try {
			normalizeOneDrivePath("../secret");
			throw new Error("expected normalizeOneDrivePath to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(OneDriveError);
			expect((err as InstanceType<typeof OneDriveError>).code).toBe(
				"invalid_path",
			);
		}
	});
});

describe("registry adapter shape", () => {
	it("registers as provider 'onedrive' with requiresSecret: true", async () => {
		const { onedriveAdapter } = await import("./onedrive");
		expect(onedriveAdapter.provider).toBe("onedrive");
		expect(onedriveAdapter.requiresSecret).toBe(true);
	});
});
