// @always-run: uses the migration journal and SQL files.
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
 * The permanent tester rule (Memory redesign §5): the tester account is
 * excluded from every migration of existing Memory data, forever. The flag is
 * set once, here, by the account's address; from then on it is read by user
 * id. The database that matters is one already serving people, so this
 * upgrades a database that stood at the release before the migration.
 */

const TAG = "1777140000141_users_memory_migration_excluded";

describe("users memory migration exclusion migration", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "alfyai-memory-excluded-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/** The migrations folder as it stood the moment BEFORE this migration. */
	function migrationsFolderBefore(): string {
		const folder = join(workDir, "drizzle-before");
		if (existsSync(folder)) return folder;
		mkdirSync(join(folder, "meta"), { recursive: true });
		const journal = JSON.parse(
			readFileSync("./drizzle/meta/_journal.json", "utf8"),
		) as { entries: Array<{ tag: string; when: number }> };
		const cutoff = journal.entries.findIndex((entry) => entry.tag === TAG);
		expect(cutoff).toBeGreaterThan(0);
		expect(journal.entries[cutoff].when).toBe(1777140000141);
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

	it("flags the tester account, whatever the address's case, and nobody else", () => {
		const sqlite = new Database(join(workDir, "upgrade.db"));
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: migrationsFolderBefore() });
		sqlite
			.prepare(
				"INSERT INTO users (id, email, password_hash) VALUES ('tester', 'Tester@Tester.com', 'h'), ('person', 'person@example.com', 'h'), ('near', 'tester@tester.com.example', 'h')",
			)
			.run();

		migrate(db, { migrationsFolder: "./drizzle" });

		const rows = db
			.select({
				id: schema.users.id,
				excluded: schema.users.memoryMigrationExcluded,
			})
			.from(schema.users)
			.all()
			.sort((a, b) => a.id.localeCompare(b.id));
		expect(rows).toEqual([
			{ id: "near", excluded: false },
			{ id: "person", excluded: false },
			{ id: "tester", excluded: true },
		]);
		sqlite.close();
	});

	it("gives an account made after the migration no flag, the tester's address included", () => {
		const sqlite = new Database(join(workDir, "fresh.db"));
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
		db.insert(schema.users)
			.values([
				{ id: "a", email: "a@example.com", passwordHash: "h" },
				{ id: "t", email: "tester@tester.com", passwordHash: "h" },
			])
			.run();
		expect(
			db
				.select({ excluded: schema.users.memoryMigrationExcluded })
				.from(schema.users)
				.all()
				.map((row) => row.excluded),
		).toEqual([false, false]);
		sqlite.close();
	});
});
