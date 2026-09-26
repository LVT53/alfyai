/**
 * Where an artifact comment is attached — the ONE anchor type for the whole
 * family (rulings 11, 35 and 45). Declared here once; the server's
 * `services/artifacts/types.ts` re-exports it instead of declaring a second
 * union, because two unions for one concept is how they drift.
 *
 * - `text`  — a quote inside a Document block, with the words either side of
 *             it so a moved quote can be found again (slice 1 resolves it)
 * - `node`  — a Canvas node (slice 3 resolves it)
 * - `point` — a bare spot on a Canvas, in board coordinates (slice 3)
 *
 * The type only. Resolution (`exact | moved | orphaned`) is per kind and lands
 * with the kind that owns it; `parseArtifactAnchor` in
 * `services/artifacts/comments.ts` is the only parser.
 */
export type Anchor =
	| {
			kind: "text";
			blockId: string;
			quote: string;
			prefix: string;
			suffix: string;
	  }
	| { kind: "node"; nodeId: string }
	| { kind: "point"; x: number; y: number };

/**
 * Ruling 11's other half: one resolution outcome, shared by every per-type
 * resolver (this slice's `resolveTextAnchor` over text; Slice 3's node/point
 * resolver later). `blockId` names whatever the type's own unit of anchoring
 * is (a Document block today; a Canvas node later) — `null` only for the
 * orphan, alongside `from`/`to` of `-1` (T10.8), because there is no location
 * to report.
 */
export type AnchorState = "exact" | "moved" | "orphaned";

/** What the margin (or, later, the canvas) paints for a state — one small vocabulary, not one per type. */
export type AnchorTone = "normal" | "warning" | "faint";

export interface AnchorResolution {
	state: AnchorState;
	/** The current block/node id the anchor resolved to, or `null` when orphaned. */
	blockId: string | null;
	/** Character offsets of the resolved quote inside that block's text, or `-1`/`-1` when orphaned. */
	from: number;
	to: number;
}

/** The one shape every resolver returns for "nothing matched" (T10.8) — never rebuilt inline per type. */
export const ORPHANED_ANCHOR_RESOLUTION: AnchorResolution = {
	state: "orphaned",
	blockId: null,
	from: -1,
	to: -1,
};

/**
 * Score → state, the one mapping every resolver's scoring feeds through:
 * `>= 4` is confident enough to call it unchanged ("exact"), anything above
 * zero found the text somewhere weaker ("moved"), and zero is not found at
 * all ("orphaned"). The scoring itself — what earns which points — is each
 * type's own (`artifact-document/anchor.ts`'s `resolveTextAnchor` for text);
 * this function is the only place the three thresholds are written down.
 */
export function anchorStateFor(score: number): AnchorState {
	if (score >= 4) return "exact";
	if (score > 0) return "moved";
	return "orphaned";
}

/** State → tone. A second state that wanted the same tone would still call this, not hardcode it again. */
export function anchorTone(state: AnchorState): AnchorTone {
	switch (state) {
		case "exact":
			return "normal";
		case "moved":
			return "warning";
		case "orphaned":
			return "faint";
	}
}
