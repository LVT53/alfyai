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
 * Session tokens are stored hashed from the release that carries this
 * migration, and the expiry is written in seconds. Every row the release before
 * wrote has the raw token as its id and a millisecond count in `expires_at`, so
 * none of them can be found any more. The migration removes them: everyone signs
 * in once after the deploy.
 *
 * The database that matters is a running one with live sessions, not a fresh
 * one, so this upgrades a database that stood at the previous release.
 */

const CLEAR_TAG = "1777140000117_clear_sessions_for_hashed_tokens";

describe("clear sessions for hashed tokens migration", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "alfyai-clear-sessions-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/**
	 * The migrations folder as it stood the moment BEFORE this migration: every
	 * entry up to it, and none after (see the same helper in `schema.test.ts`).
	 */
	function migrationsFolderBeforeClear(): string {
		const folder = join(workDir, "drizzle-before");
		if (existsSync(folder)) return folder;
		mkdirSync(join(folder, "meta"), { recursive: true });

		const journal = JSON.parse(
			readFileSync("./drizzle/meta/_journal.json", "utf8"),
		) as { entries: Array<{ tag: string }> };
		const cutoff = journal.entries.findIndex(
			(entry) => entry.tag === CLEAR_TAG,
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

	function count(sqlite: Database.Database, table: string): number {
		return (
			sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
				count: number;
			}
		).count;
	}

	it("empties the sessions of a database that is serving people, and keeps the people", () => {
		const before = migrationsFolderBeforeClear();
		const { sqlite, db } = openDb("serving.db");
		try {
			migrate(db, { migrationsFolder: before });

			sqlite
				.prepare(
					"INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("user-1", "clear-sessions@example.com", "hash", 0, 0);
			// Rows as the previous release wrote them: the raw token as the id,
			// the expiry as a millisecond count.
			const insertSession = sqlite.prepare(
				"INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
			);
			insertSession.run("a".repeat(64), "user-1", Date.now() + 86_400_000);
			insertSession.run("b".repeat(64), "user-1", Date.now() + 1_209_600_000);
			expect(count(sqlite, "sessions")).toBe(2);

			migrate(db, { migrationsFolder: "./drizzle" });

			expect(count(sqlite, "sessions")).toBe(0);
			expect(count(sqlite, "users")).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it("leaves the sessions table in place for the next sign-in to use", () => {
		const { sqlite, db } = openDb("fresh.db");
		try {
			migrate(db, { migrationsFolder: "./drizzle" });

			expect(count(sqlite, "sessions")).toBe(0);
			sqlite
				.prepare(
					"INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("user-2", "after@example.com", "hash", 0, 0);
			sqlite
				.prepare(
					"INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
				)
				.run("c".repeat(64), "user-2", Math.floor(Date.now() / 1000) + 3600);
			expect(count(sqlite, "sessions")).toBe(1);
		} finally {
			sqlite.close();
		}
	});
});
