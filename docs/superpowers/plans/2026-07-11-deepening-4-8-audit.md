# Plan: Architecture deepening — #8, #4, and #3-audit

**Branch:** `deepening-3-4-8` (off `main`)
**Date:** 2026-07-11
**Method:** Subagent-Driven Development with TDD

## Context

This plan executes three tasks from the 2026-07-11 architecture review. The
original review proposed candidates #3, #4, and #8. A pre-flight scan
discovered that **candidate #3 (finalize.ts duplicated post-turn fan-out) was
already completed on `main`** by commit `2d7b48be` ("arch-hardening C5:
narrow finalizeChatTurn to one post-turn path"). The user directed: drop #3
as an implementation task, do #8 and #4, AND audit the existing #3 refactor
for rough edges.

All three tasks target the `src/lib/server/services/chat-turn/` subsystem.

## Global Constraints

These bind every task. Copy verbatim into reviewer prompts.

- **Typecheck gate (AGENTS.md):** `npm run check` must be 0 errors, 0 warnings. New `svelte-check` diagnostics are regressions.
- **Lint gate (AGENTS.md):** `npm run lint` (biome) clean.
- **Test gate:** `npm test` (vitest run) fully green. Test output must be pristine — no stray warnings or noise.
- **Build gate (AGENTS.md):** `npm run build` produces zero warnings from Vite, Svelte, TypeScript, or any plugin.
- **Commit discipline (AGENTS.md):** small, focused chunks. One logical change per commit. Messages explain the *why*. Never push without explicit user request.
- **TDD:** RED → GREEN → REFACTOR for any logic change. Pure deletions and doc edits do not require new tests but must keep the existing suite green.
- **Fallow gate (AGENTS.md):** run before calling a patch finished. New findings are regressions unless intentional/documented.
- **Behavior preservation:** these are deepenings, not behavior changes. No route, SSE, DB, or component-contract changes. The observable behavior of chat send/stream/retry must not change.
- **AGENTS.md boundary rule (relevant to #4):** "Shared behavior should exist once. Do not copy logic between `send` and `stream`." The dedup directly honors this rule.
- **Svelte 5 / no legacy syntax:** any touched Svelte file (none expected here) must follow Svelte 5 rules.

## Tasks

### Task 1 (#8): Remove dead `reasoning-depth-evaluation.ts` + amend ADR-0036

**Severity:** Speculative (cleanup). Lowest risk, do first.

**Problem:** `src/lib/server/services/chat-turn/reasoning-depth-evaluation.ts` (516 LOC) is imported by NOTHING in production — only its own test file `reasoning-depth-evaluation.test.ts`. It is an offline fixture-driven evaluation harness for the depth classifier, living in the runtime pipeline directory where it misleads anyone tracing "how depth gets decided." Separately, ADR-0036's title ("not a parallel background subsystem") and Decision's final clause ("and no parallel subsystem") directly contradict the shipped `atlas/worker-runner.ts` + `job-ledger.ts` + `checkpoints.ts` background-job runtime.

**This task does NOT change runtime behavior.** It deletes dead code and corrects documentation that contradicts the code.

#### Steps

1. **Delete both files:**
   - `src/lib/server/services/chat-turn/reasoning-depth-evaluation.ts` (516 LOC)
   - `src/lib/server/services/chat-turn/reasoning-depth-evaluation.test.ts` (~275 LOC)

2. **Verify nothing else references them:** grep `src/` for `reasoning-depth-evaluation` after deletion. The only hit pre-deletion is the test importing the impl. There is a SEPARATE, UNRELATED script `scripts/evaluate-reasoning-depth-ab.ts` that defines its own symbols and must NOT be touched.

3. **Amend ADR-0036** (`docs/adr/0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md`):
   - **Title:** change `# Atlas is a Normal Chat Turn + artifact, not a parallel background subsystem` → `# Atlas is a Normal Chat Turn + artifact backed by a single in-process background worker, not a duplicated parallel subsystem`
   - **Decision paragraph, final sentence:** change `There are 2 Atlas-owned tables (not 16), no duplicated model runner, no plan approval gate, and no parallel subsystem.` → `There are 2 Atlas-owned tables (not 16), no duplicated model runner, and no plan approval gate; Atlas runs its pipeline inside a single in-process background worker (claim/heartbeat/recovery against atlas_jobs, durable checkpoints in atlas_round_checkpoints) that reuses the existing normal-chat model runner, rather than the old 60-second-tick parallel subsystem with its own model runner.`
   - Do NOT change the Consequences section or Resolved Branches — those already accurately describe the background job.

4. **Run gates:** `npm test` (must stay green — the deleted test file is gone, suite shrinks by its test count), `npm run check`, `npm run lint`.

#### Tests

No new tests — this is a deletion. The test suite must remain green after removing the two files. No other test imports the deleted module.

#### Acceptance

- Both files deleted.
- `grep -rn reasoning-depth-evaluation src/` returns nothing.
- `scripts/evaluate-reasoning-depth-ab.ts` is untouched (it is unrelated).
- ADR-0036 title + Decision final sentence amended as specified; Consequences/Resolved Branches untouched.
- `npm test`, `npm run check`, `npm run lint` all green.

---

### Task 2 (#4): Dedup streaming model-run against shared helpers

**Severity:** Strong. Moderate risk — touches the streaming chat path. Do second.

**Problem:** `streaming-normal-chat-model-run.ts` (376 LOC) has a 215-line inline body (`runStreamingNormalChatSendModel`, lines 112-327) that re-implements, step by step, the same sequence the plain path already factored into 6 named private helpers in `plain-normal-chat-model-run.ts` (593 LOC): `resolveProviderRuntime`, `evaluateClarification`, `resolveActiveDepthEffort`, `prepareOutboundContext`, `createToolPack`, `runDeliberationIfNeeded`. Two comment blocks are literally byte-identical between the files (the "Issue 8.1" connections comment and the "Read-side master gate for the recall tool" fail-open comment). A change to depth-clarification gating, context prep, or tool packing must be made in two places.

**The load-bearing constraint (do NOT silently change):** the streaming param type `StreamingNormalChatSendModelParams` deliberately OMITS `disableTools` and `forceProduceFileTool`. The streaming path never forces `produce_file` tool-choice, and its test at `streaming-normal-chat-model-run.test.ts` line ~637 ("leaves tool choice automatic for explicit file requests") asserts this. The dedup MUST preserve this: the streaming path must continue to behave as if `disableTools: false` and `forceProduceFileTool: false` always.

#### Approach: move the 6 shared helpers into the existing shared module

The codebase already has `shared-normal-chat-model-run-helpers.ts` (122 LOC) holding the 4 pure stateless helpers both paths use (`isEvidenceReadyToolCall`, `createRequestAbortSignal`, `resolvePromptModelConfig`, `resolvePromptContextLimits`). The 6 larger helpers currently private in `plain-normal-chat-model-run.ts` are also effectively pure (they take `params` and delegate to imported services). Move them to the shared module so neither send-model file imports from the other. This matches the existing convention and keeps the dependency graph flat.

To handle the `disableTools`/`forceProduceFileTool` divergence cleanly: the shared helpers must be parameterized by a **common base param type** that includes the fields both paths share, plus `disableTools?: boolean` and `forceProduceFileTool?: boolean` as OPTIONAL fields defaulting to `false`. The plain param type (`PlainNormalChatSendModelParams`) already has them; the streaming param type does not and will gain nothing — instead the streaming entry point passes a normalized object `{ ...params, disableTools: false, forceProduceFileTool: false }` to the shared helpers. This preserves streaming behavior exactly.

#### Steps

1. **Define a shared base param type** in `shared-normal-chat-model-run-helpers.ts` (e.g. `NormalChatSendModelBaseParams`) containing every field common to both `PlainNormalChatSendModelParams` and `StreamingNormalChatSendModelParams`, plus optional `disableTools?: boolean` and `forceProduceFileTool?: boolean`. Both existing param types should extend or be assignable to this base. (Judge at implementation time whether `extends` or structural assignability is cleaner; do not over-engineer.)

2. **Move the 6 helpers** from `plain-normal-chat-model-run.ts` into `shared-normal-chat-model-run-helpers.ts`, exporting them: `resolveProviderRuntime`, `evaluateClarification`, `resolveActiveDepthEffort`, `prepareOutboundContext`, `createToolPack`, `runDeliberationIfNeeded`. Move their local type aliases (`ProviderRuntime`, `ToolPack`, `PreparedModelContext`, `ClarificationDecision`, `DepthEffort`) too. The helpers take the base param type.

3. **Keep path-specific helpers where they are:** `buildClarificationResult`, `runPlainModelRun`, `maybeRepairFinalAnswer`, `buildRunResult` stay in `plain-normal-chat-model-run.ts` (plain-path-specific result shaping). The streaming wrappers (`createSyntheticTextStream`, `withOptionalAssumptionPrefix`, `withDeliberationUsage`) stay in `streaming-normal-chat-model-run.ts`.

4. **Rewrite `runStreamingNormalChatSendModel`** (lines 112-327) to call the shared helpers in sequence, passing a normalized param object. Keep ONLY what is genuinely streaming-specific: `deliberationElapsedMs` capture, the `runStreamingNormalChatModelRun(...)` call, the stream wrappers, and the `StreamingNormalChatSendModelResult` assembly. The clarification-ask early-return must still emit a synthetic stream.

5. **Preserve the `forceProduceFileTool` divergence explicitly:** the streaming entry passes `forceProduceFileTool: false` (or omits it → defaults false) so `createToolPack` and `prepareOutboundContext` behave exactly as today. Add a one-line comment at the normalization site explaining why (test at line ~637 encodes it).

6. **Update both test files only if needed:** `plain-normal-chat-model-run.test.ts` (22 tests) and `streaming-normal-chat-model-run.test.ts` (16 tests) mock at the service boundary, not the helper boundary, so they should stay green. If a helper move breaks a `vi.mock` path, adjust the mock import path only — do not weaken assertions. The streaming test's "leaves tool choice automatic" assertion MUST stay green and is the regression guard.

#### Tests (TDD)

This is a refactor, not new behavior. The TDD discipline here is **characterization first**: before moving anything, confirm the existing streaming test suite is green (the baseline). After the refactor, the same suite must be green — that IS the green phase. If any test goes red, the dedup changed behavior and must be corrected.

- RED baseline: `npx vitest run src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/plain-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.test.ts` — all green BEFORE the refactor (capture the count).
- GREEN: same command after refactor — same count green.
- Regression sweep: `npx vitest run src/lib/server/services/chat-turn/` — the full chat-turn suite (incl. `stream-orchestrator.test.ts`, `stream-fallback.test.ts`) must stay green.

#### Acceptance

- `streaming-normal-chat-model-run.ts` no longer contains inline copies of the 6 steps; it calls shared helpers.
- The "fail open" recall-tool comment appears ONCE (in the shared `createToolPack`), not twice.
- The "Issue 8.1" connections comment appears ONCE (in the shared `prepareOutboundContext`), not twice.
- `streaming-normal-chat-model-run.test.ts` "leaves tool choice automatic for explicit file requests" test is green and unchanged.
- All chat-turn tests green. `npm run check`, `npm run lint`, `npm run build` clean.
- The observable behavior of streaming chat is unchanged.

---

### Task 3 (#3-audit): Audit the existing finalize refactor for rough edges

**Severity:** Read-only review. Do third (can run in parallel with Task 2 review since it touches no code unless it finds something).

**Context:** Commit `2d7b48be` already collapsed the two mirrored finalize branches into a shared `runPostTurnProjection` + `runPostTurnTail`, and extracted step implementations into `finalize-steps.ts` (338 LOC). This task AUDITS that already-shipped refactor — it does not assume there is anything wrong.

#### Scope of audit

Read-only review of:
- `src/lib/server/services/chat-turn/finalize.ts` (780 LOC) — the `runPostTurnProjection` closure (lines ~547-690), `runPostTurnTail` (lines ~695-721), and the two thin wrappers (lines ~723-779).
- `src/lib/server/services/chat-turn/finalize-steps.ts` (338 LOC) — the extracted step implementations.
- `src/lib/server/services/chat-turn/finalize.test.ts` (~1746 LOC) — coverage of both paths.

Check for:
1. **Any remaining duplication** between the deferred and eager wrappers that could be collapsed further.
2. **The one intentional divergence** (deferred path swallows context-source errors; eager path does not) — is it clearly commented and minimal?
3. **Test coverage** of the deferred path — the prior audit found only ONE test exercised `deferPostTurnProjection: true`. Is that adequate, or is there a gap?
4. **Step ordering correctness** — does `runPostTurnProjection` run steps in the same order the old duplicated code did? Any subtle reordering bug?
5. **The `finalize-steps.ts` extraction** — clean separation, or did shared state/context leak across the module boundary?

#### Outcome

The audit produces a findings report. If it finds ONLY Minor issues or nothing, the task is complete with no code change (record findings in the ledger). If it finds an Important or Critical issue (e.g. a real reordering bug, a missed guard, a silent error-swallow that shouldn't be there), escalate to the controller who will dispatch a fix subagent. **Do not invent work** — if the refactor is clean, say so plainly.

#### Tests

None (read-only). If a fix is dispatched as a result, that fix follows TDD against `finalize.test.ts`.

---

## Execution Order

1. Task 1 (#8) — implementer → reviewer → ledger.
2. Task 2 (#4) — implementer → reviewer → ledger.
3. Task 3 (#3-audit) — dispatched as a read-only reviewer (most capable model); findings drive whether a fix task opens.
4. Final whole-branch review (independent judge sub-agent, most capable model) across all commits.
5. Commit per task (small focused chunks). The user said "Then commit" — commit each task's work as it completes, then a final squashed/sequential set on the branch.

## Pre-flight Conflicts Noted

- **Candidate #3 was already done on main.** Resolved with the user: drop as implementation, keep as audit (Task 3).
- No other conflicts. Tasks 1, 2, 3 are independent and touch different files.
