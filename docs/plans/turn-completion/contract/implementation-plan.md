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
- [ ] Run serial synthetic live-model matrix for DeepSeek flash, Kimi and Qwen; inspect exact test records and bounded staging logs, no secrets. Under the superseding 2026-11-10 instruction below, retain failure evidence and continue diagnosing/fixing/reviewing/revalidating gate or staging issues until intended behavior works; do not mark unresolved failures accepted. Production remains forbidden.
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


## Dated scope clarification — 2026-11-10, gate 4 candidate b5599daad

The owner's latest explicit instruction authorizes continued diagnosis, fixes, review and verification of **any full-gate or staging issue until the intended behavior works**. This supersedes the earlier stop-on-broader-staging-failure policy. Historical instruction (superseded): “Stop if unresolved structural failures occur, retain evidence.” Historical stop decisions and failed runs remain recorded evidence; they are not the current execution instruction. Preserve evidence and regression assertions, correct the responsible existing owner, and repeat the affected validation/full gate as needed rather than treating partial green output as acceptance.

Only after a fully green local gate may the controller push/deploy the exact tested SHA to **staging**, then run rigorous serial synthetic DeepSeek flash/Kimi/Qwen checks with scoped completion/attempt/saved-receipt audits. Any newly found issue follows the same fix/review/revalidate loop. Production deployment and production writes remain forbidden. Final acceptance requires actual terminal gate and staging evidence. Gate 4 at `b5599daad` subsequently PASSED and that exact release is healthy on staging; it does not certify later source fixes. Fresh gates, redeployment and the complete matrix remain required after the now-reviewed source corrections; the latest checkpoint below records gate 5 running. Documentation-only workers remain unauthorized to run tests, gates or remote actions.

**Ruling — phase-specific edit reveal with mandatory fast live-end coverage:** preserve the initial edited-question reveal assertion (original seed/edit/scroll/viewport and 10s threshold) while the real response is held, then release and require actual settlement. Retain the permanent immediate-terminal case unchanged as a countercheck that status/actions at the new live end remain usable above the composer before first alignment; preserve follow-tail behavior. The measured-composer-height clearance fix `7174fa33b` retains its 10.5rem baseline. This is not a new permanent-question-retention policy. Cost if wrong: phase isolation could mask fast completion clipping; the explicit permanent fast case is mandatory protection. Controlled probe stream-ID substitution limits protocol claims, not its observed geometry. Final scoped judge PASS is recorded in `viewport-policy-final-review.md`; paired browser 2/2 PASS is controller evidence, not a passing full gate.


### Staging checkpoint — 2026-11-10, documentation consolidation

Gate 4 passed at `b5599daad` (25,615 unit passed/3 skipped; 1,587 browser passed/75 skipped/0 failed/0 flaky; zero type/build warnings; Fallow four known/zero new). That exact SHA is healthy on staging, rollback `e2045e1da`; production remains `40f2d74fc`, untouched. Later plain-timeline `7cc746c98` and refusal-certainty `0a64d1d6c` fixes have independent approval, not fresh integrated gate/deployment acceptance.

Historical checkpoint: controlled terminal-before-file/job-to-assistant linkage and two failure-handling P1s required source corrections. Those scoped blockers are now independently accepted at `11a72a046`; the selected contract and current release boundary are recorded below. The original reproduction remains valid evidence, not a reason to restore snapshot ownership inference or poll around the race.

Reviewed harness SHA-256 `f5f7807a86565c8cb50131584bd0cc9c041f7770d01cdc7da34d9611f538d0f9` has 108 focused tests. Controls 9 HTTP passes and evidence/pause 9 HTTP passes with 12 ready segments/12 attempts (104,055 micros) are diagnostic subsets only. Preserve original H1 failure as model omission, not storage loss; the undefined-ID controller 404 was ruled out as an app defect. Neither historical failure is retroactively passed. Final results belong in [verification.md](verification.md); no production action is authorized.


### Accepted source / gate 5 checkpoint — 2026-11-10

Completion/file source is committed with scoped independent acceptance at **`11a72a046a361027d99af14ff11751416719272e`**; the later gate-5 session-expiry finding below does not reopen those approvals. The [selected current file-linkage contract](durable-file-linkage.md) at the top of that specification supersedes its historical amendments: only exact job IDs in the current occurrence's trusted raw producer records authorize association (including known failed/pending receipts); no start/late snapshot inference or unsafe plain empty baseline remains. Scope/export/other-assistant guards still apply. Both transports establish critical durable file linkage/canonical readback before terminal publication; heavy stream projections stay deferred.

Critical failure after assistant save atomically records separate `normalChatFinalization` (`failed` / `file_association_failed` / sampled `wasStopped`) with known saved identity/accounting, preserving immutable model completion/attempt usage and raw answer. Live Stop, wire/observe/reload/Copy/export agree; persistence-only failure cannot trigger generation Retry or automatic queue replay. Secondary storage errors do not imply durable success. This stays in existing owners, without a generic framework. Server final review PASS: 459 tests/11 suites, full check 0/0, Biome 18 clean. Client `f9fbaf0f0`, `37a550091`, `9e7061096` accepted with 606+10+19 focused tests.

**Gate 5 completed FAILED (exit 1/15m57s):** `scripts/gates.sh release /tmp/alfyai-completion-contract-gates-5 --port 4810 --workers 6`, console `/tmp/alfyai-completion-contract-gates-5-console.log`. All static steps passed, check/build zero warnings and Fallow four known/zero new. Units 25,767 passed/3 skipped (1,319 files passed/1 skipped); browser 1,586 passed/75 skipped/1 failed/0 flaky. The sole failure is duplicate identical session-expiry alerts; no deployment is authorized from this failed gate. At that historical checkpoint, staging and feature remote still held `b5599daad`; production remained `40f2d74fc`, untouched. The superseding gate6/deployment checkpoint below records current state. After a fully green new gate, deploy that exact tested feature SHA to staging, then complete the full frozen-runner 30-scenario matrix and scoped read-only audits, including immediate file visibility. Earlier diagnostic subsets are not final acceptance. Continue fixing all discovered gate/staging issues through convergence; production remains forbidden.


### Gate 5 bounded blocker / gate 6 required — 2026-11-10

`session-expiry.spec.ts:26` exposed two identical expiry toasts, not selector ambiguity with an unrelated toast. At this historical checkpoint Curie owned investigation/fix with Helmholtz judging; initial hypotheses were not established causes. The selected auth response-authority fix and final approved commit are recorded below. Preserve strict assertions: no loose selector, `.first()`, retries or failure waiver. Earlier completion/file review approvals (server459/11 and client606+10+19) remain accepted in scope; the session blocker was then open and is now resolved by `8fed848dd`.

Obtain the reviewed fix and targeted browser evidence, then complete **full gate 6** before any new staging deployment. At that checkpoint stage/remote feature ref remained b559; production40f untouched. Current push/deployment state follows below. The latest fix-all-gate/staging-issues authority persists; fresh exact-SHA deployment and the entire frozen-runner30-scenario matrix/audit remain pending. Gate5 output/console stay at the recorded paths; preserve its FAILED history, never retroactively pass it.


### Historical gate 6 PASS / deployment-start checkpoint — 2026-11-11

**Full release gate6 PASS at `8fed848ddb3c77690b9c28fdfbaa33e23aabb3af`, exit0/15m56s**, `/tmp/alfyai-completion-contract-gates-6` (`--port4810 --workers6`). Units25,790 passed/3 skipped, 1,319 files passed/1 skipped (10m21s); browser1,588 passed/75 skipped/0 failed/0 flaky (15m38s). All static steps PASS: check0errors/0warnings across9,096files, build18s/0compilerwarnings, Fallow3.33.1 four unchanged known/zero new; Biome one pre-existing informational diagnostic, migrations/chunks PASS. Gate5 remains FAILED historically; it is not retroactively passed.

Auth response authority is independently SPEC/QUALITY/deep-owner PASS at `8fed848dd`, matching the reviewed committed diff:330 focused tests/6files plus6 actual session-expiry browser cases (including controlled delay), Biome13 clean. [Selected auth spec](session-response-authority.md) uses existing request-generation ownership across production auth paths, preserving original Response identity with no extra Promise/microtask; no selector weakening/new Retry. Prior completion/file approvals remain intact.

At this historical checkpoint the controller pushed **exact8fed848ddb3c77690b9c28fdfbaa33e23aabb3af to origin/fix/turn-completion only**, exit0, and atomic staging deployment had started but was not yet verified complete. The superseding completed-deployment/HTTP-audit checkpoint follows below; log `/tmp/alfyai-completion-contract-staging-deploy-8fed848dd.log`; rollback target `b5599daad`. Await terminal deployment exit, exact release identity and health. Production remains `40f2d74fc`, untouched/forbidden; no main/dev push.

At that checkpoint deployment verification, the full public30-scenario matrix at https://ai.dev.alfydesign.com, generated-ID read-only staging audit and temporary browser UI checks were pending. The deployment and HTTP/audit are now PASS as recorded below; only UI verification remains pending. Capture immediate file visibility, semantic known answers/canonical bodies, pending-stop costs and complete final counts. Prior b559 diagnostic subsets do not certify this release. Continue fixing any gate/staging issue until intended behavior works; no final acceptance or documentation commit yet.


### Staging full HTTP/audit PASS; temporary UI pending — 2026-11-11

Atomic deployment of exact **8fed848ddb3c77690b9c28fdfbaa33e23aabb3af** completed exit0; migrations/health PASS, stage `releases/8fed848dd`, frozen f5 runner checksum verified. Public health idle/not draining. Rollback `b5599daad`; production rechecked `releases/40f2d74fc`, unchanged. Sanitized last30min journal1,286 lines had zero UnhandledPromiseRejection/uncaughtException/SQLITE_CORRUPT/FATAL matches; this is a bounded observation, not universal absence of errors.

The full PUBLIC30 HTTP matrix PASSED (27 answered/3 stopped) and exact-ID read-only audit PASSED33 segments/33 attempts. Evidence `/tmp/alfyai-completion-contract-staging-evidence/full-8fed848dd.json`, status `verified-http-and-audit-with-pending-stop-usage`. Known subtotal196,565micros;3pendingStopSegments/3pendingUsageAttempts with costUsdMicrosNULL and fullyPricedfalse are expected cancellation facts, not zero/free usage or a complete total. Earlier b559 subsets and failed H1/probe runs retain their historical dispositions.

**Current UI result:** run3 passes all3 desired behavior cases (Kimi/DeepSeek exact initial/reloaded Copy, DeepSeek exact Python call row, exact assistant file card), with zero HTTP/console/page/blocked-request errors. Missing model icons were repaired on staging only:3 exact-hash asset rows/files (2 icons+source parent), existing stage-admin uploader and source graph retained; production strictly read-only. App source remains8fed.

**Only verifier navigation control remains pending:** sole guard failure is static-chunk ERR_ABORTED during verifier reload; exact public chunk returns HTTP200. Worker is tracking request/navigation authority, not broadly ignoring aborts. Earlier verifier render-wait/blocked-timezone-write defects were corrected without weakening behavior assertions; preserve prior failed reports. Do not describe an outstanding application API regression. Await final verifier guard evidence, then controller review and explicitly instructed documentation commit. Production remains forbidden.


### Final scoped staging acceptance — 2026-11-11

Supersedes all pending checkpoint wording above. Final browser run4 PASS, exit0 (`/tmp/alfyai-completion-stage-ui-run4.json`): three cases/seven exact Copy checks; Kimi and DeepSeek independent answers before/after reload, exact saved Python activity, exact assistant file card. Zero HTTP/console/page/request/blocked errors. Public chunk readable200; ownedChunkWaits empty, so the previous abort race was not proven exercised. Earlier verifier failures remain historical; strict health assertions retained. Staging-only imported model-icon graph repaired (three exact-hash rows/files, existing stage-admin uploader); no app source change. Temporary browser state removed locally/remotely.

Gate6/full30 real-model matrix/33-segment33-attempt read-only audit and final UI all PASS on8fed. Final health OK, active0/not draining. Production remains40f2d74fc; no production deployment/writes. Scoped implementation accepted; architecture report anchor updated with done/partial/open ownership. General admission,07–10 and generic callers remain open; no semantic-quality/universal exactly-once guarantee. Unknown usage on three stopped attempts remains pending. Documentation-only closeout follows controller review; tested staging source stays8fed.

### Superseding follow-up checkpoint — 2026-11-11

Current source/staging is `db1ea559685486d55f6c0e0a015cb6f7135ccc18`; the earlier `8fed848dd` final handback is historical. R0/R1/R2/R2b passed independent Astra source review and full gate 12. Same-old-reply accounting/immutability checks and the new original 30-case matrix passed. The paired wider comparison retains two failures, including an unattributed Kimi wrong-topic answer; new native live browser acceptance is still pending after verifier defects. See the current table at the top of [verification.md](verification.md), rather than older completed-checkpoint text, for exact evidence and remaining obligations. The requested architecture skill phase is authorized and remains required after functional UI validation. Include the newly identified accounting-to-history failure dependency in a judged reliability/deepening pass. No speculative provider patch, semantic retry, production deployment or production write is authorized by this checkpoint.
