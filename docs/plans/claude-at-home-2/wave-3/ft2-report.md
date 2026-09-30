# FT-2 report: focus-trap pass two (the campaign modals)

Status: DONE_WITH_CONCERNS (concerns are follow-ups and one pre-existing e2e failure, listed at the end).
Model: `claude-sonnet-5-5`.
Worktree `art-ft2`, branch `fix/focus-trap-pass-two`, commits `479f8e63..8ea98b51` (7 commits, 8 files, +624 / -112).

## What changed, per step

Order followed: pin behaviour (green on the old code) -> move -> new-behaviour tests seen red first -> gates.

| Commit | What |
|---|---|
| `6b4b6a3a` | Pins for `CampaignModal` (+7 tests, all green on the hand-rolled code): Tab wraps last->first and Shift+Tab first->last (focus AND `defaultPrevented` asserted); Tab between the ends is left to the browser; stray focus (outside the dialog) is pulled to the first control on Tab and on Shift+Tab; Escape = skip (`onSkip` then `onClose`, key cancelled); focus returns to the opener when the modal is removed; Tab AND Escape are left to a dialog registered above it, and it traps again after that dialog deregisters; the inline preview attaches nothing (no dialog, no key handling, no focus taken or restored). The one existing Escape test now removes the modal in `onSkip`, as the app shell does (`finishActiveCampaign` nulls `activeCampaign`), because with the shared trap focus returns when the modal is removed, not inside the key handler. |
| `dadd0b4b` | Pins for `CampaignCropModal` (+6, green on old code): first focus on the panel itself, Escape cancels and cancels the key, Escape is ignored while a crop is saving (canvas and `toBlob` stubbed so the save stays in flight), Tab/Shift+Tab wrap between first and last ENABLED control (both with the image loaded and before it loads), Tab between the ends left alone. |
| `766da487` | `CampaignModal.svelte` moved: `focusableElements`, `restoreFocus`, `handleKeydown`, `onMount`/`onDestroy`, `<svelte:window onkeydown>`, `dialogRef` and `previousFocus` are gone. Now `focusTrap({ isTopmost: () => isTopmostDialog(dialogId), onEscape: preventDefault + closeAsSkip, focus: { target: () => initialFocusRef }, restoreFocusOnCleanup: true })`, attached as `{@attach inline ? undefined : campaignFocusTrap}` (inline preview stays inert), and a `$effect` that registers/deregisters on the DialogShell stack (not for inline). All 15 tests pass unchanged after the move. |
| `c2d9aa29` | `src/lib/utils/focus-trap.ts` (+5 tests, two seen red first): (1) new option `preventScroll` for the trap's OWN two focus moves (initial focus and restore); Tab-wrap moves keep scrolling; without the option `focus()` is still called with no arguments (a test guards that). (2) `trapTabKey` treats "the container itself holds focus" as "before the first element" for Shift+Tab (wraps to last). A forward Tab from the container is untouched. |
| `541348f5` | `CampaignCropModal.svelte` moved onto `focusTrap` the same way: `focus: { target: () => dialogRef }`, `restoreFocusOnCleanup`, `preventScroll: true`, Escape ignored while `isSaving`. It now also registers on the DialogShell stack and gates on `isTopmostDialog`. +5 tests, all seen red on the old code first (see "Behaviour changes"). |
| `db31610d` | One real-browser e2e in `tests/e2e/admin-users-campaigns.spec.ts` (see Verification). |
| `8ea98b51` | Comment in `DialogShell.svelte` that said CampaignModal is the one non-DialogShell joining the stack now names both campaign dialogs. |

Tests now: `CampaignModal.test.ts` 15 (was 8), `CampaignCropModal.test.ts` 15 (was 4), `focus-trap.test.ts` 36 (was 31), e2e +1.

## Behaviour changes beyond a pure move (each has a test, none is visual)

1. **Crop: Shift+Tab from the initially focused panel no longer walks out.** Old code (and the shared `trapTabKey`) let it go to the invisible full-screen backdrop button, and a second one to the page behind. Confirmed in Chromium: focus now goes to "Save crop". Fixed in the shared utility (`c2d9aa29`), so it also covers DialogShell panels focused by a click on plain text.
2. **Crop: focus that has left the dialog is pulled back in** (the utility's rule; the old crop trap had none).
3. **Crop: while a save has every control disabled, Tab holds focus on the panel** (old code returned without preventing the default, so Tab left).
4. **Crop joins the DialogShell open-dialog stack** (`registerDialog`/`isTopmostDialog`, the same as CampaignModal and the artifact popovers). This is required by the move, not optional: the utility's pull-back rule would make an always-live crop trap fight any dialog opened above it for every Tab, and an Escape meant for that dialog would also cancel the crop.
5. `CampaignModal`: the `aria-hidden` filter on focusables is replaced by the utility's rendered-only filter. Nothing focusable in that template carries `aria-hidden`, so there is no difference in practice.
6. `CampaignModal`: focus returns to the opener when the modal is removed (skip via Escape, x, Skip, or Finish alike) instead of also immediately inside `closeAsSkip`; in the app the parent removes the modal in the same flush, so it is the same result a microtask apart.

## Verification

- Gates, once, at the end: `npm run check` 8291 files, 0 errors, 17 warnings (the pre-existing 17; none in my files). `npx biome check src scripts tests` clean (2386 files). `npm test`: 985 files passed, 1 skipped; 15,654 tests passed, 2 skipped. `npm run build`: exit 0, 32 `Unused CSS selector` + 2 `must have an ARIA role` = baseline. `npm run check:migrations` passes. Fallow: 124 issues, 4 circular = baseline, so zero new (report in this folder: `fallow-ft2.json`; written here rather than `/tmp`).
- Playwright on 5580, once: `chat`, `conversation`, `admin-users-campaigns`, `context-usage-ring-popover`, `settings-admin`, `settings-admin-system` (the last two host the crop dialogs' panes): **50 passed, 1 failed**. The failure, `settings-admin.spec.ts:411` ("creates, promotes, demotes, and deletes a user from the Users pane"), is a strict-mode violation: two `confirm-delete` buttons exist at once (the promote dialog is still fading out when the delete dialog opens). It is **pre-existing**: rerun alone it fails 2 of 3 on my branch and 3 of 3 on the base commit `479f8e63` (checked by detaching HEAD in my own worktree, then restoring the branch). Not caused by this change; the test races an outro.
- Real browser (the unit tests run in jsdom, which has no layout or real focus): the new e2e opens the crop dialog from a slide's image input. It asserts focus starts on the panel, Shift+Tab -> "Save crop", Tab -> "Close", Escape closes it and focus returns to the element that had it before. It ran 16/16 in a doubled run of the spec. A first draft of it failed for an instructive reason and the spec now guards against it: the "New campaign" DialogShell restores focus to its opener when its outro ends and took focus from the crop dialog opened within ~150 ms; the test waits for it to be gone.
- CampaignModal itself could not be driven in a browser: it needs a published campaign with valid slides (the e2e DB has none). It is covered by the 15 jsdom tests, and the trap it now uses is the same one exercised in Chromium by DialogShell and the crop dialog.
- Screenshot (1, looked at): `scratchpad/w3/ft2-crop-open.png`, the crop dialog once settled, English, 1280x720. Title, metadata, crop frame with grid, preview, zoom, Reset / Cancel / Save crop all render as before; the panel takes focus with no ring. This change has no new UI, so I did not take the Hungarian 390x844 / 1440x900 set. (An earlier capture mid-fade-in was replaced by this one.)
- Docs: Context7 and the Svelte MCP were unavailable; I read the installed Svelte 5.55.8 source (`attach` in `dom/elements/attachments.js`) and types (`elements.d.ts`: `Attachment | false | undefined | null`) to confirm `{@attach cond ? undefined : fn}` is supported and re-evaluates when `cond` changes.

## Step 2: other hand-rolled traps (listed; none moved)

There is no other `keydown` handler that cycles Tab over focusables outside pass one's list. What the tree does contain:

1. `src/lib/components/search/SearchModal.svelte` (~lines 437-467): still wraps Tab itself, using the shared `getFocusableElements`. On pass one's list, and its comment says the difference is deliberate: focus outside goes in the direction of travel (Shift+Tab -> last), not always first. Left alone.
2. `src/lib/components/chat/ConversationJumpRail.svelte` (mobile sheet): `focusTrap` with an `onTab` override whose one purpose was "container holds focus, Shift+Tab wraps". `c2d9aa29` made that the default, so the override is now only different in two edge cases (no focusables; no pull-back for outside focus). Candidate to drop `onTab` (and then the option, which would have no user). Not done: pass one's file, own tests, not "outside the list".
3. `aria-modal="true"` dialogs with NO trap and no first-focus/restore at all, only a window Escape handler: `src/lib/components/chat/ImageLightbox.svelte` (also arrows and a scroll lock), `src/lib/components/chat/ModelSelectionGuideModal.svelte`, `src/routes/(app)/settings/_components/ModelForm.svelte`. Adding a trap here is a new behaviour per dialog, larger than "equally small", so not done.
4. **A real stacking bug found on the way, one line to fix now that the crop joins the stack.** `ModelForm` is the dialog the model-icon crop opens above (`SettingsAdminSystemPane` wraps the crop in `z-[110]`). `ModelForm`'s `handleKeydown` closes on Escape unconditionally, and it is a plain window listener, so by reading the code one Escape in the crop dialog cancels the crop and also closes the form with its unsaved edits. Before my change the crop was not on the stack either, so this is not a regression; the fix is `if (e.key === "Escape" && !hasOpenDialog()) onClose?.()` in `ModelForm.svelte` plus a test that a registered dialog above it swallows Escape. Not verified in a browser (the e2e DB has no providers).

Not trap candidates: `MessageInput.svelte` (Enter/Tab accepts a completion), `document-editor.ts` (Tab into the selection pill), `ServerUpdateNotice.svelte` (`aria-modal="false"`).

## Deviations from the brief

- The brief lists "only the topmost dialog traps when two are stacked" among behaviour to pin for both modals. That existed for `CampaignModal` only; the crop had no stack participation, so its version is new behaviour (item 4 above), written as a red-then-green test rather than a pin.
- I edited the shared utility (`preventScroll`, container Shift+Tab). The crop's move needed the first (a test already pinned `preventScroll` on its first focus and restore); the second is the hole item 1 describes. It is its own commit (`c2d9aa29`) with its own tests. It changes the container-focused Shift+Tab for every trap user, always toward "stay in the dialog"; the ten test files of the other trap users and the full suite pass.
- Added one e2e test (the brief only asked to run existing ones), because jsdom cannot observe real focus.

## Hand-off

- `src/lib/utils/focus-trap.ts`: `FocusTrapOptions.preventScroll?: boolean`; `trapTabKey` wraps Shift+Tab pressed on the container. No other API change.
- Pattern for a dialog that is not a DialogShell but nests with them (now used by `CampaignModal`, `CampaignCropModal`, `CommentsSurface`, `AppBody`, `AnchoredPopover`): `$effect(() => { registerDialog(id); return () => deregisterDialog(id); })`, `focusTrap({ isTopmost: () => isTopmostDialog(id), onEscape, focus, restoreFocusOnCleanup })`, `{@attach trap}` on the dialog element; all three functions are exported from `$lib/components/ui/DialogShell.svelte`. A window-level Escape handler that is not a `focusTrap` (like `ModelForm`'s) should defer with `hasOpenDialog()`.
- Files touched: `CampaignModal.svelte` + test, `CampaignCropModal.svelte` + test, `focus-trap.ts` + test, one comment in `DialogShell.svelte`, `tests/e2e/admin-users-campaigns.spec.ts`. Nothing in `artifacts/**`, the export route or `package.json` (S3-X's files).
- Follow-ups for the orchestrator to schedule or drop: the `ModelForm` Escape gate (item 4); drop `ConversationJumpRail`'s `onTab` override (item 2); trap for the three trap-less dialogs (item 3); the flaky `settings-admin.spec.ts:411` (wait for the previous dialog to leave before targeting `confirm-delete`); the doc comment on `FocusTrapOptions.isTopmost` still says "every migrated trap except DialogShell" and is out of date.
