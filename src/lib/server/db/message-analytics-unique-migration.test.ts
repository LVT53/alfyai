// @always-run: exercises file or process inputs outside Vitest’s import graph.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";

/**
 * `message_analytics_message_unique_idx` was declared in schema.ts from the
 * start, but no migration created it, so the writer's `onConflictDoNothing()`
 * only ever met the random primary key and a message saved twice kept two
 * timing rows. The migration removes the duplicates, then creates the index.
 *
 * The rule for the duplicates: each message keeps the row written last (the
 * highest rowid), the row every reader showed (the dashboard's map kept the
 * last row it read, the usage read took the last by rowid), so no number on a
 * page changes. The database that matters is one already serving people,
 * with duplicates nobody can see from here, so this upgrades a database that
 * stood at the release before the migration.
 */

const UNIQUE_TAG = "1777140000132_message_analytics_unique_message";
const INDEX = "message_analytics_message_unique_idx";

describe("message analytics unique message migration", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "alfyai-analytics-unique-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/**
	 * The migrations folder as it stood the moment BEFORE this migration: every
	 * entry up to it, and none after (see the same helper in `schema.test.ts`).
	 */
	function migrationsFolderBefore(): string {
		const folder = join(workDir, "drizzle-before");
		if (existsSync(folder)) return folder;
		mkdirSync(join(folder, "meta"), { recursive: true });

		const journal = JSON.parse(
			readFileSync("./drizzle/meta/_journal.json", "utf8"),
		) as { entries: Array<{ tag: string }> };
		const cutoff = journal.entries.findIndex(
			(entry) => entry.tag === UNIQUE_TAG,
		);
		expect(cutoff).toBeGreaterThan(0);
		const kept = journal.entries.slice(0, cutoff);
		const keptTags = new Set(kept.map((entry) => entry.tag));

		writeFileSync(
			join(folder, "meta", "_journal.json"),
			JSON.stringify({ ...journal, entries: kept }),
		);

		for (const file of readdirSync("./drizzle")) {
			if (!file.endsWith(".sql")) continue;
			if (!keptTags.has(file.slice(0, -".sql".length))) continue;
			copyFileSync(join("./drizzle", file), join(folder, file));
		}
		return folder;
	}

	function openDb(name: string) {
		const sqlite = new Database(join(workDir, name));
		sqlite.pragma("foreign_keys = ON");
		return { sqlite, db: drizzle(sqlite, { schema }) };
	}

	function hasUniqueIndex(sqlite: Database.Database): boolean {
		const indexes = sqlite
			.prepare("PRAGMA index_list(message_analytics)")
			.all() as Array<{ name: string; unique: number }>;
		return indexes.some((index) => index.name === INDEX && index.unique === 1);
	}

	/** A person, a chat and its replies, as the release before wrote them. */
	function seedReplies(sqlite: Database.Database, messageIds: string[]): void {
		sqlite
			.prepare(
				"INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run("user-1", "analytics-unique@example.com", "hash", 0, 0);
		sqlite
			.prepare(
				"INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)",
			)
			.run("chat-1", "user-1", "Synthetic");
		const insertMessage = sqlite.prepare(
			"INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)",
		);
		for (const id of messageIds) insertMessage.run(id, "chat-1", `reply ${id}`);
	}

	function insertTiming(
		sqlite: Database.Database,
		row: { id: string; messageId: string; generationTimeMs: number },
	): void {
		sqlite
			.prepare(
				"INSERT INTO message_analytics (id, message_id, user_id, model, generation_time_ms, first_token_ms) VALUES (?, ?, 'user-1', 'model1', ?, ?)",
			)
			.run(
				row.id,
				row.messageId,
				row.generationTimeMs,
				row.generationTimeMs / 2,
			);
	}

	function timingRows(sqlite: Database.Database) {
		return sqlite
			.prepare(
				"SELECT id, message_id AS messageId, generation_time_ms AS generationTimeMs FROM message_analytics ORDER BY message_id",
			)
			.all() as Array<{
			id: string;
			messageId: string;
			generationTimeMs: number;
		}>;
	}

	function runMigrationSqlAgain(sqlite: Database.Database): void {
		const migration = readMigrationFiles({
			migrationsFolder: "./drizzle",
		}).find((entry) => entry.folderMillis === 1777140000132);
		expect(migration).toBeDefined();
		for (const statement of migration?.sql ?? []) {
			if (statement.trim()) sqlite.exec(statement);
		}
	}

	it("keeps the row written last for each message and deletes the others", () => {
		const before = migrationsFolderBefore();
		const { sqlite, db } = openDb("serving.db");
		try {
			migrate(db, { migrationsFolder: before });
			expect(hasUniqueIndex(sqlite)).toBe(false);

			seedReplies(sqlite, ["saved-three-times", "saved-twice", "saved-once"]);
			// Ids that sort against the write order, so a rule that kept the
			// smallest or largest id could not pass by accident.
			insertTiming(sqlite, {
				id: "z-first",
				messageId: "saved-three-times",
				generationTimeMs: 9000,
			});
			insertTiming(sqlite, {
				id: "a-only",
				messageId: "saved-once",
				generationTimeMs: 1200,
			});
			insertTiming(sqlite, {
				id: "y-second",
				messageId: "saved-three-times",
				generationTimeMs: 8000,
			});
			insertTiming(sqlite, {
				id: "m-first",
				messageId: "saved-twice",
				generationTimeMs: 5000,
			});
			insertTiming(sqlite, {
				id: "b-last",
				messageId: "saved-three-times",
				generationTimeMs: 2600,
			});
			insertTiming(sqlite, {
				id: "c-last",
				messageId: "saved-twice",
				generationTimeMs: 700,
			});

			migrate(db, { migrationsFolder: "./drizzle" });

			expect(timingRows(sqlite)).toEqual([
				{ id: "a-only", messageId: "saved-once", generationTimeMs: 1200 },
				{
					id: "b-last",
					messageId: "saved-three-times",
					generationTimeMs: 2600,
				},
				{ id: "c-last", messageId: "saved-twice", generationTimeMs: 700 },
			]);
			expect(hasUniqueIndex(sqlite)).toBe(true);
			// Only timing rows go: the replies and the chat stay.
			expect(
				(
					sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
						count: number;
					}
				).count,
			).toBe(3);
		} finally {
			sqlite.close();
		}
	});

	it("then keeps one row per message: a second save of a message is ignored", () => {
		const { sqlite, db } = openDb("after.db");
		try {
			migrate(db, { migrationsFolder: "./drizzle" });
			seedReplies(sqlite, ["reply-1"]);
			insertTiming(sqlite, {
				id: "first",
				messageId: "reply-1",
				generationTimeMs: 3100,
			});

			// The writer's own statement (analytics.ts, `onConflictDoNothing()`).
			sqlite
				.prepare(
					"INSERT INTO message_analytics (id, message_id, user_id, model, generation_time_ms) VALUES ('second', 'reply-1', 'user-1', 'model1', 4100) ON CONFLICT DO NOTHING",
				)
				.run();
			expect(timingRows(sqlite)).toEqual([
				{ id: "first", messageId: "reply-1", generationTimeMs: 3100 },
			]);
			expect(() =>
				insertTiming(sqlite, {
					id: "third",
					messageId: "reply-1",
					generationTimeMs: 5100,
				}),
			).toThrow(/UNIQUE constraint failed: message_analytics\.message_id/);
		} finally {
			sqlite.close();
		}
	});

	it("can run again: its statements change nothing on a database they already ran on", () => {
		const { sqlite, db } = openDb("twice.db");
		try {
			migrate(db, { migrationsFolder: "./drizzle" });
			seedReplies(sqlite, ["reply-1", "reply-2"]);
			insertTiming(sqlite, {
				id: "one",
				messageId: "reply-1",
				generationTimeMs: 1000,
			});
			insertTiming(sqlite, {
				id: "two",
				messageId: "reply-2",
				generationTimeMs: 2000,
			});

			runMigrationSqlAgain(sqlite);

			expect(timingRows(sqlite)).toEqual([
				{ id: "one", messageId: "reply-1", generationTimeMs: 1000 },
				{ id: "two", messageId: "reply-2", generationTimeMs: 2000 },
			]);
			expect(hasUniqueIndex(sqlite)).toBe(true);
		} finally {
			sqlite.close();
		}
	});

	it("runs on a database that already had the index (one made from schema.ts by drizzle-kit push)", () => {
		const before = migrationsFolderBefore();
		const { sqlite, db } = openDb("pushed.db");
		try {
			migrate(db, { migrationsFolder: before });
			sqlite.exec(
				`CREATE UNIQUE INDEX \`${INDEX}\` ON \`message_analytics\` (\`message_id\`)`,
			);
			seedReplies(sqlite, ["reply-1"]);
			insertTiming(sqlite, {
				id: "one",
				messageId: "reply-1",
				generationTimeMs: 1000,
			});

			migrate(db, { migrationsFolder: "./drizzle" });

			expect(timingRows(sqlite)).toEqual([
				{ id: "one", messageId: "reply-1", generationTimeMs: 1000 },
			]);
			expect(hasUniqueIndex(sqlite)).toBe(true);
		} finally {
			sqlite.close();
		}
	});

	it("gives a fresh database the index", () => {
		const { sqlite, db } = openDb("fresh.db");
		try {
			migrate(db, { migrationsFolder: "./drizzle" });
			expect(hasUniqueIndex(sqlite)).toBe(true);
		} finally {
			sqlite.close();
		}
	});
});
