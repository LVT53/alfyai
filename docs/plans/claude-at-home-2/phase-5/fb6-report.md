# FB-6 report: the Document and comments (F6, F13, F14, F18, F24, F28)

Model: Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `.claude/worktrees/art-fb6`, branch `fix/friction-document`,
from `feat/artifacts` at `de7beaa0`. Commits `de7beaa0..5a411daa`, one per finding, red first, real input
(mouse double click, tap, keyboard, the real chat turn through the fake provider).

| Commit | Finding |
|---|---|
| `32fc8754` | F28 the single-tab strip's add button says "Fül hozzáadása" |
| `8a3d4f17` | F24 the comment column takes no room until there is something in it |
| `7d32e3cd` | F13 the review bar is one row on a phone |
| `75c33288` | F14 an @Alfy comment is posted at once, the thread says "Alfy válaszol…" |
| `9b33a515` | F18 Keep no longer moves the text by a line in one frame |
| `4ac64682` | F6 "Alfy dolgozik a dokumentumon…" from Alfy's first look until the change lands |
| `5a411daa` | F6 follow-up: the strip a read-only turn leaves goes when the turn ends (found by my own two-turn test) |

## Per finding: what changed and where

**F28** `document/Tabs.svelte`: the single-tab branch's button is `+ Fül hozzáadása` (icon and words, left in the strip, text
from the existing `artifacts.document.tab.add`); the multi-tab strip keeps the compact "+". Accessible name unchanged.

**F24** `document/DocumentBody.svelte`: `commentsRailShown` now also needs something to list (`comments.length > 0` or the
"your words win" card) or the reader's own opening (`railPinned`, per body). Until then a 40 px strip with one quiet
comments button (`data-testid="document-comments-affordance"`, name = `artifacts.document.margin.show`) stands where the column
will be. The first comment brings the column by itself. The header toggle stays: with nothing to list it opens/closes the empty
column for this body; with something in it it is the device-wide choice as before. Four unit tests and one e2e that assumed an
always-present empty column were updated to seed a comment or open it on purpose.

**F13** `artifacts/ReviewBar.svelte` (shared, so the board's bar too): at max-width 480 px one row of about 53 px (was about 150):
spark, count "1 / 2" and the stepper (only with more than one change; with one, the sentence takes its place), Keep and Undo with
short words "Megtart" / "Visszavon" (EN "Keep" / "Undo"), all 44 px targets. Accessible names stay "Mindet megtartom" / "Mindet
visszavonom" (aria-label); the sentence stays for a screen reader when more than one change; a refused part's link is the only
reason for a second line. Checked at 390 and 360 with touch.

**F14** `document/DocumentBody.svelte`: `postComment` / `postReply` post and refresh, then run the Alfy reply detached
(`maybeAskAlfy` → `askAlfyAboutComment`), so the composer closes at once. `answeringThreadIds` (state) goes through `MarginPanel`
(new prop) and `CommentsSheet` (spread) to `CommentThread`'s existing `alfyBusy` row, now with its own words
(`busyLabel` = `artifacts.document.comment.alfyAnswering`, "Alfy válaszol…"; the board's row keeps "Alfy ír…"). One answer at a
time per thread: the Reply button waits and a second ask on a thread being answered sends nothing. Double press: the bubble's
own `posting` guard covers the post, the thread guard covers the reply (e2e double-clicks the send button: one POST, one ask).

**F18** two causes, measured at 390 (last paragraph, every frame): (1) at Keep the pending pill (262 px, wrapped onto a line of
its own) became the narrow "Megtartva" pill, which fits on the text's last line, so the line vanished: -28 px at the press;
(2) at the end of the Kept window the removal took the line again: -31 px. Fix: (1) `change-pill-decoration.ts` sets
`--change-pill-hold-width` on the new pill from the old one (ProseMirror builds the new widget before it removes the old) and
`ChangeBar.svelte` uses it as `min-width` while "kept/undone"; (2) new `document/change-pill-removal.ts`
(`removeChangePillSmoothly`): FLIP of the blocks below (Web Animation `translateY`, no attribute touched, so ProseMirror's DOM
observer never sees it), a second pill leaving takes the first's easing over (Keep all = one glide), reduced motion = instant.
Result: biggest move between two frames 31 px to about 5 px (225 ms glide); desktop 1440 1 px to 0.

**F6** the browser hears nothing about an `edit_artifact` call until the model has written all of it, and the call then answers in
milliseconds, so "from the first edit tool call" would have shown the state for a blink (that is what the audit saw). Trigger
used instead: the first look at the open Document in a turn that is still running. `alfy-activity.ts`:
`buildDocumentReadActivity` (a `read_artifact` that is done and whose metadata says `artifactKind: "document"`; a running
activity that never settles); `chat/[conversationId]/_helpers.ts` `findLiveDocumentAlfyActivity`: hands it on only while that
message `isStreaming`, and only when no edit/create call of the message is known (the edit takes over). Because it exists only
while the turn streams, stopped/failed/finished turns take it away. `DocumentBody.svelte`: state `alfyWriting`
`{key, summary, reading}`; kept until `landAlfyActivity` has put the change in the panel (not until the call settles); cleared
on failure, on an unloadable Document, and (follow-up commit) when the page falls back to an earlier, already landed call
because a later read-only turn ended. `AlfyWriting.svelte`: a quiet one-line strip under the toolbar (was a dashed box), the
board's wording (`artifacts.document.working` / `workingSummary`), inside a slot that slides (`reducedMotionAware(slide)`).
`artifacts.document.planned.writing` is gone (EN and HU).

## New strings (`src/lib/i18n/artifacts.ts`, EN and HU together)
`artifacts.document.review.keepShort`/`undoShort`; `artifacts.document.comment.alfyAnswering`; `artifacts.document.working`,
`artifacts.document.workingSummary`. Removed: `artifacts.document.planned.writing`. Reused: `artifacts.document.margin.show`.

## Tests added
- `tests/e2e/artifact-document-friction.spec.ts` (new, 10 tests, Hungarian): F28; F24 x3 (no column and the room, first comment
  brings it, the quiet button opens it and the header closes it); F13 x3 (390 two changes, 390 one change, 360, touch);
  F14 (composer closes while the held Alfy answer is pending, pending row, one POST and one ask on a double press);
  F18 (390, per-frame movement); F6 x3 (state from the read until the change lands, a stopped turn, a stopped read-only turn
  with an earlier landed change behind it).
- Fake provider: scenario `AI_SMOKE_EDIT_DOCUMENT_SLOWLY_*` (`tests/fixtures/ai/openai-compatible-scenarios.ts`,
  `tests/mocks/ai-provider/openai-compatible-provider.ts`): the model reads the Document, takes `delayMs`, then patches one block.
- Vitest: `change-pill-removal.test.ts` (new), `alfy-activity.test.ts`, `_helpers.test.ts` (live scan), `AlfyWriting.test.ts`,
  `DocumentBody.test.ts` (F24, F14, F6 incl. the fall-back case), `CommentThread.test.ts`, `Tabs.test.ts`.
- `artifact-document-review-bar.spec.ts` (the "never covers the column" test now seeds a comment).

## Gates (`scripts/gates.sh agent ... --port 5440 --workers 4`, commit `5a411daa`)
```
check      FAIL  3 errors, 17 warnings in 8465 files   (the 3 are NOT mine, see below; warnings = baseline 17)
biome      ok    No fixes applied
migrations ok
vitest     ok    1061 files, 18003 tests passed (2 skipped)
build      ok    unused-css=32 aria=2 (baseline 32/2)
chunks     ok    editor closure 70.9 kB gzip
fallow     ok    total=124 circular=4 new_vs_baseline=0
playwright ok    146 passed, 0 failed, 0 flaky on 4 workers (friction + artifact-document*.spec.ts x8 + artifact-history + @smoke)
```
`npm run check` errors, pre-existing (from FB-2's last commit, FB-5 fixes them): `scripts/eval-artifact-contracts/suites/canvas-tools.ts`
280:37 and `canvas-tools.test.ts` 232:6, 234:36 ("'instruction' does not exist"). My changes add no diagnostic.
A first gate run failed in 13 s because I had passed a helper file (`artifact-document-polish-helpers.ts`) as a spec; rerun was clean.

## Screenshots (looked at each; Hungarian, light)
In `fb6-shots/`: `f24-f28-desktop-empty.png` (1440: "+ Fül hozzáadása" at the left, the quiet comments strip, text with the room),
`f13-phone-390-2.png`, `f13-phone-360-2.png` (one row: spark, ‹ 1/2 ›, Visszavon, Megtart), `f14-pending-reply.png` (composer gone,
comment in the column that appeared with it, "Alfy válaszol…" row, the block dimmed with "Alfy írja…"), `f6-working-1440.png` (the strip
under the toolbar while the model writes; the chat shows "Elolvasva" and "Gondolkodás…"). No dark-mode capture (tokens only).

## Deviations, interpretations, concerns
1. **Ownership.** The build-plan row reads "except ... ReviewBar.svelte, the comment components"; F13 and F14 are assigned to me and
   live there, so I read those as mine. I touched `ReviewBar.svelte` (shared with the board's bar) but not `CommentComposer`,
   `CommentsSurface`, `CommentCard`. FB-4 was told about the board's phone bar becoming one row (it also pinged me about a pkill: none of my runs died).
2. **F6 trigger** is the first read of the open Document, not the first edit call (see above). A turn that only reads the Document
   and answers shows "Alfy dolgozik a dokumentumon…" until it ends: a small over-statement, quiet, and it never sticks.
3. **F6 touches** `chat/[conversationId]/_helpers.ts` (about 15 lines, FB-3/FB-7 area, not `+page.svelte`) and widens
   `DocumentAlfyToolName` with `"read_artifact"`; the board and the App ignore it (only a *Document* read produces it).
4. On a phone the chat is under the panel, so F6 cannot be driven from the chat there; the strip shows if the panel is opened
   after the question. Not tested on a phone.
5. F14: the thread's Reply button is disabled while Alfy is answering there (one answer at a time), which matches the old
   effective behaviour (the composer was blocked until the reply came).
6. I added one bullet to `AGENTS.md` (Artifacts section, before "One body per open item") describing the F6 trigger, the pill
   removal FLIP and the rail rule.

## Hand-off
- `document/change-pill-removal.ts` `removeChangePillSmoothly(root, changeId, remove)`: the way to take a pill away; `--change-pill-hold-width` (set by `change-pill-decoration.ts`, read by `ChangeBar.svelte`).
- `alfy-activity.ts` `buildDocumentReadActivity`, `DocumentAlfyToolName` + `"read_artifact"`; `DocumentBody` `alfyWriting` / `landingActivityKey`.
- `MarginPanel` prop `answeringThreadIds` (CommentsSheet passes it through); `CommentThread` prop `busyLabel`.
- `DocumentBody` `railPinned`, `railHasContent`, `commentsAffordanceShown`; test id `document-comments-affordance`.
- Fake provider scenario `AI_SMOKE_EDIT_DOCUMENT_SLOWLY_MARKER` + `encode/decodeEditDocumentSlowlyPayload`: any spec that needs "a model that takes a while" on a Document.
