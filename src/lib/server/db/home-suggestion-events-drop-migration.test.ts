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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";

/**
 * `DROP TABLE home_suggestion_events` is the one migration in this change whose
 * whole job is to delete something, and the case it exists for is not a fresh
 * database: a fresh database would never grow the table in the first place.
 *
 * The database that matters is the one already running the previous release —
 * it ran `1777140000095_home_suggestion_events.sql` months ago, holds rows
 * nobody will ever read again, and must lose the table when the new code's
 * `migrate()` runs. Drizzle decides what to apply by comparing each migration's
 * `folderMillis` against the newest `created_at` in `__drizzle_migrations`, so
 * the drop only reaches that database because it is a *new journal entry with a
 * higher `when`*, not because its SQL changed. Editing an already-applied
 * migration would leave the table standing on every deployed instance while a
 * fresh test database looked correct, which is exactly the failure this file is
 * here to make impossible to reintroduce.
 */

const DROP_TAG = "1777140000110_drop_home_suggestion_events";
const CREATE_TAG = "1777140000095_home_suggestion_events";

describe("home suggestion events drop migration", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "alfyai-drop-events-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/**
	 * The migrations folder as it stood the moment BEFORE the drop: every entry
	 * up to it, and none after. Truncating the journal and copying only the SQL
	 * it still lists is what makes the second `migrate()` below a real upgrade
	 * step rather than a replay — see the same helper in `schema.test.ts`.
	 */
	function migrationsFolderBeforeDrop(): string {
		const folder = join(workDir, "drizzle-before");
		if (existsSync(folder)) return folder;
		mkdirSync(join(folder, "meta"), { recursive: true });

		const journal = JSON.parse(
			readFileSync("./drizzle/meta/_journal.json", "utf8"),
		) as { entries: Array<{ tag: string }> };
		const cutoff = journal.entries.findIndex((entry) => entry.tag === DROP_TAG);
		expect(cutoff).toBeGreaterThan(0);
		const kept = journal.entries.slice(0, cutoff);
		const keptTags = new Set(kept.map((entry) => entry.tag));
		// The setup is only meaningful if the table was genuinely created before
		// the drop — otherwise "the table is gone" would prove nothing.
		expect(keptTags.has(CREATE_TAG)).toBe(true);

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

	function tableExists(sqlite: Database.Database, name: string): boolean {
		const row = sqlite
			.prepare(
				"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
			)
			.get(name) as { count: number };
		return row.count > 0;
	}

	it("drops the table from a database that already created and used it", () => {
		const before = migrationsFolderBeforeDrop();
		const { sqlite, db } = openDb("stale-database.db");
		try {
			migrate(db, { migrationsFolder: before });
			// The precondition the whole test rests on: this database really did
			// have the table, created by the shipped migration.
			expect(tableExists(sqlite, "home_suggestion_events")).toBe(true);

			sqlite
				.prepare(
					"INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("user-1", "drop-migration@example.com", "hash", 0, 0);
			sqlite
				.prepare(
					"INSERT INTO home_suggestion_events (id, user_id, candidate_key, event, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run("event-1", "user-1", "atlas:job-1", "shown", 0, 9999999999);
			expect(
				(
					sqlite
						.prepare("SELECT COUNT(*) AS count FROM home_suggestion_events")
						.get() as { count: number }
				).count,
			).toBe(1);

			migrate(db, { migrationsFolder: "./drizzle" });

			expect(tableExists(sqlite, "home_suggestion_events")).toBe(false);
		} finally {
			sqlite.close();
		}
	});

	it("is a no-op for a database that never had the table", () => {
		const before = migrationsFolderBeforeDrop();
		const { sqlite, db } = openDb("never-had-it.db");
		try {
			migrate(db, { migrationsFolder: before });
			sqlite.exec("DROP TABLE home_suggestion_events");

			expect(() =>
				migrate(db, { migrationsFolder: "./drizzle" }),
			).not.toThrow();
			expect(tableExists(sqlite, "home_suggestion_events")).toBe(false);
		} finally {
			sqlite.close();
		}
	});

	it("is the last entry in the journal, so nothing it drops is recreated after it", () => {
		const journal = JSON.parse(
			readFileSync("./drizzle/meta/_journal.json", "utf8"),
		) as { entries: Array<{ idx: number; tag: string; when: number }> };
		const drop = journal.entries.find((entry) => entry.tag === DROP_TAG);
		expect(drop).toBeDefined();
		// A later migration that recreated the table would silently undo this
		// one; the drop has to stay at the end of the queue it was appended to.
		expect(drop?.idx).toBe(
			Math.max(...journal.entries.map((entry) => entry.idx)),
		);
		expect(drop?.when).toBe(
			Math.max(...journal.entries.map((entry) => entry.when)),
		);
	});
});
