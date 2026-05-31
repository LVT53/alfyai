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
		(await readChatFileContentByConversationOwner(params.fileId, params.userId));
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
	const contentType = getPreviewContentType(chatFile.filename, chatFile.mimeType);
	const isHtmlPreview = params.mode === "preview" && contentType === "text/html";
	const headers: Record<string, string> = {
		"Content-Type": isHtmlPreview ? "text/html; charset=utf-8" : contentType,
		"Content-Length": fileContent.length.toString(),
		"Content-Disposition":
			params.mode === "preview"
				? `inline; filename="${encodeURIComponent(filename)}"`
				: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
		"Cache-Control":
			params.mode === "preview" ? "private, max-age=3600" : "private, no-store",
	};
	if (isHtmlPreview) {
		headers["Content-Security-Policy"] =
			"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
		headers["X-Content-Type-Options"] = "nosniff";
		headers["Referrer-Policy"] = "no-referrer";
	}

	return {
		ok: true,
		body: new Uint8Array(fileContent),
		headers,
	};
}
