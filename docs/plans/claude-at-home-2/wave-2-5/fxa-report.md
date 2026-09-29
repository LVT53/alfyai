# Fix agent A report — round F1 (chat-side + review-state flow + App panel)

Worktree `art-fxa`, branch `fix/artifacts-rd-shell`, e2e port 5480.
Commits: `8509e87b`, `87dcd51b`, `01d54f54` (range `145c199e..01d54f54`).

## Finding 1 — Critical (review-2-5.md 38–44): App's phone regenerate sheet paints under the panel

- **Cause**: `AppBody.svelte`'s phone `<DialogShell phonePresentation="sheet">` for "Módosítás…" had no `zIndexClass`, so it rendered at the default `z-50` — under the mobile shell.
- **Fix**: added `zIndexClass="z-[150]"` (`src/lib/components/artifacts/app/AppBody.svelte`), matching every other phone sheet inside the mobile shell.
- **Test**: new e2e `tests/e2e/artifact-app.spec.ts` — "phone: 'Change this app…' opens the regenerate sheet on top of the panel" — opens the sheet at 390×844 and asserts `elementFromPoint` at the sheet's own center resolves inside the sheet, not the panel behind it. Verified red (reverted the fix, reran, confirmed the assertion fails) before restoring.

## Finding 2 — Important (59–75): chat card / list row / count-button dot ignored the persisted review state

- **Cause**: all three read only the ephemeral, session-only `liveDocumentAlfyActivity` signal (derived from `$messages`). Keep/Undo/Keep-all never touch `$messages`, so that signal never changed after those actions (stale-stuck-pending bug); a reload deliberately suppresses it for historical turns (`documentAlfyActivitySuppressKey`), so genuinely-still-pending state showed nothing (empty-after-reload bug).
- **Fix**:
  - Server: `document-ops.ts` gets a new exported `computeDocumentPendingReviewCounts(rows)` (bulk, reuses `computePendingReviewBlocks` — the same pure engine `getDocumentReviewState` already uses). `read-model.ts`'s `listArtifactsForConversation` calls it for `kind: "document"` rows only, and only fetches version history for a row that already has a review marker (cheap for the common "never touched" case). New `pendingReviewCount?: number` field on `ArtifactCardSummary` (`types.ts`) — `undefined` = never reviewable, `0` = reviewed, `N` = pending.
  - Client type: `DocumentWorkspaceItem.pendingReviewCount` (`knowledge/types.ts`), populated in `+page.svelte`'s `artifactToWorkspaceItem`.
  - Live updates: new `onPendingReviewCountChange` on `ArtifactBodyProps` (`artifact-bodies.ts`). `DocumentBody.svelte` reports `pendingList.length` from an effect (the one allowed callback-call exception — see below). `DocumentWorkspace.svelte` bubbles it via its own new `onPendingReviewCountChange` prop; `+page.svelte`'s `handlePendingReviewCountChange` patches the single `artifacts` state array (same optimistic-patch shape `handleToggleDocumentTask` already uses).
  - Three consumers fixed to prefer the persisted value, falling back to the ephemeral one only when the persisted value is `undefined` (never overriding a real `0`/`N` with a stale ephemeral guess): `ToolActivityRow.svelte`'s `artifactCardView` (chat card), `DocumentWorkspace.svelte`'s `artifactCardViewFor` (list row), `+page.svelte`'s `hasUnreviewedArtifactChange` (dot).
  - New "Reviewed" pill (green, `Check` icon, `--success-tint`/`--success-text`) in `ArtifactCard.svelte` for both `chrome="row"` and `chrome="full"`, shown when `pendingReviewCount === 0` (explicitly, distinct from `undefined`). New i18n key `artifacts.panel.reviewed` (EN "Reviewed" / HU "Átnézve", matching the mockup's own `reviewed` string) in `src/lib/i18n/artifacts.ts`.
- **A real bug found and fixed along the way**: the first version of `handlePendingReviewCountChange` unconditionally reassigned `artifacts` on every report, even when the count was unchanged — Svelte's `effect_update_depth_exceeded` (an infinite loop: new array/row references kept every dependent `$derived`, and one hop down the open body's own props, "changing" forever). Fixed by bailing out when the reported count already matches the stored one.
- **Test**: `read-model.test.ts` — new `describe("listArtifactsForConversation — pendingReviewCount …")`: omits the field for an untouched document; counts a pending edit and reads `0` once kept; counts two documents independently; never leaks to a stranger and scopes correctly to/from an incognito conversation (four cases, per the brief's "ownership and an incognito conversation" requirement). Live proof below (finding 2+3+4 share one e2e).

## Finding 3 — Important (76–86, tagged [doc] but the card→document path): opening from the card double-counted

- **Cause**: `runLoad` (DocumentBody.svelte, not edited by me) resets `handledActivityKey` on every mount, so opening a document whose edit already landed while the panel was closed replayed `landAlfyActivity` (keyed by op id) on top of the mount-time `restorePendingReview` (keyed by block id) — two entries for the same block.
- **Fix, entirely at the shell level, zero DocumentBody.svelte replay-logic edits**: `DocumentWorkspace.svelte` now tracks `alfyActivitySeenOpenKeys` — the set of `alfyActivity.key`s it actually watched while mounted and open on the matching artifact (added the moment `alfyActivity` is non-null AND `activeDocument`'s id matches, including while still `"running"`, so the normal "watched it happen live" case is unaffected). A new `bodyAlfyActivity` derived value is `alfyActivity` only if its key is in that set, else `null`; **only `bodyAlfyActivity`** (not the raw `alfyActivity`) is now handed to the mounted `<ArtifactBody>` at both the mobile and desktop call sites. A key never seen open — the "opened fresh from the card after it already settled" case — stays suppressed forever for the body, so the persisted restore is the only thing that ever adds that block. The raw `alfyActivity` prop is untouched for the row-pill ephemeral fallback and the chat card (both correct already, per the review's own evidence).
- **Test**: covered by the same live e2e as findings 2 and 4 (below) — it explicitly opens from the card (not the count button) and asserts exactly one applied change, never two.

## Finding 4 — Important (149–157): header had no version/time when opened from the card

- **Cause**: `ToolActivityRow.svelte`'s `handleOpenArtifact` built the `DocumentWorkspaceItem` without `versionNumber`/`updatedAt`, so the header's `versionNumber > 0` gate never rendered the version button — the only way into Versions — when opened via "Átnézés ›".
- **Fix**: fills both from `body.preview?.versionNumber` / `body.preview?.updatedAt` (the same server-computed `ArtifactCardSummary` already attached from `ConversationDetail.artifacts` for the pending-review pill).
- **Deviation (documented, not fixed)**: the review's own "Related" note — the header shows the item's SNAPSHOT, not the body's live number (stays `v1` even after a live edit that landed `v2`, since `body.preview` is the page's pre-turn `conversationArtifacts` snapshot, never refreshed mid-turn) — is the "better" fix the review itself frames as optional/deferred (a live-version-reporting callback, same shape as `onPendingReviewCountChange`). Left alone to stay in scope; confirmed via the live e2e that a version renders at all (`v1`), which is the actual defect.
- **Test**: same live e2e (below) asserts `artifact-version-pill` renders "v1" right after opening from the card.

## Findings 2+3+4 combined — the live proof

New e2e in `tests/e2e/artifact-document.spec.ts`, inside the existing `T8 live` describe (reuses its `fakeProvider` harness): **"the chat card, list row and count-button dot follow the persisted review state through Keep all and a reload"**. A real `edit_artifact` call (one apply, one refuse) with the panel closed → card shows "1 change to review" and the dot lights up → opened from the card (not the count button) → header shows `v1` → review region shows "Alfy changed 1 part." (exactly one, not two) → "Keep all" → card reads "Reviewed" and the dot is gone, live, no reload → page reload → still "Reviewed", still no dot. Verified this test fails without the fix (pre-guard-fix run hit the infinite-loop error; reran green after the guard).

## Finding 5 — Important (158–167): expanded panel — App popover under the panel; one Escape closed both

- **Cause A (z-index)**: `.app-regen-popover` was `z-index: 60`, under `.workspace-shell-expanded`'s `115`.
- **Fix A**: bumped to `130` (a plain number, matching this codebase's existing non-tokenized z-index convention; no shared `--z-*` custom property exists yet).
- **Cause B (Escape)**: `DocumentWorkspace.svelte`'s `<svelte:window onkeydown={handleWindowKeydown}>` mounts with the shell itself — before the popover's own listener exists — so on a shared Escape press it always ran FIRST, saw `event.defaultPrevented === false` (the popover's own `preventDefault()` hadn't fired yet), and collapsed the expanded panel regardless of the popover.
- **Fix B**: new export `hasOpenDialog()` on `DialogShell.svelte`'s module script (`dialogStack.size() > 0`, alongside the existing `registerDialog`/`deregisterDialog`/`isTopmostDialog`). `handleWindowKeydown` now returns early whenever any dialog/popover/sheet is registered, independent of listener order.
- **Test**: new e2e in `artifact-app.spec.ts` — "expanded panel: the regenerate popover paints above the panel, and Escape closes only the popover first" — expands the panel, opens the popover, asserts `elementFromPoint` topmost, one Escape closes only the popover (panel stays expanded), a second Escape then closes the panel. Verified both halves fail independently without their respective fix (reverted z-index alone → topmost assertion fails; reverted `hasOpenDialog()` check alone → panel closes prematurely), then restored both and reran green.

## Finding 6 — Important (176–182): App panel — status row / Preview-Code / "Módosítás…" flush against the edges

- **Cause**: `.app-status`, `.app-bar` (the segmented row), `.app-stage` had no horizontal padding at all, unlike the shared header's own `1.25rem` (20px) inline padding.
- **Fix**: `padding-inline: 1.25rem` on all three (desktop), `1rem` (16px) added to the existing `@media (max-width: 639px)` block for phone. Pure CSS — no test per common.md; confirmed visually in both new screenshots (the status row, tabs and "Módosítás…" now align with the header text; the phone sheet's own contents are no longer flush to the screen edge).

## Gates (run once at the end, per common.md)

1. `npm run check` — **0 errors, 17 warnings** (10 ToolActivityRow + 6 ThinkingBlock + 1 RouteItinerary) — exactly the documented pre-existing baseline, zero new.
2. `npx biome check src scripts tests` — **0 issues** (found 5 pure line-wrap formatting diffs mid-session from `biome check --write`, committed separately as `01d54f54`; reconfirmed clean twice after).
3. `npm test` — **897 test files passed, 1 skipped (898); 13691 tests passed, 2 skipped (13693)** — zero failures.
4. Playwright, the full required list (`tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts`) — **89 passed, 89 collected (10 files) — zero failures.**
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-fxa.json` — **124 total issues, 4 circular dependencies** — identical to the stated baseline, zero new findings (checked the full summary breakdown, not just the total).

### A note on environmental flakiness encountered and resolved during this session

Running `artifact-document.spec.ts`'s **pre-existing, unmodified-by-me** "T8 live … marks the applied block…" test **in isolation** (`-g` filtered to just that test, or that one plus mine) failed repeatedly and consistently with a genuine root cause: Vite's dev-server dependency pre-bundling ("504 Outdated Optimize Dep", forced HMR full-page-reload mid-stream) — a cold-start artifact of hitting the Tiptap/ProseMirror-heavy Document editor module graph for the first time in a freshly-spawned server process (`reuseExistingServer: false`), compounded early on by fix agent B's own concurrent heavy Playwright run sharing this repo's `node_modules/.vite` cache (the two worktrees' `node_modules` are the same physical directory via symlink). I root-caused this properly rather than assuming flakiness: added temporary `page.on(...)` instrumentation, saw the 504s land exactly on the live-stream request, and **definitively proved it was not my code** by running the identical filtered test against the completely unmodified baseline commit (`145c199e`) in the separate `art-base` worktree on a different port — same failure, same error, same line. When run as part of the **full required gate suite** (89 tests, cache warmed up by the ~15 earlier tests before reaching the Tiptap-heavy ones), it and everything else passed cleanly — that full-suite run is gate #4 above and is the authoritative result.

## Screenshots (Hungarian, not committed)

All in `scratchpad/rd/shots/fxa/`, looked at once each:
- `hu-390-app-regen-sheet.png` — the phone regenerate sheet on top of the panel (finding 1), also shows finding 6's padding.
- `hu-1440-app-expanded-popover.png` — the expanded panel with the regenerate popover on top (finding 5), also shows finding 6's padding.
- `hu-1440-card-after-keep-all.png` — the chat card reading "v2 · Átnézve" (green Reviewed pill) after Keep all, dot gone from the count button (finding 2).

## Deviations from the brief/spec

- Finding 4's "live version number" nuance deliberately left as the review's own documented, optional "better" fix (see Finding 4 above) — not a regression, a pre-existing, explicitly-deferred gap.
- Commits are grouped by investigative/architectural cluster rather than strictly 1:1 with the review's numbered findings (App-panel-chrome findings 1/5/6 in one commit; the review-state findings 2/3/4 in another, since 3 and 4 only became provably correct through the same combined live e2e as 2, and splitting them post-hoc would have needed risky interactive `git add -p` hunk surgery for no real benefit) — each commit message itemizes exactly which findings it covers and why. A third, small `style:` commit holds biome's own reformatting.
- No other deviations. All 6 findings in scope are fixed and tested.

## Hand-off — reuse these

- **`computeDocumentPendingReviewCounts(rows)`** (`document-ops.ts`, not re-exported through the facade — sibling-file-only, like `readDocumentReviewMetadata`): the bulk counterpart to `getDocumentReviewState`. Any future bulk-list surface that needs "how many pending Alfy blocks does this Document have" should call this rather than looping `getDocumentReviewState` per artifact.
- **`ArtifactCardSummary.pendingReviewCount` / `DocumentWorkspaceItem.pendingReviewCount`**: `undefined` = never reviewable, `0` = reviewed, `N` = pending. Keep this three-state contract if any other kind ever grows a review workflow — do not collapse `0` and `undefined` into the same falsy check (every read site in this change uses `!= null` / `??`, never `||`, on purpose).
- **`ArtifactBodyProps.onPendingReviewCountChange`**: the second "plain reactive report from an effect" callback alongside `onCommentCountChange` — same contract shape (fires on every render where the tracked value is read, not a one-time trigger). A future kind with its own review-like live count should follow this exact pattern rather than inventing a third callback shape.
- **The idempotent-write lesson**: any handler that patches shared `$state` in response to a child's own reactive effect report MUST compare against the currently-stored value and skip the write when unchanged, or a value that is genuinely stable (not oscillating) can still loop forever purely from reference-identity churn cascading back down into the reporting effect's own dependencies. `handlePendingReviewCountChange` in `+page.svelte` is the reference implementation; copy the guard, not just the callback wiring.
- **`alfyActivitySeenOpenKeys` / `bodyAlfyActivity`** (`DocumentWorkspace.svelte`): the general shape for "only replay a live, keyed activity signal into a body if this shell actually watched it while open" — reusable for any future kind whose body does its own live-activity replay and could double up against a persisted-state restore when opened cold from elsewhere (a card, a search result, …).
- **`DialogShell.hasOpenDialog()`**: a host that owns its own window-level Escape handling (not a `DialogShell` instance itself) and needs to defer to whatever popover/sheet/composer is actually on top should call this rather than relying on `event.defaultPrevented`, which is registration-order-dependent and was exactly this finding's bug.
- **`.artifact-card-reviewed` / `.artifact-row-pill-reviewed`** (`ArtifactCard.svelte`) + `artifacts.panel.reviewed` i18n key: the "reviewed" positive-state pill, success-toned (`--success-tint`/`--success-text`), parallel to the existing pending/refused pills. Any future kind with a review-style workflow reuses these classes/key rather than inventing a second "done" treatment.
- **z-index 130** for a popover that must sit above `.workspace-shell-expanded` (115) but below a full phone sheet's 150 — no shared token exists yet; if a third such popover ever needs this, consider promoting it to a real `--z-*` custom property instead of a fourth repeated magic number.
