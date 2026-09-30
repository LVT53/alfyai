/**
 * The Canvas's half of the one comment layer (ruling 11): the shape of a
 * per-kind anchor resolver and the board's own. Threads, status, replies and
 * the `@Alfy` hook are the server's (`services/artifacts/comments.ts`, over the
 * one `artifact_comments` table); the anchor union and the three-state
 * resolution every kind answers with are `anchor.ts`'s (ruling 45), imported
 * here and never redeclared. What is left for this file is what only a board
 * decides: a `node` anchor is exact while its block exists and orphaned once it
 * does not, a `point` is never invalidated by an edit to the board, and a
 * `text` anchor is not a board's to resolve.
 *
 * Pure and client-safe (no server import): the browser resolves against the
 * blocks it is drawing, the server reads `kinds` to refuse a thread a board
 * cannot place, and both use the one function.
 */
import {
	type Anchor,
	type AnchorResolution,
	ORPHANED_ANCHOR_RESOLUTION,
} from "./anchor";

/**
 * One resolver per artifact kind, over whatever that kind's body holds
 * (`Context`): the anchor and the body in, a resolution out, no I/O.
 */
export interface AnchorResolver<Context> {
	/** Which anchor kinds this artifact can place; a kind outside the list is refused at intake. */
	readonly kinds: readonly Anchor["kind"][];
	resolve(anchor: Anchor, context: Context): AnchorResolution;
}

/** A board's resolution says why an orphan is one: the block it was on is gone. */
export type CanvasAnchorResolution = AnchorResolution & {
	reason?: "node_missing";
};

export const canvasAnchorResolver: AnchorResolver<readonly { id: string }[]> = {
	kinds: ["node", "point"],
	resolve(anchor, nodes): CanvasAnchorResolution {
		switch (anchor.kind) {
			case "node":
				return nodes.some((node) => node.id === anchor.nodeId)
					? { state: "exact", blockId: anchor.nodeId, from: 0, to: 0 }
					: { ...ORPHANED_ANCHOR_RESOLUTION, reason: "node_missing" };
			// A spot on the board stays where it was left, whatever else changes.
			case "point":
				return { state: "moved", blockId: null, from: 0, to: 0 };
			case "text":
				return ORPHANED_ANCHOR_RESOLUTION;
		}
	},
};

const ALFY_MENTION = /@alfy\b/i;

/** Whether a comment asks Alfy for something: the button reads "Ask Alfy" and the hook runs. */
export function mentionsAlfy(body: string): boolean {
	return ALFY_MENTION.test(body);
}
