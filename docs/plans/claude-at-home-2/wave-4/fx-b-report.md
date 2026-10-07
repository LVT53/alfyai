# FX-B report: the panel over a project's Files dialog, the tours' reader, the dialog's footer

Status: DONE_WITH_CONCERNS (concerns are follow-ups, listed at the end; nothing in the brief is open).
Model: `claude-sonnet-5-5`.
Worktree `art-fxb4`, branch `fix/artifacts-w4-project-panel`, from `feat/artifacts` `65b9beb3`. Port 5410.
Commits `65b9beb3..7d57e7d6` (5 commits, 14 files, +1,077 / -42 including tests). Nothing pushed, merged or rebased; no other branch or worktree touched.

## Commits

| Commit | Finding | What |
|---|---|---|
| `9d224223` | I-2 | The panel over the Files dialog is a layer of the one dialog stack. |
| `915bbb2d` | I-3 | The tours' page-load answers are the signed-in reader's wherever the panel is hosted. |
| `dad488dc` | M-6 | The footer promises removal only while a row offers it. |
| `3bb4c525` | M-11 | The panel header draws no "This chat" crumb where there is no list. |
| `7d57e7d6` | tests | Dialog-plus-panel Escape unit test; Close-button focus return e2e. |

## I-2 · Tab and Escape over the Files dialog (`9d224223`)

Cause, confirmed in a browser: the panel is not on the stack, so the dialog behind it answers Tab (the next tab stop after the
last control of the panel, or after the editor, is the dialog's portaled search field) and Escape. A second cause, found by
tracing `preventDefault` on the key: **ProseMirror marks Escape (and Enter) as handled on every press** (`captureKeyDown` in
prosemirror-view), so the panel's own window handler skipped any Escape pressed in the Document's editor (`defaultPrevented`),
and only the dialog's trap, which ignores `defaultPrevented`, reacted.

Fix, `DocumentWorkspace.svelte` (the hook only):
- New prop `overDialog` (default false). While it is set and the shell shows, an `$effect` registers the panel on the dialog
  stack (`registerDialog`/`deregisterDialog`), after the dialog it sits on (the dialog is earlier in `ProjectFilesDialog`'s
  template and registers when it mounts), so the panel is topmost and the dialog's trap and Escape stand down.
- One `focusTrap` per shell (`trapFor("desktop" | "mobile")`), attached with `{@attach overDialog ? trap : undefined}` to all
  four shells (item and list, desktop and phone). Each is gated on `overDialog && previewRendererSurface === surface &&
  isTopmostDialog(stackId)`: both shells are mounted and only the one the viewport shows may answer, or the hidden one would
  `preventDefault` a Tab it can place nowhere. `restoreFocusOnCleanup` gives focus back to what had it when the shell mounted,
  which is the row's Open button. No initial-focus option: `focusPanelTitleOnOpen` already puts focus on the title.
- Escape: the window handler's own rule is now `closeFromEscape()` (list first, then the expanded close), used by the window
  handler and by the trap. A `defaultPrevented` key stays the inner layer's (a note being edited, a composer cancelling, the
  tour card's Skip), except ProseMirror's blanket one (`isEditorsOwnEscape`: target inside `.ProseMirror`). The trap stops
  immediate propagation, as DialogShell's own handler does: the dialog under the panel becomes topmost the moment the panel
  leaves the stack, which can be before its listener has run.
- `ProjectFilesDialog.svelte` passes `overDialog`.

Red first, with real keys and clicks (`tests/e2e/project-panel-over-dialog.spec.ts`), all red on the unfixed tree for the
reviewer's reason and green after:
1. Document: from the editor, Tab x8 and Shift+Tab x8 keep focus in the panel and never on the dialog (red: Tab #1 leaves).
2. Canvas: Tab x16 / Shift+Tab x16 from the board's controls (red: Tab #1 leaves).
3. One Escape from the editor closes the panel only, focus lands on the row's Open button; the second Escape closes the
   dialog and focus lands on the "N elem" chip (red: the dialog is gone after one).
4. Escape from a Canvas control closes the panel only.
5. Three layers: the Download popover, then the panel, then the dialog, one Escape each.
6. Closing with the panel's own Close button gives focus back to the row too (added after the gates; green).
7. Phone (390x844, touch): tap opens over the sheet, Tab/Shift+Tab stay in the phone shell, one Escape closes only it.
8. The first-open tour card is the innermost layer (Escape skips it; then the panel; then the dialog).
Unit: `DocumentWorkspace.over-dialog.test.ts` (8; 5 red without the hook) and a dialog+panel test in `ProjectFilesDialog.test.ts`
(red without `overDialog`: the dialog's `onClose` fires on the first Escape).

## I-3 · the tours' reader (`915bbb2d`)

Both halves of the review's fix direction:
- `currentUser` is threaded: project `+page.svelte` (`data.user`) -> `ProjectFilesDialog` (new optional prop) -> `DocumentWorkspace`,
  so `keepArtifactToursFor(currentUser?.id)` names the reader (and comment avatars get the reader's own identity there).
- `forgetArtifactTours()` (new export of `client/api/artifact-tours.ts`: clears what was kept and whose it was) is called by
  `clearClientAccountState()` in `client/session-boundary.ts`, the one boundary sign-out (Sidebar, Header) and sign-in (login
  page) both cross. Needed in its own right: a host that names no reader is "no one" for every account, so
  `keepArtifactToursFor(undefined)` never saw a change.

Red first: e2e "an in-tab sign-out and sign-in gives the next reader their own first tour": reader A opens their Canvas from
the Files dialog and finishes the tour; signs out through the sidebar (Logout + confirm); reader B signs in through the login
form on the same tab; goes in-app (sidebar project row, no reload) to their own project and opens their first Canvas. Red:
no card (the reviewer's "no card"). Green: B's card shows, exactly one `GET /api/artifact-tours/canvas`, no seen row for B.
Unit, each half alone and red first: `forgetArtifactTours is not a function`; `session-boundary.test.ts` (new: the tour was
fetched once, not twice); `ProjectFilesDialog.test.ts` (`keepArtifactToursFor` was not called with the reader's id).

## M-6 · the footer (`dad488dc`)

`ProjectFilesDialog.svelte`: `isRemovable(file)` (`file.linked !== false`) now decides both the row's unlink button and the
footer note, so they cannot drift. Footer: made items with some removable row keep "N items · removing one here keeps it in
your library"; made items only say "3 items"; plain files unchanged ("2 files · removing one here ..."); an empty list says
nothing (it was "0 files · removing one here keeps it in your library", the same untruth). No new string: `artifacts.bundle.items`
and `footerNote` are reused, `i18n/projects.ts` and `i18n/artifacts.ts` are untouched.
Red first: unit (3; the review's exact text "3 items · removing one here keeps it in your library"), e2e (3 made items, then a
Document linked from another chat through the real link route and the dialog reopened: "4 items · removing one here ...").
The existing unit test "counts items once anything was made" changed on purpose: its second step used an unlinked made item, which
has no unlink, so it now uses a linked one.

## M-11 · the crumb (`3bb4c525`)

`DocumentWorkspace` passes `onBack` to the header only when the host gave it a list (`onBack={list ? handleBackToList : undefined}`
at both header sites), and `ArtifactPanelHeader.svelte` draws the crumb only when it has an `onBack` (the grow spacer stays, so
the actions keep their place). That also takes the dead crumb off the Knowledge page's panel. Red first: header unit, workspace
unit, e2e (crumb count 1 on the unfixed tree). The existing workspace test "the breadcrumb returns to the list" now gives its
panel a list, as the chat does (its premise was a crumb with no list; the accessible name is now the counted one, `/This chat/`).

## Gates (final HEAD `7d57e7d6`; source files unchanged since `3bb4c525`)

- `npm run check`: 8386 files, **0 errors, 17 warnings** (= baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1).
- `npx biome check src scripts tests`: 2497 files, clean.
- `npm test`: 1021 files passed, 1 skipped; **16,768 tests passed**, 2 skipped.
- `npm run build`: exit 0, **32 `Unused CSS selector` + 2 `must have an ARIA role`** (= baseline).
- `npm run check:artifact-chunks` (separate step): editor first paint unchanged (69.9 kB gzip, ceiling 71,680 B); Chart.js, MapLibre
  and Mermaid out. **Chat route, measured by building both trees on this machine: base `65b9beb3` src = 542,499 B gzip (+2,014
  against the 540,485 baseline); this branch = 542,913 B gzip (+2,428). My growth: +414 B. The gate therefore FAILS on this
  branch by 380 B (2,048 allowed).** I did not move `--chat-baseline`; the move to record is +414 B for this branch on top of the
  base (RV-F measured the base at 542,478 on its machine, so the base itself had ~34-55 B of headroom).
  Where the bytes are: the `overDialog` hook in `DocumentWorkspace` (stack effect, two traps, four attach sites, the Escape helper),
  `forgetArtifactTours` + its import in `session-boundary`, the `{#if onBack}`. Nothing was lazy-split: the hook is a few dozen lines
  and the chat never uses it, so moving it behind an `import()` would save ~300 B at the price of an async window in which the
  first Tab after open has no trap; say so if you want it.
- Fallow: **124 issues, 4 circular** = baseline, zero new.
- `npm run check:migrations`: passes.
- Playwright (one run on 5410, 600 tests selected: every `artifact*` / `artifacts-*` spec (45 files), knowledge, chat,
  conversation, project-files, project-page, project-panel-over-dialog, dialog-focus-trap, home-projects, auth, login):
  **577 passed, 23 skipped, 0 failed** (40.8 min). My spec was run again alone after the two last test additions: 11/11.

## Screenshots (looked at; Hungarian, light unless noted; `scratchpad/w4/shots/fx-b/`)

- `01-files-dialog-hu-light.png`: Files dialog, three made items, footer "3 elem" with no removal promise (M-6).
- `02-panel-doc-hu-light.png`: the Document panel over the dialog: no "EZ A BESZÉLGETÉS" crumb, title and the three actions in place (M-11).
- `03-panel-doc-tab-focus.png`: after two Tabs the focus ring is on the toolbar's Bold button, inside the panel.
- `04-after-escape-dialog-stays.png`: after one Escape the panel is gone, the dialog stays, and the first row's Open button shows its focus ring.
- `05-panel-canvas-hu-dark.png`: the Canvas panel over the dialog, dark: header without the crumb, board and toolbar as usual.
- `06-phone-sheet-hu.png`: 390x844, the Files sheet with "3 elem" in the footer.
- `07-phone-panel-hu.png`: 390x844, the Document panel over the sheet: no crumb, actions at the top right.

## Deviations from the brief

- Touched `ArtifactPanelHeader.svelte` (+ its test) for M-11: not on the list, but the crumb is drawn there and no other cluster touches it.
- Touched `DocumentWorkspace.test.ts` and `DocumentWorkspace.test-helpers.ts` (an optional `overDialog` option) for the tests above.
- Did not touch `i18n/projects.ts` or `AGENTS.md` (no string was needed; AGENTS.md sentences are below for you to place).
- Two existing unit tests changed on purpose (named above).

## Open questions and concerns

1. **A press on the 20 px ring around the expanded panel still closes both layers** (real click at x=8: panel and dialog gone). The
   panel's `pointerdown`-outside close (unchanged) closes the panel, and the same press's click then lands on the dialog's scrim
   button. Not part of I-2 (keys), left alone: the fixes are a one-shot capture-phase click swallow armed by that press (a hack, and
   it adds bytes to the chat route) or a transparent scrim of the panel's own in over-dialog mode (markup and CSS). Phones are
   not affected (the phone overlay covers everything).
2. **Assistive tech.** The panel is an `aside`, not a `role="dialog"`, and the Files dialog behind it is `aria-modal="true"` and
   portaled later in the DOM, so a screen reader may treat the dialog as the only modal and hide the panel. Keyboard focus is right
   now; the semantics are the pre-existing host's.
3. **Teardown edge.** If the whole Files dialog is destroyed while the panel is still registered (browser Back with both open), the
   DialogShell's `onDestroy` finds the stack non-empty and leaves `body { overflow: hidden }` until the next dialog closes. The same
   hazard exists for any joiner (the image lightbox over a dialog). Not reachable by Escape or the Close buttons, which deregister
   the panel first. I considered putting the workspace before the dialog in the template, which fixes it but makes a stale-open
   mount register the panel under the dialog; not done.
4. Escape inside the Document editor now closes the panel in this host. On the Knowledge page (expanded, no dialog) it should still
   not, for the same ProseMirror reason (`handleWindowKeydown` skips a `defaultPrevented` key; read from the code, not run there).
   Untouched; say if you want it aligned.

## Hand-off (AGENTS.md sentences for you to place; I did not edit AGENTS.md)

- Tours section, "The panel decides": add that `clearClientAccountState` calls `forgetArtifactTours()` (client/api/artifact-tours.ts), so
  a host that names no reader cannot carry one account's "seen" to the next, and that every host passes `currentUser` (the chat,
  the Knowledge page, the project's Files dialog).
- Artifacts section: a host that opens the panel over a dialog passes `overDialog` to `DocumentWorkspace`: the panel is then a layer of
  the one dialog stack while open, Tab is trapped in the shell the viewport shows, one Escape closes the panel only
  (`isEditorsOwnEscape` lets ProseMirror's blanket Escape through, any other `defaultPrevented` Escape stays the inner layer's), and
  focus returns to what opened it. `ArtifactPanelHeader` draws the crumb only when given `onBack`, which the workspace gives only with a list.
- Modules: `src/lib/components/document-workspace/DocumentWorkspace.svelte` (`overDialog`, `closeFromEscape`, `trapFor`),
  `src/lib/components/artifacts/ArtifactPanelHeader.svelte` (optional `onBack`), `src/lib/client/api/artifact-tours.ts`
  (`forgetArtifactTours`), `src/lib/client/session-boundary.ts`, `projects/[projectId]/_components/ProjectFilesDialog.svelte`
  (`currentUser`, `overDialog`, `isRemovable`), `tests/e2e/project-panel-over-dialog.spec.ts` (new, 11 cases).
