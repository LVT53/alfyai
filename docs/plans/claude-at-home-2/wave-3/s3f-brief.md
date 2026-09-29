# Canvas agent S3-F · frames, reparenting, connectors and the drawing layer (Slice 3 T3 + T4)

S3-B put the board in the panel (read its report's hand-off first: the registry API, `CanvasBoard`'s props and callbacks,
the toolbar, where frames/connectors/drawing plug in). You make the board **arrangeable and drawable**: a note dragged
over a frame joins it and dragged out leaves it, one handle drag makes exactly one edge, deleting a node takes its edges,
and a pen/highlighter/shape/text layer that stays drawable at any zoom. These are the Svelte Flow v1 traps the prototype
measured — each one is a test here, never a hope.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3f`, branch
  `feat/artifacts-s3-frames` (from `feat/artifacts` after S3-B's merge), e2e port **5440**, label `s3f`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3f-report.md`;
  screenshots `…/scratchpad/w3/shots/s3f/`.
- **Agent S3-T runs at the same time** (Canvas's model tools and eval): `normal-chat-tools/**`, `kind-prose.ts`, the
  catalogue snapshots, `scripts/eval-artifact-contracts/**`. Stay out of those. You own
  `src/lib/components/artifacts/canvas/**` and `tests/e2e/artifact-canvas*.spec.ts` this round.
- **Dependencies first (Fallow must come back to the 124 baseline):** S3-B installed four packages; three are not imported
  yet. Replace your `node_modules` symlink with your own `npm ci`, then remove `@xyflow/system` from `package.json`
  (redundant: `@xyflow/svelte` 1.7.0 itself depends on exactly `0.0.83`, so the pin holds) and `html-to-image` (S3-X adds
  it back when the PNG export imports it), regenerate the lockfile with npm, commit that alone. You import
  `perfect-freehand` (the pen), which clears the third.

## Read first

`wave-3/common.md`; S3-B's report hand-off (`…/scratchpad/w3/s3b-report.md`); S3-P's hand-off (the body semantics:
frame-relative positions, parents first, a frame's size on the node and in `data`, a removed frame re-homes its children).
Rulings: 12, **16** (two undos: your in-session steps vs Alfy's change / History — label them differently), 47, 64.
`slice-3.md` by range: 106–136 (review focus 1–4), 517–583 (`pane-rect.ts`, `board.ts`'s geometry), 672–700
(`annotations.ts`: what carries over from the prototype), 849–957 (frames and app-level reparenting, connectors, the
drawing layer), 1096–1108 (portal and z-index traps), 1149–1161 (focus order), 1556–1627 (T3), 1628–1710 (T4). The
prototype branch the spec cites (`proto/artifact-canvas`) **no longer exists** (S3-B checked): build from the spec, the
findings doc `docs/plans/claude-at-home-2-prototype-findings.md` (grep for canvas, pad, reparent, annotations) and
`@xyflow/svelte`'s installed `.d.ts`.

## Step 1 · Frames, reparenting, connectors (T3)

`absoluteOf`, `nodeRect`, `frameRect`, `frameAt` and the pure `reparentOnDrop(node, all, measured)` in `_lib/board.ts`
(nested frames: S3-P's protocol allows them — decide how a nested frame draws and say so), the handler on the
**lowercase** `onnodedragstop`, `FrameNode.svelte` (label bar as drag handle, resize grip on selection, size kept equal
on the node and in `data`), connectors (v1 calls `addEdge` itself and then fires `onconnect` as a notification: one drag,
one edge), deleting a selected node removes its edges. Every structural gesture is one save through `saveArtifactBody`
with `expectVersion`; a stale save shows the shared conflict line and undoes the gesture. Tests: T3's list (1570–1587).

## Step 2 · The drawing layer (T4)

`_lib/pane-rect.ts` (`visibleBoardRect`), `_lib/annotations.ts` (the prototype's module with the spec's changes: shared
`newId`, the ink token, the caps — S3-P's `MAX_ANNOTATIONS_PER_BOARD`/`MAX_POINTS_PER_STROKE`, exported as you use
them), `AnnotationLayer.svelte` through `<ViewportPortal target="front">` with its pointer surface **sized from the visible
pane** (the ≥ 95 % hit-coverage gate) and `z-index: 2` above frame children, and the drawing tools, inks and your own
undo/redo in `CanvasToolbar.svelte` (a bounded history of gestures, never node/edge/comment changes). Strokes commit in
board coordinates, once per gesture. Tests: T4's list (1642–1671), including the coverage gate and the pinch cases.

## Proof

Screenshots you look at yourself: a board with two frames, a note being adopted, edges, a pen stroke, a highlighter and a
shape over a framed note, at 1440×900 light and dark and at 390×844; Hungarian. Your share of the perf budget: note the
frame time you see with ~150 nodes and ~200 strokes (the measured gate is S3-X's). The hand-off names what S3-C (pins on
the same portal layer), S3-A (the tween and highlight on `CanvasBoard`) and S3-X (export) need from you.
