# Scoped re-review — PASS

Reviewed the revised `spec.md` binding **Judge resolutions** and the implementation plan's **Fixed policy decisions before Task 1** plus published-interface requirements against the five round-1 blockers. **All five blockers are resolved. No remaining specification blocker.** This accepts the specification and implementation plan, not an unimplemented product or runtime verification.

1. **Role settlement / streaming UX:** Explicit idempotent settlement is authoritative. Ordinary provisional text stays in activity until affirmative terminal no-tools `stop`; invalid/dropped/provider-executed tool attempts invalidate promotion. Closing streams directly as answer. Delayed ordinary answer placement and the semantic limit of a naturally stopped preamble are explicitly accepted. No prose classifier is authorized.
2. **Useful partials:** Lossless, reload-accessible activity fallback covers stopped/paused/incomplete/failed outcomes. Explicit closing partials remain labeled incomplete answers across projections; provisional ordinary text is not promoted. Segment chains retain committed parts once. Synthesis fidelity is explicitly model-dependent. ADR-0056 anchors and private reasoning remain separate from commentary.
3. **Execution uncertainty:** Dispatch/settlement ledger and preliminary/provider execution facts cover the missing-callback window. Timeout/abort is not rollback. Completed/uncertain execution cannot reopen tools in automatic continuation; uncertain provider effects fail explicitly, and late settlement cannot restart stopped generation. Fresh explicit retry remains distinct.
4. **Closing bounds:** One absolute override-aware deadline; closing reserve is `min(60000, floor(totalTimeoutMs / 4))` ms, leaving the working deadline at total minus reserve. Closing reuses prepared output reserve/reasoning controls, requires full destination-gated context fit, and otherwise reports capacity failure. `maxRetries: 0`, no closing failover/recursion/executable tools, and no content-filter or expired-deadline recovery make the limit executable. The original working cause remains separate from closing outcome.
5. **Durability / cost:** Audit identity precedes generation, observe-existing cannot become start-new, unrecoverable restart state is interrupted/uncertain, terminal writes are idempotent, and storage failure is explicit. Per-attempt actual pricing, unknown usage, failed/unsaved charges and final-aggregate readiness address the `40f2d74fc` refresher risk. Task 1 publishes output/continuation/execution/usage interfaces before downstream parallel work.

The binding resolutions explicitly supersede earlier ambiguous broad wording; the original unconditional “otherwise” closing language therefore does not override the deadline/filter/capacity/uncertainty exceptions. Implementation reviews must verify those exact exceptions rather than infer new recovery permission from older prose.

The original reproduction remains the acceptance regression: distinct IDs alone are insufficient; the full-path non-leading `Hello. Let me check.## Result` case, clean-leading negative control, separate final Markdown, Copy/export/reload and replay settlement must be covered. Existing fast-route and DeepSeek work are extensions, with merged baseline `24823203b` and cost fix `40f2d74fc` preserved.

**Disposition:** proceed directly to the authorized implementation sequence; no additional human gate is needed. This judge did not modify product code or specification, run gates/build/check, or perform remote actions. Only this report was updated during scoped re-review. Round-1 rationale follows for traceability.

## Explorer reconciliation — acceptance remains PASS

Consulted `/tmp/alfyai-completion-design-findings.md` after scoped acceptance. Its concrete capture gaps reinforce the accepted full-state and destination-projection requirements; they do not authorize narrower recovery evidence.

**Binding clarification from the user:** preserve complete canonical prepared system/original outbound input (including inline prefetch, instructions, guidance and pictures), actual response messages, real completed results not yet represented by a finished step, and ordered step-only input observations with their locality/provenance labels. Preserve existing bounded model-facing payload handling; do not newly shrink full continuation evidence to digests or truncate it to fit a recovery destination. If complete permitted context plus the prepared output reserve cannot fit, terminate explicitly with `context_capacity`. The explorer's suggested attempt-view digest/truncation fallback is rejected for this work.

Local→cloud projection must cover original prepared system/input sensitivity, inline connector/prefetch blocks, assistant text/reasoning that may quote local evidence, photo labels, pixels and step-only inputs—not merely native tool-result parts. Reproject from canonical source boundaries under actual destination privacy/vision/compatibility policy. If safe reprojection cannot be established, return explicit incompatible continuation; do not send the sensitive prompt, reconstruct a lossy digest, silently drop required context or refetch evidence. Authorized privacy transformations remain governed by existing policy; they are not permission for capacity-driven evidence shrinkage.

The fixed closing deadline/output controls, execution states, block settlement and durable accounting decisions remain controlling. Explorer suggestions for alternative closing token/time caps, additional closing failover, or generic argument-hash deduplication do not replace them. The accepted no-executable-tools automatic recovery rule still applies; explicit user-input resume retains its distinct authorized semantics and execution ledger.

**Final disposition: PASS; no new specification blocker.** Implementers must cover the explorer's inline-prefetch, step-input and original-prompt sensitivity cases in focused tests. No product/spec changes or runtime verification were performed by this judge.

## Final destination/resume refinement review — PASS

Read the added binding **Destination and resume safety refinements** against the accepted no-repeat scope. No remaining blocker.

- `incompatible_continuation` correctly distinguishes inability to safely project locality-sensitive original context from `context_capacity`. Canonical step inserts/pixels retain privacy and position metadata; missing pixels are not refetched. Neither outcome permits evidence shrinkage or disclosure.
- Legacy v1 captures remain readable with honestly reconstructed/legacy fidelity. Compatibility does not imply exact evidence recovery; an incompatible or insufficient legacy capture cannot silently become a fresh automatic run.
- A user's ask answer starts an authorized new segment that may perform genuinely new tool work. This is compatible with no-repeat: the prior transcript is input data, never an executable replay, and prior dispatch/result identities survive. Automatic recovery/failover within the resumed segment still follows the tools-disabled recovery rule after execution. A human answer alone is not proof that an earlier uncertain effect rolled back or permission to repeat it.
- A known completed operation uses its recorded result or is refused; an ambiguous repeat of an earlier side effect fails closed. A new provider call ID or argument hash cannot certify a new logical operation. Existing durable tool/job ownership provides structural evidence where available; uncertain overlapping operations cannot be raced.
- The guarantee is structural: dispatched operations are not automatically replayed, and known/ambiguous repetitions are handled according to the retained ledger and operation ownership. It is **not** universal semantic exactly-once execution for arbitrary model-generated descriptions or external systems. Tests must cover new authorized work after an ask, known prior-operation reuse/refusal, ambiguous repetition and unresolved execution uncertainty.

Acceptance remains **PASS** for the binding specification. Product implementation and its verification remain outside this judge's actions; only this report was updated.

---

# Independent completion contract judgment

**Round 1 verdict: NEEDS_REVISION (superseded by scoped acceptance above)**

Reviewed `docs/plans/turn-completion/contract/spec.md` and `implementation-plan.md` in `/Users/lvt53/.codex/worktrees/turn-completion/alfyai`. This is a specification verdict, not implementation acceptance. The design is feasible in the existing boundaries, but the five decisions below must be incorporated before dispatch. Once they are resolved and the judge accepts, the user's judge→implementation authorization requires no additional human gate.

Baseline: user identifies merged `24823203b`; read-only ancestry check confirms `40f2d74fc` is its ancestor. Preserve the existing fast-route completion/delivery work and DeepSeek prefetch correction. The architecture-review chat supplied findings, not an alternate implementation.

## Evidence and scope

Read root and relevant folder rules (server services, chat-turn, shared services, client, DB, components/chat), model-run stream/plain/failover seams, fallback, ask capture, stream runtime/transport, completion record, usage schema and cost refresher. Consulted `/tmp/alfyai-interim-repro.md`; `/tmp/alfyai-completion-design-findings.md` was absent at review. No product/spec edits, checks/build/full gates, remote actions, agents, commits, credential reads or database mutations were performed.

The reproduction establishes two separate defects: SDK→neutral projection discards block/step identity (`normal-chat-model/index.ts:384`, `:1811`, `:1874`), and browser transport ignores even supplied distinct text IDs (`services/streaming.ts:1009`). Server runtime also manufactures a single answer block (`chat-turn/stream.ts:599`). Confirmed complete runtime→browser→Copy/export bad substring: `Hello. Let me check.## Result`. The clean-leading `Let me check.` case currently passes its lexical stripper; do not describe that negative control as a failing server reproduction. Preserve it as a regression, but remove lexical commentary classification as the new authority.

Official API cross-check: [AI SDK streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) and [tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), supplemented by installed AI SDK declarations and actual checked-out code (`ai` package range `^6.0.193`). Step termination and tool execution are separate facts; current docs alone are not a substitute for testing the installed SDK shapes. No framework implementation was written.

## Blocking revision 1 — settle roles explicitly and choose the live UX

**Gap:** “clean tool-free terminal step” and “provisional while the step runs” do not specify when the answer appears. Task 3 could still stream every provisional token as answer and retract it on a later tool call, contaminating Copy, stopping reasoning enrichment early, and moving text between surfaces. Conversely it could make all ordinary answers invisible until completion without stating that tradeoff. No-tools by itself also says nothing about successful termination.

**Ruling to add:**

- Preserve ordered turn/segment, attempt, step and block identities, including block start/end and step end. Settlement belongs to one shared server/model output projection, not independent client guesses. Deltas carry sequence identity; role settlement is an explicit replayable event.
- During an ordinary working step, render provisional assistant text in the existing activity surface. Do not append it to answer Markdown, Copy/export, or the answer-start signal. This deliberately means a natural tool-free answer is promoted into the answer surface at terminal settlement; it does not stream as committed answer before its role is known. An explicit closing phase streams answer text immediately because its role was designated before generation.
- Promote a natural candidate only on an affirmative normal provider stop for the terminal step, with visible sanitized text and no tool attempt in that step, no outstanding work, no stop/pause, and no length/filter/error/missing-finish condition. An invalid, refused, dropped/unoffered or provider-executed tool call still counts as a tool attempt for settlement, even if omitted from user-facing tool rows. Unknown/other finish reasons do not prove a clean natural final.
- A clean no-tools stop is a **structural answer**, not a semantic guarantee that the request was satisfied. A model can naturally stop after “Let me check.” with no call at all. Without semantic classification or a mandatory final phase, this cannot be distinguished from a short legitimate answer. Accept this limit explicitly; do not add a hidden prose heuristic or automatically invoke closing for a structurally valid natural answer.
- Preserve bytes/order across answer blocks within a settled step. Working blocks must never be prefixed to that answer. Replay must apply settlement idempotently, not briefly redraw working text as the answer.

**Required tests:** natural answer pending→commit, tool-call arriving after text, dropped tool call, unknown/no finish, closing direct streaming, and distinct-ID/non-leading reproduction through persistence and browser Copy/export.

## Blocking revision 2 — useful partials need an honest, lossless fallback

**Gap:** the blanket “a step with tools is commentary” cannot distinguish a valid subanswer from narration in that same step. Prompting closing to preserve all useful material is not a deterministic retention mechanism. On stop, pause, closing failure or imperfect synthesis, useful conclusions can disappear from the visible reply even though they remain in a private capture. The plan's “never ... lost” claim is stronger than its design.

**Ruling to add:** retain working assistant text losslessly as separately labeled interrupted/previous activity, accessible after reload for stopped, paused, incomplete and failed outcomes. Its role remains activity; never export it as answer or present it as private reasoning. Actual reasoning, ordinary assistant commentary, tool facts and ADR-0056 anchored thought summaries remain distinct types. Reuse the rail/disclosure owner, but do not fabricate reasoning offsets, classifier output or thought-step anchors for commentary.

Successful closing receives all working text and instructions to synthesize useful completed subanswers. State explicitly that synthesis fidelity is model-dependent. If deterministic inclusion as answer is required, an explicit structural `answer-part` signal is necessary; ordinary prose cannot supply that signal. For this change, recommend retaining the strict step rule plus inspectable activity fallback rather than adding a new model-facing answer-part protocol.

For explicit closing text interrupted by stop/error/length, retain the emitted answer bytes as an incomplete answer with its status in live, saved, Copy and export projections. Do not throw away that partial because a terminal finish was absent. Ordinary provisional natural-answer text interrupted before settlement stays inspectable activity; explain this deliberate asymmetry in UI tests.

For ask/resume reply segments, define one canonical answer projection over the segment chain: earlier committed answer parts stay once; earlier working prose stays activity. Closing synthesizes uncommitted partial conclusions, not a duplicate of already committed parts. Copy and Open as document currently join every segment's content (`components/chat/AGENTS.md`, “A Reply In Segments”); changing only the last segment cannot meet this contract.

## Blocking revision 3 — no-repeat must cover unknown effects, not just “done” rows

**Gap:** an in-flight promise settling as an error does not prove no side effect occurred. `normal-chat-tools/shared.ts:438` races execution against timeout; the underlying operation may complete after the envelope recorded failure. Provider-hosted execution can also happen before any observed result. Existing fallback only replays `status === "done"` digests; neither those records nor SDK finish callbacks are an execution ledger.

**Ruling to add:** use scoped execution identity and explicit states: proposed, dispatched, succeeded, definitely-not-executed, failed-after-dispatch/uncertain. Record full model-facing results at execution settlement, independently of step finish, while retaining the existing bounded payload/privacy rules. A wrapper timeout, aborted transport, provider tool-call intent, preliminary result or absent finish is not proof of a safe repeat. Provider-executed calls need their execution flag/result-finality preserved. Unknown provider effects fail as uncertain; never generate a fictitious successful tool result.

After completed or uncertain tool execution, automatic recovery/failover is tools-disabled continuation/closing for this bounded feature. Do not expose tools again and rely on a prompt saying not to repeat. That would permit a new provider call ID to repeat the same action. If future work needs continued tool execution, it requires a separate authorized logical-operation/idempotency design; argument fingerprints alone cannot distinguish an intentional second operation from a retry. Before any work, ordinary provider failover remains available. Reconnect executes nothing. Explicit fresh retry gets a new requested-turn identity; it must not be silently substituted for transport continuation.

Once an execution is uncertain, do not race another attempt with it. Stop returns promptly and prevents new work; cancellation does not certify rollback. A late result can settle the execution/audit but cannot revive the stopped generation. Test tool effect→lost callback, ignored abort→late success, provider-executed call→lost result, and fresh-ID repeated-call attempts.

## Blocking revision 4 — make the bounded closing escape conditions executable

**Gap:** “otherwise” closing includes exhausted deadlines, content filtering and contexts larger than the destination window. Full-context preservation, bounded output and arbitrary cross-provider failover cannot all be guaranteed for every destination. “One closing call” also leaves room for hidden SDK retries/failover to become several billable generations.

**Ruling to add:** one closing generation invocation per running segment, with no recursive closing, no tools and no automatic SDK retries or failover inside that phase. A resumed segment after explicit user input may reserve its own closing invocation; it records the same reply lineage and a distinct segment/attempt ID. Tool limits remain existing step budgets, not a promise of 14/18/24 individual calls, and recovery cannot reset the working budget.

Choose and record deadline/output allocation in the implementation plan before Task 1. The existing default request timeout is 300000 ms (`env.ts:630`), override-aware and possibly much smaller. Reserve closing time before allowing another working step; never start closing after the parent deadline. If there is insufficient time or full destination-gated context plus output reserve cannot fit, terminate incomplete with an explicit reason. Do not replace completed evidence with digests, rerun preparation, drop required context silently, or try a smaller-window destination. Existing policy transformations remain allowed; inability to produce a valid compatible/privacy-safe request is an explicit failure.

Content-filter termination is terminal incomplete/failed, not an automatic request to work around the filter. Truncation may consume the one tools-disabled closing opportunity when time/context permit; its own truncation is incomplete. “Adequate” cannot mean guaranteed full semantic completion within a finite budget. Keep original stop cause and closing outcome separately.

## Blocking revision 5 — pin durable identity/accounting semantics before parallel tasks

**Gap:** Tasks 1→2/3 publish signatures, but omit the minimum durable contract needed for reconnect and multi-attempt costs. `usage_events` currently has one row per message (`schema.ts:1837` vicinity); the cost refresher stops polling at the first ready row (`client/message-usage.ts`). Publishing an initial attempt as ready before closing accounting lands would preserve the old tests while losing the new cost.

**Ruling to add:** allocate an owner-scoped requested-turn identity before model work; distinguish start-new from observe-existing in the protocol. Keep a durable terminal marker/result reference independent of assistant-message creation, including unsaved failures. A completed/missing-buffer turn must never fall back to start-new. After a process restart, an accepted turn with unrecoverable execution state becomes interrupted/uncertain rather than automatically regenerated. No requirement to build a general durable job runner.

Use that turn/segment/attempt identity for idempotent audit and terminal writes. Define how a persistence failure is reported; exactly-once means one durable effect under retry, not guaranteed successful storage during database failure. Do not require raw evidence in telemetry. Retention/erasure follows existing ownership, including incognito behavior.

Keep per-attempt usage with actual provider/model identity. Final message cost is the sum of known attempt charges, including failed generation and closing; unknown usage remains unknown, not free. Do not price every attempt at the winning model's rate. Avoid counting SDK cumulative usage plus the same step usage twice. Preserve the one-message aggregate/read endpoint and serial refresher from `40f2d74fc`, but either withhold `ready` until the complete aggregate is reconciled or version readiness so later charges still refresh. Specify how failed/unsaved attempt charges contribute to conversation totals without double-counting linked message aggregates. Test two providers with different prices, failed attempt + closing, delayed last-attempt accounting, replayed receipt and queued next turn.

## Plan disposition and nonblocking recommendations

The four-slice plan and existing ownership are appropriate. Resolve the five rulings in spec/plan first, then Task 1 must publish both output settlement events and the continuation/usage interface before Tasks 2/3 run in parallel. Include plain-send step/result capture: its current `onStepFinish` only logs, while streaming captures messages only after finished steps. Amend the canonical chat-turn final-answer rules in Task 2, which currently explicitly protect the old “any visible text” gates at four fallback sites; those rules conflict with the proposed unified ownership.

Retain the implementation plan's full final release gate and staged synthetic model matrix. Judge acceptance is authority to proceed under the user's existing instruction, not a new permission request. No additional generic hardening tasks are required by this judgment. This report supplies exact decisions for the observed structural defects and the stated completion/recovery contract; finite staging tests must not be sold as permanent semantic answer-quality guarantees.
