# Owner-walk agent OW-C · every chart the chat draws also draws on the board

The owner on ai.dev (`63bc6626`): "All other chart types that would load in chat do not load inside the canvases."
Find out exactly which ones and why, then fix it at the cause.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-owc`, branch
  `fix/canvas-owner-walk-charts` (from `feat/artifacts`), e2e port **5620**, label `owc`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/owc-report.md`;
  screenshots `…/scratchpad/w3/shots/owc/`.
- **Agent OW-1 runs at the same time** on the board's interactions (`CanvasBoard`, `NodeShell`, `FrameNode`, the pill,
  undo). Stay out of those.

## Read first

`wave-3/common.md`; ruling 64 (the model may add only `chart` among data blocks; others come from the chat through
Insert); `slice-3.md` lines 399–443 (the registry's reuse promise: the chart block uses the chat's `Chart.svelte`
unchanged, with the same props); the hand-offs of `s3b-report.md`, `s3r1-report.md` (the "From this chat" listing's
chart source), `fd-report.md` (Chart.js measuring its box on screen).

## Steps

1. **Inventory, with evidence.** List every chart/diagram kind the chat renders (Chart.js chart types — bar, line, pie,
   doughnut, radar, polar area, scatter, bubble, mixed; and any other chart or diagram renderer the chat has, e.g. fenced
   blocks the message renderer turns into visuals — grep the message renderer) and for each: does the "From this chat"
   listing offer it, does the board draw it, and if not, why (suspects: Chart.js controllers/scales/plugins the chat
   registers somewhere the board's lazy path never imports; the listing's extraction matching only some fences; a
   `code` shape the chart node narrows). A table in the report.
2. **Fix at the cause**, so the board draws what the chat draws through the same components and the same registration —
   never a second chart setup. A diagram kind that is not a Chart.js chart and has no board block today: propose the
   smallest correct way (a new block kind needs its schema in `canvas-blocks.ts`, its registry row, its poster policy and
   the model rules of ruling 64 — the model still may not add it) and build it only if it is small; otherwise report it.
   Keep the editor's first paint within ruling 68 (the renderers load when their block mounts).
3. Tests: one e2e per chart type the chat can make — made in a seeded chat, inserted from "From this chat", drawn on the
   board (a canvas pixel check or the chart's own rendered state), after a reload too. Red first.

## Proof

Screenshots you look at yourself: a board with every chart type side by side (HU, 1440 light and dark). Full gates once at
the end (the size budgets as their own step).
