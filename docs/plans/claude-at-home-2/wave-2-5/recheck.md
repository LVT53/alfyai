# Re-check · fixes for Wave 2.5 review · findings

Head checked: `f86f5c6b` (worktree `rv-rd`, port 5450), fix diff `145c199e..f86f5c6b` (65 files). Method: read the fix
diff by file against `review-2-5.md`'s own citations; cross-checked `preventUpdate` against the real `@tiptap/core`
source; independently re-ran 7 targeted Playwright tests fresh on this worktree (all green); wrote and ran one
throwaway, uncommitted capture spec (deleted before finishing, `git status` clean, e2e admin's `uiLanguage` restored
to `en`) to reproduce the review's two live passes in Hungarian with screenshots, plus a DB-level check of a freshly
seeded artifact's stored body. No product or test files were changed.

## Critical (3/3 addressed)

1. **Phone composer sheet behind the panel** — ADDRESSED. `SelectionBubble.svelte` phone `<DialogShell>` now has
   `zIndexClass="z-[150]"`. Covered by `tests/e2e/artifact-document-selection-bubble.spec.ts` ("Ask Alfy"/"Comment ...
   topmost"), both re-run fresh here (green). Screenshot: `shots/recheck/phone-ask-alfy-sheet-hu.png` — sheet clearly
   painted over the dimmed panel.
2. **App phone regenerate sheet behind the panel** — ADDRESSED. `AppBody.svelte`'s phone `<DialogShell>` now has
   `zIndexClass="z-[150]"`. Covered by `artifact-app.spec.ts:595`, re-run fresh (green). Screenshot:
   `shots/recheck/phone-app-regen-sheet-hu.png` — "Min változtasson?" sheet on top of "Recheck App".
3. **Review bar balloons on phone** — ADDRESSED. `ReviewBar.svelte`: `.review-bar-msg { flex: 0 0 auto }` under the
   480px query; `.review-bar-nav :global(button.btn-icon) { min-height/min-width: 44px }` (also closes fix-first row
   5). Covered by `artifact-document-review-bar.spec.ts:116`, re-run fresh (green). Screenshot:
   `shots/recheck/phone-review-bar-compact-hu.png` — compact bar, pill and the last paragraph both visible.

## Important (15/15 addressed)

1. **Card/list/dot ignore review state** — ADDRESSED. `document-ops.ts:computeDocumentPendingReviewCounts` → new
   `ArtifactCardSummary.pendingReviewCount` (`types.ts`, `read-model.ts`) → `DocumentWorkspaceItem.pendingReviewCount`
   → three consumers (`ToolActivityRow.svelte`, `DocumentWorkspace.svelte:artifactCardViewFor`,
   `+page.svelte:hasUnreviewedArtifactChange`) all prefer the persisted value via `??`/`!= null` (never collapsing a
   real `0`). New "Reviewed" pill in `ArtifactCard.svelte`. See "New breakage" below for a gap in this same fix.
2. **Card-open double-counts a change** — ADDRESSED. `DocumentWorkspace.svelte`'s `staleKeyWhenWatchStarted` +
   `bodyAlfyActivity` (only this value, not raw `alfyActivity`, reaches `<ArtifactBody>` at both mobile/desktop call
   sites — confirmed both call sites at lines ~1629 and ~1941 use `alfyActivity={bodyAlfyActivity}`). Live-verified:
   T8's own re-run below opened from the card and counted exactly one applied change.
3. **Two nested scrollers drift rail from text** — ADDRESSED. `.document-content-text` → `overflow: visible`; wide
   tables get `overflow-x` on Tiptap's own `.tableWrapper` instead. `artifact-document-review-bar.spec.ts:174`
   re-run fresh (green): last paragraph topmost, review bar confined to the text column, never covers it.
4. **Review bar scrolls away / covers rail / hides last lines** — ADDRESSED. Moved into `.document-content-text`,
   `position: sticky`, `.document-editor-host` gets live `padding-bottom` from a `ResizeObserver`'d bar height. Same
   re-run as #3 confirms it at 1440×900; phone screenshot above confirms it at 390×844 too.
5. **Empty "Edited" version on open** — ADDRESSED. `tr.setMeta("preventUpdate", true)` added to
   `applyAlfyChangeMarks`/`keepAlfyChange`/`remarkAlfyChange` (`marks.ts`); confirmed `preventUpdate` is a real
   `@tiptap/core` transaction meta (`node_modules/@tiptap/core/dist/index.cjs:6575`) that suppresses `onUpdate`.
   `undoAlfyChange` deliberately still fires it (a real edit).
6. **Stepper never switches tabs** — ADDRESSED. `seeChange` now resolves the change's tab via `mapBlocksToTabs` and
   calls `handleTabActivate` + `tick()` before scrolling; shared by the stepper, a comment's "See change", and the
   refusal notice.
7. **Kept block re-changed by Alfy stays hidden forever** — ADDRESSED, server-side. `keptBlockIds` entries now
   `"<blockId>@<version>"` (`encodeKeptBlock`/`parseKeptBlockVersions`); a block is excluded only while
   `keptAsOfVersion >= change.versionNumber`. `acknowledgeDocumentReviewBlocks` also now filters the caller's block
   ids against the real `pendingBefore` set (the review's own secondary note under this finding).
8. **User's own edit doesn't acknowledge a pending block live** — ADDRESSED. New
   `acknowledgePendingBlocksTouchedByUserEdit` in `handleUpdate` diffs block hashes before/after and drops+acks any
   pending block the user just edited or deleted.
9. **No version/time when opened from card** — ADDRESSED. `ToolActivityRow.svelte:handleOpenArtifact` now fills
   `versionNumber`/`updatedAt` from `body.preview`. Live-verified below (header shows a version pill immediately).
10. **Expanded panel: App popover under panel; one Escape closes both** — ADDRESSED. `.app-regen-popover` z-index
    60→130; new `DialogShell.hasOpenDialog()` (exported from its module script, confirmed `dialogStack.size()` exists
    in `focus-trap.ts`) makes `DocumentWorkspace.svelte`'s window Escape handler defer to any open
    dialog/popover/sheet regardless of listener registration order.
11. **Expanded panel: Versions/Download popovers off-screen** — ADDRESSED. Both popovers switched from right-anchor
    (could go negative) to left-anchor with viewport clamping; both bumped to z-index 130.
12. **App panel chrome flush to edges** — ADDRESSED. `.app-status`/`.app-bar`/`.app-stage` get `padding-inline: 1.25rem`
    (desktop) / `1rem` (phone), matching the header's own inline padding. Visible in the phone screenshot above.
13. **Tab ⋯ menu clipped, unreachable by keyboard** — ADDRESSED. Portalled to `<body>` (`position: fixed`, z-index
    130), first item focused on open, Arrow keys cycle, Escape returns focus to the trigger.
14. **New tab shows the whole document** — ADDRESSED. `appendEmptyTabSection` mints a real anchor block (a
    zero-width-space paragraph, since a literally empty one does not survive markdown round-tripping);
    `handleTabsChange` rewrites the new tab's `startBlockId` to it before saving. Live-verified below (DB dump) —
    stored body: `<!--b:p0tv9a-->\n​\n`, a real, non-colliding `startBlockId` per tab. Also closes fix-first row 3.
15. **Selection pill unreachable by keyboard** — ADDRESSED. `document-editor.ts`'s `handleKeyDown` intercepts a plain
    Tab over a non-empty selection and calls `focusSelectionPill()`; `SelectionBubble.svelte` adds roving
    Left/Right on the toolbar; Escape uses `editor.view.focus()` (synchronous) instead of the deferred
    `commands.focus()` to win the race against the pill button leaving the DOM.

## Fix-first triage rows (6/6 addressed)

Count-button dot (→ Important 1), "Reviewed" card state (→ Important 1), new empty tab (→ Important 14), no version
button from card (→ Important 9), review bar prev/next 44px (→ Critical 3) — all addressed as above. **User avatar
placeholder "U"** — ADDRESSED separately: `currentUser`/`currentUserId`/`currentUserName`/`currentUserProfilePicture`
threaded end to end, `data.user` (chat `+page.svelte` and knowledge `+page.svelte`) → `DocumentWorkspace.svelte` (both
shells) → `DocumentBody.svelte` → `VersionsSheet.svelte` directly and → `MarginPanel.svelte` → `CommentThread.svelte`
→ `CommentCard.svelte`; `displayName`/`profilePicture` are real `users` schema fields.

## Minor findings — fix agents' own claims

ADDRESSED (code-verified): change-pill group name/HU label-in-name/focus-after-Keep-Undo; status-change announcements
(one shared live announcer, `ReviewBar` now `role="region"`); composer Escape from a chip/button; English strings in
HU UI (chip select label, task-checkbox label, Versions "Edited"/"restored" mapping); App a11y (`inert` note,
persistent busy announcer); Knowledge chips on phones (icons + 36px/44px); `btn-primary` hover contrast (kept at 12%
tint); in-chat card version staleness (`hydrateConversationDetail` + `shouldHydrateArtifactsOnToolCall`); header meta
authorship line.

PARTIALLY ADDRESSED (documented deviations, not re-litigated): Tabs ARIA — `aria-controls`/`tabpanel` and the
sr-only badge phrase fixed; ⋯/+ still inside the tablist element (fxc: functional arrow-key nav unaffected, judged
not worth B's-territory regression risk). Panel focus/name — focus-on-open fixed; per-item `aria-label` left alone
(fxd: ~10 files assert the static label verbatim, would strand B's suites red). Motion details — Toast direction
fixed (`y:12`), App popover + phone-sheet durations split in/out; document-side (`CommentsSheet`/`DownloadSheet`/
`VersionsSheet`) hardcoded durations and Toast's own `out:` transition explicitly left (jsdom limitation, B/C's
territory).

NOT ADDRESSED (not claimed fixed by any of the four reports): the [doc] portion of "phone touch targets under 44px"
(tabs 28px, ⋯ 20×20, + 24×24, mobile toolbar 36×36, chip selects 22px, task checkboxes 17px, Comments-sheet controls)
— only the two [shell] items (breadcrumb, version button) were fixed; Comments sheet/drawer anchor-offset cosmetics;
rail copy/counts (zero-count display, orphaned-thread count mismatch, uppercase toggle, single-tab copy); loose
checklist spacing / chip-select width; Versions popover uneven row gaps; Undo's version summary (still generic
"Edited", not a distinct "Undid Alfy's change").

DELIBERATELY LEFT (per the review's own triage, unchanged): Refusal placement ("can wait"), and the full "Can wait"
deferred list in review-2-5.md (Redo/multi-block insert, thread chip badge after reload, `undoAlfyChange` collapsing
an empty block, removed-text group not tab-scoped, two-phase writing label, unused `blockRect`, pending-highlight
timing, drawer + expanded presentation, no rail-hide toggle, document checkboxes, chip chevron/date icon, Tailwind
easing utilities, item-view width animation, "Deleted" card state, chip stagger, unused `totalLabel`, phone clipping,
summary pluralization, Preview/Code cross-fade, download-busy feedback, App Versions browsing, regenerate popover
label, creating/failed cards in HU).

## New breakage in the fix diff (Important)

**A genuine, reproducible regression inside the Important-1 fix itself**: opening a Document that has pending Alfy
changes (from the card, the list, or the count button) makes the chat card/list row/count-button dot flash the wrong
"Reviewed"/no-pending state for roughly 100–300ms before self-correcting.

- `src/lib/components/artifacts/document/DocumentBody.svelte:375` — `pendingChanges` starts as an empty `Map`.
- `src/lib/components/artifacts/document/DocumentBody.svelte:1154` — the reporting effect
  (`onPendingReviewCountChange?.(pendingList.length)`) has no gate on load/restore state, so it fires with `0` the
  moment the component mounts.
- `src/lib/components/artifacts/document/DocumentBody.svelte:1793,1801,1206` — `loadState = "ready"` is set, then
  `restorePendingReview` is kicked off **fire-and-forget** (`void restorePendingReview(...)`) and does a real
  `await fetchDocumentReviewState(...)` network round trip before it ever populates `pendingChanges` with the true
  pending set.
- `src/routes/(app)/chat/[conversationId]/+page.svelte:1108-1117` — `handlePendingReviewCountChange` has no "is this
  body's own initial restore actually settled" guard, so it accepts the premature `0` at face value and overwrites
  the correct persisted count for every consumer, until the real restore corrects it moments later.

Live-measured on this worktree (polled the chat card's own text every 40ms right after opening it from the card, one
real pending change): `t=0ms "1 módosítás vár rád"` → `t=288ms "Átnézve"` (wrong) → `t=389ms "1 módosítás vár rád"`
(self-corrected). Self-heals on a working network; the `restorePendingReview` catch swallows a failed fetch silently
and leaves the wrong `0` uncorrected until reload if the request itself fails. Not caught by the fix agents' own new
e2e test (`artifact-document.spec.ts` T8) because it asserts via `toContainText`, which retries past the flash.

### Observations (outside the fix diff, not blocking)

- `document-ops.ts`'s `acknowledgeDocumentReviewBlocks` comment ("every valid id was, by construction, absent from
  `keptVersions`") is imprecise — a re-admitted id (kept at an older version, Alfy changed it again) CAN already be
  present in `keptVersions` at a lower version. Harmless: the code uses `existing === undefined || asOfVersion >
  existing`, not a presence check, so behavior is correct despite the comment.

## The two live passes (Hungarian, re-run fresh on this worktree)

**Phone pass, 390×844**: Ask Alfy sheet — topmost, above the dimmed panel (`phone-ask-alfy-sheet-hu.png`). App's "Min
változtasson?" sheet — topmost, above the dimmed App panel (`phone-app-regen-sheet-hu.png`). Review bar — compact,
"Mindet visszavonom"/"Mindet megtartom" stacked and reachable, and the document's last paragraph fully visible above
it, not hidden (`phone-review-bar-compact-hu.png`). All three backed by a fresh, green Playwright re-run of the
committed regression tests plus my own throwaway HU capture.

**Live card flow**: fake-provider `edit_artifact` (`AI_SMOKE_EDIT_ARTIFACT_MARKER`) with the panel closed → card shows
"1 módosítás vár rád" + dot lit (`live-1-change-pending-hu.png`) → opened from the card → header shows `v2`, exactly
one pending change (not two) (`live-2-opened-from-card-hu.png`, modulo the transient flash noted above) → "Mindet
megtartom" → card reads "v2" and the review region is gone, dot cleared, live, no reload (`live-3-after-keep-all-hu.png`)
→ reload → dot still cleared (`live-4-after-reload-hu.png`). This exact scenario is also `artifact-document.spec.ts`'s
own T8 test, re-run fresh here in English and green.

**Empty-tab anchor**: `artifact-document.spec.ts`'s "adding a tab shows only its own (empty) section... survives a
reload" re-run fresh, green. DB dump of the resulting artifact confirms the new tab's anchor block is a real,
non-colliding id (`p0tv9a`) and the raw stored body legitimately contains the zero-width-space placeholder (it must,
to survive re-save) while `readDocumentForAlfy`/export strip it at the read boundary (code-verified in
`document-ops.ts`, `export.ts`, the markdown export route — each calls `stripEmptyTabAnchorPlaceholder`).

## Verdict

**Ready for the owner**, with one caveat: fix the new ~100–300ms "Reviewed" flash on Document open (gate the
`onPendingReviewCountChange` report on the body's own restore having completed at least once, e.g. don't report until
`restorePendingReview` has resolved or a "restore attempted" flag is set) before or shortly after shipping — it is a
real, live-reproducible regression in the exact flow the owner will exercise on the very first review, but it
self-heals within ~300ms on a working connection and does not block the release on its own.
