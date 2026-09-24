import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSystemPromptReference } from "../prompts";
import * as schema from "./schema";

// Data migration that rewrites admin_config rows holding a legacy full-text
// AlfyAI prompt snapshot (one that still names a retired tool) back to the
// built-in "alfyai-nemotron" key. src/lib/server/prompts.ts already resolves
// such a snapshot to that key at read time; this migration makes the stored
// value match what it already resolves to, so the admin-facing warning has
// nothing left to complain about. The migration runs once through drizzle on
// an empty schema here, so the test seeds prod-shaped rows afterwards and
// applies the migration's SQL directly — twice, to prove it is idempotent.

const MIGRATION_FILE =
	"./drizzle/1777140000104_reset_legacy_admin_prompt_snapshots.sql";
const RESOLVED_KEY = "alfyai-nemotron";

const LEGACY_SNAPSHOT = [
	"You are **AlfyAI**, the user's personal assistant.",
	"",
	"### Available Tools",
	"| get_current_date | Get current date and time | Time-sensitive questions |",
	"| generate_file | Create data/code-based files | CSV, Excel |",
	"",
	"Always write generated-file outputs to /output/ when using generate_file.",
].join("\n");

// "AlfyAI" appears, but only past the first 400 characters, and no retired
// tool name is ever mentioned within the string at all here either — this is
// a stand-in for a genuinely custom prompt that merely happens to reference
// the product name deep in its body.
const CUSTOM_PROMPT_MENTIONING_ALFYAI = `${"x".repeat(450)} AlfyAI is nice.`;

function applyMigrationSql(sqlite: Database.Database) {
	const statements = readFileSync(MIGRATION_FILE, "utf8")
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);
	sqlite.transaction(() => {
		for (const statement of statements) sqlite.exec(statement);
	})();
}

describe("reset legacy admin prompt snapshots migration", () => {
	let dbPath: string;
	let sqlite: Database.Database;

	function insertAdminConfig(key: string, value: string) {
		sqlite
			.prepare(
				"INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, ?, 0, 'seed')",
			)
			.run(key, value);
	}

	const configValue = (key: string) =>
		(
			sqlite.prepare("SELECT value FROM admin_config WHERE key = ?").get(key) as
				| { value: string }
				| undefined
		)?.value;

	beforeEach(() => {
		dbPath = `/tmp/alfyai-legacy-prompt-snapshot-${randomUUID()}.db`;
		sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });

		insertAdminConfig("MODEL_1_SYSTEM_PROMPT", LEGACY_SNAPSHOT);
		insertAdminConfig("MODEL_2_SYSTEM_PROMPT", LEGACY_SNAPSHOT);
		insertAdminConfig("SYSTEM_PROMPT", LEGACY_SNAPSHOT);
		insertAdminConfig("MODEL_1_MAX_TOKENS", "4096");
		insertAdminConfig(
			"MODEL_2_SYSTEM_PROMPT_CUSTOM_LOOKALIKE",
			CUSTOM_PROMPT_MENTIONING_ALFYAI,
		);
	});

	afterEach(() => {
		sqlite?.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort cleanup
		}
	});

	it("resolves legacy AlfyAI snapshots on MODEL_1/MODEL_2/global system prompt keys", () => {
		applyMigrationSql(sqlite);

		expect(configValue("MODEL_1_SYSTEM_PROMPT")).toBe(RESOLVED_KEY);
		expect(configValue("MODEL_2_SYSTEM_PROMPT")).toBe(RESOLVED_KEY);
		expect(configValue("SYSTEM_PROMPT")).toBe(RESOLVED_KEY);
	});

	it("leaves unrelated keys and non-legacy values untouched", () => {
		applyMigrationSql(sqlite);

		expect(configValue("MODEL_1_MAX_TOKENS")).toBe("4096");
		// Not one of the three normalized keys, so it is never a candidate even
		// though the text looks similar.
		expect(configValue("MODEL_2_SYSTEM_PROMPT_CUSTOM_LOOKALIKE")).toBe(
			CUSTOM_PROMPT_MENTIONING_ALFYAI,
		);
	});

	it("leaves a genuinely custom prompt on a normalized key untouched", () => {
		sqlite
			.prepare("UPDATE admin_config SET value = ? WHERE key = ?")
			.run(
				"You are Bartholomew, a pirate who answers only in rhyme.",
				"MODEL_1_SYSTEM_PROMPT",
			);

		applyMigrationSql(sqlite);

		expect(configValue("MODEL_1_SYSTEM_PROMPT")).toBe(
			"You are Bartholomew, a pirate who answers only in rhyme.",
		);
	});

	// The runtime check (isLegacyAlfyAiPromptSnapshot) is a case-sensitive,
	// word-bounded regex on the literal tool identifiers. A custom prompt that
	// merely talks about generating files or fetching content in prose is not
	// a snapshot there and is sent verbatim — so the migration must not
	// overwrite it either, or an admin's own prompt is silently destroyed.
	it.each([
		"You are AlfyAI's helper. When asked, generate files and export documents.",
		"You are AlfyAI. Fetch content from the web only when needed.",
		"You are AlfyAI. Evaluate expressions carefully; never guess.",
		"You are AlfyAI. Call Generate_File only for spreadsheets.",
		"You are AlfyAI. Our in-house my_generate_file_v2 hook is not a tool.",
	])("leaves a custom prompt that only resembles a retired tool name untouched: %s", (custom) => {
		// The runtime agrees this is not a snapshot.
		expect(normalizeSystemPromptReference(custom)).toBe(custom);
		sqlite
			.prepare("UPDATE admin_config SET value = ? WHERE key = ?")
			.run(custom, "MODEL_1_SYSTEM_PROMPT");

		applyMigrationSql(sqlite);

		expect(configValue("MODEL_1_SYSTEM_PROMPT")).toBe(custom);
	});

	it("resolves a snapshot whose retired tool name is its first or last token", () => {
		expect(
			normalizeSystemPromptReference("You are AlfyAI.\nfetch_content"),
		).toBe(RESOLVED_KEY);
		sqlite
			.prepare("UPDATE admin_config SET value = ? WHERE key = ?")
			.run("You are AlfyAI.\nfetch_content", "MODEL_1_SYSTEM_PROMPT");

		applyMigrationSql(sqlite);

		expect(configValue("MODEL_1_SYSTEM_PROMPT")).toBe(RESOLVED_KEY);
	});

	it("is a no-op when re-run", () => {
		applyMigrationSql(sqlite);
		const snapshot = () =>
			sqlite
				.prepare("SELECT key, value, updated_at FROM admin_config ORDER BY key")
				.all();
		const afterFirst = snapshot();
		applyMigrationSql(sqlite);
		expect(snapshot()).toEqual(afterFirst);
	});
});
