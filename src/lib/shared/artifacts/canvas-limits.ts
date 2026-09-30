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
/** How many photos one photo block holds, and how many sources one live-web block does. */
export const PHOTO_MAX_ITEMS = 50;
export const SOURCES_MAX = 50;

/**
 * What a picture of a board may weigh when it reaches the server: the export the
 * reader downloads, and the still image (poster) of one block. Both are PNGs the
 * browser drew, so they are bounded by what it can draw — the export by the
 * clamp of 2,400 x 1,800 (twice that on a dense display), a poster by 640 x 400 —
 * and these caps only refuse a request that is neither.
 */
export const EXPORT_PNG_MAX_BYTES = 10 * 1024 * 1024;
export const POSTER_PNG_MAX_BYTES = 1536 * 1024;
