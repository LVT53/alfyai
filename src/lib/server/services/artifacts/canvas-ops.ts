// The Canvas's own service operations (Feature 2 · Artifacts, Slice 3), the
// twin of `document-ops.ts`: what a save of a board means, on top of the one
// write every kind goes through (`updateArtifactBody`).
import type { CanvasDropReport } from "$lib/shared/artifacts/canvas-body";
import { updateArtifactBody } from "./record";
import { prepareCanvasBoard } from "./serialize/canvas";
import type { ArtifactAuthor, ArtifactScopeOptions } from "./types";

function countOf(dropped: CanvasDropReport): {
	nodes: number;
	edges: number;
	annotations: number;
} {
	return {
		nodes: dropped.nodes.length,
		edges: dropped.edges.length,
		annotations: dropped.annotations.length,
	};
}

/**
 * The board panel's own save path — the Canvas's twin of `saveDocumentBody`.
 * The body a client sends is read without trust, refused past its caps, and
 * written in its canonical form (ruling 12), so what `updateArtifactBody`
 * stores and hashes is never the raw client JSON: a mere reopen cannot change a
 * hash, and a writer holding an old `baseHash` is refused for a real reason.
 * `dropped` counts what the server could not keep (a block of an unknown kind,
 * an edge to nothing, a stroke past the cap): a save that quietly loses
 * something must say so.
 *
 * The caller has already resolved the artifact as a canvas (the body route
 * dispatches on the kind, as it does for a Document); the ownership scope is
 * `updateArtifactBody`'s own.
 */
export async function saveCanvasBoard(
	params: {
		userId: string;
		artifactId: string;
		/** The board as the client serialised it. */
		body: string;
		author: ArtifactAuthor;
		summary: string;
		expectVersion?: number;
		baseHash?: string;
		coalesceUserEdits?: boolean;
	} & ArtifactScopeOptions,
): Promise<
	| {
			ok: true;
			version: number;
			bodyHash: string;
			dropped: { nodes: number; edges: number; annotations: number };
	  }
	| {
			ok: false;
			reason:
				| "not_found"
				| "too_large"
				| "stale"
				| "hash_mismatch"
				| "version_conflict"
				| "invalid_body";
	  }
> {
	const prepared = prepareCanvasBoard(params.body);
	if (!prepared.ok) {
		// A board past a cap is `too_large` whichever cap it was: one refusal
		// the route answers with 413.
		return {
			ok: false,
			reason: prepared.reason === "invalid_body" ? "invalid_body" : "too_large",
		};
	}
	const result = await updateArtifactBody({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
		includeIncognito: params.includeIncognito,
		body: prepared.json,
		author: params.author,
		summary: params.summary,
		expectVersion: params.expectVersion,
		baseHash: params.baseHash,
		coalesceUserEdits: params.coalesceUserEdits,
	});
	if (!result.ok) return { ok: false, reason: result.reason };
	return {
		ok: true,
		version: result.versionNumber,
		bodyHash: result.bodyHash,
		dropped: countOf(prepared.dropped),
	};
}
