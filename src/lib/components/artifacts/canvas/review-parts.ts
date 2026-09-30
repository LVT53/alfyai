/**
 * The one lazy entry of Alfy's change on a board (Feature 2 · Artifacts, Slice 3,
 * T6 and ruling 63): the controller that holds the change, the layer drawn on the
 * board (the arranging frame, the rings, the pill), the bar below it and the
 * notices above it. The editor loads this with one dynamic `import()`, when a
 * change arrives from the chat or a comment, or a board is found with one waiting,
 * so a board nobody changes never pays for any of it.
 *
 * The editor may not import any of it statically, and none of it may import
 * `@xyflow/svelte` (it would pull the library into a second chunk): the layer is
 * rendered inside the editor's own `<ViewportPortal target="front">`.
 * `npm run check:artifact-chunks` passes `--allow-entry review-parts`.
 */
export {
	CanvasReviewController,
	changeLayerProps,
} from "./_lib/review-controller.svelte";
export { default as AlfyChangeLayer } from "./AlfyChangeLayer.svelte";
export { default as CanvasReviewBar } from "./CanvasReviewBar.svelte";
export { default as CanvasReviewNotices } from "./CanvasReviewNotices.svelte";
