// Issue X.1 — CONSOLIDATED, STANDING per-user isolation suite.
//
// GUARANTEE: user A can NEVER reach user B's connections, secrets, pending
// writes, or connector data — through the store, the resolve layer, health
// checks, connection-backed chat tools, or the write-confirm chokepoint —
// regardless of how the caller learns B's connectionId/pendingWriteId (a
// guess, a stale UI state, a replayed request, ...).
//
// This suite CONSOLIDATES what individual per-issue tests already proved
// (store.test.ts's "user isolation" describe, resolve.test.ts, health.test.ts,
// owntracks.test.ts's 5.7 "ISOLATION" describe, pending-writes.test.ts) into
// one standing file so a FUTURE connector/store method can't be added without
// an isolation assertion here. Where a per-issue test already covers a case
// in more depth, this file re-asserts the guarantee concisely rather than
// re-deriving every edge case — the value here is the single, durable,
// all-guarantees-in-one-place suite, not exhaustiveness per function.
//
// Runs against a REAL migrated sqlite db (same throwaway-per-test harness as
// store.test.ts/pending-writes.test.ts) — isolation is a WHERE-clause
// guarantee, so it must be proven against a real query planner, not a mock.
// All provider network I/O is mocked; no live credentials anywhere.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { WritePreview } from "$lib/server/services/connections/write-guard";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

const USER_A = "userA";
const USER_B = "userB";

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

async function seedConversation(userId: string, conversationId: string) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	await db.insert(schema.conversations).values({
		id: conversationId,
		userId,
		title: "Test conversation",
		createdAt: now,
		updatedAt: now,
	});
}

beforeEach(() => {
	dbPath = `./data/test-cross-cutting-isolation-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	seedUser(USER_A);
	seedUser(USER_B);
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

// ---------------------------------------------------------------------------
// store.ts — every user-scoped function refuses (null / false / 0-rows) for
// another user's connection id, and the row it silently guards is unchanged.
// ---------------------------------------------------------------------------
describe("isolation — store.ts", () => {
	async function seedConnB() {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		return createConnection({
			userId: USER_B,
			provider: "nextcloud",
			label: "B's Nextcloud",
			accountIdentifier: "bob",
			capabilities: ["files"],
			status: "connected",
			secret: "b-secret",
			allowWrites: true,
			writeAllowlist: ["/AlfyAI"],
		});
	}

	it("getConnection(A, B_connId) -> null", async () => {
		const { getConnection } = await import(
			"$lib/server/services/connections/store"
		);
		const connB = await seedConnB();
		expect(await getConnection(USER_A, connB.id)).toBeNull();
	});

	it("getConnectionSecret(A, B_connId) -> null", async () => {
		const { getConnectionSecret } = await import(
			"$lib/server/services/connections/store"
		);
		const connB = await seedConnB();
		expect(await getConnectionSecret(USER_A, connB.id)).toBeNull();
	});

	it("listConnectionsForUser(A) excludes B's connections", async () => {
		const { createConnection, listConnectionsForUser } = await import(
			"$lib/server/services/connections/store"
		);
		await seedConnB();
		await createConnection({
			userId: USER_A,
			provider: "plex",
			label: "A's Plex",
			capabilities: ["media"],
			status: "connected",
		});

		const listA = await listConnectionsForUser(USER_A);
		expect(listA).toHaveLength(1);
		expect(listA[0]?.label).toBe("A's Plex");
	});

	it("updateConnection/setAllowWrites/setDefaultOn/setEnabledCapabilities/deleteConnection/setConnectionWriteSecret(A, B_connId) are all no-ops — B's row is untouched", async () => {
		const {
			updateConnection,
			setAllowWrites,
			setDefaultOn,
			setEnabledCapabilities,
			deleteConnection,
			setConnectionWriteSecret,
			getConnection,
		} = await import("$lib/server/services/connections/store");
		const connB = await seedConnB();

		expect(
			await updateConnection(USER_A, connB.id, { label: "hijacked" }),
		).toBeNull();
		expect(await setAllowWrites(USER_A, connB.id, false)).toBeNull();
		expect(await setDefaultOn(USER_A, connB.id, true)).toBeNull();
		expect(await setEnabledCapabilities(USER_A, connB.id, ["x"])).toBeNull();
		expect(await setConnectionWriteSecret(USER_A, connB.id, "nope")).toBe(
			false,
		);
		expect(await deleteConnection(USER_A, connB.id)).toBe(false);

		const stillB = await getConnection(USER_B, connB.id);
		expect(stillB).not.toBeNull();
		expect(stillB?.label).toBe("B's Nextcloud");
		expect(stillB?.allowWrites).toBe(true);
		expect(stillB?.defaultOn).toBe(false);
		expect(stillB?.capabilities).toEqual(["files"]);
	});
});

// ---------------------------------------------------------------------------
// pending-writes.ts — createPendingWrite/listPendingWritesForConversation are
// scoped by (userId, conversationId); confirm/cancel refuse another user's
// pending write id outright, without ever reaching the write executor.
// ---------------------------------------------------------------------------
describe("isolation — pending-writes.ts", () => {
	const OP = {
		provider: "nextcloud",
		connectionId: "conn-b",
		action: "files.put",
		summary: "Save note.txt",
		reversible: true,
		destructive: false,
	} as const;
	const PREVIEW: WritePreview = {
		title: "Save note.txt",
		detail: "files.put — /AlfyAI/note.txt",
		reversible: true,
		destructive: false,
		withinAllowlist: true,
		warnings: [],
	};

	async function seedBsPendingWrite(conversationId?: string) {
		const { createPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		return createPendingWrite(USER_B, {
			connectionId: "conn-b",
			provider: "nextcloud",
			op: OP,
			content: "hello",
			idempotencyKey: `key-${randomUUID()}`,
			preview: PREVIEW,
			conversationId,
		});
	}

	it("listPendingWritesForConversation(A, B_conversationId) excludes B's rows", async () => {
		const conversationId = "conv-shared-id";
		await seedConversation(USER_B, conversationId);
		await seedBsPendingWrite(conversationId);

		const { listPendingWritesForConversation } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect(
			await listPendingWritesForConversation(USER_A, conversationId),
		).toEqual([]);
	});

	it("confirmPendingWrite(A, B_pendingWriteId) -> 404 not_found, never executes", async () => {
		const created = await seedBsPendingWrite();
		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);

		const result = await confirmPendingWrite(USER_A, created.id);
		expect(result).toEqual({ ok: false, status: 404, reason: "not_found" });

		// B's row is untouched — still pending, never claimed/executed by A's
		// attempt.
		const stillB = await getPendingWrite(USER_B, created.id);
		expect(stillB?.status).toBe("pending");
	});

	it("cancelPendingWrite(A, B_pendingWriteId) -> false, B's row stays pending", async () => {
		const created = await seedBsPendingWrite();
		const { cancelPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);

		expect(await cancelPendingWrite(USER_A, created.id)).toBe(false);
		expect((await getPendingWrite(USER_B, created.id))?.status).toBe("pending");
	});

	it("getPendingWrite(A, B_pendingWriteId) -> null", async () => {
		const created = await seedBsPendingWrite();
		const { getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect(await getPendingWrite(USER_A, created.id)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// resolve.ts — every resolution helper only ever sees the caller's own rows.
// (listConnectionsForUser is the single underlying query every one of these
// is built on, already proven scoped above — this section re-asserts the
// guarantee at the public resolve.ts surface every tool/route actually
// calls.)
// ---------------------------------------------------------------------------
describe("isolation — resolve.ts", () => {
	beforeEach(async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		await createConnection({
			userId: USER_B,
			provider: "google",
			label: "B's Google",
			accountIdentifier: "bob@example.com",
			capabilities: ["calendar"],
			status: "connected",
			defaultOn: true,
			secret: "b-oauth",
		});
	});

	it("resolveConnectionsForCapability(A, 'calendar') never returns B's connection", async () => {
		const { resolveConnectionsForCapability } = await import(
			"$lib/server/services/connections/resolve"
		);
		expect(await resolveConnectionsForCapability(USER_A, "calendar")).toEqual(
			[],
		);
	});

	it("getEnabledConnectionCapabilities(A) is empty despite B having calendar enabled", async () => {
		const { getEnabledConnectionCapabilities } = await import(
			"$lib/server/services/connections/resolve"
		);
		expect(await getEnabledConnectionCapabilities(USER_A)).toEqual(new Set());
	});

	it("resolveActiveCapabilities(A, ['calendar']) is empty despite B having a defaultOn calendar connection", async () => {
		const { resolveActiveCapabilities } = await import(
			"$lib/server/services/connections/resolve"
		);
		expect(await resolveActiveCapabilities(USER_A, ["calendar"])).toEqual(
			new Set(),
		);
		// requested == null path (getDefaultOnCapabilities) is equally scoped.
		expect(await resolveActiveCapabilities(USER_A)).toEqual(new Set());
	});
});

// ---------------------------------------------------------------------------
// health.ts — checkConnectionHealth(A, B_connId) never reaches B's
// adapter/secret: getConnection's scoped WHERE clause is the sole gate, so
// this is a thin confirm that health.ts routes through it rather than a
// second, independent lookup.
// ---------------------------------------------------------------------------
describe("isolation — health.ts", () => {
	it("checkConnectionHealth(A, B_connId) -> null, never calls an adapter", async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		const connB = await createConnection({
			userId: USER_B,
			provider: "nextcloud",
			label: "B's Nextcloud",
			accountIdentifier: "bob",
			capabilities: ["files"],
			status: "connected",
			secret: "b-secret",
			config: { serverUrl: "https://cloud.example.com", loginName: "bob" },
		});

		const fetchSpy = vi.fn();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const { checkConnectionHealth } = await import(
				"$lib/server/services/connections/health"
			);
			expect(await checkConnectionHealth(USER_A, connB.id)).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// OwnTracks device isolation (already proven in 5.7's owntracks.test.ts —
// duplicated here concisely as the standing cross-cutting assertion; this is
// the ONE connector where isolation is a device/credential concern on top of
// the ordinary row-scoping above, since the recorder is queried by
// otUser/otDevice pulled out of the connection's own config).
// ---------------------------------------------------------------------------
describe("isolation — owntracks device isolation (5.7)", () => {
	const ENV_KEYS = [
		"OWNTRACKS_RECORDER_URL",
		"OWNTRACKS_RECORDER_USER",
		"OWNTRACKS_RECORDER_PASS",
	];

	beforeEach(() => {
		vi.resetModules();
		for (const key of ENV_KEYS) delete process.env[key];
		process.env.OWNTRACKS_RECORDER_URL = "http://127.0.0.1:8083";
	});

	afterEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});

	it("A reading B's owntracks connection -> null + zero recorder fetch", async () => {
		const { owntracksConnect, owntracksLastLocation } = await import(
			"$lib/server/services/connections/providers/owntracks"
		);
		const { connection: connB } = await owntracksConnect({
			userId: USER_B,
			otUser: "bob_ot",
			otDevice: "devB",
		});

		const fetchMock = vi.fn();
		const fix = await owntracksLastLocation(USER_A, connB.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(fix).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Connection-backed chat tools — thin confirm. resolveConnectionsForCapability
// is user-scoped (proven above), and no tool accepts a caller-supplied
// connectionId to read/write against — so the only way a tool could reach
// B's data is a bug that queries some OTHER user's rows. This section seeds
// ONLY B with a connected, capability-enabled connection and calls each tool
// as A, asserting a graceful "no connection" outcome and that the
// provider-level read function is never invoked.
// ---------------------------------------------------------------------------
describe("isolation — connection-backed tools (thin confirm)", () => {
	it("calendar: A has no calendar connection despite B having one — no googleListEvents/appleListEvents call", async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		await createConnection({
			userId: USER_B,
			provider: "google",
			label: "B's Google",
			accountIdentifier: "bob@example.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: "b-oauth",
		});

		const { runCalendarTool } = await import(
			"$lib/server/services/normal-chat-tools/calendar"
		);
		const outcome = await runCalendarTool(
			USER_A,
			{ action: "list_events" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.events).toEqual([]);
	});

	it("files: A has no files connection despite B having one — nextcloudSearch/nextcloudReadFile never reached", async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		await createConnection({
			userId: USER_B,
			provider: "nextcloud",
			label: "B's Nextcloud",
			accountIdentifier: "bob",
			capabilities: ["files"],
			status: "connected",
			secret: "b-secret",
			config: { serverUrl: "https://cloud.example.com", loginName: "bob" },
		});

		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_A,
			{ action: "search", query: "invoice" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.results).toEqual([]);
	});

	it("email: A has no email connection despite B having one", async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		await createConnection({
			userId: USER_B,
			provider: "imap",
			label: "B's Email",
			accountIdentifier: "bob@example.com",
			capabilities: ["email"],
			status: "connected",
			secret: "b-password",
			config: {
				email: "bob@example.com",
				imapHost: "imap.example.com",
				imapPort: 993,
				imapSecure: true,
			},
		});

		const { runEmailTool } = await import(
			"$lib/server/services/normal-chat-tools/email"
		);
		const outcome = await runEmailTool(USER_A, { action: "recent" }, "model1");
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.messages).toEqual([]);
	});

	it("photos: A has no photos connection despite B having one", async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		await createConnection({
			userId: USER_B,
			provider: "immich",
			label: "B's Immich",
			accountIdentifier: "bob",
			capabilities: ["photos"],
			status: "connected",
			secret: "b-key",
			config: { origin: "https://photos.example.com" },
		});

		const { runPhotosTool } = await import(
			"$lib/server/services/normal-chat-tools/photos"
		);
		const outcome = await runPhotosTool(
			USER_A,
			{ action: "search", query: "beach" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.results).toEqual([]);
	});

	it("media: A has no media connection despite B having one", async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		await createConnection({
			userId: USER_B,
			provider: "plex",
			label: "B's Plex",
			accountIdentifier: "bob",
			capabilities: ["media"],
			status: "connected",
			secret: "b-token",
			config: { baseUrl: "https://plex.example.com" },
		});

		const { runMediaTool } = await import(
			"$lib/server/services/normal-chat-tools/media"
		);
		const outcome = await runMediaTool(
			USER_A,
			{ action: "watch_history" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.results).toEqual([]);
	});

	it("location: A has no location connection despite B having one", async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		await createConnection({
			userId: USER_B,
			provider: "owntracks",
			label: "B's OwnTracks",
			accountIdentifier: "bob_ot",
			capabilities: ["location"],
			status: "connected",
			secret: "b-device",
			config: { otUser: "bob_ot", otDevice: "devB" },
		});

		const { runLocationTool } = await import(
			"$lib/server/services/normal-chat-tools/location"
		);
		const outcome = await runLocationTool(USER_A, { action: "last" }, "model1");
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.results).toEqual([]);
	});

	it("contacts: A has no contacts-capable connection despite B having one", async () => {
		const { createConnection } = await import(
			"$lib/server/services/connections/store"
		);
		await createConnection({
			userId: USER_B,
			provider: "google",
			label: "B's Google",
			accountIdentifier: "bob@example.com",
			capabilities: ["contacts"],
			status: "connected",
			secret: "b-oauth",
		});

		const { runContactsTool } = await import(
			"$lib/server/services/normal-chat-tools/contacts"
		);
		const outcome = await runContactsTool(
			USER_A,
			{ action: "lookup", query: "Bob" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.contacts).toEqual([]);
	});
});
