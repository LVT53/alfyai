import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	explicitErasureTables,
	tablesForResetScope,
	USER_SCOPED_TABLES,
} from "./user-scoped-tables";

// A column name that directly keys a row to a person (holds a `users.id` value).
// Covers the plain `user_id` column, the `admin_config.updated_by` author stamp
// (which stores a userId or the literal "detached"), and every `*_by_user_id`
// authorship column (uploaded_by / created_by / published_by).
function isPersonKeyingColumnName(name: string): boolean {
	return (
		name === "user_id" || name === "updated_by" || name.endsWith("_by_user_id")
	);
}

// Tables that DO carry a person-keying column but are intentionally NOT in
// USER_SCOPED_TABLES because full erasure handles them outside the per-user
// explicit-delete / cascade paths — their authorship is detached or nulled by
// detachSharedContentAuthorship (ADR-0031), leaving the shared row intact. Each
// entry documents why it is safe to omit from the registry.
const NON_REGISTRY_PERSON_TABLES: Record<string, string> = {
	admin_config:
		"author stamp only (updated_by); reset to 'detached' by detachSharedContentAuthorship",
	announcement_campaigns:
		"author stamps only (created_by_user_id / published_by_user_id); set null by detachSharedContentAuthorship",
	announcement_campaign_snapshots:
		"author stamp only (published_by_user_id); set null by detachSharedContentAuthorship",
};

// Enumerate every SQLite table in schema.ts that keys rows to a person.
function schemaTablesWithPersonColumn(): string[] {
	const names: string[] = [];
	for (const value of Object.values(schema)) {
		if (!is(value, SQLiteTable)) continue;
		const columns = getTableColumns(value);
		const hasPersonColumn = Object.values(columns).some((column) =>
			isPersonKeyingColumnName(column.name),
		);
		if (hasPersonColumn) names.push(getTableName(value));
	}
	return names;
}

const {
	mockQuiesceUserMemoryMaintenance,
	mockRequestActiveChatStreamsStopForUser,
} = vi.hoisted(() => ({
	mockQuiesceUserMemoryMaintenance: vi.fn(),
	mockRequestActiveChatStreamsStopForUser: vi.fn(),
}));

vi.mock("../memory-maintenance", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../memory-maintenance")>();
	return {
		...actual,
		quiesceUserMemoryMaintenance: mockQuiesceUserMemoryMaintenance,
	};
});

vi.mock("../chat-turn/active-streams", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../chat-turn/active-streams")>();
	return {
		...actual,
		requestActiveChatStreamsStopForUser:
			mockRequestActiveChatStreamsStopForUser,
	};
});

let dbPath: string;

function openMigratedDb() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

// Seed one row keyed to `userId` in EVERY user-scoped table (plus the required
// FK parents). Used to prove full erasure leaves zero survivors anywhere.
function seedEveryUserScopedTable(userId: string) {
	const { sqlite, db } = openMigratedDb();
	const now = new Date("2026-06-15T10:00:00.000Z");
	const p = (suffix: string) => `${userId}-${suffix}`;

	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			name: `Person ${userId}`,
			passwordHash: "hash",
			role: "admin",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	// --- Parents ---
	db.insert(schema.conversations)
		.values([
			{ id: p("conv"), userId, title: "Chat", createdAt: now, updatedAt: now },
			{
				id: p("conv-fork"),
				userId,
				title: "Fork",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
	db.insert(schema.projects)
		.values({
			id: p("proj"),
			userId,
			name: "Project",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.artifacts)
		.values({
			id: p("art"),
			userId,
			type: "source_document",
			name: "Doc",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: p("msg"),
			conversationId: p("conv"),
			messageSequence: 1,
			role: "assistant",
			content: "Answer",
			metadataJson: JSON.stringify({
				evidenceStatus: "ready",
				evidenceSummary: { groups: [] },
			}),
			createdAt: now,
		})
		.run();
	db.insert(schema.announcementCampaigns)
		.values({
			id: p("campaign"),
			type: "feature",
			status: "published",
			identityKey: p("feature"),
			name: "Campaign",
			campaignVersion: p("2026.06"),
			revision: 1,
			createdByUserId: userId,
			publishedByUserId: userId,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		})
		.run();
	db.insert(schema.announcementCampaignSnapshots)
		.values({
			id: p("snapshot"),
			campaignId: p("campaign"),
			identityKey: p("feature-published"),
			type: "feature",
			name: "Campaign",
			campaignVersion: p("2026.06"),
			revision: 1,
			publishedByUserId: userId,
			publishedAt: now,
		})
		.run();

	// --- Every user-scoped table ---
	db.insert(schema.sessions)
		.values({ id: p("session"), userId, expiresAt: now })
		.run();
	db.insert(schema.browserPushSubscriptions)
		.values({
			id: p("push"),
			userId,
			endpoint: p("endpoint"),
			p256dh: "k",
			auth: "a",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversationSummaries)
		.values({
			conversationId: p("conv"),
			userId,
			summary: "Summary",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.contextCompressionSnapshots)
		.values({
			id: p("ccs"),
			conversationId: p("conv"),
			userId,
			trigger: "manual",
			modelId: "model1",
			sourceStartMessageId: p("msg"),
			sourceEndMessageId: p("msg"),
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversationForks)
		.values({
			id: p("fork"),
			forkConversationId: p("conv-fork"),
			userId,
			sourceConversationIdSnapshot: p("conv"),
			sourceAssistantMessageIdSnapshot: p("msg"),
			copiedForkPointMessageId: p("msg"),
			sourceTitle: "Chat",
			forkSequence: 1,
			createdAt: now,
		})
		.run();
	db.insert(schema.artifactChunks)
		.values({
			id: p("chunk"),
			artifactId: p("art"),
			userId,
			chunkIndex: 0,
			contentText: "chunk",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.artifactLinks)
		.values({
			id: p("link"),
			userId,
			artifactId: p("art"),
			linkType: "related",
			createdAt: now,
		})
		.run();
	db.insert(schema.conversationContextStatus)
		.values({ conversationId: p("conv"), userId, updatedAt: now })
		.run();
	db.insert(schema.conversationTaskStates)
		.values({
			taskId: p("task"),
			userId,
			conversationId: p("conv"),
			objective: "Goal",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.taskStateEvidenceLinks)
		.values({
			id: p("evidence"),
			taskId: p("task"),
			userId,
			conversationId: p("conv"),
			artifactId: p("art"),
			role: "supporting",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.taskCheckpoints)
		.values({
			id: p("checkpoint"),
			taskId: p("task"),
			userId,
			conversationId: p("conv"),
			checkpointType: "stable",
			content: "checkpoint",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversationWorkingSetItems)
		.values({
			id: p("working"),
			userId,
			conversationId: p("conv"),
			artifactId: p("art"),
			artifactType: "source_document",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.semanticEmbeddings)
		.values({
			id: p("embedding"),
			userId,
			subjectType: "artifact",
			subjectId: p("art"),
			modelName: "tei",
			sourceTextHash: "hash",
			dimensions: 1,
			embeddingJson: "[0.1]",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryEvents)
		.values({
			id: p("mem-event"),
			eventKey: p("mem-event"),
			userId,
			conversationId: p("conv"),
			messageId: p("msg"),
			domain: "task",
			eventType: "remembered",
			observedAt: now,
			createdAt: now,
		})
		.run();
	db.insert(schema.memoryResetGenerations)
		.values({ userId, resetGeneration: 0, createdAt: now, updatedAt: now })
		.run();
	db.insert(schema.memoryProjectionState)
		.values({
			id: p("projection"),
			userId,
			resetGeneration: 0,
			revision: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversationMemoryWatermarks)
		.values({ conversationId: p("conv"), userId, updatedAt: now })
		.run();
	db.insert(schema.memoryConsolidationReports)
		.values({
			id: p("consolidation"),
			userId,
			status: "succeeded",
			summaryText: "report",
			createdAt: now,
		})
		.run();
	db.insert(schema.memoryProfileItems)
		.values({
			id: p("profile-item"),
			userId,
			projectionStateId: p("projection"),
			resetGeneration: 0,
			itemKey: p("item-key"),
			category: "about_you",
			statement: "Fact.",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryProfileItemProvenance)
		.values({
			id: p("provenance"),
			itemId: p("profile-item"),
			userId,
			resetGeneration: 0,
			sourceType: "user_statement",
			label: "Chat",
			createdAt: now,
		})
		.run();
	db.insert(schema.memoryReviewItems)
		.values({
			id: p("review"),
			userId,
			resetGeneration: 0,
			subjectKey: "subject",
			subjectLabel: "subject",
			question: "Q?",
			reason: "reason",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryReviewResolutions)
		.values({
			id: p("resolution"),
			reviewItemId: p("review"),
			userId,
			resetGeneration: 0,
			resolutionType: "use_fact",
			createdAt: now,
		})
		.run();
	db.insert(schema.memoryDirtyLedger)
		.values({
			id: p("dirty"),
			userId,
			resetGeneration: 0,
			reason: "possible_conflict",
			firstMarkedAt: now,
			lastMarkedAt: now,
		})
		.run();
	db.insert(schema.memoryReworkTelemetry)
		.values({
			id: p("telemetry"),
			userId,
			resetGeneration: 0,
			eventFamily: "guided_review",
			eventName: "created",
			createdAt: now,
		})
		.run();
	db.insert(schema.conversationDrafts)
		.values({
			conversationId: p("conv"),
			userId,
			draftText: "draft",
			updatedAt: now,
		})
		.run();
	db.insert(schema.userSkillDefinitions)
		.values([
			{
				id: p("skill-user"),
				userId,
				ownership: "user",
				displayName: "User Skill",
				instructions: "Do work.",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: p("skill-system"),
				userId,
				ownership: "system",
				displayName: "System Skill",
				instructions: "Shared.",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
	db.insert(schema.skillSessions)
		.values({
			id: p("skill-session"),
			userId,
			conversationId: p("conv"),
			skillId: p("skill-user"),
			skillOwnership: "user",
			skillDisplayName: "User Skill",
			skillInstructions: "Do work.",
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "current_conversation",
			skillVersion: 1,
			startedFrom: "user",
			startedAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.skillSessionMilestones)
		.values({
			id: p("milestone"),
			sessionId: p("skill-session"),
			userId,
			conversationId: p("conv"),
			kind: "note",
			messageKey: "key",
			createdAt: now,
		})
		.run();
	db.insert(schema.skillNoteOperations)
		.values({
			id: p("note-op"),
			sessionId: p("skill-session"),
			userId,
			conversationId: p("conv"),
			assistantMessageId: p("msg"),
			operationId: "op1",
			action: "append",
			artifactId: p("art"),
			createdAt: now,
		})
		.run();
	db.insert(schema.skillNoteCheckpoints)
		.values({
			id: p("note-checkpoint"),
			noteArtifactId: p("art"),
			sessionId: p("skill-session"),
			userId,
			conversationId: p("conv"),
			assistantMessageId: p("msg"),
			operationId: "op1",
			previousBody: "body",
			createdAt: now,
		})
		.run();
	db.insert(schema.importJobs)
		.values({ id: p("import"), userId, createdAt: now, updatedAt: now })
		.run();
	db.insert(schema.messageAnalytics)
		.values({
			id: p("msg-analytics"),
			messageId: p("msg"),
			userId,
			model: "model1",
			createdAt: now,
		})
		.run();
	db.insert(schema.chatGeneratedFiles)
		.values({
			id: p("file"),
			conversationId: p("conv"),
			assistantMessageId: p("msg"),
			userId,
			filename: "report.pdf",
			storagePath: "data/generated/report.pdf",
			createdAt: now,
		})
		.run();
	db.insert(schema.fileProductionJobs)
		.values({
			id: p("file-job"),
			conversationId: p("conv"),
			assistantMessageId: p("msg"),
			userId,
			title: "File",
			status: "succeeded",
			origin: "produce_file",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	// Transitive-cascade grandchild: no user_id of its own, removed only via
	// file_production_jobs -> users cascade.
	db.insert(schema.fileProductionJobAttempts)
		.values({
			id: p("file-attempt"),
			jobId: p("file-job"),
			attemptNumber: 1,
			status: "succeeded",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.atlasJobs)
		.values({
			id: p("atlas"),
			userId,
			conversationId: p("conv"),
			assistantMessageId: p("msg"),
			action: "create",
			profile: "overview",
			normalizedQueryHash: "hash",
			clientAtlasTurnId: p("atlas-turn"),
			idempotencyKey: p("atlas-idem"),
			title: "Atlas",
			status: "succeeded",
			stage: "complete",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	// Transitive-cascade grandchild: no user_id of its own, removed only via
	// atlas_jobs -> users cascade.
	db.insert(schema.atlasRoundCheckpoints)
		.values({
			id: p("atlas-checkpoint"),
			jobId: p("atlas"),
			roundNumber: 1,
			stage: "synthesize",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.announcementCampaignUserStates)
		.values({
			id: p("campaign-state"),
			userId,
			campaignId: p("campaign"),
			snapshotId: p("snapshot"),
			status: "seen",
			reason: "eligible",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.announcementCampaignEvents)
		.values({
			id: p("campaign-event"),
			userId,
			campaignId: p("campaign"),
			snapshotId: p("snapshot"),
			eventType: "viewed",
			createdAt: now,
		})
		.run();
	db.insert(schema.userConnections)
		.values({
			id: p("connection"),
			userId,
			provider: "nextcloud",
			label: "Nextcloud",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.connectionPendingWrites)
		.values({
			id: p("pending-write"),
			userId,
			connectionId: p("connection"),
			provider: "nextcloud",
			opJson: "{}",
			idempotencyKey: p("write-idem"),
			previewJson: "{}",
			createdAt: now,
		})
		.run();
	db.insert(schema.campaignAssets)
		.values({
			id: p("asset"),
			uploadedByUserId: userId,
			assetKind: "image",
			status: "ready",
			originalFilename: "hero.png",
			mimeType: "image/png",
			sizeBytes: 10,
			storagePath: "data/campaign-assets/hero.png",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.usageEvents)
		.values({
			id: p("usage"),
			userId,
			conversationId: p("conv"),
			conversationTitle: "Chat",
			messageId: p("msg"),
			modelId: "model1",
			billingMonth: "2026-06",
			createdAt: now,
		})
		.run();
	db.insert(schema.analyticsConversations)
		.values({
			id: p("analytics-conv"),
			conversationId: p("conv"),
			userId,
			title: "Chat",
			billingMonth: "2026-06",
			conversationCreatedAt: now,
			createdAt: now,
		})
		.run();

	sqlite.close();
}

async function countRowsForUser(
	userColumn: (typeof USER_SCOPED_TABLES)[number]["userColumn"],
	table: (typeof USER_SCOPED_TABLES)[number]["table"],
	userId: string,
): Promise<number> {
	const { db } = await import("$lib/server/db");
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(table)
		.where(sql`${userColumn} = ${userId}`);
	return Number(row?.count ?? 0);
}

describe("account-lifecycle user-scoped-table registry", () => {
	it("classifies exactly the known set of user-scoped tables", () => {
		const names = USER_SCOPED_TABLES.map((entry) => entry.name).sort();
		expect(names).toEqual(
			[
				"analytics_conversations",
				"announcement_campaign_events",
				"announcement_campaign_user_states",
				"artifact_chunks",
				"artifact_links",
				"artifacts",
				"atlas_jobs",
				"browser_push_subscriptions",
				"campaign_assets",
				"chat_generated_files",
				"connection_pending_writes",
				"context_compression_snapshots",
				"conversation_context_status",
				"conversation_drafts",
				"conversation_forks",
				"conversation_memory_watermarks",
				"conversation_summaries",
				"conversation_task_states",
				"conversation_working_set_items",
				"conversations",
				"file_production_jobs",
				"import_jobs",
				"memory_consolidation_reports",
				"memory_dirty_ledger",
				"memory_events",
				"memory_profile_item_provenance",
				"memory_profile_items",
				"memory_projection_state",
				"memory_reset_generations",
				"memory_review_items",
				"memory_review_resolutions",
				"memory_rework_telemetry",
				"message_analytics",
				"projects",
				"semantic_embeddings",
				"sessions",
				"skill_note_checkpoints",
				"skill_note_operations",
				"skill_session_milestones",
				"skill_sessions",
				"task_checkpoints",
				"task_state_evidence_links",
				"usage_events",
				"user_connections",
				"user_skill_definitions",
			].sort(),
		);
	});

	it("registers (or explicitly allowlists) every schema table that keys rows to a person", () => {
		// Schema-derived completeness guard: a NEW user-scoped table added to
		// schema.ts that is neither registered in USER_SCOPED_TABLES nor documented
		// on NON_REGISTRY_PERSON_TABLES fails this test — which is exactly the
		// guarantee the registry comment promises. This does not rely on a
		// hand-maintained name list.
		const registered = new Set(USER_SCOPED_TABLES.map((entry) => entry.name));
		const unclassified = schemaTablesWithPersonColumn().filter(
			(name) => !registered.has(name) && !(name in NON_REGISTRY_PERSON_TABLES),
		);
		expect(unclassified).toEqual([]);
	});

	it("keeps the non-registry allowlist minimal and mutually exclusive with the registry", () => {
		const registered = new Set(USER_SCOPED_TABLES.map((entry) => entry.name));
		// Every allowlisted table really has a person column (otherwise it should
		// not be on the list at all)...
		const personTables = new Set(schemaTablesWithPersonColumn());
		for (const name of Object.keys(NON_REGISTRY_PERSON_TABLES)) {
			expect(
				personTables.has(name),
				`${name} should have a person column`,
			).toBe(true);
			// ...and is not ALSO in the registry (a table is handled one way).
			expect(
				registered.has(name),
				`${name} must not be double-classified`,
			).toBe(false);
		}
	});

	it("has exactly two explicit (non-cascading) tables — the analytics rollups", () => {
		expect(
			explicitErasureTables()
				.map((entry) => entry.name)
				.sort(),
		).toEqual(["analytics_conversations", "usage_events"]);
	});

	it("keeps memory and workspace reset scopes as documented subsets", () => {
		expect(tablesForResetScope("memory").map((entry) => entry.name)).toEqual([
			"task_state_evidence_links",
			"task_checkpoints",
			"conversation_task_states",
			"memory_events",
			"semantic_embeddings",
			"conversation_working_set_items",
			"conversation_context_status",
			"memory_projection_state",
			"memory_review_items",
			"memory_dirty_ledger",
			"memory_rework_telemetry",
			"conversation_summaries",
		]);
		expect(tablesForResetScope("workspace").map((entry) => entry.name)).toEqual(
			[
				"task_state_evidence_links",
				"task_checkpoints",
				"conversation_task_states",
				"memory_events",
				"semantic_embeddings",
				"conversation_working_set_items",
				"conversation_context_status",
				"sessions",
				"browser_push_subscriptions",
				"chat_generated_files",
				"conversation_drafts",
				"projects",
				"conversations",
			],
		);
	});
});

describe("full account erasure leaves no person-linked survivor", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-account-lifecycle-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		mockQuiesceUserMemoryMaintenance.mockResolvedValue(undefined);
		mockRequestActiveChatStreamsStopForUser.mockReturnValue({ stopped: 0 });
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// DB may not have been imported.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort.
		}
	});

	it("erases every user-scoped table for the target user while sparing another user", async () => {
		seedEveryUserScopedTable("erase-me");
		seedEveryUserScopedTable("keep-me");

		const { eraseUserAccountData } = await import("./index");
		await eraseUserAccountData("erase-me");

		// Load-bearing guarantee: ZERO rows keyed to the erased user survive in ANY
		// user-scoped table (cascade, explicit, or detach — detach reassigns
		// authorship so it is no longer keyed to the erased user either).
		for (const entry of USER_SCOPED_TABLES) {
			const survivors = await countRowsForUser(
				entry.userColumn,
				entry.table,
				"erase-me",
			);
			expect(
				survivors,
				`expected 0 rows keyed to erased user in ${entry.name}, found ${survivors}`,
			).toBe(0);
		}

		const { db } = await import("$lib/server/db");

		// Transitive-cascade coverage: rows with no user_id of their own are still
		// removed because their parent chain terminates at the erased users row.
		// messages: conversations -> users. file_production_job_attempts:
		// file_production_jobs -> users. atlas_round_checkpoints: atlas_jobs -> users.
		const transitiveSurvivors = {
			messages: (
				await db
					.select({ id: schema.messages.id })
					.from(schema.messages)
					.where(sql`${schema.messages.conversationId} = 'erase-me-conv'`)
			).length,
			fileProductionJobAttempts: (
				await db
					.select({ id: schema.fileProductionJobAttempts.id })
					.from(schema.fileProductionJobAttempts)
					.where(
						sql`${schema.fileProductionJobAttempts.id} = 'erase-me-file-attempt'`,
					)
			).length,
			atlasRoundCheckpoints: (
				await db
					.select({ id: schema.atlasRoundCheckpoints.id })
					.from(schema.atlasRoundCheckpoints)
					.where(
						sql`${schema.atlasRoundCheckpoints.id} = 'erase-me-atlas-checkpoint'`,
					)
			).length,
		};
		expect(transitiveSurvivors).toEqual({
			messages: 0,
			fileProductionJobAttempts: 0,
			atlasRoundCheckpoints: 0,
		});

		// The erased users row itself is gone.
		const remainingUsers = await db
			.select({ id: schema.users.id })
			.from(schema.users);
		const ids = remainingUsers.map((row) => row.id);
		expect(ids).not.toContain("erase-me");
		expect(ids).toContain("keep-me");
		expect(ids).toContain("detached-shared-content-owner");

		// The other user keeps a full complement of rows (no collateral deletion).
		for (const entry of USER_SCOPED_TABLES) {
			if (entry.erasure === "detach") continue;
			const kept = await countRowsForUser(
				entry.userColumn,
				entry.table,
				"keep-me",
			);
			expect(
				kept,
				`expected keep-me rows to survive in ${entry.name}`,
			).toBeGreaterThan(0);
		}

		// ADR-0031: the erased user's shared content is detached, not destroyed.
		const detachedAssets = await db
			.select({ id: schema.campaignAssets.id })
			.from(schema.campaignAssets)
			.where(
				sql`${schema.campaignAssets.uploadedByUserId} = 'detached-shared-content-owner'`,
			);
		expect(detachedAssets.map((row) => row.id)).toContain("erase-me-asset");
		expect(mockQuiesceUserMemoryMaintenance).toHaveBeenCalledWith("erase-me");
		expect(mockRequestActiveChatStreamsStopForUser).toHaveBeenCalledWith(
			"erase-me",
		);
	});
});

describe("clear memory and knowledge keeps the account and chats", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-account-lifecycle-clear-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		mockQuiesceUserMemoryMaintenance.mockResolvedValue(undefined);
		mockRequestActiveChatStreamsStopForUser.mockReturnValue({ stopped: 0 });
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// noop
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// noop
		}
	});

	it("clears memory + knowledge but preserves the user, chats, and analytics", async () => {
		seedEveryUserScopedTable("clear-me");

		const { clearMemoryAndKnowledgeForUser } = await import("./index");
		await clearMemoryAndKnowledgeForUser("clear-me");

		const { db } = await import("$lib/server/db");

		// Memory-scope tables are cleared.
		for (const entry of tablesForResetScope("memory")) {
			const survivors = await countRowsForUser(
				entry.userColumn,
				entry.table,
				"clear-me",
			);
			expect(survivors, `memory table ${entry.name} should be cleared`).toBe(0);
		}
		// Durable Memory V2 profile is cleared via the projection-state cascade.
		const profileItems = await countRowsForUser(
			schema.memoryProfileItems.userId,
			schema.memoryProfileItems,
			"clear-me",
		);
		expect(profileItems).toBe(0);

		// The account, chats, and historical analytics remain.
		const users = await db.select({ id: schema.users.id }).from(schema.users);
		expect(users.map((row) => row.id)).toContain("clear-me");
		const conversations = await countRowsForUser(
			schema.conversations.userId,
			schema.conversations,
			"clear-me",
		);
		expect(conversations).toBeGreaterThan(0);
		const usage = await countRowsForUser(
			schema.usageEvents.userId,
			schema.usageEvents,
			"clear-me",
		);
		expect(usage).toBeGreaterThan(0);
	});
});
