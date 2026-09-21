import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";

const TEST_DB_PATH = "./test-data/schema-test.db";

/** The migration that renames the MinerU timeout override. */
const MINERU4_MIGRATION_TAG = "1777140000098_mineru4_extraction";

describe("schema core tables", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeAll(() => {
		const dbDir = dirname(TEST_DB_PATH);
		if (!existsSync(dbDir)) {
			mkdirSync(dbDir, { recursive: true });
		}

		if (existsSync(TEST_DB_PATH)) {
			unlinkSync(TEST_DB_PATH);
		}

		sqlite = new Database(TEST_DB_PATH);
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });

		migrate(db, { migrationsFolder: "./drizzle" });
	});

	afterAll(() => {
		sqlite?.close();
		if (existsSync(TEST_DB_PATH)) {
			unlinkSync(TEST_DB_PATH);
		}
	});

	describe("users table", () => {
		it("can insert user and query by id", () => {
			const userId = "test-user-1";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "test@example.com",
					passwordHash: "hash123",
					name: "Test User",
				})
				.run();

			const user = db
				.select()
				.from(schema.users)
				.where(eq(schema.users.id, userId))
				.get();

			expect(user).toBeTruthy();
			expect(user?.id).toBe(userId);
			expect(user?.email).toBe("test@example.com");
			expect(user?.name).toBe("Test User");
		});

		it("keeps model preference storage non-null with a separate inheritance mode", () => {
			const columns = sqlite.prepare("PRAGMA table_info(users)").all() as {
				name: string;
				notnull: number;
				dflt_value: string | null;
			}[];

			expect(columns).toContainEqual(
				expect.objectContaining({
					name: "preferred_model",
					notnull: 1,
					dflt_value: "'model1'",
				}),
			);
			expect(columns).toContainEqual(
				expect.objectContaining({
					name: "model_preference_mode",
					notnull: 0,
				}),
			);
		});
	});

	describe("artifacts table", () => {
		it("can insert artifact with the minimal document fields", () => {
			const userId = "test-user-artifact";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "artifact@example.com",
					passwordHash: "hash456",
					name: "Artifact Test User",
				})
				.run();

			const artifactId = "artifact-minimal-document";
			db.insert(schema.artifacts)
				.values({
					id: artifactId,
					userId: userId,
					type: "source_document",
					name: "Test Document.pdf",
				})
				.run();

			const artifact = db
				.select()
				.from(schema.artifacts)
				.where(eq(schema.artifacts.id, artifactId))
				.get();

			expect(artifact).toBeTruthy();
			expect(artifact?.id).toBe(artifactId);
		});

		it("keeps document ownership on the artifact row only", () => {
			const columns = sqlite.prepare("PRAGMA table_info(artifacts)").all() as {
				name: string;
			}[];

			const columnNames = columns.map((c) => c.name);
			expect(columnNames).toContain("user_id");
			expect(columnNames).toContain("conversation_id");
		});
	});

	describe("projects table", () => {
		// ADR-0051: folder-anchored continuity retired the inferred project-memory
		// substrate. Project Folders no longer carry a canonical-memory pointer and
		// the `memory_projects` / `memory_project_task_links` tables are gone.
		it("is folder-anchored with no inferred continuity pointer or substrate tables", () => {
			const columns = sqlite.prepare("PRAGMA table_info(projects)").all() as {
				name: string;
			}[];
			const columnNames = columns.map((column) => column.name);
			expect(columnNames).not.toContain("canonical_memory_project_id");

			const indexes = sqlite.prepare("PRAGMA index_list(projects)").all() as {
				name: string;
			}[];
			const indexNames = indexes.map((index) => index.name);
			expect(indexNames).not.toContain(
				"projects_canonical_memory_project_id_unique_idx",
			);
			expect(indexNames).toContain("projects_user_sidebar_idx");

			const substrateTables = sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('memory_projects', 'memory_project_task_links')",
				)
				.all() as { name: string }[];
			expect(substrateTables).toEqual([]);

			const userId = "test-user-project-folder-link";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "project-folder@example.com",
					passwordHash: "hash789",
					name: "Project Folder Test User",
				})
				.run();

			db.insert(schema.projects)
				.values([
					{ id: "folder-one", userId, name: "Folder one" },
					{ id: "folder-two", userId, name: "Folder two" },
				])
				.run();

			const rows = db
				.select()
				.from(schema.projects)
				.where(eq(schema.projects.userId, userId))
				.all();
			expect(rows).toHaveLength(2);
		});
	});

	describe("conversation_summaries table", () => {
		it("stores one summary per conversation and cascades with conversation deletion", () => {
			const columns = sqlite
				.prepare("PRAGMA table_info(conversation_summaries)")
				.all() as { name: string; pk: number }[];
			expect(columns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"conversation_id",
					"user_id",
					"summary",
					"source",
					"created_at",
					"updated_at",
				]),
			);
			expect(
				columns.find((column) => column.name === "conversation_id")?.pk,
			).toBe(1);

			const foreignKeys = sqlite
				.prepare("PRAGMA foreign_key_list(conversation_summaries)")
				.all() as {
				from: string;
				table: string;
				to: string;
				on_delete: string;
			}[];
			expect(foreignKeys).toContainEqual(
				expect.objectContaining({
					from: "conversation_id",
					table: "conversations",
					to: "id",
					on_delete: "CASCADE",
				}),
			);

			const userId = "test-user-conversation-summary";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "conversation-summary@example.com",
					passwordHash: "hash-summary",
				})
				.run();
			db.insert(schema.conversations)
				.values({
					id: "conversation-summary-cascade",
					userId,
					title: "Summary cascade test",
				})
				.run();
			db.insert(schema.conversationSummaries)
				.values({
					conversationId: "conversation-summary-cascade",
					userId,
					summary: "Durable conversation summary.",
				})
				.run();

			db.delete(schema.conversations)
				.where(eq(schema.conversations.id, "conversation-summary-cascade"))
				.run();

			const summary = db
				.select()
				.from(schema.conversationSummaries)
				.where(
					eq(
						schema.conversationSummaries.conversationId,
						"conversation-summary-cascade",
					),
				)
				.get();
			expect(summary).toBeUndefined();
		});
	});

	describe("skill pack and variant metadata", () => {
		it("stores explicit skill kind and optional base pack references", () => {
			const skillColumns = sqlite
				.prepare("PRAGMA table_info(user_skill_definitions)")
				.all() as {
				name: string;
				notnull: number;
				dflt_value: string | null;
			}[];
			expect(skillColumns).toContainEqual(
				expect.objectContaining({
					name: "skill_kind",
					notnull: 1,
					dflt_value: "'user_skill'",
				}),
			);
			expect(skillColumns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"base_skill_id",
					"base_skill_version",
					"resource_metadata_json",
				]),
			);
		});

		// On-demand skill loading (drizzle/1777140000088_drop_skill_sessions_and_notes.sql)
		// drops the four session/notes tables outright while leaving
		// user_skill_definitions in place. This exercises the migration
		// journal end to end: `beforeAll` above replays every migration file
		// against a fresh database in journal order, so a malformed SQL file or
		// a journal entry pointing at the wrong tag would fail every test in
		// this file, not just this one.
		it("drops the skill_sessions family of tables via the migration journal, keeping user_skill_definitions", () => {
			const tableNames = new Set(
				(
					sqlite
						.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
						.all() as { name: string }[]
				).map((row) => row.name),
			);
			for (const dropped of [
				"skill_sessions",
				"skill_session_milestones",
				"skill_note_operations",
				"skill_note_checkpoints",
			]) {
				expect(tableNames.has(dropped)).toBe(false);
			}
			expect(tableNames.has("user_skill_definitions")).toBe(true);
		});

		// Historical regression test: skill_sessions was dropped from the live
		// schema (see drizzle/1777140000088_drop_skill_sessions_and_notes.sql —
		// skills moved from durable sessions to on-demand loading), but this
		// replays the old 043 migration against an ad hoc legacy in-memory table
		// to confirm it still backfills pack/user classifications correctly for
		// any database that applied it before the table was dropped.
		it("backfills existing skill rows and sessions into pack/user classifications", () => {
			const legacySqlite = new Database(":memory:");
			try {
				legacySqlite.exec(`
          CREATE TABLE user_skill_definitions (
            id text PRIMARY KEY NOT NULL,
            user_id text NOT NULL,
            ownership text DEFAULT 'user' NOT NULL,
            display_name text NOT NULL,
            description text DEFAULT '' NOT NULL,
            instructions text NOT NULL,
            activation_examples_json text DEFAULT '[]' NOT NULL,
            enabled integer DEFAULT 1 NOT NULL,
            published integer DEFAULT 0 NOT NULL,
            duration_policy text DEFAULT 'next_message' NOT NULL,
            question_policy text DEFAULT 'none' NOT NULL,
            notes_policy text DEFAULT 'none' NOT NULL,
            source_scope text DEFAULT 'current_conversation' NOT NULL,
            creation_source text DEFAULT 'user_created' NOT NULL,
            version integer DEFAULT 1 NOT NULL,
            created_at integer DEFAULT (unixepoch()) NOT NULL,
            updated_at integer DEFAULT (unixepoch()) NOT NULL
          );
          CREATE TABLE skill_sessions (
            id text PRIMARY KEY NOT NULL,
            user_id text NOT NULL,
            conversation_id text NOT NULL,
            skill_id text NOT NULL,
            skill_ownership text NOT NULL,
            status text DEFAULT 'active' NOT NULL,
            pause_reason text,
            end_reason text,
            skill_display_name text NOT NULL,
            skill_description text DEFAULT '' NOT NULL,
            skill_instructions text NOT NULL,
            activation_examples_json text DEFAULT '[]' NOT NULL,
            duration_policy text NOT NULL,
            question_policy text NOT NULL,
            notes_policy text NOT NULL,
            source_scope text NOT NULL,
            skill_version integer NOT NULL,
            started_from text NOT NULL,
            started_at integer DEFAULT (unixepoch()) NOT NULL,
            updated_at integer DEFAULT (unixepoch()) NOT NULL,
            paused_at integer,
            ended_at integer
          );
          INSERT INTO user_skill_definitions (
            id, user_id, ownership, display_name, instructions, published
          )
          VALUES
            ('system:pack', 'admin-1', 'system', 'Pack', 'PACK_SECRET', 1),
            ('user-skill-1', 'user-1', 'user', 'User Skill', 'USER_SECRET', 0);
          INSERT INTO skill_sessions (
            id, user_id, conversation_id, skill_id, skill_ownership,
            skill_display_name, skill_instructions, duration_policy,
            question_policy, notes_policy, source_scope, skill_version, started_from
          )
          VALUES
            ('session-pack', 'user-1', 'conv-1', 'system:pack', 'system',
              'Pack', 'PACK_SECRET', 'next_message', 'none', 'none',
              'selected_sources_only', 3, 'pending_skill'),
            ('session-user', 'user-1', 'conv-2', 'user-skill-1', 'user',
              'User Skill', 'USER_SECRET', 'session', 'none', 'none',
              'current_conversation', 2, 'pending_skill');
        `);

				const migrationSql = readFileSync(
					"./drizzle/1777140000043_skill_packs_variants.sql",
					"utf8",
				);
				for (const statement of migrationSql
					.split("--> statement-breakpoint")
					.map((part) => part.trim())
					.filter(Boolean)) {
					legacySqlite.exec(statement);
				}

				const skills = legacySqlite
					.prepare(
						"SELECT id, skill_kind FROM user_skill_definitions ORDER BY id",
					)
					.all() as { id: string; skill_kind: string }[];
				expect(skills).toEqual([
					{ id: "system:pack", skill_kind: "skill_pack" },
					{ id: "user-skill-1", skill_kind: "user_skill" },
				]);

				const sessions = legacySqlite
					.prepare(
						"SELECT id, skill_kind, pack_skill_id, pack_skill_version, effective_instructions_hash FROM skill_sessions ORDER BY id",
					)
					.all() as {
					id: string;
					skill_kind: string;
					pack_skill_id: string | null;
					pack_skill_version: number | null;
					effective_instructions_hash: string;
				}[];
				expect(sessions).toEqual([
					{
						id: "session-pack",
						skill_kind: "skill_pack",
						pack_skill_id: "system:pack",
						pack_skill_version: 3,
						effective_instructions_hash: "",
					},
					{
						id: "session-user",
						skill_kind: "user_skill",
						pack_skill_id: null,
						pack_skill_version: null,
						effective_instructions_hash: "",
					},
				]);
			} finally {
				legacySqlite.close();
			}
		});
	});

	describe("campaign_assets table", () => {
		it("stores app-owned draft and published campaign screenshot assets outside knowledge artifacts", () => {
			const columns = sqlite
				.prepare("PRAGMA table_info(campaign_assets)")
				.all() as { name: string; notnull: number }[];
			const columnNames = columns.map((column) => column.name);

			expect(columnNames).toEqual(
				expect.arrayContaining([
					"id",
					"uploaded_by_user_id",
					"source_asset_id",
					"asset_kind",
					"variant",
					"status",
					"original_filename",
					"mime_type",
					"size_bytes",
					"storage_path",
					"width",
					"height",
					"crop_x",
					"crop_y",
					"crop_width",
					"crop_height",
					"zoom",
					"crop_metadata_json",
					"created_at",
					"updated_at",
				]),
			);
			expect(
				columns.find((column) => column.name === "uploaded_by_user_id")
					?.notnull,
			).toBe(1);
			expect(
				columns.find((column) => column.name === "storage_path")?.notnull,
			).toBe(1);

			const foreignKeys = sqlite
				.prepare("PRAGMA foreign_key_list(campaign_assets)")
				.all() as {
				from: string;
				table: string;
				to: string;
				on_delete: string;
			}[];
			expect(foreignKeys).toContainEqual(
				expect.objectContaining({
					from: "uploaded_by_user_id",
					table: "users",
					to: "id",
					on_delete: "CASCADE",
				}),
			);

			const indexes = sqlite
				.prepare("PRAGMA index_list(campaign_assets)")
				.all() as { name: string }[];
			expect(indexes.map((index) => index.name)).toEqual(
				expect.arrayContaining([
					"campaign_assets_status_idx",
					"campaign_assets_uploaded_by_idx",
					"campaign_assets_source_idx",
				]),
			);

			db.insert(schema.users)
				.values({
					id: "campaign-asset-admin",
					email: "campaign-assets@example.com",
					passwordHash: "hash-campaign-assets",
					role: "admin",
				})
				.run();

			db.insert(schema.campaignAssets)
				.values({
					id: "asset-source-1",
					uploadedByUserId: "campaign-asset-admin",
					assetKind: "source",
					status: "draft",
					originalFilename: "source.png",
					mimeType: "image/png",
					sizeBytes: 1234,
					storagePath: "source/asset-source-1.png",
				})
				.run();

			db.insert(schema.campaignAssets)
				.values({
					id: "asset-crop-1",
					uploadedByUserId: "campaign-asset-admin",
					sourceAssetId: "asset-source-1",
					assetKind: "crop",
					variant: "desktop",
					status: "draft",
					originalFilename: "desktop.png",
					mimeType: "image/png",
					sizeBytes: 1000,
					storagePath: "crop/asset-crop-1.png",
					width: 1600,
					height: 1000,
					cropX: 12,
					cropY: 8,
					cropWidth: 800,
					cropHeight: 500,
					zoom: 1.25,
					cropMetadataJson: JSON.stringify({ ratio: 1.6 }),
				})
				.run();

			const crop = db
				.select()
				.from(schema.campaignAssets)
				.where(eq(schema.campaignAssets.id, "asset-crop-1"))
				.get();

			expect(crop?.sourceAssetId).toBe("asset-source-1");
			expect(crop?.variant).toBe("desktop");
			expect(crop?.cropWidth).toBe(800);
			expect(crop?.cropHeight).toBe(500);
		});
	});

	describe("messages table", () => {
		it("stores a per-conversation message sequence with a unique nullable index", () => {
			const columns = sqlite.prepare("PRAGMA table_info(messages)").all() as {
				name: string;
				notnull: number;
			}[];
			expect(columns).toContainEqual(
				expect.objectContaining({
					name: "message_sequence",
					notnull: 0,
				}),
			);

			const indexes = sqlite.prepare("PRAGMA index_list(messages)").all() as {
				name: string;
				unique: number;
			}[];
			expect(indexes).toContainEqual(
				expect.objectContaining({
					name: "messages_conversation_sequence_unique_idx",
					unique: 1,
				}),
			);
			expect(indexes).toContainEqual(
				expect.objectContaining({
					name: "messages_conversation_order_idx",
				}),
			);
		});

		it("backfills message sequence by created_at then rowid instead of UUID id", () => {
			const legacySqlite = new Database(":memory:");
			try {
				legacySqlite.exec(`
          CREATE TABLE users (
            id text PRIMARY KEY NOT NULL,
            email text NOT NULL,
            password_hash text NOT NULL
          );
          CREATE TABLE conversations (
            id text PRIMARY KEY NOT NULL,
            user_id text NOT NULL,
            title text NOT NULL,
            created_at integer DEFAULT (unixepoch()) NOT NULL,
            updated_at integer DEFAULT (unixepoch()) NOT NULL
          );
          CREATE TABLE messages (
            id text PRIMARY KEY NOT NULL,
            conversation_id text NOT NULL,
            role text NOT NULL,
            content text NOT NULL,
            created_at integer DEFAULT (unixepoch()) NOT NULL
          );
          INSERT INTO users (id, email, password_hash)
          VALUES ('user-1', 'legacy-ordering@example.com', 'hash');
          INSERT INTO conversations (id, user_id, title, created_at, updated_at)
          VALUES ('conv-1', 'user-1', 'Legacy ordering', 1777140000, 1777140000);
          INSERT INTO messages (id, conversation_id, role, content, created_at)
          VALUES
            ('z-user-message', 'conv-1', 'user', 'Question first', 1777140001),
            ('a-assistant-message', 'conv-1', 'assistant', 'Answer second', 1777140001);
        `);

				const migrationSql = readFileSync(
					"./drizzle/1777140000042_message_sequence.sql",
					"utf8",
				);
				for (const statement of migrationSql
					.split("--> statement-breakpoint")
					.map((part) => part.trim())
					.filter(Boolean)) {
					legacySqlite.exec(statement);
				}

				const rows = legacySqlite
					.prepare(
						"SELECT id, message_sequence FROM messages ORDER BY message_sequence ASC",
					)
					.all() as { id: string; message_sequence: number }[];

				expect(rows).toEqual([
					{ id: "z-user-message", message_sequence: 1 },
					{ id: "a-assistant-message", message_sequence: 2 },
				]);
			} finally {
				legacySqlite.close();
			}
		});
	});

	describe("context compression snapshots table", () => {
		it("stores conversation-owned source coverage with cascade ownership", () => {
			const columns = sqlite
				.prepare("PRAGMA table_info(context_compression_snapshots)")
				.all() as {
				name: string;
				notnull: number;
				dflt_value: string | null;
			}[];
			const columnNames = columns.map((column) => column.name);

			expect(columnNames).toEqual(
				expect.arrayContaining([
					"id",
					"conversation_id",
					"user_id",
					"trigger",
					"status",
					"model_id",
					"source_start_message_id",
					"source_end_message_id",
					"source_start_message_sequence",
					"source_end_message_sequence",
					"snapshot_json",
					"source_coverage_json",
					"source_refs_json",
					"estimated_tokens",
					"source_token_estimate",
					"failure_reason",
				]),
			);
			expect(columns).toContainEqual(
				expect.objectContaining({
					name: "status",
					notnull: 1,
					dflt_value: "'running'",
				}),
			);

			const foreignKeys = sqlite
				.prepare("PRAGMA foreign_key_list(context_compression_snapshots)")
				.all() as {
				from: string;
				table: string;
				to: string;
				on_delete: string;
			}[];
			expect(foreignKeys).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						from: "conversation_id",
						table: "conversations",
						to: "id",
						on_delete: "CASCADE",
					}),
					expect.objectContaining({
						from: "user_id",
						table: "users",
						to: "id",
						on_delete: "CASCADE",
					}),
					expect.objectContaining({
						from: "source_start_message_id",
						table: "messages",
						to: "id",
						on_delete: "CASCADE",
					}),
					expect.objectContaining({
						from: "source_end_message_id",
						table: "messages",
						to: "id",
						on_delete: "CASCADE",
					}),
				]),
			);

			const indexes = sqlite
				.prepare("PRAGMA index_list(context_compression_snapshots)")
				.all() as { name: string }[];
			expect(indexes).toContainEqual(
				expect.objectContaining({
					name: "context_compression_snapshots_conversation_source_end_idx",
				}),
			);
		});
	});

	describe("atlas tables", () => {
		it("defines exactly the two Atlas-owned persistence tables", () => {
			const tableNames = sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'atlas_%' ORDER BY name",
				)
				.all() as { name: string }[];

			expect(tableNames.map((table) => table.name)).toEqual([
				"atlas_jobs",
				"atlas_round_checkpoints",
			]);
		});

		it("keeps Atlas idempotency and round checkpoint uniqueness durable", () => {
			const jobIndexes = sqlite
				.prepare("PRAGMA index_list(atlas_jobs)")
				.all() as { name: string; unique: number }[];
			const checkpointIndexes = sqlite
				.prepare("PRAGMA index_list(atlas_round_checkpoints)")
				.all() as { name: string; unique: number }[];

			expect(jobIndexes).toContainEqual(
				expect.objectContaining({
					name: "atlas_jobs_idempotency_unique_idx",
					unique: 1,
				}),
			);
			expect(checkpointIndexes).toContainEqual(
				expect.objectContaining({
					name: "atlas_round_checkpoints_job_round_unique_idx",
					unique: 1,
				}),
			);
		});
	});

	// Analytics overhaul (backend half) — activity_events table + migration.
	// This block exercising the table through the same migrated `db` that
	// beforeAll built from ./drizzle + its journal is the migration-journal
	// test: a malformed journal entry or SQL file would already have failed
	// beforeAll for every test in this file.
	describe("activity_events table", () => {
		it("has the expected columns and nullability", () => {
			const columns = sqlite
				.prepare("PRAGMA table_info(activity_events)")
				.all() as {
				name: string;
				notnull: number;
				dflt_value: string | null;
			}[];

			const byName = new Map(columns.map((column) => [column.name, column]));
			expect(byName.get("id")).toMatchObject({ notnull: 1 });
			expect(byName.get("user_id")).toMatchObject({ notnull: 1 });
			expect(byName.get("conversation_id")).toMatchObject({ notnull: 1 });
			expect(byName.get("message_id")).toMatchObject({ notnull: 0 });
			expect(byName.get("kind")).toMatchObject({ notnull: 1 });
			expect(byName.get("name")).toMatchObject({ notnull: 1 });
			expect(byName.get("status")).toMatchObject({ notnull: 1 });
			expect(byName.get("duration_ms")).toMatchObject({ notnull: 0 });
			expect(byName.get("model_id")).toMatchObject({ notnull: 0 });
			expect(byName.get("created_at")).toMatchObject({ notnull: 1 });
		});

		it("has the (user_id, created_at) and (kind, name, created_at) indexes", () => {
			const indexes = sqlite
				.prepare("PRAGMA index_list(activity_events)")
				.all() as { name: string }[];
			const indexNames = indexes.map((index) => index.name);

			expect(indexNames).toContain("activity_events_user_created_idx");
			expect(indexNames).toContain("activity_events_kind_name_created_idx");

			const userCreatedColumns = sqlite
				.prepare("PRAGMA index_info(activity_events_user_created_idx)")
				.all() as { name: string }[];
			expect(userCreatedColumns.map((column) => column.name)).toEqual([
				"user_id",
				"created_at",
			]);

			const kindNameCreatedColumns = sqlite
				.prepare("PRAGMA index_info(activity_events_kind_name_created_idx)")
				.all() as { name: string }[];
			expect(kindNameCreatedColumns.map((column) => column.name)).toEqual([
				"kind",
				"name",
				"created_at",
			]);
		});

		it("round-trips an inserted row through Drizzle, defaulting status to done", () => {
			const userId = "activity-events-user";
			const conversationId = "activity-events-conversation";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "activity-events@example.com",
					passwordHash: "hash",
				})
				.run();
			db.insert(schema.conversations)
				.values({ id: conversationId, userId, title: "Activity events" })
				.run();

			db.insert(schema.activityEvents)
				.values({
					id: "activity-event-1",
					userId,
					conversationId,
					kind: "composer_command",
					name: "model",
				})
				.run();

			const row = db
				.select()
				.from(schema.activityEvents)
				.where(eq(schema.activityEvents.id, "activity-event-1"))
				.get();

			expect(row).toMatchObject({
				userId,
				conversationId,
				messageId: null,
				kind: "composer_command",
				name: "model",
				status: "done",
				durationMs: null,
				modelId: null,
			});
		});

		it("cascades delete when the owning conversation is deleted", () => {
			const userId = "activity-events-cascade-user";
			const conversationId = "activity-events-cascade-conversation";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "activity-events-cascade@example.com",
					passwordHash: "hash",
				})
				.run();
			db.insert(schema.conversations)
				.values({ id: conversationId, userId, title: "Cascade" })
				.run();
			db.insert(schema.activityEvents)
				.values({
					id: "activity-event-cascade",
					userId,
					conversationId,
					kind: "tool_call",
					name: "research_web",
					status: "failed",
				})
				.run();

			db.delete(schema.conversations)
				.where(eq(schema.conversations.id, conversationId))
				.run();

			const row = db
				.select()
				.from(schema.activityEvents)
				.where(eq(schema.activityEvents.id, "activity-event-cascade"))
				.get();
			expect(row).toBeUndefined();
		});
	});

	// Document-extraction ledger. As with `activity_events`, exercising the
	// tables through the same migrated `db` that `beforeAll` built from
	// ./drizzle + its journal IS the migration-journal test: a malformed journal
	// entry or SQL file would already have failed beforeAll for the whole file.
	describe("document_extraction_jobs table", () => {
		it("has the expected columns and nullability", () => {
			const columns = sqlite
				.prepare("PRAGMA table_info(document_extraction_jobs)")
				.all() as {
				name: string;
				notnull: number;
				dflt_value: string | null;
			}[];

			const byName = new Map(columns.map((column) => [column.name, column]));
			expect(byName.get("id")).toMatchObject({ notnull: 1 });
			expect(byName.get("user_id")).toMatchObject({ notnull: 1 });
			// Knowledge-page uploads have no conversation, which is the whole
			// reason this is not a row in file_production_jobs.
			expect(byName.get("conversation_id")).toMatchObject({ notnull: 0 });
			expect(byName.get("source_artifact_id")).toMatchObject({ notnull: 0 });
			expect(byName.get("chat_generated_file_id")).toMatchObject({
				notnull: 0,
			});
			expect(byName.get("normalized_artifact_id")).toMatchObject({
				notnull: 0,
			});
			expect(byName.get("origin")).toMatchObject({
				notnull: 1,
				dflt_value: "'upload'",
			});
			expect(byName.get("intake_route")).toMatchObject({ notnull: 1 });
			expect(byName.get("priority")).toMatchObject({
				notnull: 1,
				dflt_value: "0",
			});
			expect(byName.get("file_name")).toMatchObject({ notnull: 1 });
			expect(byName.get("status")).toMatchObject({
				notnull: 1,
				dflt_value: "'queued'",
			});
			expect(byName.get("attempt_count")).toMatchObject({
				notnull: 1,
				dflt_value: "0",
			});
			expect(byName.get("remote_handle_json")).toMatchObject({ notnull: 0 });
			expect(byName.get("hints_json")).toMatchObject({ notnull: 0 });
			expect(byName.get("next_attempt_at")).toMatchObject({ notnull: 0 });
			expect(byName.get("cancel_requested_at")).toMatchObject({ notnull: 0 });
			expect(byName.get("created_at")).toMatchObject({ notnull: 1 });
			expect(byName.get("updated_at")).toMatchObject({ notnull: 1 });
		});

		it("has the five indexes the claim and the read paths need", () => {
			const indexNames = (
				sqlite.prepare("PRAGMA index_list(document_extraction_jobs)").all() as {
					name: string;
				}[]
			).map((index) => index.name);

			expect(indexNames).toContain(
				"document_extraction_jobs_source_artifact_unique_idx",
			);
			expect(indexNames).toContain(
				"document_extraction_jobs_chat_file_unique_idx",
			);
			expect(indexNames).toContain("document_extraction_jobs_claim_idx");
			expect(indexNames).toContain("document_extraction_jobs_user_status_idx");
			expect(indexNames).toContain("document_extraction_jobs_conversation_idx");

			// The claim's ORDER BY is (priority, created_at) within a status.
			const claimColumns = sqlite
				.prepare("PRAGMA index_info(document_extraction_jobs_claim_idx)")
				.all() as { name: string }[];
			expect(claimColumns.map((column) => column.name)).toEqual([
				"status",
				"priority",
				"created_at",
			]);
		});

		it("allows only one job per source artifact, but many null ones", () => {
			const userId = "extraction-unique-user";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "extraction-unique@example.com",
					passwordHash: "hash",
				})
				.run();
			const artifactId = "extraction-unique-artifact";
			db.insert(schema.artifacts)
				.values({
					id: artifactId,
					userId,
					type: "source_document",
					name: "a.pdf",
				})
				.run();

			const insert = (id: string, sourceArtifactId: string | null) =>
				db
					.insert(schema.documentExtractionJobs)
					.values({
						id,
						userId,
						sourceArtifactId,
						intakeRoute: "mineru",
						fileName: "a.pdf",
					})
					.run();

			insert("extraction-job-1", artifactId);
			// The dedupe re-upload bug is structurally impossible: a second job
			// for the same artifact cannot exist.
			expect(() => insert("extraction-job-2", artifactId)).toThrow(
				/UNIQUE constraint failed/,
			);
			// The index is partial, so readback jobs (null source) do not collide.
			expect(() => insert("extraction-job-3", null)).not.toThrow();
			expect(() => insert("extraction-job-4", null)).not.toThrow();
		});

		it("cascades delete when the source artifact is deleted", () => {
			const userId = "extraction-cascade-user";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "extraction-cascade@example.com",
					passwordHash: "hash",
				})
				.run();
			db.insert(schema.artifacts)
				.values({
					id: "extraction-cascade-artifact",
					userId,
					type: "source_document",
					name: "b.pdf",
				})
				.run();
			db.insert(schema.documentExtractionJobs)
				.values({
					id: "extraction-cascade-job",
					userId,
					sourceArtifactId: "extraction-cascade-artifact",
					intakeRoute: "mineru",
					fileName: "b.pdf",
				})
				.run();
			db.insert(schema.documentExtractionJobAttempts)
				.values({
					id: "extraction-cascade-attempt",
					jobId: "extraction-cascade-job",
					attemptNumber: 1,
				})
				.run();

			db.delete(schema.artifacts)
				.where(eq(schema.artifacts.id, "extraction-cascade-artifact"))
				.run();

			expect(
				db
					.select()
					.from(schema.documentExtractionJobs)
					.where(eq(schema.documentExtractionJobs.id, "extraction-cascade-job"))
					.get(),
			).toBeUndefined();
			// And the attempt goes with it, rather than orphaning.
			expect(
				db
					.select()
					.from(schema.documentExtractionJobAttempts)
					.where(
						eq(
							schema.documentExtractionJobAttempts.id,
							"extraction-cascade-attempt",
						),
					)
					.get(),
			).toBeUndefined();
		});
	});

	describe("document_extraction_job_attempts table", () => {
		it("has the expected columns and nullability", () => {
			const columns = sqlite
				.prepare("PRAGMA table_info(document_extraction_job_attempts)")
				.all() as {
				name: string;
				notnull: number;
				dflt_value: string | null;
			}[];

			const byName = new Map(columns.map((column) => [column.name, column]));
			expect(byName.get("id")).toMatchObject({ notnull: 1 });
			expect(byName.get("job_id")).toMatchObject({ notnull: 1 });
			expect(byName.get("attempt_number")).toMatchObject({ notnull: 1 });
			expect(byName.get("status")).toMatchObject({
				notnull: 1,
				dflt_value: "'running'",
			});
			expect(byName.get("phase")).toMatchObject({ notnull: 0 });
			expect(byName.get("extractor")).toMatchObject({ notnull: 0 });
			expect(byName.get("resumed")).toMatchObject({
				notnull: 1,
				dflt_value: "0",
			});
			expect(byName.get("worker_id")).toMatchObject({ notnull: 0 });
			expect(byName.get("heartbeat_at")).toMatchObject({ notnull: 0 });
			expect(byName.get("text_length")).toMatchObject({ notnull: 0 });
			expect(byName.get("page_count")).toMatchObject({ notnull: 0 });
		});

		it("has its three indexes and keeps attempt numbers unique per job", () => {
			const indexNames = (
				sqlite
					.prepare("PRAGMA index_list(document_extraction_job_attempts)")
					.all() as { name: string }[]
			).map((index) => index.name);

			expect(indexNames).toContain(
				"document_extraction_job_attempts_job_number_unique_idx",
			);
			expect(indexNames).toContain("document_extraction_job_attempts_job_idx");
			expect(indexNames).toContain(
				"document_extraction_job_attempts_worker_idx",
			);
		});
	});

	describe("artifact_chunks page columns", () => {
		it("carries nullable page_start / page_end so legacy rows still migrate", () => {
			const columns = sqlite
				.prepare("PRAGMA table_info(artifact_chunks)")
				.all() as {
				name: string;
				type: string;
				notnull: number;
				dflt_value: string | null;
			}[];

			const byName = new Map(columns.map((column) => [column.name, column]));
			// Nullable on purpose: direct-text extraction has no pages at all, and
			// every row written before structure-aware chunking has none either. A
			// NOT NULL here would make the migration unrunnable on a populated DB.
			for (const name of ["page_start", "page_end"] as const) {
				const column = byName.get(name);
				expect(column, name).toBeDefined();
				expect(column?.type.toLowerCase(), name).toBe("integer");
				expect(column?.notnull, name).toBe(0);
				expect(column?.dflt_value, name).toBeNull();
			}
		});

		it("accepts a row that leaves both page columns unset", () => {
			const userId = "chunk-page-user";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "chunk-page@example.com",
					passwordHash: "hash",
					name: "Chunk Page",
				})
				.run();
			db.insert(schema.artifacts)
				.values({
					id: "chunk-page-artifact",
					userId,
					type: "generated_file",
					name: "doc.md",
				})
				.run();
			db.insert(schema.artifactChunks)
				.values({
					id: "chunk-page-1",
					artifactId: "chunk-page-artifact",
					userId,
					chunkIndex: 0,
					contentText: "body",
				})
				.run();

			const row = db
				.select()
				.from(schema.artifactChunks)
				.where(eq(schema.artifactChunks.id, "chunk-page-1"))
				.get();
			expect(row?.pageStart).toBeNull();
			expect(row?.pageEnd).toBeNull();
		});
	});

	// The claim runs `status = 'running' limit 1` and then
	// `status = 'queued' order by created_at asc limit 1`; the idle tick runs one
	// aggregate over the same two statuses, forever, on boxes where nobody
	// produces anything. All three used to scan the whole table.
	describe("file_production_jobs live-claim index", () => {
		it("is a partial index on (status, created_at) over the live statuses", () => {
			const indexNames = (
				sqlite.prepare("PRAGMA index_list(file_production_jobs)").all() as {
					name: string;
					partial: number;
				}[]
			).map((index) => index.name);
			expect(indexNames).toContain("file_production_jobs_live_claim_idx");

			const partial = (
				sqlite.prepare("PRAGMA index_list(file_production_jobs)").all() as {
					name: string;
					partial: number;
				}[]
			).find((index) => index.name === "file_production_jobs_live_claim_idx");
			expect(partial?.partial).toBe(1);

			// `created_at` second, so the claim's ORDER BY needs no temp b-tree.
			const columns = sqlite
				.prepare("PRAGMA index_info(file_production_jobs_live_claim_idx)")
				.all() as { name: string }[];
			expect(columns.map((column) => column.name)).toEqual([
				"status",
				"created_at",
			]);
		});

		// SQLite only uses a partial index when it can see the index's own WHERE
		// terms in the query's. It proves `status = 'running'` implies
		// `status = 'queued' or status = 'running'` and does NOT prove it implies
		// `status in ('queued','running')`, so the predicate is spelled with
		// `or`. Spelled the other way, both claim probes went back to a scan
		// while the plan for the idle tick still looked healthy — which is why
		// this is asserted on the plan rather than on the DDL text.
		it("is the plan the claim and the idle tick actually get", () => {
			const planFor = (sql: string) =>
				(
					sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as {
						detail: string;
					}[]
				)
					.map((row) => row.detail)
					.join(" | ");

			expect(
				planFor(
					"SELECT id FROM file_production_jobs WHERE status = 'running' LIMIT 1",
				),
			).toContain("file_production_jobs_live_claim_idx");
			const queued = planFor(
				"SELECT * FROM file_production_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
			);
			expect(queued).toContain("file_production_jobs_live_claim_idx");
			expect(queued).not.toContain("TEMP B-TREE");
			expect(
				planFor(
					"SELECT sum(case when status = 'running' then 1 else 0 end), sum(case when status = 'queued' then 1 else 0 end) FROM file_production_jobs WHERE status = 'queued' or status = 'running'",
				),
			).toContain("file_production_jobs_live_claim_idx");
		});
	});

	describe("artifacts auto-rename index", () => {
		it("indexes (user_id, name) so a collision check is not a per-user scan", () => {
			const indexNames = (
				sqlite.prepare("PRAGMA index_list(artifacts)").all() as {
					name: string;
				}[]
			).map((index) => index.name);
			expect(indexNames).toContain("artifacts_user_name_idx");

			const columns = sqlite
				.prepare("PRAGMA index_info(artifacts_user_name_idx)")
				.all() as { name: string }[];
			expect(columns.map((column) => column.name)).toEqual(["user_id", "name"]);
		});
	});
});

// The MinerU 4 migration does two unrelated things in one file on purpose: the
// journal is a single-owner hot file, so both phases' DDL travels together.
// The half that can silently lose data is the config rename — a real
// `admin_config` row for `MINERU_TIMEOUT_MS` (the dev box has 600000) must
// come out the other side as `MINERU_JOB_TIMEOUT_MS`, because removing the old
// key from ADMIN_CONFIG_KEYS would otherwise orphan the row: the apply loop
// iterates the key list, so the override would stop having any effect while
// still sitting in the table.
//
// Proven end to end rather than by reading the SQL: the database is first
// migrated with every migration EXCEPT this one (an exact copy of `drizzle/`
// with the last journal entry and its file removed, so drizzle's own hashes
// still match), the override is written as it exists in production, and only
// then is the real migrations folder applied.
describe("MINERU_TIMEOUT_MS override migration", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "alfyai-mineru4-migration-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/**
	 * The migrations folder as it stood the moment BEFORE the MinerU 4
	 * migration — every entry up to it, and none after.
	 *
	 * "Every migration except that one" is the same thing only while it is the
	 * last entry, and it stopped being the last entry. Drizzle decides what to
	 * apply by comparing each migration's `folderMillis` against the newest one
	 * already recorded, so replaying a folder that still held the LATER
	 * migrations left a newer timestamp in `__drizzle_migrations` and the second
	 * pass skipped the MinerU 4 file entirely — the test then asserted a rename
	 * that had never been given the chance to run.
	 */
	function migrationsFolderBeforeMineru4(): string {
		const folder = join(workDir, "drizzle-before");
		if (existsSync(folder)) return folder;
		mkdirSync(join(folder, "meta"), { recursive: true });

		const journal = JSON.parse(
			readFileSync("./drizzle/meta/_journal.json", "utf8"),
		) as { entries: Array<{ tag: string }> };
		const cutoff = journal.entries.findIndex(
			(entry) => entry.tag === MINERU4_MIGRATION_TAG,
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

	it("carries an existing override over to MINERU_JOB_TIMEOUT_MS", () => {
		const before = migrationsFolderBeforeMineru4();
		const { sqlite, db } = openDb("carry-over.db");
		try {
			migrate(db, { migrationsFolder: before });

			sqlite
				.prepare(
					"INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
				)
				.run("MINERU_TIMEOUT_MS", "600000", 1777140000, "admin-1");

			migrate(db, { migrationsFolder: "./drizzle" });

			const rows = sqlite
				.prepare(
					"SELECT key, value, updated_by FROM admin_config WHERE key LIKE 'MINERU%'",
				)
				.all() as { key: string; value: string; updated_by: string }[];

			expect(rows).toEqual([
				{
					key: "MINERU_JOB_TIMEOUT_MS",
					value: "600000",
					updated_by: "admin-1",
				},
			]);

			// The Phase 4 half of the same file landed too.
			const columns = (
				sqlite.prepare("PRAGMA table_info(artifact_chunks)").all() as {
					name: string;
				}[]
			).map((column) => column.name);
			expect(columns).toContain("page_start");
			expect(columns).toContain("page_end");
		} finally {
			sqlite.close();
		}
	});

	it("lets an already-set MINERU_JOB_TIMEOUT_MS win and still drops the old row", () => {
		const before = migrationsFolderBeforeMineru4();
		const { sqlite, db } = openDb("already-set.db");
		try {
			migrate(db, { migrationsFolder: before });

			const insert = sqlite.prepare(
				"INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
			);
			insert.run("MINERU_TIMEOUT_MS", "600000", 1777140000, "admin-1");
			insert.run("MINERU_JOB_TIMEOUT_MS", "120000", 1777140001, "admin-2");

			migrate(db, { migrationsFolder: "./drizzle" });

			const rows = sqlite
				.prepare(
					"SELECT key, value FROM admin_config WHERE key LIKE 'MINERU%' ORDER BY key",
				)
				.all() as { key: string; value: string }[];

			expect(rows).toEqual([{ key: "MINERU_JOB_TIMEOUT_MS", value: "120000" }]);
		} finally {
			sqlite.close();
		}
	});

	it("is a no-op for a database that never had the override", () => {
		const before = migrationsFolderBeforeMineru4();
		const { sqlite, db } = openDb("no-override.db");
		try {
			migrate(db, { migrationsFolder: before });
			migrate(db, { migrationsFolder: "./drizzle" });

			const rows = sqlite
				.prepare("SELECT key FROM admin_config WHERE key LIKE 'MINERU%'")
				.all();
			expect(rows).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});
