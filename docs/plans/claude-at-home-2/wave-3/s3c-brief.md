# Canvas agent S3-C · comments on the board (Slice 3 T5, with the redesign's comment parts)

The board can be arranged and drawn on (S3-F; read its hand-off). You add the **one shared comment feature** to it:
numbered pins on the board for `node` and `point` anchors, the canvas anchor resolver, the Comment tool, the comment list
the header's comments button toggles (the same cards, column, drawer and phone sheet the Document uses), and `@Alfy` in a
canvas comment — an Alfy edit plus a reply in the thread, through the one ops envelope.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3c`, branch
  `feat/artifacts-s3-comments` (from `feat/artifacts` after S3-F's merge), e2e port **5460**, label `s3c`, model tunnel
  local port **30040** (only for one live `@Alfy` check at the end).
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3c-report.md`;
  screenshots `…/scratchpad/w3/shots/s3c/`.
- **Agent S4-V (Slides' fact check, on `feat/artifacts-slides`) runs at the same time; S3-Z (containment, the workspace
  restore, the arrow refile) or S3-R (the chat-derived blocks) may join later.** You own
  `src/lib/components/artifacts/canvas/**` except what S3-R's brief names (`nodes/{Map,File,App,Photo,LiveWeb}Node.svelte`,
  the registry rows for those kinds), `src/lib/shared/artifacts/comments.ts`, the canvas branch of
  `services/artifacts/comments.ts`, and `tests/e2e/artifact-canvas*.spec.ts` (add your own spec file,
  `artifact-canvas-comments.spec.ts`, so a parallel agent's e2e never conflicts with yours).

## Read first

`wave-3/common.md`; the hand-offs of `s3f-report.md`, `s3b-report.md`, `s3p-report.md`, and `s3t-report.md` (the ops
tool's contract and refusal texts, which an `@Alfy` reply reuses). Rulings 1, 11, **45** (anchors are declared once in
`src/lib/shared/artifacts/anchor.ts` — `Anchor` already has `node` and `point`; `comments.ts` imports and never
redeclares), 49, 51, 53, 61 (Open/All and the resolved fold), **62**, 63. `slice-3.md` by range: 444–516 (the shared
comment interface and the canvas resolver — read with ruling 45), 958–983 (comment pins), 1096–1108 (the portal/z-index
traps), 1711–1790 (T5). `docs/design/artifacts-redesign/redesign.md` §8 (729–744) and AGENTS.md's Artifacts section
(the comment list that stays in view, the header toggle, the item-stamped header report).

**Chunk budget (orchestrator ruling after S3-F):** the Canvas editor's initial chunk is 67.0 kB gzip against the spec's
65 kB. Do not add to it: the comment layer, list and `@Alfy` client code load on demand (when the board has threads or
the Comment tool/comments button is used), and report the chunk size before and after.

## Step 1 · Pins, the resolver and the Comment tool

`src/lib/shared/artifacts/comments.ts` (the resolver interface, and nothing `anchor.ts` already declares) and the pure
canvas resolver (`exact` for a present node, `moved` for a point, `orphaned`/`node_missing` for a deleted node — never a
local "does it exist" check), `pinAt`, pin numbering (list position; a resolved thread keeps its number; an unknown id
prints `?`). `CommentLayer.svelte`: 22 px numbered pins in board space through the same front portal at `z-index: 2`, the
click-to-place catcher **outside** the portal (one click places a point thread; on a selected node, a node thread), the
tool returns to Select. A comment on a canvas refuses a `text` anchor at intake (the resolver's `kinds`). Tests: T5's
unit and integration lists (1726–1747).

## Step 2 · The list, the header toggle, the phone sheet

The comment list uses the shared parts: `CommentThread` cards (the quote line names the node — "Trains card" — or "a
spot on the board"), Open by default with the quiet resolved toggle (ruling 61), resolved threads folded, orphaned
threads dimmed with "the block is gone", and the same surfaces the Document uses — a column beside the board on desktop,
the drawer when the panel is narrow, `CommentsSheet` on phones — toggled by the header's comments button through
`registerPanelActions.toggleComments`, with the open count reported (`onCommentCountChange`). `MarginPanel.svelte` is
tied to the Document's blocks and tabs: **do not fork its internals**. Compose the shared cards; if a piece is generic
(the Open/All toggle, the folded group), extract it into a shared component the Document then uses too, only if its
existing tests stay green unchanged. Two-way linking: a pin click selects its thread in the list (and opens the sheet on a
phone); a thread's "go to" centres the camera on its pin and flashes it.

## Step 3 · `@Alfy` in a canvas comment

`runAlfyCommentReply` answers `not_a_document` for a board today. Add the canvas branch in the comment service (the
facade's own module): the model gets the board as `read_artifact` gives it plus the thread, answers with a reply and
optional board ops **in the exact schema the edit tool advertises** (ruling 62 — reuse S3-T's schema, example and refusal
texts, never a second wording), the ops go through the facade's `applyArtifactOps` (one version, `author: "alfy"`), the
reply is written to the thread, and a refused op is named in the reply. Abort and deadline as the Document's path does.
The client shows the landed change the way the Document's comment path does today (S3-A will add the arranging frame and
the one-change review on top — leave a clean hook, and say where in the hand-off). One live check at the end through the
tunnel: an `@Alfy` comment on a sticky ("make this a checklist of three items") lands and replies.

## Proof

Screenshots you look at yourself: pins on a board with the list open (desktop, light and dark), a phone with the sheet
open at a thread, an orphaned thread, an `@Alfy` reply; Hungarian. Full gates once at the end.
