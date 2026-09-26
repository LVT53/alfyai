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

/**
 * RV-1B, coordinator item 8: appended to (never replacing, unlike the two
 * whole-body markers above) an `@Alfy` reply's own note when the SAME
 * request applied at least one op AND refused at least one other —
 * `runAlfyCommentReply`'s `ops` array can hold more than one op against the
 * comment's anchored block, and every op in it shares the SAME `baseHash`
 * (the block as Alfy first read it), so an EARLIER op that changes the block
 * routinely leaves a LATER one refused `block_changed` in the very same
 * request. Before this, the model's own "note" only ever describes what it
 * DID change, never what it could not, so a partially-refused `@Alfy` reply
 * read in the thread as an unqualified, silent success. `CommentCard.svelte`
 * strips this suffix back off before matching the two markers above, so a
 * partial refusal on an otherwise-empty note (`ALFY_EMPTY_REPLY_MARKER`)
 * still renders its own localized text rather than the raw marker.
 */
export const ALFY_PARTIAL_REFUSAL_SUFFIX = "\n\n[[alfy:partial-refusal]]";
