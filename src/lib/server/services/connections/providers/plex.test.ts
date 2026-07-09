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
	dbPath = `./data/test-connections-plex-${randomUUID()}.db`;
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
const SERVER_URL = "https://plex.example.com";

async function seedPlexConnection(
	overrides: { token?: string; accountId?: number } = {},
) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: USER_ID,
		provider: "plex",
		label: "Plex",
		accountIdentifier: "machine-abc",
		capabilities: ["media"],
		status: "connected",
		secret: overrides.token ?? "plex-secret-token",
		config: {
			origin: SERVER_URL,
			machineIdentifier: "machine-abc",
			...(overrides.accountId !== undefined
				? { accountId: overrides.accountId }
				: {}),
		},
	});
}

// ---------------------------------------------------------------------------
// plexConnect
// ---------------------------------------------------------------------------

describe("plexConnect", () => {
	it("validates the token against /identity and stores it (never plaintext-logged) with a normalized origin", async () => {
		seedUser(USER_ID);
		const { plexConnect } = await import("./plex");
		const { getConnectionSecret } = await import("../store");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Token")).toBe("token-abc");
				expect(headers.get("Accept")).toBe("application/json");
				if (url === "https://plex.example.com/identity") {
					return jsonResponse(200, {
						MediaContainer: {
							machineIdentifier: "machine-abc",
							version: "1.32.0",
						},
					});
				}
				if (url === "https://plex.example.com/accounts") {
					return jsonResponse(200, {
						MediaContainer: {
							size: 1,
							Account: [{ id: 1, name: "token-owner" }],
						},
					});
				}
				throw new Error(`unexpected url ${url}`);
			},
		);

		const { connection } = await plexConnect({
			userId: USER_ID,
			serverUrl: "https://plex.example.com/",
			token: "token-abc",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.provider).toBe("plex");
		expect(connection.accountIdentifier).toBe("machine-abc");
		expect(connection.capabilities).toEqual(["media"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);
		expect(connection.config).toEqual({
			origin: "https://plex.example.com",
			machineIdentifier: "machine-abc",
			accountId: 1,
		});

		// The raw token must never appear anywhere in the stored/serialized DTO.
		expect(JSON.stringify(connection)).not.toContain("token-abc");

		const decrypted = await getConnectionSecret(USER_ID, connection.id);
		expect(decrypted).toBe("token-abc");
	});

	it("rejects a non-http(s) server URL as invalid_config without ever calling fetch", async () => {
		seedUser(USER_ID);
		const { plexConnect, PlexError } = await import("./plex");
		const fetchMock = vi.fn();

		try {
			await plexConnect({
				userId: USER_ID,
				serverUrl: "ftp://plex.example.com",
				token: "token-abc",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected plexConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(PlexError);
			expect((err as InstanceType<typeof PlexError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["a plain http:// URL", "http://plex.example.com"],
		["a loopback IPv4 host", "https://127.0.0.1:32400"],
		["a private RFC1918 host", "https://192.168.1.10:32400"],
		["the cloud metadata address", "https://169.254.169.254/latest"],
		["a loopback IPv6 host", "https://[::1]:32400"],
	])("rejects %s as invalid_config without ever calling fetch (SSRF guard)", async (_label, serverUrl) => {
		seedUser(USER_ID);
		const { plexConnect, PlexError } = await import("./plex");
		const fetchMock = vi.fn();

		try {
			await plexConnect({
				userId: USER_ID,
				serverUrl,
				token: "token-abc",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected plexConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(PlexError);
			expect((err as InstanceType<typeof PlexError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a 401 on /identity surfaces a clear invalid_token error with no token in the message", async () => {
		seedUser(USER_ID);
		const { plexConnect, PlexError } = await import("./plex");

		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { error: "Unauthorized" }),
		);

		try {
			await plexConnect({
				userId: USER_ID,
				serverUrl: SERVER_URL,
				token: "wrong-token",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected plexConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(PlexError);
			expect((err as InstanceType<typeof PlexError>).code).toBe(
				"invalid_token",
			);
			expect((err as Error).message).not.toContain("wrong-token");
			expect((err as Error).message.toLowerCase()).toContain("invalid");
		}
	});

	it("requires a non-empty token without ever calling fetch", async () => {
		seedUser(USER_ID);
		const { plexConnect, PlexError } = await import("./plex");
		const fetchMock = vi.fn();

		try {
			await plexConnect({
				userId: USER_ID,
				serverUrl: SERVER_URL,
				token: "   ",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected plexConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(PlexError);
			expect((err as InstanceType<typeof PlexError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// BUG 1 (privacy) — the token owner's Plex accountID must be resolved and
	// stored at connect time so watch-history reads can be scoped to it (see
	// the `plexWatchHistory` "BUG1" test below for the read-side half).
	// -------------------------------------------------------------------------

	it("BUG1: resolves and stores the token's accountID from /accounts when it's the only account visible", async () => {
		seedUser(USER_ID);
		const { plexConnect } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/identity") {
				return jsonResponse(200, {
					MediaContainer: { machineIdentifier: "machine-abc" },
				});
			}
			if (url === "https://plex.example.com/accounts") {
				return jsonResponse(200, {
					MediaContainer: {
						size: 1,
						Account: [{ id: 5, name: "solo-user" }],
					},
				});
			}
			throw new Error(`unexpected url ${url}`);
		});

		const { connection } = await plexConnect({
			userId: USER_ID,
			serverUrl: SERVER_URL,
			token: "token-abc",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.config).toEqual({
			origin: "https://plex.example.com",
			machineIdentifier: "machine-abc",
			accountId: 5,
		});
	});

	it("BUG1: resolves the owner (accountID 1) from /accounts when the token can see every household account", async () => {
		seedUser(USER_ID);
		const { plexConnect } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/identity") {
				return jsonResponse(200, {
					MediaContainer: { machineIdentifier: "machine-abc" },
				});
			}
			if (url === "https://plex.example.com/accounts") {
				return jsonResponse(200, {
					MediaContainer: {
						size: 3,
						Account: [
							{ id: 0, name: "" },
							{ id: 1, name: "owner" },
							{ id: 9, name: "kid" },
						],
					},
				});
			}
			throw new Error(`unexpected url ${url}`);
		});

		const { connection } = await plexConnect({
			userId: USER_ID,
			serverUrl: SERVER_URL,
			token: "token-abc",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.config.accountId).toBe(1);
	});

	it("BUG1: still connects (without an accountID) when /accounts can't be resolved", async () => {
		seedUser(USER_ID);
		const { plexConnect } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/identity") {
				return jsonResponse(200, {
					MediaContainer: { machineIdentifier: "machine-abc" },
				});
			}
			if (url === "https://plex.example.com/accounts") {
				return jsonResponse(500, { error: "boom" });
			}
			throw new Error(`unexpected url ${url}`);
		});

		const { connection } = await plexConnect({
			userId: USER_ID,
			serverUrl: SERVER_URL,
			token: "token-abc",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.status).toBe("connected");
		expect(connection.config.accountId).toBeUndefined();
	});

	it("re-connecting the same server (same machineIdentifier) updates (not duplicates) the connection and refreshes the stored token", async () => {
		seedUser(USER_ID);
		const { plexConnect } = await import("./plex");
		const { listConnectionsForUser, getConnectionSecret } = await import(
			"../store"
		);

		const makeFetch = () =>
			vi.fn(async () =>
				jsonResponse(200, {
					MediaContainer: { machineIdentifier: "machine-abc" },
				}),
			);

		const first = await plexConnect({
			userId: USER_ID,
			serverUrl: SERVER_URL,
			token: "first-token",
			fetch: makeFetch() as unknown as typeof fetch,
		});
		const second = await plexConnect({
			userId: USER_ID,
			serverUrl: SERVER_URL,
			token: "second-token",
			fetch: makeFetch() as unknown as typeof fetch,
		});

		expect(second.connection.id).toBe(first.connection.id);
		const rows = await listConnectionsForUser(USER_ID);
		expect(rows).toHaveLength(1);
		const decrypted = await getConnectionSecret(USER_ID, second.connection.id);
		expect(decrypted).toBe("second-token");
	});
});

// ---------------------------------------------------------------------------
// plexWatchHistory
// ---------------------------------------------------------------------------

describe("plexWatchHistory", () => {
	it("parses history Metadata into WatchEntry[], mapping episode + movie shapes", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexWatchHistory } = await import("./plex");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				expect(url).toContain(
					"https://plex.example.com/status/sessions/history/all",
				);
				expect(url).toContain("sort=viewedAt:desc");
				expect(url).toContain("limit=50");
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Token")).toBe("plex-secret-token");
				expect(headers.get("Accept")).toBe("application/json");
				return jsonResponse(200, {
					MediaContainer: {
						size: 2,
						Metadata: [
							{
								title: "Pilot",
								type: "episode",
								grandparentTitle: "Breaking Bad",
								parentTitle: "Season 1",
								index: 1,
								parentIndex: 1,
								viewedAt: 1750000000,
								accountID: 1,
								librarySectionTitle: "TV Shows",
							},
							{
								title: "Inception",
								type: "movie",
								viewedAt: 1750100000,
								accountID: 1,
								librarySectionTitle: "Movies",
							},
						],
					},
				});
			},
		);

		const results = await plexWatchHistory(
			USER_ID,
			conn.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(results).toEqual([
			{
				title: "Pilot",
				show: "Breaking Bad",
				season: 1,
				episode: 1,
				type: "episode",
				viewedAt: new Date(1750000000 * 1000).toISOString(),
				library: "TV Shows",
			},
			{
				title: "Inception",
				type: "movie",
				viewedAt: new Date(1750100000 * 1000).toISOString(),
				library: "Movies",
			},
		]);
	});

	it("BUG1 (privacy): scopes the history request to the connection's stored owner accountID so a household admin token doesn't ship every user's history", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection({ accountId: 7 });
		const { plexWatchHistory } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("accountID=7");
			return jsonResponse(200, {
				MediaContainer: {
					size: 2,
					Metadata: [
						{
							title: "Owner's Movie",
							type: "movie",
							viewedAt: 1750000000,
							accountID: 7,
						},
						{
							title: "Kid's Show",
							type: "episode",
							viewedAt: 1750000100,
							accountID: 9,
						},
					],
				},
			});
		});

		await plexWatchHistory(
			USER_ID,
			conn.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("applies `since` and `limit` to the request", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexWatchHistory } = await import("./plex");

		const since = new Date("2026-01-01T00:00:00.000Z");
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("limit=5");
			expect(url).toContain(`viewedAt>=${Math.floor(since.getTime() / 1000)}`);
			return jsonResponse(200, { MediaContainer: { size: 0, Metadata: [] } });
		});

		await plexWatchHistory(
			USER_ID,
			conn.id,
			{ since: since.toISOString(), limit: 5 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
	});

	it("filters client-side on `query` against title/show (case-insensitive)", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexWatchHistory } = await import("./plex");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, {
				MediaContainer: {
					size: 2,
					Metadata: [
						{
							title: "Pilot",
							type: "episode",
							grandparentTitle: "Breaking Bad",
							viewedAt: 1750000000,
						},
						{
							title: "Inception",
							type: "movie",
							viewedAt: 1750100000,
						},
					],
				},
			}),
		);

		const results = await plexWatchHistory(
			USER_ID,
			conn.id,
			{ query: "breaking" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(results).toHaveLength(1);
		expect(results[0]?.title).toBe("Pilot");
	});

	it("a 401 response is mapped to a typed needs_reauth error and marks the connection", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexWatchHistory } = await import("./plex");
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () => jsonResponse(401, { error: "no" }));

		await expect(
			plexWatchHistory(
				USER_ID,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: "needs_reauth" });

		const updated = await getConnection(USER_ID, conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});

	it("no token ever appears in a thrown error's message", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection({ token: "top-secret-token" });
		const { plexWatchHistory } = await import("./plex");

		const fetchMock = vi.fn(async () => jsonResponse(500, { error: "boom" }));

		try {
			await plexWatchHistory(
				USER_ID,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected plexWatchHistory to throw");
		} catch (err) {
			expect((err as Error).message).not.toContain("top-secret-token");
		}
	});
});

// ---------------------------------------------------------------------------
// plexLibrarySections
// ---------------------------------------------------------------------------

describe("plexLibrarySections", () => {
	it("parses library sections", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySections } = await import("./plex");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("https://plex.example.com/library/sections");
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Token")).toBe("plex-secret-token");
				return jsonResponse(200, {
					MediaContainer: {
						Directory: [
							{ key: "1", title: "Movies", type: "movie" },
							{ key: "2", title: "TV Shows", type: "show" },
						],
					},
				});
			},
		);

		const sections = await plexLibrarySections(USER_ID, conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(sections).toEqual([
			{ title: "Movies", type: "movie" },
			{ title: "TV Shows", type: "show" },
		]);
	});

	it("a 401 response maps to needs_reauth", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySections } = await import("./plex");

		const fetchMock = vi.fn(async () => jsonResponse(401, { error: "no" }));

		await expect(
			plexLibrarySections(USER_ID, conn.id, {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({ code: "needs_reauth" });
	});
});

// ---------------------------------------------------------------------------
// plexAdapter.checkHealth
// ---------------------------------------------------------------------------

describe("plexAdapter.checkHealth", () => {
	it("a successful /identity call -> connected", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexAdapter } = await import("./plex");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("https://plex.example.com/identity");
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Token")).toBe("plex-secret-token");
				return jsonResponse(200, {
					MediaContainer: { machineIdentifier: "machine-abc" },
				});
			},
		);

		const health = await plexAdapter.checkHealth("plex-secret-token", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(health.status).toBe("connected");
	});

	it("a 401 -> needs_reauth, with no token in the detail", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexAdapter } = await import("./plex");

		const fetchMock = vi.fn(async () => jsonResponse(401, { error: "no" }));

		const health = await plexAdapter.checkHealth("plex-secret-token", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(health.status).toBe("needs_reauth");
		expect(health.detail).not.toContain("plex-secret-token");
	});

	it("other failures -> error", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexAdapter } = await import("./plex");

		const fetchMock = vi.fn(async () => {
			throw new Error("ETIMEDOUT");
		});

		const health = await plexAdapter.checkHealth("plex-secret-token", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(health.status).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// No write path exists
// ---------------------------------------------------------------------------

describe("plex module surface — no write path", () => {
	it("exports only connect/read functions and the adapter, never a write function", async () => {
		const mod = await import("./plex");
		const exportedNames = Object.keys(mod);
		const writeLikeNames = exportedNames.filter((name) =>
			/write|create|update|delete|upload|scrobble|markWatched|markPlayed/i.test(
				name,
			),
		);
		expect(writeLikeNames).toEqual([]);
	});
});
