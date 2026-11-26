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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";

/**
 * "Send with Enter" (Settings > Profile) is a person's own switch, off by
 * default: off is the keys every account had before the switch existed (Enter
 * writes a new line, Ctrl/Cmd+Enter sends). The database that matters is one
 * already serving people, so this upgrades a database that stood at the
 * release before the migration and checks that nobody's keys changed.
 */

const TAG = "1777140000134_users_send_with_enter";

describe("users send with enter migration", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "alfyai-send-with-enter-"));
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
		) as { entries: Array<{ tag: string }> };
		const cutoff = journal.entries.findIndex((entry) => entry.tag === TAG);
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

	it("keeps Enter writing a new line for every account that existed before it", () => {
		const sqlite = new Database(join(workDir, "upgrade.db"));
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: migrationsFolderBefore() });
		sqlite
			.prepare(
				"INSERT INTO users (id, email, password_hash) VALUES ('old-1', 'old-1@example.com', 'h'), ('old-2', 'old-2@example.com', 'h')",
			)
			.run();

		migrate(db, { migrationsFolder: "./drizzle" });

		const rows = db
			.select({ id: schema.users.id, on: schema.users.sendWithEnter })
			.from(schema.users)
			.all();
		expect(rows).toEqual([
			{ id: "old-1", on: false },
			{ id: "old-2", on: false },
		]);
		sqlite.close();
	});

	it("gives a new account the switch off, and keeps one person's on to that person", () => {
		const sqlite = new Database(join(workDir, "fresh.db"));
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
		db.insert(schema.users)
			.values([
				{ id: "a", email: "a@example.com", passwordHash: "h" },
				{ id: "b", email: "b@example.com", passwordHash: "h" },
			])
			.run();

		db.update(schema.users)
			.set({ sendWithEnter: true })
			.where(eq(schema.users.id, "a"))
			.run();

		const read = (id: string) =>
			db
				.select({ on: schema.users.sendWithEnter })
				.from(schema.users)
				.where(eq(schema.users.id, id))
				.get()?.on;
		expect(read("a")).toBe(true);
		expect(read("b")).toBe(false);
		sqlite.close();
	});
});
