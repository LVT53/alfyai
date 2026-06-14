import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactChunks } from "$lib/server/db/schema";
import { getSmallFileThreshold } from "$lib/server/services/knowledge/store/core";
import { estimateTokenCount } from "$lib/utils/tokens";

const CHUNK_CHAR_TARGET = 1400;
const CHUNK_CHAR_OVERLAP = 220;

/**
 * Determines if a file should bypass chunking based on its content length.
 * Small files (< threshold) are stored in full without chunking to save storage.
 */
function shouldBypassChunking(contentLength: number): boolean {
	return contentLength < getSmallFileThreshold();
}

function splitIntoChunks(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return [];

	const chunks: string[] = [];
	let start = 0;

	while (start < normalized.length) {
		let end = Math.min(normalized.length, start + CHUNK_CHAR_TARGET);
		if (end < normalized.length) {
			const paragraphBreak = normalized.lastIndexOf("\n\n", end);
			const lineBreak = normalized.lastIndexOf("\n", end);
			const sentenceBreak = Math.max(
				normalized.lastIndexOf(". ", end),
				normalized.lastIndexOf("? ", end),
				normalized.lastIndexOf("! ", end),
			);
			const boundary = Math.max(paragraphBreak, lineBreak, sentenceBreak);
			if (boundary > start + Math.floor(CHUNK_CHAR_TARGET * 0.45)) {
				end = boundary + 1;
			}
		}

		const chunk = normalized.slice(start, end).trim();
		if (chunk) {
			chunks.push(chunk);
		}

		if (end >= normalized.length) break;
		start = Math.max(end - CHUNK_CHAR_OVERLAP, start + 1);
	}

	return chunks;
}

export async function syncArtifactChunks(params: {
	artifactId: string;
	userId: string;
	conversationId?: string | null;
	contentText?: string | null;
}): Promise<void> {
	// Always delete existing chunks first
	await db
		.delete(artifactChunks)
		.where(eq(artifactChunks.artifactId, params.artifactId));

	if (!params.contentText?.trim()) return;

	// Small file bypass: store full content without chunking
	if (shouldBypassChunking(params.contentText.length)) {
		return;
	}

	const chunks = splitIntoChunks(params.contentText);
	if (chunks.length === 0) return;

	await db.insert(artifactChunks).values(
		chunks.map((chunk, index) => ({
			id: randomUUID(),
			artifactId: params.artifactId,
			userId: params.userId,
			conversationId: params.conversationId ?? null,
			chunkIndex: index,
			contentText: chunk,
			tokenEstimate: estimateTokenCount(chunk),
			updatedAt: new Date(),
		})),
	);
}
