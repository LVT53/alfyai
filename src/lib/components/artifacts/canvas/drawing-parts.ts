/**
 * What drawing on a board is made of, as ONE lazy entry (Feature 2 · Artifacts,
 * Slice 3, T4): the layer that draws and edits the marks (with their geometry and
 * the freehand library) and the tray of tools and inks. The board imports this on
 * demand — when a tool that draws is chosen, or a board is opened that already has
 * marks — so a board nobody draws on never pays for any of it: the editor's own
 * chunk stays what the blocks need.
 *
 * The editor may not import any of it statically, and none of it may import
 * `@xyflow/svelte` (it would pull the library into a second chunk): the layer is
 * rendered inside the board's own `<ViewportPortal target="front">`.
 * `npm run check:artifact-chunks` passes `--allow-entry drawing-parts`.
 */
export { default as AnnotationLayer } from "./AnnotationLayer.svelte";
export { default as DrawTray } from "./DrawTray.svelte";
