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

import {
	estimateDocumentTokenCount,
	extractDocumentOutline,
} from "$lib/server/services/knowledge/outline";
import {
	createArtifact,
	createArtifactLink,
	guessSummary,
	updateArtifactMetadata,
} from "$lib/server/services/knowledge/store/core";
import type { Artifact } from "$lib/server/services/knowledge/types";

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
		metadata: {
			sourceArtifactId: params.sourceArtifactId,
			normalizedFrom: params.sourceName,
			...comfortMetadataPatch,
		},
	});

	await createArtifactLink({
		userId: params.userId,
		artifactId: artifact.id,
		relatedArtifactId: params.sourceArtifactId,
		conversationId: params.conversationId,
		linkType: "derived_from",
	});

	await updateArtifactMetadata({
		artifactId: params.sourceArtifactId,
		userId: params.userId,
		patch: comfortMetadataPatch,
	});

	return artifact;
}

/**
 * @deprecated Use `createNormalizedArtifactFromExtraction`. Kept for one
 * release so a caller written against the earlier name still compiles.
 */
export const createNormalizedArtifactFromText =
	createNormalizedArtifactFromExtraction;

export type PersistExtractionResultDependency =
	typeof createNormalizedArtifactFromExtraction;
