# Agent FLK · a server-only commit made a Canvas undo test fail one run in four: find out why, fix the cause

The sampling fix merged into `dev` as `b179456b`. Its release gates were green except one Playwright test that now fails
intermittently, and the orchestrator bisected it to a commit that touches only server code:

| commit | `tests/e2e/artifact-canvas-undo.spec.ts:418` ("on a Mac (⌘Z): a moved note and a deleted block"), run alone |
|---|---|
| `27274c0e` (`dev` before the merge) | 14 / 14 passed (two batches, one under the same machine load) |
| `ca145566` (SMP's first commit: `normal-chat-model/sampling.ts`, the routing through it) | 8 / 10 |
| `4e64644c` (SMP's last) | 7 / 8 |
| `b179456b` (the merge) | 7 / 10 |

Every failure is the same step: in the delete scene, after `nodeBox(page, LIST)`, a click at the checklist card's header
(`box.y + 14`) and `Delete`, the node is still there. The failed run's page snapshot shows the checklist's first item
("Passport") **ticked** (1/2), which suggests the click landed on its checkbox — the layout moved between the measure
and the click — and a "Some capabilities are degraded…" status banner showing in the chat column. The e2e server is the
**Vite dev server** (`playwright.config.ts` `webServer`), so a server change can move page timing (SSR compile, a
request that resolves later, a late banner).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/flk`, branch
  `fix/canvas-undo-regression` (from `dev` `b179456b`), e2e port **5490**, label `flk`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/flk-report.md`.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to) from the `art-base`
  worktree; the test file around `:90–160` and `:418–470`; `git show ca145566 --stat`.

## Steps

1. **Evidence, not a guess.** Record a failing run with `--trace on` (or video) and compare it with a passing run at
   `27274c0e`: what moves or reloads between the measure and the click, and when (a banner arriving, a hydration finishing
   late, a full reload, a re-render of the panel). Then find which line of `ca145566` changes that timing and how.
2. **Fix the cause.** If the product moves content under a reader's pointer (a late banner pushing the board, the panel
   re-mounting), that is a real bug a person would hit too: fix it in the product, with a test that would catch it. If
   the product is right and only the test races, make the test measure after the layout is stable with the existing
   helpers (`waitForStableBoundingBox`, `waitForMotionToSettle` in `tests/e2e/helpers.ts`) — never a blind wait.
3. **Proof:** `--repeat-each=20` green on the fixed tree, the whole `artifact-canvas-undo.spec.ts` green, then the full
   gates once (Wave 3 rules' list; Playwright with every artifact suite, `streaming.spec.ts` and knowledge).

**Runs beside you:** named by the orchestrator at dispatch.
