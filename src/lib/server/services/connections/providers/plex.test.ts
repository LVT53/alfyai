import { generateKeyPairSync, randomUUID } from "node:crypto";
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

beforeEach(() => {
	dbPath = `${tmpdir()}/alfyai-test-connections-plex-${randomUUID()}.db`;
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

const device = {
	clientId: "test-plex-device",
	kid: "kid",
	privateKey: generateKeyPairSync("ed25519")
		.privateKey.export({ type: "pkcs8", format: "pem" })
		.toString(),
};
async function seedPlexConnection(
	overrides: {
		token?: string;
		accountId?: number | null;
		legacy?: boolean;
	} = {},
) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: USER_ID,
		provider: "plex",
		label: "Plex",
		accountIdentifier: "machine-abc",
		capabilities: ["media"],
		status: "connected",
		secret: overrides.legacy
			? "old-token"
			: JSON.stringify({
					device,
					tokenOrigin: SERVER_URL,
					serverToken: overrides.token ?? "plex-secret-token",
				}),
		config: {
			origin: SERVER_URL,
			machineIdentifier: "machine-abc",
			...(!overrides.legacy ? { linked: true } : {}),
			...(overrides.accountId !== null
				? { accountId: overrides.accountId ?? 1 }
				: {}),
		},
	});
}

// ---------------------------------------------------------------------------
// Hosted reconnect of a saved connection
// ---------------------------------------------------------------------------

it("upgrades an existing saved token in place when the same server is selected", async () => {
	seedUser(USER_ID);
	const existing = await seedPlexConnection({ legacy: true });
	const { getConnectionWithCredential, listConnectionsForUser } = await import(
		"../store"
	);
	const saved = await getConnectionWithCredential(USER_ID, existing.id);
	if (!saved?.credential) throw Error("Missing stored credential");
	const { connectLinkedPlex } = await import("./plex");
	const connection = await connectLinkedPlex({
		userId: USER_ID,
		device: { clientId: "client", kid: "kid", privateKey: "key" },
		accountToken: "account-token",
		server: {
			id: "machine-abc",
			name: "Personal library",
			owned: true,
			accessToken: "scoped",
			connections: [{ uri: SERVER_URL, local: false, relay: false }],
		},
		repair: { id: existing.id, version: saved.credential.version },
		fetch: async (input) =>
			String(input).endsWith("/identity")
				? jsonResponse(200, {
						MediaContainer: { machineIdentifier: "machine-abc" },
					})
				: jsonResponse(200, { MediaContainer: { Directory: [] } }),
	});
	expect(connection.id).toBe(existing.id);
	expect(connection.config).toMatchObject({ linked: true, accountId: 1 });
	expect(await listConnectionsForUser(USER_ID)).toHaveLength(1);
	const renewed = await getConnectionWithCredential(USER_ID, existing.id);
	expect(JSON.parse(renewed?.credential?.value ?? "null").serverToken).toBe(
		"scoped",
	);
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
			expect(decodeURIComponent(url)).toContain(
				`viewedAt>=${Math.floor(since.getTime() / 1000)}`,
			);
			return jsonResponse(200, { MediaContainer: { size: 0, Metadata: [] } });
		});

		await plexWatchHistory(
			USER_ID,
			conn.id,
			{ since: since.toISOString(), limit: 5 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
	});

	// Plex is moving toward REQUIRING X-Plex-Container-Size on every container
	// (paginated MediaContainer) request — currently just a deprecation
	// warning, but documented to eventually 400 without it. The header must
	// match the `limit=` query param exactly so the two can never drift apart;
	// -Start is always "0" since this call has no offset/pagination param.
	it("sends X-Plex-Container-Size/-Start matching the `limit` query param", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexWatchHistory } = await import("./plex");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				expect(url).toContain("limit=17");
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Container-Size")).toBe("17");
				expect(headers.get("X-Plex-Container-Start")).toBe("0");
				return jsonResponse(200, { MediaContainer: { size: 0, Metadata: [] } });
			},
		);

		await plexWatchHistory(
			USER_ID,
			conn.id,
			{ limit: 17 },
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
							accountID: 1,
						},
						{
							title: "Inception",
							type: "movie",
							viewedAt: 1750100000,
							accountID: 1,
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

	// Same deprecation-heading-toward-400 requirement as plexWatchHistory —
	// this call has no limit/offset param of its own, so the header carries a
	// fixed generous ceiling rather than one derived from a query param.
	it("sends X-Plex-Container-Size/-Start on the request", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySections } = await import("./plex");

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Container-Size")).toBeTruthy();
				expect(headers.get("X-Plex-Container-Start")).toBe("0");
				return jsonResponse(200, { MediaContainer: { Directory: [] } });
			},
		);

		await plexLibrarySections(USER_ID, conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
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
// GAP B2 — plexOnDeck (continue watching / up next)
// ---------------------------------------------------------------------------

describe("plexOnDeck", () => {
	it("parses onDeck Metadata into ContinueWatchingItem[], including derived progress", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexOnDeck } = await import("./plex");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				expect(url).toBe("https://plex.example.com/library/onDeck?limit=20");
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Token")).toBe("plex-secret-token");
				expect(headers.get("Accept")).toBe("application/json");
				return jsonResponse(200, {
					MediaContainer: {
						size: 2,
						Metadata: [
							{
								title: "Ozymandias",
								type: "episode",
								grandparentTitle: "Breaking Bad",
								parentIndex: 5,
								index: 14,
								viewOffset: 300000,
								duration: 1200000,
								librarySectionTitle: "TV Shows",
							},
							{
								title: "Inception",
								type: "movie",
								librarySectionTitle: "Movies",
							},
						],
					},
				});
			},
		);

		const results = await plexOnDeck(
			USER_ID,
			conn.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(results).toEqual([
			{
				title: "Ozymandias",
				show: "Breaking Bad",
				season: 5,
				episode: 14,
				type: "episode",
				viewOffsetMs: 300000,
				durationMs: 1200000,
				progress: 0.25,
				library: "TV Shows",
			},
			{
				title: "Inception",
				type: "movie",
				library: "Movies",
			},
		]);
	});

	// Unlike watch history (BUG1), on-deck reflects the requesting token's own
	// account viewstate already — there is no `accountID=` param to add.
	it("does not append accountID to the request even when the connection has one stored", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection({ accountId: 7 });
		const { plexOnDeck } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).not.toContain("accountID");
			return jsonResponse(200, { MediaContainer: { size: 0, Metadata: [] } });
		});

		await plexOnDeck(
			USER_ID,
			conn.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("clamps `limit` and sends matching X-Plex-Container-Size/-Start", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexOnDeck } = await import("./plex");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				expect(url).toContain("limit=100");
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Container-Size")).toBe("100");
				expect(headers.get("X-Plex-Container-Start")).toBe("0");
				return jsonResponse(200, { MediaContainer: { size: 0, Metadata: [] } });
			},
		);

		await plexOnDeck(
			USER_ID,
			conn.id,
			{ limit: 999 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
	});

	it("a 401 response maps to needs_reauth and marks the connection", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexOnDeck } = await import("./plex");

		const fetchMock = vi.fn(async () => jsonResponse(401, { error: "no" }));

		await expect(
			plexOnDeck(
				USER_ID,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: "needs_reauth" });
	});

	it("no token ever appears in a thrown error's message", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection({ token: "top-secret-token" });
		const { plexOnDeck } = await import("./plex");

		const fetchMock = vi.fn(async () => jsonResponse(500, { error: "boom" }));

		try {
			await plexOnDeck(
				USER_ID,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected plexOnDeck to throw");
		} catch (err) {
			expect((err as Error).message).not.toContain("top-secret-token");
		}
	});
});

// ---------------------------------------------------------------------------
// GAP B3 — plexLibrarySearch (owned catalog, distinct from watch history)
// ---------------------------------------------------------------------------

describe("plexLibrarySearch", () => {
	it("queries each library section's /all with title=<query> and aggregates matches + totalCount", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySearch } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/library/sections") {
				return jsonResponse(200, {
					MediaContainer: {
						Directory: [
							{ key: "1", title: "Movies", type: "movie" },
							{ key: "2", title: "TV Shows", type: "show" },
						],
					},
				});
			}
			if (
				url === "https://plex.example.com/library/sections/1/all?title=matrix"
			) {
				return jsonResponse(200, {
					MediaContainer: {
						size: 1,
						totalSize: 1,
						Metadata: [{ title: "The Matrix", type: "movie", year: 1999 }],
					},
				});
			}
			if (
				url === "https://plex.example.com/library/sections/2/all?title=matrix"
			) {
				return jsonResponse(200, {
					MediaContainer: { size: 0, totalSize: 0, Metadata: [] },
				});
			}
			throw new Error(`unexpected url ${url}`);
		});

		const result = await plexLibrarySearch(
			USER_ID,
			conn.id,
			{ query: "matrix" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({
			items: [
				{ title: "The Matrix", year: 1999, type: "movie", section: "Movies" },
			],
			totalCount: 1,
		});
	});

	it("does NOT match watch history — a title the user owns but never watched is still found via library_search", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySearch, plexWatchHistory } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/library/sections") {
				return jsonResponse(200, {
					MediaContainer: {
						Directory: [{ key: "1", title: "Movies", type: "movie" }],
					},
				});
			}
			if (
				url ===
				"https://plex.example.com/library/sections/1/all?title=unwatched%20gem"
			) {
				return jsonResponse(200, {
					MediaContainer: {
						size: 1,
						totalSize: 1,
						Metadata: [{ title: "Unwatched Gem", type: "movie", year: 2020 }],
					},
				});
			}
			// Watch history never saw this title.
			if (
				url.startsWith("https://plex.example.com/status/sessions/history/all")
			) {
				return jsonResponse(200, { MediaContainer: { size: 0, Metadata: [] } });
			}
			throw new Error(`unexpected url ${url}`);
		});

		const historyResults = await plexWatchHistory(
			USER_ID,
			conn.id,
			{ query: "unwatched gem" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(historyResults).toEqual([]);

		const librarySearchResult = await plexLibrarySearch(
			USER_ID,
			conn.id,
			{ query: "unwatched gem" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(librarySearchResult.items).toEqual([
			{ title: "Unwatched Gem", year: 2020, type: "movie", section: "Movies" },
		]);
		expect(librarySearchResult.totalCount).toBe(1);
	});

	it("an empty/omitted query lists (and counts) a section's whole contents, for 'how many X do I own'", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySearch } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/library/sections") {
				return jsonResponse(200, {
					MediaContainer: {
						Directory: [{ key: "1", title: "Movies", type: "movie" }],
					},
				});
			}
			if (url === "https://plex.example.com/library/sections/1/all") {
				return jsonResponse(200, {
					MediaContainer: {
						size: 2,
						totalSize: 142,
						Metadata: [
							{ title: "Alpha", type: "movie", year: 2001 },
							{ title: "Beta", type: "movie", year: 2002 },
						],
					},
				});
			}
			throw new Error(`unexpected url ${url}`);
		});

		const result = await plexLibrarySearch(
			USER_ID,
			conn.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result.totalCount).toBe(142);
		expect(result.items).toHaveLength(2);
	});

	it("caps returned items at `limit` while totalCount still reflects the true match count", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySearch } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/library/sections") {
				return jsonResponse(200, {
					MediaContainer: {
						Directory: [{ key: "1", title: "Movies", type: "movie" }],
					},
				});
			}
			return jsonResponse(200, {
				MediaContainer: {
					size: 5,
					totalSize: 5,
					Metadata: [
						{ title: "A", type: "movie" },
						{ title: "B", type: "movie" },
						{ title: "C", type: "movie" },
						{ title: "D", type: "movie" },
						{ title: "E", type: "movie" },
					],
				},
			});
		});

		const result = await plexLibrarySearch(
			USER_ID,
			conn.id,
			{ limit: 2 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result.items).toHaveLength(2);
		expect(result.totalCount).toBe(5);
	});

	it("sends X-Plex-Container-Size on each per-section request", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySearch } = await import("./plex");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://plex.example.com/library/sections") {
					return jsonResponse(200, {
						MediaContainer: {
							Directory: [{ key: "1", title: "Movies", type: "movie" }],
						},
					});
				}
				const headers = new Headers(init?.headers);
				expect(headers.get("X-Plex-Container-Size")).toBeTruthy();
				expect(headers.get("X-Plex-Container-Start")).toBe("0");
				return jsonResponse(200, { MediaContainer: { size: 0, Metadata: [] } });
			},
		);

		await plexLibrarySearch(
			USER_ID,
			conn.id,
			{ query: "x" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
	});

	it("skips a section whose /all request fails (non-401) without aborting the whole search", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySearch } = await import("./plex");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/library/sections") {
				return jsonResponse(200, {
					MediaContainer: {
						Directory: [
							{ key: "1", title: "Photos", type: "photo" },
							{ key: "2", title: "Movies", type: "movie" },
						],
					},
				});
			}
			if (url.startsWith("https://plex.example.com/library/sections/1/all")) {
				return jsonResponse(400, { error: "unsupported filter" });
			}
			return jsonResponse(200, {
				MediaContainer: {
					size: 1,
					totalSize: 1,
					Metadata: [{ title: "The Matrix", type: "movie", year: 1999 }],
				},
			});
		});

		const result = await plexLibrarySearch(
			USER_ID,
			conn.id,
			{ query: "matrix" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result.items).toEqual([
			{ title: "The Matrix", year: 1999, type: "movie", section: "Movies" },
		]);
		expect(result.totalCount).toBe(1);
	});

	it("a 401 on a section request maps to needs_reauth and marks the connection", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexLibrarySearch } = await import("./plex");
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://plex.example.com/library/sections") {
				return jsonResponse(200, {
					MediaContainer: {
						Directory: [{ key: "1", title: "Movies", type: "movie" }],
					},
				});
			}
			return jsonResponse(401, { error: "no" });
		});

		await expect(
			plexLibrarySearch(
				USER_ID,
				conn.id,
				{ query: "matrix" },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: "needs_reauth" });

		const updated = await getConnection(USER_ID, conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});

	it("no token ever appears in a thrown error's message", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection({ token: "top-secret-token" });
		const { plexLibrarySearch } = await import("./plex");

		const fetchMock = vi.fn(async () => jsonResponse(500, { error: "boom" }));

		try {
			await plexLibrarySearch(
				USER_ID,
				conn.id,
				{ query: "x" },
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected plexLibrarySearch to throw");
		} catch (err) {
			expect((err as Error).message).not.toContain("top-secret-token");
		}
	});
});

// ---------------------------------------------------------------------------
// plexAdapter.checkHealth
// ---------------------------------------------------------------------------

describe("plexAdapter.checkHealth", () => {
	it("requires hosted sign-in for a legacy connection without contacting its saved server", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection({ legacy: true });
		const { plexAdapter } = await import("./plex");
		const fetch = vi.fn<typeof globalThis.fetch>();
		const result = await plexAdapter.checkHealth("old-token", conn, { fetch });
		expect(result.status).toBe("needs_reauth");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not query household history from a shared linked connection", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection({ accountId: null });
		const { plexWatchHistory } = await import("./plex");
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(
			plexWatchHistory(USER_ID, conn.id, {}, { fetch }),
		).rejects.toMatchObject({ code: "history_unavailable" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("a successful library read -> connected", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexAdapter } = await import("./plex");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("https://plex.example.com/library/sections");
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

it("searches tracks by title inside enabled music sections with artist and album attribution", async () => {
	seedUser(USER_ID);
	const conn = await seedPlexConnection();
	const { plexLibrarySearch } = await import("./plex");
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (url.pathname === "/library/sections")
			return jsonResponse(200, {
				MediaContainer: {
					Directory: [
						{ key: "1", title: "Films", type: "movie" },
						{ key: "3", title: "Music", type: "artist" },
					],
				},
			});
		expect(url.pathname).toBe("/library/sections/3/all");
		expect(url.searchParams.get("type")).toBe("10");
		expect(url.searchParams.get("title")).toBe("Home");
		return jsonResponse(200, {
			MediaContainer: {
				Metadata: [
					{
						type: "track",
						title: "Home",
						grandparentTitle: "Alex",
						parentTitle: "Live",
						ratingKey: "27",
						file: "/private/stuff",
					},
				],
			},
		});
	});
	const result = await plexLibrarySearch(
		USER_ID,
		conn.id,
		{ type: "track", query: "Home" },
		{ fetch },
	);
	expect(result.items).toEqual([
		{
			id: "27",
			type: "track",
			title: "Home",
			artist: "Alex",
			album: "Live",
			section: "Music",
		},
	]);
});

describe("Plex catalog browsing", () => {
	const directory = [
		{ key: "1", title: "Films", type: "movie" },
		{ key: "2", title: "TV", type: "show" },
		{ key: "3", title: "Music", type: "artist" },
		{ key: "4", title: "More Music", type: "artist" },
	];
	const album = {
		type: "album",
		title: "Live",
		ratingKey: "12",
		librarySectionTitle: "Music",
		parentTitle: "Alex",
	};
	const movie = {
		type: "movie",
		title: "Hidden Film",
		ratingKey: "31",
		librarySectionTitle: "Films",
	};
	function catalogFetch(routes: Record<string, Record<string, unknown>>) {
		return vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const data =
				url.pathname === "/library/sections"
					? { Directory: directory }
					: routes[url.pathname + url.search];
			return data
				? jsonResponse(200, { MediaContainer: data })
				: jsonResponse(404, {});
		});
	}
	it("preserves disc/track order and uses only the requested window after checking album access", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexBrowseCatalog } = await import("./plex");
		const fetch = catalogFetch({
			"/library/metadata/12": { Metadata: [album] },
			"/library/metadata/12/children": {
				totalSize: 30,
				Metadata: [
					{ title: "Overture", type: "track", parentIndex: 2, index: 1 },
					{ title: "Finale", type: "track", parentIndex: 2, index: 2 },
				],
			},
		});
		const result = await plexBrowseCatalog(
			USER_ID,
			conn.id,
			{ operation: "children", id: "12", offset: 15, limit: 2 },
			{ fetch },
		);
		expect(result.totalCount).toBe(30);
		expect(
			result.items.map((item) => [item.title, item.disc, item.track]),
		).toEqual([
			["Overture", 2, 1],
			["Finale", 2, 2],
		]);
		expect(
			new Headers(
				(fetch.mock.calls as unknown as [string, RequestInit][])[1][1].headers,
			).get("X-Plex-Container-Start"),
		).toBe("15");
	});
	it("reads catalogue metadata and track languages while excluding playback history, keys and filesystem paths", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexBrowseCatalog } = await import("./plex");
		const fetch = catalogFetch({
			"/library/metadata/31": {
				Metadata: [
					{
						...movie,
						Genre: [{ tag: "Comedy" }],
						viewCount: 12345,
						Media: [
							{
								videoResolution: "4k",
								Part: [
									{
										file: "/secret/path",
										Stream: [
											{
												streamType: 3,
												language: "Hungarian",
												key: "/secret/key",
											},
										],
									},
								],
							},
						],
					},
				],
			},
		});
		const result = await plexBrowseCatalog(
			USER_ID,
			conn.id,
			{ operation: "details", id: "31" },
			{ fetch },
		);
		expect(result.items[0]?.metadata).toEqual({
			Genre: ["Comedy"],
			videoResolution: "4k",
			languages: ["Subtitles: Hungarian"],
		});
		expect(JSON.stringify(result)).not.toMatch(/secret|12345/);
	});
	it("merges recently added albums from multiple music sections by added date, before applying the limit and offset", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { plexBrowseCatalog } = await import("./plex");
		const fetch = catalogFetch({
			"/library/sections/3/all?type=9&sort=addedAt%3Adesc": {
				Metadata: [
					{ ...album, title: "Third", addedAt: 1 },
					{ ...album, title: "Fourth", addedAt: 0 },
				],
			},
			"/library/sections/4/all?type=9&sort=addedAt%3Adesc": {
				Metadata: [
					{ ...album, title: "First", addedAt: 3 },
					{ ...album, title: "Second", addedAt: 2 },
				],
			},
		});
		const result = await plexBrowseCatalog(
			USER_ID,
			conn.id,
			{ operation: "recent", offset: 1, limit: 2 },
			{ fetch },
		);
		expect(result.items.map((item) => item.title)).toEqual(["Second", "Third"]);
		expect(result.totalCount).toBe(4);
		await expect(
			plexBrowseCatalog(
				USER_ID,
				conn.id,
				{ operation: "recent", offset: 1001 },
				{ fetch },
			),
		).rejects.toMatchObject({ code: "invalid_config" });
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it("blocks disabled category search, direct-ID children, extras, and mixed video playlist lookup", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { setEnabledCapabilities } = await import("../store");
		await setEnabledCapabilities(USER_ID, conn.id, ["media", "music", "tv"]);
		const { plexBrowseCatalog, plexLibrarySearch, plexLibrarySections } =
			await import("./plex");
		const fetch = catalogFetch({
			"/library/metadata/31": { Metadata: [movie] },
			"/playlists/7": {
				Metadata: [
					{
						type: "playlist",
						playlistType: "video",
						title: "Sensitive mixed videos",
					},
				],
			},
			"/playlists?playlistType=audio": {
				Metadata: [
					{
						ratingKey: "8",
						type: "playlist",
						playlistType: "audio",
						title: "Road music",
					},
				],
			},
		});
		const empty = { items: [], totalCount: 0 };
		expect(
			await plexLibrarySearch(USER_ID, conn.id, { type: "movie" }, { fetch }),
		).toEqual(empty);
		expect(fetch).not.toHaveBeenCalled();
		for (const operation of ["details", "children", "extras"] as const)
			expect(
				await plexBrowseCatalog(
					USER_ID,
					conn.id,
					{ operation, id: "31" },
					{ fetch },
				),
			).toEqual(empty);
		expect(
			await plexBrowseCatalog(
				USER_ID,
				conn.id,
				{ operation: "playlist_items", id: "7" },
				{ fetch },
			),
		).toEqual(empty);
		const lists = await plexBrowseCatalog(
			USER_ID,
			conn.id,
			{ operation: "playlists" },
			{ fetch },
		);
		expect(lists.items.map((p) => p.title)).toEqual(["Road music"]);
		expect(
			await plexLibrarySections(USER_ID, conn.id, { fetch }),
		).not.toContainEqual({ type: "movie", title: "Films" });
		expect(fetch.mock.calls.map(([url]) => String(url))).not.toContainEqual(
			expect.stringMatching(/\/31\/|\/7\/items|playlistType=video/),
		);
	});
	it("reads playlist tracks in order and filters disabled content from both rows and count", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { setEnabledCapabilities } = await import("../store");
		await setEnabledCapabilities(USER_ID, conn.id, ["media", "music"]);
		const { plexBrowseCatalog } = await import("./plex");
		const fetch = catalogFetch({
			"/playlists/7": {
				Metadata: [
					{ type: "playlist", playlistType: "audio", title: "Cycling" },
				],
			},
			"/playlists/7/items": {
				totalSize: 9,
				Metadata: [
					{ type: "track", title: "Three" },
					movie,
					{ type: "track", title: "One" },
				],
			},
		});
		const result = await plexBrowseCatalog(
			USER_ID,
			conn.id,
			{ operation: "playlist_items", id: "7" },
			{ fetch },
		);
		expect(result.items.map((row) => row.title)).toEqual(["Three", "One"]);
		expect(result.totalCount).toBe(2);
	});
	it("uses only enabled history sections, enforcing type and account again on Plex's response", async () => {
		seedUser(USER_ID);
		const conn = await seedPlexConnection();
		const { setEnabledCapabilities } = await import("../store");
		await setEnabledCapabilities(USER_ID, conn.id, ["media", "music"]);
		const { plexWatchHistory } = await import("./plex");
		const entry = {
			type: "track",
			title: "One",
			grandparentTitle: "Alex",
			parentTitle: "Live",
			viewedAt: 1200,
			accountID: 1,
		};
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.pathname === "/library/sections")
				return jsonResponse(200, { MediaContainer: { Directory: directory } });
			expect(["3", "4"]).toContain(url.searchParams.get("librarySectionID"));
			expect(url.searchParams.get("accountID")).toBe("1");
			return jsonResponse(200, {
				MediaContainer: {
					Metadata:
						url.searchParams.get("librarySectionID") === "3"
							? [entry, { ...entry, type: "movie" }, { ...entry, accountID: 2 }]
							: [],
				},
			});
		});
		const rows = await plexWatchHistory(
			USER_ID,
			conn.id,
			{ type: "track" },
			{ fetch },
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			title: "One",
			artist: "Alex",
			album: "Live",
		});
	});
});
