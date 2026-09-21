import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	fileProductionJobFiles,
	fileProductionJobs,
} from "$lib/server/db/schema";
import type {
	ChatGeneratedFile,
	FileProductionJob,
} from "$lib/server/services/file-production/types";
import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store/document-metadata";
import { parseJsonRecord } from "$lib/server/utils/json";

const GENERATED_DOCUMENT_RENDERED_CHAT_FILE_IDS_KEY =
	"generatedDocumentRenderedChatFileIds";

type ReadModelChatFile = {
	id: string;
	conversationId: string;
	assistantMessageId: string | null;
	artifactId: string | null;
	documentFamilyId?: string | null;
	documentFamilyStatus?: "active" | "historical" | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	userId: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	storagePath: string;
	createdAt: number;
};

type ChatGeneratedFileReadModelRow = {
	id: string;
	conversationId: string;
	assistantMessageId: string | null;
	userId: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	storagePath: string;
	createdAt: Date;
};

const chatGeneratedFileSelection = {
	id: chatGeneratedFiles.id,
	conversationId: chatGeneratedFiles.conversationId,
	assistantMessageId: chatGeneratedFiles.assistantMessageId,
	userId: chatGeneratedFiles.userId,
	filename: chatGeneratedFiles.filename,
	mimeType: chatGeneratedFiles.mimeType,
	sizeBytes: chatGeneratedFiles.sizeBytes,
	storagePath: chatGeneratedFiles.storagePath,
	createdAt: chatGeneratedFiles.createdAt,
} as const;

function legacyJobId(fileId: string): string {
	return `legacy-file:${fileId}`;
}

function legacyJobFileLinkId(fileId: string): string {
	return `legacy-file-link:${fileId}`;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function mapRowToReadModelChatFile(
	row: ChatGeneratedFileReadModelRow,
): ReadModelChatFile {
	return {
		id: row.id,
		conversationId: row.conversationId,
		assistantMessageId: row.assistantMessageId ?? null,
		artifactId: null,
		userId: row.userId,
		filename: row.filename,
		mimeType: row.mimeType ?? null,
		sizeBytes: row.sizeBytes,
		storagePath: row.storagePath,
		createdAt: row.createdAt.getTime(),
	};
}

async function listGeneratedOutputArtifactIdsByChatFile(
	conversationId: string,
): Promise<
	Map<
		string,
		{
			artifactId: string;
			documentFamilyId: string | null;
			documentFamilyStatus: "active" | "historical" | null;
			documentLabel: string | null;
			documentRole: string | null;
			versionNumber: number | null;
			originConversationId: string | null;
			originAssistantMessageId: string | null;
			sourceChatFileId: string | null;
		}
	>
> {
	const rows = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.conversationId, conversationId),
				eq(artifacts.type, "generated_output"),
			),
		)
		.orderBy(desc(artifacts.updatedAt));

	const artifactIdsByChatFile = new Map<
		string,
		{
			artifactId: string;
			documentFamilyId: string | null;
			documentFamilyStatus: "active" | "historical" | null;
			documentLabel: string | null;
			documentRole: string | null;
			versionNumber: number | null;
			originConversationId: string | null;
			originAssistantMessageId: string | null;
			sourceChatFileId: string | null;
		}
	>();
	for (const row of rows) {
		const metadata = parseJsonRecord(row.metadataJson ?? null);
		const chatFileId =
			typeof metadata?.originalChatFileId === "string" &&
			metadata.originalChatFileId.trim()
				? metadata.originalChatFileId.trim()
				: null;
		const renderedChatFileIds = readStringArray(
			metadata?.[GENERATED_DOCUMENT_RENDERED_CHAT_FILE_IDS_KEY],
		);
		const chatFileIds = Array.from(
			new Set(
				[chatFileId, ...renderedChatFileIds].filter((id): id is string =>
					Boolean(id),
				),
			),
		);
		if (chatFileIds.length === 0) continue;

		const documentMetadata = parseWorkingDocumentMetadata(metadata);
		for (const id of chatFileIds) {
			if (artifactIdsByChatFile.has(id)) {
				continue;
			}
			artifactIdsByChatFile.set(id, {
				artifactId: row.id,
				documentFamilyId: documentMetadata.documentFamilyId ?? null,
				documentFamilyStatus: documentMetadata.documentFamilyStatus ?? null,
				documentLabel: documentMetadata.documentLabel ?? null,
				documentRole: documentMetadata.documentRole ?? null,
				versionNumber:
					typeof documentMetadata.versionNumber === "number" &&
					Number.isFinite(documentMetadata.versionNumber)
						? Math.trunc(documentMetadata.versionNumber)
						: null,
				originConversationId: documentMetadata.originConversationId ?? null,
				originAssistantMessageId:
					documentMetadata.originAssistantMessageId ?? null,
				sourceChatFileId: renderedChatFileIds.includes(id)
					? id
					: (documentMetadata.sourceChatFileId ?? null),
			});
		}
	}

	return artifactIdsByChatFile;
}

async function listConversationReadModelChatFiles(
	conversationId: string,
): Promise<ReadModelChatFile[]> {
	const [rows, artifactIdsByChatFile] = await Promise.all([
		db
			.select(chatGeneratedFileSelection)
			.from(chatGeneratedFiles)
			.where(
				and(
					eq(chatGeneratedFiles.conversationId, conversationId),
					isNotNull(chatGeneratedFiles.assistantMessageId),
				),
			)
			.orderBy(desc(chatGeneratedFiles.createdAt)),
		listGeneratedOutputArtifactIdsByChatFile(conversationId),
	]);

	return rows.map((row) => ({
		...mapRowToReadModelChatFile(row),
		artifactId: artifactIdsByChatFile.get(row.id)?.artifactId ?? null,
		documentFamilyId:
			artifactIdsByChatFile.get(row.id)?.documentFamilyId ?? null,
		documentFamilyStatus:
			artifactIdsByChatFile.get(row.id)?.documentFamilyStatus ?? null,
		documentLabel: artifactIdsByChatFile.get(row.id)?.documentLabel ?? null,
		documentRole: artifactIdsByChatFile.get(row.id)?.documentRole ?? null,
		versionNumber: artifactIdsByChatFile.get(row.id)?.versionNumber ?? null,
		originConversationId:
			artifactIdsByChatFile.get(row.id)?.originConversationId ?? null,
		originAssistantMessageId:
			artifactIdsByChatFile.get(row.id)?.originAssistantMessageId ?? null,
		sourceChatFileId:
			artifactIdsByChatFile.get(row.id)?.sourceChatFileId ?? null,
	}));
}

function mapChatFileToGeneratedFile(
	file: ReadModelChatFile,
): ChatGeneratedFile {
	return {
		id: file.id,
		conversationId: file.conversationId,
		assistantMessageId: file.assistantMessageId,
		artifactId: file.artifactId,
		documentFamilyId: file.documentFamilyId,
		documentFamilyStatus: file.documentFamilyStatus,
		documentLabel: file.documentLabel,
		documentRole: file.documentRole,
		versionNumber: file.versionNumber,
		originConversationId: file.originConversationId,
		originAssistantMessageId: file.originAssistantMessageId,
		sourceChatFileId: file.sourceChatFileId,
		filename: file.filename,
		mimeType: file.mimeType,
		sizeBytes: file.sizeBytes,
		createdAt: file.createdAt,
	};
}

export async function listConversationGeneratedFiles(
	conversationId: string,
): Promise<ChatGeneratedFile[]> {
	return (await listConversationReadModelChatFiles(conversationId)).map(
		mapChatFileToGeneratedFile,
	);
}

export async function hasSucceededFileProductionJobForChatFile(input: {
	userId: string;
	conversationId: string;
	chatGeneratedFileId: string;
}): Promise<boolean> {
	return Boolean(await getSucceededFileProductionJobForChatFile(input));
}

export async function getSucceededFileProductionJobForChatFile(input: {
	userId: string;
	conversationId: string;
	chatGeneratedFileId: string;
}): Promise<{
	id: string;
	sourceMode: string | null;
	origin: string;
} | null> {
	const [row] = await db
		.select({
			id: fileProductionJobs.id,
			sourceMode: fileProductionJobs.sourceMode,
			origin: fileProductionJobs.origin,
		})
		.from(fileProductionJobFiles)
		.innerJoin(
			fileProductionJobs,
			eq(fileProductionJobs.id, fileProductionJobFiles.jobId),
		)
		.where(
			and(
				eq(
					fileProductionJobFiles.chatGeneratedFileId,
					input.chatGeneratedFileId,
				),
				eq(fileProductionJobs.userId, input.userId),
				eq(fileProductionJobs.conversationId, input.conversationId),
				eq(fileProductionJobs.status, "succeeded"),
			),
		)
		.limit(1);

	return row ?? null;
}

async function getReadModelChatFilesByIdsForConversation(
	conversationId: string,
	fileIds: string[],
): Promise<ReadModelChatFile[]> {
	const uniqueFileIds = Array.from(new Set(fileIds.filter(Boolean)));
	if (uniqueFileIds.length === 0) {
		return [];
	}

	const [rows, artifactIdsByChatFile] = await Promise.all([
		db
			.select(chatGeneratedFileSelection)
			.from(chatGeneratedFiles)
			.where(
				and(
					eq(chatGeneratedFiles.conversationId, conversationId),
					inArray(chatGeneratedFiles.id, uniqueFileIds),
				),
			)
			.orderBy(desc(chatGeneratedFiles.createdAt)),
		listGeneratedOutputArtifactIdsByChatFile(conversationId),
	]);

	return rows.map((row) => ({
		...mapRowToReadModelChatFile(row),
		artifactId: artifactIdsByChatFile.get(row.id)?.artifactId ?? null,
		documentFamilyId:
			artifactIdsByChatFile.get(row.id)?.documentFamilyId ?? null,
		documentFamilyStatus:
			artifactIdsByChatFile.get(row.id)?.documentFamilyStatus ?? null,
		documentLabel: artifactIdsByChatFile.get(row.id)?.documentLabel ?? null,
		documentRole: artifactIdsByChatFile.get(row.id)?.documentRole ?? null,
		versionNumber: artifactIdsByChatFile.get(row.id)?.versionNumber ?? null,
		originConversationId:
			artifactIdsByChatFile.get(row.id)?.originConversationId ?? null,
		originAssistantMessageId:
			artifactIdsByChatFile.get(row.id)?.originAssistantMessageId ?? null,
		sourceChatFileId:
			artifactIdsByChatFile.get(row.id)?.sourceChatFileId ?? null,
	}));
}

async function ensureLegacyJobs(files: ReadModelChatFile[]): Promise<void> {
	const legacyFiles = files.filter((file) => file.assistantMessageId);
	if (legacyFiles.length === 0) {
		return;
	}

	const fileIds = legacyFiles.map((file) => file.id);
	const existingLinks = await db
		.select({ chatGeneratedFileId: fileProductionJobFiles.chatGeneratedFileId })
		.from(fileProductionJobFiles)
		.where(inArray(fileProductionJobFiles.chatGeneratedFileId, fileIds));
	const linkedFileIds = new Set(
		existingLinks.map((link) => link.chatGeneratedFileId),
	);
	const missingFiles = legacyFiles.filter(
		(file) => !linkedFileIds.has(file.id),
	);

	for (const file of missingFiles) {
		const createdAt = new Date(file.createdAt);
		await db
			.insert(fileProductionJobs)
			.values({
				id: legacyJobId(file.id),
				conversationId: file.conversationId,
				assistantMessageId: file.assistantMessageId,
				userId: file.userId,
				title: file.documentLabel ?? file.filename,
				status: "succeeded",
				stage: null,
				origin: "legacy_generated_file",
				createdAt,
				updatedAt: createdAt,
			})
			.onConflictDoNothing({ target: fileProductionJobs.id });

		await db
			.insert(fileProductionJobFiles)
			.values({
				id: legacyJobFileLinkId(file.id),
				jobId: legacyJobId(file.id),
				chatGeneratedFileId: file.id,
				sortOrder: 0,
				createdAt,
			})
			.onConflictDoNothing({
				target: fileProductionJobFiles.chatGeneratedFileId,
			});
	}
}

function mapChatFileToProducedFile(
	file: ReadModelChatFile,
): FileProductionJob["files"][number] {
	return {
		id: file.id,
		filename: file.filename,
		mimeType: file.mimeType,
		sizeBytes: file.sizeBytes,
		downloadUrl: `/api/chat/files/${file.id}/download`,
		previewUrl: `/api/chat/files/${file.id}/preview`,
		artifactId: file.artifactId,
		documentFamilyId: file.documentFamilyId,
		documentFamilyStatus: file.documentFamilyStatus,
		documentLabel: file.documentLabel,
		documentRole: file.documentRole,
		versionNumber: file.versionNumber,
		originConversationId: file.originConversationId,
		originAssistantMessageId: file.originAssistantMessageId,
		sourceChatFileId: file.sourceChatFileId,
	};
}

function mapError(
	job: typeof fileProductionJobs.$inferSelect,
): FileProductionJob["error"] {
	if (!job.errorCode && !job.errorMessage) {
		return null;
	}

	return {
		code: job.errorCode ?? "file_production_error",
		message: job.errorMessage ?? "File production failed.",
		retryable: Boolean(job.retryable),
	};
}

function mapJobRow(
	job: typeof fileProductionJobs.$inferSelect,
	files: FileProductionJob["files"],
): FileProductionJob {
	return {
		id: job.id,
		conversationId: job.conversationId,
		assistantMessageId: job.assistantMessageId,
		title: job.title,
		status: job.status as FileProductionJob["status"],
		stage: job.stage,
		createdAt: job.createdAt.getTime(),
		updatedAt: job.updatedAt.getTime(),
		files,
		warnings: [],
		dismissed: Boolean(job.dismissed),
		error: mapError(job),
		sourceMode: job.sourceMode,
	};
}

export async function listConversationFileProductionJobs(
	userId: string,
	conversationId: string,
	options: { includeDismissed?: boolean } = {},
): Promise<FileProductionJob[]> {
	const includeDismissed = options.includeDismissed ?? false;
	const files = await listConversationReadModelChatFiles(conversationId);
	const userFiles = files.filter((file) => file.userId === userId);
	await ensureLegacyJobs(userFiles);
	const jobs = await db
		.select()
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.userId, userId),
				eq(fileProductionJobs.conversationId, conversationId),
				...(includeDismissed ? [] : [eq(fileProductionJobs.dismissed, false)]),
			),
		)
		.orderBy(desc(fileProductionJobs.createdAt));

	if (jobs.length === 0) {
		return [];
	}

	const links = await db
		.select()
		.from(fileProductionJobFiles)
		.where(
			inArray(
				fileProductionJobFiles.jobId,
				jobs.map((job) => job.id),
			),
		);
	const linksByJobId = new Map<string, typeof links>();
	for (const link of links) {
		const next = linksByJobId.get(link.jobId) ?? [];
		next.push(link);
		linksByJobId.set(link.jobId, next);
	}
	const linkedFileIds = Array.from(
		new Set(links.map((link) => link.chatGeneratedFileId)),
	);
	const linkedFiles = (
		await getReadModelChatFilesByIdsForConversation(
			conversationId,
			linkedFileIds,
		)
	).filter((file) => file.userId === userId);

	const fileById = new Map(
		[...userFiles, ...linkedFiles].map((file) => [file.id, file]),
	);

	return jobs
		.map((job) => {
			const jobLinks = (linksByJobId.get(job.id) ?? []).sort(
				(a, b) => a.sortOrder - b.sortOrder,
			);
			return mapJobRow(
				job,
				jobLinks
					.map((link) => fileById.get(link.chatGeneratedFileId))
					.filter((file): file is ReadModelChatFile => Boolean(file))
					.map(mapChatFileToProducedFile),
			);
		})
		.filter((job) => job.files.length > 0 || job.status !== "succeeded");
}

// Single-job read for callers that are POLLING one known job (the chat tool's
// in-turn wait, Atlas's output step) rather than projecting the whole
// conversation. listConversationFileProductionJobs above lists every chat file
// in the conversation and backfills legacy job rows on the way; doing that once
// per poll would be absurd, so this one goes straight at the job row and only
// resolves the files it is actually linked to.
export async function getConversationFileProductionJob(input: {
	userId: string;
	conversationId: string;
	jobId: string;
}): Promise<FileProductionJob | null> {
	const [job] = await db
		.select()
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.id, input.jobId),
				eq(fileProductionJobs.userId, input.userId),
				eq(fileProductionJobs.conversationId, input.conversationId),
			),
		)
		.limit(1);

	if (!job) {
		return null;
	}

	const links = await db
		.select()
		.from(fileProductionJobFiles)
		.where(eq(fileProductionJobFiles.jobId, job.id));
	if (links.length === 0) {
		return mapJobRow(job, []);
	}

	const files = (
		await getReadModelChatFilesByIdsForConversation(
			input.conversationId,
			links.map((link) => link.chatGeneratedFileId),
		)
	).filter((file) => file.userId === input.userId);
	const fileById = new Map(files.map((file) => [file.id, file]));

	return mapJobRow(
		job,
		[...links]
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map((link) => fileById.get(link.chatGeneratedFileId))
			.filter((file): file is ReadModelChatFile => Boolean(file))
			.map(mapChatFileToProducedFile),
	);
}

/** A job that has no deliverable yet: still being produced, or failed. */
export interface FileProductionJobState {
	id: string;
	title: string;
	status: FileProductionJob["status"];
	errorCode: string | null;
	errorMessage: string | null;
	retryable: boolean;
	updatedAt: number;
}

export const FILE_PRODUCTION_UNDELIVERED_JOB_STATUSES = [
	"queued",
	"running",
	"failed",
] as const;

/** Age bound on the prompt-context projection. `reconcileStaleFileProduction-
 * Jobs` is the only thing that ever retires an abandoned `queued`/`running`
 * row, and it runs on conversation fork — NOT on the chat turn. Without a
 * bound, one job whose worker died mid-run would be injected into every
 * prompt of that conversation forever, telling the model to correct a claim
 * that is by then months stale. A day is far longer than the 10-minute
 * staleness window a live worker is reconciled against, so nothing that is
 * genuinely in flight is ever hidden by this. */
export const FILE_PRODUCTION_JOB_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Status-only projection for prompt context: no chat-file join, no legacy
// backfill, no file hydration — just enough to tell a later turn that a file it
// already claimed to have made is still running or has failed. Succeeded jobs
// are deliberately excluded: their files are already listed under
// "Conversation Files".
export async function listConversationFileProductionJobStates(input: {
	userId: string;
	conversationId: string;
	limit?: number;
	maxAgeMs?: number;
	now?: Date;
}): Promise<FileProductionJobState[]> {
	const now = input.now ?? new Date();
	const createdAfter = new Date(
		now.getTime() -
			Math.max(0, input.maxAgeMs ?? FILE_PRODUCTION_JOB_STATE_MAX_AGE_MS),
	);
	const rows = await db
		.select({
			id: fileProductionJobs.id,
			title: fileProductionJobs.title,
			status: fileProductionJobs.status,
			errorCode: fileProductionJobs.errorCode,
			errorMessage: fileProductionJobs.errorMessage,
			retryable: fileProductionJobs.retryable,
			updatedAt: fileProductionJobs.updatedAt,
		})
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.userId, input.userId),
				eq(fileProductionJobs.conversationId, input.conversationId),
				eq(fileProductionJobs.dismissed, false),
				// Same leading columns as file_production_jobs_conversation_idx
				// (conversation_id, created_at), so the bound narrows the index
				// range instead of forcing a scan.
				gte(fileProductionJobs.createdAt, createdAfter),
				inArray(
					fileProductionJobs.status,
					FILE_PRODUCTION_UNDELIVERED_JOB_STATUSES as unknown as string[],
				),
			),
		)
		.orderBy(desc(fileProductionJobs.createdAt))
		.limit(Math.max(1, input.limit ?? 5));

	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		status: row.status as FileProductionJob["status"],
		errorCode: row.errorCode ?? null,
		errorMessage: row.errorMessage ?? null,
		retryable: Boolean(row.retryable),
		updatedAt: row.updatedAt.getTime(),
	}));
}
