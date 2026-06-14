import {
	getChatFileByConversationOwner,
	getChatFileByUser,
	readChatFileContentByConversationOwner,
	readChatFileContentByUser,
} from "$lib/server/services/chat-files";
import {
	isGeneratedFileTypeAllowed,
	validateGeneratedOutputFile,
} from "$lib/server/services/file-production/output-validation";
import { hasSucceededFileProductionJobForChatFile } from "$lib/server/services/file-production/read-model";
import { buildFileServingResponseHeaders } from "$lib/server/services/file-serving-response-policy";
import { getPreviewContentType } from "$lib/utils/file-preview";

export type GeneratedFileServingMode = "preview" | "download";

export interface GeneratedFileServingSuccess {
	ok: true;
	body: Uint8Array;
	headers: Record<string, string>;
}

export interface GeneratedFileServingError {
	ok: false;
	status: number;
	error: string;
}

export type GeneratedFileServingResult =
	| GeneratedFileServingSuccess
	| GeneratedFileServingError;

export async function resolveGeneratedFileServing(params: {
	userId: string;
	fileId: string;
	mode: GeneratedFileServingMode;
	displayFilename?: string | null;
}): Promise<GeneratedFileServingResult> {
	const chatFile =
		(await getChatFileByUser(params.fileId, params.userId)) ??
		(await getChatFileByConversationOwner(params.fileId, params.userId));
	if (!chatFile) {
		return { ok: false, status: 404, error: "File not found" };
	}

	if (
		chatFile.assistantMessageId === null &&
		!(await hasSucceededFileProductionJobForChatFile({
			userId: params.userId,
			conversationId: chatFile.conversationId,
			chatGeneratedFileId: chatFile.id,
		}))
	) {
		return { ok: false, status: 404, error: "File not found" };
	}

	if (!isGeneratedFileTypeAllowed(chatFile.filename, chatFile.mimeType)) {
		return {
			ok: false,
			status: 415,
			error: "Unsupported generated file type",
		};
	}

	const fileContent =
		(await readChatFileContentByUser(params.fileId, params.userId)) ??
		(await readChatFileContentByConversationOwner(
			params.fileId,
			params.userId,
		));
	if (!fileContent) {
		return {
			ok: false,
			status: 500,
			error: "Failed to read file content",
		};
	}

	const contentValidation = await validateGeneratedOutputFile({
		filename: chatFile.filename,
		mimeType: chatFile.mimeType,
		content: fileContent,
	});
	if (!contentValidation.ok) {
		return {
			ok: false,
			status: 415,
			error: "Invalid generated file content",
		};
	}

	const filename = params.displayFilename || chatFile.filename;
	const contentType = getPreviewContentType(
		chatFile.filename,
		chatFile.mimeType,
	);

	return {
		ok: true,
		body: new Uint8Array(fileContent),
		headers: buildFileServingResponseHeaders({
			mode: params.mode,
			contentLength: fileContent.length,
			contentType,
			filename,
			safetyFilenames: [chatFile.filename],
		}),
	};
}
