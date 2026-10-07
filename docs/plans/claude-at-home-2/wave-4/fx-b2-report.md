# FX-B2 report: FX-B's three loose ends (the press on the ring, the panel as the modal layer, the scroll lock)

Status: DONE_WITH_CONCERNS (concerns are follow-ups, listed at the end; nothing in the brief is open).
Model: `claude-sonnet-5-5`.
Worktree `art-fxb5`, branch `fix/artifacts-w4-panel-layer`, from `feat/artifacts` `d69432e7`. Port 5470.
Commits `d69432e7..9c792bd7` (4 commits, 7 files, +712 / -33 including tests; 3 source files, ~95 lines of which most are comments). Nothing pushed, merged or rebased; no other branch or worktree touched; no subagents; `AGENTS.md`, `docs/plans/**` and the size baselines untouched.

## Commits

| Commit | Item | What |
|---|---|---|
| `c1e1c79e` | 1 | A press outside the panel over a dialog closes the layer that was on top, and no other. |
| `221af95a` | 2 | The panel over a dialog is the one modal layer to assistive technology. |
| `8f617f84` | 3 | The page's scroll lock is released by whichever layer leaves the dialog stack last. |
| `9c792bd7` | tidy | A local that shadowed the new `covered` prop is renamed; a comment named the wrong place for the unlock. |

## 1 · a press on the ring closed the panel AND the dialog (`c1e1c79e`)

Cause, confirmed in a browser (1440 and 1920 wide): the expanded panel leaves a ring of the dialog's own scrim round itself (20 px;
160 px each side on a 1920 window, the panel stops at 1600). A press there is a press on the dialog's scrim button. The panel's
`pointerdown` handler closed the panel on it, and the click that ended the same press then landed on that scrim button, whose
`onclick` closed the dialog.

Writing the red tests found a second symptom of the same handler: with the panel's Download popover open, a press **inside the
popover** (it is painted outside the panel's markup, in `<body>`) also closed the panel, because the handler only asked "is the
target inside the shell".

Fix, the rule being Escape's: one press closes the layer that was on top when it began.
- `DialogShell.svelte` (the dialog-stack module): the scrim records, in the **capture** phase (`onpointerdowncapture`, so before
  the panel's bubble-phase `<svelte:document>` handler can react), whether a layer was above the dialog as the press began, and the
  click closes only if none was. A click with no press behind it (`event.detail === 0`: a key on the focused scrim, a script) is
  judged as the dialog is now. Generic: any layer that closes on a press that lands on a dialog's scrim is now safe, not only the panel.
- `DocumentWorkspace.svelte` (the `overDialog` path only): the outside-press close answers only while the panel is the topmost
  layer (`if (overDialog && !isTopmostDialog(stackId)) return;`). A popover above it takes the press, inside it or beside it.

Red first, real input, on the unfixed tree (`project-panel-over-dialog.spec.ts`, all red for the stated reason, green after):
1. 1440 and 1920 wide: `page.mouse.click` in the ring closes the panel; the dialog is still there once its fade has settled
   (red: gone); one Escape then closes it and focus lands on the Files chip.
2. With the Download popover open, three presses on the ring close the popover, then the panel, then the dialog, one each (red: the
   first press took the panel too).
3. A press on the popover's heading leaves the panel, the popover and the dialog (red: the panel closed).
Note on a strengthened assertion: a closing dialog stays "visible" to a bare `toBeVisible()` for its 150 ms fade, so the first draft
of test 1 only went red on its next assertion on the unfixed tree; `expectLayerStays` asks after `waitForMotionToSettle` and
counts elements, so each of these now fails on the dialog (or panel) being gone.
Unit: `DialogShell.test.ts` (5, "scrim": the press-and-click pin, the covered press ignored even though the layer closed on it, the
next press its own, a keyboard click judged as it is now, no close while covered and no press), `DocumentWorkspace.over-dialog.test.ts`
(4: topmost closes, a layer above takes the press and the next one closes, a press inside is not outside, a panel not over a dialog is
unchanged).

## 2 · the panel is the modal layer to assistive technology (`221af95a`)

Measured first, in Chromium's own accessibility tree (CDP `Accessibility.getFullAXTree`), because the brief's wording ("may hide
it") is about what engines do:
- Unfixed: the panel is `complementary` (not ignored), the Files dialog is the only node with `modal=true`. The panel is an `aside`
  in `<main>`; the dialog is moved to the end of `<body>` when it opens, so the panel is not even later in the document.
- Chromium does **not** hide content outside an `aria-modal` dialog in that tree (the panel's nodes are `ignored: false` with the
  dialog modal), so the harm is for engines that act on `aria-modal` and choose the modal layer by document order. Giving the panel
  `role="dialog" aria-modal="true"` alone leaves two claims, and the earlier one in the document is the panel's.

Chosen: the app's dialog-stack convention (every layer is `role="dialog" aria-modal="true"`, the topmost is the modal) plus one
swap, and not `inert` / `aria-hidden` on the dialog, both measured:
- `aria-hidden="true"` on the dialog's root while the row's Open button still has focus: Chrome logs "Blocked aria-hidden on an
  element because its descendant retained focus" and ignores it until focus leaves (the AX tree still held the dialog's nodes: 135
  nodes with the button focused, 103 after a blur).
- `inert` takes the dialog out of hit-testing, so a press on the ring would fall through to the page behind it (and it changes the
  order in which the panel's trap records the focus to give back).

Fix:
- `DocumentWorkspace.svelte`: while `overDialog`, all four shells (item and list, desktop `aside` and phone `section`) are
  `role="dialog" aria-modal="true"`, named as the landmark was (`aria-label`: "Vienna notes, Document"). Not over a dialog: still a
  landmark, no `aria-modal` (pinned).
- `DialogShell.svelte`: new optional `covered` prop; `aria-modal={covered ? "false" : "true"}` on its dialog. A host with a layer
  over it that is not later in the document says so (the doc comment on the prop explains why).
- `ProjectFilesDialog.svelte`: `covered={workspaceOpen}`.
Result in Chromium's tree: exactly one `modal=true` node while the panel is open, and it is the panel (desktop and phone); the Files
dialog is the one again after the panel closes.

Red first (unfixed tree: no `dialog` named "<title>, Document" exists): `project-panel-over-dialog.spec.ts` "the one modal layer"
(desktop: the dialog is modal and alone, then the panel is the one in the markup (`[aria-modal="true"]:visible` = 1), in the browser's
tree (CDP `modal` nodes = [the panel]) and nothing above it is `aria-hidden` / `inert`, then Escape and it is the dialog again) and
the phone twin (390x844, touch). Unit: `DialogShell` (`covered` swaps and restores), `DocumentWorkspace.over-dialog` (both shells
are modal dialogs, a panel not over a dialog stays a landmark), `ProjectFilesDialog` (the Files dialog gives the claim up while the
panel is open and takes it back on Escape). Four existing `ProjectFilesDialog` unit tests looked the panel up as `complementary`;
the role is meant to change, so they look it up as `dialog` now (a helper takes the desktop shell: jsdom has no stylesheet, so a
phone's twin is in the tree there).

## 3 · destroying the dialog under the panel left the scroll lock on (`8f617f84`)

Cause, as FX-B found: `DialogShell`'s own teardown released `body { overflow }` only if it found the stack empty. Browser Back with
both open takes the whole page away: the dialog is torn down first (children before later siblings), finds the panel still on the
stack and leaves the lock, and nothing released it after the panel's effect cleanup. Red first on the real thing: the e2e goes in
through the sidebar's project row (client-side, so Back is the app's own `popstate`, with a marker on `window` that proves the page
was not reloaded), opens the Files dialog and a Document, presses the browser's Back (`page.goBack()`), and reads
`document.body.style.overflow`: `"hidden"` on the unfixed tree.

Fix (`DialogShell.svelte` module, the dialog-stack module): the lock belongs to the stack. `lockPageScroll()` (the first
DialogShell on an empty stack, as before) sets a module flag, and `deregisterDialog` releases the lock when the stack is empty again
and the flag is set, whichever layer is the last one out. A page no dialog locked is left alone (flag), and a server render never
touches `document` (the flag is only ever set on the client). `onDestroy` now just deregisters.
Also pinned with real keys (green before and after): the lock is held while the dialog or the panel is open and released after the
second Escape.
Unit (`DialogShell.test.ts`): a layer over the dialog outlives it and the lock goes with that layer (red), the layer leaving first
and the dialog last, a page no dialog locked is not touched.
Observation worth knowing: `app.css` has `body { overflow: hidden }` globally and every page scrolls in an inner container, so the
inline lock has no visible effect in this app today and "Back, then the page scrolls" cannot be observed as scrolling. The test
asserts the lock itself. The leak was still real state (a later `overflow` read, a page that does scroll the document, and the
ref-count's own invariant).

## Gates (final HEAD `9c792bd7`; the source is the same since the last edit)

- `npm run check`: 8407 files, **0 errors, 17 warnings** (= baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1).
- `npx biome check src scripts tests`: 2536 files, clean.
- `npm test`: 1033 files passed, 1 skipped; **17,220 tests passed**, 2 skipped.
- `npm run build`: exit 0, **32 `Unused CSS selector` + 2 `must have an ARIA role`** (= baseline), on both my tree and the base.
- `npm run check:artifact-chunks` (its own step, on that build): **exit 0**. Editor first paint 70.2 kB gzip (ceiling 72,704 B),
  unchanged. **Chat route, measured by building both trees on this machine: base `d69432e7` = 542,879 B gzip (+1,390 against the
  recorded 541,489 baseline); this branch = 543,060 B gzip (+1,571). My growth: +181 B.** I did not move `--chat-baseline`; the
  move to record is +181 B on top of the base. Where the bytes are: the scrim's press record and the lock move in `DialogShell`
  (in the chat bundle because the panel imports the stack functions from it), the `role`/`aria-modal` attributes on the four shells
  and one gate line in `DocumentWorkspace`. Nothing was lazy-split.
- Fallow: **124 issues, 4 circular** = baseline, zero new.
- `npm run check:migrations`: passes.
- Playwright (one run on 5470, 694 tests in 62 files selected: every `artifact*` spec (49 files), knowledge, chat, conversation,
  project-files, project-page, project-panel-over-dialog, dialog-focus-trap, home-projects, auth, login, instructions-dialog,
  search-modal, settings-admin, admin-users-campaigns; the last four because `DialogShell` is shared by every dialog):
  **671 passed, 23 skipped, 0 failed** (47.6 min). `project-panel-over-dialog.spec.ts` is 19 cases now (11 from FX-B, 8 new).

## Screenshots (looked at; Hungarian; `scratchpad/w4/shots/fx-b2/`)

- `01-panel-over-dialog-1440-hu-light.png`: the Document panel over the dialog, 1440x900, light: the ring of dimmed scrim round it,
  header without the crumb, editor and the "Megjegyzések" column.
- `02-after-ring-press-dialog-stays-1440-hu-light.png`: after a real press in the ring: the panel is gone and the Files dialog
  ("Fájlok", one row, footer "1 elem" with no removal promise, "Kész") is still there.
- `03-panel-over-dialog-1440-hu-dark.png`: the same panel, dark.
- `04-files-sheet-390-hu-light.png`, `05-panel-over-sheet-390-hu-light.png`: 390x844 touch, the sheet and the panel over it.
No visual change was made: the screenshots are for the record, and they look as before. (The e2e admin's UI language was set to
Hungarian for these and put back to English.)

## Deviations from the brief

- Touched three existing unit-test files besides FX-B's spec (`DialogShell.test.ts`, `DocumentWorkspace.over-dialog.test.ts`,
  `ProjectFilesDialog.test.ts`): the new behaviour needed unit tests beside the e2e ones, and four existing `ProjectFilesDialog`
  tests plus one `over-dialog` test asked for the panel as `complementary`, which is the role this change is meant to change.
- The DialogShell scrim rule is generic (any dialog), not panel-only: the cause is the dialog acting on a press the layer above
  already took, and fixing it at the panel (a one-shot capture-phase click swallow, FX-B's "hack") would have left every other
  joiner with the same hole.

## Open questions and concerns

1. **The same outside-press handler has the same gap where the panel is not over a dialog** (the chat's expanded presentation and
   the Knowledge page): a press inside the panel's own popover, which is painted in `<body>`, closes the panel on `pointerdown`
   (reproduced here in the project host with the gate removed; read from the code, not run, for the other two). The brief limited
   me to the `overDialog` paths, so the gate is `overDialog && !isTopmostDialog(stackId)`. The one-line equivalent for the other
   hosts is `if (hasOpenDialog()) return;`, exactly what `handleWindowKeydown` does for Escape. It changes what an outside press
   does with a popover open there (the popover goes first, the panel on the next press), so I left it for you to decide.
2. **After a press on the ring, focus is on the dialog's scrim button, not on the row that opened the item.** Chrome focuses a
   pressed button, and the panel's trap hands focus back to the row at pointer-down, before that. The keyboard and Close-button
   paths still return it to the row (FX-B's tests). The scrim is inside the dialog's trap, so a following Tab or Escape acts on the
   dialog; I judged moving it again to be more surprising than leaving it.
3. **Assistive technology is a measured Chromium tree plus reasoning for the other engines.** I could not run VoiceOver, NVDA or
   JAWS. What the change guarantees is one `aria-modal="true"` layer at a time, which is what engines that act on it need; Chromium
   exposes the whole tree regardless (the Files dialog's content stays reachable in browse mode, as it already is for every stacked
   dialog in the app).
4. `DialogShell`'s `covered` is an explicit prop on purpose: a reactive "covered by anything above" in the stack would change
   `aria-modal` on every stacked dialog in the app (ConfirmDialog over a dialog, a popover over a sheet) and I could not run the
   whole suite for each. If you want it general, the stack needs a reactive version counter; the prop then goes away.
5. The first test of a Playwright run after a source edit can fail inside `login()` (`message-input` not found, 17 s) while Vite
   re-optimises; it happened once in this session and passed on rerun (FU-2 recorded the same family).

## Hand-off (AGENTS.md sentences for you to place; I did not edit AGENTS.md)

- Artifacts section, where `overDialog` is described: while the panel is over a dialog it is also the one modal layer to assistive
  technology (`role="dialog"` and `aria-modal="true"` on its shells, named as the landmark was), and the host passes `covered` to
  that dialog's `DialogShell`, which then says `aria-modal="false"` until the panel is gone (the panel stays where its page put it,
  so it is not later in the document than the dialog, which is moved to the end of `<body>`). An outside press over a dialog belongs
  to the topmost layer, Escape's rule: the panel answers it only while it is topmost, and a `DialogShell` scrim closes on the click
  only if the dialog was topmost when the press began (recorded in the capture phase).
- Core rules, the `DialogShell` stack paragraph: the page's scroll lock belongs to the stack; the first `DialogShell` on an empty
  stack takes it and `deregisterDialog` releases it when the stack empties, whichever layer is last out (a layer that is not a
  `DialogShell` can outlive the dialog it sits over).
- Modules: `src/lib/components/ui/DialogShell.svelte` (`covered`, `lockPageScroll`/`deregisterDialog`, `notePress`/`closeFromScrim`),
  `src/lib/components/document-workspace/DocumentWorkspace.svelte` (`role`/`aria-modal` on the shells, the `overDialog` gate in
  `handleDocumentPointerdown`), `projects/[projectId]/_components/ProjectFilesDialog.svelte` (`covered={workspaceOpen}`),
  `tests/e2e/project-panel-over-dialog.spec.ts` (now 19 cases).
