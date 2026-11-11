# Normal Chat completion and output ownership

Status: independently judged PASS after binding revisions; implementation authorized under the owner’s requested SDD workflow.

## Intent and existing work

A normal chat turn must either deliver an answer, deliver an artifact, pause for the person, stop on their request, or report failure. Working commentary is not the answer. The same contract applies to send, stream, retry and resumed segments, with one owner under chat-turn (ADR-0015).

The existing fast route already removes done, recognizes successful delivering tools, attempts tools-disabled repair, records saved-stream completion facts, and warns when a preamble is all that remains. The DeepSeek correction already represents synthetic server prefetch as retrieved context while keeping actual SDK reasoning passback. Extend these; do not build a parallel harness.

The separate “Review harness architecture” chat produced a report, not code. Its observations about repeated tools across attempts, reconnect starting a fresh run, and lossy replay are relevant to this contract. Whole-library reads, unrelated metadata concurrency, and broad performance refactors are outside this change. The merged baseline includes deployed cost-display fix 40f2d74fc; its live and delayed accounting must survive all new phases.

## Binding constraints

- Existing service boundaries, Node 22, Svelte 5 runes, English app-authored model inputs, localized English/Hungarian UI, URL provenance and connector/local-distillation gates remain binding.
- No text-length, punctuation, language, or content heuristics determine commentary versus answer. No newline-only patch. No fabricated reasoning.
- Actual provider reasoning, tool call IDs, complete tool results, prompt guidance, pictures and user input remain available to continuation, subject to the existing destination privacy/vision gates.
- No previously recorded execution is replayed automatically by recovery, failover, reconnect or resume. Explicit human-input segments may authorize newly generated calls under existing tool/domain policy. A fresh explicit user retry may start a new requested turn, but transport recovery is never a retry of side effects.
- Stops outrank pause, which outranks automatic closing. No closing after a successful delivering tool unless later unfinished work requires it. Failed/pending/refused delivery is not success.
- No production push, merge, deployment, restart, database writes or production test conversations in this work. Staging is authorized after local verification, using synthetic data and dedicated credentials only.

## Reproduction evidence

The real browser transport concatenates distinct text IDs into `Let me check.## Result`. A real server-runtime→SSE→browser probe retains `Hello. Let me check.## Result`, including Copy/export. A clean leading preface is currently stripped correctly; the regression is not claimed for that negative control. See [reproduction.md](./reproduction.md) for actual commands, red assertions and exact identity-loss boundaries.

## Output identity and phases

Every model attempt/step/text block has stable identity through neutral harness events, stream transport, replay and browser state. A block has a structural role and lifecycle, not an inferred role from its words. Existing provider-native text IDs may be scoped by attempt/step to avoid collisions.

Working steps may reason, call tools and emit commentary. Their text is initially provisional while the step runs and streams in the answer area immediately. A clean tool-free terminal step may commit its text as the answer once, without an extra model call. A step with tools is working commentary: at the first tool occurrence its preview leaves the answer area, before execution settles, and never enters canonical content. Thinking never displays this live prose, even in an expanded rail (see [Thinking display amendment](./thinking-display-amendment.md)). When a run ends without a completed answer or delivery, one explicitly designated tools-disabled closing phase produces the answer. Within that phase, text streams directly into the answer; reasoning stays thinking.

For providers with interleaved content, step boundaries and tool results, not delta timing, settle role. Multiple text blocks inside an answer step retain boundaries and concatenate only inside that answer according to the provider's original content order. Separate working blocks cannot corrupt a later heading, code fence, table or list.

Useful partial conclusions in working text remain in continuation context. The closing instruction must preserve useful completed subanswers rather than discard them. A natural answer followed by more requested tool work is not silently erased: the final answer synthesizes all completed parts. Text already emitted by an explicit answer phase is retained as an incomplete answer if stopped, truncated or failed; it is never upgraded to a completed answer. Provisional working text on interruption is retained separately as activity, with the interrupted state, not promoted by guessing.

Once a tool occurrence identifies commentary, its prose is hidden throughout the remaining live generation and for successful completion. Terminal stopped/paused/incomplete/failed activity requires fresh explicit disclosure for its own segment; missing completion never authorizes disclosure. It does not appear as an answer after reload, Copy, answer export or later prompts. Durable diagnostic/activity state may retain block identity and commentary separately, without treating it as answer content or exposing private reasoning in exports. This is distinct from ADR-0056 anchored thought summaries; reuse its UI owner without inventing classifier output or overwriting thought-step state.

## Completion state machine

One typed result describes phase, stop cause and outcome. Outcomes: answered, delivered, paused, stopped, incomplete, failed. Stop causes distinguish natural stop, tool budget, stagnation, provider length/content filter, stream end, transport error, deadline, user stop and ask pause. Record unknown provider facts honestly.

1. Clean no-tool terminal answer with visible sanitized text: answered.
2. Successful delivery with no later unfinished work: delivered (short/empty caption permitted).
3. Confirmed ask_user pause: save the segment and its exact resumable state, no closing or invented answer.
4. Explicit stop: stop all work, save eligible answer partials separately from commentary, no recovery.
5. Otherwise reserve one closing attempt, tools omitted from request and no executable tools reachable. Continue the original turn with all completed evidence and original instructions; do not rebuild the whole preparation pipeline or use digests in place of real results.
6. Closing gets adequate bounded output room and a bounded deadline under the turn deadline; it cannot recurse. No visible answer, raw tool markup, content filtering or truncation remains an explicit incomplete/failed outcome, never answered merely because text exists.

Normal tool budgets 14/18/24 remain tool budgets; the one closing call is separate and bounded. Closing uses the selected model's proper reasoning/output controls, not the old quick-depth workaround if that starves reasoning models. Concrete budget/deadline defaults must be chosen against current config and recorded in the implementation plan.

## Continuation ownership and side effects

Keep one authoritative per-turn continuation snapshot at the chat-turn/model-run seam: original prepared system/messages and prefetch evidence, cumulative real model response messages, destination-gatable result provenance, active model and attempt, emitted blocks, completed/in-flight tool facts, usage and phase state. Capture completed steps and completed tool results even if transport fails before the next step callback. Tool results must not be lost just because no finish frame arrived.

Recovery invokes generation against this snapshot, not runPlainNormalChatSendModel preparation from scratch. Failover after completed work also continues it. Apply destination-specific message formatting, prefetch representation, privacy/distillation and vision policy on each attempt; do not copy a policy decision from the original provider to a different destination. Never forward raw connector data to a destination that is not allowed to see it. Preserve available real reasoning exactly for compatible providers; no synthetic empty reasoning to satisfy an API.

If a tool's effect is still in flight, do not race it with another attempt. Await its settled recorded result under the existing cancellation/deadline policy, or fail explicitly as uncertain; never execute it again to find out. Preserve ask_user capture ownership and authorization. Pauses must keep inlined prefetch evidence as well as native prefetch; resume must not refetch it. Existing stored captures remain readable. User retry semantics must distinguish an explicit fresh run from continuation/reconnect so hidden automatic repeats are impossible.

Reconnect observes an existing turn or its durable result only. A race where the turn finishes after the status read must not register a new model run. Replay preserves block order/identity and committed answer state under bounded buffers; when old replay is unavailable, settle from saved state explicitly rather than manufacture a partial answer or restart tools.

## Persistence and telemetry

Persist final answer text independently from commentary, with versioned additive metadata for output blocks/completion. Existing legacy messages remain readable verbatim; do not attempt to guess and rewrite old text. Live receipt, saved read model, Copy, export and model-history projection use the same answer ownership. Interrupted answer partials carry consistent localized status in the UI. Copy, Open as document, document titles and Markdown answer text contain only the canonical answer words, never an app-written status prefix; status-only empty replies create no document. Commentary-only failures cannot become completed assistant answers. Preserve ask cards and generated-file references.

Record one durable completion/attempt audit for failed and unsaved turns as well as saved ones, with turn/attempt identity, phase, actual stop cause, outcome, recovery count and usage attribution. Use an existing suitable durable telemetry owner, or one narrowly scoped additive table if none can represent unsaved attempts. Never log/persist extra raw private prompts/evidence just for telemetry. Usage sums tool and closing attempts exactly once; delayed cost reconciliation continues to work. Terminal persistence and audit must not duplicate on retries or reconnects.

## Required evidence before acceptance

- Deterministic reproduction of Let me check. + tool/reasoning stage + ## Result before implementation, showing where identity is lost.
- Regression tests across real SDK step/block shapes; clean natural answer, multi-tool working commentary, multiple text blocks, legitimate partial subanswers, closing answer, token budget/stagnation/length/reasoning-only/no-finish/error exits.
- Exact continuation evidence and reasoning preserved across streaming/plain recovery, provider failover, ask pause/resume and retries; tools execute once, including side-effect counters and transport failure after execution but before step finish. Privacy/vision/provenance gates verified for each destination.
- Stop/pause precedence, failed/refused/pending delivery, artifact-only success, short captions, partial answer failures and raw markup; closing empty/truncated/error must terminate explicitly within bounds.
- Client and browser tests for provisional answer chunks before step completion, immediate withdrawal at tool occurrence, no live prose in thinking, explicit terminal activity disclosure and live status/card placement, answer Markdown integrity, reduced motion, interrupted partials, ask card, replay/reconnect races and buffer loss, persisted reload, Copy and export consistency. Legacy stored messages and cost-display regressions included.
- Exactly-once durable failed/unsaved audit and no duplicate cost/usage across attempts.
- Independent spec judge before code, task reviews after each implementation slice, final whole-change review, full repository gates and real-model staging matrix (DeepSeek flash, Kimi, Qwen ordinary tools, shared-conversation, zero-text, closing, pause/resume and interruptions). No claim of permanent semantic answer-quality guarantees from finite tests; assert the structural contract and report observed limits.

## Delivery boundary

A reviewed, tested feature branch deployed only to staging; recorded gate outputs, staging release identity/results, known limitations and rollback target. Stop before production deployment. If live tests reveal an unresolved structural gap, report it plainly; do not expand scope or mark the class fixed by passing ordinary happy paths.

## Judge resolutions — binding refinements

These refine the sections above and take precedence over ambiguous broad wording. Judge round 1: [spec-review.md](./spec-review.md).

### Role settlement and semantic limits

Preserve turn/segment, attempt, step and block IDs and ordered sequence; emit explicit replayable, idempotent role settlement. Per the owner ruling of 2026-11-11, provisional text streams in the answer area as a live-only preview, never in thinking. The first tool occurrence settles it to activity and withdraws it immediately, without retaining a separate working line. Copy/export/history continue to read canonical answer content only. A natural answer is committed only after an affirmative normal `stop` for that terminal tool-free step: visible sanitized text, no tool attempt (including invalid/refused/dropped/unoffered/provider-executed attempts), no outstanding work, no stop/pause/length/filter/error/missing finish. Settlement does not duplicate the previewed text. Explicit closing text streams directly as answer. No words, length or punctuation decide a role, and no extra model call is added.

A structurally valid no-tools normal stop is not semantic proof: a model can say “Let me check.” and stop without a call. This change accepts that limit rather than applying prose heuristics or an extra mandatory generation to every answer. Preserve original bytes/order within answer blocks; settled commentary cannot reappear as answer during replay, and saved provisional activity is never a live preview after reload.

### Partial answers and activity retention

Working text is retained losslessly as separately labeled previous/interrupted activity, accessible after reload for stopped/paused/incomplete/failed turns only after explicit terminal disclosure. Live rail expansion does not authorize later prose disclosure; authorization is cleared whenever the eligible completion identity changes, including a segment round trip. An already expanded rail must be closed and reopened for fresh access. Another resumed segment does not revoke an explicitly opened paused segment. See [Thinking display amendment](./thinking-display-amendment.md). It is not private reasoning or an anchored thought summary and is not exported as answer. Successful final synthesis receives all working text, but synthesis fidelity is model-dependent. Deterministic inclusion of selected prose as answer would require a separate explicit model-facing answer-part protocol, which is outside this design.

Interrupted explicit closing text stays as a labeled incomplete answer in live, saved, Copy and export projections. Interrupted ordinary provisional text stays inspectable activity, never promoted by guesswork. Across ask/resume segment chains, earlier committed answer parts stay once and earlier working prose stays activity; closing synthesizes only uncommitted conclusions rather than duplicating prior committed answer parts.

### Tool execution uncertainty

Scoped execution states distinguish proposed, dispatched, succeeded, known failed, definitely-not-executed and uncertain. Capture complete final model-facing results at actual execution settlement, independently of finish callbacks. A normally returned terminal failure is a known outcome even after submission: the model receives a failed file job and may correct its program in the working loop within produce_file's two-submission limit. The envelope binds the fact to its exact returned result, not copied payloads or a row found by reused call ID. Preserve provider-executed and preliminary/final-result flags. A throw, envelope timeout/abort or still-in-flight effect remains uncertain; it does not certify rollback. A late underlying effect may still succeed.

After a known execution outcome, automatic recovery/failover is tools-disabled continuation only; ordinary working steps may still consume returned results and issue new calls under the existing tool limits. Genuine uncertainty blocks both new execution and closing: return an explicit uncertain outcome rather than racing an unknown effect. A new provider tool-call ID cannot reopen executable recovery tools. Unknown provider effects never synthesize a successful result. Stop promptly cancels generation and prevents new work; late settlement may update audit but cannot revive generation. Fresh explicit retry gets a new requested-turn identity and retains its existing user-directed semantics.

### Bounds and escape conditions

Verified file delivery survives a later transport failure of its caption and closing as `delivered`; it does not authorize another execution. Later length-truncated work remains incomplete, and Stop, pause and unknown effects keep precedence. A stopped turn whose persistence fails without a durable marker reports an explicit storage error rather than a quiet successful stop.

One closing generation invocation per running segment, no recursive closing, SDK generation retries or provider failover inside closing. A resumed segment after explicit user input has its own one-call allowance and same reply lineage. Working budgets are existing step budgets (not individual tool-call counts); continuation never resets them.

A transport failure before any upstream text, reasoning or tool occurrence may receive one bounded working retry with tools, after configured pre-work failover is exhausted and only inside the original deadline. A second such failure ends failed; it must not silently turn a tool-enabled task into a tools-disabled answer. Once output or a tool occurrence exists, this retry is forbidden. Pre-work failover excludes the failed attempt's response text/reasoning from outbound context while preserving its audit record and unconsumed picture inputs. Closing removes unmatched calls proven not executed from its outbound projection; it never invents results for unknown effects. Explicit DSML tool syntax anywhere in output prevents answer promotion, including after visible prose; ordinary JSON fences remain answer text.

The plan fixes deadline/output allocation before implementation. No closing after parent deadline or content filter. A destination must fit complete policy-gated context plus output reserve; otherwise explicit incomplete context_capacity, never silent truncation/digests/refetch or a smaller-window fallback. Truncation of working output can request closing when eligible; closing truncation remains incomplete. Retain original working stop cause separately from closing outcome.

### Durable identity and accounting

Per-segment usage events and returned usage include only that segment's attempts; the durable ledger retains every segment for accounting. Later model history labels structurally stopped, incomplete or failed partial answers explicitly, in both native and flattened history, without changing saved answer bytes or inferring status from prose.

Allocate authenticated user/conversation-scoped requested-turn identity before model work. Start-new and observe-existing are distinct protocol intents. Store durable terminal outcome/result reference independently of assistant-message creation, including unsaved failure. Missing replay/owner after completion cannot become a new run. After process restart, accepted work whose execution state cannot be recovered is interrupted/uncertain rather than regenerated. This does not introduce a general job engine.

Audit and terminal writes are idempotent by turn/segment/attempt ID. Database failure yields explicit storage failure and best-effort diagnostics; exactly-once means one durable effect under retry, not guaranteed storage during outage. Follow existing account/conversation deletion and incognito retention rules; no raw evidence in telemetry.

Keep per-attempt usage with actual provider/model identity, including failed generation and closing. Charge each at its own rate; unknown usage stays unknown. Sum known charges once, never cumulative SDK totals plus their constituent steps. Preserve the cost fix's one-message aggregate/read endpoint and serial refresher, withholding ready until the final attempt aggregate is reconciled. Failed/unsaved charges contribute to conversation totals from attempt accounting, excluding any already-linked aggregate to prevent duplication. Receipt replay and queued turns cannot double-charge.

### Destination and resume safety refinements

Canonical capture precedes destination flattening. If an original prepared prompt contains locality-sensitive context that cannot be safely projected for another destination, fail explicitly `incompatible_continuation`; do not leak it or rebuild the pipeline. Images/step inserts retain their real privacy/position metadata and bounded codec; do not refetch missing pixels. Legacy v1 ask captures remain readable with reconstructed/legacy evidence fidelity, never described as exact snapshots. New captures include original prepared context, including inline prefetch.

A human answer to ask_user authorizes a new segment and may authorize new tool work. This differs from automatic recovery/failover: the old execution transcript is not rerun. Retain prior execution identity and use existing tool/job operation ownership where applicable; generic semantic exactly-once across a model inventing different operations is not promised. A recorded execution cannot be relabeled as new by a provider call ID or fingerprint. The structural resume clarification below governs genuinely new model calls after human input; it supersedes semantic mutation-family refusal. Test genuinely new resumed work and non-dispatch of recorded executions. No universal semantic idempotency claim.

## Owner's architecture alignment requirement

Where this work overlaps “Review harness architecture”, use its recommended deep-module shape now. [architecture-alignment.md](./architecture-alignment.md) maps the overlapping recommendations to module ownership and interface tests. It is binding for implementation and reviews; no planned refactor debt accepted for these overlaps.

## Final structural resume clarification (judge-approved, binding)

An accepted ask_user answer authorizes a new segment of requested work. Exact prior transcript/results and the scoped execution ledger are context, never executable replay instructions. Harness recovery, retransmission, failover and reconnect must never dispatch a recorded operation again. Known execution reuse returns the recorded result or refuses; a new provider ID/hash cannot relabel replay. Prior unsettled/uncertain effects block dispatch until safely reconciled or explicit failure.

After authenticated admission of the human-input segment, newly generated calls may execute under ordinary validated tool/access/domain-precondition policies. A previous success in the same family does not by itself forbid another operation. Authority is the accepted human-input segment plus those policies, not an ID/fingerprint/model-intent classifier. Existing external write confirmation remains separate; an ask answer does not confirm or execute a pending write.

Automatic recovery after execution in the new segment remains tools-disabled. No semantic exactly-once guarantee is made across independently generated operations in ordinary loops or human-input resumes. Existing concrete operation owners retain their idempotency/preconditions. This permits two requested documents with a pause before the second without inventing a semantic classifier.

This clarification supersedes earlier blanket semantic ambiguous-repeat refusal wording and the conservative proposal in resume-operation-policy.md. Scoped judge evidence: [resume-policy-judge.md](./resume-policy-judge.md).
