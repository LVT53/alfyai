# UI wishes batch — November 2026 (implementation plan)

Status: **ready to dispatch.** The behaviour contract is [spec.md](./spec.md); read it first. This file is
the execution plan: slices, tasks, worker scopes, review gates, the impartial judge, and the one final
gate. Written 2026-11-12.

Authority order: the wishlist (what the owner asked) → `spec.md` (how it behaves) → this plan (who does
what, in which order). A task that needs to contradict `spec.md` goes back to the owner; the plan does not
silently widen.

## 1. Goal

Five disjoint slices deliver W2, W3, W5, W6, W7, W11, W12, W13 and W14, each behind its own tests,
reviewed slice by slice, then judged by an independent reviewer against the spec, then gated once by the
orchestrator.

## 2. Non-goals

- W1, W4, W8, W9, **W10** (held back by the owner on 2026-11-12). They keep their wishlist entries.
- No stored-format change, no migration, no new tool, no new top-level server service, no route-contract
  change.
- No push, deploy, admin-setting change or live test.
- No refactors "while we are here": a slice touches only its listed files.

## 3. Orchestration model

- The orchestrator writes no feature code. It writes this plan, dispatches workers, reviews every diff,
  runs `npm run check` per slice as it lands, runs the one e2e gate, and reports.
- One worker per slice. Workers run in parallel because their write scopes do not overlap (§5).
- A fresh reviewer per slice, never the implementer, reads the diff against the spec of that slice.
- One **impartial judge** at the end, with no part in the implementation, reviews the whole diff against
  `spec.md` (§8).
- The orchestrator keeps the state table (§4) current; a slice is `pending → dispatched → in review →
  accepted`, or `returned` with findings.

## 4. State table

| # | Items | Owner | Write scope | Status |
|---|---|---|---|---|
| S1 | W7, W11, W12, W13 | worker-panel | `src/lib/components/artifacts/` (`app/`, `ArtifactCard.svelte`), `src/lib/i18n/artifacts.ts` | pending |
| S2 | W2, W6 | worker-chatnav | `src/lib/components/chat/MessageArea.svelte`, `ConversationJumpRail.svelte`, `src/routes/(app)/chat/[conversationId]/+page.svelte`, new offset helper | pending |
| S3 | W3 | worker-tools | `src/lib/components/chat/ToolActivityRow.svelte`, new `tool-call-summary.ts`, `src/lib/i18n/chat.ts` | pending |
| S4 | W5 | worker-askcard | `src/lib/shared/ask-user.ts`, `src/lib/server/services/normal-chat-tools/ask-user.ts`, `src/lib/components/chat/AskQuestionCard.svelte`, `normal-chat-tools/index.test.ts` | pending |
| S5 | W14 | worker-pictures | `src/lib/server/services/images/` (`inputs.ts`, `requests.ts`, `read-model.ts`), `src/lib/components/artifacts/image/ImageCardBody.svelte`, their tests | pending |

Before dispatch the orchestrator records `git status --short --branch` and `git log -1 --oneline`, and
tells every worker: **"You are not alone in the codebase. The worktree already has unrelated modified and
untracked files (`AGENTS.md` among them). Do not revert, format or commit anything outside your write
scope."**

## 5. Tasks

Every task is TDD: the smallest failing test first, then the change, then the focused test green. A task
that cannot be tested first says why and adds a regression check instead. Task ids are stable for review
references.

**Guide check, every slice (root `AGENTS.md`, rule added 2026-11-12).** If the item adds, removes, renames
or moves a user-facing feature or a pictured control, the same slice updates the Feature Guide entry
(`src/lib/components/guide/guide-content.ts`, `src/lib/i18n/guide.ts` in EN and HU) and the section's
drawing when the control is pictured, keeping its Show me spotlight marker on a moved control. The
worker's report states whether its control appears in the guide and what it changed; `feature-guide` is
in the gate for every slice.

### S1 — the App panel pass (worker-panel)

Scope: `src/lib/components/artifacts/app/*` and `ArtifactCard.svelte`; the App-panel keys of
`src/lib/i18n/artifacts.ts`. No other dictionary.

- **S1.T1 (W13) — delete the sandbox notice row.** Files: `AppFrame.svelte`, `i18n/artifacts.ts`,
  `AppFrame.test.ts`.
  1. Red: a test asserting the frame draws no sandbox sentence (and the preview variant draws none).
  2. Remove `.app-frame-sandbox-bar` markup and its now-unused CSS; keep `.app-frame-stage` layout and
     the iframe untouched.
  3. Remove `artifacts.app.sandboxBar` and `artifacts.app.sandboxBarPreview` from **both** dictionaries.
  4. Green: `npx vitest run src/lib/components/artifacts/app/AppFrame.test.ts` and the i18n parity test.
  - Review focus: no gap left, no leftover key, preview state still identifiable by its own chrome.

- **S1.T2 (W11) — even segments in Preview/Code.** Files: `AppBody.svelte` (`app-seg`, ~576),
  `AppVersionPreview.svelte` (`seg`, ~271), their tests.
  1. Add a Playwright assertion (written here, run in the gate) that both segments of the switcher have
     equal width and equal inner padding, in `artifact-app.spec.ts`.
  2. Fix the padding in both controls (the defect exists in both; fixing one leaves the other wrong).
  - Review focus: identical treatment in both controls, no layout shift on switch, accessible name kept.

- **S1.T3 (W12) — centre the row time.** Files: `ArtifactCard.svelte` (row chrome), its test,
  `tests/e2e/artifact-panel-rows.spec.ts`.
  1. Red: a row with no review pill reports the time about 10 px above the row's centre.
  2. Keep `.artifact-row-end` a column. When no pill is drawn, take the hover chevron out of the
     flow (it stays where it is visually) so the time is the only in-flow child and the column
     centres it; when a pill is drawn, leave the stack exactly as today.
  3. Playwright assertion: with no review marker, the time's centre is within 2 px of the row's
     centre and the end block is no wider than the time; rows with Reviewed and pending pills keep
     their stacking.
  - Review focus: no switch to a row, no wider end column, the chevron unmoved, long wrapping titles.

- **S1.T4 (W7) — the regenerate button's gap and popover.** Files: `AppBody.svelte` only.
  1. Gap: match the measured gap of a neighbouring icon+label button in the same panel (report the
     number); no new wrapper.
  2. Popover: restyle to `AnchoredPopover`'s shell and rhythm (border, radius, surface, shadow, row
     height, padding, type scale). Contents unchanged.
  3. Red: a component assertion that the trigger carries the shared gap class/token; e2e
     `artifact-app.spec.ts` keeps opening, Escape and focus-trap behaviour.
  - Review focus: the popover still positions correctly at the panel edge and the phone breakpoint; no
    inline `<svg>`; both languages.

Order inside S1: T1 → T2 → T3 → T4 (trivial to judgemental; T4 last so it can reuse T2's tab work).

### S2 — chat navigation and the phone counter (worker-chatnav)

Scope: `MessageArea.svelte`, `ConversationJumpRail.svelte`, `(+page.svelte)`, a new pure helper beside
`MessageArea` (e.g. `message-jump-offset.ts`), and the tests for them. Nothing else.

- **S2.T1 (W2) — the offset helper.** New `message-jump-offset.ts`:
  `jumpOffset({ targetTop, targetHeight, containerTop, containerHeight, gap })` returns the scroll delta
  that puts the message's **top** at `containerTop + gap`, clamped by the container's own scroll range
  (the browser clamps the rest). Unit tests, red first against today's centring formula: tall message,
  one-line message, first message (negative clamp), last message (positive clamp), reduced-gap variant.
- **S2.T2 (W2) — use it.** Replace the centring maths in `scrollToMessage` with the helper. Keep
  `releaseHeldPosition()`, `shouldAutoScroll = false`, `tick()` + `requestAnimationFrame`, the smooth
  scroll and the reduced-motion branch. Test: `MessageArea.test.ts` asserts the helper is used with the
  container rect (no second formula left in the component).
- **S2.T3 (W2) — e2e coverage.** Extend `chat-scroll-on-load.spec.ts` (open at `?message=`) with a
  long-answer case: the message's top is within a few pixels of the reading area's top. Keep
  `chat-scroller.spec.ts` and `search-modal.spec.ts` green. Written here, run in the gate.
- **S2.T4 (W6) — floating phone counter.** Files: `(+page.svelte)` (compact button ~5264 and its CSS),
  a placement helper, a component test.
  1. Red: the compact button is 32 px and sits in the header row on a phone.
  2. Make it a floating pill in the jump-to-latest capsule's family: elevated surface, border, shadow,
     ≥44×44 px target, safe-area inset, below the panel's z-index, hidden while the panel is open.
  3. Playwright: 375×667 and 390×844 — target ≥44 px, no overlap with the composer, the rail or the
     header; desktop unchanged.
  - Review focus: pending dot still drawn, aria label unchanged, opening the panel hides the pill, no
    second list.

Order: T1 → T2 → T3 → T4. Both W2 and W6 touch `(+page.svelte)`, so this stays one owner, one branch of
edits.

### S3 — the tool and skill dialog (worker-tools)

Scope: `ToolActivityRow.svelte`, a new `tool-call-summary.ts` beside it, `i18n/chat.ts` chat-detail keys,
and their tests.

- **S3.T1 — the summary module.** `describeToolCall(input): { actionKey, target, outcome, detail }`
  where `input` is the row's existing data (tool name, label, arguments, result, status, duration).
  It returns **parts, never sentences** (i18n stays in the component). Rules: unknown tool → generic
  action key + no target; missing target → no clause; failure → failure outcome; running → running
  outcome; target clipped to a sane length at a word boundary.
  Unit tests, red first: a search with 12 results, a failed call, a running call, no readable target, an
  unknown tool name, a very long argument.
- **S3.T2 — the words.** Add the frame keys and the small per-tool noun set to `i18n/chat.ts`, EN and HU.
  Keep the per-tool set small (only tools whose generic phrasing reads badly); the generic fallback is
  mandatory. Parity test.
- **S3.T3 — render it.** In the row's expanded body: summary paragraph (1–3 short lines), then the
  outcome line, then a closed "Details" disclosure holding the raw arguments and result. No raw JSON
  outside the disclosure; a running call shows the running line; the existing meta stays.
- **S3.T4 — tests.** Component test on the expanded body for the five cases; e2e
  `chat-failed-tool-row.spec.ts` plus one successful search path in `chat.spec.ts` (written here, run in
  the gate).

Review focus: no second vocabulary beside the row's labels, no server call, no JSON as primary text,
Hungarian reads naturally, the disclosure is keyboard operable.

### S4 — the Ask-me card's description (worker-askcard)

Scope: `src/lib/shared/ask-user.ts`, `normal-chat-tools/ask-user.ts`, `AskQuestionCard.svelte`, the
catalogue snapshot test, their tests.

- **S4.T1 — the limit and the type.** Add `detailChars: 280` to `ASK_LIMITS`; add `detail?: string` to
  `AskQuestion`; extend `problemsOf` to refuse an over-cap or whitespace-only detail with the model's own
  numbered wording (the existing style), and to accept a card without one.
  Tests, red first: at the cap passes, one over fails, whitespace-only fails, absent passes.
- **S4.T2 — the shown schema.** Add the optional field with `.describe("Optional explanation of the
  question, one or two sentences.")` to the capped copy only (the executing copy stays cap-free, as the
  module's header explains). Then re-baseline `CATALOGUE_TOKEN_CEILING` with a **measured** number and a
  comment line recording the date, the old value and why; if the raise is refused, cut wording elsewhere
  in the same tool text and record that instead.
- **S4.T3 — storage and read path.** Verify the question row's stored shape carries the field through
  `recordAskQuestion` and the questions route without a column change (it is JSON); if it does not, stop
  and report — no migration was planned.
- **S4.T4 — the card.** Draw the detail under the title in the muted body style, wrapping, before the
  options; nothing when absent. Keep the folded answered line title-only.
  Component test: with detail, without, over-long wrapping, phone width class.
- **S4.T5 — e2e.** Extend `ask-me-first.spec.ts` with a card that has a detail (fixture or fake model
  response) and one that does not (written here, run in the gate).

Review focus: one cap, read by schema/check/card; the fold stays one line; the model still writes its own
language; no app English pushed into model text.

### S5 — a picture made from several sources shows them all (worker-pictures)

Scope: `src/lib/server/services/images/` (`inputs.ts`, `requests.ts`, `read-model.ts`) and
`src/lib/components/artifacts/image/ImageCardBody.svelte`, with their tests. **Not** `ArtifactCard.svelte`
(S1's row chrome) and not `make-image.ts`'s schema.

- **S5.T1 — prove where the picture is lost (diagnosis, no fix yet).** One test at the request level:
  naming three pictures produces `mode: "edit"` with one `base` and two `reference` inputs, in the named
  order. One at the read-model level: the same take's view exposes all three, in prompt order. Run both
  against today's code and record the exact failing assertion. **If the request already carries only one
  reference, stop and report immediately** — that is a result made from fewer pictures than the person
  gave (P1), not a display fix, and the owner decides before anything else happens.
- **S5.T2 — one ordered list.** Make the read model expose the take's full source list in prompt order
  (base first, then references) as one field. Check every reader of `sourceFileIds` before renaming or
  extending it; prefer a new field over overloading a shared one. The list is the only source of truth —
  the component must not concatenate base and references itself.
- **S5.T3 — the row.** `ImageCardBody` draws its numbered thumbnails from that field, so the numbers match
  `<image1>` … `<imageN>`; the row stays absent for `words` and `photo` cards; the ten-picture cap clips
  without breaking layout.
- **S5.T4 — tests.** Read-model unit test (2 and 3 sources, order, no duplicates), the request-level test
  from T1 now green, a card component test (two thumbs, numbering, no row for words), and an e2e case in
  `images.spec.ts` (a card made from two sources draws two thumbnails).
- **Guard:** what the model receives must not change for the same pictures — this is a display fix unless
  T1 proved otherwise.

Review focus: the request is untouched, the thumbnails are the right pictures, the numbers match the
prompt, nothing else on the card moves.

## 6. Final gate (the orchestrator, once)

```bash
scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 4610 \
  tests/e2e/chat.spec.ts \
  tests/e2e/chat-scroller.spec.ts \
  tests/e2e/chat-scroll-on-load.spec.ts \
  tests/e2e/search-modal.spec.ts \
  tests/e2e/chat-header-room.spec.ts \
  tests/e2e/chat-failed-tool-row.spec.ts \
  tests/e2e/ask-me-first.spec.ts \
  tests/e2e/artifact-app.spec.ts \
  tests/e2e/artifact-panel-rows.spec.ts \
  tests/e2e/images.spec.ts \
  tests/e2e/images-pipeline.spec.ts \
  tests/e2e/feature-guide.spec.ts
```

Run once, at the end, after the judge's findings are settled. A red step goes back to the smallest
responsible slice and the whole gate is rerun — never a weakened assertion, a blanket retry or a widened
timeout. A spec a worker added joins this list; if a named spec turns out not to own its surface, it is
replaced and the swap is reported.

## 7. Review gates

1. **Slice reviewer (fresh subagent, not the implementer).** Gets `spec.md`, the slice's tasks, and the
   diff. Checks: the acceptance states, the EN/HU pair, runes mode, Lucide icons, boundary of the fix, no
   unrelated drift, and that the tests fail without the fix. It runs the slice's focused tests and reports
   findings as **blocker / should-fix / nit** with file:line.
2. **Orchestrator.** Re-reads the diff itself (the reviewer's report is not the review), runs
   `npm run check` once for the slice, and either accepts it or returns it to the same worker.
3. **Rework loop.** A blocker goes back to the owning worker with the finding; after two rounds on the
   same blocker the orchestrator takes the smallest integration fix itself and says so in the report.

## 8. The impartial judge (after all five slices are accepted)

A fresh subagent with **no part in the implementation** and no access to the workers' reports. It receives
`spec.md`, this plan, and the full diff (`git diff` plus new files), and it must:

1. **Verify by reading, per item** — W2, W3, W5, W6, W7, W11, W12, W13, W14 — that the code path
   implements the acceptance, citing file:line. An item it cannot trace is `UNCERTAIN`, not `PASS`.
2. **Reproduce** — run the focused unit/component tests for all five slices itself and paste the results.
3. **Attack** the edges named in the spec: last message and one-line message (W2); unknown tool and
   running call (W3); over-cap and empty detail (W5); 375×667 and a very long chat (W6); popover at the
   panel edge (W7); switching tabs repeatedly (W11); row with and without Reviewed (W12); preview state
   and a removed string (W13); **two and three sources, their order and numbering, and a words-only card
   (W14)**.
4. **Check the Feature Guide** for every item that touches a pictured control (root `AGENTS.md` rule):
   the entry exists or is correctly absent, EN and HU match, the drawing matches the control, a moved
   control keeps its spotlight marker, and `feature-guide` is in the gate.
5. **Hunt regressions**: unrelated changes, a second scroll path, a second vocabulary, a duplicated cap,
   a leftover i18n key, a raw `<svg>`, a `sessionStorage` write, a direct `process.env` read, a route
   doing service work, a guide entry left stale.
6. **Report** per item: `PASS` / `FAIL` / `UNCERTAIN`, the evidence (file:line and the command output),
   and a short list of anything a person would notice that the spec missed.

The judge may not edit code. Its `FAIL`s are fixed by the owning worker and re-judged; `UNCERTAIN`s are
resolved by evidence or explained in the final report.

## 9. Failures, flakes and scope

- A flaky e2e is a bug in the test or the app: find shared state or a mid-animation measurement; use
  `waitForStableBoundingBox`, `waitForMotionToSettle`, `expectTopmost` from `tests/e2e/helpers.ts`.
- If an item turns out to need a file outside its slice's scope, the worker stops and reports; the
  orchestrator decides — it does not edit another slice's files.
- If W5's measured ceiling raise is unacceptable to the owner, the slice ships without the schema change
  only if the card can still show a detail some other way; otherwise it is parked and reported.

## 10. Commits

One local commit per logical change, why-first messages, no push:

1. `docs: spec and plan for the November UI wishes batch` (this file and `spec.md`);
2. `fix(chat): jump to a message lands at its top` (W2);
3. `feat(chat): tool and skill dialogs describe what happened` (W3);
4. `feat(ask): the question card can explain itself` (W5);
5. `feat(chat): the phone's artifact counter floats` (W6);
6. `fix(app-panel): icon gap, popover, tabs, row time, sandbox row` (W7, W11, W12, W13);
7. `fix(images): a picture made from several sources lists them all` (W14).

A slice whose change is genuinely two unrelated fixes gets two commits; nothing is pushed.

## 11. Definition of done

- Five slices accepted after review; the judge reports no open `FAIL`.
- `npm run check` clean after every slice; the final gate green with numbers.
- Every acceptance line in `spec.md` §3 holds; EN and HU complete; no unused key.
- The state table in §4 is filled in (owner, status, findings).
- The final report: what changed in user-visible terms, which slice owned what, the exact gate command and
  result, and every residual risk.
