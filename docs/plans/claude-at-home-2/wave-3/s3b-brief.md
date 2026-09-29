# Canvas agent S3-B · the board in the panel (Slice 3 T2's core + T8's chunk guard)

S3-P built the board body and the ops protocol (read its report first). You put a **real board in the artifact panel**:
the new dependencies, the block registry, the node shell, the board host, the editor that the panel mounts for a Canvas,
the note-shaped blocks, the Insert menu for them, the in-chat card's Canvas branch, the tokens, and the guard that keeps
all of it out of the idle shell. Frames' reparenting, connectors and drawing (S3-F), comments (S3-C), Alfy's landing and
review (S3-A) and the chat-derived blocks (map, file, app, photo, live web — S3-R) come after you: leave clean seams, no
placeholders.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3b`, branch
  `feat/artifacts-s3-board` (from `feat/artifacts` after S3-P's merge), e2e port **5430**, label `s3b`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3b-report.md`;
  screenshots `…/scratchpad/w3/shots/s3b/`.
- **Agent S3-T runs at the same time**: `normal-chat-tools/artifact-tools/**`, `kind-prose.ts`,
  `normal-chat-tools/index.test.ts` and its catalogue snapshots, `scripts/eval-artifact-contracts/**`. Stay out of those.
  You both may append to `src/lib/i18n/artifacts.ts`: keep yours in an `artifacts.canvas.*` block.

## Read first

`wave-3/common.md`; `…/scratchpad/w3/s3p-report.md` (hand-off). Rulings: 1, 15, 16, 22, 51, **62–64**, and ruling 10
(the panel is `DocumentWorkspace.svelte`; you should not need to edit it — the body registry and `ArtifactBodyProps`
are the seam). `slice-3.md` by range: 9–82, 106–136 (review focus 2–6), 141–157 (packages), 361–443 (the registry, the
checklist ruling — schemas now come from `canvas-blocks.ts`, ruling 64), 1096–1161 (portal/z-index traps, limits, UI
states, focus order), 1183–1202 (prototype pointers), 1203–1332 (i18n keys), 1464–1555 (T2), 1939–2001 (T8). Mockups:
`docs/plans/claude-at-home-2-artifact-types-mockups.html` §1 (Canvas) and `…-artifact-surfaces-mockups.html` §2–3 —
`grep -n`, never whole; `docs/design/artifacts-redesign/redesign.md` §8 (lines 729–744). How a body plugs into the panel:
`artifact-bodies.ts` (`ArtifactBodyProps`, `registerPanelActions`), and `app/AppBody.svelte` as the smaller reference.
The prototype is `src/routes/prototype/canvas/` on branch `proto/artifact-canvas` (`git show proto/artifact-canvas:…`):
read it, do not copy it.

## Step 1 · Dependencies, registry, node shell, note-shaped nodes

- Replace your `node_modules` symlink with your own `npm ci`, then `npm install --save-exact @xyflow/svelte@1.7.0
  @xyflow/system@0.0.83 perfect-freehand html-to-image@1.11.11` (licences per spec 141–157; `perfect-freehand` at its
  latest, pinned). Commit `package.json` + `package-lock.json` alone first.
- `_lib/block-registry.ts` (imports the per-kind schemas from `canvas-blocks.ts`; adds component, icon, label key,
  size, section, poster policy), `NodeShell.svelte` (chrome, selection handles, anchors only on selection),
  `nodes/{Frame,Sticky,Text,Checklist,Chart}Node.svelte`. Chart reuses `chat/Chart.svelte` unchanged; the checklist is
  canvas-owned and tickable (spec 415–438; `chat/Checklist.svelte` is not touched). Registry rows for the other five
  kinds come with S3-R; until then an unknown stored kind renders the `blockMissingKind` card and stays in the body.
- Tokens in `src/app.css` and `tailwind.config.ts` together: the four sticky fills (both themes), the map-paper tint,
  the ink tokens, `--artifact-overlay-z`.

## Step 2 · The board and the editor in the panel

- `CanvasBoard.svelte` (the Svelte Flow host: **lowercase** event props, v1 API only — the trap table), a minimal
  `CanvasToolbar.svelte` (`role="toolbar"`: Select, Pan, Insert with its menu for the note-shaped kinds, Undo/Redo of
  your own steps — S3-F adds the drawing tools to it), and `CanvasEditor.svelte` implementing `ArtifactBodyProps`:
  load through `fetchArtifact` with `conversationId` (ruling 51), the loading / error / dropped-content / empty states
  (spec 1137–1148), save through `saveArtifactBody` with `expectVersion` (a 409 shows the shared conflict string), a
  bare pan is not a save (spec 355–359), and every version goes through the version announcement (common.md 6). Report
  the header's triggers through `registerPanelActions` the way `AppBody` does (Versions; Download arrives with PNG).
- Register the body: one line in `artifact-bodies.ts`. The in-chat card: one Canvas branch in `ArtifactCard.svelte`
  (what the mockup's card shows; it must stay cheap — no Svelte Flow in the chat).
- Tests: T2's registry and component lists (1480–1500) for the kinds you build; e2e `tests/e2e/artifact-canvas.spec.ts`
  (create it): open a seeded Canvas in the panel and see its blocks; insert each note-shaped kind; the Insert menu closes
  on Escape and outside click and returns focus; a tick survives a reload; the board's content stays clear of the
  toolbar and minimap; 390 px: the toolbar collapses (spec 1148).

## Step 3 · The chunk guard (T8's first half)

`scripts/check-artifact-chunks.mjs` + test (spec 1939–2001): after `npm run build`, `@xyflow/*`, `perfect-freehand` and
`html-to-image` appear only in the lazy Canvas chunk, never in the idle chat or knowledge shell. Parameterised by chunk
name so Slides reuses it. Name the method in the report.

## Proof

Screenshots you look at yourself (common.md): a seeded board with each note-shaped kind at 1440×900 light and dark, the
Insert menu open, the same board at 390×844, the in-chat card, the empty board; Hungarian. The report's hand-off names
the registry API, `CanvasBoard`'s props and callbacks, where S3-F plugs frames/connectors/drawing in, where S3-C's pins
and S3-A's landing will mount, and the bundle numbers.
