# CV-B report: everything a person inserts on a board can be changed afterwards

Status DONE_WITH_CONCERNS (the two size budgets are over, see section 5). Model: claude-sonnet-5-5 (Sonnet 5.5).
Worktree `art-cvb`, branch `fix/canvas-edit-inserted`, from `feat/artifacts` d89ab5a4. Commits `d89ab5a4..bcdbf07f` (6):

```
2bb4a36d Specs first: what a reader inserts on a board must be changeable, and a touchpad's click must be a click   (red)
7c73d875 A touchpad's click is a click, not a drag: the board allows the pointer a few pixels of wander
93ff159f A note and a text block edit from anywhere on them; a frame's toolbar can be pressed
0644af79 Every block that can be changed has a visible Edit button on its toolbar
cf3df0ea A chart, a diagram, a checklist, a map, an App and a photo block can be changed after they are inserted
bcdbf07f A block that is being changed is above the blocks beside it
```

## 0. Reproduction (written before any fix, on a production build of d89ab5a4)

Method. `npm run build`, `node build` on port 5440 with the e2e database, Playwright on that server
(`PLAYWRIGHT_REUSE_EXISTING_SERVER=true E2E_PORT=5440`), Chromium 1440x900, a chat seeded with a produced file, an App, a
route, a Chart.js chart, a Mermaid diagram, a photo search and a web search, and an empty board. Every block was inserted
through the real Insert menu (written rows, then each "From this chat" row) and driven with `page.mouse` and
`page.keyboard` only: click, double click (`clickCount: 2`), drag in steps, the real resize corners, the real toolbar
buttons, Ctrl+Z, Delete. Two input styles. "mouse": clean press and release. "touchpad": the cursor wanders 1 to 3 px
between press and release, and a drag starts with the same wobble and then glides in 3 px steps (what a laptop touchpad
sends; its two-finger scroll and pinch are wheel events, CV-C's, not touched). 24 runs (12 options x 2 styles), one fresh
chat and board each; plus a wobble-amplitude probe, a double-click hit-area probe, and one run that inserts all twelve
options in a row at human speed (no conflict banner, twelve stored, still editable: the "board went read-only after a save
conflict" theory is ruled out). Raw results: `cvb/repro-*.json`, `cvb/repro-run2.log`.

Works for every kind, with a mouse: select, move, resize by a corner, Delete by key, Undo (Ctrl+Z, also of a delete).

| Insert option | what failed (mouse) | extra on a touchpad | cause |
|---|---|---|---|
| Sticky note | double-click on a note taller than its words does nothing unless it lands on the text lines (probe: lower middle of a 200x160 note, editing=false); no visible way to edit (toolbar: tones and Delete) | a 3 px wander moved it by (-1,-3): a click is an undo step | `.sticky` is `min-height` only: the paper below the words is not the double-click target |
| Text | same: a taller text block edits only on its first line | same nudge | `.text-block` is `min-height: 32px` only |
| Frame | toolbar Delete cannot be clicked (Playwright: "the pane intercepts pointer events"); Delete key works | a click on the frame's ground does not pick it from 1.4 px of wobble | the library puts a toolbar at its block's layer + 1: a frame is at -1 so 0, under the pane (1). Picking is `onpaneclick`, which the library drops after more than `paneClickDistance` (1 px) |
| Chart (Insert) | nothing can be changed: numbers, type, colours, title | same | no editor; toolbar is Delete only |
| Checklist | items edit in place; the title cannot be set | same | `label` has no field |
| Diagram (chat) | source and title cannot be changed | same | no editor |
| Chart (chat) | as Chart (Insert) | same | no editor |
| File (chat) | a click opens the file in the panel (by design), so it cannot be selected by a click; nothing else to change | **a click with 1.4 px of wobble does nothing at all: the file does not open** | the flow's d3 drag (`nodeClickDistance` 1) swallows the click that follows any movement |
| App (chat) | click on its body does not select (the App owns its pointer, by design; the header does); title cannot be changed | same | no editor |
| Map (chat) | title cannot be changed | same | `label` has no field |
| Photos (chat) | no title or caption | same click mechanism as the file for the thumbnails (not separately measured) | schema had no caption |
| Web (chat) | Refresh works; title is the query | same | by design |

Wobble probe (production build, one fresh board per amplitude, columns = what happened):

| wobble between press and release | note click selects | frame ground click picks it | file click opens it | note double-click edits |
|---|---|---|---|---|
| none | yes | yes | yes | yes |
| 1 px along x | yes | yes | yes | yes |
| 1.4 px diagonal | yes | NO | NO | yes |
| 2.8 px diagonal | yes | NO | NO | yes |
| 3 px wander | yes (note drifted -1,-3 px) | NO | NO | yes |

## 1. What was fixed, and where (red first with real input)

Red run of the two new specs on the unfixed production build: 12 failed, 3 passed (the 3 are the regression guards
"a real drag still moves a block" x2 and "a live-web block has no Edit": `cvb/red-run.log`). Every failure was checked
to fail for the reason in the table (a missing Edit button, the double-click not reaching, the frame's Delete covered, a
form that does not exist, the wobble). After the fixes: all green on the production build and on the dev server.

1. **A touchpad's click is a click** (`CanvasBoard.svelte`): `nodeClickDistance`, `nodeDragThreshold` and
   `paneClickDistance` = `WOBBLE_PX` (4). Not the wheel or pinch props.
2. **The whole block hears the double-click** (`StickyNode`, `TextNode` CSS: `height: 100%`).
3. **A frame's toolbar is above the pane** (`NodeShell`): the toolbar gets the library's own class plus
   `canvas-toolbar--frame` (`z-index: 6 !important`). Passing only a new class replaced the library's own and the rule
   matched nothing the first time; the unit test now reads the exact string.
4. **A visible Edit button for every block that can be changed** (`NodeShell` `edit` prop, one button before Delete;
   `common.edit`). Sticky, text and frame give it the action their double-click and Enter already run. Enter and F2 as before.
5. **Forms for the blocks that had no way to change** (`nodes/BlockEditForm.svelte`, `_lib/block-edit.ts`, `LazyNode`'s
   `editing`/`onclose`, `LazyShell.editable`): see section 2.
6. **The block being changed is above its neighbours** (`BlockEditForm`'s `:global(.svelte-flow__node:has(.canvas-edit-form))
   { z-index: 12 !important }`). Found only by looking at a screenshot and then with real clicks: a form is taller than a
   plot, the block grows into the block under it, and a neighbour listed later was drawn over Save and Cancel. A new e2e
   case (a checklist right under the chart) was red on the build before this.

## 2. The editors I added, and why these

Edit opens a small form inside the block; nothing is written until Save; Save is ONE `updateNodeData` (so ONE step of the
board's own undo, ruling 16: one Ctrl+Z restores title and source together); Cancel and Escape write nothing; Ctrl/Cmd+Enter
saves; focus goes to the title and comes back to the block.

| block | form | stored in | notes |
|---|---|---|---|
| Chart (Insert or chat) | Title, "Chart data (JSON)" | `label`, `code` | source laid out over lines for editing, kept on the board's one line when plain JSON; must be a config the chat's chart can draw (JSON with a `type` and `data`, with the chat's own lenient repair); empty or past the limit refused by the block's own schema; the problem is said in words (`role="alert"`) and Save is disabled |
| Diagram (chat) | Title, "Diagram source (Mermaid)" | `label`, `code` | any text is accepted (Mermaid's syntax is Mermaid's to judge, as in the chat: it shows the source and a note); schema limits apply |
| Checklist | Title | `label` | items stay edited where they are; the form is in flow above them (the block grows) |
| Map | Title (starts as the route the header shows; an untouched title writes nothing) | `label` | the form lies over the map's top, so the map is not asked to lay out again |
| App | Title | `title` | the form lies over the App (a running frame is not reloaded) |
| Photos | Caption | new optional `label` on `photoDataSchema` (one line in `canvas-blocks.ts`, CV-A's file) | header said only "Photos" |
| File, Web | none, by choice | | a file is a pointer to what the chat holds (a title on the board would misname it; a click opens it); a live-web block is about its query (a new query is a new block, Refresh stays). The toolbar says so by having no Edit button |

The brief's "validated by the same schema": `block-edit.ts` asks `BLOCK_DATA_SCHEMAS[kind].shape.code` for the source and
parses the whole patched block through the schema before the board is asked to take it. Why a form and not a popover or
a separate editor: it is in place (the brief), reuses nothing new in the editor's first paint (the form is the content
module's, loaded with the block), and one component serves six kinds.

Tests: `block-edit.test.ts` (10), `block-edit-form.test.ts` (12), `block-forms.test.ts` (20: LazyNode with the real loaders
for all six kinds, replace/overlay, Save/Cancel/F2/focus), additions to `nodes.test.ts` and `lazy-node.test.ts`,
`lazy-nodes.test.ts`; e2e `artifact-canvas-edit-inserted.spec.ts` (12) and `artifact-canvas-wobble.spec.ts` (4) with the
shared `artifact-canvas-edit-helpers.ts` (seeds a chat that has made one of everything; a "touchpad" `click`/`drag`).

## 3. Reproduction after the fixes (same flows)

Every row of the table passes with real input on the production build (`cvb/green-run-3.log`: 12/12; wobble 4/4; plus
`artifact-canvas-blocks`, `-frames`, `-selection` green on it: 50 passed; one prod-only failure, below). Touchpad: file opens,
frame ground picks, no nudge at 1.4 px and at a 3 px wander; a real drag still moves a block (105 to 125 px of 120).

## 4. Gates (once, at the end, on the final commit)

- `npm run check`: 0 errors, 17 warnings (the 17 pre-existing). My first draft added an a11y warning (a `<form>` with a key
  handler); fixed with an attachment.
- `npx biome check src scripts tests`: clean.
- `npm test`: 1029 files passed, 16,882 tests passed, 2 skipped.
- `npm run build`: 32 `Unused CSS selector` + 2 `must have an ARIA role`, same as base.
- Playwright (all artifact suites + chat + conversation + knowledge, dev server on 5440): **525 passed, 23 skipped, 0 failed** (42 min).
- Fallow: 124 issues, 4 circular (baseline 124 / 4): no new finding.
- `npm run check:migrations`: passes.
- Known and unrelated: on the PRODUCTION build `artifact-canvas-blocks.spec.ts:558` ("fetches the code that places a block...")
  fails because it greps request URLs for `/_lib/placement`, which a hashed production build does not have; it passes on dev.

## 5. Size budgets (`npm run check:artifact-chunks` exits 1, as the brief expected could happen; I moved nothing)

| | base (d89ab5a4, measured here) | mine | budget |
|---|---|---|---|
| editor first paint (exclusive closure) | 71,598 B gzip | **71,921 B (+323)** | ceiling 71,680: **over by 241** |
| editor chunk alone | 63,287 B | 63,611 B (+324) | 65,000 |
| chat route first load | 542,912 B | **543,265 B (+353)** | baseline 540,914 + 2,048 = 542,962: **over by 303** |

Base headroom was 82 B and 50 B. Where the editor's +323 B goes: the Edit button and `edit` prop in `NodeShell`, the
`editing` wiring in `LazyNode`, the three flow props, the frame toolbar class and its rule, two `height: 100%` rules, and
`edit={startEditing}` on three nodes. One avoidable cost was removed on the way: importing `_lib/focus.ts` from the lazy form made
the bundler split it into a chunk of its own inside the editor's first paint (+159 B, a 13th chunk); the form focuses its
title with an attachment instead (chunk count back to 12). The chat route's +353 B is the twelve new strings
(`artifacts.canvas.edit.*`, EN and HU); the canvas code itself is lazy. To re-baseline: ceiling 71,680 to about 71,930, chat
baseline 540,914 to about 541,270.

## 6. Screenshots (looked at each; Hungarian, production build)

`/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/cv-b/`
- `1440-light-hu-chart-form.png`, `1440-dark-hu-chart-form.png`: the chart's form (title, JSON, Mégse, Mentés), toolbar Edit + Delete above.
- `1440-light-hu-chart-error.png`: invalid source: red outline, the message, Mentés disabled, Mégse reachable.
- `1440-light-hu-map-title-form.png`: the title-only form lying over the map, the map still drawn beneath.
- `1440-light-hu-note-toolbar.png`: the note's toolbar: four tones, Edit, Delete.
- `390-light-hu-frame-toolbar.png`, `390-light-hu-chart-form.png`: a phone: the frame's Edit and Delete at 44 px; the chart's form.

What looking found: (1) first the form's buttons were covered by the next block (fixed, section 1.6); (2) the selection
toolbar is cut off when a block's top edge is within about 45 px of the pane's top (not mine, now with an Edit button in it: see
concerns); (3) on a phone a form on a block near the bottom opens with Save and Cancel below the fold (Ctrl+Enter and
Escape work; the reader can pan).

## 7. Concerns and open points

- Both size budgets are over (above); they need the orchestrator's recorded re-baseline (ruling 68, ruling 23-style).
- The selection toolbar (NodeToolbar, library) does not flip when a block is near the pane's top edge: Edit and Delete are clipped.
  Pre-existing for Delete; worth a follow-up in the style of `keepPillInPane` (it costs closure bytes, so not done here).
- A File block cannot be selected by a click (a click opens the file: S3-R1's design); a reader selects it by a marquee, a drag,
  or Tab then Space. A "click selects, double-click opens" change would fix it but changes a tested contract.
- A form near the bottom of a phone's pane opens partly out of view; no camera move is made (a camera move would need a
  `followsPane` decision, TR-D1/D3).
- Shared files with the other two agents: `canvas-blocks.ts` (one line, `label` on `photoDataSchema`), `i18n/artifacts.ts` (my
  block after `block.drawFailed` in EN and HU), `AGENTS.md` (two bullets before "#### Tours"), `CanvasBoard.svelte` (a constant and three
  flow props beside `{nodesDraggable}`; CV-C's wheel/pinch props are on other lines). Textual conflicts, if any, are adjacent-line.
- The wobble amplitude (4 px) is a judgement; the spec drives 1.4 px and a 3 px wander.

## 8. Hand-off

- `NodeShell`: new prop `edit?: () => void` (Edit button before Delete, `data-testid="canvas-node-edit"`); frame toolbar class.
- `LazyShell.editable` (lazy-nodes.ts): a lazy block with a form says so; `LazyNode` owns `editing` and hands the content `editing` and `onclose`.
- `canvas/nodes/BlockEditForm.svelte` (`id`, `kind: EditedKind`, `data`, `onclose`, `overlay`), `canvas/_lib/block-edit.ts`
  (`EditedKind`, `titleFieldOf`, `shownTitle`, `sourceProblem`, `sourceToEdit`, `sourceToKeep`, `editPatch`).
- Test ids: `canvas-edit-form`, `canvas-edit-title`, `canvas-edit-source`, `canvas-edit-save`, `canvas-edit-cancel`, `canvas-edit-error`.
- A new editable lazy kind: export `editable: true` from its shell, accept `editing`/`onclose`, render `<BlockEditForm>` (add the kind to `EditedKind` and `titleFieldOf` if its title is not `label`).
- Strings: `artifacts.canvas.edit.{title,chartSource,diagramSource,error.empty,error.tooLong,error.notChart}`; Edit/Save/Cancel are `common.*`.
- e2e: `artifact-canvas-edit-helpers.ts` (`seedChat`, `openTheBoard`, `insertFromMenu`, `click`/`drag` with a `touchpad` style) is the way to drive a block with a laptop's hand.
