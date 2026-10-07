# FU-2 report: focus-trap pass three (three trap-less dialogs, ModelForm's Escape, the flaky admin test)

Status: DONE_WITH_CONCERNS (concerns are follow-ups, listed at the end; nothing is open in the brief).
Model: `claude-sonnet-5-5`.
Worktree `art-fu2`, branch `fix/focus-trap-pass-three`, from `feat/artifacts` f33f1316.
Commits `67576870..74966575` (8 commits, 16 files, +1,275 / -105 including tests). Nothing pushed, merged or rebased.
No `artifacts/**` file, no `i18n/artifacts.ts`, no project/knowledge file touched. No new strings (no i18n change).

## Commits

| Commit | What |
|---|---|
| `67576870` | Step 3. `tests/e2e/settings-admin.spec.ts`: every control of the Users test is named through the surface it belongs to. |
| `3a35c716` | Step 1. `ModelForm` joins the DialogShell open-dialog stack and answers Escape only while topmost. Unit tests (`ModelForm.dialog.test.ts`, new) and the Playwright case, red first. |
| `b29c54aa` | Step 2. `ImageLightbox` on the shared trap and the stack. 13 new unit tests (4 pin today's behaviour, 9 new behaviour). |
| `135ff017` | Step 2. `ModelSelectionGuideModal` on the shared trap and the stack; `ComposerToolsMenu` defers Escape to a dialog above it; new `tests/e2e/dialog-focus-trap.spec.ts` (lightbox + guide). |
| `4613f478` | Step 2. `ModelForm` on the shared trap; the keyboard Playwright case. |
| `e7022d45` | Step 2. `ConversationJumpRail`'s `onTab` override and the `FocusTrapOptions.onTab` option are gone; the `isTopmost` doc comment and the DialogShell stack notes corrected. |
| `95e3c3f1` | svelte-check fix in one of my tests (render target option shape). |
| `74966575` | Test-only: FT-2's crop-dialog e2e waits for the leaving dialog before it clicks "Add slide" (flaky on the base too, see below). |

## Step 1: `ModelForm`'s Escape (a real bug, confirmed)

Red first in a browser with real keys (`settings-admin.spec.ts`, "Admin model form dialog"): open a model's form from its Edit button, change the display name, choose an icon file (file chooser), press Escape once. On the unfixed tree both dialogs were gone and the edit with them (`getByRole('dialog', { name: 'Edit Model' })` not found after one Escape).
Fix: `ModelForm` registers on the DialogShell stack (`registerDialog`/`deregisterDialog` in an `$effect`) and its Escape handler asks `isTopmostDialog`. The crop (registered later) is above it, so the first Escape closes the crop and the second closes the form. With the crop up, focus and the edit stay. In step 2 this same registration became the trap's `isTopmost`.
Unit side (`ModelForm.dialog.test.ts`): pins (modal dialog named "Edit Model", Escape closes, the x and Cancel close; green on the old code), then "sits on the stack while mounted" and "leaves Escape to a dialog opened on top, answers again once it closes" (red first).

## Step 2: a trap for the three `aria-modal` dialogs

Pattern, identical in all three (and the one CampaignCropModal uses): `$effect` registers/deregisters on the stack; `focusTrap({ isTopmost: () => isTopmostDialog(id), onEscape: preventDefault + close, focus: { target: () => dialogRef }, restoreFocusOnCleanup: true, preventScroll: true })`; `{@attach trap}` and `bind:this` on the dialog element; `outline: none` on the dialog's own `:focus` (it takes the first focus itself; the controls inside keep their own focus styles). First focus goes to the dialog element, not a control: a picture, a long list and a long form have no control worth landing on, and the Canvas photo block (`PhotoNode`) already relied on the lightbox element taking focus.

| Dialog | Behaviour pinned first (green on the old code) | New behaviour (red first) |
|---|---|---|
| `chat/ImageLightbox.svelte` | page scroll lock taken and the prior value given back; arrows and Escape ignored while closed; Escape closes and cancels the key | takes focus itself; Tab/Shift+Tab wrap (also from the dialog itself, and with one image); stray focus pulled back; focus back to the opener without scrolling; on the stack only while open; Escape, Tab and the arrows left to a dialog above it. The arrows stay on the window listener, gated on `isTopmostDialog`. |
| `chat/ModelSelectionGuideModal.svelte` | its backdrop moves to `<body>` and is removed with it; Escape closes | same list as above. |
| `settings/_components/ModelForm.svelte` | Escape, x and Cancel close; modal dialog "Edit Model" | same list (Shift+Tab on the dialog goes to Cancel, Tab from Cancel to the x). |

Playwright, one case per dialog, driven by the keyboard (`dialog-focus-trap.spec.ts`, and `settings-admin.spec.ts` for the form), each seen red before the fix on "dialog never takes focus" (`Expected: focused, Received: inactive`):
- lightbox: Shift+Tab from the dialog wraps to "Next image", Tab to "Close", every Tab on the way round stays inside; arrows page and wrap (1/2, 2/2); body scroll lock set while open and restored; Escape closes. The one mouse action is the click that opens a picture: a picture in a reply is not a control, so no key reaches it.
- model guide: opened from the "+" menu entirely by keyboard (Enter on the trigger, Enter on the "?"); first focus on the dialog; Shift+Tab to the privacy-policy link (the last control), Tab to Close; Escape closes the guide only, the menu stays and the "?" has focus again; the next Escape closes the menu.
- model form: opened with Enter on the Edit button; first focus on the dialog; Shift+Tab to Cancel, Tab to the x, Tab on; Escape closes and focus is back on the Edit button.

**One change outside the three files, needed for "Escape closes the topmost only" to be true for the guide:** it opens above the composer's "+" menu, and `ComposerToolsMenu.svelte`'s window Escape handler closed the menu too (one press closed the guide and the menu, and the "?" that focus should return to went with it). The menu now defers with `hasOpenDialog()` (the documented protocol for a host with its own window handler: its listener is registered before the dialog's, so `defaultPrevented` is no use). Unit test red first (`ComposerToolsMenu.test.ts`: the guide opened from the real Model row, first Escape closes the guide and not the menu, second closes the menu).

Side effect, an improvement: a lightbox over a Canvas photo block inside the expanded document panel used to collapse the panel on Escape as well (the panel's handler defers to `hasOpenDialog()`, which did not know the lightbox); now it does.

`ConversationJumpRail`: first pinned the case the override existed for (new test: Shift+Tab pressed on the phone sheet itself wraps to the last control, `defaultPrevented`), then removed `onTab` from the rail, the option from `FocusTrapOptions` and `trapTabKey`'s caller, and the option's own test (nothing else used it). `getFocusableElements` keeps its other users (SearchModal, Tabs). Doc comment on `isTopmost` rewritten to say who sets it (everything on the DialogShell stack) and who does not (memory modal and its popovers, linked-document picker, the rail's sheet); the DialogShell notes that named only the two campaign modals now name every dialog that joins.

After this pass no `aria-modal` dialog is left without a trap. Left outside the stack on purpose or by scope: `SearchModal` (own Tab wrap, deliberate), `KnowledgeMemoryModal`/`KnowledgeMemoryView`, `LinkedDocumentPicker`, the rail's sheet.

## Step 3: the flaky `settings-admin.spec.ts:411`

Reproduced: 7 failures of 8 back-to-back runs (the first run, with a cold server, passed). Cause, measured in a browser with a throwaway probe: **the test, not the UI.** A confirmation that has just been answered fades out while the next one fades in. The leaving one stays in the DOM for the length of its fade but is already inert (Svelte 5 sets `inert` on an outroing element: probe at the moment of collision: `rootInert: true`, and `elementFromPoint` at its button's centre lands outside the dialog), so it takes no click and is not in the browser's accessibility tree. The test reached its controls by test id or label alone, so whenever it ran faster than a fade it met two of them. Three lookups had that shape, and the other two only surfaced once the first was fixed (a second run of ten still failed 2/10 on the next one):
1. `getByTestId("confirm-delete")` (promote dialog leaving, delete dialog entering);
2. `getByRole("button", { name: "Promote to Admin" })` (the panel's button and the leaving dialog's confirm have the same name);
3. `getByText(uniqueEmail)` right after create (table cell, detail panel and the panel's "Created ..." notice, depending on timing).
Fix: each control is named through its own surface (dialog by accessible name, the panel's buttons through `admin-user-detail`, the new account through its table cell). Results: the test 10/10 after the last fix (the run before it, with the first two fixed, still failed 2/10 on the third lookup); **the whole `settings-admin.spec.ts` 10 times in a row afterwards: 110/110 passed.**
Considered and rejected: waiting for the fade to end (hides the overlap, slower, still ambiguous), and a UI change (nothing to change: the leaving dialog already cannot take a click).

## Also found and fixed: FT-2's crop-dialog e2e flaked on the base (`admin-users-campaigns.spec.ts:161`)

In the full Playwright run it failed ("Add slide" not focused after the crop closed). Checked against the base: with the seven source files I changed checked out from f33f1316, it failed 3 of 8, same error, so not mine. Cause: the test clicked "Add slide" and only then waited for the New campaign dialog to be gone, but that dialog hands focus back to its opener as its fade ends (by design), so a click inside the fade had its focus taken by "New campaign", and the crop then handed focus back there. Fix (test only): wait for the dialog first, then click, then check the slide exists before reaching for the file input. 12/12 green afterwards. A second symptom showed once in a 3x rerun of the whole file (a 60 s wait for the file input, i.e. the slide was never added); it did not recur in the 8 base runs or the 12 runs after the change, and I cannot say the reorder fixes it, but the explicit slide check now fails it at once with a readable message.

## Gates (once, at the end; worktree clean)

- `npm run check`: 8347 files, **0 errors, 17 warnings** (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1 = baseline).
- `npx biome check src scripts tests`: 2451 files, clean.
- `npm test`: 1004 files passed, 1 skipped; **16,334 tests passed**, 2 skipped.
- `npm run build`: exit 0, **32 `Unused CSS selector` + 2 `must have an ARIA role`** = baseline.
- `npm run check:artifact-chunks` (on that build): **exit 0**. Editor first paint 69.6 kB gzip (ceiling 71,680 B); chat route 538,673 B gzip, +1,790 against the 536,883 baseline (2,048 allowed). Measured on the same tree with my seven source files swapped for the base versions: 538,498 (+1,615), so **my change is +175 B**; the integration branch already sits 1.6 KiB over the recorded baseline, so the gate has about 260 B left on a developer machine (and the server builds ~660 B heavier: the gate is not part of `npm run build`).
- Fallow: **124 issues, 4 circular** = baseline, zero new.
- `npm run check:migrations`: passes.
- Playwright, one run on 5470 against a dev server I started (509 tests selected: every `artifact*` spec, knowledge, chat, conversation, settings-admin, settings-admin-system, admin-users-campaigns, dialog-focus-trap, composer-direction-b): **484 passed, 23 skipped, 2 failed.** Both failures were in `admin-users-campaigns.spec.ts`: (a) the first test of the run, `page.goto: net::ERR_ABORTED` inside `login()`, which also hit the first test of several of my later runs; it only happens against a long-lived dev server after source edits (Vite reloads the page under the navigation) and passed 3/3 on rerun; (b) the crop-dialog flake above (fixed afterwards, 12/12). The file's other 6 tests passed in the run; in the 3x rerun every test but the crop one passed (21 of 21, the aborted first test included).
- Also run: `artifact-canvas-live.spec.ts` lightbox case (Canvas photo block opens the lightbox, pages, gives focus back to the thumbnail) passes with the trap.

## Screenshots (looked at; no UI change, 1440x900, light, English)

`scratchpad/w4/fu2-shot-lightbox.png` (opened by click, then Tab: Close shows its own focus style, no ring round the window), `fu2-shot-guide.png` (opened by keyboard over the "+" menu, no ring round the panel), `fu2-shot-model-form.png` and `fu2-shot-model-form-tab.png` (first focus on the dialog shows no ring; one Tab puts the ring on the x). Four, all as expected. I did not take the Hungarian/phone set: no string or layout changed, only the dialogs' own focus outline is suppressed.

## Deviations from the brief

- Touched `ComposerToolsMenu.svelte` (not named): required for the guide's Escape to close the topmost layer only (above).
- Changed FT-2's crop e2e (not named): in the gate set and flaky on the base.
- `FocusTrapOptions.onTab` is removed from the public type (the brief allowed it "if nothing else uses it": nothing in this tree does; a branch that adds a user will fail type-check at merge, and the default now covers the container-focused case it existed for).
- The lightbox e2e opens with one click (see above); everything else is keys.

## Open questions and follow-ups

1. **Pictures in replies cannot be reached or opened by keyboard** (no control opens the lightbox; the opener is the `<img>`), so after a mouse open there is nothing meaningful to return focus to: it returns to whatever had it (the page). Making content images buttons is an accessibility change in `MarkdownRenderer`, not done here.
2. **DialogShell returns focus when its fade ends, not when it closes.** For ~150 ms after a dialog closes, focus sits on the page (the dialog is inert) and then jumps to the opener, taking focus from anything the user (or a test) focused in that window. It is the cause of the crop-dialog flake and of the note in FT-2's report. The product-level fix is to restore at the start of the outro; it touches the shared trap and every DialogShell user, so I left it. Low priority.
3. `PhotoNode` (Canvas, `artifacts/**`, not mine) still moves focus into the lightbox and back to its thumbnail itself; the trap now does the same, to the same elements, so it is redundant but harmless (both tests green). The Canvas owner can drop it.
4. Other specs still reach `confirm-delete` by test id alone (`admin-users-campaigns` x3, `conversation` x2, `auth`, `helpers.ts`). Each has a single dialog open at that point today; same class of risk as step 3 if a second ever overlaps. Untouched.
5. While a dialog on the stack is mid-fade (it deregisters when its fade ends), `hasOpenDialog()` stays true for ~150 ms, so an Escape in that window is ignored by the "+" menu and the document panel. Pre-existing for every DialogShell user; the new users add no new case.

## Hand-off

- `src/lib/utils/focus-trap.ts`: `FocusTrapOptions.onTab` removed; nothing else changed in the API. `isTopmost` doc rewritten.
- Pattern for any dialog that is not a DialogShell but nests with them (now used by CampaignModal, CampaignCropModal, CommentsSurface, AppBody, AnchoredPopover, ImageLightbox, ModelSelectionGuideModal, ModelForm): `$effect(() => { registerDialog(id); return () => deregisterDialog(id); })`, `focusTrap({ isTopmost: () => isTopmostDialog(id), onEscape, focus: { target: () => ref }, restoreFocusOnCleanup: true, preventScroll: true })`, `{@attach trap}`; all three functions and `hasOpenDialog()` come from `$lib/components/ui/DialogShell.svelte`. A window-level Escape handler that is not a `focusTrap` defers with `hasOpenDialog()` (now also `ComposerToolsMenu`, besides `DocumentWorkspace`).
- Props are unchanged on `ImageLightbox`, `ModelSelectionGuideModal` and `ModelForm`. `ImageLightbox` registers on the stack only while it has a picture (hosts such as `PhotoNode` keep it mounted with `index === null`).
- Tests added: `ModelForm.dialog.test.ts` (12, new file), `ImageLightbox.test.ts` (+13), `ModelSelectionGuideModal.test.ts` (+10: 2 pins, 8 new behaviour), `ComposerToolsMenu.test.ts` (+1), `ConversationJumpRail.test.ts` (+1), `focus-trap.test.ts` (-1, the option's test); Playwright: `dialog-focus-trap.spec.ts` (2, new file), `settings-admin.spec.ts` ("Admin model form dialog", 2), and the Users test reworked.
- Run e2e against a long-lived dev server (`PLAYWRIGHT_REUSE_EXISTING_SERVER=true`) only if you accept that the first test after a source edit can fail with `ERR_ABORTED` in `login()`; Playwright's own server does not do that.
