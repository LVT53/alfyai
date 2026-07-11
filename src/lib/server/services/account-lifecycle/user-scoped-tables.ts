import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
	analyticsConversations,
	announcementCampaignEvents,
	announcementCampaignUserStates,
	artifactChunks,
	artifactLinks,
	artifacts,
	atlasJobs,
	browserPushSubscriptions,
	campaignAssets,
	chatGeneratedFiles,
	connectionPendingWrites,
	contextCompressionSnapshots,
	conversationContextStatus,
	conversationDrafts,
	conversationForks,
	conversationMemoryWatermarks,
	conversationSummaries,
	conversations,
	conversationTaskStates,
	conversationWorkingSetItems,
	fileProductionJobs,
	importJobs,
	memoryConsolidationReports,
	memoryDirtyLedger,
	memoryEvents,
	memoryProfileItemProvenance,
	memoryProfileItems,
	memoryProjectionState,
	memoryResetGenerations,
	memoryReviewItems,
	memoryReviewResolutions,
	memoryReworkTelemetry,
	messageAnalytics,
	projects,
	semanticEmbeddings,
	sessions,
	skillNoteCheckpoints,
	skillNoteOperations,
	skillSessionMilestones,
	skillSessions,
	taskCheckpoints,
	taskStateEvidenceLinks,
	usageEvents,
	userConnections,
	userSkillDefinitions,
} from "$lib/server/db/schema";

/**
 * The two explicit-delete reset scopes that keep the `users` row (so they cannot
 * lean on the `ON DELETE CASCADE` from `users.id` and must delete rows directly):
 *
 * - `memory`    → "Clear Memory and Knowledge": wipes learned memory + knowledge
 *                 while keeping the account, chats, and generated chat outputs.
 * - `workspace` → "Clear Workspace Data": wipes conversations and their derived
 *                 state while keeping the account and historical analytics.
 */
export type UserScopedResetScope = "memory" | "workspace";

/**
 * How full Account Erasure removes a user-scoped table's rows:
 *
 * - `cascade` → the row is deleted automatically by the `ON DELETE CASCADE`
 *               foreign key to `users.id` when the user row is deleted. This is
 *               the REAL erasure mechanism for the vast majority of tables.
 * - `explicit`→ the table has only a plain `user_id` column (NO foreign key to
 *               `users`), so the cascade never reaches it. Full erasure must
 *               delete these rows itself. Today only the analytics rollups
 *               (`usage_events`, `analytics_conversations`) are in this bucket.
 * - `detach`  → shared, deployment-level content authored by the user. Erasure
 *               reassigns/anonymizes authorship instead of deleting the row
 *               (ADR-0031). Handled by `detachSharedContentAuthorship`, NOT by a
 *               blanket delete — listed here only so the registry stays the one
 *               authoritative enumeration of every user-scoped table.
 */
export type UserScopedErasure = "cascade" | "explicit" | "detach";

export interface UserScopedTable {
	/** SQLite table name (stable identity for tests + docs). */
	readonly name: string;
	readonly table: SQLiteTable;
	/** The column that keys a row to a person (its `users.id`). */
	readonly userColumn: SQLiteColumn;
	readonly erasure: UserScopedErasure;
	/** Explicit-delete reset scopes that clear this table (empty for most). */
	readonly resets: readonly UserScopedResetScope[];
}

/**
 * THE single authoritative enumeration of the user-scoped tables that full
 * erasure and the memory/workspace resets act on — the one list that replaced
 * the two hand-maintained delete-lists (`purgeUserData` and
 * `clearMemoryAndKnowledgeForUser`) that used to shadow each other and the FK
 * cascade. Ordered children-before-parents within a scope so that filtering by a
 * reset scope yields an FK-safe delete order (e.g. `conversations` last).
 *
 * Scope note: this covers every table with a row-OWNING person key (`user_id`,
 * or `campaign_assets.uploaded_by_user_id`). A few tables carry only an
 * author-STAMP person column and are handled OUTSIDE this registry, by
 * `detachSharedContentAuthorship` (ADR-0031), so the shared row survives with
 * authorship removed: `admin_config.updated_by`,
 * `announcement_campaigns.{created_by,published_by}_user_id`, and
 * `announcement_campaign_snapshots.published_by_user_id`. They are deliberately
 * absent here and instead sit on the `NON_REGISTRY_PERSON_TABLES` allowlist in
 * `account-lifecycle.test.ts`.
 *
 * Adding a new user-scoped table? Register it here (and classify its erasure) —
 * or, if it is such an author-stamp-only case, allowlist it in that test. The
 * schema-derived completeness guard fails until one of the two happens.
 */
export const USER_SCOPED_TABLES: readonly UserScopedTable[] = [
	// --- Memory + task/context derived state (memory-scope + workspace-scope) ---
	{
		name: "task_state_evidence_links",
		table: taskStateEvidenceLinks,
		userColumn: taskStateEvidenceLinks.userId,
		erasure: "cascade",
		resets: ["memory", "workspace"],
	},
	{
		name: "task_checkpoints",
		table: taskCheckpoints,
		userColumn: taskCheckpoints.userId,
		erasure: "cascade",
		resets: ["memory", "workspace"],
	},
	{
		name: "conversation_task_states",
		table: conversationTaskStates,
		userColumn: conversationTaskStates.userId,
		erasure: "cascade",
		resets: ["memory", "workspace"],
	},
	{
		name: "memory_events",
		table: memoryEvents,
		userColumn: memoryEvents.userId,
		erasure: "cascade",
		resets: ["memory", "workspace"],
	},
	{
		name: "semantic_embeddings",
		table: semanticEmbeddings,
		userColumn: semanticEmbeddings.userId,
		erasure: "cascade",
		resets: ["memory", "workspace"],
	},
	{
		name: "conversation_working_set_items",
		table: conversationWorkingSetItems,
		userColumn: conversationWorkingSetItems.userId,
		erasure: "cascade",
		resets: ["memory", "workspace"],
	},
	{
		name: "conversation_context_status",
		table: conversationContextStatus,
		userColumn: conversationContextStatus.userId,
		erasure: "cascade",
		resets: ["memory", "workspace"],
	},
	// --- Memory-only (the durable Memory V2 profile + review substrate) ---
	{
		name: "memory_projection_state",
		table: memoryProjectionState,
		userColumn: memoryProjectionState.userId,
		erasure: "cascade",
		resets: ["memory"],
	},
	{
		name: "memory_review_items",
		table: memoryReviewItems,
		userColumn: memoryReviewItems.userId,
		erasure: "cascade",
		resets: ["memory"],
	},
	{
		name: "memory_dirty_ledger",
		table: memoryDirtyLedger,
		userColumn: memoryDirtyLedger.userId,
		erasure: "cascade",
		resets: ["memory"],
	},
	{
		name: "memory_rework_telemetry",
		table: memoryReworkTelemetry,
		userColumn: memoryReworkTelemetry.userId,
		erasure: "cascade",
		resets: ["memory"],
	},
	{
		name: "conversation_summaries",
		table: conversationSummaries,
		userColumn: conversationSummaries.userId,
		erasure: "cascade",
		resets: ["memory"],
	},
	// --- Workspace-only (chats + their sidecars, kept by Clear Memory) ---
	{
		name: "sessions",
		table: sessions,
		userColumn: sessions.userId,
		erasure: "cascade",
		resets: ["workspace"],
	},
	{
		name: "browser_push_subscriptions",
		table: browserPushSubscriptions,
		userColumn: browserPushSubscriptions.userId,
		erasure: "cascade",
		resets: ["workspace"],
	},
	{
		name: "chat_generated_files",
		table: chatGeneratedFiles,
		userColumn: chatGeneratedFiles.userId,
		erasure: "cascade",
		resets: ["workspace"],
	},
	{
		name: "conversation_drafts",
		table: conversationDrafts,
		userColumn: conversationDrafts.userId,
		erasure: "cascade",
		resets: ["workspace"],
	},
	{
		name: "projects",
		table: projects,
		userColumn: projects.userId,
		erasure: "cascade",
		resets: ["workspace"],
	},
	{
		// Deleting a conversation cascades a large subtree (messages, forks,
		// context-compression snapshots, watermarks, drafts, task states, …), so
		// it MUST come last in the workspace-scope delete order.
		name: "conversations",
		table: conversations,
		userColumn: conversations.userId,
		erasure: "cascade",
		resets: ["workspace"],
	},
	// --- Cascade-only user-scoped tables (no explicit reset clears them on their
	//     own; full erasure removes them via the users FK cascade) ---
	{
		name: "context_compression_snapshots",
		table: contextCompressionSnapshots,
		userColumn: contextCompressionSnapshots.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "conversation_forks",
		table: conversationForks,
		userColumn: conversationForks.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "artifacts",
		table: artifacts,
		userColumn: artifacts.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "artifact_chunks",
		table: artifactChunks,
		userColumn: artifactChunks.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "artifact_links",
		table: artifactLinks,
		userColumn: artifactLinks.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "memory_reset_generations",
		table: memoryResetGenerations,
		userColumn: memoryResetGenerations.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "conversation_memory_watermarks",
		table: conversationMemoryWatermarks,
		userColumn: conversationMemoryWatermarks.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "memory_consolidation_reports",
		table: memoryConsolidationReports,
		userColumn: memoryConsolidationReports.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "memory_profile_items",
		table: memoryProfileItems,
		userColumn: memoryProfileItems.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "memory_profile_item_provenance",
		table: memoryProfileItemProvenance,
		userColumn: memoryProfileItemProvenance.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "memory_review_resolutions",
		table: memoryReviewResolutions,
		userColumn: memoryReviewResolutions.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "skill_sessions",
		table: skillSessions,
		userColumn: skillSessions.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "skill_session_milestones",
		table: skillSessionMilestones,
		userColumn: skillSessionMilestones.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "skill_note_operations",
		table: skillNoteOperations,
		userColumn: skillNoteOperations.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "skill_note_checkpoints",
		table: skillNoteCheckpoints,
		userColumn: skillNoteCheckpoints.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "import_jobs",
		table: importJobs,
		userColumn: importJobs.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "message_analytics",
		table: messageAnalytics,
		userColumn: messageAnalytics.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "file_production_jobs",
		table: fileProductionJobs,
		userColumn: fileProductionJobs.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "atlas_jobs",
		table: atlasJobs,
		userColumn: atlasJobs.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "announcement_campaign_user_states",
		table: announcementCampaignUserStates,
		userColumn: announcementCampaignUserStates.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "announcement_campaign_events",
		table: announcementCampaignEvents,
		userColumn: announcementCampaignEvents.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "user_connections",
		table: userConnections,
		userColumn: userConnections.userId,
		erasure: "cascade",
		resets: [],
	},
	{
		name: "connection_pending_writes",
		table: connectionPendingWrites,
		userColumn: connectionPendingWrites.userId,
		erasure: "cascade",
		resets: [],
	},
	// --- Explicit (no FK cascade to users): analytics rollups keyed by a plain
	//     user_id text column. Full erasure deletes these itself. ---
	{
		name: "usage_events",
		table: usageEvents,
		userColumn: usageEvents.userId,
		erasure: "explicit",
		resets: [],
	},
	{
		name: "analytics_conversations",
		table: analyticsConversations,
		userColumn: analyticsConversations.userId,
		erasure: "explicit",
		resets: [],
	},
	// --- Detach (shared deployment content — reassigned, not deleted): the
	//     row-owner FK cascades, so authorship is detached BEFORE the user row is
	//     removed. See detachSharedContentAuthorship. ---
	{
		name: "campaign_assets",
		table: campaignAssets,
		userColumn: campaignAssets.uploadedByUserId,
		erasure: "detach",
		resets: [],
	},
	{
		// System-owned skill definitions are detached to the shared owner; user
		// (personal) skill definitions cascade-delete with the user row.
		name: "user_skill_definitions",
		table: userSkillDefinitions,
		userColumn: userSkillDefinitions.userId,
		erasure: "detach",
		resets: [],
	},
];

/** User-scoped tables an explicit reset scope must delete (FK-safe order). */
export function tablesForResetScope(
	scope: UserScopedResetScope,
): readonly UserScopedTable[] {
	return USER_SCOPED_TABLES.filter((entry) => entry.resets.includes(scope));
}

/**
 * User-scoped tables full erasure must delete itself because no `users` FK
 * cascade reaches them (the analytics rollups).
 */
export function explicitErasureTables(): readonly UserScopedTable[] {
	return USER_SCOPED_TABLES.filter((entry) => entry.erasure === "explicit");
}
