import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { createAttachmentTraceId } from "$lib/server/services/attachment-trace";
import {
	completeKnowledgeUploadFromFile,
	isKnowledgeUploadConversationError,
	resolveKnowledgeUploadLimits,
} from "$lib/server/services/knowledge/upload-intake";
import type { RequestHandler } from "./$types";

const UPLOAD_NAME_HEADER = "x-alfyai-upload-name";
const UPLOAD_SIZE_HEADER = "x-alfyai-upload-size";
const UPLOAD_TRACE_HEADER = "x-alfyai-upload-trace-id";
const MULTIPART_PARSE_WATCHDOG_MS = 10_000;

function maxFileSizeMb(maxFileUploadSize: number): number {
	return Math.round(maxFileUploadSize / (1024 * 1024));
}

function parseContentLength(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatBytes(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "unlimited";
	const mb = value / (1024 * 1024);
	return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

function decodeHeaderValue(value: string | null): string | null {
	if (!value) return null;
	try {
		return decodeURIComponent(value).slice(0, 240);
	} catch {
		return value.slice(0, 240);
	}
}

function sanitizeUploadTraceId(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return /^[a-z0-9:_-]{4,120}$/i.test(trimmed) ? trimmed : null;
}

function uploadBodyLimitMessage(limitBytes: number | null) {
	return `Upload exceeded the server request body size limit of ${formatBytes(limitBytes)}. Try uploading a smaller file or increase BODY_SIZE_LIMIT for this deployment.`;
}

function uploadInterruptedMessage(params: {
	fileName: string | null;
	declaredFileSize: number | null;
	contentLength: number | null;
	adapterBodySizeLimit: number;
}) {
	const label = params.fileName ? `"${params.fileName}"` : "the file";
	const size = params.declaredFileSize ?? params.contentLength;
	const sizeLabel = size === null ? "" : ` (${formatBytes(size)})`;
	const adapterLimit = formatBytes(params.adapterBodySizeLimit);
	return `Upload connection closed while receiving ${label}${sizeLabel}, before AlfyAI could parse the complete multipart body. Extraction did not start. If this repeats, check reverse proxy upload limits/timeouts and BODY_SIZE_LIMIT (${adapterLimit}) for this deployment.`;
}

function errorStatus(error: unknown): number | null {
	if (typeof error !== "object" || error === null || !("status" in error))
		return null;
	const status = Number((error as { status?: unknown }).status);
	return Number.isInteger(status) ? status : null;
}

function errorName(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("name" in error))
		return null;
	const name = (error as { name?: unknown }).name;
	return typeof name === "string" ? name : null;
}

function isBodySizeLimitError(error: unknown, message: string) {
	return (
		errorStatus(error) === 413 ||
		/body size exceeded|content-length of .* exceeds limit|payload too large/i.test(
			message,
		)
	);
}

function isUploadAbortError(error: unknown, message: string) {
	return (
		errorName(error) === "AbortError" ||
		/\baborted\b|operation was aborted|client prematurely closed/i.test(message)
	);
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const traceId =
		sanitizeUploadTraceId(event.request.headers.get(UPLOAD_TRACE_HEADER)) ??
		createAttachmentTraceId("upload");
	const startedAt = Date.now();
	const limits = resolveKnowledgeUploadLimits();
	const contentLength = parseContentLength(
		event.request.headers.get("content-length"),
	);
	const declaredFileName = decodeHeaderValue(
		event.request.headers.get(UPLOAD_NAME_HEADER),
	);
	const declaredFileSize = parseContentLength(
		event.request.headers.get(UPLOAD_SIZE_HEADER),
	);
	const maxBodySize =
		limits.maxFileUploadSize + limits.multipartOverheadAllowance;
	const requestBodyLimit = limits.multipartBodyLimit;

	if (contentLength !== null && contentLength > requestBodyLimit) {
		console.warn(
			"[KNOWLEDGE] Multipart upload exceeded app body allowance before parsing:",
			{
				traceId,
				userId: user.id,
				declaredFileName,
				declaredFileSize,
				contentLength,
				maxBodySize,
				adapterBodySizeLimit: limits.adapterBodySizeLimit,
				requestBodyLimit,
			},
		);
		return json(
			{
				error: uploadBodyLimitMessage(requestBodyLimit),
				code: "upload_body_too_large",
				errorKey: "knowledge.uploadBodyTooLarge",
				details: {
					fileName: declaredFileName,
					fileSize: declaredFileSize,
					contentLength,
					maxBodySize,
					adapterBodySizeLimit: limits.adapterBodySizeLimit,
					requestBodyLimit,
				},
			},
			{ status: 413 },
		);
	}

	if (
		declaredFileSize !== null &&
		declaredFileSize > limits.maxFileUploadSize
	) {
		console.warn(
			"[KNOWLEDGE] Upload file exceeded app file allowance before parsing:",
			{
				traceId,
				userId: user.id,
				declaredFileName,
				declaredFileSize,
				maxFileUploadSize: limits.maxFileUploadSize,
			},
		);
		return json(
			{
				error: `File too large. Maximum size is ${maxFileSizeMb(limits.maxFileUploadSize)}MB.`,
				code: "upload_file_too_large",
				errorKey: "knowledge.uploadFileTooLarge",
				details: {
					fileName: declaredFileName,
					fileSize: declaredFileSize,
					maxFileUploadSize: limits.maxFileUploadSize,
				},
			},
			{ status: 413 },
		);
	}

	console.info("[KNOWLEDGE] Multipart upload receive started", {
		traceId,
		userId: user.id,
		declaredFileName,
		declaredFileSize,
		contentLength,
		maxFileUploadSize: limits.maxFileUploadSize,
		adapterBodySizeLimit: limits.adapterBodySizeLimit,
		requestBodyLimit,
	});

	let formData: FormData;
	const logMultipartAbort = () => {
		console.warn(
			"[KNOWLEDGE] Multipart upload request aborted during formData parsing",
			{
				traceId,
				userId: user.id,
				declaredFileName,
				declaredFileSize,
				contentLength,
				durationMs: Date.now() - startedAt,
			},
		);
	};
	const watchdog = setInterval(() => {
		console.warn("[KNOWLEDGE] Multipart upload still parsing formData", {
			traceId,
			userId: user.id,
			declaredFileName,
			declaredFileSize,
			contentLength,
			requestSignalAborted: event.request.signal?.aborted ?? null,
			durationMs: Date.now() - startedAt,
		});
	}, MULTIPART_PARSE_WATCHDOG_MS);
	const requestSignal = event.request.signal;
	if (typeof requestSignal?.addEventListener === "function") {
		requestSignal.addEventListener("abort", logMultipartAbort, { once: true });
	}
	try {
		formData = await event.request.formData();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = isUploadAbortError(error, message);
		const limitError = isBodySizeLimitError(error, message);
		const diagnostics = {
			traceId,
			userId: user.id,
			declaredFileName,
			declaredFileSize,
			contentLength,
			maxFileUploadSize: limits.maxFileUploadSize,
			maxBodySize,
			adapterBodySizeLimit: limits.adapterBodySizeLimit,
			requestBodyLimit,
			requestSignalAborted: event.request.signal?.aborted ?? null,
			classification: limitError
				? "body_limit"
				: aborted
					? "connection_closed_before_multipart_parse"
					: "invalid_multipart",
			name: errorName(error),
			status: errorStatus(error),
			message,
		};
		if (aborted) {
			console.warn(
				"[KNOWLEDGE] Failed to parse multipart upload:",
				diagnostics,
			);
		} else {
			console.error(
				"[KNOWLEDGE] Failed to parse multipart upload:",
				diagnostics,
			);
		}

		if (limitError) {
			return json(
				{
					error: uploadBodyLimitMessage(requestBodyLimit),
					code: "upload_body_too_large",
					errorKey: "knowledge.uploadBodyTooLarge",
					details: diagnostics,
				},
				{ status: 413 },
			);
		}

		if (aborted) {
			return json(
				{
					error: uploadInterruptedMessage({
						fileName: declaredFileName,
						declaredFileSize,
						contentLength,
						adapterBodySizeLimit: limits.adapterBodySizeLimit,
					}),
					code: "upload_aborted",
					errorKey: "knowledge.uploadAborted",
					details: diagnostics,
				},
				{ status: 400 },
			);
		}

		return json(
			{ error: "Invalid form data", code: "invalid_form_data" },
			{ status: 400 },
		);
	} finally {
		clearInterval(watchdog);
		if (typeof requestSignal?.removeEventListener === "function") {
			requestSignal.removeEventListener("abort", logMultipartAbort);
		}
	}

	const file = formData.get("file");
	const conversationIdValue = formData.get("conversationId");

	if (!(file instanceof File)) {
		return json({ error: "No file provided" }, { status: 400 });
	}
	if (file.size > limits.maxFileUploadSize) {
		return json(
			{
				error: `File too large. Maximum size is ${maxFileSizeMb(limits.maxFileUploadSize)}MB.`,
			},
			{ status: 400 },
		);
	}
	console.info("[KNOWLEDGE] Multipart upload parsed", {
		traceId,
		userId: user.id,
		fileName: file.name,
		fileSize: file.size,
		contentLength,
		durationMs: Date.now() - startedAt,
	});

	let conversationId: string | null = null;
	if (typeof conversationIdValue === "string" && conversationIdValue.trim()) {
		conversationId = conversationIdValue.trim();
	}

	try {
		const response = await completeKnowledgeUploadFromFile({
			userId: user.id,
			conversationId,
			file,
			traceId,
			startedAt,
		});
		return json(response);
	} catch (error) {
		if (isKnowledgeUploadConversationError(error)) {
			return json(
				{ error: "Conversation not found or access denied" },
				{ status: 400 },
			);
		}
		throw error;
	}
};
