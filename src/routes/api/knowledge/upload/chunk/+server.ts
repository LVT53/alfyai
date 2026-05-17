import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, readdir, rm, stat, writeFile } from 'fs/promises';
import { once } from 'events';
import { join } from 'path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/hooks';
import { createAttachmentTraceId } from '$lib/server/services/attachment-trace';
import { getConversation } from '$lib/server/services/conversations';
import { getConfig } from '$lib/server/config-store';
import { getAdapterBodySizeLimitBytes } from '$lib/server/env';
import { completeStoredKnowledgeUpload } from '$lib/server/services/knowledge/upload-completion';

const UPLOAD_NAME_HEADER = 'x-alfyai-upload-name';
const UPLOAD_SIZE_HEADER = 'x-alfyai-upload-size';
const UPLOAD_TRACE_HEADER = 'x-alfyai-upload-trace-id';
const UPLOAD_CONVERSATION_HEADER = 'x-alfyai-conversation-id';
const CHUNK_INDEX_HEADER = 'x-alfyai-chunk-index';
const CHUNK_TOTAL_HEADER = 'x-alfyai-chunk-total';
const CHUNK_START_HEADER = 'x-alfyai-chunk-start';
const CHUNK_SIZE_HEADER = 'x-alfyai-chunk-size';
const CHUNK_FINAL_HEADER = 'x-alfyai-chunk-final';
const MAX_CHUNK_BYTES = 1024 * 1024;

function parseNonNegativeInteger(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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

function finiteLimit(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

function effectiveFileLimit(params: {
	appFileLimit: number;
	adapterBodySizeLimit: number;
}): number {
	const adapterLimit = finiteLimit(params.adapterBodySizeLimit);
	return adapterLimit === null
		? params.appFileLimit
		: Math.min(params.appFileLimit, adapterLimit);
}

function partName(index: number): string {
	return `part-${String(index).padStart(6, '0')}`;
}

async function countReceivedBytes(uploadDir: string): Promise<number> {
	let total = 0;
	for (const name of await readdir(uploadDir).catch(() => [])) {
		if (!name.startsWith('part-')) continue;
		const info = await stat(join(uploadDir, name)).catch(() => null);
		total += info?.size ?? 0;
	}
	return total;
}

async function pipePartToWriter(
	partPath: string,
	writer: ReturnType<typeof createWriteStream>,
	hash: ReturnType<typeof createHash>,
): Promise<number> {
	const reader = createReadStream(partPath);
	let bytes = 0;
	reader.on('data', (chunk: Buffer) => {
		bytes += chunk.length;
		hash.update(chunk);
		if (!writer.write(chunk)) {
			reader.pause();
			void once(writer, 'drain').then(() => reader.resume());
		}
	});
	await once(reader, 'end');
	return bytes;
}

async function finishWriter(writer: ReturnType<typeof createWriteStream>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		writer.once('finish', resolve);
		writer.once('error', reject);
		writer.end();
	});
}

async function assembleChunks(params: {
	uploadDir: string;
	tempPathAbsolute: string;
	totalChunks: number;
	totalSize: number;
}): Promise<{ receivedBytes: number; binaryHash: string }> {
	const writer = createWriteStream(params.tempPathAbsolute, { flags: 'wx' });
	const hash = createHash('sha256');
	let receivedBytes = 0;

	try {
		for (let index = 0; index < params.totalChunks; index += 1) {
			const partPath = join(params.uploadDir, partName(index));
			const info = await stat(partPath).catch(() => null);
			if (!info?.isFile()) {
				throw new Error(`Missing upload chunk ${index + 1} of ${params.totalChunks}.`);
			}
			receivedBytes += await pipePartToWriter(partPath, writer, hash);
		}
		await finishWriter(writer);
	} catch (error) {
		writer.destroy();
		await rm(params.tempPathAbsolute, { force: true }).catch(() => undefined);
		throw error;
	}

	if (receivedBytes !== params.totalSize) {
		await rm(params.tempPathAbsolute, { force: true }).catch(() => undefined);
		throw new Error(
			`Upload size mismatch. Browser declared ${params.totalSize} bytes but the server assembled ${receivedBytes} bytes.`
		);
	}

	return {
		receivedBytes,
		binaryHash: hash.digest('hex'),
	};
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const startedAt = Date.now();
	const config = getConfig();
	const traceId = sanitizeUploadTraceId(event.request.headers.get(UPLOAD_TRACE_HEADER)) ?? createAttachmentTraceId('upload');
	const fileName = decodeHeaderValue(event.request.headers.get(UPLOAD_NAME_HEADER));
	const totalSize = parseNonNegativeInteger(event.request.headers.get(UPLOAD_SIZE_HEADER));
	const chunkIndex = parseNonNegativeInteger(event.request.headers.get(CHUNK_INDEX_HEADER));
	const totalChunks = parseNonNegativeInteger(event.request.headers.get(CHUNK_TOTAL_HEADER));
	const chunkStart = parseNonNegativeInteger(event.request.headers.get(CHUNK_START_HEADER));
	const declaredChunkSize = parseNonNegativeInteger(event.request.headers.get(CHUNK_SIZE_HEADER));
	const isFinalChunk = event.request.headers.get(CHUNK_FINAL_HEADER) === 'true';
	const conversationId = sanitizeHeaderValue(event.request.headers.get(UPLOAD_CONVERSATION_HEADER));
	const mimeType = event.request.headers.get('content-type')?.split(';')[0]?.trim() || null;
	const adapterBodySizeLimit = getAdapterBodySizeLimitBytes();
	const fileLimit = effectiveFileLimit({
		appFileLimit: config.maxFileUploadSize,
		adapterBodySizeLimit,
	});

	if (!fileName || totalSize === null || chunkIndex === null || totalChunks === null || chunkStart === null || declaredChunkSize === null) {
		return json({ error: 'Missing chunk upload metadata', code: 'chunk_metadata_missing', traceId }, { status: 400 });
	}

	if (totalSize > fileLimit) {
		return json(
			{
				error: `File too large. Maximum size is ${formatBytes(fileLimit)}.`,
				code: 'upload_file_too_large',
				errorKey: 'knowledge.uploadFileTooLarge',
				traceId,
			},
			{ status: 413 },
		);
	}

	if (declaredChunkSize > MAX_CHUNK_BYTES) {
		return json(
			{
				error: `Upload chunk too large. Maximum chunk size is ${formatBytes(MAX_CHUNK_BYTES)}.`,
				code: 'upload_chunk_too_large',
				traceId,
			},
			{ status: 413 },
		);
	}

	if (chunkIndex >= totalChunks || totalChunks <= 0) {
		return json({ error: 'Invalid upload chunk index', code: 'chunk_index_invalid', traceId }, { status: 400 });
	}

	const expectedChunkSize =
		chunkIndex === totalChunks - 1
			? totalSize - chunkStart
			: Math.min(declaredChunkSize, totalSize - chunkStart);
	if (expectedChunkSize !== declaredChunkSize || expectedChunkSize < 0) {
		return json({ error: 'Invalid upload chunk size metadata', code: 'chunk_size_invalid', traceId }, { status: 400 });
	}

	if (conversationId) {
		const conversation = await getConversation(user.id, conversationId);
		if (!conversation) {
			return json({ error: 'Conversation not found or access denied', code: 'conversation_not_found', traceId }, { status: 400 });
		}
	}

	const chunkBuffer = Buffer.from(await event.request.arrayBuffer());
	if (chunkBuffer.length !== declaredChunkSize) {
		return json(
			{
				error: `Chunk size mismatch. Browser declared ${declaredChunkSize} bytes but the server received ${chunkBuffer.length} bytes.`,
				code: 'chunk_size_mismatch',
				traceId,
			},
			{ status: 400 },
		);
	}

	const uploadDir = join(process.cwd(), 'data', 'knowledge', user.id, '.incoming', traceId);
	await mkdir(uploadDir, { recursive: true });
	await writeFile(join(uploadDir, partName(chunkIndex)), chunkBuffer);
	const receivedBytes = await countReceivedBytes(uploadDir);

	console.info('[KNOWLEDGE] Chunked upload part received', {
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
		console.warn('[KNOWLEDGE] Chunked upload assembly failed', {
			traceId,
			userId: user.id,
			fileName,
			receivedBytes,
			totalSize,
			message,
		});
		return json({ error: message, code: 'chunk_assembly_failed', traceId }, { status: 400 });
	}

	console.info('[KNOWLEDGE] Chunked upload assembled', {
		traceId,
		userId: user.id,
		fileName,
		receivedBytes: assembled.receivedBytes,
		totalSize,
		durationMs: Date.now() - startedAt,
	});

	const response = await completeStoredKnowledgeUpload({
		userId: user.id,
		conversationId,
		fileName,
		mimeType,
		sizeBytes: assembled.receivedBytes,
		binaryHash: assembled.binaryHash,
		tempPathAbsolute: finalTempPath,
		traceId,
		startedAt,
		logPrefix: 'Chunked',
	});

	await rm(uploadDir, { force: true, recursive: true }).catch(() => undefined);
	return json({
		...response,
		complete: true,
		traceId,
		receivedBytes: assembled.receivedBytes,
		totalSize,
	});
};
