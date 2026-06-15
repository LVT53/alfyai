import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { createAttachmentTraceId } from "$lib/server/services/attachment-trace";
import {
	completeKnowledgeUploadFromStoredFile,
	isKnowledgeUploadConversationError,
	resolveKnowledgeUploadLimits,
} from "$lib/server/services/knowledge/upload-intake";
import {
	formatBytes,
	parseContentLength,
	readKnowledgeUploadRequestMetadata,
	resolveKnowledgeUploadConversation,
	writeKnowledgeUploadBytes,
} from "../shared";
import type { RequestHandler } from "./$types";

const PROGRESS_BYTES = 8 * 1024 * 1024;
const PROGRESS_MS = 10_000;

class RawUploadLimitError extends Error {
	code = "upload_body_too_large" as const;
	status = 413 as const;
}

class RawUploadSizeMismatchError extends Error {
	code = "upload_size_mismatch" as const;
	status = 400 as const;
}

function uploadBodyLimitMessage(limitBytes: number | null) {
	return `Upload exceeded the server request body size limit of ${formatBytes(limitBytes)}. Try uploading a smaller file or increase BODY_SIZE_LIMIT for this deployment.`;
}

function isAbortError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const name =
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		typeof (error as { name?: unknown }).name === "string"
			? (error as { name: string }).name
			: "";
	return (
		name === "AbortError" ||
		/\baborted\b|operation was aborted|client prematurely closed/i.test(message)
	);
}

async function* iterateRawUploadBody(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
	const reader = body.getReader();
	let completed = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				completed = true;
				return;
			}
			yield value;
		}
	} finally {
		if (!completed) {
			await reader.cancel().catch(() => undefined);
		}
		reader.releaseLock();
	}
}

async function receiveRawUpload(params: {
	body: ReadableStream<Uint8Array>;
	tempPathAbsolute: string;
	traceId: string;
	userId: string;
	fileName: string | null;
	declaredFileSize: number | null;
	contentLength: number | null;
	requestBodyLimit: number;
	signal?: AbortSignal;
	startedAt: number;
}): Promise<{ receivedBytes: number; binaryHash: string }> {
	let nextProgressBytes = PROGRESS_BYTES;
	let lastProgressAt = Date.now();
	let abortLogged = false;
	let receivedBytes = 0;

	const logProgress = (reason: "bytes" | "interval", receivedBytes: number) => {
		console.info("[KNOWLEDGE] Raw upload receive progress", {
			traceId: params.traceId,
			userId: params.userId,
			fileName: params.fileName,
			reason,
			receivedBytes,
			declaredFileSize: params.declaredFileSize,
			contentLength: params.contentLength,
			durationMs: Date.now() - params.startedAt,
		});
	};
	const onAbort = () => {
		abortLogged = true;
		console.warn(
			"[KNOWLEDGE] Raw upload request aborted while receiving body",
			{
				traceId: params.traceId,
				userId: params.userId,
				fileName: params.fileName,
				receivedBytes,
				declaredFileSize: params.declaredFileSize,
				contentLength: params.contentLength,
				durationMs: Date.now() - params.startedAt,
			},
		);
	};
	params.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const result = await writeKnowledgeUploadBytes({
			source: iterateRawUploadBody(params.body),
			tempPathAbsolute: params.tempPathAbsolute,
			expectedSize: params.declaredFileSize,
			onChunk: ({ receivedBytes: chunkReceivedBytes }) => {
				receivedBytes = chunkReceivedBytes;
				if (chunkReceivedBytes > params.requestBodyLimit) {
					throw new RawUploadLimitError(
						uploadBodyLimitMessage(params.requestBodyLimit),
					);
				}

				const now = Date.now();
				if (chunkReceivedBytes >= nextProgressBytes) {
					logProgress("bytes", chunkReceivedBytes);
					while (chunkReceivedBytes >= nextProgressBytes) {
						nextProgressBytes += PROGRESS_BYTES;
					}
					lastProgressAt = now;
				} else if (now - lastProgressAt >= PROGRESS_MS) {
					logProgress("interval", chunkReceivedBytes);
					lastProgressAt = now;
				}
			},
			createSizeMismatchError: ({ expectedSize, receivedBytes }) =>
				new RawUploadSizeMismatchError(
					`Upload size mismatch. Browser declared ${expectedSize} bytes but the server received ${receivedBytes} bytes.`,
				),
		});
		return result;
	} catch (error) {
		if (!abortLogged && isAbortError(error)) {
			onAbort();
		}
		throw error;
	} finally {
		params.signal?.removeEventListener("abort", onAbort);
	}
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const metadata = readKnowledgeUploadRequestMetadata(event.request);
	const traceId = metadata.traceId || createAttachmentTraceId("upload");
	const startedAt = Date.now();
	const limits = resolveKnowledgeUploadLimits();
	const contentLength = parseContentLength(
		event.request.headers.get("content-length"),
	);
	const declaredFileName = metadata.fileName;
	const declaredFileSize = metadata.declaredFileSize;
	const conversationId = metadata.conversationId;
	const mimeType = metadata.mimeType;
	const requestBodyLimit = limits.storedFileLimit;

	console.info("[KNOWLEDGE] Raw upload receive started", {
		traceId,
		userId: user.id,
		fileName: declaredFileName,
		declaredFileSize,
		contentLength,
		mimeType,
		conversationId,
		maxFileUploadSize: limits.maxFileUploadSize,
		adapterBodySizeLimit: limits.adapterBodySizeLimit,
		requestBodyLimit,
	});

	if (!declaredFileName) {
		return json(
			{
				error: "Upload file name is required",
				code: "upload_name_required",
				traceId,
			},
			{ status: 400 },
		);
	}

	if (!event.request.body) {
		return json(
			{
				error: "Upload request body is empty",
				code: "upload_body_missing",
				traceId,
			},
			{ status: 400 },
		);
	}

	if (
		declaredFileSize !== null &&
		declaredFileSize > limits.maxFileUploadSize
	) {
		return json(
			{
				error: `File too large. Maximum size is ${formatBytes(limits.maxFileUploadSize)}.`,
				code: "upload_file_too_large",
				errorKey: "knowledge.uploadFileTooLarge",
				traceId,
			},
			{ status: 413 },
		);
	}

	if (contentLength !== null && contentLength > requestBodyLimit) {
		return json(
			{
				error: uploadBodyLimitMessage(requestBodyLimit),
				code: "upload_body_too_large",
				errorKey: "knowledge.uploadBodyTooLarge",
				traceId,
			},
			{ status: 413 },
		);
	}

	const conversation = await resolveKnowledgeUploadConversation({
		userId: user.id,
		conversationId,
		traceId,
	});
	if (conversation.response) {
		return conversation.response;
	}
	const validatedConversationId = conversation.conversationId;

	const tempDir = join(
		process.cwd(),
		"data",
		"knowledge",
		user.id,
		".incoming",
	);
	await mkdir(tempDir, { recursive: true });
	const tempPathAbsolute = join(tempDir, `${traceId}-${Date.now()}.upload`);

	let received: { receivedBytes: number; binaryHash: string };
	try {
		received = await receiveRawUpload({
			body: event.request.body,
			tempPathAbsolute,
			traceId,
			userId: user.id,
			fileName: declaredFileName,
			declaredFileSize,
			contentLength,
			requestBodyLimit,
			signal: event.request.signal,
			startedAt,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			error instanceof RawUploadLimitError ||
			error instanceof RawUploadSizeMismatchError
				? error.status
				: isAbortError(error)
					? 400
					: 500;
		const code =
			error instanceof RawUploadLimitError ||
			error instanceof RawUploadSizeMismatchError
				? error.code
				: isAbortError(error)
					? "upload_aborted"
					: "upload_receive_failed";
		console.warn("[KNOWLEDGE] Raw upload receive failed", {
			traceId,
			userId: user.id,
			fileName: declaredFileName,
			declaredFileSize,
			contentLength,
			code,
			message,
			durationMs: Date.now() - startedAt,
		});
		return json({ error: message, code, traceId }, { status });
	}

	console.info("[KNOWLEDGE] Raw upload receive completed", {
		traceId,
		userId: user.id,
		fileName: declaredFileName,
		receivedBytes: received.receivedBytes,
		contentLength,
		durationMs: Date.now() - startedAt,
	});

	try {
		const response = await completeKnowledgeUploadFromStoredFile({
			userId: user.id,
			conversationId: validatedConversationId,
			fileName: declaredFileName,
			mimeType,
			sizeBytes: received.receivedBytes,
			binaryHash: received.binaryHash,
			tempPathAbsolute,
			traceId,
			startedAt,
			logPrefix: "Raw",
		});
		return json(response);
	} catch (error) {
		if (isKnowledgeUploadConversationError(error)) {
			await unlink(tempPathAbsolute).catch(() => undefined);
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
};
