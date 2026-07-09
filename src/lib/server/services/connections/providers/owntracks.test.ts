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
	"OWNTRACKS_RECORDER_URL",
	"OWNTRACKS_RECORDER_USER",
	"OWNTRACKS_RECORDER_PASS",
];

function setConfiguredEnv(url = "http://127.0.0.1:8083") {
	process.env.OWNTRACKS_RECORDER_URL = url;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	vi.resetModules();
	for (const key of ENV_KEYS) delete process.env[key];

	dbPath = `./data/test-connections-owntracks-${randomUUID()}.db`;
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

const USER_A = "userA";
const USER_B = "userB";

// ---------------------------------------------------------------------------
// Admin config gate — not_configured, no fetch
// ---------------------------------------------------------------------------

describe("config: OWNTRACKS_RECORDER_URL unset", () => {
	it("owntracksListDevices throws a typed not_configured error without ever calling fetch", async () => {
		seedUser(USER_A);
		const { owntracksListDevices, OwnTracksError } = await import(
			"./owntracks"
		);
		const fetchMock = vi.fn();

		await expect(
			owntracksListDevices(USER_A, {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(OwnTracksError);
		await expect(
			owntracksListDevices(USER_A, {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({ code: "not_configured" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("owntracksConnect throws a typed not_configured error without ever calling fetch", async () => {
		seedUser(USER_A);
		const { owntracksConnect, OwnTracksError } = await import("./owntracks");
		const fetchMock = vi.fn();

		await expect(
			owntracksConnect({
				userId: USER_A,
				otUser: "alice",
				otDevice: "phone",
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(OwnTracksError);
		await expect(
			owntracksConnect({
				userId: USER_A,
				otUser: "alice",
				otDevice: "phone",
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({ code: "not_configured" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// owntracksListDevices
// ---------------------------------------------------------------------------

describe("owntracksListDevices", () => {
	it("flattens /list (users) + per-user /list?user= into (otUser, otDevice) pairs", async () => {
		seedUser(USER_A);
		setConfiguredEnv();
		const { owntracksListDevices } = await import("./owntracks");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "http://127.0.0.1:8083/api/0/list") {
				return jsonResponse(200, { results: ["alice", "bob"] });
			}
			if (url === "http://127.0.0.1:8083/api/0/list?user=alice") {
				return jsonResponse(200, { results: ["phone", "watch"] });
			}
			if (url === "http://127.0.0.1:8083/api/0/list?user=bob") {
				return jsonResponse(200, { results: ["tablet"] });
			}
			throw new Error(`unexpected url ${url}`);
		});

		const pairs = await owntracksListDevices(USER_A, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(pairs).toEqual([
			{ otUser: "alice", otDevice: "phone" },
			{ otUser: "alice", otDevice: "watch" },
			{ otUser: "bob", otDevice: "tablet" },
		]);
	});
});

// ---------------------------------------------------------------------------
// owntracksConnect
// ---------------------------------------------------------------------------

describe("owntracksConnect", () => {
	it("stores config {otUser, otDevice}, an accountIdentifier, capability 'location', and no secret", async () => {
		seedUser(USER_A);
		setConfiguredEnv();
		const { owntracksConnect } = await import("./owntracks");

		const { connection } = await owntracksConnect({
			userId: USER_A,
			otUser: "alice",
			otDevice: "phone",
		});

		expect(connection.provider).toBe("owntracks");
		expect(connection.accountIdentifier).toBe("alice/phone");
		expect(connection.capabilities).toEqual(["location"]);
		expect(connection.status).toBe("connected");
		expect(connection.config).toEqual({ otUser: "alice", otDevice: "phone" });
		expect(connection.hasSecret).toBe(false);
		expect("secret" in connection).toBe(false);
	});

	it("rejects empty otUser/otDevice as invalid_config", async () => {
		seedUser(USER_A);
		setConfiguredEnv();
		const { owntracksConnect } = await import("./owntracks");

		await expect(
			owntracksConnect({ userId: USER_A, otUser: "  ", otDevice: "phone" }),
		).rejects.toMatchObject({ code: "invalid_config" });
		await expect(
			owntracksConnect({ userId: USER_A, otUser: "alice", otDevice: "" }),
		).rejects.toMatchObject({ code: "invalid_config" });
	});

	it("re-connecting the same (otUser, otDevice) updates (not duplicates) the connection", async () => {
		seedUser(USER_A);
		setConfiguredEnv();
		const { owntracksConnect } = await import("./owntracks");
		const { listConnectionsForUser } = await import("../store");

		const first = await owntracksConnect({
			userId: USER_A,
			otUser: "alice",
			otDevice: "phone",
			label: "My Phone",
		});
		const second = await owntracksConnect({
			userId: USER_A,
			otUser: "alice",
			otDevice: "phone",
			label: "My Phone (again)",
		});

		expect(second.connection.id).toBe(first.connection.id);
		const rows = await listConnectionsForUser(USER_A);
		expect(rows).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// ISOLATION — the critical property of this whole module.
// ---------------------------------------------------------------------------

describe("ISOLATION — per-user device isolation", () => {
	it("userA can read their own device, but reading userB's connection returns null and never hits the recorder for userB's device", async () => {
		seedUser(USER_A);
		seedUser(USER_B);
		setConfiguredEnv();
		const { owntracksConnect, owntracksLastLocation } = await import(
			"./owntracks"
		);

		const { connection: connA } = await owntracksConnect({
			userId: USER_A,
			otUser: "alice_ot",
			otDevice: "devA",
		});
		const { connection: connB } = await owntracksConnect({
			userId: USER_B,
			otUser: "bob_ot",
			otDevice: "devB",
		});

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("user=alice_ot");
			expect(url).toContain("device=devA");
			return jsonResponse(200, [
				{ lat: 1.1, lon: 2.2, tst: 1750000000, addr: "Home" },
			]);
		});

		const fixA = await owntracksLastLocation(USER_A, connA.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(fixA).toEqual({
			lat: 1.1,
			lon: 2.2,
			at: new Date(1750000000 * 1000).toISOString(),
			place: "Home",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// userA attempts to read userB's connection. This must resolve to
		// nothing and must NOT touch the recorder at all — there is no code
		// path in this module that lets a caller supply otUser/otDevice
		// directly, so the only way to reach userB's device would be through
		// this connectionId, and the connection store's userId-scoped WHERE
		// clause refuses to return a row that isn't userA's.
		fetchMock.mockClear();
		const fixCrossUser = await owntracksLastLocation(USER_A, connB.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(fixCrossUser).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();

		// Sanity: userB really does own connB and can read their own device.
		fetchMock.mockClear();
		const fetchMockB = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("user=bob_ot");
			expect(url).toContain("device=devB");
			return jsonResponse(200, [{ lat: 9.9, lon: 8.8, tst: 1750000001 }]);
		});
		const fixB = await owntracksLastLocation(USER_B, connB.id, {
			fetch: fetchMockB as unknown as typeof fetch,
		});
		expect(fixB?.lat).toBe(9.9);
	});

	it("owntracksLocationHistory also refuses a connectionId the caller doesn't own, without ever fetching", async () => {
		seedUser(USER_A);
		seedUser(USER_B);
		setConfiguredEnv();
		const { owntracksConnect, owntracksLocationHistory } = await import(
			"./owntracks"
		);

		const { connection: connB } = await owntracksConnect({
			userId: USER_B,
			otUser: "bob_ot",
			otDevice: "devB",
		});

		const fetchMock = vi.fn();
		const history = await owntracksLocationHistory(
			USER_A,
			connB.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(history).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a nonexistent connectionId returns null/empty without ever fetching", async () => {
		seedUser(USER_A);
		setConfiguredEnv();
		const { owntracksLastLocation, owntracksLocationHistory } = await import(
			"./owntracks"
		);
		const fetchMock = vi.fn();

		expect(
			await owntracksLastLocation(USER_A, "does-not-exist", {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).toBeNull();
		expect(
			await owntracksLocationHistory(
				USER_A,
				"does-not-exist",
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// owntracksLastLocation
// ---------------------------------------------------------------------------

describe("owntracksLastLocation", () => {
	async function seedConn() {
		setConfiguredEnv();
		const { owntracksConnect } = await import("./owntracks");
		const { connection } = await owntracksConnect({
			userId: USER_A,
			otUser: "alice_ot",
			otDevice: "devA",
		});
		return connection;
	}

	it("maps the first Position to a LocationFix (addr -> place)", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLastLocation } = await import("./owntracks");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, [
				{ lat: 47.5, lon: 19.05, tst: 1751000000, addr: "Budapest", batt: 88 },
			]),
		);

		const fix = await owntracksLastLocation(USER_A, conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(fix).toEqual({
			lat: 47.5,
			lon: 19.05,
			at: new Date(1751000000 * 1000).toISOString(),
			place: "Budapest",
			battery: 88,
		});
	});

	it("an empty array response maps to null", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLastLocation } = await import("./owntracks");

		const fetchMock = vi.fn(async () => jsonResponse(200, []));

		const fix = await owntracksLastLocation(USER_A, conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(fix).toBeNull();
	});

	it("a recorder 5xx throws a typed request_failed error and marks the connection status error", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLastLocation, OwnTracksError } = await import(
			"./owntracks"
		);
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () => jsonResponse(500, { error: "boom" }));

		await expect(
			owntracksLastLocation(USER_A, conn.id, {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(OwnTracksError);

		const updated = await getConnection(USER_A, conn.id);
		expect(updated?.status).toBe("error");
	});

	it("a network failure throws a typed request_failed error", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLastLocation, OwnTracksError } = await import(
			"./owntracks"
		);

		const fetchMock = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});

		await expect(
			owntracksLastLocation(USER_A, conn.id, {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(OwnTracksError);
	});
});

// ---------------------------------------------------------------------------
// owntracksLocationHistory
// ---------------------------------------------------------------------------

describe("owntracksLocationHistory", () => {
	async function seedConn() {
		setConfiguredEnv();
		const { owntracksConnect } = await import("./owntracks");
		const { connection } = await owntracksConnect({
			userId: USER_A,
			otUser: "alice_ot",
			otDevice: "devA",
		});
		return connection;
	}

	it("applies from/to/format and maps data[] to LocationFix[]", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory } = await import("./owntracks");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("user=alice_ot");
			expect(url).toContain("device=devA");
			expect(url).toContain("from=2026-01-01");
			expect(url).toContain("to=2026-01-31");
			expect(url).toContain("format=json");
			return jsonResponse(200, {
				count: 2,
				data: [
					{ lat: 1, lon: 2, tst: 1750000000 },
					{ lat: 3, lon: 4, tst: 1750000100 },
				],
			});
		});

		const fixes = await owntracksLocationHistory(
			USER_A,
			conn.id,
			{ from: "2026-01-01", to: "2026-01-31" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(fixes).toEqual([
			{ lat: 1, lon: 2, at: new Date(1750000000 * 1000).toISOString() },
			{ lat: 3, lon: 4, at: new Date(1750000100 * 1000).toISOString() },
		]);
	});

	it("defaults to the last 7 days when from/to are omitted, with an inclusive (end-of-day) `to`", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory } = await import("./owntracks");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			expect(url.searchParams.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			// BUG2: a bare `to=YYYY-MM-DD` is parsed by the Recorder as
			// 00:00:00 of that day (start of day), which would silently
			// exclude every fix from "today" — the default upper bound must
			// carry an explicit end-of-day time component.
			expect(url.searchParams.get("to")).toMatch(
				/^\d{4}-\d{2}-\d{2}T23:59:59$/,
			);
			return jsonResponse(200, { count: 0, data: [] });
		});

		await owntracksLocationHistory(
			USER_A,
			conn.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("BUG2: a caller-supplied bare-date `to` (e.g. today) is widened to end-of-day so today's fixes aren't excluded", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory } = await import("./owntracks");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			expect(url.searchParams.get("to")).toBe("2026-01-31T23:59:59");
			return jsonResponse(200, { count: 0, data: [] });
		});

		await owntracksLocationHistory(
			USER_A,
			conn.id,
			{ from: "2026-01-01", to: "2026-01-31" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
	});

	it("BUG2: a caller-supplied `to` that already carries a time component is left untouched", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory } = await import("./owntracks");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			expect(url.searchParams.get("to")).toBe("2026-01-31T12:00:00");
			return jsonResponse(200, { count: 0, data: [] });
		});

		await owntracksLocationHistory(
			USER_A,
			conn.id,
			{ from: "2026-01-01", to: "2026-01-31T12:00:00" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
	});

	it("applies a limit, capping the returned fixes", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory } = await import("./owntracks");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, {
				count: 3,
				data: [
					{ lat: 1, lon: 1, tst: 1 },
					{ lat: 2, lon: 2, tst: 2 },
					{ lat: 3, lon: 3, tst: 3 },
				],
			}),
		);

		const fixes = await owntracksLocationHistory(
			USER_A,
			conn.id,
			{ limit: 2 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(fixes).toHaveLength(2);
	});

	it("BUG3: passes the Recorder's native `limit` query param (reverse-search — see API.md) so it can shrink the payload server-side", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory } = await import("./owntracks");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			expect(url.searchParams.get("limit")).toBe("2");
			return jsonResponse(200, { count: 0, data: [] });
		});

		await owntracksLocationHistory(
			USER_A,
			conn.id,
			{ limit: 2 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
	});

	it("BUG3: returns the NEWEST N fixes (by tst), not the oldest, when the Recorder hands back more oldest-first rows than `limit`", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory } = await import("./owntracks");

		// The Recorder's lsscan (storage.c) returns rows oldest-first — this
		// fixture is deliberately oldest-first and deliberately longer than
		// the requested limit, simulating a Recorder that hands back (or
		// doesn't itself truncate to) more than `limit` rows.
		const fetchMock = vi.fn(async () =>
			jsonResponse(200, {
				count: 5,
				data: [
					{ lat: 1, lon: 1, tst: 1000 }, // oldest
					{ lat: 2, lon: 2, tst: 2000 },
					{ lat: 3, lon: 3, tst: 3000 },
					{ lat: 4, lon: 4, tst: 4000 },
					{ lat: 5, lon: 5, tst: 5000 }, // newest
				],
			}),
		);

		const fixes = await owntracksLocationHistory(
			USER_A,
			conn.id,
			{ limit: 2 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		// Must be the two NEWEST fixes (tst 4000, 5000), not the two oldest
		// (tst 1000, 2000) that a naive `.slice(0, limit)` on an
		// ascending/oldest-first array would keep.
		expect(fixes.map((f) => f.lat)).toEqual([4, 5]);
	});

	it("an empty data[] maps to an empty array", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory } = await import("./owntracks");

		const fetchMock = vi.fn(async () => jsonResponse(200, { data: [] }));

		const fixes = await owntracksLocationHistory(
			USER_A,
			conn.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(fixes).toEqual([]);
	});

	it("a recorder 5xx throws a typed request_failed error", async () => {
		seedUser(USER_A);
		const conn = await seedConn();
		const { owntracksLocationHistory, OwnTracksError } = await import(
			"./owntracks"
		);

		const fetchMock = vi.fn(async () => jsonResponse(503, { error: "boom" }));

		await expect(
			owntracksLocationHistory(
				USER_A,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toBeInstanceOf(OwnTracksError);
	});
});

// ---------------------------------------------------------------------------
// owntracksAdapter.checkHealth
// ---------------------------------------------------------------------------

describe("owntracksAdapter.checkHealth", () => {
	it("a successful /api/0/last call -> connected", async () => {
		seedUser(USER_A);
		setConfiguredEnv();
		const { owntracksConnect, owntracksAdapter } = await import("./owntracks");
		const { connection } = await owntracksConnect({
			userId: USER_A,
			otUser: "alice_ot",
			otDevice: "devA",
		});

		const fetchMock = vi.fn(async () => jsonResponse(200, []));
		const health = await owntracksAdapter.checkHealth("", connection, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("connected");
	});

	it("a recorder failure -> error", async () => {
		seedUser(USER_A);
		setConfiguredEnv();
		const { owntracksConnect, owntracksAdapter } = await import("./owntracks");
		const { connection } = await owntracksConnect({
			userId: USER_A,
			otUser: "alice_ot",
			otDevice: "devA",
		});

		const fetchMock = vi.fn(async () => jsonResponse(500, { error: "boom" }));
		const health = await owntracksAdapter.checkHealth("", connection, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("error");
	});

	it("OWNTRACKS_RECORDER_URL unset -> error, without calling fetch", async () => {
		seedUser(USER_A);
		setConfiguredEnv();
		const { owntracksConnect } = await import("./owntracks");
		const { connection } = await owntracksConnect({
			userId: USER_A,
			otUser: "alice_ot",
			otDevice: "devA",
		});

		// Unconfigure after connecting (config is read live at checkHealth time).
		delete process.env.OWNTRACKS_RECORDER_URL;
		vi.resetModules();
		const { owntracksAdapter } = await import("./owntracks");
		const fetchMock = vi.fn();
		const health = await owntracksAdapter.checkHealth("", connection, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("error");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// No write path exists
// ---------------------------------------------------------------------------

describe("owntracks module surface — no write path", () => {
	it("exports only connect/read functions and the adapter, never a write function", async () => {
		setConfiguredEnv();
		const mod = await import("./owntracks");
		const exportedNames = Object.keys(mod);
		const writeLikeNames = exportedNames.filter((name) =>
			/write|create|update|delete|upload|scrobble|markWatched|markPlayed/i.test(
				name,
			),
		);
		expect(writeLikeNames).toEqual([]);
	});
});
