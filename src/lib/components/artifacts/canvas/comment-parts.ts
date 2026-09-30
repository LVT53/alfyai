/**
 * What the board's comments are made of, as ONE lazy entry: the pins and the
 * catcher, the list, and the controller that holds their state. The editor
 * imports this on demand (a board that has threads, a reader who presses
 * Comment or picks the tool), so a board nobody comments on never pays for any
 * of it: the editor's own chunk stays what the drawing and the blocks need.
 */
export { CanvasCommentsController } from "./_lib/comments-controller.svelte";
export { default as CanvasComments } from "./CanvasComments.svelte";
export { default as CommentCatcher } from "./CommentCatcher.svelte";
export { default as CommentPins } from "./CommentPins.svelte";
