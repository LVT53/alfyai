// A database as the release BEFORE a kind's migration left it.
//
// Each kind's slice has a test that is about a database that is NOT fresh: the rows
// the previous release left, upgraded the way a deploy upgrades them. `migrate()`
// over an empty file can never show that, so the helper of a kind stops the
// migrations one entry before the kind's own, lets the test seed rows with the old
// release's column set and words, and only then runs the rest. The part every one of
// them needs is here: build the file at that point, and write a row by column name.

import {
	copyFileSync,
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

export type SeedValue = string | number | null;

export interface DatabaseBeforeMigration {
	/** The directory the database lives in: `cleanup` removes it. */
	workDir: string;
	dbPath: string;
	sqlite: Database.Database;
}

/**
 * A fresh database migrated up to, and not including, the journal entry `tag`. The
 * journal is truncated and only the SQL it still lists is copied, which is what makes
 * the later `migrate()` over `./drizzle` a real upgrade step and not a replay.
 */
export function migrateUpToBefore(
	tag: string,
	workDirPrefix: string,
): DatabaseBeforeMigration {
	const workDir = mkdtempSync(join(tmpdir(), workDirPrefix));
	const before = join(workDir, "drizzle-before");

	const journal = JSON.parse(
		readFileSync("./drizzle/meta/_journal.json", "utf8"),
	) as { entries: Array<{ tag: string }> };
	const cutoff = journal.entries.findIndex((entry) => entry.tag === tag);
	if (cutoff <= 0) {
		rmSync(workDir, { recursive: true, force: true });
		throw new Error(
			`The journal has no entry ${tag}: the pre-migration database cannot be built.`,
		);
	}
	const kept = journal.entries.slice(0, cutoff);
	const keptTags = new Set(kept.map((entry) => entry.tag));
	mkdirSync(join(before, "meta"), { recursive: true });
	writeFileSync(
		join(before, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries: kept }),
	);
	for (const file of readdirSync("./drizzle")) {
		if (!file.endsWith(".sql")) continue;
		if (!keptTags.has(file.slice(0, -".sql".length))) continue;
		copyFileSync(join("./drizzle", file), join(before, file));
	}

	const dbPath = join(workDir, "pre-engine.db");
	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite), { migrationsFolder: before });
	return { workDir, dbPath, sqlite };
}

/** Writes one row by column name, the way the previous release's own statements did. */
export function insertRow(
	sqlite: Database.Database,
	table: string,
	row: Record<string, SeedValue>,
	verb = "INSERT",
): void {
	const columns = Object.keys(row);
	sqlite
		.prepare(
			`${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		)
		.run(...columns.map((column) => row[column]));
}

/** Closes the database (it may be closed already) and removes its directory. */
export function removeDatabaseBeforeMigration(
	database: DatabaseBeforeMigration,
): void {
	try {
		database.sqlite.close();
	} catch {
		// Closed by the test already.
	}
	rmSync(database.workDir, { recursive: true, force: true });
}
