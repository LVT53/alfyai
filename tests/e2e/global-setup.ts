import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

const E2E_SESSION_SECRET =
	process.env.SESSION_SECRET ||
	"e2e-test-session-secret-long-enough-1234567890";
const DEFAULT_E2E_DB_PATH = join(
	process.cwd(),
	"data",
	"playwright-e2e-chat.db",
);

// Tables that must never be wiped: drizzle's migration bookkeeping. Everything
// else is user/runtime data that a fresh e2e run should start without.
const PRESERVED_TABLES = new Set(["__drizzle_migrations"]);

function removeDatabaseFiles(dbPath: string) {
	for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
		rmSync(path, { force: true });
	}
}

/**
 * Wipe all user/runtime data IN PLACE, without deleting the database file.
 *
 * Why in-place rather than rm + recreate: Playwright starts `config.webServer`
 * BEFORE `globalSetup`. If we delete the DB file here, the already-running
 * server keeps the now-unlinked inode open (SQLite/Linux semantics), so every
 * subsequent login reads an empty old file while our seed lands in the new one
 * — producing 401s across the whole suite. Deleting rows instead keeps the
 * server's open file handle valid, so seeded data is visible to the server.
 *
 * We disable foreign keys for the duration of the wipe so table order does not
 * matter, DELETE from every table except drizzle's migration ledger, then
 * re-enable foreign keys.
 */
function wipeUserData(dbPath: string) {
	const db = new Database(dbPath);
	try {
		db.pragma("foreign_keys = OFF");
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
			)
			.all() as { name: string }[];
		db.transaction(() => {
			for (const { name } of tables) {
				if (PRESERVED_TABLES.has(name)) continue;
				db.prepare(`DELETE FROM "${name}"`).run();
			}
		})();
		db.pragma("foreign_keys = ON");
	} finally {
		db.close();
	}
}

export default async function globalSetup() {
	const dbDir = join(process.cwd(), "data");
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}

	const dbPath = process.env.E2E_DATABASE_PATH || DEFAULT_E2E_DB_PATH;
	const isDefaultPath = resolve(dbPath) === resolve(DEFAULT_E2E_DB_PATH);

	// Hard file-deletion reset is ONLY safe when the path is non-default: the
	// default path is the one the already-running webServer has open, and
	// unlinking it there strands the server on a deleted inode (see wipeUserData
	// docstring). For the default path we always do an in-place SQL wipe.
	if (!isDefaultPath && process.env.E2E_RESET_DATABASE === "true") {
		removeDatabaseFiles(dbPath);
	}

	// Run migrations FIRST: idempotent, and creates the file if it is missing.
	try {
		execSync("npm run db:prepare", {
			stdio: "pipe",
			env: {
				...process.env,
				DATABASE_PATH: dbPath,
				E2E_DATABASE_PATH: dbPath,
				SESSION_SECRET: E2E_SESSION_SECRET,
			},
		});
	} catch (err) {
		console.warn(
			"[globalSetup] db:prepare failed:",
			(err as Error).message?.slice(0, 200),
		);
	}

	// In-place wipe of all user/runtime data. Keeps the server's open inode
	// valid so seeded rows are visible to it.
	try {
		wipeUserData(dbPath);
	} catch (err) {
		console.warn(
			"[globalSetup] Database wipe failed:",
			(err as Error).message?.slice(0, 200),
		);
	}

	try {
		execSync(
			`npx tsx scripts/seed-admin.ts --email=admin@local --password=admin123 --name="Admin User" --admin`,
			{
				stdio: "pipe",
				env: {
					...process.env,
					DATABASE_PATH: dbPath,
					E2E_DATABASE_PATH: dbPath,
					SESSION_SECRET: E2E_SESSION_SECRET,
				},
			},
		);
		console.log("[globalSetup] Test admin seeded: admin@local");
	} catch (err) {
		console.warn(
			"[globalSetup] Seed admin failed:",
			(err as Error).message?.slice(0, 200),
		);
	}
}
