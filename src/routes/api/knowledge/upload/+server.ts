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

type UploadContext = {
	userId: string;
	traceId: string;
	startedAt: number;
	limits: ReturnType<typeof resolveKnowledgeUploadLimits>;
	contentLength: number | null;
	declaredFileName: string | null;
	declaredFileSize: number | null;
	maxBodySize: number;
	requestBodyLimit: number;
};

function buildUploadContext(
	userId: string,
	traceId: string,
	limits: ReturnType<typeof resolveKnowledgeUploadLimits>,
	request: Request,
) {
	const contentLength = parseContentLength(
		request.headers.get("content-length"),
	);
	return {
		userId,
		traceId,
		startedAt: Date.now(),
		limits,
		contentLength,
		declaredFileName: decodeHeaderValue(
			request.headers.get(UPLOAD_NAME_HEADER),
		),
		declaredFileSize: parseContentLength(
			request.headers.get(UPLOAD_SIZE_HEADER),
		),
		maxBodySize: limits.maxFileUploadSize + limits.multipartOverheadAllowance,
		requestBodyLimit: limits.multipartBodyLimit,
	};
}

function buildUploadRequestSummary(context: UploadContext) {
	return {
		traceId: context.traceId,
		userId: context.userId,
		declaredFileName: context.declaredFileName,
		declaredFileSize: context.declaredFileSize,
		contentLength: context.contentLength,
		maxFileUploadSize: context.limits.maxFileUploadSize,
		adapterBodySizeLimit: context.limits.adapterBodySizeLimit,
		requestBodyLimit: context.requestBodyLimit,
	};
}

function precheckUploadDeclarations(context: UploadContext): Response | null {
	if (
		context.contentLength !== null &&
		context.contentLength > context.requestBodyLimit
	) {
		console.warn(
			"[KNOWLEDGE] Multipart upload exceeded app body allowance before parsing:",
			buildUploadRequestSummary(context),
		);
		return json(
			{
				error: uploadBodyLimitMessage(context.requestBodyLimit),
				code: "upload_body_too_large",
				errorKey: "knowledge.uploadBodyTooLarge",
				details: {
					fileName: context.declaredFileName,
					fileSize: context.declaredFileSize,
					contentLength: context.contentLength,
					maxBodySize: context.maxBodySize,
					adapterBodySizeLimit: context.limits.adapterBodySizeLimit,
					requestBodyLimit: context.requestBodyLimit,
				},
			},
			{ status: 413 },
		);
	}
	if (
		context.declaredFileSize !== null &&
		context.declaredFileSize > context.limits.maxFileUploadSize
	) {
		console.warn(
			"[KNOWLEDGE] Upload file exceeded app file allowance before parsing:",
			buildUploadRequestSummary(context),
		);
		return json(
			{
				error: `File too large. Maximum size is ${maxFileSizeMb(context.limits.maxFileUploadSize)}MB.`,
				code: "upload_file_too_large",
				errorKey: "knowledge.uploadFileTooLarge",
				details: {
					fileName: context.declaredFileName,
					fileSize: context.declaredFileSize,
					maxFileUploadSize: context.limits.maxFileUploadSize,
				},
			},
			{ status: 413 },
		);
	}
	return null;
}

function parseMultipartFormData(
	request: Request,
	context: UploadContext,
): Promise<Response | FormData> {
	const requestSignal = request.signal;
	const logMultipartAbort = () => {
		console.warn(
			"[KNOWLEDGE] Multipart upload request aborted during formData parsing",
			{
				traceId: context.traceId,
				userId: context.userId,
				declaredFileName: context.declaredFileName,
				declaredFileSize: context.declaredFileSize,
				contentLength: context.contentLength,
				durationMs: Date.now() - context.startedAt,
			},
		);
	};
	const watchdog = setInterval(() => {
		console.warn("[KNOWLEDGE] Multipart upload still parsing formData", {
			traceId: context.traceId,
			userId: context.userId,
			declaredFileName: context.declaredFileName,
			declaredFileSize: context.declaredFileSize,
			contentLength: context.contentLength,
			requestSignalAborted: request.signal?.aborted ?? null,
			durationMs: Date.now() - context.startedAt,
		});
	}, MULTIPART_PARSE_WATCHDOG_MS);

	if (typeof requestSignal?.addEventListener === "function") {
		requestSignal.addEventListener("abort", logMultipartAbort, { once: true });
	}

	return request
		.formData()
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = isUploadAbortError(error, message);
			const limitError = isBodySizeLimitError(error, message);
			const diagnostics = {
				traceId: context.traceId,
				userId: context.userId,
				fileName: context.declaredFileName,
				fileSize: context.declaredFileSize,
				contentLength: context.contentLength,
				maxFileUploadSize: context.limits.maxFileUploadSize,
				maxBodySize: context.maxBodySize,
				adapterBodySizeLimit: context.limits.adapterBodySizeLimit,
				requestBodyLimit: context.requestBodyLimit,
				requestSignalAborted: request.signal?.aborted ?? null,
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
						error: uploadBodyLimitMessage(context.requestBodyLimit),
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
							fileName: context.declaredFileName,
							declaredFileSize: context.declaredFileSize,
							contentLength: context.contentLength,
							adapterBodySizeLimit: context.limits.adapterBodySizeLimit,
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
		})
		.finally(() => {
			clearInterval(watchdog);
			if (typeof requestSignal?.removeEventListener === "function") {
				requestSignal.removeEventListener("abort", logMultipartAbort);
			}
		}) as Promise<Response | FormData>;
}

function resolveConversationId(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	return null;
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const traceId =
		sanitizeUploadTraceId(event.request.headers.get(UPLOAD_TRACE_HEADER)) ??
		createAttachmentTraceId("upload");

	const limits = resolveKnowledgeUploadLimits();
	const context = buildUploadContext(user.id, traceId, limits, event.request);

	const preflight = precheckUploadDeclarations(context);
	if (preflight) {
		return preflight;
	}

	console.info(
		"[KNOWLEDGE] Multipart upload receive started",
		buildUploadRequestSummary(context),
	);

	const parsedFormData = await parseMultipartFormData(event.request, context);
	if (parsedFormData instanceof Response) {
		return parsedFormData;
	}

	const file = parsedFormData.get("file");
	const conversationId = resolveConversationId(
		parsedFormData.get("conversationId"),
	);

	if (!(file instanceof File)) {
		return json({ error: "No file provided" }, { status: 400 });
	}
	if (file.size > context.limits.maxFileUploadSize) {
		return json(
			{
				error: `File too large. Maximum size is ${maxFileSizeMb(context.limits.maxFileUploadSize)}MB.`,
			},
			{ status: 400 },
		);
	}

	console.info("[KNOWLEDGE] Multipart upload parsed", {
		traceId,
		userId: user.id,
		fileName: file.name,
		fileSize: file.size,
		contentLength: context.contentLength,
		durationMs: Date.now() - context.startedAt,
	});

	try {
		const response = await completeKnowledgeUploadFromFile({
			userId: user.id,
			conversationId,
			file,
			traceId: context.traceId,
			startedAt: context.startedAt,
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
