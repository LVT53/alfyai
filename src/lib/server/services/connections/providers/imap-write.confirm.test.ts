import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { idempotencyKey, type WriteOperation } from "../write-guard";

// Issue 6.3 — end-to-end double-send prevention proof: this file exercises
// the REAL confirmPendingWrite (pending-writes.ts, Issue 6.0's atomic claim)
// dispatching to the REAL registered "imap" write-executor
// (registerWriteExecutor's side effect from importing providers/imap-write
// via pending-writes.ts's own side-effect import — nothing here imports
// imap-write.ts directly), against a throwaway sqlite db — same harness as
// pending-writes.test.ts / pending-writes.write-executor-dispatch.test.ts.
// `nodemailer` is mocked at the MODULE level (rather than via the
// executor's own createTransport DI hook, which confirmPendingWrite's opts
// has no way to thread through) so no real SMTP socket is ever opened here.
let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

const sendMailMock = vi.fn(async () => ({ ok: true }));
const closeMock = vi.fn();
const createTransportMock = vi.fn(() => ({
	sendMail: sendMailMock,
	close: closeMock,
}));

vi.mock("nodemailer", () => ({
	default: { createTransport: createTransportMock },
}));

beforeEach(() => {
	dbPath = `./data/test-imap-write-confirm-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });

	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user-1@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sendMailMock.mockClear();
	closeMock.mockClear();
	createTransportMock.mockClear();
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

async function seedImapConnection(): Promise<string> {
	const { createConnection } = await import("../store");
	const conn = await createConnection({
		userId: "user-1",
		provider: "imap",
		label: "Email",
		accountIdentifier: "alice@example.com",
		capabilities: ["email"],
		status: "connected",
		secret: "app-password-xyz",
		allowWrites: true,
		config: {
			email: "alice@example.com",
			imapHost: "imap.example.com",
			imapPort: 993,
			imapSecure: true,
			smtpHost: "smtp.example.com",
			smtpPort: 587,
		},
	});
	return conn.id;
}

function makeSendOp(connectionId: string): WriteOperation {
	return {
		provider: "imap",
		connectionId,
		action: "email.send",
		summary: 'Send "Hello" to bob@example.com',
		reversible: false,
		destructive: false,
		target: { label: "Hello → bob@example.com" },
	};
}

const PREVIEW = {
	title: "Send an email",
	detail: "email.send — Hello → bob@example.com",
	reversible: false,
	destructive: false,
	withinAllowlist: null,
	warnings: ["Sending cannot be undone"],
};

describe("imap write-executor dispatched through confirmPendingWrite — double-send prevention", () => {
	it("a real concurrent pair of confirmPendingWrite calls sends the email at most once", async () => {
		const connectionId = await seedImapConnection();
		const { createPendingWrite, confirmPendingWrite } = await import(
			"../pending-writes"
		);

		const op = makeSendOp(connectionId);
		const content = JSON.stringify({
			to: "bob@example.com",
			subject: "Hello",
			body: "Hi Bob!",
		});
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "imap",
			op,
			content,
			idempotencyKey: idempotencyKey(op),
			preview: PREVIEW,
		});

		const results = await Promise.all([
			confirmPendingWrite("user-1", created.id),
			confirmPendingWrite("user-1", created.id),
		]);

		// Exactly one of the two concurrent confirms actually sends the email,
		// no matter how they interleave — the other short-circuits to
		// "already executed" or is refused as "in_progress", never a second
		// live send. This is the double-send guarantee: the atomic
		// pending -> executing claim (Issue 6.0) means the SMTP-submitting
		// executor body can only ever run once per pending write.
		expect(sendMailMock).toHaveBeenCalledTimes(1);
		expect(results.every((r) => r.ok || r.status === 409)).toBe(true);
		expect(results.some((r) => r.ok)).toBe(true);
	});

	it("confirming an already-executed send again is a no-op — never re-sends", async () => {
		const connectionId = await seedImapConnection();
		const { createPendingWrite, confirmPendingWrite } = await import(
			"../pending-writes"
		);

		const op = makeSendOp(connectionId);
		const content = JSON.stringify({
			to: "bob@example.com",
			subject: "Hello",
			body: "Hi Bob!",
		});
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "imap",
			op,
			content,
			idempotencyKey: idempotencyKey(op),
			preview: PREVIEW,
		});

		const first = await confirmPendingWrite("user-1", created.id);
		expect(first.ok).toBe(true);
		expect(sendMailMock).toHaveBeenCalledTimes(1);

		const second = await confirmPendingWrite("user-1", created.id);
		expect(second).toEqual({
			ok: true,
			alreadyExecuted: true,
			etag: null,
		});
		expect(sendMailMock).toHaveBeenCalledTimes(1);
	});

	it("sends with the deterministic Message-ID derived from the pending write's op", async () => {
		const connectionId = await seedImapConnection();
		const { createPendingWrite, confirmPendingWrite } = await import(
			"../pending-writes"
		);
		const { imapMessageIdForOp } = await import("./imap-write");

		const op = makeSendOp(connectionId);
		const content = JSON.stringify({
			to: "bob@example.com",
			subject: "Hello",
			body: "Hi Bob!",
		});
		const created = await createPendingWrite("user-1", {
			connectionId,
			provider: "imap",
			op,
			content,
			idempotencyKey: idempotencyKey(op),
			preview: PREVIEW,
		});

		await confirmPendingWrite("user-1", created.id);

		expect(sendMailMock).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "bob@example.com",
				subject: "Hello",
				text: "Hi Bob!",
				messageId: imapMessageIdForOp(op),
			}),
		);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});
});
