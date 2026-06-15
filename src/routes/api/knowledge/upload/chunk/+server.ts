import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
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
	parseNonNegativeInteger,
	readKnowledgeUploadRequestMetadata,
	resolveKnowledgeUploadConversation,
	writeKnowledgeUploadBytes,
} from "../shared";
import type { RequestHandler } from "./$types";

const CHUNK_INDEX_HEADER = "x-alfyai-chunk-index";
const CHUNK_TOTAL_HEADER = "x-alfyai-chunk-total";
const CHUNK_START_HEADER = "x-alfyai-chunk-start";
const CHUNK_SIZE_HEADER = "x-alfyai-chunk-size";
const CHUNK_FINAL_HEADER = "x-alfyai-chunk-final";

function partName(index: number): string {
	return `part-${String(index).padStart(6, "0")}`;
}

async function countReceivedBytes(uploadDir: string): Promise<number> {
	let total = 0;
	for (const name of await readdir(uploadDir).catch(() => [])) {
		if (!name.startsWith("part-")) continue;
		const info = await stat(join(uploadDir, name)).catch(() => null);
		total += info?.size ?? 0;
	}
	return total;
}

async function* iterateChunkUploadBytes(params: {
	uploadDir: string;
	totalChunks: number;
}): AsyncGenerator<Uint8Array, void, void> {
	for (let index = 0; index < params.totalChunks; index += 1) {
		const partPath = join(params.uploadDir, partName(index));
		const info = await stat(partPath).catch(() => null);
		if (!info?.isFile()) {
			throw new Error(
				`Missing upload chunk ${index + 1} of ${params.totalChunks}.`,
			);
		}

		const reader = createReadStream(partPath);
		try {
			for await (const chunk of reader) {
				yield chunk;
			}
		} finally {
			reader.destroy();
		}
	}
}

async function assembleChunks(params: {
	uploadDir: string;
	tempPathAbsolute: string;
	totalChunks: number;
	totalSize: number;
}): Promise<{ receivedBytes: number; binaryHash: string }> {
	return writeKnowledgeUploadBytes({
		source: iterateChunkUploadBytes({
			uploadDir: params.uploadDir,
			totalChunks: params.totalChunks,
		}),
		tempPathAbsolute: params.tempPathAbsolute,
		expectedSize: params.totalSize,
		createSizeMismatchError: ({ expectedSize, receivedBytes }) =>
			new Error(
				`Upload size mismatch. Browser declared ${expectedSize} bytes but the server assembled ${receivedBytes} bytes.`,
			),
	});
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const startedAt = Date.now();
	const limits = resolveKnowledgeUploadLimits();
	const metadata = readKnowledgeUploadRequestMetadata(event.request);
	const traceId = metadata.traceId || createAttachmentTraceId("upload");
	const fileName = metadata.fileName;
	const totalSize = metadata.declaredFileSize;
	const chunkIndex = parseNonNegativeInteger(
		event.request.headers.get(CHUNK_INDEX_HEADER),
	);
	const totalChunks = parseNonNegativeInteger(
		event.request.headers.get(CHUNK_TOTAL_HEADER),
	);
	const chunkStart = parseNonNegativeInteger(
		event.request.headers.get(CHUNK_START_HEADER),
	);
	const declaredChunkSize = parseNonNegativeInteger(
		event.request.headers.get(CHUNK_SIZE_HEADER),
	);
	const isFinalChunk = event.request.headers.get(CHUNK_FINAL_HEADER) === "true";
	const conversationId = metadata.conversationId;
	const mimeType = metadata.mimeType;
	const fileLimit = limits.chunkFileLimit;
	const chunkBodyLimit = limits.chunkBodyLimit;
	const contentLength = parseNonNegativeInteger(
		event.request.headers.get("content-length"),
	);

	if (
		!fileName ||
		totalSize === null ||
		chunkIndex === null ||
		totalChunks === null ||
		chunkStart === null ||
		declaredChunkSize === null
	) {
		return json(
			{
				error: "Missing chunk upload metadata",
				code: "chunk_metadata_missing",
				traceId,
			},
			{ status: 400 },
		);
	}

	if (totalSize > fileLimit) {
		return json(
			{
				error: `File too large. Maximum size is ${formatBytes(fileLimit)}.`,
				code: "upload_file_too_large",
				errorKey: "knowledge.uploadFileTooLarge",
				traceId,
			},
			{ status: 413 },
		);
	}

	if (
		declaredChunkSize > chunkBodyLimit ||
		(contentLength !== null && contentLength > chunkBodyLimit)
	) {
		return json(
			{
				error: `Upload chunk too large. Maximum chunk size is ${formatBytes(chunkBodyLimit)}.`,
				code: "upload_chunk_too_large",
				traceId,
			},
			{ status: 413 },
		);
	}

	if (chunkIndex >= totalChunks || totalChunks <= 0) {
		return json(
			{
				error: "Invalid upload chunk index",
				code: "chunk_index_invalid",
				traceId,
			},
			{ status: 400 },
		);
	}

	const isLastChunk = chunkIndex === totalChunks - 1;
	const expectedChunkStart = isLastChunk
		? totalSize - declaredChunkSize
		: chunkIndex * declaredChunkSize;
	if (
		expectedChunkStart < 0 ||
		!Number.isSafeInteger(expectedChunkStart) ||
		chunkStart !== expectedChunkStart
	) {
		return json(
			{
				error: "Invalid upload chunk start metadata",
				code: "chunk_start_invalid",
				traceId,
			},
			{ status: 400 },
		);
	}

	const expectedChunkSize = isLastChunk
		? totalSize - chunkStart
		: Math.min(declaredChunkSize, totalSize - chunkStart);
	if (expectedChunkSize !== declaredChunkSize || expectedChunkSize < 0) {
		return json(
			{
				error: "Invalid upload chunk size metadata",
				code: "chunk_size_invalid",
				traceId,
			},
			{ status: 400 },
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

	const chunkBuffer = Buffer.from(await event.request.arrayBuffer());
	if (chunkBuffer.length !== declaredChunkSize) {
		return json(
			{
				error: `Chunk size mismatch. Browser declared ${declaredChunkSize} bytes but the server received ${chunkBuffer.length} bytes.`,
				code: "chunk_size_mismatch",
				traceId,
			},
			{ status: 400 },
		);
	}

	const uploadDir = join(
		process.cwd(),
		"data",
		"knowledge",
		user.id,
		".incoming",
		traceId,
	);
	await mkdir(uploadDir, { recursive: true });
	await writeFile(join(uploadDir, partName(chunkIndex)), chunkBuffer);
	const receivedBytes = await countReceivedBytes(uploadDir);

	console.info("[KNOWLEDGE] Chunked upload part received", {
		traceId,
		userId: user.id,
		fileName,
		chunkIndex,
		totalChunks,
		chunkBytes: chunkBuffer.length,
		receivedBytes,
		totalSize,
		durationMs: Date.now() - startedAt,
	});

	if (!isFinalChunk) {
		return json({
			complete: false,
			traceId,
			receivedBytes,
			totalSize,
			chunkIndex,
			totalChunks,
		});
	}

	const finalTempPath = join(uploadDir, `${traceId}.assembled`);
	let assembled: { receivedBytes: number; binaryHash: string };
	try {
		assembled = await assembleChunks({
			uploadDir,
			tempPathAbsolute: finalTempPath,
			totalChunks,
			totalSize,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn("[KNOWLEDGE] Chunked upload assembly failed", {
			traceId,
			userId: user.id,
			fileName,
			receivedBytes,
			totalSize,
			message,
		});
		return json(
			{ error: message, code: "chunk_assembly_failed", traceId },
			{ status: 400 },
		);
	}

	console.info("[KNOWLEDGE] Chunked upload assembled", {
		traceId,
		userId: user.id,
		fileName,
		receivedBytes: assembled.receivedBytes,
		totalSize,
		durationMs: Date.now() - startedAt,
	});

	let response: Awaited<
		ReturnType<typeof completeKnowledgeUploadFromStoredFile>
	>;
	try {
		response = await completeKnowledgeUploadFromStoredFile({
			userId: user.id,
			conversationId: validatedConversationId,
			fileName,
			mimeType,
			sizeBytes: assembled.receivedBytes,
			binaryHash: assembled.binaryHash,
			tempPathAbsolute: finalTempPath,
			traceId,
			startedAt,
			logPrefix: "Chunked",
		});
	} catch (error) {
		if (isKnowledgeUploadConversationError(error)) {
			await rm(uploadDir, { force: true, recursive: true }).catch(
				() => undefined,
			);
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

	await rm(uploadDir, { force: true, recursive: true }).catch(() => undefined);
	return json({
		...response,
		complete: true,
		traceId,
		receivedBytes: assembled.receivedBytes,
		totalSize,
	});
};
