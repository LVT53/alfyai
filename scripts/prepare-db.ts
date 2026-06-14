#!/usr/bin/env tsx

import { config as dotenvConfig } from "dotenv";

dotenvConfig();

if (!process.env.DATABASE_PATH) {
	process.env.DATABASE_PATH = "./data/chat.db";
}

import {
	createCipheriv,
	pbkdf2Sync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

let databasePath = process.env.DATABASE_PATH;
let sqlite: Database.Database;

const requiredExistingTables = [
	"projects",
	"artifacts",
	"artifact_links",
	"artifact_chunks",
	"conversation_context_status",
	"context_compression_snapshots",
	"conversation_summaries",
	"conversation_forks",
	"deep_research_jobs",
	"deep_research_plan_versions",
	"deep_research_timeline_events",
	"deep_research_usage_records",
	"deep_research_sources",
	"deep_research_tasks",
	"deep_research_pass_checkpoints",
	"deep_research_coverage_gaps",
	"deep_research_resume_points",
	"deep_research_evidence_notes",
	"deep_research_synthesis_claims",
	"deep_research_claim_evidence_links",
	"conversation_task_states",
	"task_state_evidence_links",
	"task_checkpoints",
	"memory_projects",
	"memory_project_task_links",
	"persona_memory_attributions",
	"persona_memory_clusters",
	"persona_memory_cluster_members",
	"conversation_drafts",
	"user_skill_definitions",
	"skill_sessions",
	"skill_session_milestones",
	"skill_note_operations",
	"skill_note_checkpoints",
	"campaign_assets",
	"announcement_campaigns",
	"announcement_campaign_slides",
	"announcement_campaign_snapshots",
	"announcement_campaign_snapshot_slides",
	"announcement_campaign_user_states",
	"announcement_campaign_events",
	"import_jobs",
	"providers",
];

const requiredExistingColumns: Array<[string, string]> = [
	["conversations", "project_id"],
	["conversations", "status"],
	["conversations", "sealed_at"],
	["conversations", "sidebar_pinned"],
	["conversations", "sidebar_sort_order"],
	["projects", "sidebar_pinned"],
	["deep_research_jobs", "report_artifact_id"],
	["messages", "thinking"],
	["messages", "tool_calls"],
	["messages", "metadata_json"],
	["messages", "message_sequence"],
	["messages", "import_source"],
	["users", "role"],
	["users", "preferred_model"],
	["users", "translation_enabled"],
	["users", "theme"],
	["users", "title_language"],
	["users", "avatar_id"],
	["users", "profile_picture"],
	["users", "honcho_peer_version"],
	["conversation_drafts", "selected_linked_sources_json"],
	["conversation_drafts", "pending_skill_json"],
	["user_skill_definitions", "published"],
	["user_skill_definitions", "skill_kind"],
	["user_skill_definitions", "base_skill_id"],
	["user_skill_definitions", "base_skill_version"],
	["user_skill_definitions", "resource_metadata_json"],
	["skill_sessions", "skill_kind"],
	["skill_sessions", "pack_skill_id"],
	["skill_sessions", "pack_skill_version"],
	["skill_sessions", "variant_skill_id"],
	["skill_sessions", "variant_skill_version"],
	["skill_sessions", "effective_instructions_hash"],
	["announcement_campaigns", "identity_key"],
	["announcement_campaigns", "published_snapshot_id"],
	["announcement_campaign_slides", "desktop_crop_asset_id"],
	["announcement_campaign_snapshots", "identity_key"],
	["announcement_campaign_snapshot_slides", "desktop_crop_asset_id"],
	["announcement_campaign_user_states", "snapshot_id"],
	["announcement_campaign_events", "event_type"],
];

const baselineAdoptionRequiredTables = [
	"projects",
	"artifacts",
	"artifact_links",
	"artifact_chunks",
	"conversation_context_status",
	"conversation_task_states",
	"task_state_evidence_links",
	"task_checkpoints",
	"memory_projects",
	"memory_project_task_links",
	"persona_memory_attributions",
	"persona_memory_clusters",
	"persona_memory_cluster_members",
	"conversation_drafts",
];

const baselineAdoptionRequiredColumns: Array<[string, string]> = [
	["conversations", "project_id"],
	["messages", "thinking"],
	["messages", "tool_calls"],
	["messages", "metadata_json"],
	["users", "role"],
	["users", "preferred_model"],
	["users", "translation_enabled"],
	["users", "theme"],
	["users", "avatar_id"],
	["users", "profile_picture"],
];

// Columns that should be auto-created if missing (safe defaults, no data loss)
const autoCreateColumnsBeforeMigrations: Array<[string, string, string]> = [
	["users", "title_language", "TEXT NOT NULL DEFAULT 'auto'"],
];

const autoCreateColumnsAfterMigrations: Array<[string, string, string]> = [
	...autoCreateColumnsBeforeMigrations,
	["users", "model_preference_mode", "TEXT"],
];

const ADOPTION_BASELINE_TAG = "0005_flaky_famine";
const HONCHO_PEER_VERSION_MIGRATION_TAG =
	"1775416800000_users_honcho_peer_version";
const TITLE_LANGUAGE_MIGRATION_TAG = "1777140000003_users_title_language";
const INFERENCE_PROVIDERS_CREATION_TAG = "1777140000000_inference_providers";
const UI_LANGUAGE_MIGRATION_TAG = "1777140000005_users_ui_language";
const PREFERRED_PERSONALITY_MIGRATION_TAG =
	"1777140000008_users_preferred_personality";
const INFERENCE_PROVIDER_MIGRATION_TAGS = [
	INFERENCE_PROVIDERS_CREATION_TAG,
	"1777140000001_inference_provider_reasoning_options",
	"1777140000002_inference_provider_context_limits",
	"1777140000004_inference_provider_max_tokens",
] as const;

function deriveProviderEncryptionKey(secret: string): Buffer {
	return pbkdf2Sync(secret, "alfyai-providers", 100000, 32, "sha256");
}

function encryptSeededProviderApiKey(plaintext: string): {
	encrypted: string;
	iv: string;
} {
	const sessionSecret =
		process.env.SESSION_SECRET || "mock-session-secret-for-dev-testing-only";
	const key = deriveProviderEncryptionKey(sessionSecret);
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();

	return {
		encrypted: Buffer.concat([encrypted, authTag]).toString("base64"),
		iv: iv.toString("base64"),
	};
}

function openDatabase(path: string): void {
	databasePath = path;
	const dbDir = dirname(databasePath);

	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}

	sqlite = new Database(databasePath);
	sqlite.pragma("foreign_keys = ON");
}

function hasTable(tableName: string): boolean {
	return Boolean(
		sqlite
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
			)
			.get(tableName),
	);
}

function listColumns(tableName: string): string[] {
	return sqlite
		.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
		.all()
		.map((row) => String((row as { name: unknown }).name));
}

function hasColumn(tableName: string, columnName: string): boolean {
	if (!hasTable(tableName)) return false;
	return listColumns(tableName).includes(columnName);
}

function autoCreateMissingColumns(
	columns: readonly (readonly [string, string, string])[],
): number {
	let created = 0;
	for (const [table, column, definition] of columns) {
		if (!hasTable(table)) continue;
		if (hasColumn(table, column)) continue;
		sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		created += 1;
		console.log(`[prepare-db] Added missing column: ${table}.${column}`);
	}
	return created;
}

function countMigrationRows(): number {
	if (!hasTable("__drizzle_migrations")) return 0;
	const row = sqlite
		.prepare("SELECT COUNT(*) as count FROM __drizzle_migrations")
		.get() as { count: number };
	return row.count;
}

function listMigrationHashes(): Set<string> {
	if (!hasTable("__drizzle_migrations")) return new Set();
	const rows = sqlite
		.prepare("SELECT hash FROM __drizzle_migrations")
		.all() as { hash: string }[];
	return new Set(rows.map((row) => row.hash));
}

function getLatestMigrationCreatedAt(): number | null {
	if (!hasTable("__drizzle_migrations")) return null;
	const row = sqlite
		.prepare(
			"SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
		)
		.get() as { created_at: string | number | null } | undefined;
	if (row?.created_at == null) return null;

	const createdAt = Number(row.created_at);
	return Number.isFinite(createdAt) ? createdAt : null;
}

function hasApplicationTables(): boolean {
	const row = sqlite
		.prepare(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' LIMIT 1",
		)
		.get();
	return Boolean(row);
}

function validateSchemaRequirements(
	requiredTables: readonly string[],
	requiredColumns: readonly (readonly [string, string])[],
): string[] {
	const problems: string[] = [];

	for (const tableName of requiredTables) {
		if (!hasTable(tableName)) {
			problems.push(`missing table ${tableName}`);
		}
	}

	for (const [tableName, columnName] of requiredColumns) {
		if (!hasTable(tableName)) {
			problems.push(`missing table ${tableName} for column ${columnName}`);
			continue;
		}
		if (!listColumns(tableName).includes(columnName)) {
			problems.push(`missing column ${tableName}.${columnName}`);
		}
	}

	return problems;
}

function validateBaselineAdoptionSchema(): string[] {
	return validateSchemaRequirements(
		baselineAdoptionRequiredTables,
		baselineAdoptionRequiredColumns,
	);
}

function validateExistingRuntimeSchema(): string[] {
	return validateSchemaRequirements(
		requiredExistingTables,
		requiredExistingColumns,
	);
}

function ensureMigrationJournal(): void {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
			id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
			hash text NOT NULL,
			created_at numeric
		)
	`);
}

function readMigrationJournalEntries(): {
	entries: Array<{
		idx: number;
		when: number;
		tag: string;
		breakpoints: boolean;
	}>;
} {
	return JSON.parse(readFileSync("./drizzle/meta/_journal.json", "utf8")) as {
		entries: Array<{
			idx: number;
			when: number;
			tag: string;
			breakpoints: boolean;
		}>;
	};
}

function syncMigrationJournalToBaselineSchema(): number {
	const problems = validateBaselineAdoptionSchema();
	if (problems.length > 0) {
		throw new Error(
			`Cannot adopt existing database into Drizzle migrations: ${problems.join(", ")}`,
		);
	}

	ensureMigrationJournal();
	const journal = readMigrationJournalEntries();
	const baselineIndex = journal.entries.findIndex(
		(entry) => entry.tag === ADOPTION_BASELINE_TAG,
	);
	if (baselineIndex === -1) {
		throw new Error(
			`Cannot find baseline migration tag ${ADOPTION_BASELINE_TAG} in drizzle/meta/_journal.json`,
		);
	}

	const migrations = readMigrationFiles({
		migrationsFolder: "./drizzle",
	}).slice(0, baselineIndex + 1);
	const existingHashes = listMigrationHashes();
	const insertMigration = sqlite.prepare(
		'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
	);
	let insertedCount = 0;

	sqlite.transaction(() => {
		for (const migrationMeta of migrations) {
			if (existingHashes.has(migrationMeta.hash)) {
				continue;
			}
			insertMigration.run(
				migrationMeta.hash,
				String(migrationMeta.folderMillis),
			);
			insertedCount += 1;
		}
	})();

	return insertedCount;
}

function getMigrationMetaForTag(tag: string) {
	const journal = readMigrationJournalEntries();
	const migrationIndex = journal.entries.findIndex(
		(entry) => entry.tag === tag,
	);
	if (migrationIndex === -1) {
		throw new Error(
			`Cannot find migration tag ${tag} in drizzle/meta/_journal.json`,
		);
	}

	const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
	const migrationMeta = migrations[migrationIndex];
	if (!migrationMeta) {
		throw new Error(`Cannot resolve migration metadata for tag ${tag}`);
	}

	return migrationMeta;
}

function insertMigrationRecordIfMissing(tag: string): number {
	ensureMigrationJournal();
	const migrationMeta = getMigrationMetaForTag(tag);
	const existingHashes = listMigrationHashes();

	if (existingHashes.has(migrationMeta.hash)) {
		return 0;
	}

	sqlite
		.prepare(
			"INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
		)
		.run(migrationMeta.hash, String(migrationMeta.folderMillis));
	return 1;
}

function applyPendingMigrationsBeforeTag(tag: string): number {
	ensureMigrationJournal();
	const targetMigration = getMigrationMetaForTag(tag);
	const latestCreatedAt = getLatestMigrationCreatedAt();
	const pendingMigrations = readMigrationFiles({
		migrationsFolder: "./drizzle",
	}).filter(
		(migrationMeta) =>
			migrationMeta.folderMillis < targetMigration.folderMillis &&
			(latestCreatedAt === null ||
				latestCreatedAt < migrationMeta.folderMillis),
	);

	if (pendingMigrations.length === 0) {
		return 0;
	}

	const insertMigration = sqlite.prepare(
		'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
	);

	sqlite.transaction(() => {
		for (const migrationMeta of pendingMigrations) {
			for (const statement of migrationMeta.sql) {
				if (statement.trim().length === 0) continue;
				sqlite.exec(statement);
			}
			insertMigration.run(
				migrationMeta.hash,
				String(migrationMeta.folderMillis),
			);
		}
	})();

	return pendingMigrations.length;
}

function ensureInferenceProvidersSchema(): {
	backfill: number;
	repair: boolean;
	created: boolean;
} {
	let created = false;
	let repaired = false;

	if (!hasTable("inference_providers")) {
		sqlite.exec(`
			CREATE TABLE inference_providers (
				id text PRIMARY KEY NOT NULL,
				name text NOT NULL,
				display_name text NOT NULL,
				base_url text NOT NULL,
				api_key_encrypted text NOT NULL,
				api_key_iv text NOT NULL,
				model_name text NOT NULL,
				enabled integer DEFAULT 1 NOT NULL,
				sort_order integer DEFAULT 0 NOT NULL,
				reasoning_effort text,
				thinking_type text,
				max_model_context integer,
				compaction_ui_threshold integer,
				target_constructed_context integer,
				max_message_length integer,
				max_tokens integer,
				created_at integer DEFAULT (unixepoch()) NOT NULL,
				updated_at integer DEFAULT (unixepoch()) NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS inference_providers_name_unique
				ON inference_providers (name);
		`);
		created = true;
		repaired = true;
	} else {
		sqlite.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS inference_providers_name_unique ON inference_providers (name)",
		);
		const columnsToCreate: Array<[string, string]> = [
			["reasoning_effort", "text"],
			["thinking_type", "text"],
			["max_model_context", "integer"],
			["compaction_ui_threshold", "integer"],
			["target_constructed_context", "integer"],
			["max_message_length", "integer"],
			["max_tokens", "integer"],
		];
		for (const [column, definition] of columnsToCreate) {
			if (!hasColumn("inference_providers", column)) {
				sqlite.exec(
					`ALTER TABLE inference_providers ADD COLUMN ${column} ${definition}`,
				);
				repaired = true;
			}
		}
	}

	let backfill = 0;
	for (const providerTag of INFERENCE_PROVIDER_MIGRATION_TAGS) {
		backfill += insertMigrationRecordIfMissing(providerTag);
	}

	return { backfill, repair: repaired, created };
}

function backfillColumnMigrationIfNeeded(params: {
	table: string;
	column: string;
	tag: string;
	applyPendingBefore?: boolean;
}): number {
	if (!hasTable(params.table) || !hasColumn(params.table, params.column)) {
		return 0;
	}

	if (params.applyPendingBefore) {
		applyPendingMigrationsBeforeTag(params.tag);
	}

	const journal = readMigrationJournalEntries();
	const migrationIndex = journal.entries.findIndex(
		(entry) => entry.tag === params.tag,
	);
	if (migrationIndex === -1) {
		throw new Error(
			`Cannot find migration tag ${params.tag} in drizzle/meta/_journal.json`,
		);
	}

	const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
	const migrationMeta = migrations[migrationIndex];
	if (!migrationMeta) {
		throw new Error(`Cannot resolve migration metadata for tag ${params.tag}`);
	}

	const existingHashes = listMigrationHashes();
	if (existingHashes.has(migrationMeta.hash)) {
		return 0;
	}

	ensureMigrationJournal();
	sqlite
		.prepare(
			'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
		)
		.run(migrationMeta.hash, String(migrationMeta.folderMillis));

	return 1;
}

function applyMigrationCompatibilityRepairs(): void {
	const adoptedHonchoMigrationCount = backfillColumnMigrationIfNeeded({
		table: "users",
		column: "honcho_peer_version",
		tag: HONCHO_PEER_VERSION_MIGRATION_TAG,
	});
	if (adoptedHonchoMigrationCount > 0) {
		console.log(
			`Backfilled ${adoptedHonchoMigrationCount} Drizzle migration record for existing users.honcho_peer_version column in ${databasePath}.`,
		);
	}

	const adoptedTitleLanguageMigrationCount = backfillColumnMigrationIfNeeded({
		table: "users",
		column: "title_language",
		tag: TITLE_LANGUAGE_MIGRATION_TAG,
	});
	if (adoptedTitleLanguageMigrationCount > 0) {
		console.log(
			`Backfilled ${adoptedTitleLanguageMigrationCount} Drizzle migration record for existing users.title_language column in ${databasePath}.`,
		);
	}

	const {
		backfill: adoptedInferenceProvidersMigrationCount,
		repair: needsRepair,
		created: createdInferenceProvidersTable,
	} = ensureInferenceProvidersSchema();
	if (adoptedInferenceProvidersMigrationCount > 0) {
		if (needsRepair) {
			console.log(
				`Repaired inference_providers schema in ${databasePath}: ${createdInferenceProvidersTable ? "created missing table and" : "added missing columns and"} backfilled ${adoptedInferenceProvidersMigrationCount} provider migration record(s).`,
			);
		} else {
			console.log(
				`Backfilled ${adoptedInferenceProvidersMigrationCount} Drizzle migration record(s) for existing inference_providers schema in ${databasePath}.`,
			);
		}
	}

	const adoptedUiLanguageMigrationCount = backfillColumnMigrationIfNeeded({
		table: "users",
		column: "ui_language",
		tag: UI_LANGUAGE_MIGRATION_TAG,
	});
	if (adoptedUiLanguageMigrationCount > 0) {
		console.log(
			`Backfilled ${adoptedUiLanguageMigrationCount} Drizzle migration record for existing users.ui_language column in ${databasePath}.`,
		);
	}

	const adoptedPreferredPersonalityMigrationCount =
		backfillColumnMigrationIfNeeded({
			table: "users",
			column: "preferred_personality_id",
			tag: PREFERRED_PERSONALITY_MIGRATION_TAG,
			applyPendingBefore: true,
		});
	if (adoptedPreferredPersonalityMigrationCount > 0) {
		console.log(
			`Backfilled ${adoptedPreferredPersonalityMigrationCount} Drizzle migration record for existing users.preferred_personality_id column in ${databasePath}.`,
		);
	}
}

function applyNoJournalAdoptionCompatibilityBackfills(): void {
	const adoptedHonchoMigrationCount = backfillColumnMigrationIfNeeded({
		table: "users",
		column: "honcho_peer_version",
		tag: HONCHO_PEER_VERSION_MIGRATION_TAG,
		applyPendingBefore: true,
	});
	if (adoptedHonchoMigrationCount > 0) {
		console.log(
			`Backfilled ${adoptedHonchoMigrationCount} Drizzle migration record for existing users.honcho_peer_version column in ${databasePath}.`,
		);
	}

	const adoptedTitleLanguageMigrationCount = backfillColumnMigrationIfNeeded({
		table: "users",
		column: "title_language",
		tag: TITLE_LANGUAGE_MIGRATION_TAG,
		applyPendingBefore: true,
	});
	if (adoptedTitleLanguageMigrationCount > 0) {
		console.log(
			`Backfilled ${adoptedTitleLanguageMigrationCount} Drizzle migration record for existing users.title_language column in ${databasePath}.`,
		);
	}
}

function runDrizzleMigrations(): void {
	const db = drizzle(sqlite);
	migrate(db, { migrationsFolder: "./drizzle" });
}

function seedDefaultProvidersIfNeeded(): void {
	if (!hasTable("providers")) return;
	const hasProviders = Boolean(
		sqlite.prepare("SELECT 1 FROM providers LIMIT 1").get(),
	);
	if (hasProviders) return;

	const model1BaseUrl =
		process.env.MODEL_1_BASEURL || "http://localhost:30001/v1";
	const model1Name = process.env.MODEL_1_NAME || "model-1";
	const model1DisplayName = process.env.MODEL_1_DISPLAY_NAME || "Model 1";

	if (model1BaseUrl && model1Name) {
		const id = randomUUID();
		const apiKey = encryptSeededProviderApiKey(
			process.env.MODEL_1_API_KEY || "",
		);
		sqlite
			.prepare(
				`INSERT INTO providers (id, name, display_name, base_url, api_key_encrypted, api_key_iv, sort_order, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 0, 1, unixepoch(), unixepoch())`,
			)
			.run(
				id,
				"model1",
				model1DisplayName,
				model1BaseUrl,
				apiKey.encrypted,
				apiKey.iv,
			);
		sqlite
			.prepare(
				`INSERT INTO provider_models (id, provider_id, name, display_name, enabled, sort_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 1, 0, unixepoch(), unixepoch())`,
			)
			.run(randomUUID(), id, model1Name, model1DisplayName);
	}

	const model2Enabled = process.env.MODEL_2_ENABLED !== "false";
	const model2BaseUrl = process.env.MODEL_2_BASEURL || "";
	const model2Name = process.env.MODEL_2_NAME || "";
	const model2DisplayName = process.env.MODEL_2_DISPLAY_NAME || "Model 2";

	if (model2Enabled && model2BaseUrl && model2Name) {
		const id = randomUUID();
		const apiKey = encryptSeededProviderApiKey(
			process.env.MODEL_2_API_KEY || "",
		);
		sqlite
			.prepare(
				`INSERT INTO providers (id, name, display_name, base_url, api_key_encrypted, api_key_iv, sort_order, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 1, 1, unixepoch(), unixepoch())`,
			)
			.run(
				id,
				"model2",
				model2DisplayName,
				model2BaseUrl,
				apiKey.encrypted,
				apiKey.iv,
			);
		sqlite
			.prepare(
				`INSERT INTO provider_models (id, provider_id, name, display_name, enabled, sort_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 1, 0, unixepoch(), unixepoch())`,
			)
			.run(randomUUID(), id, model2Name, model2DisplayName);
	}

	console.log("[prepare-db] Seeded default providers from env configuration.");
}

export function prepareDatabase(
	path = process.env.DATABASE_PATH || "./data/chat.db",
): void {
	openDatabase(path);

	try {
		if (hasApplicationTables()) {
			const existingMigrationCount = countMigrationRows();
			if (existingMigrationCount === 0) {
				const schemaProblems = validateBaselineAdoptionSchema();
				if (schemaProblems.length > 0) {
					throw new Error(
						`Database ${databasePath} is missing required schema pieces: ${schemaProblems.join(", ")}`,
					);
				}

				const insertedCount = syncMigrationJournalToBaselineSchema();
				if (insertedCount > 0) {
					console.log(
						`Backfilled ${insertedCount} baseline Drizzle migration record(s) for ${databasePath}.`,
					);
				}
				applyNoJournalAdoptionCompatibilityBackfills();
			} else {
				autoCreateMissingColumns(autoCreateColumnsBeforeMigrations);
				applyMigrationCompatibilityRepairs();
			}

			runDrizzleMigrations();
			autoCreateMissingColumns(autoCreateColumnsAfterMigrations);
			seedDefaultProvidersIfNeeded();
			const schemaProblems = validateExistingRuntimeSchema();
			if (schemaProblems.length > 0) {
				throw new Error(
					`Database ${databasePath} is missing required schema pieces after migrations: ${schemaProblems.join(", ")}`,
				);
			}
			console.log(`Database migrations are up to date for ${databasePath}.`);
			return;
		}

		runDrizzleMigrations();
		seedDefaultProvidersIfNeeded();
		console.log(`Database migrations are up to date for ${databasePath}.`);
	} finally {
		sqlite.close();
	}
}

function isDirectExecution(): boolean {
	return Boolean(
		process.argv[1] &&
			resolve(process.argv[1]) === fileURLToPath(import.meta.url),
	);
}

if (isDirectExecution()) {
	prepareDatabase();
}
