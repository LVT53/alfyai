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

beforeEach(() => {
	dbPath = `./data/test-connections-immich-${randomUUID()}.db`;
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
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const USER_ID = "userA";

async function seedImmichConnection(overrides: { apiKey?: string } = {}) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: USER_ID,
		provider: "immich",
		label: "Immich",
		accountIdentifier: "alice@example.com",
		capabilities: ["photos"],
		status: "connected",
		secret: overrides.apiKey ?? "immich-secret-key",
		config: { origin: "https://photos.example.com", immichUserId: "user-1" },
	});
}

// ---------------------------------------------------------------------------
// assertReadOnlyPermissions
// ---------------------------------------------------------------------------

describe("assertReadOnlyPermissions", () => {
	it("does not throw for the read-only permission set", async () => {
		const { assertReadOnlyPermissions, READ_ONLY_IMMICH_PERMISSIONS } =
			await import("./immich");
		expect(() =>
			assertReadOnlyPermissions(READ_ONLY_IMMICH_PERMISSIONS),
		).not.toThrow();
	});

	it("throws when 'all' is present", async () => {
		const { assertReadOnlyPermissions } = await import("./immich");
		expect(() => assertReadOnlyPermissions(["asset.read", "all"])).toThrow();
	});

	it("throws for asset.delete", async () => {
		const { assertReadOnlyPermissions } = await import("./immich");
		expect(() =>
			assertReadOnlyPermissions(["asset.read", "asset.delete"]),
		).toThrow();
	});

	it("throws for anything ending in .update or .upload", async () => {
		const { assertReadOnlyPermissions } = await import("./immich");
		expect(() => assertReadOnlyPermissions(["asset.update"])).toThrow();
		expect(() => assertReadOnlyPermissions(["asset.upload"])).toThrow();
	});
});

// ---------------------------------------------------------------------------
// assertNoDangerousImmichWritePermissions (Issue 6.4)
// ---------------------------------------------------------------------------

describe("assertNoDangerousImmichWritePermissions", () => {
	it("does not throw for the write permission set (album.create/albumAsset.create/album.read)", async () => {
		const {
			assertNoDangerousImmichWritePermissions,
			WRITE_IMMICH_PERMISSIONS,
		} = await import("./immich");
		expect(() =>
			assertNoDangerousImmichWritePermissions(WRITE_IMMICH_PERMISSIONS),
		).not.toThrow();
	});

	it.each([
		"all",
		"asset.delete",
		"asset.update",
		"asset.upload",
		"album.delete",
	])("throws for %s", async (permission) => {
		const { assertNoDangerousImmichWritePermissions } = await import(
			"./immich"
		);
		expect(() =>
			assertNoDangerousImmichWritePermissions([permission]),
		).toThrow();
	});

	it("does NOT throw for album.create/albumAsset.create (unlike the read-only guard's .create suffix rule)", async () => {
		const { assertNoDangerousImmichWritePermissions } = await import(
			"./immich"
		);
		expect(() =>
			assertNoDangerousImmichWritePermissions([
				"album.create",
				"albumAsset.create",
			]),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// immichConnect
// ---------------------------------------------------------------------------

describe("immichConnect", () => {
	it("logs in, mints a read-only API key, and stores it (never the password) with a normalized origin", async () => {
		seedUser(USER_ID);
		const { immichConnect } = await import("./immich");
		const { getConnectionSecret } = await import("../store");

		let capturedApiKeyBody: unknown;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://photos.example.com/api/auth/login") {
					const body = JSON.parse(String(init?.body));
					expect(body).toEqual({
						email: "alice@example.com",
						password: "hunter2",
					});
					return jsonResponse(200, {
						accessToken: "access-token-abc",
						userId: "user-1",
						userEmail: "alice@example.com",
						isAdmin: false,
						name: "Alice",
					});
				}
				if (url === "https://photos.example.com/api/api-keys") {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe("Bearer access-token-abc");
					capturedApiKeyBody = JSON.parse(String(init?.body));
					return jsonResponse(201, {
						secret: "immich-secret-key",
						apiKey: { id: "key-1", name: "AlfyAI (read-only)" },
					});
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const { connection } = await immichConnect({
			userId: USER_ID,
			serverUrl: "https://photos.example.com/",
			email: "alice@example.com",
			password: "hunter2",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.provider).toBe("immich");
		expect(connection.accountIdentifier).toBe("alice@example.com");
		expect(connection.capabilities).toEqual(["photos"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);
		expect(connection.config).toEqual({
			origin: "https://photos.example.com",
			immichUserId: "user-1",
		});

		// Never the password, anywhere in the stored/serialized DTO.
		expect(JSON.stringify(connection)).not.toContain("hunter2");

		const decrypted = await getConnectionSecret(USER_ID, connection.id);
		expect(decrypted).toBe("immich-secret-key");
		// The password must never be persisted as the stored secret either.
		expect(decrypted).not.toBe("hunter2");

		// The permissions POSTed must be exactly the read-only set and contain
		// none of the forbidden delete/write/all scopes.
		expect(capturedApiKeyBody).toMatchObject({ name: "AlfyAI (read-only)" });
		const permissions = (capturedApiKeyBody as { permissions: string[] })
			.permissions;
		expect(permissions).toEqual(
			expect.arrayContaining(["asset.read", "asset.view", "album.read"]),
		);
		for (const forbidden of [
			"all",
			"asset.delete",
			"asset.update",
			"asset.upload",
			"asset.replace",
		]) {
			expect(permissions).not.toContain(forbidden);
		}
	});

	it("normalizes a server URL that already ends in /api", async () => {
		seedUser(USER_ID);
		const { immichConnect } = await import("./immich");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://photos.example.com/api/auth/login") {
					return jsonResponse(200, {
						accessToken: "token",
						userId: "user-1",
						userEmail: "alice@example.com",
					});
				}
				if (url === "https://photos.example.com/api/api-keys") {
					return jsonResponse(201, { secret: "s3cr3t", apiKey: {} });
				}
				throw new Error(
					`Unexpected fetch to ${url} (init=${JSON.stringify(init)})`,
				);
			},
		);

		const { connection } = await immichConnect({
			userId: USER_ID,
			serverUrl: "https://photos.example.com/api",
			email: "alice@example.com",
			password: "hunter2",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.config.origin).toBe("https://photos.example.com");
	});

	it("rejects a non-http(s) server URL as invalid_config without ever calling fetch", async () => {
		seedUser(USER_ID);
		const { immichConnect, ImmichError } = await import("./immich");
		const fetchMock = vi.fn();

		try {
			await immichConnect({
				userId: USER_ID,
				serverUrl: "ftp://photos.example.com",
				email: "alice@example.com",
				password: "hunter2",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected immichConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ImmichError);
			expect((err as InstanceType<typeof ImmichError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["a plain http:// URL", "http://photos.example.com"],
		["a loopback IPv4 host", "https://127.0.0.1:2283"],
		["a private RFC1918 host", "https://192.168.1.10"],
		["the cloud metadata address", "https://169.254.169.254/latest"],
		["a loopback IPv6 host", "https://[::1]:2283"],
	])("rejects %s as invalid_config without ever calling fetch (SSRF guard)", async (_label, serverUrl) => {
		seedUser(USER_ID);
		const { immichConnect, ImmichError } = await import("./immich");
		const fetchMock = vi.fn();

		try {
			await immichConnect({
				userId: USER_ID,
				serverUrl,
				email: "alice@example.com",
				password: "hunter2",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected immichConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ImmichError);
			expect((err as InstanceType<typeof ImmichError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still normalizes a public https server URL with a trailing /api/", async () => {
		seedUser(USER_ID);
		const { immichConnect } = await import("./immich");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/auth/login")) {
				return jsonResponse(200, {
					accessToken: "token",
					userId: "user-1",
					userEmail: "alice@example.com",
				});
			}
			if (url.endsWith("/api/api-keys")) {
				return jsonResponse(201, { secret: "s3cr3t", apiKey: {} });
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const { connection } = await immichConnect({
			userId: USER_ID,
			serverUrl: "https://photos.example.com/api/",
			email: "alice@example.com",
			password: "hunter2",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.config.origin).toBe("https://photos.example.com");
	});

	it("a 401 on login surfaces a clear invalid_credentials error with no password in the message", async () => {
		seedUser(USER_ID);
		const { immichConnect, ImmichError } = await import("./immich");

		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { message: "Invalid credentials" }),
		);

		try {
			await immichConnect({
				userId: USER_ID,
				serverUrl: "https://photos.example.com",
				email: "alice@example.com",
				password: "wrong-pw",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected immichConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ImmichError);
			expect((err as InstanceType<typeof ImmichError>).code).toBe(
				"invalid_credentials",
			);
			expect((err as Error).message).not.toContain("wrong-pw");
			expect((err as Error).message.toLowerCase()).toContain("invalid");
		}
	});

	it("re-connecting the same email updates (not duplicates) the connection and refreshes the stored key", async () => {
		seedUser(USER_ID);
		const { immichConnect } = await import("./immich");
		const { listConnectionsForUser, getConnectionSecret } = await import(
			"../store"
		);

		const makeFetch = (secret: string) =>
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/api/auth/login")) {
					return jsonResponse(200, {
						accessToken: "token",
						userId: "user-1",
						userEmail: "alice@example.com",
					});
				}
				if (url.endsWith("/api/api-keys")) {
					return jsonResponse(201, { secret, apiKey: {} });
				}
				throw new Error(`Unexpected fetch to ${url}`);
			});

		const first = await immichConnect({
			userId: USER_ID,
			serverUrl: "https://photos.example.com",
			email: "alice@example.com",
			password: "first-pw",
			fetch: makeFetch("first-key") as unknown as typeof fetch,
		});
		const second = await immichConnect({
			userId: USER_ID,
			serverUrl: "https://photos.example.com",
			email: "alice@example.com",
			password: "second-pw",
			fetch: makeFetch("second-key") as unknown as typeof fetch,
		});

		expect(second.connection.id).toBe(first.connection.id);
		const rows = await listConnectionsForUser(USER_ID);
		expect(rows).toHaveLength(1);
		const decrypted = await getConnectionSecret(USER_ID, second.connection.id);
		expect(decrypted).toBe("second-key");
	});
});

// ---------------------------------------------------------------------------
// immichEnableWrites (Issue 6.4)
// ---------------------------------------------------------------------------

describe("immichEnableWrites", () => {
	it("re-logs in, mints a write-scoped key whose permissions contain none of delete/update/upload/all, and stores it (never the password) in the SEPARATE write-secret columns", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichEnableWrites } = await import("./immich");
		const { getConnectionSecret, getConnectionWriteSecret } = await import(
			"../store"
		);

		let capturedApiKeyBody: unknown;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://photos.example.com/api/auth/login") {
					const body = JSON.parse(String(init?.body));
					expect(body).toEqual({
						email: "alice@example.com",
						password: "hunter2",
					});
					return jsonResponse(200, {
						accessToken: "access-token-write",
						userId: "user-1",
						userEmail: "alice@example.com",
					});
				}
				if (url === "https://photos.example.com/api/api-keys") {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe(
						"Bearer access-token-write",
					);
					capturedApiKeyBody = JSON.parse(String(init?.body));
					return jsonResponse(201, {
						secret: "write-scoped-key",
						apiKey: { id: "key-2", name: "AlfyAI (album write)" },
					});
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const { connection } = await immichEnableWrites({
			userId: USER_ID,
			connectionId: conn.id,
			password: "hunter2",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.hasWriteSecret).toBe(true);
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);
		expect(JSON.stringify(connection)).not.toContain("hunter2");
		expect(JSON.stringify(connection)).not.toContain("write-scoped-key");

		// The read-only key from connect-time is untouched.
		const readSecret = await getConnectionSecret(USER_ID, conn.id);
		expect(readSecret).toBe("immich-secret-key");

		const writeSecret = await getConnectionWriteSecret(USER_ID, conn.id);
		expect(writeSecret).toBe("write-scoped-key");

		expect(capturedApiKeyBody).toMatchObject({ name: "AlfyAI (album write)" });
		const permissions = (capturedApiKeyBody as { permissions: string[] })
			.permissions;
		expect(permissions).toEqual(
			expect.arrayContaining([
				"album.create",
				"albumAsset.create",
				"album.read",
			]),
		);
		for (const forbidden of [
			"all",
			"asset.delete",
			"asset.update",
			"asset.upload",
		]) {
			expect(permissions).not.toContain(forbidden);
		}
	});

	it("a 401 on re-login surfaces invalid_credentials with no password in the message, and stores nothing", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichEnableWrites, ImmichError } = await import("./immich");
		const { getConnectionWriteSecret } = await import("../store");

		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { message: "Invalid credentials" }),
		);

		try {
			await immichEnableWrites({
				userId: USER_ID,
				connectionId: conn.id,
				password: "wrong-pw",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected immichEnableWrites to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ImmichError);
			expect((err as InstanceType<typeof ImmichError>).code).toBe(
				"invalid_credentials",
			);
			expect((err as Error).message).not.toContain("wrong-pw");
		}
		expect(await getConnectionWriteSecret(USER_ID, conn.id)).toBeNull();
	});

	it("throws connection_not_found for an unknown connection id, without calling fetch", async () => {
		seedUser(USER_ID);
		const { immichEnableWrites, ImmichError } = await import("./immich");
		const fetchMock = vi.fn();

		try {
			await immichEnableWrites({
				userId: USER_ID,
				connectionId: "does-not-exist",
				password: "hunter2",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected immichEnableWrites to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ImmichError);
			expect((err as InstanceType<typeof ImmichError>).code).toBe(
				"connection_not_found",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// immichSmartSearch
// ---------------------------------------------------------------------------

describe("immichSmartSearch", () => {
	it("parses smart search results into PhotoResult[], mapping exif place/people and defaulting the rest", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichSmartSearch } = await import("./immich");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://photos.example.com/api/search/smart",
				);
				const headers = new Headers(init?.headers);
				expect(headers.get("x-api-key")).toBe("immich-secret-key");
				const body = JSON.parse(String(init?.body));
				expect(body).toEqual({ query: "beach", size: 20 });
				return jsonResponse(200, {
					assets: {
						items: [
							{
								id: "asset-1",
								originalFileName: "beach.jpg",
								fileCreatedAt: "2026-06-01T10:00:00.000Z",
								type: "IMAGE",
								exifInfo: {
									city: "Malibu",
									state: "California",
									country: "USA",
									description: "Sunset at the beach",
									dateTimeOriginal: "2026-06-01T09:55:00.000Z",
								},
								people: [{ name: "Alice" }, { name: "Bob" }],
							},
							{
								id: "asset-2",
								originalFileName: "bare.jpg",
								fileCreatedAt: "2026-05-01T00:00:00.000Z",
								type: "VIDEO",
							},
						],
					},
					albums: { items: [] },
				});
			},
		);

		const results = await immichSmartSearch(
			USER_ID,
			conn.id,
			{ query: "beach" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(results).toEqual([
			{
				id: "asset-1",
				fileName: "beach.jpg",
				takenAt: "2026-06-01T09:55:00.000Z",
				type: "IMAGE",
				place: "Malibu, California, USA",
				people: ["Alice", "Bob"],
				description: "Sunset at the beach",
				thumbnailPath: "/api/assets/asset-1/thumbnail",
			},
			{
				id: "asset-2",
				fileName: "bare.jpg",
				takenAt: "2026-05-01T00:00:00.000Z",
				type: "VIDEO",
				thumbnailPath: "/api/assets/asset-2/thumbnail",
			},
		]);
	});

	it("respects a custom limit and forwards it as `size`", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichSmartSearch } = await import("./immich");

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				expect(body.size).toBe(3);
				return jsonResponse(200, { assets: { items: [] } });
			},
		);

		await immichSmartSearch(
			USER_ID,
			conn.id,
			{ query: "beach", limit: 3 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
	});

	it("a 401 response is mapped to a typed needs_reauth error and marks the connection", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichSmartSearch } = await import("./immich");
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () => jsonResponse(401, { message: "no" }));

		await expect(
			immichSmartSearch(
				USER_ID,
				conn.id,
				{ query: "beach" },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: "needs_reauth" });

		const updated = await getConnection(USER_ID, conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});

	it("no api-key/password ever appears in a thrown error's message", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection({ apiKey: "top-secret-key" });
		const { immichSmartSearch } = await import("./immich");

		const fetchMock = vi.fn(async () => jsonResponse(500, { message: "boom" }));

		try {
			await immichSmartSearch(
				USER_ID,
				conn.id,
				{ query: "beach" },
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected immichSmartSearch to throw");
		} catch (err) {
			expect((err as Error).message).not.toContain("top-secret-key");
		}
	});
});

// ---------------------------------------------------------------------------
// immichThumbnail
// ---------------------------------------------------------------------------

describe("immichThumbnail", () => {
	it("fetches thumbnail bytes + content-type using the stored api key", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichThumbnail } = await import("./immich");

		const fakeBytes = new Uint8Array([1, 2, 3, 4]).buffer;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://photos.example.com/api/assets/asset-1/thumbnail",
				);
				const headers = new Headers(init?.headers);
				expect(headers.get("x-api-key")).toBe("immich-secret-key");
				return new Response(fakeBytes, {
					status: 200,
					headers: { "Content-Type": "image/jpeg" },
				});
			},
		);

		const result = await immichThumbnail(
			USER_ID,
			conn.id,
			{ assetId: "asset-1" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result.contentType).toBe("image/jpeg");
		expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
	});
});

// ---------------------------------------------------------------------------
// immichAdapter.checkHealth
// ---------------------------------------------------------------------------

describe("immichAdapter.checkHealth", () => {
	it("a successful authorized call -> connected", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichAdapter } = await import("./immich");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("https://photos.example.com/api/users/me");
				const headers = new Headers(init?.headers);
				expect(headers.get("x-api-key")).toBe("immich-secret-key");
				return jsonResponse(200, { id: "user-1", email: "alice@example.com" });
			},
		);

		const health = await immichAdapter.checkHealth("immich-secret-key", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(health.status).toBe("connected");
	});

	it("a 401 -> needs_reauth, with no key in the detail", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichAdapter } = await import("./immich");

		const fetchMock = vi.fn(async () => jsonResponse(401, { message: "no" }));

		const health = await immichAdapter.checkHealth("immich-secret-key", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(health.status).toBe("needs_reauth");
		expect(health.detail).not.toContain("immich-secret-key");
	});

	it("other failures -> error", async () => {
		seedUser(USER_ID);
		const conn = await seedImmichConnection();
		const { immichAdapter } = await import("./immich");

		const fetchMock = vi.fn(async () => {
			throw new Error("ETIMEDOUT");
		});

		const health = await immichAdapter.checkHealth("immich-secret-key", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(health.status).toBe("error");
	});
});
