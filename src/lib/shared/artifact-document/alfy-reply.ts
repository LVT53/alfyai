/**
 * Fixed, non-localized markers an `@Alfy` comment reply's body carries
 * instead of Alfy's own generated text (Feature 2 · Artifacts, Slice 1, Task
 * T10). The server writes one of these when there is nothing meaningful of
 * Alfy's own to show (a refusal, or an empty note on an otherwise-successful
 * change); `CommentCard.svelte` recognizes them and renders the matching
 * localized string (`artifacts.document.comment.alfyRefused` /
 * `...alfyDone`) instead of the literal marker.
 *
 * Never confused with real content: a human can never author a comment as
 * "alfy" (the create route hardcodes `author: "user"`), and a comment's body
 * never reaches an exported file (ruling 1 — comments are never part of an
 * artifact body), so these values are only ever read back through
 * `CommentCard.svelte`.
 */
export const ALFY_REFUSED_MARKER = "[[alfy:refused]]";
export const ALFY_EMPTY_REPLY_MARKER = "[[alfy:done]]";
