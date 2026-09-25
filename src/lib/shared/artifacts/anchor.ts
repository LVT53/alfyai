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
