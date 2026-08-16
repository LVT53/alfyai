import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { DatabaseInstance } from "./index";
import * as schema from "./schema";

export interface InMemoryDatabase {
	db: DatabaseInstance;
	sqlite: InstanceType<typeof Database>;
	close(): void;
}

/**
 * The second query-execution adapter required by ADR-0059: an ephemeral,
 * fully migrated SQLite database that lives only in process memory.
 *
 * Before this, the only way to get a `DatabaseInstance` was the file-backed
 * bootstrap in `./index.ts`, and every test that needed real query behavior
 * hand-rolled its own temp-file-plus-migrate-plus-cleanup boilerplate (see
 * git history on the test files this slice converts). This centralizes
 * that into one adapter: no temp file, no `DATABASE_PATH` env juggling, no
 * `vi.resetModules()` dance, no manual `unlinkSync` cleanup — construct it,
 * use it, call `close()`.
 *
 * It is what proves the seam is honestly backend-agnostic: services hand
 * the exact same composed-query callbacks to `QueryExecutor.run` regardless
 * of which adapter backs it. `createQueryExecutor(createInMemoryDatabase().db)`
 * runs that code unchanged.
 */
export function createInMemoryDatabase(): InMemoryDatabase {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return {
		db,
		sqlite,
		close: () => sqlite.close(),
	};
}
