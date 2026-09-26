/**
 * The two identifiers `extensions.ts` and `marks.ts` both need to name the
 * same ProseMirror attribute/node type. Pulled out on its own, with zero
 * imports, so the two files can reference each other's exports (`marks.ts`'s
 * `AlfyChange` mark is registered in `extensions.ts`'s extension list; `undo`
 * in `marks.ts` locates a block by this same attribute) without a circular
 * `extensions.ts` → `marks.ts` → `extensions.ts` import — Fallow's circular-
 * dependency gate (slice-1.md's Gates) is a named check this slice must not
 * add a new finding to.
 */
export const BLOCK_ID_ATTR = "blockId";
export const BLOCK_MARKER_NODE = "blockMarker";
