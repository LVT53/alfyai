/**
 * The review state of an artifact, whichever kind it is (ruling 61 for a
 * Document, ruling 63 for a board): one place that reads the artifact's kind
 * inside the caller's ownership scope and asks that kind's own review, so the
 * route stays an HTTP adapter and never learns which kinds have one. A kind
 * with no review (App, File) answers like a missing id: there is nothing here to
 * tell it apart, and a 404 must not confirm that an id exists.
 */
import type { CanvasReviewState } from "$lib/shared/artifacts/canvas-review";
import { acknowledgeCanvasReview, getCanvasReviewState } from "./canvas-review";
import {
	acknowledgeDocumentReviewBlocks,
	type DocumentReviewPendingBlock,
	getDocumentReviewState,
} from "./document-ops";
import { kindForArtifactRow, readScopedArtifactRow } from "./record";
import type { ArtifactScopeOptions } from "./types";

export type ArtifactReviewResult =
	| { ok: true; kind: "document"; pending: DocumentReviewPendingBlock[] }
	| { ok: true; kind: "canvas"; review: CanvasReviewState }
	| { ok: false; reason: "not_found" };

const NOT_FOUND = { ok: false, reason: "not_found" } as const;

export async function getArtifactReviewState(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<ArtifactReviewResult> {
	const row = await readScopedArtifactRow(params);
	if (!row) return NOT_FOUND;
	const kind = kindForArtifactRow(row);
	if (kind === "canvas") {
		const result = await getCanvasReviewState(params);
		return result.ok ? { ok: true, kind, review: result.review } : NOT_FOUND;
	}
	if (kind === "document") {
		const result = await getDocumentReviewState(params);
		return result.ok ? { ok: true, kind, pending: result.pending } : NOT_FOUND;
	}
	return NOT_FOUND;
}

/**
 * Keep, Undo, Keep all and Undo all all acknowledge. A Document names the
 * blocks it just resolved (`blockIds`); a board is reviewed as one change, so
 * it names the newest version of Alfy's it was shown (`throughVersion`).
 */
export async function acknowledgeArtifactReview(
	params: {
		userId: string;
		artifactId: string;
		blockIds?: string[];
		throughVersion?: number;
	} & ArtifactScopeOptions,
): Promise<ArtifactReviewResult> {
	const row = await readScopedArtifactRow(params);
	if (!row) return NOT_FOUND;
	const kind = kindForArtifactRow(row);
	if (kind === "canvas") {
		const result = await acknowledgeCanvasReview({
			...params,
			throughVersion: params.throughVersion ?? 0,
		});
		return result.ok ? { ok: true, kind, review: result.review } : NOT_FOUND;
	}
	if (kind === "document") {
		const result = await acknowledgeDocumentReviewBlocks({
			...params,
			blockIds: params.blockIds ?? [],
		});
		return result.ok ? { ok: true, kind, pending: result.pending } : NOT_FOUND;
	}
	return NOT_FOUND;
}
