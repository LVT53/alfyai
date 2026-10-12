# FB-3 — the panel's motion and layout (F3, F4, F15, F19, F26)

Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `art-fb3`, branch `fix/friction-panel` from `feat/artifacts` (`de7beaa0`).

| Commit | Finding |
|---|---|
| `ed810c0e` | F4: the docked panel and the chat change width together, on one curve (open, close, reload) |
| `0787b7c5` | F19: deleting the open item shows the list without closing the panel |
| `1792abb5` | F26: expand animates; the X closes; the count button brings the item back |
| `7dad9dc7` | F3: the sidebar folds to its rail while a docked panel needs the room |
| `d538a054` | F26 follow-up: specs that reopen a closed panel by the count button |
| `02f23d22` | F15: the tour card is laid over the item |
| `499268e9` | AGENTS.md (the dock's rules, the tour card's placement), reduced-motion and column-fill specs |
| `d5fbc8fe` | gate fixes: biome format of `DocumentWorkspace.svelte`, a stale entrance direction after a delete |

## Gate (`scripts/gates.sh agent <out> --port 5400 --workers 4` with the specs below, run at `499268e9`; logs in `fb3-gates/run1/`)

Specs named: `artifact-panel-motion`, `artifacts-panel`, `artifact-panel-names`, `artifact-panel-popover-press`, `artifact-panel-swap`, `artifact-tours`, `artifact-tours-empty-states`, `artifact-chat-card`, `artifact-card-narrow`, `chat`, `project-panel-over-dialog` (in full) + the `@smoke` set.

```
migrations ok    1s
fallow     ok    total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
build      ok    unused-css=32 aria=2 (baseline 32/2)
chunks     ok    editor closure 71.0 kB gzip; chat route first paint 552,961 B in 82 chunks (information only)
vitest     ok    1,061 files, 17,999 tests passed, 2 skipped
playwright ok    130 passed, 0 skipped, 0 failed, 0 flaky, 4 workers, 1m20s (production build)
check      FAIL  3 errors, 17 warnings in 8,465 files
biome      FAIL  1 file (a format line in DocumentWorkspace.svelte)
total 5m46s at load 12-16 (two other agents running)
```
- **check**: the 17 warnings are the baseline; the 3 errors are `scripts/eval-artifact-contracts/suites/canvas-tools.ts:280` and `canvas-tools.test.ts:232,234` (`instruction` is not on the edit tool's input type). They are on the base (`701898bf`, FB-2's "keep the eval's edit_artifact simulation in step with the tool"), untouched by this branch.
- **biome**: fixed in `d5fbc8fe`; `npx biome check src scripts tests` is clean (2,627 files). That commit also changes one condition (`deleteOpenItem` asks for the list only when the page has not already turned to it); re-verified with the workspace/client/store unit tests (226 passed) and `artifact-panel-motion` + `artifact-delete` (29 passed, dev server).
- Numbers below were recorded on the production build in the gate run (`fb3-shots/numbers-gate-build.jsonl`) and agree with the dev-server runs.


## What changed, per finding (red first, real input; `tests/e2e/artifact-panel-motion.spec.ts`, 19 tests)

**How it was measured.** `tests/e2e/panel-motion-helpers.ts` installs, as an init script, a `requestAnimationFrame` sampler (chat column, panel, composer, sidebar, plus any element a test names: box and transform per frame) and a `layout-shift` observer. They only observe. Every change is driven by a real click or key. Frame strips (CDP screencast) are in `fb3-shots/`.

Two numbers per change, because the audit's single "layout shift" number hides two different things:
- **biggest single-frame share of the travel** (`maxStepFraction`: 1.0 is a cut) — the "nothing jumps after its first frame" measure;
- the page's own `layout-shift` entries: the **biggest single entry**, and the **sum**. A smooth width change reports a small entry on every frame it runs, so the *sum* of a smooth open is as large as, or larger than, the sum of a cut; the biggest entry is what fell. I report both so nobody reads the sum as a regression.

### F4 — one motion language (ed810c0e)
Root cause: the docked shell had `max-width: 0` / `min-width: 0` at rest and `max-width: 68%` / `min-width: 620px` when open, none of them in the transition list, and its inline `width` was the same in both states, so the "width transition" never ran: the chat cut to its new width in one frame (for the item shell; the list shell jumped to its 620 px minimum, 65% of the travel), and a close removed the column in the frame the page stopped asking for it (the list branch was `{#if shouldRender && list?.open}`, the item branch needed `activeDocument`, which is null once the last item is closed), so no exit ever played.

Now the docked panel is a column whose **width** moves (0 → W on `--ease-emphasis` over `MOTION_DURATION.emphasis`; W → 0 on `--ease-in` over `standard`), and the chat column (flex 1) takes what it leaves, frame for frame. The width is one CSS `min()/max()` expression built by `src/lib/client/workspace-dock.ts` (`dockedWidthCss`), resolved by the browser against the live stage; the list shell and the item shell share it (the list used to ignore the reader's drag). What the column holds is laid out at the width it is growing to and shown from the right edge (`dockContentWidth`, from a ResizeObserver on the stage), so the editor/board/App are not re-flowed through every width. The content enters with the column (delay 0 instead of 60 ms: with the delay, the column was empty when the chat had already given up 80% of its width, which the second test holds). A column on its way out keeps what it showed (`lastShownDocument`, `lastShownList`, `shellPresentation`). A reload with the panel open opens it the same way.

| 1440, Document, sidebar on its rail | before | after |
|---|---|---|
| open (count button): biggest single-frame share of the chat's travel | 0.65 | 0.13 |
| open: biggest layout-shift entry / sum | 0.111 / 0.249 | 0.066 / 0.483 |
| close: share / biggest entry / sum | 1.00 / 0.488 / 0.488 | 0.09 / 0.046 / 0.478 |
| reload with the panel open: share / biggest entry / sum | 1.00 / 0.060 / 0.071 | 0.13 / 0.075 / 0.490 |

### F19 — delete (0787b7c5)
The page forgets a deleted item by closing its tab, and closing the last tab closes the panel; the panel asked for the list only after the delete had resolved. `handleArtifactDeleted` now opens the list in the same synchronous step whenever the panel was on that item and anything is left. Delete a Document from the panel (two items): layout shift sum **0.719 → 0.00005**, biggest entry 0.474 → 0.00005, widest chat column during the delete **1391 px → 445 px** (the docked width: no full-width frame).

### F26 — expand, X, count button (1792abb5, d538a054)
- Expand/dock are one inset animation each (`requestExpandedPresentation` / `requestDockedPresentation`: the old rect is the first keyframe, the overlay's own insets the last; the dock animates the overlay onto the column held for it, then switches). While expanded the panel leaves its column standing (`reserveDock`, `.workspace-dock-spacer`), so the chat does not re-flow behind it: chat travel during expand **947 px → 0**; the panel's biggest single-frame share **1.00 → 0.13**; biggest layout-shift entry **0.657 → 0.034** (sum 0.657 → 0.275).
- The **X closes**, in whatever shape the panel is in. Escape and a press outside still step out to the dock (existing specs rely on it; `artifact-panel-popover-press.spec.ts` passes unchanged), and the dock has a button of its own (`Minimize2`, the existing `documentWorkspace.collapseWorkspace*` strings, English and Hungarian). A panel that closes from expanded stays an overlay until it has faded.
- The **count button brings back the item the panel was closed on** (`lastClosedItem`, in memory), if it is still in the chat's list; otherwise the list. Two specs and one helper assumed "count button = list" after a close (`artifact-tours.spec.ts` "met again", `openCanvasPanel`); updated in `d538a054`.

### F3 — the floor and the sidebar (7dad9dc7)
Floor: chat column **364 px** (a composer of 340, the width the audit found still usable). Two steps, in the order the brief gives: the panel gives up width first (the dock arithmetic: ask, 68%, stage − 364, never under 440), then, when the chat would be under the floor with the panel at the width it asks for, **the sidebar folds to its rail** (`sidebarFoldedForPanel`, `setSidebarFoldNeeded` in `stores/ui.ts`; the decision is the chat page's). The fold is never persisted and never touches `sidebarCollapsed`; a press on the sidebar's button while folded opens it and keeps it open for as long as that panel stays (`toggleSidebarCollapsed`, used by `Sidebar.svelte` and `Header.svelte`).

Sidebar open, Document docked — chat column / composer / panel:

| window | before | after |
|---|---|---|
| 1100 | 180 / 156 / 620 | 364 / 340 / 688 (sidebar on its rail) |
| 1280 | 314 / 290 / 666 | 394 / 370 / 838 (rail) |
| 1440 | 365 / 341 / 775 | 365 / 341 / 775 (nothing needed) |

(The audit read 134 / 268 / 319 for the composer on its machine; ours measured 156 / 290 / 341. The floor is chosen so that the same rule holds on both.) The project crumb stops short of the count chip at all three; the sidebar is back as the reader had it when the panel closes (asserted).

### F15 — the tour card (02f23d22)
The card is decided a moment after the item has painted (a request, then a lazy chunk) and was a flex item above the item. It is now **a layer laid over the top of the item's stage** (`.workspace-tour-layer`, absolute, as tall as the card): no room is made, so none can be made late. Item box over the frames of the card's arrival / leaving, fresh reader:

| | before | after |
|---|---|---|
| Document moved on arrival / on leaving | 163 px / 169 px | 0 / 0 |
| App | 188 px / 190 px | 0 / 0 |
| Canvas: different fits on arrival / on leaving | 2 (re-fit) / 27 | 1 (its own first fit) / 1 |
| phone (390 × 844): where the Document's text starts while the card is up | y 453 (below the middle) | y 231 |

The empty state's "Show it again" link is handed to the body only while no card is up (`bodyReplayTour`). Existing tour specs (24) pass, one assertion changed on purpose (`artifact-tours.spec.ts`: the card is over the page, not above it). It does cover the top of a short Document while it is up; that is the price of "nothing moves", and the reader can Skip it.

## Deviations, decisions, concerns
- **Layout-shift sums rise on open/close** (explained above): the sum counts every frame of a smooth change. The audit's targets "nothing jumps after its first frame" are what the per-frame measure and the single-frame biggest entry show.
- **Reload**: the server cannot know the tab's panel state, so the server-rendered page is full-width until hydration; the panel then opens with the same motion (before: a cut). A cookie the server could read would remove that first full-width frame; not done.
- **Escape / press outside** still *dock* an expanded panel in the chat while the X *closes* it (the ruling names only the X; the popover-press spec relies on the rest). The new dock button is how a pointer user gets back to the dock.
- **Panel minimum**: the old CSS forced the panel to ≥ 620 px even where that left the chat 180 px; the floor now wins down to a 440 px panel (a window under ~800 px gets both under their wishes).
- **Sidebar's own width animation** (240 ms, its own curve) is left alone; it runs beside the panel's 250 ms on a curve that is close to `--ease-emphasis`. Not unified.
- `svelte-check` reports 3 errors in `scripts/eval-artifact-contracts/suites/canvas-tools{,.test}.ts` (`instruction` is not in the edit tool's input type) that exist on the base (`701898bf`, FB-2's eval-simulator commit); not from this work.
- One Playwright run of mine was killed by FB-4's `pkill -f "playwright test"` (exit 144); rerun and green.
- `artifact-canvas-helpers.ts` (`openCanvasPanel`) was edited: it now accepts "the count button brought the board back". FB-4 owns canvas specs; the change is a few lines.

## Hand-off for FB-5 (DocumentWorkspace's rows, list, headers, history entries)
What is new in `DocumentWorkspace.svelte` and the page that you build on or must not break:
- **Shell state**: `shouldShowWorkspaceShell` (the page's wish), `shouldRender` (is the column in the page, until the exit has played), `isVisible` (open state = `.workspace-fade-in`). `liveActiveDocument` is the item the page says is open; **`activeDocument` is the live one or, while the column is leaving, the last one shown** (`lastShownDocument`). Logic that must not act on a closing item should read `liveActiveDocument`. The list branch is `{#if list && renderListShell}` (was `list?.open`): a column leaving from the list keeps showing it. `shellPresentation` is the presentation the column had when it was last wanted; use it, not `presentation`, in the shell's markup.
- **Width**: only `--workspace-dock-width` (from `dockedWidthCss(workspaceWidth)`) sets a docked column's width. Do not add `max-width`/`min-width`/inline `width` to `.workspace-shell-desktop`: a limit the transition cannot see is a cut. A docked column's `.workspace-content` is absolutely positioned at the right edge with the number from `dockContentWidth`; anything you put in the header or list lives inside it and has that width from the first frame.
- **Header actions** (`artifactHeaderActionsSnippet`): the X (`handleCloseWorkspace`) closes; `stepOutOfExpanded()` is Escape / press outside / the phone's backdrop; `workspace-dock-button` (Minimize2) only in expanded with `returnToDockedOnExpandedClose`. The legacy header (`workspace-header`) has the same button.
- **List rows**: untouched, but the list shell now uses the same width and the same enter/leave as the item shell; `pendingEntrance` is reset after every arrival (default: from the right, no delay) and set to "left" by the `$effect.pre` that sees a list opening over an item (so `handleBackToList`'s manual set is redundant but harmless).
- **History entries (F7)**: the panel's open state lives in the page (`workspaceOpen`, `artifactListOpen`, `workspaceDocuments`, `activeWorkspaceDocumentId`, `workspacePresentation`); `closeWorkspace()` is the one function that closes (it also remembers `lastClosedItem`); `openWorkspaceDocument(...)`, `selectWorkspaceDocument(...)`, `openArtifactList()` open. A Back that closes the top layer should call these, not set the flags. The count button's click handler is `handleArtifactCountButtonClick` (F26's "brings back the item" is done: do not redo it for FB-5's "F26 (count button)").
- **Page**: `handleArtifactDeleted` is where "the panel was on the deleted item → show the list" lives (F19); `windowWidth`/`dockPreferredWidth`/`sidebarNeededForPanel` is the sidebar fold (F3).
- **Tour**: the card is rendered by the `tourCard` snippet inside `.workspace-stage`, *before* `.workspace-body` (both shells); do not move it back into `.workspace-body`. `bodyReplayTour` is what bodies get as `onReplayTour`.
- **Tests you may touch**: `artifact-panel-motion.spec.ts` (recorder helpers in `panel-motion-helpers.ts`: `installMotionRecorder`, `startRecording(page, {name: selector})`, `profile`, `shiftSum`); the unit tests in `DocumentWorkspace.test.ts` read the docked width out of `--workspace-dock-width` (`askedWidth`). The count button restores the closed item, so a spec that closes and reopens must expect the item, not the list.

## Screenshots and frames (`fb3-shots/`, each looked at)
- `open-strip.png`, `close-strip.png`, `expand-strip.png`: CDP screencast contact sheets (time since the first changed frame under each frame). Open: the chat narrows as the list is uncovered from the right edge, finished at ~290 ms. Close: the mirror, content fading, ~190 ms. Expand: the panel grows from its column to the window while the chat behind it stays put.
- `f3-1280-sidebar-folded-docked.png` (sidebar on its rail, chat 394 px, panel 838 px), `f3-1280-sidebar-open-before-panel.png`.
- `f15-document-card-over-item.png`, `f15-canvas-card-over-item.png` (board still fitted at 100% under the card), `f15-phone-hu-card-over-item.png` (390 × 844, Hungarian).
- `numbers-before.jsonl` (the original tree), `numbers-after-*.jsonl` (dev server), `numbers-gate-build.jsonl` (production build); `raw/` has every frame.

## Re-running
`E2E_SERVER=dev E2E_PORT=5400 E2E_WORKERS=1 FB3_NUMBERS=/tmp/n.jsonl npx playwright test tests/e2e/artifact-panel-motion.spec.ts` (the numbers are appended as JSON lines; the assertions never read them).
