// Generated-file readback: what happens when a generated binary's text finally
// arrives.
//
// A generated file is not an upload. There is no source artifact to normalize
// and no second artifact to create: the `generated_output` artifact already
// exists — `syncGeneratedFilesToMemory` writes it the moment the file is
// stored, so the file-production job can finish without waiting for a parser —
// and what the extraction produces is the one missing section of its memory
// wrapper. This module is the sink the extraction worker calls to fill that
// section in, and the single place that knows the wrapper's shape.
//
// Splitting the wrapper's tail out of `chat-files.ts` is what makes the two
// paths provably identical: the section written at creation time (usually "no
// readable text yet") and the section written here when the text lands are
// produced by the same function, so a readback leaves exactly the bytes the old
// inline `extractDocumentText` call used to leave.

import { and, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import { mapArtifact } from "$lib/server/services/knowledge/store/core";
import { queueArtifactSemanticEmbeddingRefresh } from "$lib/server/services/semantic-embedding-refresh";
import { syncArtifactChunks } from "$lib/server/services/task-state/chunk-sync";
import { parseJsonRecord } from "$lib/server/utils/json";
import { previewText } from "$lib/server/utils/text";
import { DocumentExtractionError } from "./contracts";
import {
	GENERATED_FILE_EXTRACT_PREVIEW_CHARS,
	GENERATED_FILE_EXTRACTED_CONTENT_LABEL,
	GENERATED_FILE_NO_EXTRACTION_TEXT,
} from "./generated-file-memory-format";
import {
	type ReadbackExtractionSink,
	setGeneratedFileReadbackSink,
} from "./worker-runner";

/**
 * The wrapper's wire format. It now lives in a dependency-free module of its
 * own (`./generated-file-memory-format`) so `read_generated_file` can share
 * these exact bytes without importing this file — and with it the extraction
 * worker, the extractor registry and a zip reader — into a chat turn's
 * bundle. Re-exported here because this module is where every existing caller
 * imports them from.
 */
export {
	GENERATED_FILE_EXTRACT_PREVIEW_CHARS,
	GENERATED_FILE_EXTRACTED_CONTENT_LABEL,
	GENERATED_FILE_NO_EXTRACTION_TEXT,
} from "./generated-file-memory-format";

/**
 * The wrapper's final section, in both of its shapes.
 *
 * With text it is a label line followed by the preview; without, it is one line
 * that says so. The two shapes are not symmetric, and deliberately so: the
 * marker `read_generated_file` looks for is `"\nExtracted file content:\n"`,
 * which the second shape does not contain, so a file whose text never arrived
 * falls back to the whole wrapper rather than returning an empty document.
 */
export function buildGeneratedFileExtractedContentSection(
	extractedText: string | null,
): string {
	const snippet = previewText(
		extractedText,
		GENERATED_FILE_EXTRACT_PREVIEW_CHARS,
	);
	return snippet
		? `${GENERATED_FILE_EXTRACTED_CONTENT_LABEL}\n${snippet}`
		: `${GENERATED_FILE_EXTRACTED_CONTENT_LABEL} ${GENERATED_FILE_NO_EXTRACTION_TEXT}`;
}

/**
 * Replaces the wrapper's final section, keeping everything above it byte for
 * byte.
 *
 * The head — filename, type, version, the prior-version list and the assistant
 * response excerpt — was computed when the file was stored and must not be
 * recomputed here: the prior-version list is a point-in-time answer, and asking
 * for it again now (with this file's own artifact in the table) would produce a
 * different, wrong one.
 */
export function applyExtractedTextToGeneratedFileMemoryContent(
	memoryContent: string,
	extractedText: string | null,
): string {
	const section = buildGeneratedFileExtractedContentSection(extractedText);
	const markerIndex = memoryContent.lastIndexOf(
		`\n${GENERATED_FILE_EXTRACTED_CONTENT_LABEL}`,
	);
	if (markerIndex < 0) {
		// No section to replace: a wrapper written by an older build, or an
		// artifact whose text was cleared. Appending keeps the invariant that the
		// extracted content is the last section.
		const head = memoryContent.replace(/\s+$/, "");
		return head ? `${head}\n\n${section}` : section;
	}
	// `markerIndex` points at the newline that starts the section's own line, so
	// the slice already ends with the blank separator line's first newline and
	// only one more is needed.
	return `${memoryContent.slice(0, markerIndex)}\n${section}`;
}

export interface CompleteGeneratedFileReadbackInput {
	userId: string;
	conversationId: string | null;
	chatGeneratedFileId: string;
	text: string;
	/**
	 * Carried by the seam for every extractor. Not stored: a page count on a
	 * generated_output artifact would surface in the attachment UI as a new,
	 * unasked-for fact about a file the user just generated. Uploads keep it
	 * (see `persist.ts`), generated files never had it.
	 */
	pageCount: number | null;
	structured?: unknown;
}

interface GeneratedOutputArtifactRow {
	id: string;
	conversationId: string | null;
	contentText: string | null;
}

/**
 * The `generated_output` artifact that stands for this chat file.
 *
 * Matched on `metadata.originalChatFileId` only. A source-first generated
 * document also lists its rendered chat files under
 * `generatedDocumentRenderedChatFileIds`, but those never reach the ledger —
 * they already carry canonical source text (ADR-0005) — so matching them here
 * could only ever overwrite good text with a parse of its own rendering.
 */
async function findGeneratedOutputArtifact(
	input: CompleteGeneratedFileReadbackInput,
): Promise<GeneratedOutputArtifactRow | null> {
	const scope = input.conversationId
		? and(
				eq(artifacts.userId, input.userId),
				eq(artifacts.type, "generated_output"),
				eq(artifacts.conversationId, input.conversationId),
			)
		: and(
				eq(artifacts.userId, input.userId),
				eq(artifacts.type, "generated_output"),
			);

	const rows = await db
		.select({
			id: artifacts.id,
			conversationId: artifacts.conversationId,
			contentText: artifacts.contentText,
			metadataJson: artifacts.metadataJson,
		})
		.from(artifacts)
		.where(scope)
		.orderBy(desc(artifacts.updatedAt));

	for (const row of rows) {
		const metadata = parseJsonRecord(row.metadataJson ?? null);
		const originalChatFileId =
			typeof metadata?.originalChatFileId === "string"
				? metadata.originalChatFileId.trim()
				: null;
		if (originalChatFileId === input.chatGeneratedFileId) {
			return {
				id: row.id,
				conversationId: row.conversationId ?? null,
				contentText: row.contentText ?? null,
			};
		}
	}

	return null;
}

/**
 * Writes the extracted text into the generated file's existing artifact, the
 * same way the inline path did: memory content, then chunks, then the embedding
 * refresh — in that order, because `createArtifact` uses that order and a chunk
 * set that disagrees with `contentText` is what breaks retrieval offsets.
 *
 * Runs outside any ledger transaction: the worker moves the job to `indexing`
 * first, so a crash in the middle stops the heartbeat and stale recovery
 * requeues the job rather than leaving it half-written and `succeeded`.
 */
export async function completeGeneratedFileReadback(
	input: CompleteGeneratedFileReadbackInput,
): Promise<{ artifactId: string; chunksTruncated: boolean }> {
	const artifact = await findGeneratedOutputArtifact(input);
	if (!artifact) {
		// The conversation or the file was deleted while the job was queued. The
		// job ends `failed` and stays there: there is nothing left to write onto,
		// and retrying would only re-run a parser for an artifact that is gone.
		throw new DocumentExtractionError({
			code: "internal",
			message: `No generated_output artifact remains for chat file ${input.chatGeneratedFileId}.`,
			retryable: false,
			details: { chatGeneratedFileId: input.chatGeneratedFileId },
		});
	}

	const nextContent = applyExtractedTextToGeneratedFileMemoryContent(
		artifact.contentText ?? "",
		input.text,
	);

	const [updated] = await db
		.update(artifacts)
		.set({
			contentText: nextContent,
			sizeBytes: Buffer.byteLength(nextContent, "utf8"),
			updatedAt: new Date(),
		})
		.where(
			and(eq(artifacts.id, artifact.id), eq(artifacts.userId, input.userId)),
		)
		.returning();

	if (!updated) {
		throw new DocumentExtractionError({
			code: "internal",
			message: `Generated_output artifact ${artifact.id} disappeared during readback.`,
			retryable: false,
		});
	}

	const sync = await syncArtifactChunks({
		artifactId: updated.id,
		userId: input.userId,
		conversationId: updated.conversationId,
		contentText: nextContent,
	});
	queueArtifactSemanticEmbeddingRefresh(mapArtifact(updated));

	return { artifactId: updated.id, chunksTruncated: sync.truncated };
}

const readbackSink: ReadbackExtractionSink = (input) =>
	completeGeneratedFileReadback({
		userId: input.userId,
		conversationId: input.conversationId,
		chatGeneratedFileId: input.chatGeneratedFileId,
		text: input.text,
		pageCount: input.pageCount,
		structured: input.structured,
	});

/**
 * Points the worker at this module's sink.
 *
 * Idempotent by construction — the worker holds one slot, not a list — so a
 * double import, an HMR re-evaluation or a test that called
 * `resetExtractionWorkerForTests()` all end with exactly one registration.
 *
 * Registration has to be synchronous and has to happen at import, not at the
 * first enqueue: a readback job queued before a restart is claimed by
 * `ensureExtractionWorker()` during server init, and a sink registered from a
 * promise would be racing that claim. `chat-files.ts` imports this module
 * statically and is itself on the boot import path (`hooks.server.ts` →
 * `memory-maintenance.ts` → `chat-files.ts`), so the slot is filled before
 * `init()` runs.
 */
export function ensureGeneratedFileReadbackSinkRegistered(): void {
	setGeneratedFileReadbackSink(readbackSink);
}

ensureGeneratedFileReadbackSinkRegistered();
