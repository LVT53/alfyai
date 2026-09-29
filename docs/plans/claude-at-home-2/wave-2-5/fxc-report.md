# Fix agent C report — Document review logic, versions, avatars, Hungarian strings (round F2)

Branch `fix/artifacts-rd-doc-logic`, worktree `.claude/worktrees/art-fxc`. Commits `04d7a3ee..456c7b9f` (12 commits on
top of the merged base, `75eacddc`, which already contained fix agents A and B). The 12th commit (`456c7b9f`) is not
one of review-2-5.md's numbered findings — it is a pre-existing `DocumentWorkspace.svelte` regression this round's own
verification pass uncovered and fixed; see the dedicated section below.

## Important finding 1 (review-2-5.md:109–121) — opening a Document with pending changes wrote an empty "Edited" version

**Cause:** `applyAlfyChangeMarks`, `keepAlfyChange`, and `remarkAlfyChange` (`marks.ts`) are mark-only transactions —
they add or remove the `AlfyChange` mark over text a patch already applied elsewhere, never new content. None of them
set Tiptap's own `preventUpdate` transaction meta (every OTHER no-op-for-history dispatch in this module already does:
`setActiveDocumentTab`, `setCommentAnchors`, `setChangePills`, `ensureBlockIds`'s own insert/delete, `loadMarkdown`'s
`emitUpdate: false`). Without it, Tiptap still treats a mark-only change as `docChanged` (`AddMarkStep`/`RemoveMarkStep`
genuinely change the doc's node structure even though the visible text is identical) and fires its own `update` event.
`DocumentBody.svelte`'s `handleUpdate` — wired to that event — cannot tell "the user typed" from "a mark was
programmatically added," so it scheduled a normal autosave every time. The worst case was ruling 61's own
reload-restore: `restorePendingReview` calls `remarkChangeFn` once per pending block right after load, so merely
*opening* a Document with unreviewed changes re-marked every pending block and wrote one byte-identical, fake "Edited"
version per open.

**Fix:** added `tr.setMeta("preventUpdate", true)` to the three functions' dispatches (`marks.ts`). `undoAlfyChange` is
untouched on purpose — Undo genuinely changes the document's content (ruling 61: "Undo restores the parent's content…
as a user edit") and must keep autosaving.

**Test:** `marks.test.ts`, new describe block `"marks: mark-only transactions never fire onUpdate"` (4 tests): each of
the three fixed functions is asserted to NOT call a spied `onUpdate`, and `undoAlfyChange` is asserted to STILL call it
exactly once (the negative control, proving the fix is scoped correctly and doesn't accidentally silence a real edit
too).

Commit `15ccae81`.

## Important finding 2 (review-2-5.md:122–129) — the review stepper's Next/Previous never switched tabs

**Cause:** `handleReviewNext`/`handleReviewPrev` call `seeChange` → `scrollToChangeFn`, which only ever scrolls to the
mark's live position. A change living in a tab other than the active one sits inside a `display:none` section (ruling
61's "tabs show only their own section"), so the scroll did nothing visible and the tab never switched.

**Fix:** `seeChange` (`DocumentBody.svelte`) — shared by the stepper, a comment chip's own "See change", and the
refusal notice's "See what Alfy did" — now resolves the change's `blockId` (from the same `pendingChanges` map the
pills themselves read), maps it to its owning tab via the existing `mapBlocksToTabs`, and calls `handleTabActivate`
plus `await tick()` before scrolling if that tab isn't already active. All three callers get the fix for free since
they all go through this one function; with 0/1 tabs `mapBlocksToTabs` returns an empty map, so the no-tabs case is
unaffected.

**Test:** `DocumentBody.test.ts`, new test `"the stepper switches tabs first when the next change lives in a different
tab"` — two tabs, two pending changes (one per tab), clicking Next from the first (already-active) tab's own change
asserts `setActiveDocumentTab` is called with the second tab's id before `scrollToChange` is called with its
changeId.

Commit `1220f7ca`.

## Important finding 3 (review-2-5.md:130–140) — ruling 61 persistence: a kept block Alfy changes again was never pending again after a reload

Server-side, through the artifacts facade (`document-ops.ts`), as required.

**Cause:** `keptBlockIds` was a flat `string[]` of block ids with no version information. `computePendingReviewBlocks`
excluded ANY block id present in `keptBlockIds`, regardless of which Alfy version last touched it. Repro: Alfy edit A
changes b1 and b2 → user Keeps b1 (`keptBlockIds = ["b1"]`, `throughVersion` stays at A's parent since b2 is still
pending) → Alfy edit B changes b1 again → on reload, `getDocumentReviewState` still excluded b1 (still in
`keptBlockIds`) even though a NEWER, never-reviewed Alfy version had touched it since.

**Fix:** kept ids are now encoded `"<blockId>@<alfyVersionNumber>"` (`encodeKeptBlock`/`parseKeptBlockVersions`, new
in `document-ops.ts`), where the version is the pending block's own `alfyVersionNumber` *at the moment it was kept*.
`computePendingReviewBlocks` excludes a block only when `keptAsOfVersion >= change.versionNumber` (the block's most
recent Alfy-authored change) — a newer Alfy edit re-admits it. A legacy/malformed entry with no parseable `@version`
reads as version 0, so it can never permanently suppress a real Alfy version (safe default, not a crash). When the
same block id has been kept more than once across the artifact's life, the highest recorded version wins.
`acknowledgeDocumentReviewBlocks` now also computes `pendingBefore` first and only accepts block ids that are
genuinely in that set — a POST naming a stale/foreign/made-up id is silently ignored rather than stored verbatim (the
review's own secondary note under this finding).

**Test:** `document-ops.test.ts` — 3 new pure `computePendingReviewBlocks` cases (kept-as-of an older version is
re-admitted by a newer change; kept-as-of the current version still suppresses when Alfy hasn't touched it again; a
legacy bare id is treated as version 0), plus 2 new DB-integration tests under `acknowledgeDocumentReviewBlocks`
(the exact two-block repro above, through real `createDocumentArtifact`/`applyDocumentPatch`/`acknowledgeDocumentReviewBlocks`
calls; and a fabricated block id being ignored without touching stored metadata). The existing "partial keep" pure
test was updated to the new `"id@version"` shape (was testing a bare id, now `"p1@2"`) since that shape is the
documented contract, not an incidental detail.

**Verified still green:** ownership scope, incognito `?conversationId=`, and the shared 404 tests in
`document-ops.test.ts` (`getDocumentReviewState`/`acknowledgeDocumentReviewBlocks` describes) — all pre-existing,
all still passing; I did not touch their assertions, only the pure function's internal encoding.

Commit `04d7a3ee`.

## Important finding 4 (review-2-5.md:141–148) — a user's own edit of a pending block did not acknowledge it live

**Cause:** ruling 61's "a user's own edit to such a block acknowledges it" was already true SERVER-SIDE after a
reload (`computePendingReviewBlocks`'s "most recent change wins" rule naturally excludes a block whose latest change
is user-authored), but nothing told the LIVE session the same thing. The pill and the review bar's count kept
showing a change as pending after the user typed right over it, and clicking Undo would have restored Alfy's
PRE-edit text, throwing the user's own typing away with it.

**Fix:** `handleUpdate` (`DocumentBody.svelte`) now calls a new `acknowledgePendingBlocksTouchedByUserEdit` right
before refreshing `blocks` state: it compares every still-`"pending"` block's hash (from the OLD `blocks` state)
against its hash in the freshly parsed markdown; a block whose hash changed (edited) or that no longer exists
(deleted) is dropped from `pendingChanges` (removing its pill — the same `setChangePills` effect that renders them
reacts to this) and its mark cleared immediately via `keepChangeFn` — the same mechanism Keep uses, but without
Keep's own 1.4s settle window (there is no "Kept" label to show for an edit nobody explicitly kept) — then
acknowledged through the same `acknowledgeReview` → `acknowledgeDocumentReviewBlocks` API Keep/Undo already call.

**Test:** `DocumentBody.test.ts`, two new tests under the ruling-61 describe block: typing over a pending block's own
text calls `acknowledgeDocumentReviewBlocks` with that block id, clears the mark the same way Keep does, and empties
the pill list; editing a DIFFERENT block from the one pending leaves the real pending block's own acknowledge call
and mark untouched (the negative control).

Commit `64da06dc`.

## Triage "fix first" (review-2-5.md:272–275) — the user's own avatar was a placeholder "U"

**Cause:** `CommentCard.svelte` and `VersionsSheet.svelte` both hardcoded `<AvatarCircle userId="user">` — a literal
string, never the signed-in user's own id/name/picture.

**Fix:** threaded the signed-in user (`(app)/+layout.server.ts`'s own `SessionUser`, already resolved server-side) as
a new `ArtifactBodyProps.currentUser` field, through `DocumentWorkspace.svelte` (both the mobile and desktop
`<ArtifactBody>` instantiations) to whichever body is open, then through `DocumentBody.svelte` to `VersionsSheet`
directly and to `MarginPanel`/`CommentsSheet` → `CommentThread` → `CommentCard` for comments (`CommentsSheet.svelte`
needed no change — its own `...marginPanelProps` rest-spread picks up the new field automatically via
`ComponentProps<typeof MarginPanel>`). Both the chat page and the knowledge page (via a new `currentUser` prop on
`KnowledgeWorkspaceCoordinator.svelte`) supply their own already-available `data.user`.

**Test:** `CommentCard.test.ts` (2 new tests: placeholder fallback with no current user, real initial once supplied)
and `VersionsSheet.test.ts` (2 new tests, same shape, querying `document.querySelector(".avatar-circle")` since the
popover is portalled to `<body>`, not inside the render container).

Commit `e36fed66`.

## Minor — English strings in the Hungarian UI (review-2-5.md:256–260)

Three separate leaks, each fixed independently:

1. **Chip select accessible name "status"** — `extensions.ts`'s tracker-chip node view set `aria-label` to the bare
   internal `ChipKind` value. New `chipFieldLabel(kind, locale)` in `chips.ts` ("Status"/"Állapot",
   "Date"/"Dátum"), wired into the node view.
2. **Task checkbox names "Task item checkbox for …"** — Tiptap's own hardcoded English default inside
   `@tiptap/extension-list`. `TaskItem.configure({ a11y: { checkboxLabel } })` is the library's own supported
   override point; `extensions.ts` now supplies a localized one.
3. **Version summaries "Edited"/"restored …" shown verbatim** — these are the save route's own literal, stored
   strings (`/api/artifacts/[id]/body`'s `"Edited"`, `versions.ts`'s `` `restored ${summary}` `` wrapper).
   `VersionsSheet.svelte`'s new `summaryLabel()` maps those two known, enum-like server tokens onto localized text at
   DISPLAY time (never rewriting the stored value, which must stay a stable, language-independent marker); an
   Alfy-authored free-form summary (real content, e.g. "Booked the hotel") is left exactly as stored, in every
   locale.

**Test:** `chips.test.ts` (2 new), `extensions.test.ts` (3 new, including an empty-task-item case), `VersionsSheet.test.ts`
(4 new, covering bare "Edited", "restored X", "restored Edited" nesting both layers, and an Alfy free-form summary
staying untouched).

Commit `e6b39e18`.

## Minor — change pill group name, HU label-in-name, and its focus (review-2-5.md:210–216)

Three related gaps in `ChangeBar.svelte`/`change-pill-decoration.ts`:

1. **Empty quote in the group name** — `ChangePillEntry` never carried `blockLabel` (only `ChangeBar.svelte`'s own
   prop existed; nothing ever passed it), so the pill's `role="group"` name always rendered as `"Alfy's change: "`.
   Threaded through from `pending.entry.blockLabel` (already present on `AlfyChangeEntry`) into the
   `ChangePillEntry`/`mount()` call.
2. **WCAG 2.5.3 Label in Name** — the Hungarian accessible names ("Alfy módosításának megtartása/visszavonása/
   megismétlése") named a DIFFERENT word form of the action than the visible buttons ("Megtartom"/"Visszavonom"/
   "Újra"), so a voice-control user saying the visible word could not activate the control. English was already
   compliant (`"Keep Alfy's change"` starts with "Keep"). Restructured the three HU strings to start with the exact
   visible word (`"Megtartom — Alfy módosítása"` etc.).
3. **Focus dropped to `<body>` after Keep/Undo** — the widget re-mounts under a new decoration key on every status
   transition, destroying whichever button had focus. Undo's own resulting "undone" state keeps a Redo button —
   `ChangeBar.svelte` now autofocuses it on mount via a plain `$effect` (safe: "undone" is reachable only through the
   user's own just-now Undo click, never a fresh load or a live Alfy edit landing, both of which always start
   "pending"). Keep's own "kept" state has no button left in the pill, so `DocumentBody.svelte`'s new
   `focusAfterKeep()` moves focus to the review bar's first enabled button when one is still genuinely showing
   (checked via the reactive `pendingList.length`, not bare DOM presence — the review bar's own OUT transition keeps
   its never-disabled Keep-all/Undo-all buttons in the DOM for a moment after `pendingList` already reads empty), or
   back into the document via `editor.view.focus()` otherwise. `:not([disabled])` skips the stepper's own Prev/Next
   when only one pending change remains.

**Test:** `change-pill-decoration.test.ts` (1 new, end-to-end through the real decoration + mounted `ChangeBar`),
`ChangeBar.test.ts` (5 new: Redo autofocus, a negative control proving "pending" mounts never steal focus, and the
three HU label-in-name checks), `DocumentBody.test.ts` (2 new: focus lands on the editor once Keep empties the list
entirely, focus lands on a review-bar button — specifically skipping the disabled stepper — when another change is
still pending).

Commit `64893697`.

## Minor — status changes not announced (review-2-5.md:217–222)

**Cause:** the review bar's and the refusal notice's `role="status"` regions were inserted WITH their text already
present — most screen readers do not announce a region that already carries content at the moment of insertion (only
a later text CHANGE on an already-mounted live region reliably is). Separately, because the review bar's own buttons
lived INSIDE that same live region, moving `currentIndex` (a Prev/Next click) re-announced the whole bar, buttons
included.

**Fix:** one shared, always-mounted, visually hidden `aria-live="polite"` announcer in `DocumentBody.svelte`
(`data-testid="document-announcer"`), fed by the four events named: a comment added (`postComment`/`postReply`) or
resolved/reopened (`handleCommentResolve`); Alfy's own reply landing (`maybeAskAlfy`'s successful branch) — which
also covers the review bar's own "Alfy changed N parts" landing summary, tracked via `pendingList`'s own count
increasing (never decreasing, which is Keep/Undo's own announcement's job); and Keep/Undo (reusing the existing
`change.keptNotice`/`undoneNotice` strings rather than duplicating them). `ReviewBar.svelte`'s own region is now a
plain, non-live `role="region"` — it never announces itself or re-announces on a stepper move.

**Also fixed, discovered while testing this:** a real, pre-existing bug in `artifacts.document.review.summary`'s own
EN string — a `{count}` nested INSIDE an ICU plural branch never resolves, because `i18n/index.ts`'s own plural
regex captures each branch as `[^{}]*` (no braces allowed inside a branch), so a branch containing its own `{count}`
fails to match the plural pattern at all and leaves the raw `"{count, plural, ...}"` template in the rendered text.
This was invisible in the existing `ReviewBar.test.ts` because `toHaveTextContent`'s substring match still found
"Alfy changed 3 parts." INSIDE that unresolved template. Fixed by moving `{count}` outside the plural block (the
shape every OTHER plural key in `artifacts.ts` already uses correctly, e.g. `panel.count`/`panel.pendingReview`) —
same fix applied to my own new `tab.openCommentsA11y` key below, which had copied the same broken shape before I
caught it. Added a precise, non-substring regression test.

**Test:** `DocumentBody.test.ts` (5 new: landing summary + Kept announced, Undone announced, comment-added,
comment-resolved, Alfy-replied — the last three extend already-existing, already-passing flow tests with one more
assertion each rather than duplicating their setup), `ReviewBar.test.ts` (role="region" instead of "status" on the 2
existing summary tests, plus 1 new test asserting the EXACT resolved text with no leftover ICU markers).

Commit `55e25c63`.

## Minor — tabs ARIA (review-2-5.md:223–228)

Three sub-items; two fixed, one deliberately deferred:

1. **`aria-controls` pointed at ids that never existed** — fixed. The editor host
   (`DocumentBody.svelte`'s `.document-editor-host`) now carries `role="tabpanel"`, `id="document-tabpanel-{activeTabId}"`,
   and `aria-labelledby="document-tab-{activeTabId}"` — omitted entirely for a single-tab document (there is no
   tablist for it to pair with).
2. **The badge read as a bare number** — fixed. The visible digit is now `aria-hidden="true"`; an sr-only phrase
   ("{count} open comments"/"{count} nyitott megjegyzés") sits alongside it.
3. **The tablist also owns the ⋯ and + buttons** — NOT fixed; see Deviations below.

**Test:** `DocumentBody.test.ts` (2 new: the tabpanel id/role/aria-labelledby trio updates when the active tab
changes, and is omitted for a single-tab document), `Tabs.test.ts` (1 new: the visible badge is `aria-hidden`, the
sr-only text is present and correct).

Commit `1eaace35`.

## Minor — composer Escape only worked from the textarea (review-2-5.md:229–232)

**Cause:** `handleComposerKeydown` (Escape → cancel, Cmd/Ctrl+Enter → submit) was wired to the `<textarea>` alone
(`SelectionBubble.svelte`). Escape did nothing while focus was on a suggestion chip or the Cancel button — the
composer stayed open.

**Fix:** moved the handler to the desktop composer's own wrapping `role="dialog"` container (added `tabindex="-1"`
to satisfy `a11y_interactive_supports_focus` — a new warning my own change introduced, caught by the check gate and
fixed before it could count as a regression), so it catches the keydown bubbling up from any descendant. The phone
sheet needed no equivalent change: `DialogShell`'s own `focusTrap` already owns Escape there
(`onClose={cancel}`, window-level, independent of which descendant has focus) — confirmed by reading
`DialogShell.svelte` rather than assumed.

**Test:** `SelectionBubble.test.ts` (2 new: Escape from a focused suggestion chip, and from the focused Cancel
button, both dismiss without posting — the existing "Escape in the composer…" test already covered the textarea
case and still passes unchanged).

Commit `f86900ce`.

## Verified — fix agent B's zero-width-space anchor (finding 7) never leaks (review-2-5.md, fix-agent-B finding 7)

**What I checked:** `appendEmptyTabSection`'s zero-width-space placeholder for a still-untouched new tab's anchor
paragraph MUST survive the artifact's own stored body (`saveDocumentBody`'s re-canonicalisation would otherwise drop
the tab's anchor marker again — this is fix agent B's whole fix, and I did not touch it) — so "never reach the saved
Markdown" cannot mean the stored body/hash itself; it means no reader OUTSIDE the live editor should see the raw
invisible character.

**What I found leaking, and fixed:**
- **`read_artifact`** (`readDocumentForAlfy` in `document-ops.ts`) — both a block's `label` and `text` fields
  included the raw placeholder verbatim when a still-empty new tab's anchor block was read.
- **PDF/DOCX export** (`export.ts`'s `exportText`, used by every block mapper) — the placeholder survived into the
  exported paragraph text. Fixed by stripping it in `exportText`, and by having `buildGeneratedDocumentSource` drop
  a paragraph that maps to EMPTY text entirely (rather than exporting a visible empty paragraph) — the file-production
  report's own `validateGeneratedDocumentSource` rejects empty paragraph text outright, so "export a visible empty
  paragraph" was never actually an option; dropping it is the closest match to "the user never wrote anything here."
- **Markdown export** (the export route's own `inline_text` branch, which does NOT go through `export.ts`) —
  fixed by stripping the placeholder from each block's markdown before joining.

**What I checked and found already safe (no code change):**
- **The card preview** (`read-model.ts`'s `buildDocumentPreview` / `ArtifactCardSummary.documentPreview`) — this
  surface never carries body/free text at all, only `tabCount`/`tasks`/`totalTaskCount` (and `readTaskBlock` only
  ever recognizes task-list syntax, which `appendEmptyTabSection` never produces), so it was already safe by
  construction.
- **The artifact's own saved Markdown and hash** — deliberately UNCHANGED. Stripping the placeholder there would
  revive the exact whole-document-tab bug fix agent B's placeholder exists to prevent.

**The one shared fix point:** `blocks.ts` gains `EMPTY_TAB_ANCHOR_PLACEHOLDER` (now the single source of truth;
`document-editor.ts`'s `appendEmptyTabSection` was refactored to import it rather than keep its own private literal)
and `stripEmptyTabAnchorPlaceholder(text)`, used by all three fixed call sites above.

**Test:** `document-ops.test.ts` (2 new: `readDocumentForAlfy` strips the placeholder from both `label` and `text`;
a placeholder mixed into real text is stripped without disturbing the real text around it), `export.test.ts` (2 new:
a still-empty tab's paragraph is dropped from the export entirely — even when it is the ONLY block, resulting in a
valid empty-blocks source — and a placeholder mixed into real text is stripped, not the whole block), `export`
route's own `export.test.ts` (1 new: the exported `.md` content never contains the raw placeholder), `read-model.test.ts`
(1 new: the card preview's `documentPreview` field never contains it either, mirroring the file's own existing
"never leaks the body itself" test).

Commit `0b98bcff`.

## Additional finding (not in review-2-5.md) — a pending Alfy activity from before the panel opened could be mis-tracked as "already seen"

Found while re-running the brief's exact Playwright gate as final verification, not while implementing any of the
five findings above — but blocking a clean gate, so in scope to fix.

**How it surfaced:** the "status changes not announced" fix (above) corrects a real, separate ICU-plural bug in
`artifacts.document.review.summary`'s EN string. Landing that text fix changed what
`tests/e2e/artifact-document.spec.ts`'s T8 live suite actually renders/observes at the point the panel opens onto an
artifact that already has Alfy activity against it, which was enough to expose a pre-existing bug in
`DocumentWorkspace.svelte`'s `alfyActivitySeenOpenKeys` guard — the mechanism that decides whether a given Alfy
activity `key` for the open artifact counts as "newly seen" (driving the chat card / sidebar row / header count-button
dot) versus "already accounted for." It was not a bug I introduced; it was always latent, just never exercised by the
existing suite's exact timing before this session's own text change shifted it.

**Cause:** the original guard only checked `if (!open) return` before deciding a `alfyActivity.key` was new. It could
not distinguish "the panel just started watching this artifact" (any pre-existing activity key already sitting on
that artifact at that instant is stale — the user hasn't newly seen anything, it was already there) from "the panel
was already open and watching, and this key is a genuinely new arrival." Because Svelte batches reactivity, `open`
flipping true and the active artifact/document changing can land in the very same effect run, so a plain `!open`
gate could not tell which case it was in.

**Two failed intermediate attempts, kept here since both are instructive:**
1. `if (!open) return` alone (the pre-existing code) — confirmed failing via the exact T8 test above.
2. Added `alfyActivity.status !== "running"` as a second gate — fixed that test, but broke a different, previously-green
   one: `artifact-document.spec.ts:1033` ("marks the applied block and shows the refusal notice for the refused one").
   Root cause of the new break: the fake-provider test harness resolves fast enough that Svelte's own reactivity can
   skip straight from no-activity to `"applied"` without an intermediate render where `"running"` is independently
   observed, so gating on `"running"` silently no-ops for that test's timing.

**Fix:** replaced the boolean gate with an explicit history-tracking `Map` (`staleKeyWhenWatchStarted`, keyed by
`artifactId`) plus a `previousWatch` snapshot (`{ open, artifactId }`). A "watch" is defined as starting exactly when
`open` transitions true, or the active artifact/document id changes while already open. At the instant a watch
starts, whatever `alfyActivity.key` already exists for that artifact (if any) is recorded as that artifact's stale
baseline and can never later count as "newly seen." Any activity key that shows up AFTER that instant, or that
belongs to a different artifact, is evaluated normally against `alfyActivitySeenOpenKeys`. This correctly separates
"stale, already-there-when-we-started-looking" from "arrived while we were already watching" regardless of whether
`open` and the active artifact change together or separately, and does not depend on observing any particular
in-between `status` value.

**Test:** verified against both e2e tests directly (`artifact-document.spec.ts:1195`'s T8 "chat card, list row and
count-button dot follow the persisted review state through Keep all and a reload", and `:1033`'s "marks the applied
block and shows the refusal notice for the refused one") together in the same run, then the full
`artifact-document.spec.ts` file, then the full required Playwright gate (see Gates below). I did not add a new
unit test for `DocumentWorkspace.svelte` itself — it has no existing unit-test file in this codebase (the component's
own coverage is exclusively through these Playwright flows), and adding one now would mean building test scaffolding
for a file I was told not to otherwise touch (it partially overlaps fix agent D's ownership — see Constraints); the
two e2e tests above already pin the exact regression and its fix.

Commit `456c7b9f`.

## Gates (run once, at the end, per common.md; re-run again after `456c7b9f` landed, since that commit came after the
first full pass — both passes agree on every number below)

1. **`npm run check`** — 0 errors, 17 warnings (exact pre-existing baseline, unchanged across both runs:
   `ToolActivityRow.svelte` 10, `ThinkingBlock.svelte` 6, `RouteItinerary.svelte` 1 — none of these three files are
   touched by any of my commits). Caught and fixed one real regression along the way during development (a new
   `a11y_interactive_supports_focus` warning from adding `onkeydown` to `SelectionBubble.svelte`'s `role="dialog"`
   div without a `tabindex` — fixed before the final run, per common.md's "a new warning is a regression" rule; the
   final run is clean, `7961 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS`).
2. **`npx biome check src scripts tests`** — clean, 2141 files, no fixes needed on the final pass (a few
   formatting-only auto-fixes were applied and re-verified during development).
3. **`npm test`** — final run: 897 files passed + 1 skipped (898), 13760 tests passed + 2 skipped (13762), exit 0.
   No failures. The 2 skipped were already-skipped before this round (not mine).
4. **Playwright**, on port 5490, the brief's exact required glob — `tests/e2e/artifact*.spec.ts
   tests/e2e/artifacts-*.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts`
   (covers `artifact-document.spec.ts`, `artifact-document-review-bar.spec.ts`, `artifacts-api.spec.ts`,
   `artifacts-panel.spec.ts`, plus the two general chat-regression files) — final run: **99 passed, 0 failed
   (4.8m), exit 0**. Two flakes were triaged and confirmed non-regressions during development, both re-run in
   isolation to confirm: a `page.goto: net::ERR_ABORTED` on "opens a document from the panel and shows its content
   in the editor" (transient dev-server/navigation timing, passed alone); and `:1033`'s refusal-notice test failing
   under the now-superseded second attempt at the `DocumentWorkspace.svelte` fix above (fixed by the final
   history-tracking approach, not a lingering issue).
5. **`npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-fxc.json`** — `total_issues: 124`,
   `circular_dependencies: 4` — exact baseline, zero new findings. Re-run once more after `456c7b9f`
   (`/tmp/fallow-fxc-final.json`) with the same numbers.

## Screenshots

Not captured. My findings are all logic/server/a11y fixes (review state correctness, focus management, ARIA
attributes, announced text, i18n string selection) rather than visual/layout changes the spec's mockup would show
differently — there is nothing new for a screenshot to usefully compare against the mockup. The one genuinely
user-visible change (the real avatar initial instead of "U") is directly asserted by `CommentCard.test.ts`/
`VersionsSheet.test.ts` rather than screenshotted.

## Deviations from the brief, with reasons

1. **Left the ⋯/+ buttons inside `Tabs.svelte`'s own `role="tablist"` element** (the third sub-item of the tabs-ARIA
   finding). They are currently laid out via normal flex flow immediately after the active tab's own label inside
   `.document-tab-item`; moving them structurally outside the tablist while preserving that exact visual adjacency
   would require rect-based absolute positioning for the ⋯ TRIGGER button itself (today only the dropdown MENU it
   opens is positioned that way, via `portalToBody` + a measured rect). That is a materially bigger change to a
   component fix agent B recently and carefully fixed for this exact clipping/positioning surface (`4c8035cc`,
   `c5d51adc`), and the underlying FUNCTIONAL bug does not exist today: `handleTablistKeydown`'s own arrow-key
   navigation already operates strictly on the real tab buttons (`tabs.findIndex`/`tabButtons.get`), never touching
   ⋯/+. Only the static ARIA-tree structure is imperfect. Judged not worth the regression risk for a "minor, cheap"
   finding; flagged as a follow-up instead of attempted.
2. **No screenshots** — see above; none of my findings are visual/layout changes.

## Hand-off — reuse these

- **`stripEmptyTabAnchorPlaceholder(text)` / `EMPTY_TAB_ANCHOR_PLACEHOLDER`** (`$lib/shared/artifact-document/blocks.ts`):
  the one shared point for "this text may contain `appendEmptyTabSection`'s own zero-width-space placeholder; give me
  it back clean." Any FUTURE reader of a Document's block text that isn't the live editor itself (a new export
  format, a new model tool, a new preview surface) should call this rather than reading `block.markdown`/`block.label`
  raw.
- **`encodeKeptBlock`/`parseKeptBlockVersions`** (`document-ops.ts`, not exported — internal to the ruling-61
  persistence functions): the `"<blockId>@<version>"` encoding for a per-block "kept as of this Alfy version" fact.
  If Canvas/Slides ever get their own ruling-61-shaped persistence (rd4b's own hand-off already names this as the
  template to reuse), carry this version-tie forward too — a bare block id with no version is exactly the bug this
  round fixed.
- **`acknowledgeDocumentReviewBlocks` now validates against `pendingBefore` before writing anything** — any future
  caller of a similar "acknowledge these ids" endpoint should follow the same shape (recompute the current truth,
  filter the caller's input against it, never trust a raw client-supplied id list into storage).
- **`focusAfterKeep`'s pattern** (`DocumentBody.svelte`): check the REACTIVE state (`pendingList.length`), never bare
  DOM presence, when deciding whether a transient UI element (here, the review bar) is "really still there" versus
  merely still painted mid-exit-transition. A `{#if}`-gated element's own OUT transition keeps it (and its
  interactive children) in the DOM for a moment after the condition that gates it has already gone false.
- **`ChangeBar.svelte`'s Redo autofocus `$effect`**: the general pattern for "this status value is only ever reached
  by the user's own just-now action, never a fresh load or an unrelated live update landing — safe to autofocus
  unconditionally on mount." Verify that invariant explicitly (as I did here, by checking every code path that can
  produce the status) before copying the pattern; it is NOT safe for a status reachable multiple ways (e.g. "pending",
  reachable both by a fresh Alfy edit landing AND by Redo — that one needs an explicit "this specific transition was
  user-initiated" signal, which I deliberately did not build since only Keep/Undo were in scope this round).
- **The one shared announcer** (`DocumentBody.svelte`'s `announce()` / `data-testid="document-announcer"`): the
  established pattern already existed elsewhere in the codebase (`MessageInput.svelte`'s own
  `composer-extraction-announcer`/`composer-attachment-announcer`) — I followed it rather than inventing a new one.
  Any future Document event worth announcing should call `announce()` rather than adding a second `aria-live` region.
- **The "stale-at-watch-start" snapshot pattern** (`DocumentWorkspace.svelte`'s `staleKeyWhenWatchStarted`): when a
  guard needs to tell "this value already existed when we started watching" from "this value arrived while we were
  already watching," and the two Svelte reactive inputs that define "started watching" (here: `open`,
  `activeDocument`'s id) can change together in the same effect run, a plain boolean/equality gate checked on every
  run cannot distinguish the two cases. Snapshot the watched value into a `Map`/variable exactly at the transition
  edge (recomputed each run from a `previousWatch`-style prior-state comparison, not from a value that resets itself),
  and compare against that snapshot rather than re-deriving "is this new" from the current values alone. Any future
  "X changed since we started paying attention to Y" guard in this codebase should reach for this shape before a
  `status`-value gate, which is timing-dependent on which intermediate states a given code path actually renders.
- **The ICU-plural-with-nested-placeholder trap**: `{name}` must sit OUTSIDE a `{name, plural, one {…} other {…}}`
  block in this codebase's `i18n/index.ts` — a nested `{name}` inside a branch silently fails to resolve (the plural
  regex's branch capture excludes braces). `panel.count`/`panel.pendingReview`/`cardSubtitle` show the correct shape;
  `review.summary` and my own new `tab.openCommentsA11y` both had to be fixed to it this round. Worth a `grep -n
  "plural,"` sanity check across `src/lib/i18n/*.ts` before adding any new count-bearing plural key, and worth
  someone eventually hardening the regex itself (out of scope for me — a shared utility used far beyond Documents).
