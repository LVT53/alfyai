// Test util: loads a test file's heavy, lazily imported module graphs once, so
// the first test does not pay for them.
//
// Tests reset the module registry per test so the app sees its own database
// file; the first evaluation of a graph (artifacts, analytics, sharp, the job
// engine) is then what the first test pays: seconds under a loaded full run.
// Call this from `beforeAll` and the tests only re-evaluate cached modules.

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { vi } from "vitest";
import * as schema from "$lib/server/db/schema";

/**
 * Points `DATABASE_PATH` at a throwaway migrated file for the imports (the
 * database module opens its file when loaded), closes it, restores the
 * variable and resets the registry so no test sees this copy.
 */
export async function warmModules(
	loaders: Array<() => Promise<unknown>>,
): Promise<void> {
	const dbPath = join(tmpdir(), `alfyai-warm-${randomUUID()}.db`);
	const seed = new Database(dbPath);
	migrate(drizzle(seed, { schema }), { migrationsFolder: "./drizzle" });
	seed.close();
	const previous = process.env.DATABASE_PATH;
	process.env.DATABASE_PATH = dbPath;
	try {
		await Promise.all(loaders.map((load) => load()));
		// Closing the connection imports the database module, which may load it
		// for the first time here when no loader did. That is harmless: it opens
		// the throwaway file above and the registry reset below drops it.
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} finally {
		if (previous === undefined) delete process.env.DATABASE_PATH;
		else process.env.DATABASE_PATH = previous;
		for (const suffix of ["", "-wal", "-shm"]) {
			if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
		}
		vi.resetModules();
	}
}
