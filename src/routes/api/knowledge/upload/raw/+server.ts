import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { createAttachmentTraceId } from "$lib/server/services/attachment-trace";
import {
	completeKnowledgeUploadFromStoredFile,
	isKnowledgeUploadConversationError,
	resolveKnowledgeUploadLimits,
	validateKnowledgeUploadConversation,
} from "$lib/server/services/knowledge/upload-intake";
import type { RequestHandler } from "./$types";

const UPLOAD_NAME_HEADER = "x-alfyai-upload-name";
const UPLOAD_SIZE_HEADER = "x-alfyai-upload-size";
const UPLOAD_TRACE_HEADER = "x-alfyai-upload-trace-id";
const UPLOAD_CONVERSATION_HEADER = "x-alfyai-conversation-id";
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

function sanitizeHeaderValue(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, 240) : null;
}

function sanitizeUploadTraceId(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return /^[a-z0-9:_-]{4,120}$/i.test(trimmed) ? trimmed : null;
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

async function writeChunk(
	writer: ReturnType<typeof createWriteStream>,
	chunk: Uint8Array,
): Promise<void> {
	if (!writer.write(Buffer.from(chunk))) {
		await once(writer, "drain");
	}
}

async function finishWriter(
	writer: ReturnType<typeof createWriteStream>,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		writer.once("finish", resolve);
		writer.once("error", reject);
		writer.end();
	});
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
	const reader = params.body.getReader();
	const writer = createWriteStream(params.tempPathAbsolute, { flags: "wx" });
	const hash = createHash("sha256");
	let receivedBytes = 0;
	let nextProgressBytes = PROGRESS_BYTES;
	let lastProgressAt = Date.now();
	let abortLogged = false;

	const logProgress = (reason: "bytes" | "interval") => {
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
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > params.requestBodyLimit) {
				throw new RawUploadLimitError(
					uploadBodyLimitMessage(params.requestBodyLimit),
				);
			}
			hash.update(value);
			await writeChunk(writer, value);

			const now = Date.now();
			if (receivedBytes >= nextProgressBytes) {
				logProgress("bytes");
				while (receivedBytes >= nextProgressBytes) {
					nextProgressBytes += PROGRESS_BYTES;
				}
				lastProgressAt = now;
			} else if (now - lastProgressAt >= PROGRESS_MS) {
				logProgress("interval");
				lastProgressAt = now;
			}
		}

		await finishWriter(writer);
	} catch (error) {
		writer.destroy();
		await reader.cancel().catch(() => undefined);
		await unlink(params.tempPathAbsolute).catch(() => undefined);
		if (!abortLogged && isAbortError(error)) {
			onAbort();
		}
		throw error;
	} finally {
		params.signal?.removeEventListener("abort", onAbort);
	}

	if (
		params.declaredFileSize !== null &&
		receivedBytes !== params.declaredFileSize
	) {
		await unlink(params.tempPathAbsolute).catch(() => undefined);
		throw new RawUploadSizeMismatchError(
			`Upload size mismatch. Browser declared ${params.declaredFileSize} bytes but the server received ${receivedBytes} bytes.`,
		);
	}

	return {
		receivedBytes,
		binaryHash: hash.digest("hex"),
	};
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
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
	const conversationId = sanitizeHeaderValue(
		event.request.headers.get(UPLOAD_CONVERSATION_HEADER),
	);
	const mimeType =
		event.request.headers.get("content-type")?.split(";")[0]?.trim() || null;
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

	let validatedConversationId: string | null;
	try {
		validatedConversationId = await validateKnowledgeUploadConversation({
			userId: user.id,
			conversationId,
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
