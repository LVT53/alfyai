# Canvas agent S3-R1 · blocks from this chat: files, Apps, charts and maps (Slice 3 T2's rest)

The approved Canvas mockup promises "Insert any AlfyAI block: map, calendar, chart, checklist, Immich photos, files, apps
or live web", and the spec's registry says those blocks are the chat's own components on the board — but it never says
how the user picks *which* map or file. You build the first half of that: the **"From this chat" section of the Insert
menu**, the server listing behind it, and the File, App, chart and map blocks. Photos and live web are S3-R2's.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3r1`, branch
  `feat/artifacts-s3-blocks` (from `feat/artifacts`), e2e port **5490**, label `s3r1`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3r1-report.md`;
  screenshots `…/scratchpad/w3/shots/s3r1/`.
- The orchestrator names the parallel agent when you start. You own `nodes/{File,App,Map}Node.svelte`, the registry rows
  for `file`, `app`, `map` (and the chart row's "from this chat" source), the Insert menu's "From this chat" section in
  `CanvasToolbar.svelte`, the listing route and its service function, and your own e2e file
  `tests/e2e/artifact-canvas-blocks.spec.ts`.

## Read first

`wave-3/common.md`; the hand-offs of `s3b-report.md` (the registry, NodeShell, the Insert menu), `s3f-report.md`
(frames, the drawing layer, the chunk budget), `s3p-report.md` (the block schemas; the model cannot add these kinds —
ruling 64 — so the user's Insert is the only way they land; a photo URL must be same-origin). Rulings 10, 42, 51, 58
(the App frame is exactly `allow-scripts allow-forms` under the strict CSP), 64, and the chunk-budget ruling in
`progress.md`'s S3-F row. `slice-3.md` by range: 399–443 (the registry rows and the reuse promises), 1096–1108 (traps),
1137–1161 (UI states, focus order). The existing parts you reuse unchanged: `chat/Chart.svelte`,
`chat/MapRouteCard.svelte` (its inline-SVG fallback is the offline shape), `FileTypeIcon.svelte`,
`artifacts/app/AppFrame.svelte` (its sandbox, CSP, bootstrap and `window.alfy.storage`).

## Step 1 · What this chat has, as insertable blocks

A server read, ownership-scoped through the existing services (facade rule; incognito contained, ruling 51), that lists
the board's own conversation's insertable things: its produced and attached **files**, its **Apps**, the **maps** its
`map_route` tool calls returned (`ToolCallMapData`), and the **charts** its replies drew (the chart code the chat
renders) — newest first, bounded, each with the label the chat shows. A thin route over it (`requireApiUser`,
`{ ok: true, … }`, a foreign or missing id → the same 404). Tests first: scope (another user's chat, an incognito chat
without and with its id), the bound, each source's shape.

## Step 2 · The blocks and the Insert section

- The Insert menu gains **From this chat** (the listing, grouped by kind, empty groups hidden, a quiet empty state) next
  to S3-B's note-shaped section; inserting places the block at the view's centre and saves through `saveArtifactBody`.
- `FileNode`: a compact row (`FileTypeIcon`, name, type, size); a click opens the file in the panel's shared viewer — add
  an optional "open this item" callback to `ArtifactBodyProps` and wire it in `DocumentWorkspace.svelte` (one small,
  additive change; no other agent edits the workspace this round), never an inline heavy renderer.
- `AppNode`: the App running in `AppFrame` at node size with `nodrag`/`nowheel`, its storage the **App's own** (never the
  board's), and the sandbox/CSP exactly as the panel's (the exact-string tests apply to the node too).
- `MapNode`: `MapRouteCard` with the same props the chat passes; the chart from a chat reply through `Chart.svelte`
  unchanged. Chart.js and MapLibre load only when their block mounts (the chunk budget).
- Tests: the registry rows (poster policy stays as the spec says — S3-X draws the posters), each node's reuse promise
  (same props as the chat; the App frame's exact sandbox string; nodrag/nowheel), the Insert section by keyboard (roving
  tabindex, Escape returns focus), and e2e: insert a file, an App, a map and a chart from a seeded chat, reload, all four
  are still there; the file opens in the viewer; two Apps on one board keep separate storage.

## Proof

Screenshots you look at yourself: a board with all four blocks at 1440×900 light and dark, the Insert menu's "From this
chat" open, the same board at 390×844; Hungarian. Report the editor chunk size before and after. Full gates once.
