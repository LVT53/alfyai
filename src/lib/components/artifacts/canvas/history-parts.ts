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
 * Nothing static may import it, and it imports no module the editor's first
 * paint alone owns: `npm run check:artifact-chunks` holds the editor's closure to
 * its ceiling with this entry built (it is a lazy part of the editor's family,
 * `--allow-entry artifacts/canvas/`).
 */
export { default } from "./CanvasVersionPreview.svelte";
