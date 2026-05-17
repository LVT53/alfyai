import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/hooks';
import {
	createNormalizedArtifact,
	resolvePromptAttachmentArtifacts,
	saveUploadedArtifact,
} from '$lib/server/services/knowledge';
import { syncArtifactToHoncho } from '$lib/server/services/honcho';
import {
	createAttachmentTraceId,
	logAttachmentTrace,
} from '$lib/server/services/attachment-trace';
import { getConversation } from '$lib/server/services/conversations';
import { getConfig } from '$lib/server/config-store';
import { getAdapterBodySizeLimitBytes } from '$lib/server/env';

const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 1024 * 1024;
const UPLOAD_NAME_HEADER = 'x-alfyai-upload-name';
const UPLOAD_SIZE_HEADER = 'x-alfyai-upload-size';
const UPLOAD_TRACE_HEADER = 'x-alfyai-upload-trace-id';
const MULTIPART_PARSE_WATCHDOG_MS = 10_000;
const MAX_FILE_SIZE_MB = () => Math.round(getConfig().maxFileUploadSize / (1024 * 1024));

function parseContentLength(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatBytes(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return 'unlimited';
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
	const label = params.fileName ? `"${params.fileName}"` : 'the file';
	const size = params.declaredFileSize ?? params.contentLength;
	const sizeLabel = size === null ? '' : ` (${formatBytes(size)})`;
	const adapterLimit = formatBytes(params.adapterBodySizeLimit);
	return `Upload connection closed while receiving ${label}${sizeLabel}, before AlfyAI could parse the complete multipart body. Extraction did not start. If this repeats, check reverse proxy upload limits/timeouts and BODY_SIZE_LIMIT (${adapterLimit}) for this deployment.`;
}

function errorStatus(error: unknown): number | null {
	if (typeof error !== 'object' || error === null || !('status' in error)) return null;
	const status = Number((error as { status?: unknown }).status);
	return Number.isInteger(status) ? status : null;
}

function errorName(error: unknown): string | null {
	if (typeof error !== 'object' || error === null || !('name' in error)) return null;
	const name = (error as { name?: unknown }).name;
	return typeof name === 'string' ? name : null;
}

function isBodySizeLimitError(error: unknown, message: string) {
	return (
		errorStatus(error) === 413 ||
		/body size exceeded|content-length of .* exceeds limit|payload too large/i.test(message)
	);
}

function isUploadAbortError(error: unknown, message: string) {
	return errorName(error) === 'AbortError' || /\baborted\b|operation was aborted|client prematurely closed/i.test(message);
}

function finiteLimit(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

function effectiveRequestBodyLimit(params: {
	appMultipartLimit: number;
	adapterBodySizeLimit: number;
}): number {
	const adapterLimit = finiteLimit(params.adapterBodySizeLimit);
	return adapterLimit === null
		? params.appMultipartLimit
		: Math.min(params.appMultipartLimit, adapterLimit);
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const traceId = sanitizeUploadTraceId(event.request.headers.get(UPLOAD_TRACE_HEADER)) ?? createAttachmentTraceId('upload');
	const startedAt = Date.now();
	const config = getConfig();
	const contentLength = parseContentLength(event.request.headers.get('content-length'));
	const declaredFileName = decodeHeaderValue(event.request.headers.get(UPLOAD_NAME_HEADER));
	const declaredFileSize = parseContentLength(event.request.headers.get(UPLOAD_SIZE_HEADER));
	const adapterBodySizeLimit = getAdapterBodySizeLimitBytes();
	const maxBodySize = config.maxFileUploadSize + MULTIPART_OVERHEAD_ALLOWANCE_BYTES;
	const requestBodyLimit = effectiveRequestBodyLimit({
		appMultipartLimit: maxBodySize,
		adapterBodySizeLimit,
	});

	if (contentLength !== null && contentLength > requestBodyLimit) {
		console.warn('[KNOWLEDGE] Multipart upload exceeded app body allowance before parsing:', {
			traceId,
			userId: user.id,
			declaredFileName,
			declaredFileSize,
			contentLength,
			maxBodySize,
			adapterBodySizeLimit,
			requestBodyLimit,
		});
		return json(
			{
				error: uploadBodyLimitMessage(requestBodyLimit),
				code: 'upload_body_too_large',
				errorKey: 'knowledge.uploadBodyTooLarge',
				details: {
					fileName: declaredFileName,
					fileSize: declaredFileSize,
					contentLength,
					maxBodySize,
					adapterBodySizeLimit,
					requestBodyLimit,
				},
			},
			{ status: 413 }
		);
	}

	if (declaredFileSize !== null && declaredFileSize > config.maxFileUploadSize) {
		console.warn('[KNOWLEDGE] Upload file exceeded app file allowance before parsing:', {
			traceId,
			userId: user.id,
			declaredFileName,
			declaredFileSize,
			maxFileUploadSize: config.maxFileUploadSize,
		});
		return json(
			{
				error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB()}MB.`,
				code: 'upload_file_too_large',
				errorKey: 'knowledge.uploadFileTooLarge',
				details: {
					fileName: declaredFileName,
					fileSize: declaredFileSize,
					maxFileUploadSize: config.maxFileUploadSize,
				},
			},
			{ status: 413 }
		);
	}

	console.info('[KNOWLEDGE] Multipart upload receive started', {
		traceId,
		userId: user.id,
		declaredFileName,
		declaredFileSize,
		contentLength,
		maxFileUploadSize: config.maxFileUploadSize,
		adapterBodySizeLimit,
		requestBodyLimit,
	});

	let formData: FormData;
	const logMultipartAbort = () => {
		console.warn('[KNOWLEDGE] Multipart upload request aborted during formData parsing', {
			traceId,
			userId: user.id,
			declaredFileName,
			declaredFileSize,
			contentLength,
			durationMs: Date.now() - startedAt,
		});
	};
	const watchdog = setInterval(() => {
		console.warn('[KNOWLEDGE] Multipart upload still parsing formData', {
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
	if (typeof requestSignal?.addEventListener === 'function') {
		requestSignal.addEventListener('abort', logMultipartAbort, { once: true });
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
			maxFileUploadSize: config.maxFileUploadSize,
			maxBodySize,
			adapterBodySizeLimit,
			requestBodyLimit,
			requestSignalAborted: event.request.signal?.aborted ?? null,
			classification: limitError
				? 'body_limit'
				: aborted
					? 'connection_closed_before_multipart_parse'
					: 'invalid_multipart',
			name: errorName(error),
			status: errorStatus(error),
			message,
		};
		if (aborted) {
			console.warn('[KNOWLEDGE] Failed to parse multipart upload:', diagnostics);
		} else {
			console.error('[KNOWLEDGE] Failed to parse multipart upload:', diagnostics);
		}

		if (limitError) {
			return json(
				{
					error: uploadBodyLimitMessage(requestBodyLimit),
					code: 'upload_body_too_large',
					errorKey: 'knowledge.uploadBodyTooLarge',
					details: diagnostics,
				},
				{ status: 413 }
			);
		}

		if (aborted) {
			return json(
				{
					error: uploadInterruptedMessage({
						fileName: declaredFileName,
						declaredFileSize,
						contentLength,
						adapterBodySizeLimit,
					}),
					code: 'upload_aborted',
					errorKey: 'knowledge.uploadAborted',
					details: diagnostics,
				},
				{ status: 400 }
			);
		}

		return json({ error: 'Invalid form data', code: 'invalid_form_data' }, { status: 400 });
	} finally {
		clearInterval(watchdog);
		if (typeof requestSignal?.removeEventListener === 'function') {
			requestSignal.removeEventListener('abort', logMultipartAbort);
		}
	}

	const file = formData.get('file');
	const conversationIdValue = formData.get('conversationId');

	if (!(file instanceof File)) {
		return json({ error: 'No file provided' }, { status: 400 });
	}
	if (file.size > config.maxFileUploadSize) {
		return json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB()}MB.` }, { status: 400 });
	}
	console.info('[KNOWLEDGE] Multipart upload parsed', {
		traceId,
		userId: user.id,
		fileName: file.name,
		fileSize: file.size,
		contentLength,
		durationMs: Date.now() - startedAt,
	});

	let conversationId: string | null = null;
	if (typeof conversationIdValue === 'string' && conversationIdValue.trim()) {
		conversationId = conversationIdValue.trim();
	}

	if (conversationId) {
		const conversation = await getConversation(user.id, conversationId);
		if (!conversation) {
			return json({ error: 'Conversation not found or access denied' }, { status: 400 });
		}
	}

	const uploadResult = await saveUploadedArtifact({
		userId: user.id,
		conversationId,
		file,
	});
	const artifact = uploadResult.artifact;
	console.info('[KNOWLEDGE] Source upload saved', {
		traceId,
		userId: user.id,
		conversationId,
		artifactId: artifact.id,
		fileName: artifact.name,
		fileSize: artifact.sizeBytes,
		durationMs: Date.now() - startedAt,
	});

	let normalizedArtifact = uploadResult.normalizedArtifact;
	if (!normalizedArtifact && artifact.storagePath) {
		normalizedArtifact = await createNormalizedArtifact({
			userId: user.id,
			conversationId,
			sourceArtifactId: artifact.id,
			sourceStoragePath: artifact.storagePath,
			sourceName: artifact.name,
			sourceMimeType: artifact.mimeType,
		});
	}
	console.info('[KNOWLEDGE] Upload extraction completed', {
		traceId,
		userId: user.id,
		conversationId,
		artifactId: artifact.id,
		normalizedArtifactId: normalizedArtifact?.id ?? null,
		normalizedTextLength: normalizedArtifact?.contentText?.length ?? 0,
		durationMs: Date.now() - startedAt,
	});

	let syncResult: Awaited<ReturnType<typeof syncArtifactToHoncho>> = {
		uploaded: false,
		mode: 'none',
	};
	syncResult = await syncArtifactToHoncho({
		userId: user.id,
		conversationId,
		artifact,
		file,
	});

	if (!syncResult.uploaded) {
		syncResult = await syncArtifactToHoncho({
			userId: user.id,
			conversationId,
			artifact,
			fallbackTextArtifact: normalizedArtifact,
		});
	}
	console.info('[KNOWLEDGE] Upload Honcho sync completed', {
		traceId,
		userId: user.id,
		conversationId,
		artifactId: artifact.id,
		uploaded: syncResult.uploaded,
		mode: syncResult.mode,
		durationMs: Date.now() - startedAt,
	});

	const resolvedAttachment = await resolvePromptAttachmentArtifacts(user.id, [artifact.id]);
	const resolvedItem = resolvedAttachment.items[0];
	const promptReady = resolvedItem?.promptReady ?? false;
	const readinessError = resolvedItem
		? resolvedItem.readinessError
		: 'This file could not be prepared for chat. Remove it or upload a supported text-readable document.';

	logAttachmentTrace('upload_result', {
		traceId,
		userId: user.id,
		conversationId,
		sourceArtifactId: artifact.id,
		normalizedArtifactId: normalizedArtifact?.id ?? null,
		promptReady,
		promptArtifactId: resolvedItem?.promptArtifact?.id ?? null,
		extractionTextLength: resolvedItem?.contentLength ?? 0,
		chunkCount: resolvedItem?.chunkCount ?? 0,
		contentHash: resolvedItem?.contentHash ?? null,
	});

	return json({
		artifact,
		normalizedArtifact,
		honcho: syncResult,
		promptReady,
		promptArtifactId: promptReady ? resolvedItem?.promptArtifact?.id ?? null : null,
		readinessError,
		renameInfo: uploadResult.renameInfo,
	});
};
