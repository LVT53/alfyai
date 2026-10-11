/**
 * The one lazy entry of a board's preview in History (ruling 76, versioning.md
 * §5.4, ruling 68's pattern): the read-only board with the diff layer, the
 * "New" and "Moved" tags, the trails and the ghosts. History's per-kind registry
 * (`history/history-previews.ts`) imports this with `import()` when a reader opens
 * History on a board, so neither the chat page nor the editor's first paint ever
 * pays for any of it. The preview draws a board of its own with the editor's own
 * `CanvasBoard` (every block looks as it does when it is edited), so it opens
 * with a Canvas panel, where that code is already loaded.
 *
 * Only `CanvasEditor.svelte` imports it (`loadHistoryPreview`, with `import()`),
 * never History's registry and never anything static, and it imports neither the
 * board nor the flow library: the editor hands them over (`provideBoardParts`).
 * The bundler puts a module that two lazy entries both import into a chunk of its
 * own, so a preview that imported `CanvasBoard` would split the board and the
 * library out of the editor's chunk, and the editor's first paint would pay for
 * the split. `npm run check:artifact-chunks` holds the editor's closure to its
 * ceiling with this entry built (it is a lazy part of the editor's family,
 * `--allow-entry artifacts/canvas/`).
 */
export { default, provideBoardParts } from "./CanvasVersionPreview.svelte";
