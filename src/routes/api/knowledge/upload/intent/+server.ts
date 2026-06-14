import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { createAttachmentTraceId } from "$lib/server/services/attachment-trace";
import {
	isKnowledgeUploadConversationError,
	resolveKnowledgeUploadLimits,
	validateKnowledgeUploadConversation,
} from "$lib/server/services/knowledge/upload-intake";
import type { RequestHandler } from "./$types";

function formatBytes(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "unlimited";
	const mb = value / (1024 * 1024);
	return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

function parseUploadIntent(value: unknown): {
	fileName: string | null;
	fileSize: number | null;
	mimeType: string | null;
	conversationId: string | null;
} {
	const input =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	const fileName =
		typeof input.fileName === "string" && input.fileName.trim()
			? input.fileName.trim().slice(0, 240)
			: null;
	const fileSize =
		typeof input.fileSize === "number" &&
		Number.isFinite(input.fileSize) &&
		input.fileSize >= 0
			? Math.floor(input.fileSize)
			: null;
	const mimeType =
		typeof input.mimeType === "string" && input.mimeType.trim()
			? input.mimeType.trim().slice(0, 120)
			: null;
	const conversationId =
		typeof input.conversationId === "string" && input.conversationId.trim()
			? input.conversationId.trim().slice(0, 120)
			: null;
	return { fileName, fileSize, mimeType, conversationId };
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const traceId = createAttachmentTraceId("upload");
	const limits = resolveKnowledgeUploadLimits();
	const requestBodyLimit = limits.multipartBodyLimit;
	const rawUploadLimit = limits.storedFileLimit;
	const chunkBodyLimit = limits.chunkBodyLimit;

	let payload: unknown;
	try {
		payload = await event.request.json();
	} catch {
		return json({ error: "Invalid upload intent payload" }, { status: 400 });
	}

	const intent = parseUploadIntent(payload);
	console.info("[KNOWLEDGE] Upload intent received", {
		traceId,
		userId: user.id,
		fileName: intent.fileName,
		fileSize: intent.fileSize,
		mimeType: intent.mimeType,
		conversationId: intent.conversationId,
		maxFileUploadSize: limits.maxFileUploadSize,
		adapterBodySizeLimit: limits.adapterBodySizeLimit,
		requestBodyLimit,
		rawUploadLimit,
		chunkBodyLimit,
	});

	if (intent.fileSize === null) {
		return json(
			{
				error: "Upload size is required before sending the file.",
				code: "upload_size_required",
				traceId,
			},
			{ status: 400 },
		);
	}

	if (intent.fileSize > limits.maxFileUploadSize) {
		return json(
			{
				error: `File too large. Maximum size is ${formatBytes(limits.maxFileUploadSize)}.`,
				code: "upload_file_too_large",
				errorKey: "knowledge.uploadFileTooLarge",
				traceId,
				details: {
					fileName: intent.fileName,
					fileSize: intent.fileSize,
					maxFileUploadSize: limits.maxFileUploadSize,
				},
			},
			{ status: 413 },
		);
	}

	try {
		await validateKnowledgeUploadConversation({
			userId: user.id,
			conversationId: intent.conversationId,
		});
	} catch (error) {
		if (isKnowledgeUploadConversationError(error)) {
			return json(
				{
					error: "Conversation not found or access denied",
					code: "conversation_not_found",
					traceId,
				},
				{ status: 400 },
			);
		}
		throw error;
	}

	return json({
		traceId,
		maxFileUploadSize: limits.maxFileUploadSize,
		adapterBodySizeLimit: limits.adapterBodySizeLimit,
		requestBodyLimit,
		rawUploadLimit,
		chunkBodyLimit,
	});
};
