# FG-2 — finish the fast gates from where FG stopped

FG (the fast-gates job, brief `phase-5/fg-brief.md`, read it in full: it is the scope) was halted by the owner partway
through its step 3. You finish it in the same worktree and branch. Read `phase-5/common.md` and the two files it names
first.

- Worktree: `.claude/worktrees/art-fg`, branch `infra/fast-gates`. Ports 5450–5469 are yours.
- Report: `<scratchpad>/p5/fg-report.md` (`<scratchpad>` is in common.md): the report FG's brief asks for, covering all
  three steps, including what FG did before you.

## Where FG stopped

- **Committed, in order:** `cae39413` (step 1: the chat route held by a closure rule instead of a byte baseline),
  `462096c2` (step 2: a server and a database file per worker slot, on the production build), `913a8b89` (the
  fake-provider and lazy-chunk specs agree with a production build), `3477a490` (the gate runner, the quarantine list
  and the `@smoke` tier; fixes from parallel runs), `eaf65d1a` (the live-edit specs get an empty conversation). The
  worktree is clean. Its last words, a minute before the halt: "Now apply the `@smoke` tags via a script keyed by file
  and exact title", so the smoke set may be incomplete.
- No measurement of the "after" exists yet, and no report.

## What to do

1. **Review FG's five commits before building on them** (`git log --stat cae39413^..eaf65d1a`, then the diffs by
   file): does step 1's closure rule really forbid what the brief names and pass on today's build; does step 2 give
   each worker its own server, database and on-disk state; are the spec edits real fixes (no weakened assertion, no
   blanket wait); does the runner do what FG's brief asks? Fix what is wrong, in commits of your own.
2. **Finish step 3** as FG's brief says, checking each part FG started: the gate runner's `release` and `agent`
   modes with durations, the quarantine list with reasons, the `@smoke` set (15–25 tests across the main flows, under
   three minutes on the build) and `npm run test:e2e:smoke`, AGENTS.md's "Mandatory Verification" lines.
3. **Measure the "after"**: `scripts/gates.sh release` twice, plus one whole-suite run; stability three times at the
   chosen worker count. Other agents share this Mac (a versioning server agent on ports 5400–5409, later a History UI
   agent on 5420–5429): note the load (`uptime`) with each timing.

Final reply at most 12 lines: status, **your model ID**, commit range, before → after, concerns.
