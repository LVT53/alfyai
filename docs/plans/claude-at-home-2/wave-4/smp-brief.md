# Agent SMP · every internal model call takes the provider family's one sampling profile

**Not Feature 2.** This fix branches from `dev` and merges into `dev`. The owner (2026-10-05): chat turns already send
the qwen adapter's `defaultSampling` (temperature 0.6, top_p 0.95, top_k 20 — `src/lib/server/services/normal-chat-model/provider-compatibility.ts`,
first shipped in `476f70c1`), but the control-model and utility paths build their own requests and send no sampling, so
they run at the checkpoint's `generation_config` temperature 1.0, and short snippets a person reads come out garbled
("Rägyvágok").

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/smp`, branch
  `fix/internal-call-sampling` (from `dev` `27274c0e`), e2e port **5400**, label `smp`, real-model tunnel local port
  **30401**.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/smp-report.md`
  (the live probe's script and raw output beside it, in `…/scratchpad/w4/smp-probe/` — outside the repo).
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` and the Wave 3 rules it points to — **read both from the
  `art-base` worktree** (`/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-base/docs/plans/…`;
  `dev` does not carry the plan docs). Then AGENTS.md's lines on `normal-chat-model/`, `normal-chat-control-model.ts`,
  `provider-model-runtime-defaults.ts` and `task-state/control-model.ts`. Nothing of the slice specs applies to you.
- Already known, so you start ahead: `normal-chat-control-model.ts:~360-400` (`sendJsonControlMessage`) applies the
  family's temperature and top_p but check whether `top_k` reaches the wire (the chat path injects `top_k` into the body
  through the provider's `transformRequestBody` — `normal-chat-model/index.ts:~1275-1295, ~1589-1612` — because the
  openai-compatible provider has no call option for it); `artifacts/app/contract.ts:~227-236` keeps **its own copy** of
  the numbers (`topK: 20`) and `artifacts/app/generate.ts:~368-396` has a top_k-rejection retry; `42205adb` fixed the
  context summarizer's client once. The model-call builders on `dev`: `git grep -l -E 'generateText|streamText|generateObject|chat/completions|createOpenAICompatible|sendJsonControlMessage' -- 'src/lib/server/**/*.ts' ':!*.test.ts'`.

## Steps

1. **Inventory, then red tests.** Find every server-side model request that does not go through the chat turn's own
   run: at least the thought-step status lines and classifier, the rail summary and turn acknowledgement
   (`short-local-text.ts`), title generation, context compression, the memory judge and consolidation (and
   recuration), the task-state control model, the ChatGPT-import summarizer, the App generator and verifier, the
   Document and Canvas `@Alfy` replies, and anything else the grep finds. For each, write down what reaches **the wire**
   today (temperature, top_p, top_k in the request body, read through a fake `fetch` — not what the code seems to pass).
   Write one test per path that asserts the body carries the family profile, and see each one fail where it is missing.
2. **One profile, one route to the wire.** Make every path take the provider family's sampling profile from the one
   place it is declared (`provider-compatibility.ts`'s family adapter) through one shared helper that the chat path
   uses too — temperature, top_p **and** top_k (top_k by the same body injection the chat uses). Never a second copy
   of the numbers: fold `app/contract.ts`'s copy into the profile. A family with no profile sends what it sends today
   (pin that with a test). **Ruling (orchestrator):** an explicit temperature a caller sets for a deterministic
   machine-read answer (a JSON classification) may stay, listed in your inventory with its reason; every path whose
   output a person reads — status lines, the rail summary, titles, replies, summaries, Apps, `@Alfy` notes — takes the
   whole profile, temperature included. Add one line to AGENTS.md's `normal-chat-model/` bullet naming the helper as
   the only way an internal call gets its sampling.
3. **Before/after on the real model.** Through `ssh -N -L 30401:192.168.1.96:30000 alfyroot` (in the same command as
   the probe; model `qwen3-6-27b`), send the real prompts of at least three person-read paths (a Hungarian thought-step
   status line, a Hungarian title, the rail summary) N ≥ 10 times each with the old body (no sampling) and the new one
   (the profile), and report samples plus a simple garble count (e.g. letters outside English and Hungarian, like
   "ä"; words that are neither). Bounded and sequential; the probe lives outside the repo.

Then the full gates once (Wave 3 rules' list, Playwright with `tests/e2e/streaming.spec.ts` and every artifact suite
added, since the App and `@Alfy` paths change). Your report's inventory table: path · file:line · wire before ·
wire after · test name.

**Runs beside you:** agent TR-A on `feat/artifacts-tours` (tours server routes, campaigns, the archive) — no shared
files; do not touch theirs.
