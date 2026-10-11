# FG-2 — finish the fast gates from where FG stopped

FG (the fast-gates job, brief `phase-5/fg-brief.md`, read it in full: it is the scope) was halted by the owner partway
through its step 3. You finish it in the same worktree and branch. Read `phase-5/common.md` and the two files it names
first.

- Worktree: `.claude/worktrees/art-fg`, branch `infra/fast-gates`. Ports 5450–5469 are yours.
- Report: `<scratchpad>/p5/fg-report.md` (`<scratchpad>` is in common.md): the report FG's brief asks for, covering all
  three steps, including what FG did before you.

## Where FG stopped

- **Committed:** `cae39413` (step 1: the chat route held by a closure rule instead of a byte baseline), `462096c2`
  (step 2: a server and a database file per worker slot, on the production build), `913a8b89` (the fake-provider and
  lazy-chunk specs agree with a production build).
- **Uncommitted in the worktree, unreviewed** (left exactly as FG left it mid-edit): `scripts/gates.sh`,
  `scripts/gates.mjs`, `scripts/gates.test.ts`, `tests/e2e/quarantine.json`, `tests/e2e/quarantine.ts`,
  `tests/integration/e2e-quarantine.test.ts`, and edits to `playwright.config.ts`, `tests/e2e/e2e-env.ts`,
  `tests/e2e/e2e-servers.ts`, `tests/integration/e2e-slots.test.ts`, `tests/e2e/artifact-canvas-helpers.ts`,
  `artifact-chat-card.spec.ts`, `artifact-document.spec.ts`, `artifact-panel-swap.spec.ts`, `artifact-versions.spec.ts`.
  Its last words: "Now apply the `@smoke` tags via a script keyed by file and exact title."
- No measurement of the "after" exists yet, and no report.

## What to do

1. **Review the work in the worktree before building on it** (`git log -p cae39413^..913a8b89 --stat`, `git diff`): does
   step 1's closure rule really forbid what the brief names and pass on today's build; does step 2 give each worker its
   own server, database and on-disk state; are the spec edits real fixes (no weakened assertion, no blanket wait)?
   Fix what is wrong, then commit the uncommitted work in coherent steps once each works.
2. **Finish step 3** as FG's brief says: the gate runner's `release` and `agent` modes with durations, the quarantine
   list with reasons, the `@smoke` set (15–25 tests, under three minutes on the build) and `npm run test:e2e:smoke`,
   AGENTS.md's "Mandatory Verification" lines.
3. **Measure the "after"**: `scripts/gates.sh release` twice, plus one whole-suite run; stability three times at the
   chosen worker count. Other agents share this Mac (a versioning server agent on ports 5400–5409, later a History UI
   agent on 5420–5429): note the load (`uptime`) with each timing.

Final reply at most 12 lines: status, **your model ID**, commit range, before → after, concerns.
