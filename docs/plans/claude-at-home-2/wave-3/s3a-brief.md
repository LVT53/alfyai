# Canvas agent S3-A · Alfy's change lands, and is reviewed as one change (Slice 3 T6's client half + ruling 63)

Alfy can change a board through the chat's `edit_artifact` (S3-T) and through an `@Alfy` comment (S3-C), and today the
board simply swaps to the new body. You make the change **visible and reviewable** the way the Document's is: the user
watches it land (Alfy is arranging…, structure first, moves tweened, touched nodes highlighted, skipped ops named), and
then keeps or undoes it as **one change** (ruling 63) — also after a reload. Plus the node selection pill the approved
mockup shows ("Ask Alfy · Comment").

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3a`, branch
  `feat/artifacts-s3-review` (from `feat/artifacts` after S3-C's merge), e2e port **5510**, label `s3a`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3a-report.md`;
  screenshots `…/scratchpad/w3/shots/s3a/`.
- **Parallel agents:** S3-Z (the chat page's workspace restore, `document-workspace-state.ts`, the containment suite,
  `canvas-model.ts`'s create parse, the Playwright setup) now, then S3-R1 (new block nodes, the Insert menu's "From
  this chat", an "open this item" callback in `ArtifactBodyProps` and `DocumentWorkspace.svelte`). Stay out of those.
  In the chat page, `DocumentWorkspace.svelte` and `artifact-bodies.ts` you change **only** the Alfy-activity seam
  (its type and pass-through); say exactly what in the report so the merges stay keep-both.

## Read first

`wave-3/common.md`; the hand-offs of `s3c-report.md` (**"For S3-A"**: `adoptServerBoard` → `judgeServerBoard` →
`CanvasBoard.land(body)` is your hook; the controller's `asking`; the change chip props), `s3t-report.md` (the tool-call
metadata an Alfy canvas edit leaves; a highlight-only edit writes no version), `s3p-report.md` (the review marker the
envelope already writes; `structuralOps`/`moveOps`/`highlightedIds`), `s3f-report.md` (undo, the chunk budget).
Rulings 16, 53, **61, 63**, and AGENTS.md's Artifacts paragraphs on the review state, the once-only landing
(`settledActivityKeyAtMount`), the keyed body mount and the item-stamped header report. `slice-3.md` by range:
984–1023 (the diff path and its order — the contract), 1005 (the highlight), 1123–1128 (tween and highlight timings),
1791–1878 (T6's e2e list). `docs/design/artifacts-redesign/redesign.md` §4 (editing feedback: the one chain) and §8.
The Document's implementation is your reference, not your code: `document/alfy-activity.ts`, `ChangeBar.svelte`,
`ReviewBar.svelte`, `AlfyWriting.svelte`, `services/artifacts/document-ops.ts` (`computePendingReviewBlocks`,
`getDocumentReviewState`, `acknowledgeDocumentReviewBlocks`) and the review route.

**Chunk budget:** the editor's initial chunk is already over (69.1 kB gzip vs 65; S3-X brings it back). Everything you
add loads on demand (when an Alfy change arrives or is pending), not in the first paint.

## Step 1 · The change lands where the user can see it

- The chat turn's activity reaches a board: extend the Alfy-activity seam so a running and a settled `edit_artifact` on
  a Canvas reach its body (its ops, summary, refused indices — S3-T's metadata), exactly once per activity (the
  Document's once-only rule: a body mounted after the call settled restores the server's review state and never lands it
  again).
- Extend `CanvasBoard.land`: while Alfy runs, the arranging frame (the redesign's Alfy-writing state for a board: a
  dashed frame around what Alfy is arranging, "Alfy is arranging…" with the summary); when it lands, structural ops first
  (parents before children), `tick()`, then the moves tweened (620 ms), then the touched nodes highlighted (cleared after
  3200 ms), then the skipped ops in the shared `RefusalNotice` (never a canvas copy). Reduced motion: no tween, no pulse.
  A second landing while one runs waits for it (never interleaves); Ask Alfy is disabled while arranging.
- The same landing for an `@Alfy` comment reply (S3-C's path) and the comment reply's change chip
  (`changeStateByCommentId`, `onSeeChange`).
- Tests: T6's e2e list (1830–1835) driven through a mocked chat turn and a canned ops call, plus the once-only rule
  across a re-mount and a reload.

## Step 2 · Keep or Undo, as one change, across reloads (ruling 63)

- Server: a Canvas branch of the review state behind the existing review route and facade (never route-local): pending
  = each Alfy version newer than the marker, its **touched node ids** against its parent version; Keep advances the
  marker; the read model's `pendingReviewCount` for a board feeds the card, the list row and the count button's dot (one
  source, as for Documents). Ownership scope, `?conversationId=` for incognito, `{ ok: true }`.
- Client: one change pill (`ChangeBar`'s pill) at the corner of the touched nodes' bounding box, and the shared
  `ReviewBar` at the bottom of the board — prev/next centres the camera on each touched node (S3-C's `BoardLayerApi`
  `centerOn`), Keep / Undo for the whole change. **Undo** saves the parent version's body back as a user version with
  the shared summary ("Undid Alfy's change"); if the user changed the board after the change landed, Undo is refused
  with the shared refusal card and points to History (Versions). Keyboard: the Document's shortcuts file owns the chords
  (⌘/Ctrl+Alt+Z for Alfy's change; never the reader's own undo).
- Tests: pending after reload, Keep then reload shows nothing pending, Undo writes the parent body as a user version,
  Undo refused after a user edit, a highlight-only edit is not pending, the dot follows the persisted state, another
  user's board 404s.

## Step 3 · Selecting blocks: Ask Alfy and Comment

The mockup's node-selection pill ("Ask Alfy · Comment"; S3-R2 adds "Refresh" for live-web blocks later): Ask Alfy on the
selected blocks sends the chat a request scoped to them the way the Document's selection "Ask" does (find that path and
reuse it — the chat, not a side channel, makes the change), and the change lands through step 1; Comment opens S3-C's
composer on the selected node. The toolbar's Ask Alfy works the same with no selection (the whole board). Tests: the
pill appears on a selection and hides on Escape, the request names the selected blocks, both actions by keyboard.

## Proof

Screenshots you look at yourself: the arranging frame mid-change, the highlighted result with the pill, the review bar
(desktop light and dark, and 390×844), the refused-Undo card, the selection pill; Hungarian. Report the editor chunk
before and after. Full gates once at the end.
