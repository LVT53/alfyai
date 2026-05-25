import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";

const TEST_DB_PATH = "./test-data/schema-test.db";

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
			expect(user?.honchoPeerVersion).toBe(0);
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
		it("links at most one project folder to a canonical memory project", () => {
			const columns = sqlite.prepare("PRAGMA table_info(projects)").all() as {
				name: string;
			}[];
			const columnNames = columns.map((column) => column.name);
			expect(columnNames).toContain("canonical_memory_project_id");

			const indexes = sqlite.prepare("PRAGMA index_list(projects)").all() as {
				name: string;
				unique: number;
			}[];
			expect(indexes).toContainEqual(
				expect.objectContaining({
					name: "projects_canonical_memory_project_id_unique_idx",
					unique: 1,
				}),
			);

			const foreignKeys = sqlite
				.prepare("PRAGMA foreign_key_list(projects)")
				.all() as {
				from: string;
				table: string;
				to: string;
				on_delete: string;
			}[];
			expect(foreignKeys).toContainEqual(
				expect.objectContaining({
					from: "canonical_memory_project_id",
					table: "memory_projects",
					to: "project_id",
					on_delete: "SET NULL",
				}),
			);

			const userId = "test-user-project-folder-link";
			db.insert(schema.users)
				.values({
					id: userId,
					email: "project-folder@example.com",
					passwordHash: "hash789",
					name: "Project Folder Test User",
				})
				.run();

			db.insert(schema.memoryProjects)
				.values({
					projectId: "memory-project-1",
					userId,
					name: "Canonical continuity",
				})
				.run();

			db.insert(schema.projects)
				.values({
					id: "folder-with-canonical",
					userId,
					name: "Folder with canonical continuity",
					canonicalMemoryProjectId: "memory-project-1",
				})
				.run();

			db.insert(schema.projects)
				.values([
					{
						id: "folder-without-canonical-1",
						userId,
						name: "Unlinked folder one",
					},
					{
						id: "folder-without-canonical-2",
						userId,
						name: "Unlinked folder two",
					},
				])
				.run();

			expect(() =>
				db
					.insert(schema.projects)
					.values({
						id: "duplicate-folder-canonical",
						userId,
						name: "Duplicate canonical continuity",
						canonicalMemoryProjectId: "memory-project-1",
					})
					.run(),
			).toThrow();
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
		it("stores explicit skill kind, optional base pack references, and session audit snapshot fields", () => {
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

			const sessionColumns = sqlite
				.prepare("PRAGMA table_info(skill_sessions)")
				.all() as {
				name: string;
				notnull: number;
				dflt_value: string | null;
			}[];
			expect(sessionColumns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"skill_kind",
					"pack_skill_id",
					"pack_skill_version",
					"variant_skill_id",
					"variant_skill_version",
					"effective_instructions_hash",
				]),
			);
			expect(
				sessionColumns.find((column) => column.name === "skill_kind")?.notnull,
			).toBe(1);
			expect(
				sessionColumns.find(
					(column) => column.name === "effective_instructions_hash",
				)?.notnull,
			).toBe(1);
		});

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
});
