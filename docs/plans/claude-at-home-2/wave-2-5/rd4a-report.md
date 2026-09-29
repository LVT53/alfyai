# Agent 4a report — selection pill/composer, in-place writing, pinned refusal

Worktree `.claude/worktrees/art-rd4a`, branch `feat/artifacts-rd4a-compose`, port 5430.
Commit range: `f1c29be8..986a3fa5` (14 commits, `git log --oneline f1c29be8..HEAD`).

## Step 9 · Selection pill and composer

- **`bubble-placement.ts`**: added `COMPOSER_BUBBLE_SIZE` (340×320), the composer's own
  footprint. `DocumentBody.svelte`'s `updateSelectionBubble` now always computes placement
  against this size (never the small pill's), so growing the pill into the composer in place
  never needs a re-flip. `DEFAULT_BUBBLE_SIZE` stayed un-exported (fallow caught the unused
  export once nothing outside the file needed it anymore).
- **`SelectionBubble.svelte`** (full rewrite): a horizontal pill (`role="toolbar"`, named
  "Selection") with "✦ Ask Alfy · 💬 Comment"; the SAME element grows in place into a 340px
  composer (CSS width transition + a content fade-in 80ms after, both covered by app.css's
  existing global reduced-motion override — no new JS needed for that part). Ask mode: header
  naming the truncated quote, a clean textarea (no visible `@Alfy` prefill — the OLD prefill
  trick this redesign explicitly replaces), four suggestion chips, the effect line, and a Send
  button that stays labelled "Ask Alfy" but transparently prefixes `@Alfy ` on submit so
  `DocumentBody.svelte`'s existing `mentionsAlfy(body)` gate (unchanged) still routes it through
  the Ask-Alfy reply. Comment mode: the same textarea, the "Mention @Alfy…" hint, and the
  send button's own "@Alfy switch" — it relabels to "Ask Alfy" the moment the draft mentions
  `@Alfy`, matching the exact behaviour without the caller needing to know about it.
  `onSubmit(body, sourceRect)` now hands back the composer's own on-screen rect (`null` on a
  phone) for the travel animation below.
  - Phones: `isPhoneViewport()`/`watchPhoneViewport` (existing `$lib/utils/viewport.svelte.ts`
    helpers, read synchronously at init so the FIRST render already picks the right
    presentation) switch to a full-width docked bar (`position: fixed`, not `sticky` — see
    Deviations) and route the composer through `DialogShell phonePresentation="sheet"` instead
    of growing in place.
  - Escape dismisses the pill from a **window-level** keydown listener (not just a local
    `onkeydown` on the toolbar div), so it works regardless of where focus actually is — the
    pill's own buttons are never auto-focused. Same effect also owns ⌘/Ctrl+Alt+M (opens
    Comment directly).
- **`DocumentBody.svelte`**: `selectionBubble` state now also carries `quote` (from
  `readSelectionAnchorContext`). `postComment` returns the created comment's id. New
  `handleSelectionSubmit(anchor, body, sourceRect)` drives motion #9 ("the composer's box
  travels to the new thread's place in the margin and becomes the card"): a cloned ghost `div`
  (inline-styled, not a Svelte component) animates via `reducedMotionAnimate` from the
  composer's captured rect to the new comment's own rect (found via
  `[data-comment-id="…"]` inside the rail, which rd3a's own `MarginPanel.svelte` already
  stamps on every card), then the real card gets a 150ms-delayed WAAPI fade-in applied directly
  to its DOM node. Skipped entirely under reduced motion, when `sourceRect` is `null` (phone —
  nothing to travel from), or when the target card can't be found (best-effort).
  `updateSelectionBubble` also sets/clears a new "selection pending" decoration
  (`setSelectionPendingFn`) whenever the bubble is shown/hidden, using the LIVE selection's own
  raw ProseMirror positions (see the simplification below) rather than resolving through the
  comment-anchor system.

## Step 11 · Alfy writing, refusal, typing

- **New `alfy-writing-decoration.ts`** (registered from `extensions.ts` with a 3-line spread):
  three small ProseMirror decorations, all following the SAME shape rd1/rd3a's own
  `CommentAnchors`/`tabSectionPluginKey` established (plugin state only, written via a
  no-op-for-history transaction):
  1. **In-place "Alfy is writing"** — a `Decoration.node` (`.alfy-writing-block`, gutter bar +
     dimmed text) plus a `Decoration.widget` (`.alfy-writing-tag`, the inline "✦ Alfy is
     writing…" tag) at the block's end. Wired from `maybeAskAlfy` (the composer-driven Ask-Alfy
     reply), where the target block is known **synchronously** — unlike the T8-live
     chat-tool-call path, whose own `DocumentAlfyActivity.patches` is deliberately empty while
     `status === "running"` (`alfy-activity.ts`'s own doc comment: "there is nothing to mark
     until the call has settled"). That path keeps the existing global `AlfyWriting.svelte`
     banner — restyled (see below) but functionally unchanged — since it has no block to point
     at. Held for **at least 600ms** even once the reply settles (`ALFY_WRITING_MIN_VISIBLE_MS`),
     scheduled via `setTimeout` rather than awaited, so it never delays applying the result.
     Tested with fake timers (`DocumentBody.test.ts`).
  2. **Selection-pending highlight** (`.selection-pending`) — originally designed around
     block-relative character offsets (mirroring a comment anchor's own resolution), then
     simplified to take the live selection's raw PM positions directly once I realised this
     highlight, unlike a comment anchor, never needs to survive a reload or an edit — see the
     dedicated commit for the full reasoning. Net simplification, not added scope.
  3. **Refused-line dashed rule** (`.alfy-refused-line`) — every refused block from
     `landAlfyActivity`'s own `summarizeRefusalsFn` output, via `setRefusedLinesFn`.
- **`RefusalNotice.svelte`**: redesigned as the warning-card variant of the comment family —
  `CircleSlash` + `--warning-tint`/`--warning-text`, matching `CommentCard.svelte`'s own
  refusal treatment exactly (rd3a's hand-off: "the two should read as the same family"). New
  optional `askAgainLabel`/`onAskAgain` and `dismissLabel`/`onDismiss`, additive to the
  existing props — every existing test/behaviour kept working unchanged.
  `DocumentBody.svelte`'s `refusalNotice` state gained `refusedBlockIds`; `dismissRefusalNotice`
  clears the card and its line's dashed rule together; `handleAskAgainRefusal` re-selects the
  first refused block and scrolls to it (`selectAndScrollToBlockFn`, new in
  `document-editor.ts`, mirroring `changeMarkRect`/`scrollToChange`'s own shape) — re-surfacing
  the ordinary selection pill there, the same flow a user reaches by selecting text themselves,
  rather than jumping straight into an open composer.
  **Exported for agent 4b's review bar**: `artifacts.document.refused.reviewBarLeft` ("Left
  {count} alone.") — the exact mockup copy (`revLeft`) for whatever renders "✦ Alfy changed N
  parts. Left M alone." `refusalNotice.refusedBlockIds.length` is the count to read; `askAgain`
  reuses the EXISTING `artifacts.document.comment.askAgain` key (not the mockup's own slightly
  different HU string) so it reads as the same word as `CommentCard`'s refusal variant.
- **`AlfyWriting.svelte`**: restyled as the dashed "planned section" box (mirrors the mockup's
  `.planned` box exactly — dashed accent border, tinted background) for the T8-live path where
  no specific block is known yet. Same props/testid/`aria-live` — a CSS-only change.
- **The in-chat card's "1 part left alone" pill** (rd5a's own flagged gap): `ArtifactCardView`
  gained `refusedCount` (chrome="full" only); `ArtifactCard.svelte` renders it as its own
  `CircleSlash`/`--warning-tint` pill beside the existing `pendingReviewCount` one, and "Review"
  now also shows for a refusal alone (not only a pending change).
  `ToolActivityRow.svelte`'s `artifactCardView` computes both from the SAME `alfyActivity` — and
  along the way fixed a real bug in the process: `pendingReviewCount` used
  `Math.max(alfyActivity.appliedCount, 1)`, a stopgap from before this pill existed (rd5a's own
  deviation note) so a fully-refused call still showed SOMETHING. A fully refused call
  (`appliedCount === 0`) now correctly shows only "N parts left alone", never a misleading "1
  change to review" for zero actual changes. Applied the identical fix to
  `DocumentWorkspace.svelte`'s `artifactCardViewFor`, which its own comment says mirrors this
  exactly — no new pill on the panel list row itself (out of scope per the brief, which scopes
  "left alone" to the in-chat card only).
- **Typing placeholder in threads**: left as rd3a already built it (`comment-thread-typing`,
  dots + a single "Alfy is writing…" label while `posting && mentionsAlfy`) — see Deviations.

## Tests added

- `bubble-placement.test.ts`: composer-vs-pill placement sizing (+1 test).
- `alfy-writing-decoration.test.ts` (new file, 12 tests): all three decorations, built against a
  real Tiptap editor (mirrors `extensions.test.ts`'s own `mountEditor` pattern) — target/clear,
  multiple refused blocks, missing-block/stale-range defensiveness.
- `document-editor.test.ts` (+9 tests): `setAlfyWritingBlock`/`setSelectionPending`/
  `setRefusedLines` (write side + no-undo-step), `blockRect`, `selectAndScrollToBlock`. Caught a
  real bug here: the three plugins' `apply()` used `tr.getMeta(key) ?? value`, which treats an
  explicitly-dispatched `null` (this feature's own "clear the target" signal) as "nothing set"
  and falls back to stale state, since `null` is nullish — fixed with a small `applyMetaOrNull`
  helper that distinguishes the two.
- `SelectionBubble.test.ts` (full rewrite, 16 tests): pill, Ask/Comment composer contents +
  chips + effect line, the @Alfy switch, submit body/rect, Cancel/Escape (including the new
  window-level Escape), Cmd/Ctrl+Enter, phone docked bar + sheet, accessible names.
- `RefusalNotice.test.ts` (+3 tests): Ask again/Dismiss, absence without handlers, testid
  stability with every action present.
- `ArtifactCard.test.ts` (+2), `ToolActivityRow.test.ts` (+2): both pills together, left-alone
  alone (no misleading pending-review pill) for a full refusal.
- `DocumentBody.test.ts` (+3, plus 6 existing tests updated for the new composer flow's button
  labels): the 600ms minimum (fake timers, real assertions on `mockSetAlfyWritingBlock`'s call
  history before/at/after the floor), Ask again, Dismiss. Also added a `state.selection` stub to
  the suite's own fake editor (the new code reads it directly) and five new lazy-module mocks —
  Vitest's own mock-completeness check turns a missing export into a hard runtime error the
  moment it's accessed, which failed 34/35 tests identically until fixed.
- `artifact-document-selection-bubble.spec.ts` (E2E, updated): see Deviations/bugs below — a new
  `assertDockedBarAtBottom` contract for the phone case, and an Escape press before each new
  selection in the shared `selectWordAndReadBubble` helper.

## Gates (run at the end, in this worktree)

1. `npm run check` — **0 errors, 17 warnings**, exactly the pre-existing baseline
   (`ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1). No new warning.
2. `npx biome check src scripts tests` — **clean**.
3. `npm test` (full vitest) — **13,634 passed, 2 skipped, 0 failed** (pre-existing skips) on the
   final run (13,633 on the mid-session run, before the last CSS-fix commit added no new test).
4. Playwright, port 5430: `tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts
   tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts` (12 files)
   — **81 passed, 0 failed**.
5. `npx fallow --no-cache --format json --quiet --score` — **124 issues, 4 circular
   dependencies** — exactly the stated baseline, zero new findings (one intermediate unused
   export, caught and fixed before this final run — see the dedicated commit).

Gate 3 and gate 4 were each run twice (once mid-session, once as the final sweep after the last
CSS fix); both full and clean both times. Full commands and counts are in this file's own commits
if a second opinion wants to re-run any of them.

## Screenshots (Hungarian; not committed)

`…/scratchpad/rd/shots/rd4a/`, captured against this worktree's own dev server (port 5430) with a
seeded document, via a throwaway Playwright spec deleted before finishing (never committed):

- `pill-hu-light-1440.png` — the resting pill, 1440×900 light.
- `composer-ask-hu-light-1440.png` — the open Ask composer (header naming the quote, suggestion
  chips, effect line), 1440×900 light.
- `docked-bar-hu-light-390.png` — the phone docked bar, 390×844 light.
- `refusal-pinned-hu-dark-1440.png` — a real, live refusal (driven through `/api/chat/stream` by
  the fake-provider harness, exactly like `artifact-document.spec.ts`'s own T8-live test) showing
  the pinned warning card (Ask again/Dismiss), the dashed refused-line rule, and the in-chat
  card's two pills together ("1 change to review" + "1 part left alone"), 1440×900 dark.

I looked at each once and fixed two real, screenshot-driven findings before calling this done —
see Deviations.

## Deviations from the spec, with reasons

- **Two real bugs found and fixed while capturing screenshots against a real long document** (not
  scope creep — both block the redesign's own stated phone behaviour):
  1. The phone docked bar was originally `position: sticky` (lower cost, no rect math). Against a
     real 40-paragraph seeded document it sits alongside the (very tall) editor content in normal
     flow, so its `bottom: 0` offset only holds true near the END of that flow — once scrolled
     deep, the bar's own natural position has already scrolled past and it stops tracking the
     viewport (confirmed: scrolled fully off-screen). Switched to `position: fixed`.
  2. A full-width fixed bar can then physically overlap and intercept clicks on text rendering
     directly beneath it — hit in the existing E2E regression suite's own two-selections-in-a-row
     test. Fixed both by moving Escape to a window-level listener (a genuine a11y improvement per
     redesign §4.4, not just a workaround) and by pressing Escape before each new selection in
     that suite's own shared helper.
- **The gutter-bar/dimmed-text/inline-tag/refused-line CSS was missing entirely on the first
  pass** — the three decorations were adding the right classes to the right DOM nodes (proven by
  their own unit tests), but `DocumentBody.svelte` — the one place document-content styling
  lives — never got the actual style rules, so everything was invisible until I screenshotted a
  real refusal and didn't see the dashed rule that should have been there. Fixed and verified
  against a real browser's `getComputedStyle` (`border-left-style: dashed`) before calling this
  done. Flagging this prominently: it is exactly the kind of gap that unit tests asserting "the
  class is present" cannot catch on their own, and a caller reading only the diff stat (classes
  added in the decoration module, zero lines in `DocumentBody.svelte`'s `<style>` in the FIRST
  pass) would have missed it too.
- **The selection's "pending" highlight applies from the moment the pill shows, not only once
  composing starts.** Building a callback for "SelectionBubble just entered compose mode" would
  have meant a new prop crossing that component's own boundary for a cosmetic-only distinction —
  the pill stage already shows the browser's own native selection highlight, so showing the
  dashed-amber one slightly early is a minor, deliberate simplification, not a gap.
- **CommentThread's "Alfy is reading…" → "Alfy is writing…" two-phase swap** — not built. rd3a's
  own typing placeholder (dots + a single "Alfy is writing…" label while `posting && mentionsAlfy`)
  already works; my brief only asked for this "if agent 3a did not finish it". Given it's purely
  cosmetic (no real "reading" vs "writing" signal exists — `posting` is one boolean spanning the
  whole call either way) and everything else in this step needed the time more, I left it as
  rd3a built it.
- **`blockRectFn` (`document-editor.ts`'s new `blockRect`) is exported and tested but never
  called from `DocumentBody.svelte`.** I built it (mirroring `changeMarkRect`) anticipating I'd
  need it to pin `RefusalNotice`'s own on-screen position beside its line, then chose a simpler,
  lower-risk design instead (a plain warning card in the existing `AlfyWriting`/`RefusalNotice`
  flow position, styled to read as "pinned" via the dashed gutter rule doing the actual
  line-pointing) rather than a second absolute-positioning system alongside `changePositions`
  (which 4b's own ChangeBar rework may replace entirely). Left `blockRect` in place — it's a
  small, correct, tested, mirror-shaped addition a future agent (perhaps 4b, perhaps whoever
  eventually gives Canvas/Slides their own "pinned near a node" treatment) can use rather than
  re-deriving the same rect math a third time; not a dead-code regression since real callers
  (`selectAndScrollToBlock`'s own sibling function) share its `findBlockNodeRange` internals and
  fallow's baseline stayed exactly flat with it present.

## Hand-off — reuse these

- **`alfy-writing-decoration.ts`**: `AlfyWritingTarget`/`SelectionPendingTarget`/
  `RefusedLinesTarget` + `buildXDecorations` (pure, PM-doc-in-decoration-out) +
  `findBlockNodeRange` (exported for `document-editor.ts`'s own `blockRect`/
  `selectAndScrollToBlock`, and the one place to extend if a FOURTH "ephemeral single-target
  decoration on a block" need ever comes up — don't re-derive the node walk a third time).
  Self-contained on purpose: imports `BLOCK_ID_ATTR` from `./block-attrs`, never `./extensions`
  (which registers THIS module's plugins) — that direction would be the exact cycle
  `block-attrs.ts`'s own header comment already explains Fallow's gate does not allow.
- **`document-editor.ts`**: `setAlfyWritingBlock`/`setSelectionPending`/`setRefusedLines` (write
  side, no-op-for-history dispatch, mirrors `setCommentAnchors` exactly), `blockRect` (mirrors
  `changeMarkRect`), `selectAndScrollToBlock` (mirrors `scrollToChange`, but selects the WHOLE
  block rather than a point). All four take a bare `blockId`, no comment/anchor machinery needed
  — reuse these directly rather than resolving through the comment-anchor system for any future
  "point at this block" need.
- **`applyMetaOrNull`** (`alfy-writing-decoration.ts`, not exported — copy the ~4-line pattern,
  it's not worth a cross-file dependency for): if a future plugin's own state can legitimately be
  cleared to `null`, `tr.getMeta(key) ?? value` is the WRONG pattern — it silently treats the
  clear as a no-op. `extensions.ts`'s older `commentAnchorPluginKey`/`tabSectionPluginKey` get
  away with the `??` form only because they never dispatch a bare `null`.
- **`COMPOSER_BUBBLE_SIZE`** (`bubble-placement.ts`): pass the GROWN state's footprint to
  `computeBubblePlacement`, not the resting state's, whenever "this pill/popover grows in place"
  — sizing for the smaller resting state risks a placement that has no room once it grows.
  `DEFAULT_BUBBLE_SIZE` stays un-exported on purpose (fallow's unused-export check).
  `isPhoneViewport`/`watchPhoneViewport` (`$lib/utils/viewport.svelte.ts`, pre-existing, not
  mine) are the right tool whenever a component needs to pick between two ENTIRELY different
  presentations (not just CSS) for phone vs. desktop — self-contained, no shared tracking
  dependency, SSR-safe.
- **The composer-travel FLIP** (`DocumentBody.svelte`'s `handleSelectionSubmit`): a plain cloned
  `div`, inline-styled, animated via `reducedMotionAnimate` from a captured source rect to a
  `[data-comment-id="…"]` target rect found after `tick()`. No new shared helper extracted for
  this — it is the one FLIP-across-a-component-boundary case in this feature so far; if a second
  one shows up (e.g. an App/Canvas/Slides equivalent), that's the moment to pull the ghost-clone
  math into `motion.ts` rather than copying this function.
- **Window-level Escape** (`SelectionBubble.svelte`'s own `$effect`): for any future
  floating/pill-style affordance whose OWN buttons are never auto-focused, a local `onkeydown`
  on the container is not enough — Escape needs a window listener guarded by the component's own
  "am I currently showing the dismissable state" check, exactly like this file's `mode !== 'pill'`
  guard.
- **`refusedCount` / `pendingReviewCount`** (`ArtifactCard.svelte`'s `ArtifactCardView`,
  `ToolActivityRow.svelte`'s `artifactCardView`): both now derived from the same `alfyActivity`,
  `appliedCount > 0` gating `pendingReviewCount` and `status === "refused"` gating `refusedCount`
  — reuse this exact pair for any future kind's own chat card rather than re-deriving either.
- **`artifacts.document.refused.reviewBarLeft`** i18n key (en/hu, exact mockup copy): ready for
  whoever builds `ReviewBar.svelte` (agent 4b) — read `refusalNotice.refusedBlockIds.length` for
  the count (currently private to `DocumentBody.svelte`; the count itself, not a new prop, is
  what 4b will need surfaced if `ReviewBar` mounts as a sibling rather than inside this file).
- Kept test ids stable throughout: `artifact-count-button`, `artifact-panel-list`,
  `alfy-change-bar`, `refusal-notice`, `margin-comment`, `selection-bubble`, `document-tabs`.
- **Not mine, still open**: `ReviewBar.svelte`/`ChangeBar.svelte` and pending-review-across-reloads
  (explicitly agent 4b's, per the brief); CommentThread's two-phase reading/writing swap (see
  Deviations); Step 14 Knowledge chips (rd5a's own hand-off, still nobody's).
