# Context Exhaustion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task under the controller's execution method. Steps use checkbox (`- [ ]`) syntax for tracking.

**Delivery state:** Task 1 has controller-confirmed SPEC + QUALITY PASS at `1570d5264`, including the late-image guard. Task 2 has final SPEC PASS and is implemented with focused worker verification; independent implementation/final reviews and the controller-owned full gate remain pending. No push or deployment. Historical broader Task1 matrix items remain unchecked where its narrowed report did not claim them.

**Goal:** Bound NEW research/fetch views against aggregate remaining room and recover through lossless closing; preserve existing captures and honest irrecoverable failures.
**Architecture:** One completion owner measures projected requests and allocates read leases; existing web shaping and envelope owners finalize bounded new views before capture. Both transports share lossless closing and existing execution/privacy/persistence owners.
**Tech Stack:** TypeScript, installed AI SDK 6.0.193, Vitest fake-provider fixtures; no dependency change.
**Spec:** [Context exhaustion design](../specs/2026-11-18-context-exhaustion-design.md).

## Global Constraints

- No automatic replay/refetch, post-capture digests/truncation, generic result store, preparation pipeline or smaller-destination bypass. NEW web views may select whole units or explicit prefixes before capture under the explicit fidelity amendment.
- One tools-disabled closing per segment; original deadlines/reasoning controls; M=4,096; proposed minimum closing output min(O,1,024); preserve frozen snapshot O.
- Keep initial oversized-schema rejection, full-evidence failure, delivered artifacts, read-only/refusal/deadline fixes and destination gates intact.

## Review Focus

- NEW oversized/sequential/parallel reads must succeed with truthful bounded views when reserved input fits; old oversized captures remain exact and may fail.
- Pending image inserts included once in the closing input and capacity calculation.
- Freeze one pool per projected step; leases follow proposal order with no refunds, independent of network completion; fully settle parallel work before closing.
- Stop/pause/deadline precedence, resume allowance and destination privacy/cap restrictions.
- Bounded view equality across envelope/recorder/capture/wire, selected-only evidence/provenance, and conditional no-dispatch accounting; missing usage stays unknown.

---

### Task 1: Implement and verify lossless capacity closing

**Files:** `src/lib/server/services/normal-chat-model/completion.ts`; optional pure arithmetic in existing `context-guard.ts`; existing `tests/integration/normal-chat-completion.test.ts` and `normal-chat-completion-sdk.test.ts`. Use current fake-provider fixtures; no preparation/route/tool/persistence redesign in this slice.

**Interfaces:** Preserve public completion policy/snapshot/output shapes. Factor the exact projected-input and closing allocation owner; Task 2 consumes its `measureRequest(input, tools)` projection/count result defined in the spec, without duplicating math. Closing uses invocation-local C while captured prepared cap remains O.

**Red regressions:**

- [x] Add a new RED parameterized plain/stream regression with maxToolSteps above one. First provider step emits working prose and one settled lookup; choose result/schema sizes so initial request fits, the next working request does not, and complete closing with O does. Assert exactly two provider calls, one execution, second request has no tools/forced tool choice, exact result and working text preserved, canonical answer contains only closing, working cause capacity, one closing.
- [x] Add RED fixed-output pressure case: catalogue-free Q+O+M exceeds W but R≥min(O,1,024). Assert outgoing cap exactly min(O,R), original thinking/sampling unchanged, snapshot O unchanged; closing text settles as answer. Include exact-fit and one-token-under-floor cases using real counters, not hardcoded wire-byte approximations.
- [x] Parameterize genuinely oversized single/accumulated/same-step parallel results: each individual payload may be below 32k while aggregate cannot close. Assert no oversized provider request, exact output retained, no replay, explicit capacity failure. Keep existing maxToolSteps:1 capacity fixture and initial catalogue boundary tests unchanged.
- [x] Run only new tests to prove the first two cases fail on current behavior; identify the failure assertion. Existing passing capacity tests are counterexamples, not RED evidence. Use Node 22 and local `node_modules/.bin/vitest run tests/integration/normal-chat-completion.test.ts -t '<new case names>'`; no network/model access.

**Engine change and green checks:**

- [x] Factor local closing input construction from existing `prepareStep`: record/drain inserts once, append instruction, apply existing destination/vision/provenance projection, then measure. Cache the same closing step-zero input for SDK dispatch; recheck abort/deadline/fit there. Do not apply the legacy shrinking guard.
- [x] Allocate an invocation-local closing C from the spec before constructing the SDK request. Use C in both assertion and `maxOutputTokens`; retain O in snapshot. Reduction requires exact original provider/base/model identity. Unknown limits or insufficient floor remain capacity failure; changed destinations retain O and all existing gates.
- [x] Replace the unconditional working-capacity break with eligible progress → single closing, after current precedence and delivery checks. Include retained progress for an admitted human resume, exclude initial no-progress rejection and completed observation. Set working cause before transition; never select fallback because of capacity.
- [x] Rerun the new regression fixtures; inspect both sent request bodies and terminal snapshot/events. Confirm huge exact evidence remains incomplete, no tool executes in closing, and closing length/error/empty ends once without another recovery.

**Invariant coverage in the same implementation task:**

- [ ] Add stop during async projection/counting, settled ask plus a parallel result, and uncertain sibling cases. Assert zero recovery dispatch for stop/pause/uncertainty/filter/expired parent deadline; assert all same-step results settle before capacity closing. Preserve operation counters and scoped reuse behavior.
- [ ] Add capacity during exact user resume and transport-failure closing on a different/smaller destination. Assert prior calls never execute again, human-admitted new work retains existing policy, destination cannot obtain reduced cap to fit, private original/step-image context remains gated, and exhausted closing allowance never resets. Include pending image insertion in the closing fit calculation without refetch.
- [ ] Add accounting assertions: known working usage plus known closing usage summed once; capacity-prevented request charged zero only with proof of no dispatch; missing usage remains unknown; attempted working outcome remains capacity even when closing answers. If needed, finalize usage at the proven local capacity exit in `completion.ts`, using existing usage shape/ledger rather than a new table. Never overwrite unknown transport-tail usage with zero.
- [ ] Run the touched focused tests and existing completion/request-room/refusal/failover tests once, including the real prepared-turn chain. Preserve initial preparation budgeting and per-model reasoning settings. No broad testing during implementation iteration without a new failure/change.

- [x] Review this slice once after its RED/green/invariant cycle. Report Task 1 progress only; do not call the complete context-exhaustion objective fixed. Keep the accounting change local to proven capacity-prevented dispatch if its regression requires it.

### Task 2: Bound NEW web views through existing deep modules

**Files:** Sequentially extend `normal-chat-model/completion.ts` and `completion-tools.ts`; `normal-chat-tools/model-payload-budget.ts`, `shared.ts`, `research-web-tool.ts`, fetch adapter in `normal-chat-tools/index.ts`; `web-grounding.ts` and their existing focused tests. Prepared-turn integration tests may verify transport wiring. Paths are beneath `src/lib/server/services/`. No new top-level service/store/schema.

**Interfaces:** Consume Task 1's actual projected-input measurement and closing reservation owner. Add the spec's opaque `ReadResultGrant`, opt-in/bind/get helpers in existing payload-budget leaf, and `boundGroundedWebView(...)` in web grounding. A WeakMap keys the exact copied options object; preserve `experimental_context` identity and all SDK fields. No capability/grant leaves legacy/App-verifier behavior unchanged; an active capability with unknown room produces a denial, not legacy fallback. Engine owns pool/leases; web grounding owns selection; envelope validates the final view before observation.

**RED and implementation:**

Worker evidence distinguishes 12 initial missing-API RED tests, 2 allocation API RED tests, subsequent prepared compaction failures and final focused GREEN; it does not claim every integration assertion was run before all implementation.

- [x] Add RED plain/stream cases through real research/fetch shaping+envelope with synthetic upstream/cache fixtures: one oversized NEW read, sequential accumulation and same-step parallel reads must expose bounded truthful views and reach one valid closing when the reserved input fits. Contrast Task 1's unchanged old oversized-capture failure. Coordinate with the controller's test-only repro worker; never overwrite concurrent tests.
- [x] Add RED allocation tests with reversed network completion order and cache-hit ordering: same scoped proposal order yields identical lease sizes/selection; total leases plus measured overhead never exceed the frozen step pool. No refunds within step; next provider step alone recomputes from actual retained context. Include unknown room; U=h_i+f_i and one below; a denied grant with nonempty refusal using its separate failure allowance; post-read selection-validation/onError failure; assert final semantic model-output equality including SDK wrappers on errors as well as success.
- [x] Freeze the pool from Task 1's projected request, subtract maximum working output, closing minimum/instruction/margin, image costs and measured framing/terminal-refusal reserve. Use U after fixed reservations; admit only U≥h_i+f_i; set p_i=f_i+floor((U−h_i−f_i)/2), debit h_i+p_i once, expose p_i plus alternative failure budget f_i. Wrapper h_i is excluded from payload spending; failure replaces success, not another debit. Denied success allowance is zero but refusal has separately reserved h_d+f_d and exposed failure allowance; later denials cannot borrow leases and may terminate capacity without an unchecked payload commit. Implement these proposal-order grants in `completion-tools.ts`; opt in only research/fetch. Deny with `ToolCallRefusedError` through the existing proven-refusal fact path before any upstream fetch when minimum cannot fit; after settled work transition read-exhausted to existing closing without retrying reads. Preserve stop/pause/uncertainty/delivery and concurrent siblings.
- [x] Implement the leaf option helpers with a private brand and WeakMaps/execute-function opt-in WeakSet; pass the exact bound options through adapters to the envelope. Prove unrelated context is untouched and App verifier/no-grant calls retain current behavior. Do not key leases by tool name or share a full remaining allowance with each call.
- [x] Extend web grounding to preserve full fitting views or choose stable source/evidence/page bundles and explicit versioned prefix ranges. Include coverage/omitted counts and narrowing guidance; drop unscoped brief on ANY omitted source/quote/page content, even with all source IDs kept; coverage:full requires the whole fetched/cached candidate view. Add the all-source-IDs-retained/omitted-quote-or-page-tail case with a brief containing that omitted fact; exclude its brief/candidate/citation support. Rebuild ALL candidates/chips/counts/metadata (including `createGroundedWebMetadata` and `observeResult` inputs) from selected view, retaining IDs/URLs and only supported quotes. Do not promise next-page availability or silently refetch. Size cached results for their new lease without changing previous captures/cache backing data.
- [x] Enforce ONE envelope final commit boundary for success, returned failure AND catch/onError before digest/observe/record/return: validate compact success payload against p_i/32k or failure against exposed f_i/f_d, with wrapper budget separate. Clear unselected candidates/metadata on every failure. Replace an uncommitted invalid post-read view or arbitrary onError payload with the fixed bounded failure using f_i; no reselection/truncation and no post-read ToolCallRefusedError/definitely_not_executed. Preserve entry/fact identity and abort precedence; no failure allowance means explicit capacity without an unchecked payload commit. Keep selected-only provenance/locality gates.
- [x] Run targeted new tests RED then green using Node 22 and local Vitest, including exact returned/observed/captured/wire-view equality; omitted facts excluded from citation/chips; one operation each with no automatic replay/refetch; both transports; legacy oversized capture unchanged; privacy/failover/resume boundaries. Include mixed unrestricted-tool/model-output overflow as honest fail-closed limits, not expected failure for all NEW web reads.

**Contract and final verification:**

- [x] Amend affected fidelity/bounds/output-reserve wording in `docs/plans/turn-completion/contract/spec.md`, its `implementation-plan.md`, ADR-0026 and services/chat-turn engineering map. Exact retention begins at the final bounded NEW view, never permits reshaping old captures, and does not imply raw-result storage. Incorporate the accepted judge amendment without another user approval cycle.
- [ ] Controller performs fresh review and the repository-mandated final gate once after implementation; relevant specs are `tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts` (plus ask coverage if changed). Controller owns gate scheduling/ports and any later commit decision; do not start a competing run in this diagnosis task.
- [x] Report Task 1 and Task 2 evidence separately, remaining finite-window limits and unavailable incident sizing. No production/deployment/model probes, universal nonempty-answer guarantee or claim that catalogue-only relief reproduced the incident. Conditional accounting remains limited to proved no-dispatch exits.
