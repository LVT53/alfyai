/**
 * The limits on what a board's blocks hold. Generous on purpose: the board's real
 * cap is its byte size, and a limit that drops a node on the user's own save is
 * worse than a long note. These only exist so a runaway value is refused with a
 * reason. The board's own inputs enforce the same numbers (`maxlength`), because a
 * node past them is DROPPED on save, not clipped.
 *
 * Their own module, and not part of `canvas-blocks.ts` (which re-exports them),
 * so client code that needs only a number does not import every block schema: a
 * module the editor shares with a chunk that loads on demand is split out of the
 * editor's own chunk to make that possible, and that costs the editor's first
 * paint.
 */
export const LABEL_MAX_CHARS = 500;
export const TEXT_MAX_CHARS = 20_000;
export const CHECKLIST_MAX_ITEMS = 200;
export const CHECKLIST_ITEM_MAX_CHARS = 1_000;
