import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getSmallFileThreshold } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { artifactChunks } from "$lib/server/db/schema";
import { estimateTokenCount } from "$lib/utils/tokens";

const CHUNK_CHAR_TARGET = 1400;
const CHUNK_CHAR_OVERLAP = 220;

/**
 * Rows per INSERT statement.
 *
 * Every row binds 8 parameters, and better-sqlite3 refuses a statement with
 * more than SQLITE_MAX_VARIABLE_NUMBER (32766) of them — 4095 rows. One
 * multi-values INSERT therefore threw `too many SQL variables` on any document
 * over roughly 4.8 MB, which the 100 MB upload limit allows and which Phase 1
 * made reachable: the code/text extensions that now take the direct-text route
 * (a .log, a .sql dump, a .json export) arrive as one long string.
 *
 * 500 leaves an order of magnitude of headroom if the row ever gains columns.
 */
const CHUNK_INSERT_BATCH_ROWS = 500;

/**
 * The most chunk rows one artifact may have. A safety net, not a product
 * limit.
 *
 * Sized so that the largest document the app admits without a backend still
 * chunks in full: the direct-text cap is 8 MiB
 * (`DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES`), the chunker advances
 * `CHUNK_CHAR_TARGET - CHUNK_CHAR_OVERLAP` = 1180 characters per chunk, so the
 * worst case — 8 MiB of single-byte characters — is about 7 110 rows. 12 000
 * leaves that whole range untouched with room for a smaller target later, and
 * still stops a pathological input (a parser that returns a 500 MB string, a
 * future backend with no cap of its own) from inserting hundreds of thousands
 * of rows and queueing as many embedding calls.
 *
 * Truncation is REPORTED, never silent: `syncArtifactChunks` returns
 * `truncated`, the extraction worker records it on the attempt's diagnostics,
 * and the artifact carries `chunksTruncated` in its metadata — so "retrieval
 * only sees the first 12 000 chunks of this file" is a fact someone can find
 * rather than a mystery about missing search hits.
 */
export const MAX_ARTIFACT_CHUNKS = 12_000;

export interface SyncArtifactChunksResult {
	chunkCount: number;
	/** true when the text produced more chunks than the ceiling allows. */
	truncated: boolean;
	/** How many chunks the text would have produced. Equals `chunkCount` when not truncated. */
	totalChunks: number;
}

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
			// The boundary search only ever accepts a result past
			// `start + 45% of the target`, so it need not look before `start` —
			// but `lastIndexOf(needle, end)` scans the whole prefix when the
			// needle is absent, which made this loop quadratic. A log with no
			// sentence punctuation took 23 s of blocking CPU at 5 MB and 98 s at
			// 10 MB; windowing it is 13 ms. Two windows because a two-character
			// needle may start at `end` and finish at `end + 1`, while a
			// one-character needle may only start at `end`.
			const pairWindow = normalized.slice(start, end + 2);
			const charWindow = normalized.slice(start, end + 1);
			const relative = Math.max(
				pairWindow.lastIndexOf("\n\n"),
				charWindow.lastIndexOf("\n"),
				pairWindow.lastIndexOf(". "),
				pairWindow.lastIndexOf("? "),
				pairWindow.lastIndexOf("! "),
			);
			const boundary = relative < 0 ? -1 : start + relative;
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
}): Promise<SyncArtifactChunksResult> {
	const allChunks =
		params.contentText?.trim() &&
		// Small file bypass: store full content without chunking.
		!shouldBypassChunking(params.contentText.length)
			? splitIntoChunks(params.contentText)
			: [];

	const truncated = allChunks.length > MAX_ARTIFACT_CHUNKS;
	const chunks = truncated ? allChunks.slice(0, MAX_ARTIFACT_CHUNKS) : allChunks;

	if (truncated) {
		console.warn("[CHUNK_SYNC] Chunk ceiling reached; retrieval is partial", {
			artifactId: params.artifactId,
			userId: params.userId,
			totalChunks: allChunks.length,
			keptChunks: chunks.length,
			maxChunks: MAX_ARTIFACT_CHUNKS,
		});
	}

	const rows = chunks.map((chunk, index) => ({
		id: randomUUID(),
		artifactId: params.artifactId,
		userId: params.userId,
		conversationId: params.conversationId ?? null,
		chunkIndex: index,
		contentText: chunk,
		tokenEstimate: estimateTokenCount(chunk),
		updatedAt: new Date(),
	}));

	// The delete and every insert batch share one transaction: a failure part
	// way through must not leave the artifact with the first 500 chunks of its
	// new text and none of the old ones. better-sqlite3 is synchronous, so the
	// callback is too — this is the same shape every other transaction in the
	// tree uses.
	db.transaction((tx) => {
		tx.delete(artifactChunks)
			.where(eq(artifactChunks.artifactId, params.artifactId))
			.run();

		for (let start = 0; start < rows.length; start += CHUNK_INSERT_BATCH_ROWS) {
			tx.insert(artifactChunks)
				.values(rows.slice(start, start + CHUNK_INSERT_BATCH_ROWS))
				.run();
		}
	});

	return {
		chunkCount: rows.length,
		truncated,
		totalChunks: allChunks.length,
	};
}
