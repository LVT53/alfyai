/**
 * What picking and moving SEVERAL blocks needs beyond the library's own selection,
 * as ONE lazy entry (the owner's walk: "multi-select ... move them/resize them
 * together"): the box with its handles and toolbar (and the arithmetic that scales
 * the blocks with it), and the long press a finger uses to start a selection. The
 * board imports this on demand: when a selection first has two blocks, or at once on
 * a device whose pointer is coarse, so a board nobody picks two blocks on never pays
 * for any of it and the editor's first paint stays what the blocks need.
 *
 * The editor may not import any of it statically, and none of it may import
 * `@xyflow/svelte` (it would pull the library into a second chunk): the box is
 * rendered inside the board's own flow and is handed what it needs.
 */
export { watchTouchSelection } from "./_lib/touch-select";
export { default as GroupBox } from "./GroupBox.svelte";
