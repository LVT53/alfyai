import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { createAttachmentTraceId } from "$lib/server/services/attachment-trace";
import { resolveKnowledgeUploadLimits } from "$lib/server/services/knowledge/upload-intake";
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
	const user = event.locals.user!;
	const traceId = createAttachmentTraceId("upload");
	const limits = resolveKnowledgeUploadLimits();
	const maxBodySize =
		limits.maxFileUploadSize + limits.multipartOverheadAllowance;
	const requestBodyLimit = limits.multipartBodyLimit;

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

	if (intent.fileSize > requestBodyLimit) {
		return json(
			{
				error: `Upload exceeded the server request body size limit of ${formatBytes(requestBodyLimit)}. Try uploading a smaller file or increase BODY_SIZE_LIMIT for this deployment.`,
				code: "upload_body_too_large",
				errorKey: "knowledge.uploadBodyTooLarge",
				traceId,
				details: {
					fileName: intent.fileName,
					fileSize: intent.fileSize,
					maxBodySize,
					adapterBodySizeLimit: limits.adapterBodySizeLimit,
					requestBodyLimit,
				},
			},
			{ status: 413 },
		);
	}

	return json({
		traceId,
		maxFileUploadSize: limits.maxFileUploadSize,
		adapterBodySizeLimit: limits.adapterBodySizeLimit,
		requestBodyLimit,
	});
};
