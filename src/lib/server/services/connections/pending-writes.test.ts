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
