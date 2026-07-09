import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { WriteOperation, WritePreview } from "./write-guard";

// Issue 6.0 — confirmPendingWrite's provider dispatch, NEW behavior on top of
// the registry (write-executors.ts). This file is intentionally separate
// from pending-writes.test.ts, which stays untouched: it is the proof that
// Nextcloud's confirm path is byte-for-byte unchanged. These tests only
// cover the new dispatch surface — an unregistered provider, and a fake
// executor standing in for a future (Phase 6) provider — never re-assert
// Nextcloud-specific behavior.
let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

beforeEach(() => {
	dbPath = `./data/test-pending-writes-dispatch-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });

	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values([
			{
				id: "user-1",
				email: "user-1@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

// confirmPendingWrite now re-checks the connection's CURRENT allowWrites
// setting at confirm time (the write-safety corruption-firewall fix) —
// every dispatch test below needs a REAL, allowWrites:true connection row to
// get past that gate before it can exercise the dispatch/claim behavior
// these tests are actually about. The connection's own `provider` field is
// unrelated to the pending write's dispatch `provider` (a free-text label
// used purely to look up a registered executor), so a fixed "nextcloud"
// connection works as the backing row for every fake/unregistered provider
// below.
async function seedConnection(): Promise<string> {
	const { createConnection } = await import("./store");
	const conn = await createConnection({
		userId: "user-1",
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "alice",
		status: "connected",
		allowWrites: true,
	});
	return conn.id;
}

function makeOp(provider: string, connectionId: string): WriteOperation {
	return {
		provider,
		connectionId,
		action: "calendar.create_event",
		summary: "Create a test event",
		reversible: true,
		destructive: false,
	};
}

const PREVIEW: WritePreview = {
	title: "Create a test event",
	detail: "calendar.create_event",
	reversible: true,
	destructive: false,
	withinAllowlist: null,
	warnings: [],
};

describe("confirmPendingWrite — provider dispatch (Issue 6.0)", () => {
	it("a pending write whose provider has no registered executor fails with unsupported_operation and the row is marked failed (no execution)", async () => {
		const { createPendingWrite, confirmPendingWrite, getPendingWrite } =
			await import("./pending-writes");

		const connectionId = await seedConnection();
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "totally-unregistered-provider",
			op: makeOp("totally-unregistered-provider", connectionId),
			content: "hello",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		const result = await confirmPendingWrite("user-1", created.id);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(409);
			expect(result.reason).toBe("unsupported_operation");
		}

		const row = await getPendingWrite("user-1", created.id);
		expect(row?.status).toBe("failed");
	});

	it("dispatches to a registered fake executor with the right userId/connectionId/op/content, and records its etag on success", async () => {
		const { registerWriteExecutor } = await import("./write-executors");
		const { createPendingWrite, confirmPendingWrite, getPendingWrite } =
			await import("./pending-writes");

		const provider = `fake-provider-${randomUUID()}`;
		const executeSpy = vi.fn(async () => ({
			ok: true as const,
			etag: "fake-etag-1",
		}));
		registerWriteExecutor({ provider, execute: executeSpy });

		const connectionId = await seedConnection();
		const op = makeOp(provider, connectionId);
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider,
			op,
			content: "fake content",
			idempotencyKey: "key-2",
			preview: PREVIEW,
		});

		const result = await confirmPendingWrite("user-1", created.id);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.alreadyExecuted).toBe(false);
			expect(result.etag).toBe("fake-etag-1");
		}

		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(executeSpy).toHaveBeenCalledWith(
			"user-1",
			connectionId,
			op,
			"fake content",
			undefined,
		);

		const row = await getPendingWrite("user-1", created.id);
		expect(row?.status).toBe("executed");
		expect(row?.etag).toBe("fake-etag-1");
	});

	it("a fake executor returning {ok:false} marks the row failed and surfaces its reason", async () => {
		const { registerWriteExecutor } = await import("./write-executors");
		const { createPendingWrite, confirmPendingWrite, getPendingWrite } =
			await import("./pending-writes");

		const provider = `fake-provider-fail-${randomUUID()}`;
		registerWriteExecutor({
			provider,
			execute: vi.fn(async () => ({ ok: false as const, reason: "x" })),
		});

		const connectionId = await seedConnection();
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider,
			op: makeOp(provider, connectionId),
			content: "hello",
			idempotencyKey: "key-3",
			preview: PREVIEW,
		});

		const result = await confirmPendingWrite("user-1", created.id);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(409);
			expect(result.reason).toBe("x");
		}

		const row = await getPendingWrite("user-1", created.id);
		expect(row?.status).toBe("failed");
	});

	it("the atomic claim still holds for a dispatched provider: a confirm racing an already-claimed row never invokes the fake executor", async () => {
		// Deterministic version of the same TOCTOU proof pending-writes.test.ts
		// uses for Nextcloud ("claimPendingWrite (atomic claim-before-execute)"):
		// claim the row directly to put it in exactly the state a losing,
		// concurrent confirmPendingWrite call would observe, rather than
		// relying on real event-loop interleaving of two in-flight confirms.
		const { registerWriteExecutor } = await import("./write-executors");
		const { createPendingWrite, claimPendingWrite, confirmPendingWrite } =
			await import("./pending-writes");

		const provider = `fake-provider-concurrent-${randomUUID()}`;
		const executeSpy = vi.fn(async () => ({ ok: true as const, etag: "e" }));
		registerWriteExecutor({ provider, execute: executeSpy });

		const connectionId = await seedConnection();
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider,
			op: makeOp(provider, connectionId),
			content: "hello",
			idempotencyKey: "key-4",
			preview: PREVIEW,
		});

		const wonRace = await claimPendingWrite("user-1", created.id);
		expect(wonRace).toBe(true);

		const losingConfirm = await confirmPendingWrite("user-1", created.id);
		expect(losingConfirm.ok).toBe(false);
		if (!losingConfirm.ok) expect(losingConfirm.status).toBe(409);
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("a real concurrent pair of confirmPendingWrite calls invokes the fake executor at most once", async () => {
		const { registerWriteExecutor } = await import("./write-executors");
		const { createPendingWrite, confirmPendingWrite } = await import(
			"./pending-writes"
		);

		const provider = `fake-provider-race-${randomUUID()}`;
		const executeSpy = vi.fn(async () => ({ ok: true as const, etag: "e" }));
		registerWriteExecutor({ provider, execute: executeSpy });

		const connectionId = await seedConnection();
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider,
			op: makeOp(provider, connectionId),
			content: "hello",
			idempotencyKey: "key-5",
			preview: PREVIEW,
		});

		const results = await Promise.all([
			confirmPendingWrite("user-1", created.id),
			confirmPendingWrite("user-1", created.id),
		]);

		// Exactly one call actually executes the fake executor, no matter how
		// the two confirms interleave — the other must either short-circuit to
		// "already executed" or be refused as "in_progress", never execute a
		// second time.
		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(results.every((r) => r.ok || r.status === 409)).toBe(true);
	});
});
