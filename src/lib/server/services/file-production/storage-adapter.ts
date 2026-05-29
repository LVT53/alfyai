import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import {
	type ChatFile,
	type FileInput,
	storeGeneratedFile as storeChatGeneratedFile,
	syncGeneratedFilesToMemory as syncChatGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import type { Artifact, FileProductionJob } from "$lib/types";
import type {
	ParsedFileProductionJobRequest,
	ProgramExecutionResult,
} from "./execution-adapter";
import {
	mapChatFileToProducedFile,
	mapChatFileToSourceProducedFile,
} from "./job-ledger";
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

export async function syncFileProductionOutputsToMemory(
	input: SyncFileProductionOutputsToMemoryInput,
): Promise<void> {
	if (!input.job.assistantMessageId || input.producedFiles.length === 0) {
		return;
	}

	const syncGeneratedFilesToMemory =
		input.syncGeneratedFilesToMemory ?? syncChatGeneratedFilesToMemory;
	try {
		await syncGeneratedFilesToMemory({
			userId: input.job.userId,
			conversationId: input.job.conversationId,
			assistantMessageId: input.job.assistantMessageId,
			fileIds: input.producedFiles.map((file) => file.id),
			assistantResponse: await getAssistantMessageContent(
				input.job.assistantMessageId,
			),
		});
	} catch (error) {
		console.error(
			"[FILE_PRODUCTION] Background generated-file memory sync failed",
			{
				jobId: input.job.id,
				assistantMessageId: input.job.assistantMessageId,
				fileIds: input.producedFiles.map((file) => file.id),
				error,
			},
		);
	}
}
