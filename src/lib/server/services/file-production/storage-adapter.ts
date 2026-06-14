import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { fileProductionJobs, messages } from "$lib/server/db/schema";
import {
	type ChatFile,
	type FileInput,
	storeGeneratedFile as storeChatGeneratedFile,
	syncGeneratedFilesToMemory as syncChatGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store/document-metadata";
import type { Artifact, FileProductionJob } from "$lib/types";
import type {
	ParsedFileProductionJobRequest,
	ProgramExecutionResult,
} from "./execution-adapter";
import {
	type FileProductionLimits,
	getFileProductionLimits,
	validateFileProductionOutputLimits,
} from "./limits";
import { validateProgramOutputContract } from "./output-validation";
import { attachGeneratedDocumentSourceArtifactToRenderedFiles } from "./source-persistence";

export type StoreGeneratedFileDependency = (
	conversationId: string,
	userId: string,
	file: FileInput,
) => Promise<ChatFile>;

export type SyncGeneratedFilesToMemoryDependency =
	typeof syncChatGeneratedFilesToMemory;

interface FileProductionStorageJobContext {
	id: string;
	userId: string;
	conversationId: string;
	assistantMessageId: string | null;
}

export interface StoreFileProductionOutputsInput {
	job: FileProductionStorageJobContext;
	attemptId: string;
	request: ParsedFileProductionJobRequest;
	executionResult: ProgramExecutionResult;
	sourceArtifact: Artifact | null;
	now: Date;
	storeGeneratedFile?: StoreGeneratedFileDependency;
	limits?: Partial<FileProductionLimits>;
}

export type StoreFileProductionOutputsResult =
	| {
			ok: true;
			producedFiles: FileProductionJob["files"];
	  }
	| {
			ok: false;
			errorCode: string;
			errorMessage: string;
			retryable: boolean;
			diagnostics?: unknown;
	  };

export interface SyncFileProductionOutputsToMemoryInput {
	job: FileProductionStorageJobContext;
	producedFiles: FileProductionJob["files"];
	syncGeneratedFilesToMemory?: SyncGeneratedFilesToMemoryDependency;
}

async function getAssistantMessageContent(
	assistantMessageId: string,
): Promise<string> {
	const [message] = await db
		.select({ content: messages.content })
		.from(messages)
		.where(eq(messages.id, assistantMessageId))
		.limit(1);

	return message?.content ?? "";
}

function getProducedFileSizeBytes(
	file: ProgramExecutionResult["files"][number],
) {
	return Buffer.isBuffer(file.content)
		? file.content.length
		: Buffer.byteLength(file.content);
}

function mapChatFileToProducedFile(
	file: ChatFile,
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

function mapChatFileToSourceProducedFile(
	file: ChatFile,
	sourceArtifact: Artifact,
): FileProductionJob["files"][number] {
	const metadata = parseWorkingDocumentMetadata(sourceArtifact.metadata);
	return {
		...mapChatFileToProducedFile(file),
		artifactId: sourceArtifact.id,
		documentFamilyId: metadata.documentFamilyId ?? sourceArtifact.id,
		documentFamilyStatus: metadata.documentFamilyStatus ?? "active",
		documentLabel: metadata.documentLabel ?? sourceArtifact.name,
		documentRole: metadata.documentRole ?? null,
		versionNumber: metadata.versionNumber ?? 1,
		originConversationId:
			metadata.originConversationId ?? sourceArtifact.conversationId,
		originAssistantMessageId: metadata.originAssistantMessageId ?? null,
		sourceChatFileId: file.id,
	};
}

export async function storeFileProductionOutputs(
	input: StoreFileProductionOutputsInput,
): Promise<StoreFileProductionOutputsResult> {
	if (input.executionResult.files.length === 0) {
		return {
			ok: false,
			errorCode: "program_no_outputs",
			errorMessage: "The program finished without producing files.",
			retryable: false,
		};
	}

	const effectiveLimits = {
		...getFileProductionLimits(),
		...(input.limits ?? {}),
	};
	const outputLimit = validateFileProductionOutputLimits({
		fileSizes: input.executionResult.files.map(getProducedFileSizeBytes),
		limits: effectiveLimits,
	});
	if (!outputLimit.ok) {
		console.warn("[FILE_PRODUCTION] Output limit failed", {
			jobId: input.job.id,
			attemptId: input.attemptId,
			code: outputLimit.code,
			limit: outputLimit.limit,
			actual: outputLimit.actual,
			unit: outputLimit.unit,
		});
		return {
			ok: false,
			errorCode: outputLimit.code,
			errorMessage: outputLimit.message,
			retryable: outputLimit.retryable,
			diagnostics: {
				limit: outputLimit.limit,
				actual: outputLimit.actual,
				unit: outputLimit.unit,
			},
		};
	}

	if (input.request.sourceMode === "program") {
		const outputContract = await validateProgramOutputContract({
			files: input.executionResult.files,
			programFilename: input.request.filename,
			requestedOutputTypes: input.request.outputs,
		});
		if (!outputContract.ok) {
			return {
				ok: false,
				errorCode: outputContract.code,
				errorMessage: outputContract.message,
				retryable: outputContract.retryable,
			};
		}
	}

	const storeGeneratedFile = input.storeGeneratedFile ?? storeChatGeneratedFile;
	const storedFiles: ChatFile[] = [];
	try {
		for (const file of input.executionResult.files) {
			const filename =
				input.request.sourceMode === "program" &&
				input.request.filename &&
				input.executionResult.files.length === 1
					? input.request.filename
					: file.filename;
			const storedFile = await storeGeneratedFile(
				input.job.conversationId,
				input.job.userId,
				{
					assistantMessageId: null,
					filename,
					mimeType: file.mimeType,
					content: Buffer.isBuffer(file.content)
						? file.content
						: Buffer.from(file.content),
				},
			);
			storedFiles.push(storedFile);
		}
	} catch (error) {
		return {
			ok: false,
			errorCode: "program_output_storage_failed",
			errorMessage:
				error instanceof Error
					? error.message
					: "Program output storage failed.",
			retryable: true,
		};
	}

	let sourceArtifact = input.sourceArtifact;
	if (sourceArtifact && storedFiles.length > 0) {
		sourceArtifact =
			(await attachGeneratedDocumentSourceArtifactToRenderedFiles({
				artifactId: sourceArtifact.id,
				renderedChatFileIds: storedFiles.map((file) => file.id),
			})) ?? sourceArtifact;
	}

	const producedFiles: FileProductionJob["files"] = sourceArtifact
		? storedFiles.map((file) =>
				mapChatFileToSourceProducedFile(file, sourceArtifact),
			)
		: storedFiles.map(mapChatFileToProducedFile);

	return { ok: true, producedFiles };
}

async function resolveAssistantMessageId(
	jobId: string,
): Promise<string | null> {
	const [refreshed] = await db
		.select({
			assistantMessageId: fileProductionJobs.assistantMessageId,
		})
		.from(fileProductionJobs)
		.where(eq(fileProductionJobs.id, jobId))
		.limit(1);
	return refreshed?.assistantMessageId ?? null;
}

export async function syncFileProductionOutputsToMemory(
	input: SyncFileProductionOutputsToMemoryInput,
): Promise<void> {
	if (input.producedFiles.length === 0) {
		return;
	}

	let assistantMessageId = input.job.assistantMessageId;

	if (!assistantMessageId) {
		assistantMessageId = await resolveAssistantMessageId(input.job.id);
	}

	if (!assistantMessageId) {
		console.info(
			"[FILE_PRODUCTION] Skipping memory sync — assistant message not yet assigned, stream completion will handle it",
			{ jobId: input.job.id },
		);
		return;
	}

	const syncGeneratedFilesToMemory =
		input.syncGeneratedFilesToMemory ?? syncChatGeneratedFilesToMemory;
	try {
		await syncGeneratedFilesToMemory({
			userId: input.job.userId,
			conversationId: input.job.conversationId,
			assistantMessageId,
			fileIds: input.producedFiles.map((file) => file.id),
			assistantResponse: await getAssistantMessageContent(assistantMessageId),
		});
	} catch (error) {
		console.error(
			"[FILE_PRODUCTION] Background generated-file memory sync failed",
			{
				jobId: input.job.id,
				assistantMessageId,
				fileIds: input.producedFiles.map((file) => file.id),
				error,
			},
		);
	}
}
