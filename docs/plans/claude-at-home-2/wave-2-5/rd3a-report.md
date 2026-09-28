# rd3a report — comment card, thread anatomy, and the rail (redesign steps 6–7)

Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd3a`, branch
`feat/artifacts-rd3a-comments`, base `6903880c`. Commit range `4deaea3b..c97e697a` (7 commits).

## Step 6 · Comment card and thread anatomy

**`src/lib/components/artifacts/CommentCard.svelte`** — rewritten as one MESSAGE row (never a whole
thread): avatar (`AvatarCircle` for the user, a sparkle tile in `--accent-tint`/`--accent-text` for
Alfy), name (existing `versions.byUser`/`byAlfy` labels), relative time, body with `@Alfy` highlighted
(a small local `splitMentions` regex split, `--accent-text` + bold), the Guess tag (`isGuess` prop — the
caller decides this, never derived from `comment.author` alone), the change chip (`changeState` +
`onSeeChange`, "Edited · waiting for you / Kept / Undone" + a "See change" link), and the refusal variant
(`CircleSlash` icon on `--warning-tint`, plus an "Ask again" quick action via `onAskAgain`). Resolve/Reply
moved OFF this component onto `CommentThread` (see below) — the mockup draws Reply/Resolve once per
thread, at the bottom, not once per message.

**`src/lib/components/artifacts/document/CommentThread.svelte`** — rewritten as the whole thread box:
the quote line (a button, "goes to the anchor" via `onGoto`, "· moved" suffix when the anchor's state is
`moved`, struck through for `quoteStruck` removed-text threads), the root `CommentCard` + each reply's
`CommentCard`, the shared Reply/Resolve actions row (`btn-ghost btn-sm` + `CornerDownLeft`/`Check`/
`RotateCcw`), resolve fold-to-one-line with peek (a CSS `grid-template-rows: 0fr → 1fr` height reveal —
no JS measurement, and it inherits app.css's global reduced-motion collapse for free, so §7.3's "instant
fold" needs no extra branch), and the reply composer: placeholder "Reply, or ask @Alfy…", the submit
button switches from "↳ Reply" (secondary) to "✦ Ask Alfy" (primary) the moment `/@alfy\b/i` matches the
draft — live, not just after posting — with a hint line and Alfy's own typing-dots placeholder
("Alfy is writing…", a static-with-loop-dots pattern matching `AlfyWriting.svelte`'s own established
shimmer idiom) while an `@Alfy` reply is in flight. Cmd/Ctrl+Enter sends.

Both files' own test suites were rewritten alongside them (Resolve/Reply behaviour tests moved from
`CommentCard.test.ts` to `CommentThread.test.ts`, which now owns that behaviour — never deleted, only
relocated to match the redesign's own split).

## Step 7 · The rail

**`src/lib/components/artifacts/document/extensions.ts`** — new `CommentAnchors` ProseMirror plugin:
`commentAnchorPluginKey`, `CommentAnchorTarget` (`{commentId, blockId, from, to, resolved}` — a
block-relative character window, `blockVisibleText`'s own contract, never a raw PM position),
`commentAnchorDocRange` (binary search over `doc.textBetween(blockStart, p, "\n")`'s length — reuses the
exact "\n"-between-blocks separator `readSelectionAnchorContext` already captures anchors with, so it
can never drift from how anchors were created), and `buildCommentAnchorDecorations` (one
`Decoration.inline` per resolved, non-orphaned anchor: `.comment-anchor` + `.is-active` when linked +
`.is-resolved` when the thread is resolved; `role="button"`/`tabindex="0"` only while OPEN — a resolved
thread's highlight goes back to reading as plain text, matching §3.4's own a11y note and ruling 61's
Open-by-default rail).

**`src/lib/components/artifacts/document/document-editor.ts`** — two new lazy-boundary exports:
`setCommentAnchors` (a no-op-for-history dispatch, mirrors `setActiveDocumentTab` exactly) and
`scrollToCommentAnchor` (the quote button's "goes to the anchor" plus motion #17's flash — hand-rolled
rather than `motion.ts`'s `reducedMotionAnimate`, because THIS one animation must hold a static 3px ring
for 900ms under reduced motion too, §7.3 rule 3 — not just jump to the resting state, which is what
`reducedMotionAnimate`'s reduced path does for every other animation in this feature).

**`src/lib/shared/artifact-document/blocks.ts`** — new `mapBlocksToTabs(blocks, tabs)`, extracted from
`DocumentBody.svelte`'s own `computeTabBadgeCounts` (behaviour-preserving refactor) so the rail's own
per-tab comment scoping and the tab-strip badge counts share one block→tab walk instead of two.

**`src/lib/components/artifacts/document/MarginPanel.svelte`** — rebuilt as the rail (`CommentRail` in
§8's terms; kept the filename and `data-testid="margin-comment"` per the brief). New on top of the
unchanged placement engine (`margin-layout.ts`, untouched):
- **Ruling 61** (wins over the spec/mockup): Open by default; a quiet toggle — `"{count} resolved"` ↔
  `"Show open only"` — switches to All, never the mockup's own two-button "Open 4 | All 6" filter.
  Resolved threads fold to one line either way (`CommentThread`'s own job).
- **Per-tab scoping**: only the active tab's own comments (`mapBlocksToTabs` against each comment's
  static `anchor.blockId`, mirroring `computeTabBadgeCounts`) are positioned; a summary row per OTHER
  tab ("{title}" + "{open} open · {resolved} resolved") switches to it on click. The removed-text group
  is the one exception — never tab-scoped (see Deviations).
- **The removed-text group** is now foldable (motion #21, collapsed by default) and count-aware
  ("N comments on text that was removed").
- **Two-way linking**: reports its own resolved anchors upward every time they change
  (`onAnchorsChange`), reflects `activeCommentId` as `.is-active` (border/shadow/6px shift, motion #16)
  on a thread's own card, and scrolls+focuses a card on `focusRequest` (a Svelte action,
  `focusOnRequest`, not an effect — needs to run per-`{#each}`-item).

**`src/lib/components/artifacts/document/DocumentBody.svelte`**:
- `.document-content` becomes the one scroll container for a two-column grid
  (`.document-content-text` / `.document-content-rail`, `minmax(0,1fr) 300px` at ≥820px, one column
  below) — the old scroll-sync effect is gone entirely, per the brief. `contentEl`'s own identity is
  unchanged, so every `localizePoint`/selection-bubble/change-bar computation kept working untouched.
- New state: `activeCommentId`, `focusCommentRequest` (a bumped token, deliberately separate from
  `activeCommentId` so a mere card hover can never also yank scroll/keyboard focus),
  `commentAnchors`, `changeIdByCommentId` (+ `changeChipByCommentId` derived from it and
  `pendingChanges`).
- `maybeAskAlfy` now records which `changeId` an `@Alfy` reply produced, keyed by `commentId` — this is
  what feeds the change chip and its "See change" (a `seeChange(changeId)` helper, factored out of the
  refusal notice's own `handleSeeChange` so both share one scroll-to-change path).
- Editor-side event delegation on `editorEl` (`mouseover`/`mouseout`/`focusin`/`focusout`/`click`/
  `keydown`, plain DOM listeners — no new Tiptap-level event mechanism) turns hover/focus/click/Enter on
  a `.comment-anchor` span into `activeCommentId`/`focusCommentRequest` changes, gated on the span
  carrying `role="button"` (i.e. its own thread is open).
- CSS: added the grid two-column layout, a `.comment-anchor:focus-visible` ring, and restored `flex: 1`
  on `.document-content` (dropped when it became a grid — see Deviations/bugs below).

## Tests added

- `CommentCard.test.ts`, `CommentThread.test.ts` — rewritten (avatar/Guess/mention/refusal/chip
  variants; fold/peek, quote+onGoto, composer Ask-Alfy switch + typing placeholder, Cmd/Ctrl+Enter).
- `extensions.test.ts` — new `describe("extensions: CommentAnchors")`: `commentAnchorDocRange`'s
  char-offset→position mapping and not-found path; `buildCommentAnchorDecorations`' shape (class,
  `data-comment-anchor-id`, interactive-only-while-open, `is-active`/`is-resolved`).
- `document-editor.test.ts` — new `describe("setCommentAnchors / scrollToCommentAnchor")`: live DOM
  render/clear, `is-active`, `is-resolved` has no `tabindex`, found/not-found scroll paths.
- `blocks.test.ts` — new `describe("mapBlocksToTabs")`.
- `MarginPanel.test.ts` — rewritten: empty state, one-thread-per-comment, moved suffix, removed-text
  group (count + fold + click-to-reveal), ruling 61 filter (hidden by default, toggle reveals folded,
  toggle absent with nothing resolved), per-tab scoping (own tab shown, other tab summarized, click
  switches tabs), two-way linking (hover reports `onActiveCommentChange`, `is-active` class,
  `focusRequest` scrolls+focuses, `onAnchorsChange` reports resolved anchors), the existing 50-comment
  re-measurement debounce test (updated call sites only).
- `DocumentBody.test.ts` — mock additions only (`setCommentAnchors`/`scrollToCommentAnchor`) plus one
  updated empty-margin-text assertion; all existing behaviour tests otherwise unchanged and green.
- `tests/e2e/artifact-document-comments.spec.ts` — two assertions updated for intentional redesign
  changes (the removed EXACT pill; the removed-text group's new fold-by-default, so the e2e now opens it
  before asserting contents visible).

## Gates (run at the end, after every commit above)

1. `npm run check` (via `svelte-check --output machine`): **0 errors**, 17 pre-existing warnings
   (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) — no new warning.
2. `npx biome check src scripts tests`: clean (one `--write` formatting pass committed separately,
   mechanical line-wrapping only, re-verified with targeted vitest + a full 4-suite Playwright re-run
   afterwards).
3. `npm test` (full vitest): **892 files passed, 1 skipped; 13572 tests passed, 2 skipped.** Zero
   failures.
4. Playwright, port 5420: the brief's own 4 named suites — `artifact-document-comments.spec.ts`,
   `artifact-document.spec.ts`, `artifacts-panel.spec.ts`, `artifact-document-selection-bubble.spec.ts`
   (31 tests) — plus, per common.md's fuller list, `artifact-app.spec.ts`, `artifact-chat-card.spec.ts`,
   `artifacts-api.spec.ts` (14 tests), `chat.spec.ts`, `conversation.spec.ts`, `knowledge.spec.ts` (36
   tests). **All 81 green**, run twice (before and after the biome commit).
   - Found and fixed one real regression this way, not caught by the unit suite (which never lays out
     for real): turning `.document-content` into a grid dropped its own `flex: 1` (still needed — it is
     a flex CHILD of `.document-main`), so at 390×844 the editor host fell to 28% of the viewport
     against T11.1's own ≥60% budget. Restored; the failing test passes again.
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-rd3a.json`: **124
   issues, 4 circular dependencies — exact match to the stated baseline, zero new findings.** Verified
   directly: none of this session's new exports/types (`mapBlocksToTabs`, `CommentAnchorTarget`,
   `commentAnchorDocRange`, `buildCommentAnchorDecorations`, `setCommentAnchors`,
   `scrollToCommentAnchor`, `decorationAttrs`) appear anywhere in the report.

## Screenshots (Hungarian, not committed)

In `…/scratchpad/rd/shots/rd3a/`:
- `rd3a-hu-rail-light-1440x900.png` — two open threads (one with an Alfy reply, one Alfy's own
  judgement-call note tagged "TIPP"/Guess), one folded resolved thread ("train"), the collapsed
  removed-text group ("1 MEGJEGYZÉS TÖRÖLT SZÖVEGEN"), and the live comment-anchor highlights in the
  text ("flight", "hotel" underlined amber; "train" — resolved — back to plain text).
- `rd3a-hu-rail-dark-1440x900.png` — same scene, dark.
- `rd3a-hu-reply-composer-1440x900.png` — the flight thread's reply composer open ("Válasz, vagy
  kérdezd: @Alfy…", Mégse/↵ Válasz).

Captured via a throwaway Playwright spec (`tests/e2e/zz-rd3a-shots.spec.ts`), deleted before the final
commit per common.md; `git status` is clean.

## Deviations from the spec, with reasons

- **Ruling 61's filter is one quiet toggle, not the mockup's "Open 4 | All 6" segmented control** — the
  brief is explicit that the ruling wins; the toggle only appears once there is something resolved to
  reveal (or already showing All with nothing resolved, an edge case left reachable rather than
  special-cased away).
- **The removed-text group is never tab-scoped**, even though every other list is (ruling 61's third
  point). A comment's tab membership is derived from its own STATIC `anchor.blockId` against the
  current block→tab map (`mapBlocksToTabs`), and an orphaned comment's block is — by definition — no
  longer in that map at all, so there is no live signal for "which tab this used to belong to" without
  new persistence this step does not add. Always showing it regardless of active tab is the documented,
  deliberate choice (in `MarginPanel.svelte`'s own comments) over guessing.
- **Two-way linking went slightly beyond the brief's own condensed line.** The brief's step 7 text names
  only "hover/focus on a card marks its words `.is-active`" and "clicking the words opens and focuses
  the thread"; the fuller spec prose (§3.2) also asks for hover/focus on the WORDS to link the card, and
  Enter-on-a-focused-highlight as a keyboard equivalent to click — both are implemented (the delegated
  listener set was already needed for click; the extra listeners were incremental), so a11y parity holds
  without extra scope risk.
- **The flash-on-quote-click (motion #17) is hand-rolled, not `reducedMotionAnimate`.** That helper's
  reduced-motion path always jumps straight to the animation's LAST keyframe; §7.3 rule 3 requires this
  one animation to hold a real intermediate state (a static ring) for the full 900ms under reduced
  motion too, which the shared helper cannot express. `scrollToCommentAnchor`'s own doc comment explains
  this in place.
- **The user's avatar is a fixed placeholder** (`AvatarCircle userId="user"`, no real name/photo) —
  `ArtifactComment.author` is a plain `"user" | "alfy"` union with no per-comment identity to thread
  (there is exactly one human commenter on any given artifact), and wiring a real profile picture through
  five components for a placeholder-only payoff felt like the wrong trade against this step's own scope.
- **No `<820px` drawer.** Per the brief, that (plus phone comments and the Versions/Download popovers)
  is explicitly agent 3b's own step, run after this one. `.document-content-rail` collapses to
  `display:none` below 820px today with no toggle back — 3b's own starting point, not a regression (the
  pre-redesign rail was `display:none` below 900px with no toggle either).

## Hand-off — reuse these

- **`MarginPanel.svelte`'s full new prop contract** — `comments, blocks, contentEl, tabs, activeTabId,
  changeStateByCommentId, activeCommentId, focusRequest, onResolve, onSubmitReply, onSeeChange,
  onGotoAnchor, onActiveCommentChange, onAnchorsChange, onActivateTab`. Agent 3b's phone sheet / narrow
  drawer should reuse this component AS ITS CONTENT and change only the wrapping chrome (a sheet
  instead of a grid column) — the state (`activeCommentId`/`focusCommentRequest`/`commentAnchors`) and
  the editor-side event delegation already live in `DocumentBody.svelte` and need no new plumbing for a
  narrower viewport, only a different `.document-content-rail` presentation below 820px.
- **The comment-anchor decoration mechanism** — `CommentAnchorTarget`, `commentAnchorDocRange`,
  `buildCommentAnchorDecorations` (`extensions.ts`), `setCommentAnchors`, `scrollToCommentAnchor`
  (`document-editor.ts`). The one other place in this feature that will eventually need an anchor
  decoration (a future node/point-based Canvas equivalent) should follow the SAME shape — resolve
  externally (never inside the plugin), dispatch via a no-op-for-history transaction — rather than
  inventing a second decoration convention.
- **`mapBlocksToTabs`** (`shared/artifact-document/blocks.ts`) — the one block→tab assignment rule,
  now shared by the tab-strip badge counts and the rail's own per-tab scoping. Any future per-tab UI
  should call this rather than re-deriving block/tab membership a third way.
- **The CSS `grid-template-rows: 0fr ↔ 1fr` collapsible pattern** (`.comment-thread-collapsible` /
  `.is-expanded`, used by both `CommentThread`'s fold and the rail's removed-text group) — a JS-free
  height reveal that gets app.css's reduced-motion collapse for free. Reuse this for any future
  fold/reveal (e.g. a phone sheet's own sections) instead of a new JS-measured height animation.
- **`changeIdByCommentId` / `changeChipByCommentId` (`DocumentBody.svelte`) are session-only**, exactly
  like `pendingChanges` itself (rd2's own hand-off already flagged this durability gap for the review
  bar). Whoever eventually makes pending-review state durable across a reload should extend the SAME
  persisted signal to cover the chip, not add a second one.
- **`seeChange(changeId)`** (`DocumentBody.svelte`) is now the one scroll-to-a-change helper, shared by
  the refusal notice's "See what Alfy did" and the comment chip's "See change". Reuse it for any future
  caller that needs to jump to a change's own mark.
- **CommentCard's refusal variant** (CircleSlash icon, `--warning-tint`, "Ask again" via `onAskAgain`) is
  the pattern agent 4a should match when it finishes `RefusalNotice.svelte`'s own "warning card variant
  of the comment family" (§9.2) — the two should read as the same family, not two different visual
  languages for "Alfy refused."
- Kept test ids stable throughout: `artifact-count-button`, `artifact-panel-list`, `alfy-change-bar`,
  `refusal-notice`, `margin-comment`, `selection-bubble`, `document-tabs`.
