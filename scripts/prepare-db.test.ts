import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDatabase } from "./prepare-db";

const PRE_RETIRED_RESEARCH_TAG = "1777140000011_file_production_requests";
const PRE_RESEARCH_REMOVAL_TAG = "1777140000061_memory_rework_foundation";
const ADOPTION_BASELINE_TAG = "0005_flaky_famine";
const SKILL_NOTES_TAG = "1777140000035_skill_notes";
const PRE_LANGFLOW_RETIREMENT_TAG =
	"1777140000046_context_compression_snapshots";
const RETIRED_RESEARCH_TABLE_PREFIX = ["deep", "research"].join("_");
const RETIRED_RESEARCH_TABLES = [
	"jobs",
	"plan_versions",
	"timeline_events",
	"usage_records",
	"sources",
	"tasks",
	"pass_checkpoints",
	"coverage_gaps",
	"resume_points",
	"evidence_notes",
	"synthesis_claims",
	"claim_evidence_links",
	"citation_audit_verdicts",
].map((suffix) => `${RETIRED_RESEARCH_TABLE_PREFIX}_${suffix}`);

let tempDir: string | null = null;

function applyMigrationsThroughTag(
	dbPath: string,
	tag: string,
	recordJournal: boolean,
): void {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");

	if (recordJournal) {
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
				id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
				hash text NOT NULL,
				created_at numeric
			)
		`);
	}

	const journal = JSON.parse(
		readFileSync("./drizzle/meta/_journal.json", "utf8"),
	) as {
		entries: Array<{ tag: string }>;
	};
	const targetIndex = journal.entries.findIndex((entry) => entry.tag === tag);
	if (targetIndex === -1) {
		throw new Error(`Cannot find migration tag ${tag}`);
	}

	const migrations = readMigrationFiles({
		migrationsFolder: "./drizzle",
	}).slice(0, targetIndex + 1);
	const insertMigration = recordJournal
		? sqlite.prepare(
				'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
			)
		: null;
	sqlite.transaction(() => {
		for (const migration of migrations) {
			for (const statement of migration.sql) {
				if (statement.trim().length === 0) continue;
				sqlite.exec(statement);
			}
			insertMigration?.run(migration.hash, String(migration.folderMillis));
		}
	})();
	sqlite.close();
}

function createDatabaseMigratedThroughTag(dbPath: string, tag: string): void {
	applyMigrationsThroughTag(dbPath, tag, true);
}

function createDatabaseSchemaThroughTagWithoutJournal(
	dbPath: string,
	tag: string,
): void {
	applyMigrationsThroughTag(dbPath, tag, false);
}

function hasTable(sqlite: Database.Database, tableName: string): boolean {
	return Boolean(
		sqlite
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
			)
			.get(tableName),
	);
}

function listColumns(sqlite: Database.Database, tableName: string): string[] {
	return sqlite
		.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
		.all()
		.map((row) => String((row as { name: unknown }).name));
}

function decryptSeededProviderApiKey(
	encrypted: string,
	iv: string,
	secret: string,
): string {
	const key = pbkdf2Sync(secret, "alfyai-providers", 100000, 32, "sha256");
	const ivBuffer = Buffer.from(iv, "base64");
	const encryptedBuffer = Buffer.from(encrypted, "base64");
	const authTag = encryptedBuffer.slice(-16);
	const ciphertext = encryptedBuffer.slice(0, -16);
	const decipher = createDecipheriv("aes-256-gcm", key, ivBuffer);
	decipher.setAuthTag(authTag);
	return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

describe("prepare-db script", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it("applies pending migrations and removes retired research tables", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-prepare-db-"));
		const dbPath = join(tempDir, "chat.db");
		createDatabaseMigratedThroughTag(dbPath, PRE_RETIRED_RESEARCH_TAG);

		prepareDatabase(dbPath);

		const sqlite = new Database(dbPath, { readonly: true });
		try {
			for (const tableName of RETIRED_RESEARCH_TABLES) {
				expect(hasTable(sqlite, tableName)).toBe(false);
			}
			expect(listColumns(sqlite, "conversations")).toEqual(
				expect.arrayContaining(["status", "sealed_at"]),
			);
		} finally {
			sqlite.close();
		}
	});

	it("purges only retired research artifacts and dependent rows during upgrade", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-prepare-db-"));
		const dbPath = join(tempDir, "chat.db");
		createDatabaseMigratedThroughTag(dbPath, PRE_RESEARCH_REMOVAL_TAG);

		const seeded = new Database(dbPath);
		try {
			seeded.transaction(() => {
				seeded
					.prepare(
						'INSERT INTO users ("id", "email", "password_hash") VALUES (?, ?, ?)',
					)
					.run("user-1", "user@example.test", "hash");
				seeded
					.prepare(
						'INSERT INTO conversations ("id", "user_id", "title") VALUES (?, ?, ?)',
					)
					.run("conv-1", "user-1", "Removal check");
				seeded
					.prepare(
						'INSERT INTO messages ("id", "conversation_id", "role", "content") VALUES (?, ?, ?, ?)',
					)
					.run("msg-1", "conv-1", "assistant", "Done");

				const insertArtifact = seeded.prepare(
					`INSERT INTO artifacts (
						"id",
						"user_id",
						"conversation_id",
						"type",
						"name",
						"content_text",
						"metadata_json"
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				insertArtifact.run(
					"artifact-report-by-job",
					"user-1",
					"conv-1",
					"generated_output",
					"Retired report by job",
					"delete me",
					null,
				);
				insertArtifact.run(
					"artifact-report-by-metadata",
					"user-1",
					"conv-1",
					"generated_output",
					"Retired report by metadata",
					"delete me too",
					'{"deepResearchJobId":"research-job-2"}',
				);
				insertArtifact.run(
					"artifact-ordinary-output",
					"user-1",
					"conv-1",
					"generated_output",
					"Ordinary generated file",
					"keep me",
					'{"sourceChatFileId":"file-1"}',
				);

				seeded
					.prepare(
						`INSERT INTO deep_research_jobs (
							"id",
							"user_id",
							"conversation_id",
							"trigger_message_id",
							"depth",
							"status",
							"title",
							"user_request",
							"report_artifact_id"
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						"research-job-1",
						"user-1",
						"conv-1",
						"msg-1",
						"standard",
						"completed",
						"Retired report",
						"Research this",
						"artifact-report-by-job",
					);

				const insertChunk = seeded.prepare(
					`INSERT INTO artifact_chunks (
						"id",
						"artifact_id",
						"user_id",
						"conversation_id",
						"chunk_index",
						"content_text"
					) VALUES (?, ?, ?, ?, ?, ?)`,
				);
				insertChunk.run(
					"chunk-delete",
					"artifact-report-by-job",
					"user-1",
					"conv-1",
					0,
					"delete chunk",
				);
				insertChunk.run(
					"chunk-keep",
					"artifact-ordinary-output",
					"user-1",
					"conv-1",
					0,
					"keep chunk",
				);

				const insertEmbedding = seeded.prepare(
					`INSERT INTO semantic_embeddings (
						"id",
						"user_id",
						"subject_type",
						"subject_id",
						"model_name",
						"source_text_hash",
						"embedding_json"
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				insertEmbedding.run(
					"embedding-delete",
					"user-1",
					"artifact",
					"artifact-report-by-metadata",
					"mock-model",
					"hash-delete",
					"[0]",
				);
				insertEmbedding.run(
					"embedding-keep",
					"user-1",
					"artifact",
					"artifact-ordinary-output",
					"mock-model",
					"hash-keep",
					"[1]",
				);

				const insertLink = seeded.prepare(
					`INSERT INTO artifact_links (
						"id",
						"user_id",
						"artifact_id",
						"related_artifact_id",
						"conversation_id",
						"message_id",
						"link_type"
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				insertLink.run(
					"link-delete",
					"user-1",
					"artifact-ordinary-output",
					"artifact-report-by-job",
					"conv-1",
					"msg-1",
					"source",
				);
				insertLink.run(
					"link-keep",
					"user-1",
					"artifact-ordinary-output",
					null,
					"conv-1",
					"msg-1",
					"source",
				);

				const insertWorkingSetItem = seeded.prepare(
					`INSERT INTO conversation_working_set_items (
						"id",
						"user_id",
						"conversation_id",
						"artifact_id",
						"artifact_type"
					) VALUES (?, ?, ?, ?, ?)`,
				);
				insertWorkingSetItem.run(
					"working-delete",
					"user-1",
					"conv-1",
					"artifact-report-by-metadata",
					"generated_output",
				);
				insertWorkingSetItem.run(
					"working-keep",
					"user-1",
					"conv-1",
					"artifact-ordinary-output",
					"generated_output",
				);

				const insertConfig = seeded.prepare(
					'INSERT INTO admin_config ("key", "value", "updated_by") VALUES (?, ?, ?)',
				);
				insertConfig.run("DEEP_RESEARCH_ENABLED", "true", "test");
				insertConfig.run("MODEL_1_NAME", "kept-model", "test");
			})();
		} finally {
			seeded.close();
		}

		prepareDatabase(dbPath);

		const sqlite = new Database(dbPath, { readonly: true });
		try {
			for (const tableName of RETIRED_RESEARCH_TABLES) {
				expect(hasTable(sqlite, tableName)).toBe(false);
			}
			expect(
				sqlite.prepare('SELECT "id" FROM artifacts ORDER BY "id"').all(),
			).toEqual([{ id: "artifact-ordinary-output" }]);
			expect(
				sqlite.prepare('SELECT "id" FROM artifact_chunks ORDER BY "id"').all(),
			).toEqual([{ id: "chunk-keep" }]);
			expect(
				sqlite
					.prepare('SELECT "id" FROM semantic_embeddings ORDER BY "id"')
					.all(),
			).toEqual([{ id: "embedding-keep" }]);
			expect(
				sqlite.prepare('SELECT "id" FROM artifact_links ORDER BY "id"').all(),
			).toEqual([{ id: "link-keep" }]);
			expect(
				sqlite
					.prepare(
						'SELECT "id" FROM conversation_working_set_items ORDER BY "id"',
					)
					.all(),
			).toEqual([{ id: "working-keep" }]);
			expect(
				sqlite.prepare('SELECT "key" FROM admin_config ORDER BY "key"').all(),
			).toEqual([{ key: "MODEL_1_NAME" }]);
			expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	it("adopts an existing baseline app database before applying current migrations", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-prepare-db-"));
		const dbPath = join(tempDir, "chat.db");
		createDatabaseSchemaThroughTagWithoutJournal(dbPath, ADOPTION_BASELINE_TAG);

		const beforePrepare = new Database(dbPath, { readonly: true });
		try {
			expect(hasTable(beforePrepare, "__drizzle_migrations")).toBe(false);
			expect(hasTable(beforePrepare, "conversations")).toBe(true);
			expect(hasTable(beforePrepare, RETIRED_RESEARCH_TABLES[0])).toBe(false);
		} finally {
			beforePrepare.close();
		}

		prepareDatabase(dbPath);

		const sqlite = new Database(dbPath, { readonly: true });
		try {
			expect(hasTable(sqlite, "__drizzle_migrations")).toBe(true);
			for (const tableName of RETIRED_RESEARCH_TABLES) {
				expect(hasTable(sqlite, tableName)).toBe(false);
			}
		} finally {
			sqlite.close();
		}
	});

	it("adopts a no-journal baseline database after an earlier compatibility column repair", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-prepare-db-"));
		const dbPath = join(tempDir, "chat.db");
		createDatabaseSchemaThroughTagWithoutJournal(dbPath, ADOPTION_BASELINE_TAG);

		const repairedBeforeAdoption = new Database(dbPath);
		try {
			repairedBeforeAdoption.exec(
				"ALTER TABLE users ADD COLUMN title_language TEXT NOT NULL DEFAULT 'auto'",
			);
		} finally {
			repairedBeforeAdoption.close();
		}

		prepareDatabase(dbPath);

		const sqlite = new Database(dbPath, { readonly: true });
		try {
			expect(hasTable(sqlite, RETIRED_RESEARCH_TABLES[0])).toBe(false);
			expect(listColumns(sqlite, "users")).toEqual(
				expect.arrayContaining(["title_language", "honcho_peer_version"]),
			);
		} finally {
			sqlite.close();
		}
	});

	it("rejects a journaled Composer Command V1 schema with a missing required draft column", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-prepare-db-"));
		const dbPath = join(tempDir, "chat.db");
		createDatabaseMigratedThroughTag(dbPath, SKILL_NOTES_TAG);

		const corrupted = new Database(dbPath);
		try {
			corrupted.exec(
				"ALTER TABLE conversation_drafts DROP COLUMN pending_skill_json",
			);
		} finally {
			corrupted.close();
		}

		expect(() => prepareDatabase(dbPath)).toThrow(
			/missing column conversation_drafts\.pending_skill_json/,
		);
	});

	it("removes retired Langflow admin_config overrides during prepare", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-prepare-db-"));
		const dbPath = join(tempDir, "chat.db");
		createDatabaseMigratedThroughTag(dbPath, PRE_LANGFLOW_RETIREMENT_TAG);

		const seeded = new Database(dbPath);
		try {
			const insertOverride = seeded.prepare(
				'INSERT INTO admin_config ("key", "value", "updated_by") VALUES (?, ?, ?)',
			);
			for (const key of [
				"MODEL_1_FLOW_ID",
				"MODEL_1_COMPONENT_ID",
				"MODEL_2_FLOW_ID",
				"MODEL_2_COMPONENT_ID",
				"LANGFLOW_API_URL",
				"LANGFLOW_API_KEY",
				"LANGFLOW_FLOW_ID",
				"LANGFLOW_WEBHOOK_SECRET",
			]) {
				insertOverride.run(key, "legacy-value", "test");
			}
			insertOverride.run("MODEL_1_NAME", "kept-model", "test");
		} finally {
			seeded.close();
		}

		prepareDatabase(dbPath);

		const sqlite = new Database(dbPath, { readonly: true });
		try {
			const rows = sqlite
				.prepare('SELECT "key" FROM admin_config ORDER BY "key"')
				.all() as Array<{ key: string }>;
			expect(rows.map((row) => row.key)).toEqual(["MODEL_1_NAME"]);
		} finally {
			sqlite.close();
		}
	});

	it("seeds default provider API keys using the provider encryption format", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-prepare-db-"));
		const dbPath = join(tempDir, "chat.db");
		const previousSessionSecret = process.env.SESSION_SECRET;
		const previousModel1ApiKey = process.env.MODEL_1_API_KEY;
		const previousModel2Enabled = process.env.MODEL_2_ENABLED;
		process.env.SESSION_SECRET = "prepare-db-test-secret";
		process.env.MODEL_1_API_KEY = "sk-seeded-provider";
		process.env.MODEL_2_ENABLED = "false";

		try {
			prepareDatabase(dbPath);

			const sqlite = new Database(dbPath, { readonly: true });
			try {
				const row = sqlite
					.prepare(
						"SELECT api_key_encrypted, api_key_iv FROM providers WHERE name = 'model1'",
					)
					.get() as
					| { api_key_encrypted: string; api_key_iv: string }
					| undefined;

				expect(row).toBeTruthy();
				if (!row) {
					throw new Error("Expected seeded model1 provider row");
				}
				expect(row?.api_key_encrypted).not.toBe("sk-seeded-provider");
				expect(row?.api_key_iv).toBeTruthy();
				expect(
					decryptSeededProviderApiKey(
						row.api_key_encrypted,
						row.api_key_iv,
						"prepare-db-test-secret",
					),
				).toBe("sk-seeded-provider");
			} finally {
				sqlite.close();
			}
		} finally {
			if (previousSessionSecret === undefined) {
				delete process.env.SESSION_SECRET;
			} else {
				process.env.SESSION_SECRET = previousSessionSecret;
			}
			if (previousModel1ApiKey === undefined) {
				delete process.env.MODEL_1_API_KEY;
			} else {
				process.env.MODEL_1_API_KEY = previousModel1ApiKey;
			}
			if (previousModel2Enabled === undefined) {
				delete process.env.MODEL_2_ENABLED;
			} else {
				process.env.MODEL_2_ENABLED = previousModel2Enabled;
			}
		}
	});
});
