import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		alfyaiTestDatabasePath: string;
	}
}

/**
 * Vitest global setup: provisions the default test database.
 *
 * `src/lib/server/db/index.ts` opens `getDatabasePath()` at import time, which
 * defaults to `./data/chat.db`. That directory is gitignored local state, so on
 * a fresh clone (or CI) every test that touches the shared `db` singleton
 * without mocking it would fail with "Cannot open database because the
 * directory does not exist" -- or, on a developer machine, silently run
 * against a real (and possibly stale, un-migrated) dev database.
 *
 * Instead we create a throwaway directory under the OS temp dir, apply every
 * Drizzle migration to a fresh SQLite file there, and hand the path to each
 * worker via `provide`; `src/vitest-setup.ts` exports it as `DATABASE_PATH`
 * before any test module loads. The directory is removed when the run ends.
 */
export default function setup(project: TestProject) {
	const directory = mkdtempSync(join(tmpdir(), "alfyai-vitest-"));
	const databasePath = join(directory, "chat.db");

	const sqlite = new Database(databasePath);
	try {
		sqlite.pragma("journal_mode = WAL");
		migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
	} finally {
		sqlite.close();
	}

	project.provide("alfyaiTestDatabasePath", databasePath);

	return () => {
		rmSync(directory, { recursive: true, force: true });
	};
}
