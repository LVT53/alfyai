# Handoff: MinerU 4.1 client rewrite and cutover

For a FRESH orchestrator session, after the weekly limit resets (2026-11-09). Written 2026-11-05 by the session that ran the spike.

## Where things stand

- Production runs **MinerU 4.0.12** (`mineru4.service`, 127.0.0.1:8002) and AlfyAI `19bd78b97`+ (`main`); both apps' `MINERU_API_URL` point at :8002.
- MinerU 4.1 is a breaking protocol change. The owner chose "Spike now, build later" on 2026-11-05. The spike is DONE:
  [spike-report.md](spike-report.md) (verdict GO) and `fixtures/` (690 captured answers, `openapi.json`, 130 error probes, tools).
- The plan is DONE: [client-spec.md](client-spec.md): decisions S1 to S10, tasks A to D with file ownership, verification, cutover, rollback.
- Nothing is built. Nothing about MinerU 4.1 is committed. The `docs/plans/mineru-4-1/` folder is untracked in the main checkout
  (`/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai`); a worktree will not have it, so read it there by absolute path or commit it first.
- On the box, left for you: venv `/home/alfydesign/apps/mineru4/.venv-4.1.7` (mineru 4.1.7, Python 3.12.15, `[torch]`), spike MINERU_HOME
  `/home/alfydesign/m41s` (models, telemetry seeded off), `/home/alfydesign/apps/mineru4/uploads-4.1.7`, the spike-only key file
  `mineru41-spike.env`, and `/root/mineru41-spike/start-spike.sh` (transient unit on :8012; stop with `systemctl stop mineru41-spike`).

## The owner's rules for this work (from memory notes; they override defaults)

- The orchestrator writes no code: it plans, dispatches, reviews and tests at checkpoints. Implementers are `model: "sonnet"` agents, one task
  each (2 to 3 steps), committing small. Reviews: `model: "opus"` for Tasks A and B (lost or stuck extractions are the expensive bug), Sonnet for C and D.
  Agents report their model ID. Then an independent review-and-fix pass before production.
- Budget: check `get_usage` before every dispatch; stop dispatching around 94 % of the weekly limit and tell the owner the numbers. When the weekly
  is healthy, do not park work for a 5-hour reset. Measured: about 1.4 % of the weekly limit per small task, all in.
- Gates: `scripts/gates.sh agent <out-dir> --port <base> <specs>` once per task at the end; the release gate on the exact merge commit before
  production. Never run `npm run check` or `npm test` while a build runs. Node 22: `PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- Git: other sessions commit to local `dev` in the shared checkout. Commit only your own paths (`git commit -- <paths>`). Push only when the owner
  asks, and push an explicit SHA (`git push origin <sha>:dev`, `<sha>:main`), never a branch name. `git fetch` and compare both ways first.
- Production steps (deploy, `MINERU_API_URL` flip, unit changes on the box) only in the turn of the owner's own "deploy"/go-ahead; do not
  route around a permission-classifier refusal. Production reads need the owner's OK. Never print a key (`systemctl status` and `ps` show argv).
- Hungarian and English for any new UI string; prompt text the app writes is English only (ruling 79).

## Read first

1. `AGENTS.md`, then `src/lib/server/services/AGENTS.md` and the AGENTS files of the folders a task touches.
2. [client-spec.md](client-spec.md), then [spike-report.md](spike-report.md) §6 (every difference), §8 (restart), §9 (parser check), §10 (gotchas).
3. Memory notes: `alfyai-mineru-4-1-upgrade`, `alfyai-mineru-4-migration`, `alfyai-staging-verify-harness`, `alfyai-deployed-code-is-origin-main`,
   `alfyai-push-explicit-sha-not-branch`, `alfyai-subagent-model-preference`, `alfyai-token-budget-pacing`.

## Order of work

0. `git fetch`; confirm `dev`/`main` state; `get_usage`; check PyPI for a 4.1.x newer than 4.1.7 (spec header says how to handle it).
1. Spec §3: ask the owner about the synthetic 4.0.12 run, run it if allowed, and list the other callers.
2. Task C if §3.1 says production already loses charts (it can ship on 4.0.12 alone); otherwise C runs beside A.
3. Task A, review, fix. Then Task B, review, fix. Then the independent review pass over A+B+C.
4. Task D's unit on :8004 (with the owner's go-ahead), then ai.dev (spec §6 step 2, §5 live list including the restart test).
5. Production on the owner's "deploy" (spec §6 step 3); rollback is spec §6 step 4.
6. Update memory (`alfyai-mineru-4-1-upgrade`, `alfyai-mineru-4-migration`, `alfyai-deployed-code-is-origin-main`) with what shipped.

## Prompt to start the session

> Continue the MinerU 4.1 upgrade for AlfyAI. Read docs/plans/mineru-4-1/HANDOFF.md in
> /Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai and follow it: you orchestrate, Sonnet agents build, Opus reviews the wire and flow tasks.
> Start with step 0 and step 1 of "Order of work", and ask me the open items in client-spec.md §8 before dispatching any agent.
