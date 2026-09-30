/**
 * The words for what goes wrong with a board, as ONE lazy entry: the panel body for
 * a board that could not be shown (`CanvasStates`), and the notices about saving one
 * (`CanvasBanners`). The editor fetches this the first time either is due, so a board
 * that opens and saves without trouble never carries any of it.
 */
export { default as CanvasBanners } from "./CanvasBanners.svelte";
export { default as CanvasStates } from "./CanvasStates.svelte";
