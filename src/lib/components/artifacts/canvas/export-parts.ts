/**
 * What a picture of the board is made of, as ONE lazy entry (Feature 2 ·
 * Artifacts, Slice 3, T7): the controller that takes the still images of the
 * blocks a picture cannot carry live and draws the export, the renderer it brings
 * (`html-to-image`), and the Download popover that shows how it went. The editor
 * imports this on demand — when the board has an App, a map, photos or live web
 * whose still image is due, or the reader presses Download — so a board with
 * neither, and a reader who never exports, never pay for any of it: the editor's
 * own chunk stays what the drawing and the blocks need.
 *
 * The editor may not import any of it statically, and none of it may import
 * `@xyflow/svelte` (it would pull the library into a second chunk): it asks the
 * board for what it needs through `PicturesBoard`. `npm run check:artifact-chunks`
 * passes `--allow-entry export-parts`.
 */
export { CanvasPicturesController } from "./_lib/pictures-controller.svelte";
export { default as CanvasDownload } from "./CanvasDownload.svelte";
