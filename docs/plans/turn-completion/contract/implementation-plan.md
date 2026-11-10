# Normal Chat completion contract implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. TDD, task review after each slice, broad final review before gates.

**Goal:** Deterministic completion and separate working commentary from answer, with exact-context continuation and no automatic repeat of completed tools.

**Architecture:** Extend existing normal-chat-model and chat-turn seams; preserve native block/step identity into a shared output projection. Share completion and continuation across send/stream and keep browser and durable answer projections consistent.

**Tech Stack:** Existing AI SDK 6, TypeScript, Svelte 5, Drizzle/SQLite, Vitest and Playwright; Node 22.

**Spec:** [spec.md](./spec.md), subject to independent judge approval before Task 1.

## Global Constraints

- No text-length, punctuation, language, or content heuristics determine commentary versus answer. No newline-only patch. No fabricated reasoning.
- No completed tool is rerun automatically by recovery, failover, reconnect or resume.
- Stops outrank pause, which outranks automatic closing.
- No production deployment or production writes. Preserve deployed cost-display fix 40f2d74fc.
- Workers read root/folder AGENTS, use Node 22 and focused tests only, never push/deploy or spawn their own agents. No check/test during build.
- Shared worktree: do not revert another worker's edits. Named-path commits only.

## Review focus

1. Interleaved useful partial conclusions stay available for final synthesis; interrupted provisional text never silently promoted or lost.
2. Tool executed before the final callback/transport error must not run twice; unknown in-flight effect must fail explicitly.
3. Initial-local to cloud failover gates every result and vision input for its actual destination, preserving URL provenance.
4. Reconnect after completion observes durable state and cannot start a new turn; replay truncation cannot fabricate a completed partial answer.
5. Delayed usage/cost receipt includes closing/failover usage exactly once.

## Task boundaries and sequence

| Task | Outcome | Owner write scope | Depends on |
|---|---|---|---|
| 1 | Native structured blocks, continuation and bounded closing at model boundary | `normal-chat-model/`, new shared output types/projection in `src/lib/shared/`, related integration tests | Judge |
| 2 | Server lifecycle uses one completion contract/full-context continuation and durable audit; exact pause/resume and reconnect | `chat-turn/`, server messages/read model/history, analytics, schema/migrations, send/retry adapters, server-focused tests/docs | 1 |
| 3 | Client consumes block roles, transient commentary fades, independent answer persists/Copy/export agrees | `src/lib/services/`, `src/lib/client/`, relevant `src/lib/components/`, chat page, types/i18n, client/component tests | 1; overlaps with 2 only at declared interfaces |
| 4 | Cross-layer regression scenarios and real-model staging runner | `tests/e2e/`, fake-provider fixture owner, `docs/plans/turn-completion/contract/` verification harness | 2 + 3 |

Tasks 2 and 3 can run in parallel only after Task 1 publishes exact event types and snapshot signatures. No concurrent shared-type edits: Task 1 owns those; later amendments routed through the owner. Controller owns plan, ledger, integration and gate commands. Each task has its own brief/report and diff package based on its recorded pre-dispatch HEAD, excluding concurrent other-scope changes when necessary.

## Task 1: Native completion/output and exact model continuation

- [ ] Read judge-approved spec and exact SDK installed source/docs. Write failing real-SDK/neutral-event tests for step identity, preamble/tool/final blocks, budget/stagnation/length/blank exits, native reasoning passback and completed-tool failure/failover execution counts.
- [ ] Implement shared typed block/phase/outcome/stop-cause contract and pure projection in existing shared boundary; publish exact signatures for Tasks 2/3 in report.
- [ ] Implement one bounded no-executable-tools closing call after unfinished exits, exact context/results/reasoning continuation and stop/pause/delivery precedence. Retain normal clean tool-free terminal answers without a second call. Generic tool-free callers outside normal chat must keep their contract.
- [ ] Track actual completed results even if no finished-step callback, reject unsafe in-flight retry, and preserve real usage for all phases. Destination-dependent rendering/gating remains explicit per attempt.
- [ ] Run focused model and SDK integration tests; commit named paths; self-review and report red/green evidence and residual integration requirements. Independent task review and scoped fix loop.

## Task 2: Shared chat-turn lifecycle/persistence/audit

- [ ] Test stream/plain parity, no pipeline re-preparation on recovery, unchanged full evidence/pictures/reasoning, paused inlined prefetch resume, failed/unsaved audit, stop races, delivery, retry semantics, reconnect-completed race and replay ordering/truncation.
- [ ] Thread Task 1 continuation and output contract through prepared runs, original-context repair, ask capture/resume, completion/finalize and send. Remove superseded digest/pipeline recovery logic, not just bypass it with a second implementation.
- [ ] Persist independent answer and versioned block/completion state; retain legacy readability. Durable per-turn/attempt telemetry covers saved and failed/unsaved outcomes without raw content. Use additive schema migration if needed; retain deletion/privacy ownership.
- [ ] Make reconnect observe only, preserve replay identity; on replay unavailable settle saved result explicitly, never generate. Ensure each destination applies existing privacy/vision/provenance policies.
- [ ] Verify usage/cost aggregation and delayed receipt remain correct; update canonical server AGENTS/ADR contract and required technical docs.
- [ ] Focused unit/integration tests, migration verification; commit named paths, report; independent task review/fix loop.

## Task 3: Activity/answer client projection

- [ ] Reproduce client failure as a regression: working `Let me check.` + tool/reasoning + answer `## Result` must never become one Markdown string. Include provisional role settlement after step finish and multiple blocks.
- [ ] Consume stable scoped block IDs and role lifecycle through UI stream contract, client runtime/store and activity/thinking UI. Keep answer Markdown independent and stream explicit answer phase directly.
- [ ] Fade transient commentary at terminal using existing motion conventions and reduced-motion handling; preserve separate interrupted activity and eligible answer partials for stop/failure/pause.
- [ ] Ensure reload, Copy, export and history use canonical answer projection, legacy messages remain verbatim, ask cards and cost-display fix survive. Update EN/HU UI strings and guide only if user-facing controls change.
- [ ] Focused transport/client/component tests covering live, completed, partial, paused, replay and copy/export; commit named paths, report; independent task review/fix loop.

## Task 4: Adversarial integration coverage

- [ ] Deterministic fake-provider browser scenarios for intermediate commentary, Markdown block boundaries, useful partials, exact once side-effect execution, budget/stagnation/length/error/blank closure, stop/pause/resume, reload/reconnect/buffer loss, Copy/export and live/delayed costs. Assert final DOM and stored content as well as SSE metadata.
- [ ] Extend synthetic staging runner to validate same model families across ordinary, shared-conversation, quiet, required closure, pause/resume and interruptions, with exact test IDs and private completion/audit/usage inspection.
- [ ] Focused runner/schema/browser syntax validation, named-path commits/report; independent task review.

## Final verification and release boundary

- [ ] Whole-change independent review from pre-extension baseline (24823203b), with ledger decisions and all reports. Delegate corrections and scoped re-review.
- [ ] `PATH=/opt/homebrew/opt/node@22/bin:$PATH scripts/gates.sh release /tmp/alfyai-completion-contract-gates --port 4810 --workers 6` (full unquarantined browser suite plus all static/build/Fallow/unit gates).
- [ ] Scratch `DATABASE_PATH=/tmp/alfyai-completion-contract.db npm run db:prepare`; no production database.
- [ ] Only after clean gates, push feature branch and deploy exact tested SHA to staging under existing remote-live-testing procedure. Check existing staging revision and production health/read-only release identity; never modify production.
- [ ] Run serial synthetic live-model matrix for DeepSeek flash, Kimi and Qwen; inspect exact test records and bounded staging logs, no secrets. Stop if unresolved structural failures occur, retain evidence.
- [ ] Save acceptance report with tested/deployed SHA, counts, failure details/limits and rollback target. Record that production was not deployed.

## Fixed policy decisions before Task 1

- Total deadline: one absolute deadline from accepted model work using override-aware `requestTimeoutMs` (default 300000ms); no per-phase extension. Reserve `min(60000, floor(totalTimeoutMs / 4))` milliseconds for closing before starting another working step; the working deadline is total deadline minus that reserve. Closing is bounded by the remaining absolute deadline, not an independent fresh timeout. User stop is never interpreted as working-timeout eligibility.
- Closing output: reuse the turn's prepared effective maximum output-token budget and original selected reasoning controls, recomputing fit against accumulated exact context and actual destination maximum context. No quick-depth forcing. If that full reserve cannot fit, return incomplete `context_capacity` rather than reduce/drop evidence. Missing capacity facts use existing model runtime limit owner, not a new hardcoded model table.
- Closing `maxRetries: 0`, no internal provider failover, no tools/active tools/forced tool choice/step-image executable injection; exactly one generation invocation per segment. No closing after content-filter or absolute deadline.
- Settlement UX: all ordinary working text stays activity until positive terminal `stop` proves a no-tool answer; closing streams directly. Every tool attempt invalidates natural-answer settlement, including hidden/unoffered calls. Unknown finish is incomplete.
- Useful working prose is available as separate labeled activity on stopped/paused/incomplete/failed reloads; no fabricated thought-step anchor. Closing synthesis quality is model-dependent, with lossless activity fallback.
- Execution ledger captures dispatch and complete final results independently of SDK step callbacks; uncertain effects never restore executable tools. Explicit fresh retry uses a new requested-turn ID.
- Durable turn audit is mandatory before generation; no owner after restart means interrupted/uncertain, never start-new on observe-existing. Persist idempotent terminal reference even without an assistant row.
- Usage readiness waits for final aggregate. Per-attempt actual model/provider pricing, failed-attempt usage and unknown amounts stay explicit; unsaved costs cannot be counted twice with linked message aggregates.

## Task interfaces that must be published before parallel work

Task 1 owns a shared `NormalChatOutputBlock` / `NormalChatOutputEvent` / `NormalChatCompletion` schema with version, scoped stable IDs, sequence, step phase, block text and explicit settlement. A pure projection computes answer text, inspectable activity and outcome without heuristics. It also publishes model-run continuation snapshot and per-attempt usage/execution types and continuation entrypoint. Task 2 owns durable IDs, storage and per-destination policy preparation; Task 3 consumes the projection/events and does not determine final roles itself. Exact exported names/signatures are finalized by Task 1's reviewed report and copied into later briefs. Both downstream tasks must include judge-resolution requirements above.

### Scheduling refinement

Task 4's deterministic provider fixtures and black-box browser assertions can be authored while Task 1 runs: their contract is user-visible behavior, not pending internal types. They own only tests/fixtures, tests/mocks, and a new browser spec. They must not build/check/run e2e concurrently with model-focused tests; red evidence is the existing real-function reproduction. Final browser execution and Task 4 acceptance wait for Tasks 2/3. This reduces idle time without sharing implementation files.

### Server slice refinement

Task 2 is split by write ownership into 2A (durable turn/attempt ledger and actual-model accounting) and 2B (lifecycle/context/reconnect integration). 2A can run before Task 1 completes because its durable IDs, terminal record and per-attempt usage requirements are fixed by the judged spec, independently of model invocation signatures. It owns schema/migrations, analytics and one chat-turn ledger module; 2B owns the remaining chat-turn lifecycle and consumes 2A's reviewed interface. This avoids a single worker spanning accounting, schema and all stream/resume logic. Both get independent task reviews; no concurrent writes to shared server files.

### Reviewed-interface scheduling

Task 1 review accepted its public ownership/interface shape but found three internal correctness defects. Its implementer fixes them without changing published signatures. Tasks 2B/3 may work in disjoint scopes against that frozen contract concurrently; their final acceptance still requires the corrected model review. No finding is waived or marked complete, and any required interface amendment is coordinated before integration.

## Bounded prepared output reserve — controller-selected integration fix

Ruling: resolve a finite positive Normal Chat output cap before context preparation, using the positive selected model setting, then the positive provider setting, otherwise `C - deriveDefaultTargetConstructedContext(C)` from the existing finite model-context owner (provider window first, then the selected runtime window, matching Model Run). This is an application policy, not a provider-capability claim. Missing/nonfinite/nonpositive settings fall through; positive fractional settings normalize to integer tokens under the existing convention. Why: an absent limit previously reserved zero in preparation and then failed Model Run before SDK dispatch. Cost if wrong: the application fallback may be below or above the provider-native default; an explicit cap overrides it.

`context-budget.ts` owns candidate resolution; the shared `prepareNormalChatTurn` applies it to a runtime copy before preparation. Existing target/input clamps produce the effective cap, and that exact positive value binds the SDK request, continuation snapshot and closing phase. Generic nullable budgets/model callers and selected reasoning controls are unchanged. A positive captured cap stays frozen across destinations; old missing/invalid captures receive repaired reserve metadata without refetching or rebuilding canonical evidence. Destination fit remains mandatory, with no absent-limit bypass or smaller-destination cap reduction.

Validation remains estimator-based: this fix does not add tokenizer or serialized tool-schema accounting, and does not establish that an ordinary tool catalogue fits an 8k window. The existing Model Run margin and full-context capacity refusal remain authoritative for this change.
