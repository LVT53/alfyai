// @always-run: uses the migration journal and SQL files.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryDatabase, type InMemoryDatabase } from "./in-memory";
import * as schema from "./schema";

/**
 * Workspace Search Stage B: message text and the text of documents and files
 * live in two trigram full-text indexes, kept in step by triggers. These tests
 * read the index the way the search does (`MATCH`), on a database upgraded
 * from the release before the index and on one built by every migration, so a
 * later migration that drops a trigger or rebuilds a table fails here.
 */

const TAG = "1777140000145_workspace_search_index";
const BEFORE = new Date("2026-11-20T10:00:00.000Z");

type IndexedTable = "messages" | "artifacts";

const TRIGGERS: ReadonlyArray<readonly [IndexedTable, string]> = [
	["messages", "messages_fts_insert"],
	["messages", "messages_fts_update"],
	["messages", "messages_fts_delete"],
	["artifacts", "artifacts_fts_insert"],
	["artifacts", "artifacts_fts_update"],
	["artifacts", "artifacts_fts_delete"],
];

/** The base rows the index holds, by id: every one, or those whose text holds the phrase. */
function indexedIds(
	sqlite: Database.Database,
	table: IndexedTable,
	phrase?: string,
): string[] {
	const index = `${table}_fts`;
	const match = phrase ? `WHERE ${index} MATCH ?` : "";
	const rows = sqlite
		.prepare(
			`SELECT id FROM ${table} WHERE rowid IN (SELECT rowid FROM ${index} ${match}) ORDER BY id`,
		)
		.pluck()
		.all(...(phrase ? [`"${phrase}"`] : [])) as string[];
	return rows;
}

/** How many index rows carry one base row's row id (one, or none). */
function indexRowsOf(
	sqlite: Database.Database,
	table: IndexedTable,
	id: string,
): number {
	return sqlite
		.prepare(
			`SELECT count(*) FROM ${table}_fts WHERE rowid = (SELECT rowid FROM ${table} WHERE id = ?)`,
		)
		.pluck()
		.get(id) as number;
}

function addUser(sqlite: Database.Database, id: string): void {
	sqlite
		.prepare(
			"INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?)",
		)
		.run(
			id,
			`${id}@example.com`,
			BEFORE.getTime() / 1000,
			BEFORE.getTime() / 1000,
		);
}

function addChat(sqlite: Database.Database, id: string, userId: string): void {
	sqlite
		.prepare(
			"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(id, userId, id, BEFORE.getTime() / 1000, BEFORE.getTime() / 1000);
}

function addMessage(
	sqlite: Database.Database,
	id: string,
	conversationId: string,
	content: string,
): void {
	sqlite
		.prepare(
			"INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
		)
		.run(id, conversationId, content, BEFORE.getTime() / 1000);
}

function addArtifact(
	sqlite: Database.Database,
	row: {
		id: string;
		userId: string;
		type: string;
		contentText: string | null;
		kind?: string;
	},
): void {
	sqlite
		.prepare(
			"INSERT INTO artifacts (id, user_id, type, name, content_text, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			row.id,
			row.userId,
			row.type,
			row.id,
			row.contentText,
			row.kind ? JSON.stringify({ artifactType: row.kind }) : null,
			BEFORE.getTime() / 1000,
			BEFORE.getTime() / 1000,
		);
}

/** One row of every type and kind, each holding "Árvíz" in its text. */
function seedEveryKind(sqlite: Database.Database): void {
	addUser(sqlite, "u1");
	addUser(sqlite, "u2");
	addChat(sqlite, "c1", "u1");
	addChat(sqlite, "c2", "u2");
	addMessage(sqlite, "m1", "c1", "Árvíztűrő tükörfúrógép kell");
	addMessage(sqlite, "m2", "c1", "");
	addMessage(sqlite, "m3", "c2", "the ÁRVÍZ report");
	const text = (what: string) => `${what} about the Árvíz plans`;
	for (const row of [
		{
			id: "a-document",
			type: "artifact",
			kind: "document",
			contentText: text("A Document"),
		},
		{
			id: "a-slides",
			type: "artifact",
			kind: "slides",
			contentText: text("Slides"),
		},
		{
			id: "a-untyped",
			type: "artifact",
			contentText: text("An untyped artifact"),
		},
		{
			id: "a-image",
			type: "artifact",
			kind: "image",
			contentText: '{"prompt":"Árvíz picture"}',
		},
		{
			id: "a-video",
			type: "artifact",
			kind: "video",
			contentText: '{"prompt":"Árvíz clip"}',
		},
		{
			id: "a-canvas",
			type: "artifact",
			kind: "canvas",
			contentText: '{"nodes":[{"text":"Árvíz"}]}',
		},
		{
			id: "a-app",
			type: "artifact",
			kind: "app",
			contentText: "const árvíz = useState();",
		},
		{ id: "a-upload", type: "source_document", contentText: text("An upload") },
		{
			id: "a-normalized",
			type: "normalized_document",
			contentText: text("Extracted text"),
		},
		{
			id: "a-generated",
			type: "generated_output",
			contentText: text("A generated file"),
		},
		{ id: "a-skill", type: "skill_note", contentText: text("A Skill Note") },
		{
			id: "a-capsule",
			type: "work_capsule",
			contentText: text("A work capsule"),
		},
		{ id: "a-empty", type: "normalized_document", contentText: null },
	]) {
		addArtifact(sqlite, { userId: "u1", ...row });
	}
}

const TEXT_ARTIFACTS = [
	"a-document",
	"a-generated",
	"a-normalized",
	"a-skill",
	"a-slides",
	"a-untyped",
	"a-upload",
];

describe("the workspace search index migration", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "alfyai-search-index-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/** The migrations folder as it stood the moment BEFORE the index. */
	function migrationsFolderBefore(): string {
		const folder = join(workDir, "drizzle-before");
		if (existsSync(folder)) return folder;
		mkdirSync(join(folder, "meta"), { recursive: true });
		const journal = JSON.parse(
			readFileSync("./drizzle/meta/_journal.json", "utf8"),
		) as { entries: Array<{ tag: string; when: number }> };
		const cutoff = journal.entries.findIndex((entry) => entry.tag === TAG);
		expect(cutoff).toBeGreaterThan(0);
		expect(journal.entries[cutoff].when).toBe(1777140000145);
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

	it("indexes the text that was there before the migration, and only text", () => {
		const sqlite = new Database(join(workDir, "upgrade.db"));
		sqlite.pragma("foreign_keys = ON");
		try {
			migrate(drizzle(sqlite, { schema }), {
				migrationsFolder: migrationsFolderBefore(),
			});
			seedEveryKind(sqlite);
			migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });

			expect(indexedIds(sqlite, "messages", "arviz")).toEqual(["m1", "m3"]);
			expect(indexedIds(sqlite, "messages")).toEqual(["m1", "m3"]);
			expect(indexedIds(sqlite, "artifacts", "arviz")).toEqual(TEXT_ARTIFACTS);
			// Nothing else is in the index at all: no JSON, no code, no capsule, no empty row.
			expect(indexedIds(sqlite, "artifacts")).toEqual(TEXT_ARTIFACTS);
			expect(
				sqlite.prepare("SELECT count(*) FROM artifacts_fts").pluck().get(),
			).toBe(TEXT_ARTIFACTS.length);
		} finally {
			sqlite.close();
		}
	});
});

describe("the workspace search index after every migration", () => {
	let memory: InMemoryDatabase;

	afterEach(() => {
		memory?.close();
	});

	it("keeps its triggers after every migration", () => {
		memory = createInMemoryDatabase();
		const triggers = memory.sqlite
			.prepare(
				"SELECT tbl_name, name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_fts\\_%' ESCAPE '\\' ORDER BY tbl_name, name",
			)
			.all() as Array<{ tbl_name: string; name: string }>;
		expect(triggers.map((row) => [row.tbl_name, row.name])).toEqual(
			[...TRIGGERS].sort((left, right) =>
				`${left[0]} ${left[1]}`.localeCompare(`${right[0]} ${right[1]}`),
			),
		);
	});

	it("follows a message's insert, edit and delete, and its chat's and person's deletes", () => {
		memory = createInMemoryDatabase();
		const { sqlite } = memory;
		addUser(sqlite, "u1");
		addChat(sqlite, "c1", "u1");
		addMessage(sqlite, "m1", "c1", "first about the gardens");
		expect(indexedIds(sqlite, "messages", "garden")).toEqual(["m1"]);

		sqlite
			.prepare(
				"UPDATE messages SET content = 'now about the kitchens' WHERE id = 'm1'",
			)
			.run();
		expect(indexedIds(sqlite, "messages", "garden")).toEqual([]);
		expect(indexedIds(sqlite, "messages", "kitchen")).toEqual(["m1"]);

		sqlite
			.prepare("UPDATE messages SET metadata_json = '{}' WHERE id = 'm1'")
			.run();
		expect(indexRowsOf(sqlite, "messages", "m1")).toBe(1);

		sqlite.prepare("UPDATE messages SET content = '' WHERE id = 'm1'").run();
		expect(indexedIds(sqlite, "messages")).toEqual([]);
		sqlite
			.prepare(
				"UPDATE messages SET content = 'back to the orchard' WHERE id = 'm1'",
			)
			.run();
		expect(indexedIds(sqlite, "messages", "orchard")).toEqual(["m1"]);

		sqlite.prepare("DELETE FROM messages WHERE id = 'm1'").run();
		expect(indexedIds(sqlite, "messages", "orchard")).toEqual([]);

		addMessage(sqlite, "m2", "c1", "a harbour in the chat");
		sqlite.prepare("DELETE FROM conversations WHERE id = 'c1'").run();
		expect(
			sqlite.prepare("SELECT count(*) FROM messages_fts").pluck().get(),
		).toBe(0);

		addChat(sqlite, "c2", "u1");
		addMessage(sqlite, "m3", "c2", "a lighthouse of the person");
		expect(indexedIds(sqlite, "messages", "lighthouse")).toEqual(["m3"]);
		sqlite.prepare("DELETE FROM users WHERE id = 'u1'").run();
		expect(
			sqlite.prepare("SELECT count(*) FROM messages_fts").pluck().get(),
		).toBe(0);
	});

	it("follows an artifact's text, type and kind", () => {
		memory = createInMemoryDatabase();
		const { sqlite } = memory;
		addUser(sqlite, "u1");
		addArtifact(sqlite, {
			id: "doc",
			userId: "u1",
			type: "artifact",
			kind: "document",
			contentText: "orchard notes",
		});
		expect(indexedIds(sqlite, "artifacts", "orchard")).toEqual(["doc"]);

		sqlite
			.prepare(
				`UPDATE artifacts SET metadata_json = '{"artifactType":"document","documentLabel":"Notes"}' WHERE id = 'doc'`,
			)
			.run();
		expect(indexRowsOf(sqlite, "artifacts", "doc")).toBe(1);

		sqlite
			.prepare(
				`UPDATE artifacts SET metadata_json = '{"artifactType":"app"}' WHERE id = 'doc'`,
			)
			.run();
		expect(indexedIds(sqlite, "artifacts")).toEqual([]);
		sqlite
			.prepare(
				`UPDATE artifacts SET metadata_json = '{"artifactType":"document"}' WHERE id = 'doc'`,
			)
			.run();
		expect(indexedIds(sqlite, "artifacts", "orchard")).toEqual(["doc"]);

		sqlite
			.prepare("UPDATE artifacts SET type = 'work_capsule' WHERE id = 'doc'")
			.run();
		expect(indexedIds(sqlite, "artifacts")).toEqual([]);

		addArtifact(sqlite, {
			id: "text",
			userId: "u1",
			type: "normalized_document",
			contentText: "harbour text",
		});
		expect(indexedIds(sqlite, "artifacts", "harbour")).toEqual(["text"]);
		sqlite
			.prepare(
				"UPDATE artifacts SET content_text = 'lighthouse text' WHERE id = 'text'",
			)
			.run();
		expect(indexedIds(sqlite, "artifacts", "harbour")).toEqual([]);
		expect(indexedIds(sqlite, "artifacts", "lighthouse")).toEqual(["text"]);
		sqlite
			.prepare("UPDATE artifacts SET content_text = NULL WHERE id = 'text'")
			.run();
		expect(indexedIds(sqlite, "artifacts")).toEqual([]);
		sqlite
			.prepare(
				"UPDATE artifacts SET content_text = 'meadow text' WHERE id = 'text'",
			)
			.run();
		sqlite.prepare("DELETE FROM artifacts WHERE id = 'text'").run();
		expect(
			sqlite.prepare("SELECT count(*) FROM artifacts_fts").pluck().get(),
		).toBe(0);

		addArtifact(sqlite, {
			id: "made",
			userId: "u1",
			type: "generated_output",
			contentText: "a valley report",
		});
		sqlite.prepare("DELETE FROM users WHERE id = 'u1'").run();
		expect(
			sqlite.prepare("SELECT count(*) FROM artifacts_fts").pluck().get(),
		).toBe(0);
	});
});

// ── Guards on what later code and migrations may do ────────────────────────

const INDEXED_TABLES: readonly IndexedTable[] = ["messages", "artifacts"];

/**
 * A migration that rebuilds an indexed table (drops it, renames another table
 * into its place, or renames it away) gives its rows new row ids and drops its
 * triggers, so it must empty that table's index, refill it and create the
 * three triggers again in the same file.
 */
/** An optional schema before a table's name: main. or "main". or `main`. */
const SCHEMA = '([`"]?main[`"]?\\.)?';

function rebuildOffenders(files: Record<string, string>): string[] {
	const offenders: string[] = [];
	for (const [file, sqlText] of Object.entries(files)) {
		for (const table of INDEXED_TABLES) {
			// The table's name, quoted or not, perhaps after its schema, and ended.
			const name = `${SCHEMA}[\`"]?${table}[\`"]?`;
			const rebuilds = [
				new RegExp(`drop\\s+table\\s+(if\\s+exists\\s+)?${name}(\\s|;|$)`, "i"),
				new RegExp(`rename\\s+to\\s+${name}(\\s|;|$)`, "i"),
				new RegExp(`alter\\s+table\\s+${name}\\s+rename\\s+to\\b`, "i"),
				new RegExp(`__new_${table}\\b`, "i"),
			].some((pattern) => pattern.test(sqlText));
			if (!rebuilds) continue;
			const repairs =
				sqlText.includes(`'delete-all'`) &&
				sqlText.includes(`${table}_fts`) &&
				TRIGGERS.filter(([owner]) => owner === table).every(([, name]) =>
					sqlText.includes(name),
				);
			if (!repairs) offenders.push(`${file} (${table})`);
		}
	}
	return offenders;
}

function laterMigrations(): Record<string, string> {
	const files: Record<string, string> = {};
	for (const file of readdirSync("./drizzle")) {
		const number = Number(file.split("_")[0]);
		if (!file.endsWith(".sql") || !(number > 1777140000145)) continue;
		files[file] = readFileSync(join("./drizzle", file), "utf8");
	}
	return files;
}

const REPLACE_PATTERN =
	/(insert\s+or\s+replace\s+into|replace\s+into|update\s+or\s+replace)\s+([`"]?main[`"]?\.)?[`"]?(messages|artifacts)[`"]?[\s(]/i;

function sourceFiles(root: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (statSync(path).isDirectory()) {
			if (entry === "node_modules") continue;
			found.push(...sourceFiles(path));
		} else if (/\.(ts|js|mjs|cjs|svelte|sql)$/.test(entry)) {
			found.push(path);
		}
	}
	return found;
}

describe("what may touch an indexed table", () => {
	it("a later migration that rebuilds an indexed table refills the index", () => {
		expect(rebuildOffenders(laterMigrations())).toEqual([]);
		// The guard itself: a bare rebuild is caught, a repaired one is not.
		expect(
			rebuildOffenders({
				"1777140000199_rebuild.sql":
					"CREATE TABLE `__new_messages` (id text);\nDROP TABLE `messages`;",
			}),
		).toEqual(["1777140000199_rebuild.sql (messages)"]);
		// Hand-written statements need no semicolon (drizzle splits on its
		// breakpoints), may name the schema, and may rename instead of drop.
		for (const statement of [
			"DROP TABLE messages",
			"DROP TABLE IF EXISTS `main`.`messages`",
			"ALTER TABLE `messages_old` RENAME TO messages",
			"ALTER TABLE main.artifacts RENAME TO artifacts_old",
		]) {
			expect(
				rebuildOffenders({ "1777140000199_rebuild.sql": statement }),
				statement,
			).toHaveLength(1);
		}
		// Adding a column keeps the rows and the triggers: no refill needed.
		expect(
			rebuildOffenders({
				"1777140000199_add.sql": "ALTER TABLE `messages` ADD `pinned` integer",
			}),
		).toEqual([]);
		expect(
			rebuildOffenders({
				"1777140000199_rebuild.sql": `DROP TABLE \`artifacts\`;\nINSERT INTO artifacts_fts(artifacts_fts) VALUES('delete-all');\n${TRIGGERS.filter(
					([owner]) => owner === "artifacts",
				)
					.map(([, name]) => name)
					.join("\n")}`,
			}),
		).toEqual([]);
	});

	it("nothing replaces a message or an artifact row", () => {
		const offenders = ["src", "scripts"]
			.flatMap((root) => sourceFiles(root))
			.filter(
				(path) => !path.endsWith("workspace-search-index-migration.test.ts"),
			)
			.filter((path) => REPLACE_PATTERN.test(readFileSync(path, "utf8")))
			.map((path) => relative(process.cwd(), path));
		expect(offenders).toEqual([]);
		expect(
			REPLACE_PATTERN.test("INSERT OR REPLACE INTO messages (id) VALUES (?)"),
		).toBe(true);
		expect(
			REPLACE_PATTERN.test("replace into `artifacts`(id) values (?)"),
		).toBe(true);
		expect(
			REPLACE_PATTERN.test(
				"UPDATE OR REPLACE messages SET message_sequence = 1 WHERE id = ?",
			),
		).toBe(true);
		expect(
			REPLACE_PATTERN.test("insert or replace into main.messages (id)"),
		).toBe(true);
		expect(
			REPLACE_PATTERN.test("INSERT OR REPLACE INTO artifact_kv (k) VALUES (?)"),
		).toBe(false);
	});
});
