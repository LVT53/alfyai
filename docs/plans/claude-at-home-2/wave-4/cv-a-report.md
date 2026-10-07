# CV-A report: Alfy draws the chat's diagrams on a board, and puts what it adds where a person would

Branch `feat/canvas-alfy-blocks` (worktree `art-cva`), from `feat/artifacts` d89ab5a4. Model: Sonnet 5.5 (`claude-sonnet-5-5`).
Commits `d89ab5a4..510623c7`, ten of them (oldest first):

| commit | what |
|---|---|
| 531c8391 | `mermaid-size.ts`: estimate how tall a diagram is drawn, from its source |
| c23c79b2 | `board-placement.ts`: the deterministic placer |
| d20d0c7a | the diagram kind for Alfy, the placer in the judge, `position` optional, `near`, model-facing text EN/HU, ceilings moved, snapshots |
| 2e293ac3 | estimate re-grounded on the board's own drawing (the card counted); a frame that grows keeps a 12-unit clearance |
| 0bc8a1c0 | e2e `artifact-canvas-alfy-blocks.spec.ts` (5 cases, measured on what is drawn) |
| 6ec8ac06 | `placed` list in the edit tool's answer; the `type` field says what a mermaid block is |
| 4cce0892 | a chart's config may be an object; diagram labels need fewer quotes |
| e0418603 | the canvas eval: six new cases (en + hu), the Mermaid-parse evaluator, rubric corrections, recorded set, README |
| 7ca4b3f9 | the diagram work kept out of the editor's first paint (size gate) |
| 510623c7 | AGENTS.md; a test that the advertised schema takes the new op shapes |

## What was built

**Ruling 74, the diagram.** The block kind is `mermaid` (UI: "Diagram" / "Abra"); the owner's word "diagram" is the user-facing name. It is the 6th kind `add_node`/`add_frame` make, and `update_node` may change every field of it, its source included. The block's schema is the stored one the reader's Insert uses; the model's variant is the same schema made strict with one sentence on `code`. It is drawn by `canvas/nodes/MermaidNode.svelte`, which already gives `Mermaid.svelte` the source and nothing else.

*The chat's security settings, checked.* `Mermaid.svelte` initialises Mermaid with `securityLevel: "strict"`, `htmlLabels: false`, `flowchart.htmlLabels: false`, and passes the SVG through `sanitizeHtml({svg: true, ...})` (DOMPurify SVG profile, the CSS `url()`/`@import` scrubber). I probed Mermaid 11.17 under that posture with hostile sources:

- an `%%{init: {...htmlLabels:true}}%%` directive does flip labels to HTML, but the `<foreignObject>`/`<img>` it produces is removed by the sanitizer (verified with `sanitizeHtml`);
- `click B href "https://..."` renders an `<a xlink:href>` that **survives the gate** (a link inside the picture);
- an image shape `A@{ img: "https://attacker.example/x.png", ... }` makes **Mermaid itself request the URL while rendering, before any sanitizer runs** (confirmed with a request log; the render then fails with "source image cannot be decoded").

Both are already true of the chat today (a ` ```mermaid ` fence in a reply), so I did not touch `Mermaid.svelte`/`html-sanitizer.ts` (not my files, and they change the chat). What changes with this work is that Alfy can now write such a source straight onto a board, which keeps it and draws it on every open. Ruling 67's reasoning therefore applies at the model's door: `mermaidSourceProblem` (`canvas-model-blocks.ts`) refuses an add or an `update_node` whose source contains an image/icon shape, a `click` line, a `%%{ }%%` directive or an `http(s)://` address, naming what to remove. What the reader inserts from the chat is not judged. **Recommendation for you (concern 1):** a source pre-check in `Mermaid.svelte` (or a request block) would close the chat's own path.

**The placer.** `shared/artifacts/board-placement.ts` (`placeBlock`), pure and deterministic, called from the judge in `board-ops.ts`, so create (`parseCanvasCreateBody`), edit and `@Alfy` all get it, and so does the panel's ops route. The judge settles each add once, against the board as the earlier accepted ops left it; the op that lands names a place and a frame and no `near`; `applyOp` stays a plain application plus one geometric rule (a block added inside a frame it sticks out of makes the frame grow a margin past it).

- `position` is optional on `add_node` and `add_frame`; `near` (a block's id) is new; create bodies take both. The brief's `in` is `parentId` with the position left out (no second field for one idea).
- A place the model gives is kept when free (no more than a pixel shared with a neighbour, inside its frame); otherwise moved to the nearest free ground, 24 clear of what is there.
- A place left out is found beside `near` (right, else under, else nearest free ground, in the same frame), in the next free slot of the `parentId` frame (across, then the next row; first block at 20,56), or on free ground nearest what the reader is looking at (the camera the board was saved with, assumed 900x600 pane, else the middle of the content; an empty board gets 40,40).
- A frame with no room grows down or right when the strip it claims is 12 clear of its neighbours (and inside its own parent frame); otherwise the block goes beside the frame and the answer says so.
- A block whose middle is over a frame it was not made a child of becomes the child (what a reader's drop does). A new frame is never adopted.
- `move` is deliberately not settled (an arrangement moves blocks around each other, one at a time).
- The edit tool's answer now carries `placed: [{id, x, y, in?, note?}]` for blocks the app had a hand in (moved, placed, frame grew, beside-not-in, adopted); a block that went where it was told is not listed. The eval's tool replay answers the same.

**Diagram height.** A diagram is the one block whose height nothing stores. `mermaid-size.ts` reads the source (flowchart ranks/lanes, labelled arrows, decisions, sequence messages, Gantt, ER, class, pie...) and adds the block's card. Grounded on **41 sources rendered inside the panel in Chromium** (block heights measured on the board, 480 wide): never short on any of the 41, 2 to 20 percent over on all but three (a lone subgraph 1.49x, a timeline 1.41x, a short LR chain 1.25x). The first version, grounded on bare Mermaid renders, was 26 short on a flowchart with labelled branches; the e2e that measures what the board draws found it, and the estimate was re-fit (card +59, 7.7 px a letter, width taken 12 percent under so a wide diagram is not shrunk on paper).

## Eval, before and after

`qwen3-6-27b`, thinking off, sequential, **12 cases x 5 repeats = 60 answers each**, through the tunnel on 30404. "Before" is the unchanged tool (the six new cases scored by the same rubric); "after" is the final tool text and schema. The rubric was corrected between (a chart is read the way the chat reads a fence, `parseJsonLenient`: one closing brace short still draws; the language detector reads "Opera, 19:00" as English, so only phrases of 3+ words count): the before-run's one wrongly-failed chart is counted good (39, recorded 38).

| case | before (good/5) | after (good/5) |
|---|---|---|
| arrange Saturday | 4 | 5 |
| add Sunday (en / hu) | 4 / 5 | 5 / 5 |
| remove and connect | 5 | 5 |
| create Vienna (en / hu) | 3 / 4 | 5 / 5 |
| **new** note beside the museum note (en / hu) | 4 / 5 | 5 / 5 |
| **new** bar chart in the full Saturday frame (en / hu) | 4 / 1 | 3 / 4 |
| **new** flowchart of the Saturday plan (en / hu) | **0 / 0** | **4 / 4** |
| **total** | **39 / 60** | **55 / 60** |

The six old cases went 25 -> 30 of 30; the six new add-to-an-existing-board cases 14 -> 25 of 30. Two more repeats on the final code (after the last restructure): 10/12 and 11/12 good. Before, the flowchart became sticky notes in all ten answers (the owner's probe); after, eight of ten are a Mermaid block that the chat's own parser reads (the `diagram:` check), drawn clear of everything.

What is left, in order: (a) the first call of a chart, or of a diagram with quoted labels, refused because the model sent its whole `ops` as one string with the inner JSON/quotes escaped, mended on the next call: letting a chart's config be an object took the chart cases' refused first calls from 5 of 10 answers to 3 of 10; (b) one answer in five to "a flowchart" is still a sticky note; (c) a `move` that leaves a block outside its frame (two answers in the 60 of the second after-run, none in the final 60). Raw outputs (every answer, every run): `scratchpad/w4/cva/{before5,after5,after5b,after5c,final1}`.

`fixtures/canvas/responses/` is now one live run (after5c run 2) in which all twelve came out good; `fixtures/canvas/evaluations/` holds the Mermaid-parse results for replay. `run.ts --suite canvas --replay`: 12 scored, 0 bad, no model, no key.

## Catalogue ceilings (ruling 23), measured

`estimateTokens` as `index.test.ts` counts (descriptions only): **en 5,084 -> 5,110 (+26), hu 8,223 -> 8,256 (+33), edit_artifact hu 784 -> 817.** Ceilings moved by those plus the same margin they had: en 5,110 -> **5,136**, hu 8,250 -> **8,283**, per tool 786 -> **819**. The cost is two clauses of the Canvas rule (a diagram is 480 wide; "leave position out and the block is placed for you (beside near, else in its parentId frame, else on free ground); a position you give is kept if free, else moved"), against one removed ("Keep blocks apart and inside their frame..."). The placement rule in full, the kinds and the diagram guidance are schema text (uncounted). The frozen EN/HU snapshots changed (the cached prefix moves once, on purpose).

## Gates

- `npm run check`: 0 errors, 17 warnings (the pre-existing ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1).
- `npx biome check src scripts tests`: clean.
- `npm test`: 17,007 passed, 2 skipped (1,028 files).
- `npm run build`: 32 `Unused CSS selector` + 2 `must have an ARIA role`, nothing new.
- `npm run check:artifact-chunks` (its own step): **exit 0.** Editor's own closure **71,515 B gzip** against a ceiling of 71,680 (unmoved); the same gate on a scratch build of base d89ab5a4 in this environment gives **71,587**. Chat route 542,331 (base 542,928 here) against `--chat-baseline 540,914`, tolerance 2,048 (unmoved). The first build of this work was at **74,063** (over); it was brought back not by moving the ceiling but by moving what only planners need out of the editor's closure: the diagram estimate (2.4 KiB gzip) behind `plannedNodeSize` (`node-size.ts`), the model-only declarations (`canvas-model-blocks.ts`), and the refusal reasons the review controller says (`board-refusals.ts`, so the editor no longer imports the vocabulary for four lines). The editor reserves `DIAGRAM_RESERVED_HEIGHT` (420, its Insert's own number) for a diagram it has not measured.
- Fallow: 124 issues, 4 circular (the baseline), nothing in my files.
- `npm run check:migrations`: passes unchanged. No migration.
- Playwright, once, on port 5430, every artifact suite + knowledge + chat + conversation (537 tests): **513 passed, 23 skipped, 1 failed**, the failure being `artifact-app.spec.ts:296` (the App tripwire: a torn-down frame), which **passes alone** (flaky in the combined run; the App kind is not mine). The new spec, 5 cases, passes.

## Screenshots (looked at each)

`scratchpad/w4/shots/cv-a/`: `hu-1440-light.png`, `hu-1440-dark.png`, `hu-390-light.png` (Hungarian UI: a note beside the museum note, a chart that made the Saturday frame grow, a flowchart on free ground, all clear of each other; the diagram draws in the dark theme), plus the five from the e2e (`flowchart`, `note-beside`, `chart-in-frame`, `diagram-in-frame`, `diagram-beside-frame`). One thing that is the fixture's, not mine: the tidy board's notes are 20 apart, so the edge label "then" sits half behind them.

## Concerns, for the orchestrator

1. **The chat's own Mermaid path fetches an `img:` URL while rendering and keeps `click ... href` links** (above). Pre-existing; I closed the board's door for Alfy only.
2. `move` is not settled: a rearrangement can still leave a block outside its frame (the eval counts it). Settling moves per frame bounds is possible but is a different rule from "where an add goes".
3. The ~20 percent of first calls refused for sending `ops` as one escaped string is a model habit with nested JSON/quotes; two mitigations are in (chart as object, fewer quotes in diagram guidance). A diagram source as an array of lines, or a lenient `ops`-string reader, are the next options.
4. Files outside the brief's list I touched, small: `canvas/_lib/review-controller.svelte.ts` (one import path), `canvas/_lib/block-meta.ts` (the reserved height constant). Neither is in `nodes/**` or `NodeShell.svelte`. `canvas-blocks.ts` lost its model-only half to `canvas-model-blocks.ts`: if FX-C or CV-B edit those declarations they will need the new path.
5. The placer assumes a 900x600 pane when it reads the saved camera, and a board whose camera is the default (0,0,1) is read as "fitted".
6. The e2e applies the change through the panel's ops route (author `user`), which judges with the same vocabulary the model's edit does; it does not run the in-process Alfy path.
7. `read_artifact` `blocks` now carries a diagram's `code` (an edit of it is made from it) and names an unnamed diagram by its kind.

## Hand-off

`shared/artifacts/`: `board-placement.ts` (`placeBlock`, `PLACEMENT_GAP`, `FRAME_INSET`), `mermaid-size.ts` (`estimatedDiagramHeight`), `node-size.ts` (`plannedNodeSize`), `canvas-model-blocks.ts` (`MODEL_CREATABLE_*`, `modelUpdatableFields`, `modelCreatableBlockDataSchema`, `mermaidSourceProblem`, `storedBlockData`), `board-refusals.ts`, `board-ops.ts` (`placementNotes`, `PlacedNote`, optional `position`, `near`). `canvas-blocks.ts`: `estimatedNodeSize(node, diagramHeight?)`, `DIAGRAM_RESERVED_HEIGHT`. Eval: `suites/canvas-diagrams.ts` (a `SuiteEvaluator`, registered in `evaluators.ts`, wired in `run-tool-suite.ts`), six fixtures, `fixtures/canvas/evaluations/`.
