// O1 — the honest measurement this slice was built on. Two backlog claims
// were unverified before this file existed:
//   1. "conversation-detail payload embedded twice in the HTML"
//   2. "~60-80 DB round trips per page view"
//
// Claim 1 was checked by hand against a real rendered page (see the O1
// section of docs/architecture-deepening-slices.md for the method and
// result: it does not hold — SvelteKit's `data-sveltekit-fetched` embeds the
// raw fetch response exactly once for a universal `+page.ts` load; the
// load's *return value* is not separately serialized). Claim 2 is checked
// here, mechanically, with a real seeded SQLite database and a spy on
// `better-sqlite3`'s `prepare()` — the same instrumentation
// message-sequences.test.ts already established for S1.
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedConversationWithMessages(messageCount: number) {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-08-15T12:00:00.000Z");

	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "o1-query-count@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "O1 query-count fixture",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	const rows = Array.from({ length: messageCount }, (_, i) => ({
		id: `msg-${i}`,
		conversationId: "conv-1",
		messageSequence: i + 1,
		role: i % 2 === 0 ? "user" : "assistant",
		content: `Message ${i}`,
		createdAt: new Date(now.getTime() + i * 1000),
	}));
	if (rows.length > 0) {
		db.insert(schema.messages).values(rows).run();
	}

	sqlite.close();
}

describe("conversation detail read model — query counting (O1)", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-o1-query-count-${Date.now()}-${Math.random()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("issues exactly one bounded message-list query per open, not an unbounded full-history scan", async () => {
		// 89 is the production maximum observed for a single conversation at
		// slice O1's measurement time (2026-08-15, §0 of the slices doc) —
		// well under the 100-row default window, so this also proves the
		// window doesn't truncate any conversation seen in production today.
		seedConversationWithMessages(89);
		const prepareSpy = vi.spyOn(Database.prototype, "prepare");
		try {
			const { getConversationDetail } = await import("./read-model");
			const detail = await getConversationDetail({
				userId: "user-1",
				conversationId: "conv-1",
			});

			expect(detail?.messages).toHaveLength(89);
			expect(detail?.hasMoreMessages).toBe(false);

			const messageTableQueries = prepareSpy.mock.calls.filter(([sqlText]) =>
				/SELECT[\s\S]*FROM\s+"?messages"?/i.test(String(sqlText)),
			);
			// One SELECT against `messages` for the whole read — the bounded
			// window query — not one per message and not a second full-history
			// read alongside it.
			expect(messageTableQueries).toHaveLength(1);
			expect(String(messageTableQueries[0][0])).toMatch(/LIMIT/i);
			expect(String(messageTableQueries[0][0])).not.toMatch(/OFFSET/i);
		} finally {
			prepareSpy.mockRestore();
		}
	});

	it("records the total prepared-statement count for one conversation-detail open (Step 0 measurement)", async () => {
		seedConversationWithMessages(89);
		const prepareSpy = vi.spyOn(Database.prototype, "prepare");
		try {
			const { getConversationDetail } = await import("./read-model");
			const detail = await getConversationDetail({
				userId: "user-1",
				conversationId: "conv-1",
			});
			expect(detail).not.toBeNull();

			const totalStatements = prepareSpy.mock.calls.length;
			// This is the number to compare against the backlog's unverified
			// "~60-80 DB round trips per page view" estimate. It is printed
			// (not just asserted as a range) so the actual figure is visible in
			// CI output and doesn't silently drift as collaborators change —
			// see the O1 section of docs/architecture-deepening-slices.md for
			// the recorded before/after comparison.
			// eslint-disable-next-line no-console
			console.info(
				`[O1 measurement] one getConversationDetail() open (89 messages, otherwise-empty conversation) issued ${totalStatements} prepared statements`,
			);
			expect(totalStatements).toBeGreaterThan(0);
		} finally {
			prepareSpy.mockRestore();
		}
	});

	it("paginates older messages beyond the initial window with the correctly assembled shape", async () => {
		seedConversationWithMessages(45);
		const { getConversationDetail, getOlderConversationMessages } =
			await import("./read-model");

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
			messageWindowLimit: 20,
		});
		expect(detail?.messages).toHaveLength(20);
		expect(detail?.hasMoreMessages).toBe(true);
		expect(detail?.messages[0]?.id).toBe("msg-25");
		expect(detail?.messages.at(-1)?.id).toBe("msg-44");

		const middlePage = await getOlderConversationMessages({
			userId: "user-1",
			conversationId: "conv-1",
			offset: 20,
			limit: 20,
		});
		expect(middlePage?.messages).toHaveLength(20);
		expect(middlePage?.hasMoreBefore).toBe(true);
		expect(middlePage?.messages[0]?.id).toBe("msg-5");
		expect(middlePage?.messages.at(-1)?.id).toBe("msg-24");
		// Assembled shape parity with the initial window: same ChatMessage
		// fields, not a stripped-down projection.
		for (const message of middlePage?.messages ?? []) {
			expect(message).toHaveProperty("role");
			expect(message).toHaveProperty("content");
			expect(message).toHaveProperty("timestamp");
		}

		const finalPage = await getOlderConversationMessages({
			userId: "user-1",
			conversationId: "conv-1",
			offset: 40,
			limit: 20,
		});
		expect(finalPage?.messages).toHaveLength(5);
		expect(finalPage?.hasMoreBefore).toBe(false);
		expect(finalPage?.messages[0]?.id).toBe("msg-0");
		expect(finalPage?.messages.at(-1)?.id).toBe("msg-4");
	});

	it("returns null from pagination for a conversation the user does not own", async () => {
		seedConversationWithMessages(5);
		const { getOlderConversationMessages } = await import("./read-model");

		const page = await getOlderConversationMessages({
			userId: "someone-else",
			conversationId: "conv-1",
			offset: 0,
			limit: 20,
		});
		expect(page).toBeNull();
	});
});
