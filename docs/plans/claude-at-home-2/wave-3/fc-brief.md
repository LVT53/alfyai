# Fix agent F-C · the App inside a board, and the reader's unsaved step (RV-3 cluster C)

The Opus review (`wave-3/rv3-review.md`) split its fixes into three clusters with disjoint files. You fix **cluster C**.
F-B runs beside you on the board UI (`canvas/nodes/*`, `canvas/_lib/*`, `CanvasBoard`, `CommentCatcher`,
`CanvasComments`, `AlfyChangeLayer`, `NodeShell`, `src/lib/i18n/artifacts.ts`); stay out of those — F-B owns the wording
of I2's banner, you own its logic.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxc3`, branch
  `fix/artifacts-w3-app-save` (from `feat/artifacts` after S3-X's and F-A's merges), e2e port **5570**, label `fc`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/fc-report.md`;
  screenshots `…/scratchpad/w3/shots/fc/`.

## Read first

`wave-3/common.md`; `wave-3/rv3-review.md` — I1, I2 and the fix plan's cluster C (its file list is yours); decisions.md
ruling 58 (the App frame's sandbox, CSP and tripwire — the tripwire must keep catching an App that navigates itself);
`s3r1-report.md` (the App block runs in the panel's own `AppFrame`); AGENTS.md's Artifacts section on the keyed body
mount and the once-only landing.

## The fixes (test first, each red before green)

- **I1** — dragging an App block into (or out of) a frame must not fire the "this App tried to leave its sandbox"
  tripwire or reset the App. Find why reparenting reloads the frame (a remount of the iframe) and fix the cause (keep the
  frame mounted across a reparent), not the alarm; prove the tripwire still fires for a real self-navigation and that
  the App's storage survives the drag.
- **I2** — a step the reader has not saved yet is never lost when Alfy's change lands: flush the reader's pending save
  before a chat send that can change this board (an optional `flush` in `ArtifactBodyProps`, awaited by the chat page
  through `DocumentWorkspace`), and when a landing still meets an unsaved step, rebase it onto Alfy's version instead of
  discarding it (or, where it truly conflicts, keep the reader's words and say so — never a silent loss; F-B words the
  banner). Tests: type on a board, send "rearrange this" at once, both the reader's text and Alfy's change survive.

## Proof

Screenshots you look at yourself (HU, desktop): an App dragged into a frame still running, the board after a send that
raced an edit. Full gates once at the end, every artifact e2e suite included.
