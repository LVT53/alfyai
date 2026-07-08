import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactChunks,
	artifactLinks,
	artifacts,
	chatGeneratedFiles,
	conversationForks,
	conversations,
	fileProductionJobFiles,
	fileProductionJobs,
	memoryEvents,
	messages,
} from "$lib/server/db/schema";
import type {
	Artifact,
	Conversation,
	ConversationForkListSummary,
	ConversationForkOrigin,
	ForkCopyMetadata,
	ForkEvidenceSnapshot,
	MessageEvidenceSummary,
	MessageSourceForks,
} from "$lib/types";
import { reconcileStaleFileProductionJobs } from "./file-production";
import { messageOrderAsc } from "./message-ordering";
import {
	type MessageSequenceExecutor,
	repairConversationMessageSequencesWithExecutor,
} from "./message-sequences";
import { queueArtifactSemanticEmbeddingRefresh } from "./semantic-embedding-refresh";

type CreateConversationForkParams = {
	userId: string;
	sourceConversationId: string;
	sourceMessageId: string;
};

type ConversationForkResult = {
	conversation: Conversation;
	forkOrigin: ConversationForkOrigin;
};

type PersistedMessageMetadata = Record<string, unknown> & {
	forkCopy?: ForkCopyMetadata;
	forkEvidenceSnapshot?: ForkEvidenceSnapshot;
	evidenceSummary?: MessageEvidenceSummary | null;
	wasStopped?: boolean;
};

type JsonRecord = Record<string, unknown>;
type ForkQueryExecutor = {
	select: typeof db.select;
} & MessageSequenceExecutor;
type SourceConversationRow = typeof conversations.$inferSelect;
type SourceMessageRow = typeof messages.$inferSelect;
type GeneratedFileCopyPlan = {
	sourceFile: typeof chatGeneratedFiles.$inferSelect;
	copiedFileId: string;
	storagePath: string;
};
type GeneratedWorkSnapshotResult = {
	copiedArtifactIdBySourceId: Map<string, string>;
	copiedArtifacts: Artifact[];
};

const MAX_FORK_SEQUENCE_ATTEMPTS = 5;

class ForkSequenceCollisionRetry extends Error {
	constructor() {
		super("Fork sequence collision");
		this.name = "ForkSequenceCollisionRetry";
	}
}

export class ConversationForkError extends Error {
	constructor(
		public code:
			| "source_conversation_not_found"
			| "invalid_source_message"
			| "empty_source_message"
			| "stopped_source_message"
			| "required_artifact_unavailable"
			| "required_artifact_unauthorized"
			| "required_generated_work_unavailable"
			| "fork_sequence_conflict",
		message: string,
		public status = 400,
	) {
		super(message);
		this.name = "ConversationForkError";
	}
}

function mapConversation(row: typeof conversations.$inferSelect): Conversation {
	return {
		id: row.id,
		title: row.title,
		projectId: row.projectId ?? null,
		status: row.status as Conversation["status"],
		sealedAt: row.sealedAt ? row.sealedAt.getTime() / 1000 : null,
		sidebarPinned: row.sidebarPinned,
		sidebarSortOrder: row.sidebarSortOrder ?? null,
		createdAt: row.createdAt.getTime() / 1000,
		updatedAt: row.updatedAt.getTime() / 1000,
	};
}

function mapForkOrigin(
	row: typeof conversationForks.$inferSelect,
): ConversationForkOrigin {
	return {
		forkConversationId: row.forkConversationId,
		sourceConversationId:
			row.sourceConversationId ?? row.sourceConversationIdSnapshot,
		sourceAssistantMessageId:
			row.sourceAssistantMessageId ?? row.sourceAssistantMessageIdSnapshot,
		sourceConversationIdAvailable: Boolean(row.sourceConversationId),
		sourceAssistantMessageIdAvailable: Boolean(row.sourceAssistantMessageId),
		copiedForkPointMessageId: row.copiedForkPointMessageId,
		sourceTitle: row.sourceTitle,
		forkSequence: row.forkSequence,
		createdAt: row.createdAt.getTime() / 1000,
	};
}

function mapForkListSummary(
	row: typeof conversationForks.$inferSelect,
): ConversationForkListSummary {
	return {
		sourceTitle: row.sourceTitle,
		forkSequence: row.forkSequence,
		sourceConversationId:
			row.sourceConversationId ?? row.sourceConversationIdSnapshot,
		sourceConversationIdAvailable: Boolean(row.sourceConversationId),
	};
}

function parseMetadata(value: string | null): PersistedMessageMetadata {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as PersistedMessageMetadata)
			: {};
	} catch {
		return {};
	}
}

function parseJsonRecord(value: string | null): JsonRecord {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as JsonRecord) : {};
	} catch {
		return {};
	}
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function mapArtifactForSemanticRefresh(
	row: typeof artifacts.$inferSelect,
	metadata: JsonRecord | null,
): Artifact {
	return {
		id: row.id,
		userId: row.userId,
		type: row.type as Artifact["type"],
		retrievalClass: row.retrievalClass as Artifact["retrievalClass"],
		name: row.name,
		mimeType: row.mimeType,
		extension: row.extension,
		sizeBytes: row.sizeBytes,
		conversationId: row.conversationId,
		storagePath: row.storagePath,
		contentText: row.contentText,
		summary: row.summary,
		metadata,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

function validateForkSourceSnapshot(params: {
	sourceConversation: SourceConversationRow | null;
	sourceMessages: SourceMessageRow[];
	sourceMessageId: string;
}): {
	sourceConversation: SourceConversationRow;
	sourceMessagesToCopy: SourceMessageRow[];
	forkPointMessage: SourceMessageRow;
} {
	if (!params.sourceConversation) {
		throw new ConversationForkError(
			"source_conversation_not_found",
			"Source conversation not found",
			404,
		);
	}

	const forkPointIndex = params.sourceMessages.findIndex(
		(message) => message.id === params.sourceMessageId,
	);
	const forkPointMessage =
		forkPointIndex >= 0 ? params.sourceMessages[forkPointIndex] : null;

	if (forkPointMessage?.role !== "assistant") {
		throw new ConversationForkError(
			"invalid_source_message",
			"Forks can only be created from a persisted assistant response",
		);
	}
	if (forkPointMessage.content.trim().length === 0) {
		throw new ConversationForkError(
			"empty_source_message",
			"Forks require a non-empty assistant response",
		);
	}
	if (parseMetadata(forkPointMessage.metadataJson).wasStopped === true) {
		throw new ConversationForkError(
			"stopped_source_message",
			"Stopped assistant responses cannot be forked",
		);
	}

	return {
		sourceConversation: params.sourceConversation,
		sourceMessagesToCopy: params.sourceMessages.slice(0, forkPointIndex + 1),
		forkPointMessage,
	};
}

function readForkSourceSnapshot(
	executor: ForkQueryExecutor,
	params: CreateConversationForkParams,
): {
	sourceConversation: SourceConversationRow;
	sourceMessagesToCopy: SourceMessageRow[];
	forkPointMessage: SourceMessageRow;
} {
	const sourceConversation = executor
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.id, params.sourceConversationId),
				eq(conversations.userId, params.userId),
			),
		)
		.limit(1)
		.get();

	const sourceMessages = sourceConversation
		? (() => {
				repairConversationMessageSequencesWithExecutor(
					executor,
					sourceConversation.id,
				);
				return executor
					.select()
					.from(messages)
					.where(eq(messages.conversationId, sourceConversation.id))
					.orderBy(...messageOrderAsc())
					.all();
			})()
		: [];

	return validateForkSourceSnapshot({
		sourceConversation: sourceConversation ?? null,
		sourceMessages,
		sourceMessageId: params.sourceMessageId,
	});
}

function cleanupStagedFiles(stagedFilePaths: string[]): void {
	for (const stagedFilePath of stagedFilePaths) {
		try {
			rmSync(stagedFilePath, { force: true });
		} catch {
			// File cleanup is best-effort after a rolled-back fork.
		}
	}
}

function isForkSequenceUniqueConstraintError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const errorWithCode = error as { code?: unknown; message?: unknown };
	const code = typeof errorWithCode.code === "string" ? errorWithCode.code : "";
	const message =
		typeof errorWithCode.message === "string" ? errorWithCode.message : "";
	if (!code.includes("SQLITE_CONSTRAINT") && !/unique/i.test(message)) {
		return false;
	}
	return (
		message.includes(
			"conversation_forks_user_source_assistant_sequence_unique_idx",
		) ||
		(message.includes("conversation_forks.user_id") &&
			message.includes(
				"conversation_forks.source_assistant_message_id_snapshot",
			) &&
			message.includes("conversation_forks.fork_sequence"))
	);
}

function prepareGeneratedFileCopyPlan(params: {
	userId: string;
	sourceConversationId: string;
	forkConversationId: string;
	sourceMessageIds: string[];
	stagedFilePaths: string[];
}): GeneratedFileCopyPlan[] {
	if (params.sourceMessageIds.length === 0) return [];

	const sourceFiles = db
		.select()
		.from(chatGeneratedFiles)
		.where(
			and(
				eq(chatGeneratedFiles.userId, params.userId),
				eq(chatGeneratedFiles.conversationId, params.sourceConversationId),
				inArray(chatGeneratedFiles.assistantMessageId, params.sourceMessageIds),
			),
		)
		.orderBy(asc(chatGeneratedFiles.createdAt), asc(chatGeneratedFiles.id))
		.all();

	return sourceFiles.map((sourceFile) => {
		const copiedFileId = randomUUID();
		const storagePath = join(
			params.forkConversationId,
			`${copiedFileId}.${getFileExtension(sourceFile.filename)}`,
		);
		const sourceFullPath = join(getChatFilesDir(), sourceFile.storagePath);
		const targetFullPath = join(getChatFilesDir(), storagePath);
		try {
			mkdirSync(dirname(targetFullPath), { recursive: true });
			copyFileSync(sourceFullPath, targetFullPath);
			params.stagedFilePaths.push(targetFullPath);
		} catch {
			throw new ConversationForkError(
				"required_generated_work_unavailable",
				"Fork source includes generated work whose binary storage is no longer available",
				409,
			);
		}
		return {
			sourceFile,
			copiedFileId,
			storagePath,
		};
	});
}

function copyMetadata(
	sourceMessage: typeof messages.$inferSelect,
	snapshotCreatedAt: Date,
): PersistedMessageMetadata {
	const sourceMetadata = parseMetadata(sourceMessage.metadataJson);
	const next: PersistedMessageMetadata = {
		...sourceMetadata,
		forkCopy: {
			sourceMessageId: sourceMessage.id,
			sourceConversationId: sourceMessage.conversationId,
			sourceRole: sourceMessage.role as ForkCopyMetadata["sourceRole"],
			sourceCreatedAt: sourceMessage.createdAt.toISOString(),
		},
	};
	delete next.skillQuestion;
	delete next.pendingSkillNoteIntents;
	delete next.skillDrafts;
	delete next.skillControl;
	delete next.evidenceStatus;
	const evidenceSummary =
		sourceMetadata.evidenceSummary &&
		Array.isArray(sourceMetadata.evidenceSummary.groups)
			? sourceMetadata.evidenceSummary
			: null;
	if (sourceMessage.role === "assistant" && evidenceSummary) {
		next.forkEvidenceSnapshot = {
			sourceMessageId: sourceMessage.id,
			sourceConversationId: sourceMessage.conversationId,
			snapshotCreatedAt: snapshotCreatedAt.toISOString(),
			evidenceSummary,
		};
		delete next.evidenceSummary;
	}
	return next;
}

function getNextForkSequence(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	sourceAssistantMessageId: string,
): number {
	const latest = tx
		.select({ forkSequence: conversationForks.forkSequence })
		.from(conversationForks)
		.where(
			eq(
				conversationForks.sourceAssistantMessageIdSnapshot,
				sourceAssistantMessageId,
			),
		)
		.orderBy(desc(conversationForks.forkSequence))
		.limit(1)
		.get();
	return (latest?.forkSequence ?? 0) + 1;
}

function scopeMemoryEventKey(userId: string, eventKey: string): string {
	return `u:${userId}:${eventKey}`;
}

function isDurableDocumentArtifactType(type: string): boolean {
	return type === "source_document" || type === "normalized_document";
}

function isGeneratedOutputArtifactType(type: string): boolean {
	return type === "generated_output";
}

function isTerminalFileProductionStatus(status: string): boolean {
	return (
		status === "succeeded" || status === "failed" || status === "cancelled"
	);
}

function getChatFilesDir(): string {
	return join(process.cwd(), "data", "chat-files");
}

function getFileExtension(filename: string): string {
	const ext = extname(filename).toLowerCase();
	return ext ? ext.slice(1) : "bin";
}

function isConversationLevelLinkVisibleAtFork(
	link: typeof artifactLinks.$inferSelect,
	forkPointCreatedAt: Date,
): boolean {
	return (
		link.messageId !== null ||
		link.createdAt.getTime() <= forkPointCreatedAt.getTime()
	);
}

function copyDurableDocumentLinks(params: {
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
	userId: string;
	sourceConversationId: string;
	forkConversationId: string;
	sourceMessageIds: string[];
	copiedMessageIdBySourceId: Map<string, string>;
	copiedGeneratedArtifactIds: Set<string>;
	forkPointCreatedAt: Date;
	now: Date;
}): void {
	if (params.sourceMessageIds.length === 0) return;

	const rows = params.tx
		.select({
			link: artifactLinks,
			artifact: artifacts,
		})
		.from(artifactLinks)
		.leftJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.where(
			and(
				eq(artifactLinks.userId, params.userId),
				eq(artifactLinks.conversationId, params.sourceConversationId),
				eq(artifactLinks.linkType, "attached_to_conversation"),
				or(
					isNull(artifactLinks.messageId),
					inArray(artifactLinks.messageId, params.sourceMessageIds),
				),
			),
		)
		.all();

	const linksToCopy: (typeof artifactLinks.$inferSelect)[] = [];
	for (const row of rows) {
		if (
			!isConversationLevelLinkVisibleAtFork(row.link, params.forkPointCreatedAt)
		) {
			continue;
		}
		if (!row.artifact) {
			throw new ConversationForkError(
				"required_artifact_unavailable",
				"Fork source includes a document or attachment that is no longer available",
				409,
			);
		}
		if (row.artifact.userId !== params.userId) {
			throw new ConversationForkError(
				"required_artifact_unauthorized",
				"Fork source includes a document or attachment that is not available to this user",
				403,
			);
		}
		if (isDurableDocumentArtifactType(row.artifact.type)) {
			linksToCopy.push(row.link);
			continue;
		}
		if (isGeneratedOutputArtifactType(row.artifact.type)) {
			if (params.copiedGeneratedArtifactIds.has(row.artifact.id)) continue;
			throw new ConversationForkError(
				"required_generated_work_unavailable",
				"Fork source includes generated work that cannot be snapshotted",
				409,
			);
		}
		throw new ConversationForkError(
			"required_artifact_unavailable",
			`Fork source includes a visible ${row.artifact.type} attachment that cannot be preserved`,
			409,
		);
	}

	if (linksToCopy.length === 0) return;

	params.tx
		.insert(artifactLinks)
		.values(
			linksToCopy.map((link) => ({
				id: randomUUID(),
				userId: params.userId,
				artifactId: link.artifactId,
				relatedArtifactId: link.relatedArtifactId ?? null,
				conversationId: params.forkConversationId,
				messageId: link.messageId
					? (params.copiedMessageIdBySourceId.get(link.messageId) ?? null)
					: null,
				linkType: link.linkType,
				createdAt: params.now,
			})),
		)
		.run();
}

function copyGeneratedWorkSnapshot(params: {
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
	userId: string;
	sourceConversationId: string;
	forkConversationId: string;
	sourceMessageIds: string[];
	copiedMessageIdBySourceId: Map<string, string>;
	forkPointCreatedAt: Date;
	now: Date;
	fileCopyPlans: GeneratedFileCopyPlan[];
}): GeneratedWorkSnapshotResult {
	if (params.sourceMessageIds.length === 0) {
		return {
			copiedArtifactIdBySourceId: new Map(),
			copiedArtifacts: [],
		};
	}

	const copiedFileIdBySourceId = new Map<string, string>();
	const sourceFiles = params.fileCopyPlans.map((plan) => plan.sourceFile);
	for (const plan of params.fileCopyPlans) {
		const { sourceFile, copiedFileId, storagePath } = plan;
		params.tx
			.insert(chatGeneratedFiles)
			.values({
				id: copiedFileId,
				conversationId: params.forkConversationId,
				assistantMessageId: sourceFile.assistantMessageId
					? (params.copiedMessageIdBySourceId.get(
							sourceFile.assistantMessageId,
						) ?? null)
					: null,
				userId: params.userId,
				filename: sourceFile.filename,
				mimeType: sourceFile.mimeType ?? null,
				sizeBytes: sourceFile.sizeBytes,
				storagePath,
				createdAt: sourceFile.createdAt,
			})
			.run();
		copiedFileIdBySourceId.set(sourceFile.id, copiedFileId);
	}

	const sourceJobs = params.tx
		.select()
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.userId, params.userId),
				eq(fileProductionJobs.conversationId, params.sourceConversationId),
				inArray(fileProductionJobs.assistantMessageId, params.sourceMessageIds),
			),
		)
		.orderBy(asc(fileProductionJobs.createdAt), asc(fileProductionJobs.id))
		.all();
	const nonTerminalJob = sourceJobs.find(
		(job) => !isTerminalFileProductionStatus(job.status),
	);
	if (nonTerminalJob) {
		throw new ConversationForkError(
			"required_generated_work_unavailable",
			"Fork source includes generated work that is still queued or running",
			409,
		);
	}
	const copiedJobIdBySourceId = new Map<string, string>();
	const sourceJobFileLinks =
		sourceJobs.length > 0
			? params.tx
					.select()
					.from(fileProductionJobFiles)
					.where(
						inArray(
							fileProductionJobFiles.jobId,
							sourceJobs.map((job) => job.id),
						),
					)
					.orderBy(
						asc(fileProductionJobFiles.sortOrder),
						asc(fileProductionJobFiles.id),
					)
					.all()
			: [];
	for (const sourceJob of sourceJobs) {
		const copiedJobId = randomUUID();
		copiedJobIdBySourceId.set(sourceJob.id, copiedJobId);
		params.tx
			.insert(fileProductionJobs)
			.values({
				id: copiedJobId,
				conversationId: params.forkConversationId,
				assistantMessageId: sourceJob.assistantMessageId
					? (params.copiedMessageIdBySourceId.get(
							sourceJob.assistantMessageId,
						) ?? null)
					: null,
				userId: params.userId,
				title: sourceJob.title,
				status: sourceJob.status,
				stage: sourceJob.stage,
				origin: sourceJob.origin,
				currentAttemptId: null,
				retryable: sourceJob.retryable,
				errorCode: sourceJob.errorCode,
				errorMessage: sourceJob.errorMessage,
				completedAt: sourceJob.completedAt,
				cancelRequestedAt: sourceJob.cancelRequestedAt,
				idempotencyKey: sourceJob.idempotencyKey
					? `fork:${params.forkConversationId}:${sourceJob.id}:${sourceJob.idempotencyKey}`
					: null,
				requestJson: sourceJob.requestJson,
				sourceMode: sourceJob.sourceMode,
				documentIntent: sourceJob.documentIntent,
				createdAt: sourceJob.createdAt,
				updatedAt: sourceJob.updatedAt,
			})
			.run();
	}

	for (const sourceLink of sourceJobFileLinks) {
		const copiedJobId = copiedJobIdBySourceId.get(sourceLink.jobId);
		const copiedFileId = copiedFileIdBySourceId.get(
			sourceLink.chatGeneratedFileId,
		);
		if (!copiedJobId || !copiedFileId) {
			throw new ConversationForkError(
				"required_generated_work_unavailable",
				"Fork source includes generated work whose job output is no longer available",
				409,
			);
		}
		params.tx
			.insert(fileProductionJobFiles)
			.values({
				id: randomUUID(),
				jobId: copiedJobId,
				chatGeneratedFileId: copiedFileId,
				sortOrder: sourceLink.sortOrder,
				createdAt: sourceLink.createdAt,
			})
			.run();
	}

	const sourceFileIds = new Set(sourceFiles.map((file) => file.id));
	const sourceMessageIds = new Set(params.sourceMessageIds);
	const copiedArtifactIdBySourceId = new Map<string, string>();
	const sourceGeneratedArtifacts = params.tx
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				eq(artifacts.conversationId, params.sourceConversationId),
				eq(artifacts.type, "generated_output"),
			),
		)
		.orderBy(asc(artifacts.createdAt), asc(artifacts.id))
		.all()
		.filter((artifact) => {
			const metadata = parseJsonRecord(artifact.metadataJson);
			const originalChatFileId =
				typeof metadata.originalChatFileId === "string"
					? metadata.originalChatFileId
					: null;
			const assistantMessageId =
				typeof metadata.assistantMessageId === "string"
					? metadata.assistantMessageId
					: null;
			const originAssistantMessageId =
				typeof metadata.originAssistantMessageId === "string"
					? metadata.originAssistantMessageId
					: null;
			return (
				(originalChatFileId !== null &&
					sourceFileIds.has(originalChatFileId)) ||
				(assistantMessageId !== null &&
					sourceMessageIds.has(assistantMessageId)) ||
				(originAssistantMessageId !== null &&
					sourceMessageIds.has(originAssistantMessageId))
			);
		});

	if (sourceGeneratedArtifacts.length === 0) {
		return {
			copiedArtifactIdBySourceId,
			copiedArtifacts: [],
		};
	}

	const copiedArtifacts: Artifact[] = [];
	for (const sourceArtifact of sourceGeneratedArtifacts) {
		const sourceMetadata = parseJsonRecord(sourceArtifact.metadataJson);
		const sourceOriginalChatFileId =
			typeof sourceMetadata.originalChatFileId === "string"
				? sourceMetadata.originalChatFileId
				: null;
		const sourceAssistantMessageId =
			typeof sourceMetadata.assistantMessageId === "string"
				? sourceMetadata.assistantMessageId
				: typeof sourceMetadata.originAssistantMessageId === "string"
					? sourceMetadata.originAssistantMessageId
					: null;
		const copiedChatFileId = sourceOriginalChatFileId
			? (copiedFileIdBySourceId.get(sourceOriginalChatFileId) ?? null)
			: null;
		const sourceRenderedChatFileIds = readStringArray(
			sourceMetadata.generatedDocumentRenderedChatFileIds,
		);
		const copiedRenderedChatFileIds: string[] = [];
		for (const sourceRenderedChatFileId of sourceRenderedChatFileIds) {
			const copiedRenderedChatFileId = copiedFileIdBySourceId.get(
				sourceRenderedChatFileId,
			);
			if (!copiedRenderedChatFileId) {
				throw new ConversationForkError(
					"required_generated_work_unavailable",
					"Fork source includes generated document rendered-file metadata that cannot be copied",
					409,
				);
			}
			copiedRenderedChatFileIds.push(copiedRenderedChatFileId);
		}
		const copiedAssistantMessageId = sourceAssistantMessageId
			? (params.copiedMessageIdBySourceId.get(sourceAssistantMessageId) ?? null)
			: null;
		if (sourceOriginalChatFileId && !copiedChatFileId) {
			throw new ConversationForkError(
				"required_generated_work_unavailable",
				"Fork source includes generated work whose file metadata is no longer available",
				409,
			);
		}
		if (sourceArtifact.storagePath && !copiedChatFileId) {
			throw new ConversationForkError(
				"required_generated_work_unavailable",
				"Fork source includes binary generated work that cannot be copied",
				409,
			);
		}
		const copiedArtifactId = randomUUID();
		copiedArtifactIdBySourceId.set(sourceArtifact.id, copiedArtifactId);
		const nextMetadata: JsonRecord = {
			...sourceMetadata,
			documentFamilyId: randomUUID(),
			documentFamilyStatus: "active",
			versionNumber: 1,
			originConversationId: params.forkConversationId,
			originAssistantMessageId: copiedAssistantMessageId ?? "",
			forkedFromArtifactId: sourceArtifact.id,
			forkedFromConversationId:
				typeof sourceMetadata.originConversationId === "string"
					? sourceMetadata.originConversationId
					: params.sourceConversationId,
			forkedFromAssistantMessageId:
				typeof sourceMetadata.originAssistantMessageId === "string"
					? sourceMetadata.originAssistantMessageId
					: (sourceAssistantMessageId ?? ""),
		};
		if (typeof sourceMetadata.documentFamilyId === "string") {
			nextMetadata.forkedFromDocumentFamilyId = sourceMetadata.documentFamilyId;
		}
		delete nextMetadata.supersedesArtifactId;
		delete nextMetadata.previousGeneratedArtifactId;
		delete nextMetadata.recentGeneratedVersionIds;
		if (copiedChatFileId) {
			nextMetadata.originalChatFileId = copiedChatFileId;
			nextMetadata.sourceChatFileId = copiedChatFileId;
		}
		if (copiedRenderedChatFileIds.length > 0) {
			nextMetadata.generatedDocumentRenderedChatFileIds = Array.from(
				new Set(copiedRenderedChatFileIds),
			);
		}
		if (sourceOriginalChatFileId) {
			nextMetadata.forkedFromChatFileId = sourceOriginalChatFileId;
		}
		if (copiedAssistantMessageId) {
			nextMetadata.assistantMessageId = copiedAssistantMessageId;
		}

		const [copiedArtifact] = params.tx
			.insert(artifacts)
			.values({
				id: copiedArtifactId,
				userId: params.userId,
				conversationId: params.forkConversationId,
				type: sourceArtifact.type,
				retrievalClass: sourceArtifact.retrievalClass,
				name: sourceArtifact.name,
				mimeType: sourceArtifact.mimeType,
				extension: sourceArtifact.extension,
				sizeBytes: sourceArtifact.sizeBytes,
				binaryHash: sourceArtifact.binaryHash,
				storagePath: copiedChatFileId ? null : sourceArtifact.storagePath,
				contentText: sourceArtifact.contentText,
				summary: sourceArtifact.summary,
				metadataJson: JSON.stringify(nextMetadata),
				createdAt: sourceArtifact.createdAt,
				updatedAt: sourceArtifact.updatedAt,
			})
			.returning()
			.all();
		if (copiedArtifact) {
			copiedArtifacts.push(
				mapArtifactForSemanticRefresh(copiedArtifact, nextMetadata),
			);
		}
	}

	const sourceChunks = params.tx
		.select()
		.from(artifactChunks)
		.where(
			inArray(
				artifactChunks.artifactId,
				Array.from(copiedArtifactIdBySourceId.keys()),
			),
		)
		.orderBy(asc(artifactChunks.chunkIndex), asc(artifactChunks.id))
		.all();
	if (sourceChunks.length > 0) {
		params.tx
			.insert(artifactChunks)
			.values(
				sourceChunks.map((chunk) => ({
					id: randomUUID(),
					artifactId: copiedArtifactIdBySourceId.get(chunk.artifactId) ?? "",
					userId: params.userId,
					conversationId: params.forkConversationId,
					chunkIndex: chunk.chunkIndex,
					contentText: chunk.contentText,
					tokenEstimate: chunk.tokenEstimate,
					createdAt: chunk.createdAt,
					updatedAt: chunk.updatedAt,
				})),
			)
			.run();
	}

	const sourceArtifactLinks = params.tx
		.select({ link: artifactLinks, relatedArtifact: artifacts })
		.from(artifactLinks)
		.leftJoin(artifacts, eq(artifactLinks.relatedArtifactId, artifacts.id))
		.where(
			inArray(
				artifactLinks.artifactId,
				Array.from(copiedArtifactIdBySourceId.keys()),
			),
		)
		.all();
	const linksToCopy = sourceArtifactLinks.flatMap(
		({ link, relatedArtifact }) => {
			if (link.linkType === "supersedes") return [];
			const copiedArtifactId = copiedArtifactIdBySourceId.get(link.artifactId);
			if (!copiedArtifactId) return [];
			if (
				link.messageId &&
				!params.copiedMessageIdBySourceId.has(link.messageId)
			) {
				return [];
			}
			if (
				link.messageId === null &&
				link.linkType === "attached_to_conversation" &&
				!isConversationLevelLinkVisibleAtFork(link, params.forkPointCreatedAt)
			) {
				return [];
			}
			const copiedRelatedArtifactId = link.relatedArtifactId
				? copiedArtifactIdBySourceId.get(link.relatedArtifactId)
				: null;
			const canKeepDurableRelatedArtifact =
				!copiedRelatedArtifactId &&
				relatedArtifact &&
				isDurableDocumentArtifactType(relatedArtifact.type) &&
				relatedArtifact.userId === params.userId;
			return [
				{
					id: randomUUID(),
					userId: params.userId,
					artifactId: copiedArtifactId,
					relatedArtifactId:
						copiedRelatedArtifactId ??
						(canKeepDurableRelatedArtifact ? link.relatedArtifactId : null),
					conversationId: params.forkConversationId,
					messageId: link.messageId
						? params.copiedMessageIdBySourceId.get(link.messageId)
						: null,
					linkType: link.linkType,
					createdAt: link.createdAt,
				},
			];
		},
	);
	if (linksToCopy.length > 0) {
		params.tx.insert(artifactLinks).values(linksToCopy).run();
	}

	return {
		copiedArtifactIdBySourceId,
		copiedArtifacts,
	};
}

export async function createConversationFork(
	params: CreateConversationForkParams,
): Promise<ConversationForkResult> {
	const preflight = readForkSourceSnapshot(db, params);
	const preflightSourceMessageIds = preflight.sourceMessagesToCopy.map(
		(message) => message.id,
	);
	await reconcileStaleFileProductionJobs({
		userId: params.userId,
		conversationId: preflight.sourceConversation.id,
		assistantMessageIds: preflightSourceMessageIds,
	});

	for (let attempt = 1; attempt <= MAX_FORK_SEQUENCE_ATTEMPTS; attempt += 1) {
		const stagedFilePaths: string[] = [];
		const forkConversationId = randomUUID();
		let transactionResult: {
			result: ConversationForkResult;
			copiedArtifacts: Artifact[];
		};

		try {
			const fileCopyPlans = prepareGeneratedFileCopyPlan({
				userId: params.userId,
				sourceConversationId: preflight.sourceConversation.id,
				forkConversationId,
				sourceMessageIds: preflightSourceMessageIds,
				stagedFilePaths,
			});

			transactionResult = db.transaction((tx) => {
				const { sourceConversation, sourceMessagesToCopy, forkPointMessage } =
					readForkSourceSnapshot(tx as ForkQueryExecutor, params);
				const sourceMessageIds = sourceMessagesToCopy.map(
					(message) => message.id,
				);
				const forkSequence = getNextForkSequence(tx, forkPointMessage.id);
				const now = new Date();
				const forkConversation = tx
					.insert(conversations)
					.values({
						id: forkConversationId,
						userId: params.userId,
						title: `${sourceConversation.title} (fork ${forkSequence})`,
						projectId: sourceConversation.projectId ?? null,
						status: "open",
						createdAt: now,
						updatedAt: now,
					})
					.returning()
					.get();

				const copiedMessages = tx
					.insert(messages)
					.values(
						sourceMessagesToCopy.map((sourceMessage, index) => ({
							id: randomUUID(),
							conversationId: forkConversation.id,
							messageSequence: index + 1,
							role: sourceMessage.role,
							content: sourceMessage.content,
							thinking: sourceMessage.thinking,
							toolCalls: sourceMessage.toolCalls,
							metadataJson: JSON.stringify(copyMetadata(sourceMessage, now)),
							createdAt: sourceMessage.createdAt,
						})),
					)
					.returning()
					.all();
				const copiedForkPointMessage =
					copiedMessages[copiedMessages.length - 1];
				if (!copiedForkPointMessage) {
					throw new ConversationForkError(
						"invalid_source_message",
						"Fork source did not include copyable messages",
					);
				}
				const copiedMessageIdBySourceId = new Map(
					sourceMessagesToCopy.map((sourceMessage, index) => [
						sourceMessage.id,
						copiedMessages[index]?.id ?? "",
					]),
				);
				const generatedSnapshot = copyGeneratedWorkSnapshot({
					tx,
					userId: params.userId,
					sourceConversationId: sourceConversation.id,
					forkConversationId: forkConversation.id,
					sourceMessageIds,
					copiedMessageIdBySourceId,
					forkPointCreatedAt: forkPointMessage.createdAt,
					now,
					fileCopyPlans,
				});
				copyDurableDocumentLinks({
					tx,
					userId: params.userId,
					sourceConversationId: sourceConversation.id,
					forkConversationId: forkConversation.id,
					sourceMessageIds,
					copiedMessageIdBySourceId,
					copiedGeneratedArtifactIds: new Set(
						generatedSnapshot.copiedArtifactIdBySourceId.keys(),
					),
					forkPointCreatedAt: forkPointMessage.createdAt,
					now,
				});

				const lineage = tx
					.insert(conversationForks)
					.values({
						id: randomUUID(),
						forkConversationId: forkConversation.id,
						userId: params.userId,
						sourceConversationId: sourceConversation.id,
						sourceConversationIdSnapshot: sourceConversation.id,
						sourceAssistantMessageId: forkPointMessage.id,
						sourceAssistantMessageIdSnapshot: forkPointMessage.id,
						copiedForkPointMessageId: copiedForkPointMessage.id,
						sourceTitle: sourceConversation.title,
						forkSequence,
						createdAt: now,
					})
					.onConflictDoNothing({
						target: [
							conversationForks.userId,
							conversationForks.sourceAssistantMessageIdSnapshot,
							conversationForks.forkSequence,
						],
					})
					.returning()
					.get();
				if (!lineage) {
					throw new ForkSequenceCollisionRetry();
				}

				tx.insert(memoryEvents)
					.values({
						id: randomUUID(),
						eventKey: scopeMemoryEventKey(
							params.userId,
							`conversation_fork_created:${forkConversation.id}`,
						),
						userId: params.userId,
						conversationId: forkConversation.id,
						messageId: copiedForkPointMessage.id,
						domain: "conversation",
						eventType: "conversation_fork_created",
						subjectId: forkConversation.id,
						relatedId:
							lineage.sourceConversationId ??
							lineage.sourceConversationIdSnapshot,
						observedAt: now,
						payloadJson: JSON.stringify({
							sourceConversationId:
								lineage.sourceConversationId ??
								lineage.sourceConversationIdSnapshot,
							sourceAssistantMessageId:
								lineage.sourceAssistantMessageId ??
								lineage.sourceAssistantMessageIdSnapshot,
							sourceTitle: lineage.sourceTitle,
							forkSequence: lineage.forkSequence,
							copiedForkPointMessageId: lineage.copiedForkPointMessageId,
						}),
						createdAt: now,
					})
					.onConflictDoNothing({
						target: memoryEvents.eventKey,
					})
					.run();

				return {
					result: {
						conversation: mapConversation(forkConversation),
						forkOrigin: mapForkOrigin(lineage),
					},
					copiedArtifacts: generatedSnapshot.copiedArtifacts,
				};
			});
		} catch (error) {
			cleanupStagedFiles(stagedFilePaths);
			if (
				error instanceof ForkSequenceCollisionRetry ||
				isForkSequenceUniqueConstraintError(error)
			) {
				if (attempt < MAX_FORK_SEQUENCE_ATTEMPTS) {
					continue;
				}
				throw new ConversationForkError(
					"fork_sequence_conflict",
					"Could not allocate a fork sequence after retrying concurrent fork creation",
					409,
				);
			}
			throw error;
		}

		for (const copiedArtifact of transactionResult.copiedArtifacts) {
			queueArtifactSemanticEmbeddingRefresh(copiedArtifact);
		}
		return transactionResult.result;
	}

	throw new ConversationForkError(
		"fork_sequence_conflict",
		"Could not allocate a fork sequence after retrying concurrent fork creation",
		409,
	);
}

export async function getConversationForkOrigin(
	forkConversationId: string,
): Promise<ConversationForkOrigin | null> {
	const [lineage] = await db
		.select()
		.from(conversationForks)
		.where(eq(conversationForks.forkConversationId, forkConversationId))
		.limit(1);
	return lineage ? mapForkOrigin(lineage) : null;
}

export async function listChildForksBySourceMessages(
	userId: string,
	sourceAssistantMessageIds: string[],
): Promise<Record<string, MessageSourceForks>> {
	const uniqueMessageIds = Array.from(
		new Set(sourceAssistantMessageIds),
	).filter(Boolean);
	if (uniqueMessageIds.length === 0) return {};

	const rows = await db
		.select({
			sourceAssistantMessageId: conversationForks.sourceAssistantMessageId,
			conversationId: conversationForks.forkConversationId,
			title: conversations.title,
			forkSequence: conversationForks.forkSequence,
			createdAt: conversationForks.createdAt,
		})
		.from(conversationForks)
		.innerJoin(
			conversations,
			eq(conversations.id, conversationForks.forkConversationId),
		)
		.where(
			and(
				eq(conversationForks.userId, userId),
				inArray(conversationForks.sourceAssistantMessageId, uniqueMessageIds),
			),
		)
		.orderBy(
			asc(conversationForks.sourceAssistantMessageId),
			asc(conversationForks.forkSequence),
			asc(conversationForks.createdAt),
		);

	const grouped: Record<string, MessageSourceForks> = {};
	for (const row of rows) {
		if (!row.sourceAssistantMessageId) continue;
		const group = grouped[row.sourceAssistantMessageId] ?? {
			count: 0,
			forks: [],
		};
		group.forks.push({
			conversationId: row.conversationId,
			title: row.title,
			forkSequence: row.forkSequence,
			createdAt: row.createdAt.getTime() / 1000,
		});
		group.count = group.forks.length;
		grouped[row.sourceAssistantMessageId] = group;
	}

	return grouped;
}

export async function getConversationForkSummaries(
	userId: string,
	conversationIds: string[],
): Promise<Map<string, ConversationForkListSummary>> {
	const uniqueConversationIds = Array.from(new Set(conversationIds)).filter(
		Boolean,
	);
	if (uniqueConversationIds.length === 0) return new Map();

	const rows = await db
		.select()
		.from(conversationForks)
		.where(
			and(
				eq(conversationForks.userId, userId),
				inArray(conversationForks.forkConversationId, uniqueConversationIds),
			),
		);

	return new Map(
		rows.map((row) => [row.forkConversationId, mapForkListSummary(row)]),
	);
}
