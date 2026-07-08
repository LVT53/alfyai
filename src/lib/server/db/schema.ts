import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	passwordHash: text("password_hash").notNull(),
	name: text("name"),
	role: text("role").notNull().default("user"),
	preferredModel: text("preferred_model").notNull().default("model1"),
	modelPreferenceMode: text("model_preference_mode"),
	translationEnabled: integer("translation_enabled").notNull().default(0),
	theme: text("theme").notNull().default("system"),
	titleLanguage: text("title_language").notNull().default("auto"),
	uiLanguage: text("ui_language").notNull().default("en"),
	preferredPersonalityId: text("preferred_personality_id"),
	avatarId: integer("avatar_id"),
	profilePicture: text("profile_picture"),
	sidebarProjectsExpanded: integer("sidebar_projects_expanded", {
		mode: "boolean",
	})
		.notNull()
		.default(true),
	sidebarChatsExpanded: integer("sidebar_chats_expanded", { mode: "boolean" })
		.notNull()
		.default(true),
	// When false, the memory pipeline (judge intake + consolidation) skips this
	// user entirely: existing facts are kept but no new ones are formed.
	memoryEnabled: integer("memory_enabled", { mode: "boolean" })
		.notNull()
		.default(true),
	lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
});

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

export const browserPushSubscriptions = sqliteTable(
	"browser_push_subscriptions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		endpoint: text("endpoint").notNull(),
		p256dh: text("p256dh").notNull(),
		auth: text("auth").notNull(),
		userAgent: text("user_agent"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		lastFailureAt: integer("last_failure_at", { mode: "timestamp" }),
	},
	(table) => [
		uniqueIndex("browser_push_subscriptions_endpoint_unique_idx").on(
			table.endpoint,
		),
		index("browser_push_subscriptions_user_updated_idx").on(
			table.userId,
			table.updatedAt,
		),
	],
);

export const conversations = sqliteTable(
	"conversations",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		projectId: text("project_id"),
		status: text("status").notNull().default("open"),
		sealedAt: integer("sealed_at", { mode: "timestamp" }),
		sidebarPinned: integer("sidebar_pinned", { mode: "boolean" })
			.notNull()
			.default(false),
		// Incognito: when true, this conversation is never fed to the memory
		// pipeline (no judge intake, excluded from the nightly sweep).
		memoryIncognito: integer("memory_incognito", { mode: "boolean" })
			.notNull()
			.default(false),
		sidebarSortOrder: integer("sidebar_sort_order"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userStatusIdx: index("conversations_user_status_idx").on(
			table.userId,
			table.status,
			table.updatedAt,
		),
		userSidebarIdx: index("conversations_user_sidebar_idx").on(
			table.userId,
			table.sidebarPinned,
			table.sidebarSortOrder,
		),
	}),
);

export const conversationSummaries = sqliteTable(
	"conversation_summaries",
	{
		conversationId: text("conversation_id")
			.primaryKey()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		summary: text("summary").notNull(),
		source: text("source").notNull().default("deterministic"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userUpdatedIdx: index("conversation_summaries_user_updated_idx").on(
			table.userId,
			table.updatedAt,
		),
	}),
);

export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		messageSequence: integer("message_sequence"),
		role: text("role").notNull(),
		content: text("content").notNull(),
		thinking: text("thinking"),
		toolCalls: text("tool_calls"),
		metadataJson: text("metadata_json"),
		importSource: text("import_source"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		conversationSequenceUniqueIdx: uniqueIndex(
			"messages_conversation_sequence_unique_idx",
		)
			.on(table.conversationId, table.messageSequence)
			.where(sql`${table.messageSequence} IS NOT NULL`),
		conversationOrderIdx: index("messages_conversation_order_idx").on(
			table.conversationId,
			table.messageSequence,
			table.createdAt,
		),
	}),
);

export const contextCompressionSnapshots = sqliteTable(
	"context_compression_snapshots",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		trigger: text("trigger").notNull(),
		status: text("status").notNull().default("running"),
		modelId: text("model_id").notNull(),
		sourceStartMessageId: text("source_start_message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		sourceEndMessageId: text("source_end_message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		sourceStartMessageSequence: integer(
			"source_start_message_sequence",
		).notNull(),
		sourceEndMessageSequence: integer("source_end_message_sequence").notNull(),
		snapshotJson: text("snapshot_json").notNull().default("{}"),
		sourceCoverageJson: text("source_coverage_json").notNull().default("{}"),
		sourceRefsJson: text("source_refs_json").notNull().default("[]"),
		estimatedTokens: integer("estimated_tokens").notNull().default(0),
		sourceTokenEstimate: integer("source_token_estimate").notNull().default(0),
		failureReason: text("failure_reason"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		conversationCreatedIdx: index(
			"context_compression_snapshots_conversation_created_idx",
		).on(table.conversationId, table.createdAt),
		conversationStatusIdx: index(
			"context_compression_snapshots_conversation_status_idx",
		).on(table.conversationId, table.status, table.updatedAt),
		conversationSourceEndIdx: index(
			"context_compression_snapshots_conversation_source_end_idx",
		).on(table.conversationId, table.sourceEndMessageSequence),
		userConversationIdx: index(
			"context_compression_snapshots_user_conversation_idx",
		).on(table.userId, table.conversationId),
	}),
);

export const conversationForks = sqliteTable(
	"conversation_forks",
	{
		id: text("id").primaryKey(),
		forkConversationId: text("fork_conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sourceConversationId: text("source_conversation_id").references(
			() => conversations.id,
			{
				onDelete: "set null",
			},
		),
		sourceConversationIdSnapshot: text(
			"source_conversation_id_snapshot",
		).notNull(),
		sourceAssistantMessageId: text("source_assistant_message_id").references(
			() => messages.id,
			{
				onDelete: "set null",
			},
		),
		sourceAssistantMessageIdSnapshot: text(
			"source_assistant_message_id_snapshot",
		).notNull(),
		copiedForkPointMessageId: text("copied_fork_point_message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		sourceTitle: text("source_title").notNull(),
		forkSequence: integer("fork_sequence").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		forkConversationUniqueIdx: uniqueIndex(
			"conversation_forks_fork_conversation_unique_idx",
		).on(table.forkConversationId),
		sourceAssistantIdx: index("conversation_forks_source_assistant_idx").on(
			table.sourceAssistantMessageIdSnapshot,
			table.forkSequence,
		),
		userSourceAssistantSequenceUniqueIdx: uniqueIndex(
			"conversation_forks_user_source_assistant_sequence_unique_idx",
		).on(
			table.userId,
			table.sourceAssistantMessageIdSnapshot,
			table.forkSequence,
		),
		sourceConversationIdx: index(
			"conversation_forks_source_conversation_idx",
		).on(table.sourceConversationIdSnapshot, table.forkSequence),
		userCreatedIdx: index("conversation_forks_user_created_idx").on(
			table.userId,
			table.createdAt,
		),
	}),
);

export const artifacts = sqliteTable(
	"artifacts",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").references(() => conversations.id, {
			onDelete: "set null",
		}),
		type: text("type").notNull(),
		retrievalClass: text("retrieval_class").notNull().default("durable"),
		name: text("name").notNull(),
		mimeType: text("mime_type"),
		extension: text("extension"),
		sizeBytes: integer("size_bytes"),
		binaryHash: text("binary_hash"),
		storagePath: text("storage_path"),
		contentText: text("content_text"),
		summary: text("summary"),
		metadataJson: text("metadata_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userBinaryHashIdx: index("artifacts_user_binary_hash_idx").on(
			table.userId,
			table.binaryHash,
		),
		userSizeIdx: index("artifacts_user_size_idx").on(
			table.userId,
			table.sizeBytes,
		),
	}),
);

export const artifactChunks = sqliteTable(
	"artifact_chunks",
	{
		id: text("id").primaryKey(),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => artifacts.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").references(() => conversations.id, {
			onDelete: "cascade",
		}),
		chunkIndex: integer("chunk_index").notNull(),
		contentText: text("content_text").notNull(),
		tokenEstimate: integer("token_estimate").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		artifactIdx: index("artifact_chunks_artifact_idx").on(
			table.artifactId,
			table.chunkIndex,
		),
		userConversationIdx: index("artifact_chunks_user_conversation_idx").on(
			table.userId,
			table.conversationId,
		),
	}),
);

export const artifactLinks = sqliteTable("artifact_links", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	artifactId: text("artifact_id")
		.notNull()
		.references(() => artifacts.id, { onDelete: "cascade" }),
	relatedArtifactId: text("related_artifact_id").references(
		() => artifacts.id,
		{ onDelete: "cascade" },
	),
	conversationId: text("conversation_id").references(() => conversations.id, {
		onDelete: "cascade",
	}),
	messageId: text("message_id").references(() => messages.id, {
		onDelete: "cascade",
	}),
	linkType: text("link_type").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
});

export const conversationContextStatus = sqliteTable(
	"conversation_context_status",
	{
		conversationId: text("conversation_id")
			.primaryKey()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		estimatedTokens: integer("estimated_tokens").notNull().default(0),
		maxContextTokens: integer("max_context_tokens").notNull().default(262144),
		thresholdTokens: integer("threshold_tokens").notNull().default(209715),
		targetTokens: integer("target_tokens").notNull().default(157286),
		compactionApplied: integer("compaction_applied").notNull().default(0),
		compactionMode: text("compaction_mode").notNull().default("none"),
		routingStage: text("routing_stage").notNull().default("deterministic"),
		routingConfidence: integer("routing_confidence").notNull().default(0),
		verificationStatus: text("verification_status")
			.notNull()
			.default("skipped"),
		layersUsedJson: text("layers_used_json"),
		workingSetCount: integer("working_set_count").notNull().default(0),
		workingSetArtifactIdsJson: text("working_set_artifact_ids_json"),
		workingSetApplied: integer("working_set_applied").notNull().default(0),
		taskStateApplied: integer("task_state_applied").notNull().default(0),
		promptArtifactCount: integer("prompt_artifact_count").notNull().default(0),
		recentTurnCount: integer("recent_turn_count").notNull().default(0),
		summary: text("summary"),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
);

export const conversationTaskStates = sqliteTable(
	"conversation_task_states",
	{
		taskId: text("task_id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		status: text("status").notNull().default("active"),
		objective: text("objective").notNull(),
		confidence: integer("confidence").notNull().default(0),
		locked: integer("locked").notNull().default(0),
		lastConfirmedTurnMessageId: text("last_confirmed_turn_message_id"),
		constraintsJson: text("constraints_json"),
		factsToPreserveJson: text("facts_to_preserve_json"),
		decisionsJson: text("decisions_json"),
		openQuestionsJson: text("open_questions_json"),
		activeArtifactIdsJson: text("active_artifact_ids_json"),
		nextStepsJson: text("next_steps_json"),
		lastCheckpointAt: integer("last_checkpoint_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		conversationIdx: index("conversation_task_states_conversation_idx").on(
			table.conversationId,
			table.updatedAt,
		),
	}),
);

export const taskStateEvidenceLinks = sqliteTable(
	"task_state_evidence_links",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => conversationTaskStates.taskId, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => artifacts.id, { onDelete: "cascade" }),
		chunkIndex: integer("chunk_index"),
		role: text("role").notNull(),
		origin: text("origin").notNull().default("system"),
		confidence: integer("confidence").notNull().default(0),
		reason: text("reason"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		taskIdx: index("task_state_evidence_links_task_idx").on(
			table.taskId,
			table.role,
			table.updatedAt,
		),
	}),
);

export const taskCheckpoints = sqliteTable(
	"task_checkpoints",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => conversationTaskStates.taskId, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		checkpointType: text("checkpoint_type").notNull(),
		content: text("content").notNull(),
		sourceTurnRange: text("source_turn_range"),
		sourceEvidenceIdsJson: text("source_evidence_ids_json"),
		verificationStatus: text("verification_status")
			.notNull()
			.default("skipped"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		taskIdx: index("task_checkpoints_task_idx").on(
			table.taskId,
			table.checkpointType,
			table.updatedAt,
		),
	}),
);

export const conversationWorkingSetItems = sqliteTable(
	"conversation_working_set_items",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => artifacts.id, { onDelete: "cascade" }),
		artifactType: text("artifact_type").notNull(),
		score: integer("score").notNull().default(0),
		state: text("state").notNull().default("cooling"),
		reasonCodesJson: text("reason_codes_json"),
		lastActivatedAt: integer("last_activated_at", { mode: "timestamp" }),
		lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
);

export const semanticEmbeddings = sqliteTable(
	"semantic_embeddings",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		subjectType: text("subject_type").notNull(),
		subjectId: text("subject_id").notNull(),
		modelName: text("model_name").notNull(),
		sourceTextHash: text("source_text_hash").notNull(),
		dimensions: integer("dimensions").notNull().default(0),
		embeddingJson: text("embedding_json").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		subjectUniqueIdx: uniqueIndex("semantic_embeddings_subject_unique_idx").on(
			table.userId,
			table.subjectType,
			table.subjectId,
			table.modelName,
		),
		userSubjectIdx: index("semantic_embeddings_user_subject_idx").on(
			table.userId,
			table.subjectType,
			table.updatedAt,
		),
	}),
);

export const memoryProjects = sqliteTable(
	"memory_projects",
	{
		projectId: text("project_id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		summary: text("summary"),
		status: text("status").notNull().default("active"),
		lastActiveAt: integer("last_active_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userStatusIdx: index("memory_projects_user_status_idx").on(
			table.userId,
			table.status,
			table.updatedAt,
		),
	}),
);

export const memoryProjectTaskLinks = sqliteTable(
	"memory_project_task_links",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => memoryProjects.projectId, { onDelete: "cascade" }),
		taskId: text("task_id")
			.notNull()
			.references(() => conversationTaskStates.taskId, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		taskIdx: uniqueIndex("memory_project_task_links_task_idx").on(table.taskId),
		projectIdx: index("memory_project_task_links_project_idx").on(
			table.projectId,
			table.updatedAt,
		),
	}),
);

export const memoryEvents = sqliteTable(
	"memory_events",
	{
		id: text("id").primaryKey(),
		eventKey: text("event_key").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").references(() => conversations.id, {
			onDelete: "set null",
		}),
		messageId: text("message_id").references(() => messages.id, {
			onDelete: "set null",
		}),
		domain: text("domain").notNull(),
		eventType: text("event_type").notNull(),
		subjectId: text("subject_id"),
		relatedId: text("related_id"),
		observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
		payloadJson: text("payload_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		eventKeyIdx: uniqueIndex("memory_events_event_key_idx").on(table.eventKey),
		userObservedIdx: index("memory_events_user_observed_idx").on(
			table.userId,
			table.domain,
			table.observedAt,
		),
		userTypeIdx: index("memory_events_user_type_idx").on(
			table.userId,
			table.eventType,
			table.observedAt,
		),
	}),
);

export const memoryResetGenerations = sqliteTable("memory_reset_generations", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	resetGeneration: integer("reset_generation").notNull().default(0),
	advancedAt: integer("advanced_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
});

export const memoryProjectionState = sqliteTable(
	"memory_projection_state",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		resetGeneration: integer("reset_generation").notNull().default(0),
		scopeType: text("scope_type").notNull().default("global"),
		scopeId: text("scope_id").notNull().default(""),
		revision: integer("revision").notNull().default(0),
		status: text("status").notNull().default("ready"),
		lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp" }),
		metadataJson: text("metadata_json").notNull().default("{}"),
		personaSummaryText: text("persona_summary_text"),
		personaSummaryLinksJson: text("persona_summary_links_json")
			.notNull()
			.default("[]"),
		personaSummaryUpdatedAt: integer("persona_summary_updated_at", {
			mode: "timestamp",
		}),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userGenerationScopeIdx: uniqueIndex(
			"memory_projection_state_user_generation_scope_idx",
		).on(table.userId, table.resetGeneration, table.scopeType, table.scopeId),
		userUpdatedIdx: index("memory_projection_state_user_updated_idx").on(
			table.userId,
			table.updatedAt,
		),
	}),
);

export const conversationMemoryWatermarks = sqliteTable(
	"conversation_memory_watermarks",
	{
		conversationId: text("conversation_id")
			.primaryKey()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		lastJudgedSequence: integer("last_judged_sequence").notNull().default(0),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
);

export const memoryConsolidationReports = sqliteTable(
	"memory_consolidation_reports",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		resetGeneration: integer("reset_generation").notNull().default(0),
		status: text("status").notNull(), // "succeeded" | "failed"
		summaryText: text("summary_text").notNull(),
		actionsJson: text("actions_json").notNull().default("[]"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userCreatedIdx: index("memory_consolidation_reports_user_created_idx").on(
			table.userId,
			table.createdAt,
		),
	}),
);

export const memoryProfileItems = sqliteTable(
	"memory_profile_items",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectionStateId: text("projection_state_id")
			.notNull()
			.references(() => memoryProjectionState.id, { onDelete: "cascade" }),
		resetGeneration: integer("reset_generation").notNull().default(0),
		itemKey: text("item_key").notNull(),
		category: text("category").notNull(),
		scopeType: text("scope_type").notNull().default("global"),
		scopeId: text("scope_id").notNull().default(""),
		statement: text("statement").notNull(),
		status: text("status").notNull().default("active"),
		revision: integer("revision").notNull().default(0),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
		deletedAt: integer("deleted_at", { mode: "timestamp" }),
		suppressedAt: integer("suppressed_at", { mode: "timestamp" }),
		metadataJson: text("metadata_json").notNull().default("{}"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userGenerationStatusIdx: index(
			"memory_profile_items_user_generation_status_idx",
		).on(table.userId, table.resetGeneration, table.status, table.updatedAt),
		userGenerationItemKeyIdx: uniqueIndex(
			"memory_profile_items_user_generation_item_key_idx",
		).on(table.userId, table.resetGeneration, table.itemKey),
		userCategoryIdx: index("memory_profile_items_user_category_idx").on(
			table.userId,
			table.category,
			table.updatedAt,
		),
	}),
);

export const memoryProfileItemProvenance = sqliteTable(
	"memory_profile_item_provenance",
	{
		id: text("id").primaryKey(),
		itemId: text("item_id")
			.notNull()
			.references(() => memoryProfileItems.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		resetGeneration: integer("reset_generation").notNull().default(0),
		sourceType: text("source_type").notNull(),
		sourceId: text("source_id"),
		label: text("label").notNull(),
		summary: text("summary"),
		metadataJson: text("metadata_json").notNull().default("{}"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		itemCreatedIdx: index("memory_profile_item_provenance_item_created_idx").on(
			table.itemId,
			table.createdAt,
		),
		userGenerationIdx: index(
			"memory_profile_item_provenance_user_generation_idx",
		).on(table.userId, table.resetGeneration),
	}),
);

export const memoryReviewItems = sqliteTable(
	"memory_review_items",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		resetGeneration: integer("reset_generation").notNull().default(0),
		subjectKey: text("subject_key").notNull(),
		subjectLabel: text("subject_label").notNull(),
		question: text("question").notNull(),
		reason: text("reason").notNull(),
		status: text("status").notNull().default("open"),
		affectedItemIdsJson: text("affected_item_ids_json").notNull().default("[]"),
		evidenceJson: text("evidence_json").notNull().default("[]"),
		metadataJson: text("metadata_json").notNull().default("{}"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		resolvedAt: integer("resolved_at", { mode: "timestamp" }),
	},
	(table) => ({
		openSubjectIdx: uniqueIndex("memory_review_items_open_subject_idx")
			.on(table.userId, table.resetGeneration, table.subjectKey)
			.where(sql`${table.status} = 'open'`),
		userStatusIdx: index("memory_review_items_user_status_idx").on(
			table.userId,
			table.resetGeneration,
			table.status,
			table.updatedAt,
		),
	}),
);

export const memoryReviewResolutions = sqliteTable(
	"memory_review_resolutions",
	{
		id: text("id").primaryKey(),
		reviewItemId: text("review_item_id")
			.notNull()
			.references(() => memoryReviewItems.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		resetGeneration: integer("reset_generation").notNull().default(0),
		resolutionType: text("resolution_type").notNull(),
		editedStatement: text("edited_statement"),
		metadataJson: text("metadata_json").notNull().default("{}"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		reviewUniqueIdx: uniqueIndex("memory_review_resolutions_review_idx").on(
			table.reviewItemId,
		),
		userGenerationIdx: index(
			"memory_review_resolutions_user_generation_idx",
		).on(table.userId, table.resetGeneration),
	}),
);

export const memoryDirtyLedger = sqliteTable(
	"memory_dirty_ledger",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		resetGeneration: integer("reset_generation").notNull().default(0),
		scopeType: text("scope_type").notNull().default("global"),
		scopeId: text("scope_id").notNull().default(""),
		reason: text("reason").notNull(),
		status: text("status").notNull().default("pending"),
		count: integer("count").notNull().default(1),
		reasonMetadataJson: text("reason_metadata_json").notNull().default("{}"),
		firstMarkedAt: integer("first_marked_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		lastMarkedAt: integer("last_marked_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		claimedAt: integer("claimed_at", { mode: "timestamp" }),
		completedAt: integer("completed_at", { mode: "timestamp" }),
	},
	(table) => ({
		pendingUniqueIdx: uniqueIndex("memory_dirty_ledger_pending_unique_idx")
			.on(
				table.userId,
				table.resetGeneration,
				table.scopeType,
				table.scopeId,
				table.reason,
			)
			.where(sql`${table.status} = 'pending'`),
		userStatusIdx: index("memory_dirty_ledger_user_status_idx").on(
			table.userId,
			table.resetGeneration,
			table.status,
			table.lastMarkedAt,
		),
	}),
);

export const memoryReworkTelemetry = sqliteTable(
	"memory_rework_telemetry",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		resetGeneration: integer("reset_generation").notNull().default(0),
		eventFamily: text("event_family").notNull(),
		eventName: text("event_name").notNull(),
		category: text("category"),
		reason: text("reason"),
		status: text("status"),
		count: integer("count"),
		durationMs: integer("duration_ms"),
		subjectId: text("subject_id"),
		metadataJson: text("metadata_json").notNull().default("{}"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userFamilyCreatedIdx: index(
			"memory_rework_telemetry_user_family_created_idx",
		).on(table.userId, table.eventFamily, table.createdAt),
	}),
);

export const conversationDrafts = sqliteTable(
	"conversation_drafts",
	{
		conversationId: text("conversation_id")
			.primaryKey()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		draftText: text("draft_text").notNull().default(""),
		selectedAttachmentIdsJson: text("selected_attachment_ids_json"),
		selectedLinkedSourcesJson: text("selected_linked_sources_json"),
		pendingSkillJson: text("pending_skill_json"),
		atlasMode: integer("atlas_mode", { mode: "boolean" })
			.notNull()
			.default(false),
		atlasProfile: text("atlas_profile"),
		clientAtlasTurnId: text("client_atlas_turn_id"),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userUpdatedIdx: index("conversation_drafts_user_updated_idx").on(
			table.userId,
			table.updatedAt,
		),
	}),
);

export const adminConfig = sqliteTable("admin_config", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
	updatedBy: text("updated_by").notNull(),
});

export const userSkillDefinitions = sqliteTable(
	"user_skill_definitions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		ownership: text("ownership").notNull().default("user"),
		skillKind: text("skill_kind").notNull().default("user_skill"),
		baseSkillId: text("base_skill_id"),
		baseSkillVersion: integer("base_skill_version"),
		displayName: text("display_name").notNull(),
		description: text("description").notNull().default(""),
		instructions: text("instructions").notNull(),
		activationExamplesJson: text("activation_examples_json")
			.notNull()
			.default("[]"),
		resourceMetadataJson: text("resource_metadata_json"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		published: integer("published", { mode: "boolean" })
			.notNull()
			.default(false),
		durationPolicy: text("duration_policy").notNull().default("next_message"),
		questionPolicy: text("question_policy").notNull().default("none"),
		notesPolicy: text("notes_policy").notNull().default("none"),
		sourceScope: text("source_scope").notNull().default("current_conversation"),
		creationSource: text("creation_source").notNull().default("user_created"),
		version: integer("version").notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userUpdatedIdx: index("user_skill_definitions_user_updated_idx").on(
			table.userId,
			table.updatedAt,
		),
		userNameIdx: index("user_skill_definitions_user_name_idx").on(
			table.userId,
			table.displayName,
		),
		skillKindIdx: index("user_skill_definitions_skill_kind_idx").on(
			table.skillKind,
		),
		baseSkillIdx: index("user_skill_definitions_base_skill_idx").on(
			table.baseSkillId,
		),
		userEnabledIdx: index("user_skill_definitions_user_enabled_idx").on(
			table.userId,
			table.enabled,
			table.displayName,
		),
	}),
);

export const skillSessions = sqliteTable(
	"skill_sessions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		skillId: text("skill_id").notNull(),
		skillOwnership: text("skill_ownership").notNull(),
		skillKind: text("skill_kind").notNull().default("user_skill"),
		packSkillId: text("pack_skill_id"),
		packSkillVersion: integer("pack_skill_version"),
		variantSkillId: text("variant_skill_id"),
		variantSkillVersion: integer("variant_skill_version"),
		status: text("status").notNull().default("active"),
		pauseReason: text("pause_reason"),
		endReason: text("end_reason"),
		skillDisplayName: text("skill_display_name").notNull(),
		skillDescription: text("skill_description").notNull().default(""),
		skillInstructions: text("skill_instructions").notNull(),
		activationExamplesJson: text("activation_examples_json")
			.notNull()
			.default("[]"),
		durationPolicy: text("duration_policy").notNull(),
		questionPolicy: text("question_policy").notNull(),
		notesPolicy: text("notes_policy").notNull(),
		sourceScope: text("source_scope").notNull(),
		skillVersion: integer("skill_version").notNull(),
		effectiveInstructionsHash: text("effective_instructions_hash")
			.notNull()
			.default(""),
		startedFrom: text("started_from").notNull(),
		startedAt: integer("started_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		pausedAt: integer("paused_at", { mode: "timestamp" }),
		endedAt: integer("ended_at", { mode: "timestamp" }),
	},
	(table) => ({
		userConversationUpdatedIdx: index(
			"skill_sessions_user_conversation_updated_idx",
		).on(table.userId, table.conversationId, table.updatedAt),
		conversationStatusIdx: index("skill_sessions_conversation_status_idx").on(
			table.conversationId,
			table.status,
		),
		oneActivePerConversationIdx: uniqueIndex(
			"skill_sessions_one_active_per_conversation_idx",
		)
			.on(table.conversationId)
			.where(sql`${table.status} = 'active'`),
	}),
);

export const skillSessionMilestones = sqliteTable(
	"skill_session_milestones",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => skillSessions.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		messageKey: text("message_key").notNull(),
		messageParamsJson: text("message_params_json").notNull().default("{}"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		sessionCreatedIdx: index("skill_session_milestones_session_created_idx").on(
			table.sessionId,
			table.createdAt,
		),
		conversationCreatedIdx: index(
			"skill_session_milestones_conversation_created_idx",
		).on(table.conversationId, table.createdAt),
	}),
);

export const skillNoteOperations = sqliteTable(
	"skill_note_operations",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => skillSessions.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		assistantMessageId: text("assistant_message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		operationId: text("operation_id").notNull(),
		action: text("action").notNull(),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => artifacts.id, { onDelete: "cascade" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		sessionTurnOperationIdx: uniqueIndex(
			"skill_note_operations_session_turn_operation_idx",
		).on(table.sessionId, table.assistantMessageId, table.operationId),
		artifactCreatedIdx: index("skill_note_operations_artifact_created_idx").on(
			table.artifactId,
			table.createdAt,
		),
	}),
);

export const skillNoteCheckpoints = sqliteTable(
	"skill_note_checkpoints",
	{
		id: text("id").primaryKey(),
		noteArtifactId: text("note_artifact_id")
			.notNull()
			.references(() => artifacts.id, { onDelete: "cascade" }),
		sessionId: text("session_id")
			.notNull()
			.references(() => skillSessions.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		assistantMessageId: text("assistant_message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		operationId: text("operation_id").notNull(),
		previousBody: text("previous_body").notNull(),
		previousMetadataJson: text("previous_metadata_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		noteCreatedIdx: index("skill_note_checkpoints_note_created_idx").on(
			table.noteArtifactId,
			table.createdAt,
		),
		sessionCreatedIdx: index("skill_note_checkpoints_session_created_idx").on(
			table.sessionId,
			table.createdAt,
		),
	}),
);

export const providers = sqliteTable("providers", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	displayName: text("display_name").notNull(),
	baseUrl: text("base_url").notNull(),
	apiKeyEncrypted: text("api_key_encrypted").notNull(),
	apiKeyIv: text("api_key_iv").notNull(),
	iconAssetId: text("icon_asset_id").references(
		(): AnySQLiteColumn => campaignAssets.id,
		{ onDelete: "set null" },
	),
	processingRegionCode: text("processing_region_code"),
	privacyPolicyUrl: text("privacy_policy_url"),
	rateLimitFallbackEnabled: integer("rate_limit_fallback_enabled")
		.notNull()
		.default(0),
	rateLimitFallbackBaseUrl: text("rate_limit_fallback_base_url"),
	rateLimitFallbackApiKeyEncrypted: text(
		"rate_limit_fallback_api_key_encrypted",
	),
	rateLimitFallbackApiKeyIv: text("rate_limit_fallback_api_key_iv"),
	rateLimitFallbackModelName: text("rate_limit_fallback_model_name"),
	rateLimitFallbackTimeoutMs: integer("rate_limit_fallback_timeout_ms")
		.notNull()
		.default(10000),
	sortOrder: integer("sort_order").notNull().default(0),
	enabled: integer("enabled").notNull().default(1),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
});

export const providerModels = sqliteTable(
	"provider_models",
	{
		id: text("id").primaryKey(),
		providerId: text("provider_id")
			.notNull()
			.references(() => providers.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		displayName: text("display_name").notNull(),
		iconAssetId: text("icon_asset_id").references(
			(): AnySQLiteColumn => campaignAssets.id,
			{ onDelete: "set null" },
		),
		guideNoteEn: text("guide_note_en"),
		guideNoteHu: text("guide_note_hu"),
		guideBadge: text("guide_badge", { enum: ["intelligent", "simple"] }),
		guideNoCost: integer("guide_no_cost").notNull().default(0),
		estimatedTokensPerSecond: integer("estimated_tokens_per_second"),
		fallbackProviderModelId: text("fallback_provider_model_id").references(
			(): AnySQLiteColumn => providerModels.id,
			{ onDelete: "set null" },
		),
		maxModelContext: integer("max_model_context"),
		compactionUiThreshold: integer("compaction_ui_threshold"),
		targetConstructedContext: integer("target_constructed_context"),
		maxMessageLength: integer("max_message_length"),
		maxTokens: integer("max_tokens"),
		reasoningEffort: text("reasoning_effort", {
			enum: ["none", "minimal", "low", "medium", "high", "max", "xhigh"],
		}),
		thinkingType: text("thinking_type", { enum: ["enabled", "disabled"] }),
		aliasesJson: text("aliases_json").notNull().default("[]"),
		capabilitiesJson: text("capabilities_json").notNull().default("{}"),
		inputUsdMicrosPer1m: integer("input_usd_micros_per_1m")
			.notNull()
			.default(0),
		cachedInputUsdMicrosPer1m: integer("cached_input_usd_micros_per_1m")
			.notNull()
			.default(0),
		cacheHitUsdMicrosPer1m: integer("cache_hit_usd_micros_per_1m")
			.notNull()
			.default(0),
		cacheMissUsdMicrosPer1m: integer("cache_miss_usd_micros_per_1m")
			.notNull()
			.default(0),
		outputUsdMicrosPer1m: integer("output_usd_micros_per_1m")
			.notNull()
			.default(0),
		enabled: integer("enabled").notNull().default(1),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		providerModelUniqueIdx: uniqueIndex(
			"provider_models_provider_id_name_unique",
		).on(table.providerId, table.name),
	}),
);

// Optional per-provider-model schedule of price windows that OVERRIDE the flat
// provider_models rates while active (DeepSeek-style peak/off-peak). Windows are
// defined in UTC; a null rate column inherits the base rate. When no window is
// active the flat rates apply. See resolveEffectivePriceRule in analytics.ts.
export const providerModelPriceWindows = sqliteTable(
	"provider_model_price_windows",
	{
		id: text("id").primaryKey(),
		providerModelId: text("provider_model_id")
			.notNull()
			.references(() => providerModels.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		// Subset of 0..6 (0=Sunday, UTC) the window applies to; "0123456" = every day.
		daysOfWeek: text("days_of_week").notNull().default("0123456"),
		// Minutes from UTC midnight. start is inclusive (0..1439), end is exclusive
		// (0..1440); when end <= start the window wraps past midnight into next day.
		startMinute: integer("start_minute").notNull(),
		endMinute: integer("end_minute").notNull(),
		inputUsdMicrosPer1m: integer("input_usd_micros_per_1m"),
		cachedInputUsdMicrosPer1m: integer("cached_input_usd_micros_per_1m"),
		cacheHitUsdMicrosPer1m: integer("cache_hit_usd_micros_per_1m"),
		cacheMissUsdMicrosPer1m: integer("cache_miss_usd_micros_per_1m"),
		outputUsdMicrosPer1m: integer("output_usd_micros_per_1m"),
		enabled: integer("enabled").notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		providerModelIdx: index("provider_model_price_windows_model_idx").on(
			table.providerModelId,
		),
	}),
);

export const importJobs = sqliteTable(
	"import_jobs",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		status: text("status").notNull().default("pending"),
		totalConversations: integer("total_conversations").notNull().default(0),
		processedConversations: integer("processed_conversations")
			.notNull()
			.default(0),
		errorLog: text("error_log"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userStatusIdx: index("import_jobs_user_status_idx").on(
			table.userId,
			table.status,
			table.updatedAt,
		),
	}),
);

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		color: text("color"),
		sidebarPinned: integer("sidebar_pinned", { mode: "boolean" })
			.notNull()
			.default(false),
		sortOrder: integer("sort_order").notNull().default(0),
		canonicalMemoryProjectId: text("canonical_memory_project_id").references(
			() => memoryProjects.projectId,
			{ onDelete: "set null" },
		),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		canonicalMemoryProjectUniqueIdx: uniqueIndex(
			"projects_canonical_memory_project_id_unique_idx",
		).on(table.canonicalMemoryProjectId),
		userSidebarIdx: index("projects_user_sidebar_idx").on(
			table.userId,
			table.sidebarPinned,
			table.sortOrder,
		),
	}),
);

export const messageAnalytics = sqliteTable(
	"message_analytics",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		model: text("model").notNull(),
		promptTokens: integer("prompt_tokens"),
		completionTokens: integer("completion_tokens"),
		reasoningTokens: integer("reasoning_tokens"),
		generationTimeMs: integer("generation_time_ms"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		messageUniqueIdx: uniqueIndex("message_analytics_message_unique_idx").on(
			table.messageId,
		),
	}),
);

export const analyticsConversations = sqliteTable(
	"analytics_conversations",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		userId: text("user_id").notNull(),
		userEmail: text("user_email"),
		userName: text("user_name"),
		title: text("title"),
		source: text("source").notNull().default("live"),
		billingMonth: text("billing_month").notNull(),
		conversationCreatedAt: integer("conversation_created_at", {
			mode: "timestamp",
		}),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		conversationUniqueIdx: uniqueIndex(
			"analytics_conversations_conversation_unique_idx",
		).on(table.conversationId),
		userMonthIdx: index("analytics_conversations_user_month_idx").on(
			table.userId,
			table.billingMonth,
		),
	}),
);

export const usageEvents = sqliteTable(
	"usage_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		userEmail: text("user_email"),
		userName: text("user_name"),
		conversationId: text("conversation_id").notNull(),
		conversationTitle: text("conversation_title"),
		messageId: text("message_id").notNull(),
		modelId: text("model_id").notNull(),
		modelDisplayName: text("model_display_name"),
		providerId: text("provider_id"),
		providerDisplayName: text("provider_display_name"),
		providerBaseUrl: text("provider_base_url"),
		providerModelName: text("provider_model_name"),
		promptTokens: integer("prompt_tokens").notNull().default(0),
		cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
		cacheHitTokens: integer("cache_hit_tokens").notNull().default(0),
		cacheMissTokens: integer("cache_miss_tokens").notNull().default(0),
		completionTokens: integer("completion_tokens").notNull().default(0),
		reasoningTokens: integer("reasoning_tokens").notNull().default(0),
		totalTokens: integer("total_tokens").notNull().default(0),
		usageSource: text("usage_source").notNull().default("estimated"),
		generationTimeMs: integer("generation_time_ms"),
		billingMonth: text("billing_month").notNull(),
		costUsdMicros: integer("cost_usd_micros").notNull().default(0),
		priceRuleId: text("price_rule_id"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		messageUniqueIdx: uniqueIndex("usage_events_message_unique_idx").on(
			table.messageId,
		),
		userMonthIdx: index("usage_events_user_month_idx").on(
			table.userId,
			table.billingMonth,
		),
		modelMonthIdx: index("usage_events_model_month_idx").on(
			table.modelId,
			table.billingMonth,
		),
	}),
);

export const chatGeneratedFiles = sqliteTable(
	"chat_generated_files",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		assistantMessageId: text("assistant_message_id").references(
			() => messages.id,
			{ onDelete: "cascade" },
		),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		filename: text("filename").notNull(),
		mimeType: text("mime_type"),
		sizeBytes: integer("size_bytes").notNull().default(0),
		storagePath: text("storage_path").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		assistantMessageIdx: index("chat_generated_files_assistant_message_idx").on(
			table.assistantMessageId,
			table.createdAt,
		),
		conversationIdx: index("chat_generated_files_conversation_idx").on(
			table.conversationId,
			table.createdAt,
		),
		userIdx: index("chat_generated_files_user_idx").on(
			table.userId,
			table.createdAt,
		),
	}),
);

export const fileProductionJobs = sqliteTable(
	"file_production_jobs",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		assistantMessageId: text("assistant_message_id").references(
			() => messages.id,
			{
				onDelete: "set null",
			},
		),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		status: text("status").notNull().default("succeeded"),
		stage: text("stage"),
		origin: text("origin").notNull().default("legacy_generated_file"),
		currentAttemptId: text("current_attempt_id"),
		retryable: integer("retryable", { mode: "boolean" })
			.notNull()
			.default(false),
		dismissed: integer("dismissed", { mode: "boolean" })
			.notNull()
			.default(false),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		completedAt: integer("completed_at", { mode: "timestamp" }),
		cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp" }),
		idempotencyKey: text("idempotency_key"),
		requestJson: text("request_json"),
		sourceMode: text("source_mode"),
		documentIntent: text("document_intent"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		conversationIdx: index("file_production_jobs_conversation_idx").on(
			table.conversationId,
			table.createdAt,
		),
		assistantMessageIdx: index("file_production_jobs_assistant_message_idx").on(
			table.assistantMessageId,
			table.createdAt,
		),
		userIdx: index("file_production_jobs_user_idx").on(
			table.userId,
			table.createdAt,
		),
		idempotencyUniqueIdx: uniqueIndex(
			"file_production_jobs_idempotency_unique_idx",
		)
			.on(table.userId, table.conversationId, table.idempotencyKey)
			.where(sql`${table.idempotencyKey} IS NOT NULL`),
		sourceModeIdx: index("file_production_jobs_source_mode_idx").on(
			table.sourceMode,
			table.createdAt,
		),
	}),
);

export const fileProductionJobAttempts = sqliteTable(
	"file_production_job_attempts",
	{
		id: text("id").primaryKey(),
		jobId: text("job_id")
			.notNull()
			.references(() => fileProductionJobs.id, { onDelete: "cascade" }),
		attemptNumber: integer("attempt_number").notNull(),
		status: text("status").notNull().default("running"),
		stage: text("stage"),
		mode: text("mode"),
		renderer: text("renderer"),
		runtime: text("runtime"),
		workerId: text("worker_id"),
		claimedAt: integer("claimed_at", { mode: "timestamp" }),
		heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
		startedAt: integer("started_at", { mode: "timestamp" }),
		finishedAt: integer("finished_at", { mode: "timestamp" }),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		retryable: integer("retryable", { mode: "boolean" })
			.notNull()
			.default(false),
		diagnosticsJson: text("diagnostics_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		jobNumberUniqueIdx: uniqueIndex(
			"file_production_job_attempts_job_number_unique_idx",
		).on(table.jobId, table.attemptNumber),
		jobIdx: index("file_production_job_attempts_job_idx").on(
			table.jobId,
			table.createdAt,
		),
		workerIdx: index("file_production_job_attempts_worker_idx").on(
			table.workerId,
			table.status,
			table.heartbeatAt,
		),
	}),
);

export const fileProductionJobFiles = sqliteTable(
	"file_production_job_files",
	{
		id: text("id").primaryKey(),
		jobId: text("job_id")
			.notNull()
			.references(() => fileProductionJobs.id, { onDelete: "cascade" }),
		chatGeneratedFileId: text("chat_generated_file_id")
			.notNull()
			.references(() => chatGeneratedFiles.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		chatFileUniqueIdx: uniqueIndex(
			"file_production_job_files_chat_file_unique_idx",
		).on(table.chatGeneratedFileId),
		jobOrderIdx: index("file_production_job_files_job_order_idx").on(
			table.jobId,
			table.sortOrder,
		),
	}),
);

export const atlasJobs = sqliteTable(
	"atlas_jobs",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		assistantMessageId: text("assistant_message_id").references(
			() => messages.id,
			{
				onDelete: "set null",
			},
		),
		action: text("action").notNull(),
		parentAtlasJobId: text("parent_atlas_job_id").references(
			(): AnySQLiteColumn => atlasJobs.id,
			{
				onDelete: "set null",
			},
		),
		profile: text("profile").notNull(),
		normalizedQueryHash: text("normalized_query_hash").notNull(),
		clientAtlasTurnId: text("client_atlas_turn_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		title: text("title").notNull(),
		status: text("status").notNull().default("queued"),
		stage: text("stage").notNull().default("queued"),
		progressPercent: integer("progress_percent").notNull().default(0),
		progressDetailsJson: text("progress_details_json").notNull().default("{}"),
		workerId: text("worker_id"),
		heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
		startedAt: integer("started_at", { mode: "timestamp" }),
		completedAt: integer("completed_at", { mode: "timestamp" }),
		cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp" }),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		totalTokens: integer("total_tokens").notNull().default(0),
		costUsdMicros: integer("cost_usd_micros").notNull().default(0),
		localSourceCount: integer("local_source_count").notNull().default(0),
		webSourceCount: integer("web_source_count").notNull().default(0),
		acceptedSourceCount: integer("accepted_source_count").notNull().default(0),
		rejectedSourceCount: integer("rejected_source_count").notNull().default(0),
		fileProductionJobId: text("file_production_job_id").references(
			() => fileProductionJobs.id,
			{
				onDelete: "set null",
			},
		),
		htmlChatGeneratedFileId: text("html_chat_generated_file_id").references(
			() => chatGeneratedFiles.id,
			{
				onDelete: "set null",
			},
		),
		pdfChatGeneratedFileId: text("pdf_chat_generated_file_id").references(
			() => chatGeneratedFiles.id,
			{
				onDelete: "set null",
			},
		),
		markdownChatGeneratedFileId: text(
			"markdown_chat_generated_file_id",
		).references(() => chatGeneratedFiles.id, {
			onDelete: "set null",
		}),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		errorRetryable: integer("error_retryable", { mode: "boolean" })
			.notNull()
			.default(false),
		failureMetadataJson: text("failure_metadata_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => [
		uniqueIndex("atlas_jobs_idempotency_unique_idx").on(table.idempotencyKey),
		index("atlas_jobs_user_status_created_idx").on(
			table.userId,
			table.status,
			table.createdAt,
		),
		index("atlas_jobs_conversation_status_updated_idx").on(
			table.conversationId,
			table.status,
			table.updatedAt,
		),
		index("atlas_jobs_parent_idx").on(table.parentAtlasJobId, table.createdAt),
		index("atlas_jobs_assistant_message_idx").on(table.assistantMessageId),
	],
);

export const atlasRoundCheckpoints = sqliteTable(
	"atlas_round_checkpoints",
	{
		id: text("id").primaryKey(),
		jobId: text("job_id")
			.notNull()
			.references(() => atlasJobs.id, { onDelete: "cascade" }),
		roundNumber: integer("round_number").notNull(),
		checkpointVersion: integer("checkpoint_version").notNull().default(1),
		stage: text("stage").notNull(),
		checkpointJson: text("checkpoint_json").notNull().default("{}"),
		curatedSourcePoolJson: text("curated_source_pool_json")
			.notNull()
			.default("[]"),
		compressedFindingsJson: text("compressed_findings_json")
			.notNull()
			.default("{}"),
		usageJson: text("usage_json").notNull().default("{}"),
		qualityDiagnosticsJson: text("quality_diagnostics_json")
			.notNull()
			.default("{}"),
		documentSourceSummaryJson: text("document_source_summary_json")
			.notNull()
			.default("{}"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => [
		uniqueIndex("atlas_round_checkpoints_job_round_unique_idx").on(
			table.jobId,
			table.roundNumber,
		),
		index("atlas_round_checkpoints_job_created_idx").on(
			table.jobId,
			table.createdAt,
		),
	],
);

export const campaignAssets = sqliteTable(
	"campaign_assets",
	{
		id: text("id").primaryKey(),
		uploadedByUserId: text("uploaded_by_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sourceAssetId: text("source_asset_id").references(
			(): AnySQLiteColumn => campaignAssets.id,
			{
				onDelete: "set null",
			},
		),
		assetKind: text("asset_kind").notNull(),
		variant: text("variant"),
		status: text("status").notNull().default("draft"),
		originalFilename: text("original_filename").notNull(),
		mimeType: text("mime_type").notNull(),
		sizeBytes: integer("size_bytes").notNull().default(0),
		storagePath: text("storage_path").notNull(),
		width: integer("width"),
		height: integer("height"),
		cropX: real("crop_x"),
		cropY: real("crop_y"),
		cropWidth: real("crop_width"),
		cropHeight: real("crop_height"),
		zoom: real("zoom"),
		cropMetadataJson: text("crop_metadata_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		statusIdx: index("campaign_assets_status_idx").on(
			table.status,
			table.createdAt,
		),
		uploadedByIdx: index("campaign_assets_uploaded_by_idx").on(
			table.uploadedByUserId,
			table.createdAt,
		),
		sourceIdx: index("campaign_assets_source_idx").on(
			table.sourceAssetId,
			table.variant,
		),
	}),
);

export const announcementCampaigns = sqliteTable(
	"announcement_campaigns",
	{
		id: text("id").primaryKey(),
		type: text("type").notNull(),
		status: text("status").notNull().default("draft"),
		identityKey: text("identity_key").notNull().unique(),
		name: text("name").notNull(),
		campaignVersion: text("campaign_version").notNull(),
		revision: integer("revision").notNull(),
		releaseVersion: text("release_version"),
		audience: text("audience").notNull().default("all"),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		publishedByUserId: text("published_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		publishedSnapshotId: text("published_snapshot_id"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		publishedAt: integer("published_at", { mode: "timestamp" }),
		archivedAt: integer("archived_at", { mode: "timestamp" }),
	},
	(table) => ({
		typeStatusIdx: index("announcement_campaigns_type_status_idx").on(
			table.type,
			table.status,
			table.publishedAt,
		),
		versionRevisionUniqueIdx: uniqueIndex(
			"announcement_campaigns_version_revision_unique_idx",
		).on(table.type, table.campaignVersion, table.revision),
		statusUpdatedIdx: index("announcement_campaigns_status_updated_idx").on(
			table.status,
			table.updatedAt,
		),
	}),
);

export const announcementCampaignSlides = sqliteTable(
	"announcement_campaign_slides",
	{
		id: text("id").primaryKey(),
		campaignId: text("campaign_id")
			.notNull()
			.references(() => announcementCampaigns.id, { onDelete: "cascade" }),
		layoutType: text("layout_type").notNull(),
		semanticRole: text("semantic_role").notNull().default("feature"),
		sortOrder: integer("sort_order").notNull(),
		titleEn: text("title_en").notNull().default(""),
		titleHu: text("title_hu").notNull().default(""),
		bodyEn: text("body_en").notNull().default(""),
		bodyHu: text("body_hu").notNull().default(""),
		actionLabelEn: text("action_label_en"),
		actionLabelHu: text("action_label_hu"),
		altTextEn: text("alt_text_en").notNull().default(""),
		altTextHu: text("alt_text_hu").notNull().default(""),
		desktopCropAssetId: text("desktop_crop_asset_id").references(
			() => campaignAssets.id,
			{
				onDelete: "set null",
			},
		),
		mobileCropAssetId: text("mobile_crop_asset_id").references(
			() => campaignAssets.id,
			{
				onDelete: "set null",
			},
		),
		actionDestination: text("action_destination"),
		setupControlsJson: text("setup_controls_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		campaignOrderIdx: index(
			"announcement_campaign_slides_campaign_order_idx",
		).on(table.campaignId, table.sortOrder),
		campaignOrderUniqueIdx: uniqueIndex(
			"announcement_campaign_slides_campaign_order_unique_idx",
		).on(table.campaignId, table.sortOrder),
	}),
);

export const announcementCampaignSnapshots = sqliteTable(
	"announcement_campaign_snapshots",
	{
		id: text("id").primaryKey(),
		campaignId: text("campaign_id")
			.notNull()
			.references(() => announcementCampaigns.id, { onDelete: "cascade" }),
		identityKey: text("identity_key").notNull().unique(),
		type: text("type").notNull(),
		name: text("name").notNull(),
		campaignVersion: text("campaign_version").notNull(),
		revision: integer("revision").notNull(),
		releaseVersion: text("release_version"),
		audience: text("audience").notNull().default("all"),
		publishedByUserId: text("published_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		publishedAt: integer("published_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		archivedAt: integer("archived_at", { mode: "timestamp" }),
	},
	(table) => ({
		campaignIdx: index("announcement_campaign_snapshots_campaign_idx").on(
			table.campaignId,
		),
		typePublishedIdx: index(
			"announcement_campaign_snapshots_type_published_idx",
		).on(table.type, table.publishedAt),
	}),
);

export const announcementCampaignSnapshotSlides = sqliteTable(
	"announcement_campaign_snapshot_slides",
	{
		id: text("id").primaryKey(),
		snapshotId: text("snapshot_id")
			.notNull()
			.references(() => announcementCampaignSnapshots.id, {
				onDelete: "cascade",
			}),
		campaignId: text("campaign_id")
			.notNull()
			.references(() => announcementCampaigns.id, { onDelete: "cascade" }),
		draftSlideId: text("draft_slide_id"),
		layoutType: text("layout_type").notNull(),
		semanticRole: text("semantic_role").notNull().default("feature"),
		sortOrder: integer("sort_order").notNull(),
		titleEn: text("title_en").notNull(),
		titleHu: text("title_hu").notNull(),
		bodyEn: text("body_en").notNull(),
		bodyHu: text("body_hu").notNull(),
		actionLabelEn: text("action_label_en"),
		actionLabelHu: text("action_label_hu"),
		altTextEn: text("alt_text_en").notNull(),
		altTextHu: text("alt_text_hu").notNull(),
		desktopCropAssetId: text("desktop_crop_asset_id").references(
			() => campaignAssets.id,
			{
				onDelete: "set null",
			},
		),
		mobileCropAssetId: text("mobile_crop_asset_id").references(
			() => campaignAssets.id,
			{
				onDelete: "set null",
			},
		),
		actionDestination: text("action_destination"),
		setupControlsJson: text("setup_controls_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		snapshotOrderIdx: index(
			"announcement_campaign_snapshot_slides_order_idx",
		).on(table.snapshotId, table.sortOrder),
		campaignOrderIdx: index(
			"announcement_campaign_snapshot_slides_campaign_idx",
		).on(table.campaignId, table.sortOrder),
	}),
);

export const announcementCampaignUserStates = sqliteTable(
	"announcement_campaign_user_states",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		campaignId: text("campaign_id")
			.notNull()
			.references(() => announcementCampaigns.id, { onDelete: "cascade" }),
		snapshotId: text("snapshot_id")
			.notNull()
			.references(() => announcementCampaignSnapshots.id, {
				onDelete: "cascade",
			}),
		status: text("status").notNull(),
		reason: text("reason").notNull(),
		completedAt: integer("completed_at", { mode: "timestamp" }),
		dismissedAt: integer("dismissed_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userSnapshotUniqueIdx: uniqueIndex(
			"announcement_campaign_user_states_user_snapshot_unique_idx",
		).on(table.userId, table.snapshotId),
		userCampaignIdx: index(
			"announcement_campaign_user_states_user_campaign_idx",
		).on(table.userId, table.campaignId),
	}),
);

export const announcementCampaignEvents = sqliteTable(
	"announcement_campaign_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		campaignId: text("campaign_id")
			.notNull()
			.references(() => announcementCampaigns.id, { onDelete: "cascade" }),
		snapshotId: text("snapshot_id")
			.notNull()
			.references(() => announcementCampaignSnapshots.id, {
				onDelete: "cascade",
			}),
		eventType: text("event_type").notNull(),
		slideId: text("slide_id").references(
			() => announcementCampaignSnapshotSlides.id,
			{
				onDelete: "set null",
			},
		),
		metadataJson: text("metadata_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		campaignEventIdx: index(
			"announcement_campaign_events_campaign_event_idx",
		).on(table.campaignId, table.eventType, table.createdAt),
		userCampaignEventIdx: index(
			"announcement_campaign_events_user_campaign_event_idx",
		).on(table.userId, table.campaignId, table.eventType),
		slideIdx: index("announcement_campaign_events_slide_idx").on(table.slideId),
	}),
);

export const personalityProfiles = sqliteTable("personality_profiles", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	description: text("description").notNull().default(""),
	promptText: text("prompt_text").notNull().default(""),
	isBuiltIn: integer("is_built_in").notNull().default(0),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
});

// External accounts a user privately connects to AlfyAI (Google, Apple,
// Nextcloud, Immich, email, Plex, OwnTracks, contacts). Secrets are stored
// encrypted (see connections service, issue 1.2); this table only holds the
// ciphertext + metadata needed to manage the connection.
export const CONNECTION_PROVIDERS = [
	"nextcloud",
	"immich",
	"imap",
	"google",
	"apple",
	"plex",
	"owntracks",
	"contacts",
] as const;

export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const userConnections = sqliteTable(
	"user_connections",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		provider: text("provider").notNull(),
		label: text("label").notNull(),
		accountIdentifier: text("account_identifier").notNull().default(""),
		status: text("status").notNull().default("disconnected"),
		statusDetail: text("status_detail"),
		defaultOn: integer("default_on", { mode: "boolean" })
			.notNull()
			.default(false),
		allowWrites: integer("allow_writes", { mode: "boolean" })
			.notNull()
			.default(false),
		writeAllowlistJson: text("write_allowlist_json").notNull().default("[]"),
		capabilitiesJson: text("capabilities_json").notNull().default("[]"),
		secretCiphertext: text("secret_ciphertext"),
		secretIv: text("secret_iv"),
		secretAuthTag: text("secret_auth_tag"),
		oauthScopesJson: text("oauth_scopes_json").notNull().default("[]"),
		tokenExpiresAt: integer("token_expires_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		userProviderAccountUniqueIdx: uniqueIndex(
			"user_connections_user_provider_account_unique",
		).on(table.userId, table.provider, table.accountIdentifier),
		userIdx: index("user_connections_user_idx").on(table.userId),
	}),
);
