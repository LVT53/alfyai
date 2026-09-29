# S3-B report · the board in the panel (Slice 3 T2's core + T8's chunk guard)

Model: `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-s3b`, branch `feat/artifacts-s3-board`.
Commits `86c6c783..32df4626` (10):

| SHA | What |
|---|---|
| `06b951f8` | the four packages, pinned exactly (package.json + lockfile alone) |
| `fc58e283` | tokens: four sticky fills, map paper, four inks, `--artifact-overlay-z`, with contrast tests |
| `4f3a406a` | block meta + registry, `NodeShell`, the five node components, EN/HU strings |
| `bde18a5b` | `CanvasBoard`, `CanvasToolbar` + `InsertMenu`, `ZoomChip`, `CanvasEditor`, body registration, e2e spec |
| `35e05cbd` | the in-chat card's Canvas branch (server block count + `ArtifactCard` + `ToolActivityRow`) |
| `5af2cc4a` | fixes found by driving it in a browser (focus on insert, frame resize corners, node names, tab order, phone) |
| `d96fd1a5` | `scripts/check-artifact-chunks.mjs` + test, wired into `npm run build` |
| `6cf28025` | e2e for offline / refused / too-big / deleted / the card; a locked board no longer deletes from the keyboard |
| `39d6d984` | export cleanup for Fallow; the test stand-in pinned to the shell |
| `32df4626` | e2e: saved edges are drawn |

No migration, nothing in `services/artifacts/` beyond a read-model preview, nothing in S3-T's or S4-D's files.

## What I built, per step

### Step 1 · dependencies, registry, node shell, note-shaped nodes

- `@xyflow/svelte@1.7.0`, `@xyflow/system@0.0.83`, `perfect-freehand@1.2.3`, `html-to-image@1.11.11`, all `--save-exact`, all MIT (one transitive newcomer, `@svelte-put/shortcut` 4.2.0, MIT). Own `npm ci` first.
- Tokens (`src/app.css` both themes + `tailwind.config.ts`): `--sticky-{yellow,mint,blue,plain}`, `--map-paper`, `--ink-{blue,red,green,graphite}`, `--artifact-overlay-z: 2100`. The contrast test recomputes text-on-fill (4.5:1) for each sticky in both themes, note-stands-off-the-page (1.05:1; the spec's yellow is 1.076:1, so the bar I first wrote at 1.08 was wrong), and each ink on the page (3:1); mutation-checked.
- `canvas/_lib/block-meta.ts` (a leaf: icon, label key, chrome, size, min size, `fixedHeight`, section, `needsPoster`, `structural`, Svelte Flow hints) and `block-registry.ts` (adds the component and the shared schema from `canvas-blocks.ts`, ruling 64). Split in two so nodes read their own icon/label without importing the registry that imports them (a cycle).
- `NodeShell.svelte`: chrome per kind (`frame` / `note` / `bare` / `card`), selection outline, four resize corners and four connection anchors (both only while selected; the anchors are always in the DOM because a stored edge needs a handle), a selection toolbar (Delete, plus what a node adds), the node wrapper's accessible name kept against the library.
- Nodes: `Frame`, `Sticky` (four tones, picked from the selection toolbar), `Text`, `Checklist` (canvas-owned, ticks are saved edits; `chat/Checklist.svelte` untouched and asserted not imported), `Chart` (the chat's `Chart.svelte` with exactly `{code}`), `MissingKindNode` (a known kind with no component yet: header-only card, stays in the body). `InlineTextField` is the shared in-place editor (text overlaid by a textarea so the block is exactly as tall as its words). Every input carries the schema's own limit as `maxlength` (`TEXT_MAX_CHARS` 20,000, `LABEL_MAX_CHARS` 500, checklist 200 x 1,000; exported from `canvas-blocks.ts`).

### Step 2 · the board and the editor

- `CanvasBoard.svelte` (Svelte Flow v1: lowercase events, `onbeforeconnect` stamps the edge id, `snapGrid` not used, selection wrapper `pointer-events: none`), `CanvasToolbar.svelte` (`role="toolbar"`: Select, Pan, Undo, Redo, Insert; compact below 480 px), `InsertMenu.svelte` (roving tabindex over the rows, in the shared `AnchoredPopover`, a sheet on phones), `ZoomChip.svelte`, minimap from 720 px.
- How a change reaches the editor: the board watches `nodes`/`edges`/`annotations`; 350 ms after they stop changing it compares the canonical JSON **without the camera** (`structuralJson`) with the last reported one; a difference is one step (one history entry, one `onchange`). A pan changes only the camera, so it is never a step; the camera rides along with the next real one. Undo/redo (50 steps, `board-history.ts`) reuse the Document's shortcut module (`historyShortcutFor`).
- `CanvasEditor.svelte`: `fetchArtifact` with `conversationId` (ruling 51); states: loading skeleton, unreadable + Retry, no access, dropped-content notice (dismissible), empty; saves through the Document's `createDocumentAutosave` + `saveArtifactBody` with `expectVersion` and `baseHash`; 409/stale -> conflict banner + Reload, the board goes read-only, the reader's steps stay on screen; 404 -> "deleted" state and no further writes; 413 -> "too big" notice; a thrown error -> offline banner, and it saves again on `online`; a refused save -> Retry. `registerPanelActions({ openVersions })` opens the shared `VersionsSheet`. Every version reaches the header through `saveArtifactBody`/`fetchArtifact`'s announcements; nothing here prints a version or an "edited" time.
- Registered: one line in `artifact-bodies.ts`.
- The in-chat card: `ArtifactCardView.blockCount` and one Canvas branch in `ArtifactCard.svelte` ("Canvas · 11 blocks · v7"; EN plural, HU singular); the count is `ArtifactCardSummary.canvasPreview.blockCount`, taken by `read-model.ts` with `normalizeCanvasBody` (so it agrees with the panel); nothing of the board is drawn or loaded in the chat (test asserts the card imports none of it, e2e asserts no `.svelte-flow` in the chat).

### Step 3 · the chunk guard (T8's first half)

`scripts/check-artifact-chunks.mjs` (+ test, 20 cases), `npm run check:artifact-chunks`, appended to `npm run build`.
**Method**: the build's own manifest (`.svelte-kit/output/client/.vite/manifest.json`) is the chunk graph. The lazy target = every manifest entry whose `name`/key/`src` contains `--name` (default `CanvasEditor`). A package is found by fingerprint strings a minifier keeps (`svelte-flow__pane`; `simulatePressure`+`runningLength`; `Failed to clone iframe`), all required in one chunk's JS+CSS. A package is **confined** when every chunk holding it is in the target's static closure and in no other entry's static closure (entries = app entries, every route node - chat and knowledge among them - and every other lazy entry); otherwise `outside` (the editor does not load it) or `leak` (names which entries load it). A package found nowhere is reported "not in this build", never as guarded. No matching target fails loudly. Optional `--max-gzip`, `--allow-entry NAME`. Proven on the real manifest by injecting a static import of the editor into the chat route: it fails and names the route nodes.
Reuse for Slides: `--name SlidesEditor --confine <pkg>`; add the package's fingerprint tuple to `PACKAGE_FINGERPRINTS`.
**Numbers** (final tree): the editor chunk `_app/immutable/chunks/BUOBZB2g2.js` is 193.1 kB raw (JS + its CSS text), **57.2 kB gzip**, all of it its own (1 exclusive chunk), 28 shared; `@xyflow` only in it; `perfect-freehand` and `html-to-image` are in no chunk yet (nothing imports them until S3-F).

## Tests added

~129 vitest cases: registry 14, history 5, model 12, placement 5, nodes/shell 34, chunk guard 20, card 6, chat row 2, read model 5, token contrast 26. Playwright `tests/e2e/artifact-canvas.spec.ts`, 26 cases: opens and paints all kinds + a map as the missing-kind card; empty board; inserts each note-shaped kind and saves (unique positions, reload); Insert menu Escape / outside click / arrow keys; a tick survives a reload (and the map block survives the save); undo/redo from toolbar and keyboard; edit a note in place; drag a block; delete from the toolbar + Undo; Delete key but not in a field; one drag from an anchor = exactly one edge with the board's own id; resize a frame keeps node and data size equal; drag a frame by its chip (children follow); content clear of toolbar and minimap at 1440x900; a bare pan is not a save (no new version row); 409; dropped-content notice; load error + Retry; offline + recover; refused save + Retry, too big, deleted; the chat card; roles/names/tab order/focus ring; Enter on a focused note; saved edges drawn; phone (390): no Pan, 44 px targets, zoom above the toolbar, no minimap.

## Gates (final tree)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (= baseline) |
| `npx biome check src scripts tests` | clean, 2236 files |
| `npm test` | 928 files passed (1 skipped), 14,513 tests passed (2 skipped) (S3-P: 14,386). One earlier full run exited 1 with all tests green: `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`, raised in `chatgpt-import/index.test.ts` (untouched; passes alone; the final full run was clean) |
| `npm run build` | passes; 32 `Unused CSS selector` + 2 `must have an ARIA role` = baseline; `check:artifact-chunks` OK |
| Playwright (5430), every artifact spec + chat + conversation + knowledge | **203 passed**, 0 failed (11.1 min; S3-P: 177) |
| Fallow | **127 issues (baseline 124), 4 circular = baseline.** The +3 are `unused_dependencies`: `@xyflow/system`, `html-to-image`, `perfect-freehand` - installed as briefed, imported by S3-F (pen, frame hit-test) and the PNG export. No unused export, file or type finding. I did not suppress them (a suppression that outlives its reason is worse); see open question 1 |
| `npm run check:migrations` | passes unchanged |

## Screenshots (`.../scratchpad/w3/shots/s3b/`, Hungarian, not committed)

`01-board-hu-1440-light.png` (all five kinds + the missing-kind card, fitted on open), `02-board-hu-1440-dark.png` (dark, selected note: outline, four corners, four anchors, toolbar with tones and Delete), `03-insert-menu-hu-1440-light.png`, `04-board-hu-390-light.png`, `05-card-chat-hu-1440-light.png` (the in-chat card, panel closed), `06-empty-hu-1440-light.png`, `08-insert-hu-390-light.png` (Insert sheet on a phone). I looked at each against the mockup (types §1, surfaces §2-3). What looking (and the e2e) found, all fixed: the missing-kind card had an empty body strip under its header (now header-only); the zoom chip sat under the toolbar at 390 (now above it); my first "dark" shot was not dark (the server preference wins over localStorage; script issue, redone); a just-inserted note could not take focus (Svelte Flow draws a node hidden until measured; `focusWhenShown` retries); a frame's resize corners were dead (its wrapper ignores the pointer and that is inherited); the library rewrote the node wrapper's aria-label away (kept with a MutationObserver); the toolbar was after the blocks in tab order (moved first in the DOM, painted above by z-index).
Not a defect but visible: on a phone the fitted board is small (46 %); the shared card wraps "v1" onto a second line beside "Megnyitva a panelen" in a narrow chat column, like the Document card does.

## Deviations from the spec / brief, and why

1. **The prototype branch `proto/artifact-canvas` does not exist** in this repository (no ref, tag or reflog entry). Built from the spec's pointers, the findings doc, and Svelte Flow v1's installed types and source.
2. **Conflict string**: the brief says "the shared conflict string" (`artifacts.document.versions.conflict`), which reads "This document changed elsewhere". I used the spec's failure-mode string for a board, `artifacts.canvas.saveConflict` (+ Reload). One-line swap if the owner prefers.
3. **Deleted-while-open** says "This board was deleted." without a Close button: `ArtifactBodyProps` has no close callback and ruling 10 says not to edit the panel; the header's X closes. **Load 404** shows `noAccess`.
4. **Registry**: `component` is the Svelte Flow node component (`NodeProps`), not the spec's `{data, selected, dark}` body (`dark` is unneeded: CSS tokens); the table is `Partial<Record<BlockKind, …>>` until S3-R. `structural` is true for the frame only (the field's own doc: "must not be a frame child"; the test-list line "frame, sticky and text as structural" contradicts it; a note is the commonest frame child).
5. **Insert menu**: the mockup's Calendar row is not a kind in the spec; the menu lists what is registered. The shared `AnchoredPopover` puts initial focus on its close button, hands focus back to Insert on Escape and on a pick, and leaves focus where the reader clicked on an outside click (I assert exactly that; the brief's "returns focus" holds for Escape).
6. **390 px toolbar**: Select, Undo, Redo, Insert (spec: Select / Insert / Ask Alfy): Ask Alfy is not built, a phone needs Undo, and a finger already pans so Pan goes.
7. **Additions**: sticky tone swatches and a per-block selection toolbar with Delete (the only way to delete on a phone; Alfy can make four tones, so a reader must be able to pick one).
8. **Card**: a server-side `canvasPreview.blockCount` (the brief says "one branch in `ArtifactCard`"; a count needs data). The panel's list rows are unchanged (still "Canvas · v1"): extending them is three one-liners (`+page.svelte:1148`'s mapping, `DocumentWorkspaceItem`, `artifactCardViewFor`) that I left out to stay off the chat page.
9. **Nested frames** (allowed by the protocol): a frame is top-level in the UI (`structural`); a nested one from the protocol renders inside its parent (not exercised visually).
10. Chart Insert gives a small sample bar chart (legend off): `code` is required and a reader has no way to write one yet. The library's "Svelte Flow" attribution is kept (bottom-left).

## Open questions

1. **Fallow +3 unused dependencies** until S3-F/PNG import them. Options: accept (self-resolving at S3-F's merge); add them to `.fallowrc.json` `ignoreDependencies` for now; or pin `@xyflow/system` through `overrides` (as the repo does for esbuild) instead of a top-level dependency.
2. The header's generic Download link (no body-registered `openDownload`) downloads the raw board JSON from `/api/knowledge/{id}/download` (200 text/plain) until the PNG export registers its own. Hide it for Canvas meanwhile?
3. **Observed, not touched, unverified as a bug**: in my screenshot script, opening a second conversation in the same tab after a reload showed the first conversation's board in the panel (the panel's open item seems remembered across conversations in the tab). Each e2e case uses a fresh context, so no test sees it. Worth a look for incognito.
4. The spec's 65 kB gzip budget: 57.2 kB measured, 7.8 kB headroom for S3-F/C/A/R (perfect-freehand and html-to-image not in the build yet). `--max-gzip 65000` enforces it; I left it off the build script so the next agent is not surprised.
5. `AGENTS.md`'s Artifacts section needs a paragraph when Canvas ships (I did not touch it): `canvas/` layout, the "board hands over whole steps, camera excluded" rule, the chunk guard, `canvasPreview`.

## Hand-off

### Registry (`src/lib/components/artifacts/canvas/_lib/`)
- `block-meta.ts`: `BLOCK_META` (kind, icon, labelKey, chrome, size, minSize, fixedHeight, section, needsPoster, structural?, flow? {zIndex, dragHandle, style}), `RegisteredKind`, `metaFor(kind)` (falls back to the missing-kind meta). `block-registry.ts`: `BLOCK_REGISTRY`, `BlockRegistryEntry = BlockMeta & {kind, component, schema}`, `blockEntry`, `insertableEntries()` (its `INSERT_ORDER` already names all ten kinds), `boardNodeTypes()` (every kind -> component or `MissingKindNode`), `defaultDataFor`, `newBlockNode`.
- **Adding a kind (S3-R)**: a `BLOCK_META` row (`needsPoster: true` for map/app/photo/liveweb; `flow` hints if any); a node in `nodes/` composing `NodeShell` (props: `id kind selected minWidth minHeight summary title meta tone activate`, snippets `header toolbar children`; reuse the chat component with only the props the chat passes); a registry row; a `defaultDataFor` case or, for kinds whose data comes from a chooser (file, photos, app, live web, map), an optional async `pick` on the entry and one branch in `CanvasBoard.insertBlock` (its only creation path). The stub `_test/xyflow-mock.ts` has a test that fails if a node imports a name from `@xyflow/svelte` the stub lacks.
- Nodes reach the board through `board-context.ts`: `useBoardContext()` -> `{ readonly, requestEdit, takeEditRequest }`. A node changes its data with `useSvelteFlow().updateNodeData`; the board notices.

### `CanvasBoard`
Props `{ body: CanvasBody /* read once; a different body = a new mount */, readonly?, onchange(body) /* one step, camera included, never a bare pan */, oncamera?(viewport) /* in memory only */ }`; export `flush(): CanvasBody`. It must sit under `<SvelteFlowProvider>` (the editor does that inside a `{#key boardKey}`). State: `nodes`, `edges`, `viewport`, `annotations` (`$state.raw`), `tool: BoardTool`, the 50-step history, `SETTLE_MS` 350.
**The rule that makes plugging in cheap**: anything that changes `nodes`, `edges` or `annotations` is a step automatically (the observer); call `commit()` for an immediate one. Alfy's landings must NOT push the reader's history: set `committedJson` directly (see `restore()`), since Alfy's change is a version, not a step (ruling 16).
- **S3-F**: frames' reparenting = an `onnodedragstop` handler on `<SvelteFlow>` (lowercase!) rewriting `parentId`/`position` in `nodes` (use `blockEntry(kind).structural` to refuse nesting; `toFlowNodes` copies each kind's `flow` hints; a frame's size is kept equal on the node and in its data by `bodyOfState`). Connectors: `NodeShell`'s `ANCHORS` (bottom/right sources, top/left targets), the board is `ConnectionMode.Loose`, `handleBeforeConnect` stamps the id (one drag = one edge, tested); **stored edges carry no handle ids, so after a reload an edge runs bottom -> top whichever side it was drawn from**: your call whether to add a floating edge type. Drawing: a `<ViewportPortal target="front">` child of `<SvelteFlow>` after `<Background>` (explicit `z-index: 2`, sized from the visible pane); extend `BoardTool` (in `CanvasToolbar.svelte`) and the derived `panOnDrag`/`selectionOnDrag`/`nodesDraggable`; the toolbar is one flex row (`compact` prop for phones); `annotations` are already carried, saved and undone.
- **S3-C**: pins in a second `ViewportPortal` (z-index 2), open card in screen space. The editor loads `fetchArtifact().comments` (already returned) and would add `onCommentCountChange` / `onCommentsShownChange` to its `Props` and `toggleComments` to `registerPanelActions`. Node/point anchors resolve against the board's `nodes`.
- **S3-A**: add `alfyActivity` to `CanvasEditor`'s `Props`; landing = replace `nodes`/`edges` in the board (a new exported method) and tween with `moveOps`/`structuralOps`; the `CanvasNode.highlight` field exists but `NodeShell` does not render it yet; the `ReviewBar` mounts at the bottom of the board (inside `CanvasEditor`'s overlay area or the board). The review read side (ruling 63) is unchanged from S3-P's note.
- **S3-R**: see "Adding a kind". `InsertMenu` groups by `section`; text before blocks.

### Editor seams
`CanvasEditor.load()` (fetch, normalise, `boardKey`), `handleBoardChange` (-> `createDocumentAutosave`), `handleSaveResult` (the state machine: idle/saving/saved/offline/failed/conflict/deleted/tooLarge), notices region (`.canvas-editor__notices`), Versions via `registerPanelActions`. Download joins with the PNG export: register `openDownload`.

### Numbers
CanvasEditor chunk 193.1 kB raw / 57.2 kB gzip, 1 exclusive chunk + 28 shared; guard: `npm run check:artifact-chunks` (also in `npm run build`).
