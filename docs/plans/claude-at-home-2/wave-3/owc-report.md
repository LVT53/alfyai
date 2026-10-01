# OW-C report · every chart the chat draws is drawn on the board

Agent model ID: `claude-sonnet-5-5`. Worktree `art-owc`, branch `fix/canvas-owner-walk-charts`, e2e port 5620.
Commits `5a614d95..HEAD` (`git log --oneline 5a614d95..HEAD`):

| commit | what |
|---|---|
| `fe58f8ad` | Canvas: a Mermaid diagram the chat drew is a block a board can hold |
| `359dfcd3` | Mermaid draws in the reader's theme, in the chat and on a board |
| `cfeca08a` | "From this chat" reads a chart's config the way the chat does |
| `1bf3eff0` | A chart picked from the chat is placed in the room its plot takes |
| `cdc9aa93` | Hold Mermaid out of the editor's first paint, and re-baseline the chat route |
| `17702040` | A diagram is given room for a typical drawing when it is placed |
| `e9c291e9` | e2e: every chart and diagram the chat draws is drawn on the board |
| `092d4394` | AGENTS.md: the board holds the chat's charts and diagrams |
| `f6ede881` | The browser's listing answer carries the diagrams group too |

## Verdict in one paragraph

The owner's sentence is true of exactly one family: **the chat's other picture, the ` ```mermaid ` fence** (flowchart, sequence,
class, state, ER, Gantt, pie, ...). The board had no block for it and "From this chat" did not list it, so none of it "loaded
inside the canvases". Every **Chart.js** chart the chat draws already drew on the board, measured, not assumed (a pixel check
of the colours each chart asks for, on the dev server **and on a production build**, and with what the production model really
writes): the board's chart block renders the chat's own `Chart.svelte` unchanged, whose one lazy `import("chart.js/auto")`
registers every controller, scale and plugin, so there was no registration the board's lazy path missed, no fence the listing
skipped and no `code` shape the node narrowed. I built the missing block (small: it is the pattern the file/App/map blocks
already follow) and fixed three real defects found on the way: a chart the chat repairs was offered as a bare "Chart"; round
charts were placed in a bar chart's room and lay over their neighbours; Mermaid was unreadable on a dark page, in the chat as
much as on the board. `csv` fences (a table, the chat's third diagram fence) are not built: see Open questions.

## 1. Inventory, with evidence

"Before" is the code at `5a614d95` (what ai.dev runs plus docs). Evidence is the new e2e `tests/e2e/artifact-canvas-charts.spec.ts`
run against that code on a **production build** (`node build`, port 5621) and on the dev server, and a scratch run with what the
production model (`qwen3-6-27b` through the alfyroot tunnel, the chat's own chart/diagram instructions) wrote for 16 prompts.

| What the chat draws | "From this chat" offered it (before) | Board drew it (before) | After | Cause |
|---|---|---|---|---|
| Chart.js `bar`, `line`, `pie`, `doughnut`, `radar`, `polarArea`, `scatter`, `bubble` | yes | **yes** (prod build and dev: each colour the config asks for is on the canvas, before and after a reload) | yes / yes | none. `ChartNode` = the chat's `Chart.svelte`, props `{ code }` only; Chart.js is `chart.js/auto` in both |
| Chart.js mixed (a `bar` with a `line` dataset) | yes | **yes** | yes / yes | none |
| The same as the production model writes them: pretty-printed, no colours (Chart.js's colours plugin supplies them), Chart.js 2's `options.title` (ignored by v4), a tooltip callback as a *string*, filled lines (`tension`, `fill`) | yes | **yes** (all 11 real outputs painted the same palette on the chat canvas and the board canvas) | yes / yes | none |
| A chart the chat rescues from text art: a bar-column table, an ASCII `█` fence | yes (the listing reads replies with the chat's own `classifyMarkdownBlocks`) | **yes** | yes / yes | none |
| A chart config **one closing brace short** (the local model's classic defect; the chat reads it with `parseJsonLenient`) | yes, but as a bare "Chart" with no title | drawn whole | named by its title and type | the listing's `chartFacts` used strict `JSON.parse`; the chat's chart is lenient. Fixed (`cfeca08a`) |
| Mermaid: flowchart, sequence, class, state, ER, Gantt, pie | **no** | **no** (no block kind) | **yes / yes** | no `mermaid` block kind and no listing. Built (`fe58f8ad`) |
| `csv` fence (a table) | no | no | no | not a chart; no block kind. Not built (Open questions) |
| Map route (`map_route`) | yes | yes | yes / yes | existing block |
| GFM checklist, table, callout, accordion, code | n/a: not charts or diagrams | | | |

How the Mermaid gap was shown: a chat holding four real model diagrams (flowchart, sequence, class, state), a `csv` fence and
one bar chart drew all four diagrams in its own message (`.markdown-mermaid svg` x 4) while the Insert menu's "From this chat"
listed **only** "Charts: Bar chart". The e2e then failed 8 of its 8 diagram/listing cases on the production build (red first).

The Chart.js types had no red to start from: they passed on the first run. I kept the e2e for them (nine types, four
model-written configs, two rescues) as the regression guard the owner's sentence asks for, and made it check the thing's own
rendered state: a failed chart still leaves a blank `<canvas>`, so "a canvas is visible" (what the S3-R1 chart case asserted)
cannot catch the defect the owner described.

## 2. What changed, by step

**Step A: the diagram block (`fe58f8ad`).** A new block kind `mermaid`, declared once in `shared/artifacts/canvas-blocks.ts`
(`{ kind, label?, subtitle?, code }`, source capped at 50,000 characters, default width 480). Ruling 64: it is **not** in
`MODEL_CREATABLE_KINDS` (an `add_node` of one is refused `unknown_kind`, the refusal still names the five kinds); ruling 67: on one
that exists `update_node` may change `label` and `subtitle`, never `code`. Registry: a `BLOCK_META` row (Lucide `Workflow`,
card chrome, `section: "chat"`, `needsPoster: false`: the export's clone carries an inline SVG, held by an export e2e), a
registry row with `LazyNode`, `nodes/MermaidNode.svelte` (content = the chat's `Mermaid.svelte` given exactly the chat's `code`
and no other prop, plus `mermaidShell`), one loader in `_lib/lazy-nodes.ts`. So the editor's first paint pays nothing for
Mermaid (the editor's closure grew 0.3 kB gzip for the row, loader and schema). Listing: `services/artifacts/chat-blocks.ts`
reads each reply once for charts and diagrams, every closed ` ```mermaid ` fence becomes a `ChatMermaidBlock` (`diagrams` in the
listing, newest first, 12 at most, deduplicated, each checked against the block's schema), named by its own title (frontmatter
`title:`, a `title ...` line, `pie title ...`), else its kind; `chat-block-data.ts` shows a "Diagrams / Ábrák" group after the
charts. Strings (EN + HU, own block in `i18n/artifacts.ts`): the group, the kind label, eight diagram-type names.
Exhaustive switches extended: `canvas-model.ts labelOf`, `comments.ts nodeWords`.

**Step B: Mermaid in the reader's theme (`359dfcd3`).** Seen in my own dark screenshot: Mermaid's default theme inks lines,
arrows and labels dark, so on a dark page a flowchart lost its arrows, a sequence diagram its messages, a pie its title and
legend, in the chat's own copy as much as on the board. The shared `Mermaid.svelte` now initialises Mermaid with the reader's
theme before each render and draws again when it changes. Mermaid builds its site config from defaults plus what `initialize`
is given, so every call states the **whole** strict posture (strict security level, no HTML labels): a call naming only the
theme would have quietly given back the labels the SVG sanitiser gate is built around (a unit test pins the exact object).
`stores/theme.ts isDark` no longer throws where there is no `matchMedia` (a DOM test environment).

**Step C: a chart the chat repairs (`cfeca08a`).** `chartFacts` reads the config with `parseJsonLenient`, the chat's own reader.

**Step D: chart placement (`1bf3eff0`).** Found by looking at my own proof screenshot: a board of all nine chart types had
pies laid over line charts. Placement leaves room for a block from one number per kind (the chart row says 360 x 250, a bar
chart's), but a pie, doughnut, polar area or radar chart is square (about 400 tall). A new `insertSize(row, data)` beside the
registry gives placement `estimatedNodeSize` (the estimate the model reads and the eval measures by) for a chart;
`CanvasToolbar.pick` hands the board a row carrying it. Red first: the e2e failed with "Bar: sales by fruit lies over Pie: share by fruit".
`CanvasBoard` is untouched (OW-1's).

**Step E: the size gate (`cdc9aa93`).** `check:artifact-chunks` now `--forbid mermaid` (a fingerprint for Mermaid's core in the
script and its test), so a change that pulls Mermaid into what opening a board downloads fails the gate. The chat route's baseline
moves by its measured delta, for a recorded reason: **537,215 -> 538,327 bytes gzip (+1,112) on this machine**, measured by building
the commit before mine in a throwaway worktree of my own (removed again): +463 from the diagram strings in the dictionary the
chat loads (compared chunk by chunk), the rest from the shared Mermaid component itself: its theme code, and its now being a
chunk of its own, shared with the diagram block's lazy content (Chart.js's component already is, for the chart block). Baseline 535,771 -> 536,883: the route keeps exactly the headroom it had (+1,444 of 2,048 before
and after; this machine already measured the pre-change code at +1,444 over the recorded number).

**Step F: diagram placement room (`17702040`).** A diagram stores no height; placement reads `size.height`: 320 -> 420 (a Gantt
chart is about 100, a flowchart, state diagram or pie 330 to 450 at 480 wide).

**Step G: tests (`e9c291e9`, others in each step).** See section 3.

**Step H: docs.** `AGENTS.md` (Canvas section: what a board draws of what the chat draws, the model's limits on a diagram,
Mermaid in the size gate, that a `csv` fence has no block).

## 3. Tests added

- `tests/e2e/artifact-canvas-charts.spec.ts` (new, 25 cases + 6 gated screenshot cases): nine Chart.js types, four model-written
  configs, one config a brace short (name and geometry), two rescued charts, seven Mermaid diagrams (each: drawn in the chat
  first, offered, picked, drawn on the board, saved with its exact source, drawn again after a reload), "no two charts lie over
  one another", and the menu's headings and order. Charts are held to their own colours on the canvas; diagrams to the source's
  words in an SVG, with no source `<pre>` and no error note.
- `tests/e2e/artifact-canvas-export.spec.ts`: one case, the exported PNG contains the diagram itself (Mermaid's box fill, by the
  hundred of pixels), no card standing in for it.
- Vitest: shared schema and kind list (`canvas-blocks.test.ts`, the sample board now holds a diagram), ops (`board-ops.test.ts`:
  `add_node` refused, `update_node` label yes / code no, move and remove), server listing (`chat-blocks.test.ts`: 11 new cases:
  kinds, titles, dedupe, caps, scan window, the charts' share filling up first, a repaired chart, a non-chart), client groups and
  names in both languages (`chat-block-data.test.ts`, `ChatBlocksSection.test.ts`), registry/loaders/lazy-source rules
  (`block-registry.test.ts`, `lazy-nodes.test.ts`, `lazy-node.test.ts`), the node (`nodes.test.ts` with `_test/StubMermaid.svelte`),
  `insertSize` and the toolbar's hand-over (`block-registry.test.ts`, `CanvasToolbar.test.ts`), the theme and the strict posture
  (`Mermaid.test.ts`), the guard's Mermaid fingerprint (`check-artifact-chunks.test.ts`), the client's listing default.

## 4. Gates

Run once at the end, on the final tree (HEAD `f6ede881`, clean):

1. `npm run check`: **0 errors, 17 warnings** (the pre-existing ones: `ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1).
2. `npx biome check src scripts tests`: clean, 2,427 files.
3. `npm test`: **994 files passed, 1 skipped; 15,893 tests passed, 2 skipped**, exit 0. (A first full run had two failures in
   `client/api/artifacts.test.ts`, the listing default needing `diagrams`; fixed in `f6ede881`, then run again in full.)
4. `npm run build`: exit 0, **32** `Unused CSS selector` and **2** `must have an ARIA role` lines (the baseline), nothing new.
   **`npm run check:artifact-chunks`, its own step on that build: exit 0.** Editor first paint: 201.4 kB raw / 60.2 kB gzip
   chunk, **68.0 kB gzip** with its own 11 chunks (ceiling 69,632 B; base 67.7); Chart.js, MapLibre and **Mermaid** are not in it;
   chat route **538,323 B gzip, +1,440 against the new baseline 536,883** (2,048 allowed). Measured on the same machine, the
   commit before mine is 537,215 (+1,444 against the old 535,771): see Step E for why the baseline moved by +1,112.
5. Playwright, once, `E2E_PORT=5620`, a cold server, `artifact*.spec.ts artifacts-*.spec.ts knowledge chat conversation`:
   **380 passed, 22 skipped (the gated screenshot cases), 0 failed**, 29.7 min.
6. `npx fallow --no-cache --format json --quiet --score`: **124 issues, 4 circular**, identical to the baseline; **zero** new findings.
7. `npm run check:migrations`: passes (no migration, none needed).

## 5. Screenshots (looked at, in `.../scratchpad/w3/shots/owc/`, not committed)

Hungarian, taken by the gated cases of `artifact-canvas-charts.spec.ts` (`OWC_SHOTS=<dir>`):

- `1440-light-charts.png`: all nine Chart.js types inserted from the chat, side by side. Every plot is whole and legible, none over
  another (this is the picture that showed the placement defect of step D, before the fix: pies lay over the line chart). The
  selection's own floating pill covers the top of the radar card; that is the selected block's pill, not a defect of the block.
- `1440-light-all.png`: the same board with seven diagrams added (flowchart, sequence, class, state, ER, Gantt "Release plan",
  pie "Pets adopted"): all drawn, no block over another, headers "Ábra" or the diagram's own title.
- `1440-dark-charts.png`, `1440-dark-all.png`: dark. After step B the diagrams are readable (light ink for arrows, labels and
  messages; before it the arrows and message texts were invisible). Observed, not changed: Chart.js's default axis and legend ink
  is a dark grey that is faint on a dark card (the chat's charts have it too), and Mermaid's own dark palette draws a pie's
  slices very dark (labels and legend are legible, the slices are low contrast).
- `1440-light-insert-menu.png`: "Ebből a beszélgetésből" with the new "Diagramok" (charts) and "Ábrák" (diagrams) groups, the
  diagrams named by title ("Release plan") or kind ("Szekvenciadiagram", "Folyamatábra"), newest first.
- `390-light-board.png`: a phone, a doughnut, a flowchart and a state diagram on one board, fitted; no overlap. The board's zoom
  control covers the flowchart's last row (existing control, not mine).
- `export-diagram.png`: the PNG the board's Download kept: the diagram is in it, with its text, beside a note.

## 6. Deviations, observations, open questions

**Deviations from the brief**
- *Red first* holds for the Mermaid cases (8 of 8 e2e cases failed on a production build before the block existed), the placement
  case (failed with "Bar: sales by fruit lies over Pie: share by fruit") and the repaired-chart case (the pick by title timed out:
  the row was a bare "Chart"). It cannot hold for the nine Chart.js types: they passed on their first run, and that is the
  finding. The unit tests for the new block were written after its code, behind the failing e2e.
- I changed two shared things beyond the board: the chat's `Mermaid.svelte` (theme) and `stores/theme.ts` (`matchMedia` guard),
  and `scripts/check-artifact-chunks.mjs` plus `package.json` (the Mermaid fingerprint, the re-baselined chat route). Each has its
  own commit and message. Both callers of `Mermaid.svelte` are covered (its unit test, the node test, the e2e).
- `AGENTS.md` edited (three sentences in the Canvas bullets). `docs/plans/**` untouched.
- `CanvasToolbar.svelte` has a one-line change in `pick()` and an import: OW-1's territory is adjacent (the toolbar's undo
  buttons), but its hunks are elsewhere in that file. `CanvasBoard`, `NodeShell`, `FrameNode`, the pills and undo are untouched.

**Observations**
- A block's content loads lazily and the board learns its real height only once it has drawn, so two inserts in quick
  succession (the second before the first has drawn) can still lay one over the other: the first is measured as its loading
  stand-in. A chart's height is now estimated from its data (and the e2e waits for a block to draw before the next pick), but a
  diagram's height is only a typical room (420). A stand-in in `LazyNode` that reserves the estimated room would close it; that is
  NodeShell/LazyNode ground next to OW-1, so not done.
- `chartAspectRatio` (shared, in the editor's first-paint closure) still reads the config strictly. For a config the chat
  repairs it takes the 2:1 default, but the plot ends up whole anyway (measured: the box grows with its content). Using
  `parseJsonLenient` there would add a module to the editor's closure for no visible gain.
- The model's own path (Alfy adding a chart block with `add_node`) was not part of the owner's sentence and is unchanged; ruling 64
  holds: it may add `chart`, never `mermaid`.

**Open questions for the orchestrator**
1. **`csv`**, the chat's third diagram fence (a table; `CsvTable.svelte`). Not built: it is a table, not a chart, and the brief said
   build only what is small and clearly asked for. Design if wanted: a `csv` kind, `{ kind, label?, code }` capped like a chart,
   a `BLOCK_META` row (Lucide `Table2`, `needsPoster: false`), `nodes/CsvNode.svelte` (the chat's `CsvTable` given `code` only), one
   loader, a `tables` group in the listing and the menu, strings, an e2e; the same file list as `fe58f8ad`, about 150 lines and
   its tests, about +0.3 kB on the chat route.
2. **The re-baseline** (+1,112 B, step E) is my call within "re-baseline on purpose, with a recorded reason"; revert `package.json`'s
   `--chat-baseline` if you would rather spend the headroom otherwise (then the gate fails on this machine by 508 B).
3. **Chart.js ink on a dark page** (the library's default grey, in the chat and on the board): a six-line fix in the shared
   `Chart.svelte` (defaults by theme), as I did for Mermaid. Not done: contrast, not the owner's sentence.
4. Should Alfy be allowed to add a `mermaid` block (ruling 64 says only `chart` among data blocks)? Today it may not, and may
   only name one.

## 7. Hand-off

Modules, exports, test ids, for whoever builds the next block kind (follow `fe58f8ad`'s file list):
- `shared/artifacts/canvas-blocks.ts`: `mermaid` in `BLOCK_DATA_SCHEMAS` (so in `BLOCK_KINDS`, `BlockKind`, `CanvasBlockData`),
  `KIND_WIDTHS.mermaid` (480), `APP_OWNED_UPDATABLE_FIELDS.mermaid` (`label`, `subtitle`); not in `MODEL_CREATABLE_*`.
- `shared/artifacts/chat-blocks.ts`: `ChatMermaidBlock` (`key`, `at`, `title`, `diagramType`, `data`), `CanvasChatBlocks.diagrams`,
  `emptyChatBlocks()` carries it; the browser's `fetchCanvasChatBlocks` defaults it to `[]`.
- `services/artifacts/chat-blocks.ts` (internal): `mermaidFacts`, `blocksIn` (one reading of a reply for charts and diagrams),
  `diagramsIn`; `chartFacts` reads leniently.
- `canvas/_lib/block-meta.ts` (`mermaid` row, `size` 480 x 420 for placement only), `block-registry.ts` (`insertSize(row, data?)`,
  `defaultDataFor` returns `null` for `mermaid`), `lazy-nodes.ts` (loader), `nodes/MermaidNode.svelte` (`default`, `mermaidShell`),
  `chat-blocks/chat-block-data.ts` (`ChatBlockKind` has `"mermaid"`, `DIAGRAM_TYPE_KEYS`), `CanvasToolbar.svelte` (`pick` gives
  placement `insertSize`).
- Test ids and hooks: `[data-testid="canvas-mermaid"]` (the block's content), `[data-testid="canvas-node"][data-kind="mermaid"]`, the
  menu group names "Diagrams" / "Ábrák" and "Charts" / "Diagramok"; `canvas/_test/StubMermaid.svelte` (a stand-in recording the
  props the board gives the chat's component).
- i18n (own lines in `i18n/artifacts.ts`, after `chat.chartType.other`): `artifacts.canvas.insert.mermaid`,
  `artifacts.canvas.chat.diagrams`, `artifacts.canvas.chat.diagramType.{flowchart,sequence,class,state,er,gantt,pie,other}`.
- Size gate: `PACKAGE_FINGERPRINTS.mermaid`, `--forbid mermaid`, `--chat-baseline 536883` (`package.json`).
- E2E: `tests/e2e/artifact-canvas-charts.spec.ts` (`CHART_TYPES`, `MODEL_WRITTEN`, `RESCUED`, `DIAGRAMS` tables; `expectPainted`
  counts a canvas's pixels of the colours a config asks for; `expectDiagramDrawn`; `OWC_SHOTS` gates the screenshots);
  a case in `artifact-canvas-export.spec.ts`.
- Files other agents may also touch, for the merge: `i18n/artifacts.ts` (a block after `chartType.other` in each language),
  `CanvasToolbar.svelte` / `CanvasToolbar.test.ts` (`pick`; a describe and imports appended), `block-meta.ts`, `block-registry.ts`,
  `AGENTS.md` (three sentences), `package.json` (the `check:artifact-chunks` line).
