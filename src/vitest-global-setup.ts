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
 * Vitest global setup: provisions the template test database.
 *
 * `src/lib/server/db/index.ts` opens `getDatabasePath()` at import time, which
 * defaults to `./data/chat.db`. That directory is gitignored local state, so on
 * a fresh clone (or CI) every test that touches the shared `db` singleton
 * without mocking it would fail with "Cannot open database because the
 * directory does not exist" -- or, on a developer machine, silently run
 * against a real (and possibly stale, un-migrated) dev database.
 *
 * Instead we create a throwaway directory under the OS temp dir and apply
 * every Drizzle migration to a fresh SQLite file there. That file is a
 * *template*, never opened by test code directly: `src/vitest-setup.ts`
 * copies it once per worker before `DATABASE_PATH` is set, so each worker's
 * better-sqlite3 connection (WAL mode, see db/index.ts) has the file to
 * itself. Two connections sharing one WAL file across separate processes hit
 * immediate `SQLITE_BUSY` "database is locked" errors on ordinary snapshot
 * conflicts -- a deferred transaction that reads and then writes after
 * another connection committed in between can't be rescued by a busy-timeout
 * retry, because there is no lock to wait out. Production never sees this
 * (one process, one connection); parallel test workers did.
 *
 * The WAL is force-checkpointed before this connection closes so the
 * template file alone (no `-wal`/`-shm` sidecars needed) is a complete,
 * migrated database that a plain file copy can reproduce. The whole
 * directory -- template plus every worker's copy -- is removed when the run
 * ends.
 */
export default function setup(project: TestProject) {
	const directory = mkdtempSync(join(tmpdir(), "alfyai-vitest-"));
	const databasePath = join(directory, "chat.db");

	const sqlite = new Database(databasePath);
	try {
		sqlite.pragma("journal_mode = WAL");
		migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
		// Flush every WAL frame back into the main file and drop the WAL/SHM
		// sidecars. Closing the last connection to a WAL database normally
		// checkpoints too, but that's incidental cleanup -- copying this file
		// (src/vitest-setup.ts) depends on it, so make it explicit.
		sqlite.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		sqlite.close();
	}

	project.provide("alfyaiTestDatabasePath", databasePath);

	return () => {
		rmSync(directory, { recursive: true, force: true });
	};
}
