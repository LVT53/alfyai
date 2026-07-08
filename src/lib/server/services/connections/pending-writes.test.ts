import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { WriteOperation, WritePreview } from "./write-guard";

// pending-writes.ts loads/writes real rows via `$lib/server/db`, and
// confirmPendingWrite calls through to executeNextcloudWrite (4.2) which
// itself loads the connection + decrypts its secret via the store layer —
// same throwaway-sqlite-per-test harness as nextcloud-files.write.test.ts.
let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

beforeEach(() => {
	dbPath = `./data/test-pending-writes-${randomUUID()}.db`;
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
			{
				id: "user-2",
				email: "user-2@example.com",
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

const CONN_CONFIG = {
	serverUrl: "https://cloud.example.com",
	loginName: "alice",
};

async function seedConnection(
	userId: string,
	overrides: { allowWrites?: boolean; writeAllowlist?: string[] } = {},
): Promise<string> {
	const { createConnection } = await import("./store");
	const conn = await createConnection({
		userId,
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "alice",
		capabilities: ["files"],
		status: "connected",
		secret: "app-password-xyz",
		allowWrites: overrides.allowWrites ?? true,
		writeAllowlist: overrides.writeAllowlist ?? ["/AlfyAI"],
		config: CONN_CONFIG,
	});
	return conn.id;
}

function makeOp(
	connectionId: string,
	path = "/AlfyAI/note.txt",
): WriteOperation {
	return {
		provider: "nextcloud",
		connectionId,
		action: "files.put",
		summary: `Save note.txt to ${path}`,
		reversible: true,
		destructive: false,
		target: { path, withinAllowlist: true },
	};
}

const PREVIEW: WritePreview = {
	title: "Save note.txt",
	detail: "files.put — /AlfyAI/note.txt",
	reversible: true,
	destructive: false,
	withinAllowlist: true,
	warnings: [],
};

describe("createPendingWrite / getPendingWrite", () => {
	it("creates a pending row scoped to the user and returns {id, preview}", async () => {
		const { createPendingWrite, getPendingWrite } = await import(
			"./pending-writes"
		);
		const connectionId = await seedConnection("user-1");
		const op = makeOp(connectionId);

		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op,
			content: "hello world",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		expect(created.id).toBeTruthy();
		expect(created.preview).toEqual(PREVIEW);

		const fetched = await getPendingWrite("user-1", created.id);
		expect(fetched).not.toBeNull();
		expect(fetched?.status).toBe("pending");
		expect(fetched?.op).toEqual(op);
		expect(fetched?.content).toBe("hello world");
		expect(fetched?.connectionId).toBe(connectionId);
	});

	it("getPendingWrite returns null for another user's pending write (user-scoped)", async () => {
		const { createPendingWrite, getPendingWrite } = await import(
			"./pending-writes"
		);
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		const fetched = await getPendingWrite("user-2", created.id);
		expect(fetched).toBeNull();
	});

	it("getPendingWrite returns null for an unknown id", async () => {
		const { getPendingWrite } = await import("./pending-writes");
		const fetched = await getPendingWrite("user-1", "does-not-exist");
		expect(fetched).toBeNull();
	});
});

describe("cancelPendingWrite", () => {
	it("marks a pending write cancelled and a later confirm is refused", async () => {
		const { createPendingWrite, cancelPendingWrite, confirmPendingWrite } =
			await import("./pending-writes");
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		const cancelled = await cancelPendingWrite("user-1", created.id);
		expect(cancelled).toBe(true);

		const fetchMock = vi.fn();
		const result = await confirmPendingWrite("user-1", created.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(409);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("cancelling another user's pending write is a no-op (user-scoped)", async () => {
		const { createPendingWrite, cancelPendingWrite, getPendingWrite } =
			await import("./pending-writes");
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		const cancelled = await cancelPendingWrite("user-2", created.id);
		expect(cancelled).toBe(false);

		const fetched = await getPendingWrite("user-1", created.id);
		expect(fetched?.status).toBe("pending");
	});
});

describe("confirmPendingWrite", () => {
	it("executes exactly once via executeNextcloudWrite; a second confirm is idempotent and does not execute again", async () => {
		const { createPendingWrite, confirmPendingWrite, getPendingWrite } =
			await import("./pending-writes");
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello world",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		let putCount = 0;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "PUT") putCount++;
				return new Response(null, { status: 201, headers: { ETag: '"e1"' } });
			},
		);

		const first = await confirmPendingWrite("user-1", created.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.alreadyExecuted).toBe(false);
		expect(putCount).toBe(1);

		const afterFirst = await getPendingWrite("user-1", created.id);
		expect(afterFirst?.status).toBe("executed");

		const second = await confirmPendingWrite("user-1", created.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.alreadyExecuted).toBe(true);
		// No second PUT — the write was NOT executed again.
		expect(putCount).toBe(1);
	});

	it("refuses to confirm a pending write owned by another user, and never executes", async () => {
		const { createPendingWrite, confirmPendingWrite, getPendingWrite } =
			await import("./pending-writes");
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello world",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		const fetchMock = vi.fn();
		const result = await confirmPendingWrite("user-2", created.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(404);
		}
		expect(fetchMock).not.toHaveBeenCalled();

		const stillPending = await getPendingWrite("user-1", created.id);
		expect(stillPending?.status).toBe("pending");
	});

	it("returns a 404-shaped refusal for an unknown pending write id", async () => {
		const { confirmPendingWrite } = await import("./pending-writes");
		const fetchMock = vi.fn();
		const result = await confirmPendingWrite("user-1", "does-not-exist", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// 4.3 review fix — the confirm flow previously checked `status` in
// application code and only updated the row AFTER awaiting
// executeNextcloudWrite, a TOCTOU race that let two concurrent confirms both
// issue a real Nextcloud write. These tests prove the atomic
// claim-before-execute fix deterministically, without relying on real
// event-loop interleaving of two in-flight confirms.
describe("claimPendingWrite (atomic claim-before-execute)", () => {
	it("the first claim on a pending row succeeds; a second claim on the same row fails (changes === 0)", async () => {
		const { createPendingWrite, claimPendingWrite, getPendingWrite } =
			await import("./pending-writes");
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello world",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		const firstClaim = await claimPendingWrite("user-1", created.id);
		expect(firstClaim).toBe(true);

		const afterFirstClaim = await getPendingWrite("user-1", created.id);
		expect(afterFirstClaim?.status).toBe("executing");

		// Simulates the losing side of a race: another confirm reading the
		// same row tries to claim it too, after the winner already flipped
		// it to "executing".
		const secondClaim = await claimPendingWrite("user-1", created.id);
		expect(secondClaim).toBe(false);
	});

	it("a confirm that arrives after another confirm already claimed the row is refused and never calls executeNextcloudWrite (proves 'executes exactly once' under concurrency)", async () => {
		const { createPendingWrite, claimPendingWrite, confirmPendingWrite } =
			await import("./pending-writes");
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello world",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		let putCount = 0;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "PUT") putCount++;
				return new Response(null, { status: 201, headers: { ETag: '"e1"' } });
			},
		);

		// A concurrent confirm "wins" the race first — claim the row directly
		// to deterministically put it in the exact state a second, racing
		// confirmPendingWrite call would observe (status === "executing",
		// claimed by someone else, execution not necessarily finished yet).
		const wonRace = await claimPendingWrite("user-1", created.id);
		expect(wonRace).toBe(true);

		// The losing confirm call must refuse — NOT call executeNextcloudWrite —
		// because it can no longer win the claim (the row is already
		// "executing").
		const losingConfirm = await confirmPendingWrite("user-1", created.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(losingConfirm.ok).toBe(false);
		if (!losingConfirm.ok) expect(losingConfirm.status).toBe(409);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(putCount).toBe(0);
	});

	it("execute failure moves the row to 'failed' — it is never left stuck in 'executing'", async () => {
		const { createPendingWrite, confirmPendingWrite, getPendingWrite } =
			await import("./pending-writes");
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello world",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "PUT") {
					return new Response("server error", { status: 500 });
				}
				return new Response(null, { status: 201 });
			},
		);

		const result = await confirmPendingWrite("user-1", created.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(result.ok).toBe(false);

		const afterFailure = await getPendingWrite("user-1", created.id);
		expect(afterFailure?.status).toBe("failed");
		expect(afterFailure?.status).not.toBe("executing");

		// A later confirm on a "failed" row is refused outright, not
		// silently retried, and still never calls the executor.
		const fetchMockAfter = vi.fn();
		const retry = await confirmPendingWrite("user-1", created.id, {
			fetch: fetchMockAfter as unknown as typeof fetch,
		});
		expect(retry.ok).toBe(false);
		if (!retry.ok) expect(retry.status).toBe(409);
		expect(fetchMockAfter).not.toHaveBeenCalled();
	});

	it("alreadyExecuted responses carry the etag from the original execution", async () => {
		const { createPendingWrite, confirmPendingWrite } = await import(
			"./pending-writes"
		);
		const connectionId = await seedConnection("user-1");
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "nextcloud",
			op: makeOp(connectionId),
			content: "hello world",
			idempotencyKey: "key-1",
			preview: PREVIEW,
		});

		const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
			return new Response(null, { status: 201, headers: { ETag: '"e-42"' } });
		});

		const first = await confirmPendingWrite("user-1", created.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.etag).toBe('"e-42"');

		const second = await confirmPendingWrite("user-1", created.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(second.ok).toBe(true);
		if (second.ok) {
			expect(second.alreadyExecuted).toBe(true);
			expect(second.etag).toBe('"e-42"');
		}
	});
});
