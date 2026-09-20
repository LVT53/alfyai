// The `indexing` phase: everything `createNormalizedArtifact` used to do AFTER
// extraction, with the extraction call removed.
//
// It is a separate phase in the ledger rather than a tail on the parse because
// it is genuinely slow and genuinely different: `createArtifact` chunks the
// text, inserts every chunk row and queues an embedding refresh, which for a
// multi-megabyte markdown is thousands of writes. A UI that says "parsing"
// through all of it is lying about where the time is going.
//
// Runs OUTSIDE any ledger transaction. The job is moved to `indexing` first,
// this runs, and only then does the job go `succeeded` — so a crash in the
// middle leaves a job whose heartbeat stops, which stale recovery requeues.

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import {
	estimateDocumentTokenCount,
	extractDocumentOutline,
} from "$lib/server/services/knowledge/outline";
import {
	createArtifact,
	createArtifactLink,
	getNormalizedArtifactForSource,
	guessSummary,
	mapArtifact,
	updateArtifactMetadata,
} from "$lib/server/services/knowledge/store/core";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { queueArtifactSemanticEmbeddingRefresh } from "$lib/server/services/semantic-embedding-refresh";
import { syncArtifactChunks } from "$lib/server/services/task-state/chunk-sync";

export interface CreateNormalizedArtifactFromExtractionParams {
	userId: string;
	conversationId?: string | null;
	sourceArtifactId: string;
	sourceName: string;
	text: string;
	normalizedName: string;
	mimeType: string;
	pageCount?: number;
	/**
	 * Backend-specific structured payload. Opaque here until something narrows
	 * it with a type guard; carried so the seam does not have to be reopened to
	 * start using it.
	 */
	structured?: unknown;
}

/**
 * Text in, normalized artifact out.
 *
 * "Long-document comfort" (owner-approved mockup, 2026-09-06) is computed once
 * here and stored on BOTH artifacts: the normalized one carries the full text,
 * but the source artifact is the one shown to the user as an attachment chip,
 * so the token estimate and outline have to live there too.
 */
export async function createNormalizedArtifactFromExtraction(
	params: CreateNormalizedArtifactFromExtractionParams,
): Promise<Artifact> {
	const tokenEstimate = estimateDocumentTokenCount(params.text);
	const outline = extractDocumentOutline(params.text);
	const comfortMetadataPatch: Record<string, unknown> = {
		tokenEstimate,
		...(params.pageCount !== undefined ? { pageCount: params.pageCount } : {}),
		...(outline.length > 0 ? { outline } : {}),
	};

	const metadata = {
		sourceArtifactId: params.sourceArtifactId,
		normalizedFrom: params.sourceName,
		...comfortMetadataPatch,
	};

	// A source document may only ever have ONE normalized artifact.
	//
	// A second extraction of the same source is not hypothetical: a worker that
	// dies between the artifact insert and `completeExtractionAttempt` leaves an
	// `indexing` job that stale recovery requeues, and a cancel that lands while
	// the chunk inserts are running does the same thing in a second. Creating a
	// fresh artifact on that second pass is worse than a duplicate row —
	// `getNormalizedArtifactForSource` orders by the link's `created_at` and
	// takes the FIRST, so the prompt pipeline would keep reading the OLD text
	// while the ledger's `normalized_artifact_id` pointed at the new one, and
	// both artifacts' chunks would answer the same retrieval query.
	//
	// Rewriting the existing artifact in place keeps the id (so every
	// `derived_from` link, working-set item and evidence link stays valid) and
	// makes a re-extraction idempotent.
	const existing = await getNormalizedArtifactForSource(
		params.userId,
		params.sourceArtifactId,
	);
	const artifact = existing
		? await rewriteNormalizedArtifact({
				existingId: existing.id,
				userId: params.userId,
				normalizedName: params.normalizedName,
				mimeType: params.mimeType,
				text: params.text,
				sourceName: params.sourceName,
				metadata,
			})
		: await createNewNormalizedArtifact({ params, metadata });

	await updateArtifactMetadata({
		artifactId: params.sourceArtifactId,
		userId: params.userId,
		patch: comfortMetadataPatch,
	});

	return artifact;
}

async function createNewNormalizedArtifact(input: {
	params: CreateNormalizedArtifactFromExtractionParams;
	metadata: Record<string, unknown>;
}): Promise<Artifact> {
	const { params, metadata } = input;
	const artifact = await createArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		type: "normalized_document",
		name: params.normalizedName,
		mimeType: params.mimeType,
		extension: "txt",
		sizeBytes: Buffer.byteLength(params.text, "utf8"),
		storagePath: null,
		contentText: params.text,
		summary: guessSummary(params.text, params.sourceName),
		metadata,
	});

	await createArtifactLink({
		userId: params.userId,
		artifactId: artifact.id,
		relatedArtifactId: params.sourceArtifactId,
		conversationId: params.conversationId,
		linkType: "derived_from",
	});

	return artifact;
}

/**
 * The re-extraction path. Same work `createArtifact` does — row, chunks,
 * embedding refresh — against an id that already exists, and no second
 * `derived_from` link, because the one that made this artifact findable is
 * still there.
 */
async function rewriteNormalizedArtifact(input: {
	existingId: string;
	userId: string;
	normalizedName: string;
	mimeType: string;
	text: string;
	sourceName: string;
	metadata: Record<string, unknown>;
}): Promise<Artifact> {
	const [updated] = await db
		.update(artifacts)
		.set({
			name: input.normalizedName,
			mimeType: input.mimeType,
			sizeBytes: Buffer.byteLength(input.text, "utf8"),
			contentText: input.text,
			summary: guessSummary(input.text, input.sourceName),
			metadataJson: JSON.stringify(input.metadata),
			updatedAt: new Date(),
		})
		.where(eq(artifacts.id, input.existingId))
		.returning();

	if (!updated) {
		throw new Error(
			`Normalized artifact ${input.existingId} disappeared during re-extraction`,
		);
	}

	const mapped = mapArtifact(updated);
	await syncArtifactChunks({
		artifactId: mapped.id,
		userId: mapped.userId,
		conversationId: mapped.conversationId,
		contentText: mapped.contentText,
	});
	queueArtifactSemanticEmbeddingRefresh(mapped);

	return mapped;
}

/**
 * @deprecated Use `createNormalizedArtifactFromExtraction`. Kept for one
 * release so a caller written against the earlier name still compiles.
 */
export const createNormalizedArtifactFromText =
	createNormalizedArtifactFromExtraction;

export type PersistExtractionResultDependency =
	typeof createNormalizedArtifactFromExtraction;
