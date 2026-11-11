# Proven produce_file refusal certainty — revised mini-spec

Status: approved; amended by the owner's 2026-11-11 ruling that a returned failed file job is a known outcome and the working loop continues. Helmholtz's 2026-11-10 SPEC PASS remains historical evidence in `.superpowers/sdd/implementation-plan/produce-file-refusal-certainty-judge.md`.

## Trusted fact in the existing recorder

Only produce_file's existing pre-submission refuse() closure may mark its own fresh failed result as definitely_not_executed. Every call site must remain before submitFileProductionIntake for that invocation. This fact says nothing about previous invocations/jobs or unrelated server reads.

Use the existing ToolCallRecorder:

```ts
record(entry: ToolCallEntry, fact?: {
  state: "definitely_not_executed" | "failed" | "uncertain";
  result: object;
}): ToolCallEntry;
getExecutionCertainty?(result: unknown): "definitely_not_executed" | "failed" | "uncertain" | undefined;
```

createToolCallRecorder privately associates that exact fresh result object with its execution fact (WeakMap). The fact is not a metadata/entry/payload field and is never serialized. The provenance recorder wrapper forwards the trusted argument and lookup unchanged. The produce_file entry builder marks a failed payload carrying a terminal job ID as `failed`; its callers construct that payload only after the ledger reports a settled outcome. It marks running/queued job results as `uncertain`. The envelope transfers this private entry fact to the exact compacted result; a generic returned failed row grants no certainty. The catch path records `uncertain`, including when its model-facing fallback says a background job is still running. These facts describe execution certainty, not delivery success.

The prepared forAttempt classifier consults only its actual attempt pack's recorder using classifyExecution's original result.output reference, before Model Run clones/serializes it. It must not obtain certainty via the existing cross-pack callId/name rowFor search, arguments, hashes, status/HTTP/job metadata or prose. Fresh results are unique per invocation. Copied/equal-shaped outputs, forged metadata and other recorders/packs yield unknown. Current successful classification stays unchanged. A normally returned terminal failed job has the explicit `failed` execution state, is passed to the model, and permits correction within the existing two-submission working-loop limit. Missing failure facts and exception/abort/timeout stay uncertain. Delivery/evidence filters remain unchanged; a known failure is never delivery.

## Required existing Model Run guard amendment

An honest refusal fact must not reopen executable automatic recovery. Current hasExecuted() excludes definitely_not_executed, allowing a subsequent transport/deadline failure to enter tools-enabled pre-work fallback. Recorder-only changes cannot establish the required guard.

The existing Model Run owner must distinguish pre-work/no-tool-occurrence from a recorded attempted/refused invocation. After the latter, automatic transport recovery cannot expose tools or replay the old operation: use the existing at-most-once tools-disabled closing when execution has a known outcome, or an explicit terminal if closing is ineligible. Unknown execution blocks both new dispatch and closing. Stop/pause/deadline precedence remains unchanged. Human-answer/new-segment policy stays unchanged; fresh working-step generation consuming a returned failure is distinct from automatic recovery. No caller-managed loop or second state machine.

The controller authorized this narrow amendment in normal-chat-model/completion.ts and its focused tests. No ledger/schema/client/delivery/export change. No semantic registry or universal exactly-once claim.

## Focused acceptance

- Real produce_file pre-submission invalid-input refusal records the private fact; submit/job dispatch count zero; failed payload/status preserved.
- Exact result/recorder identity through provenance wrapper; copied/forged/equal-shaped results do not authorize certainty.
- Earlier genuine refusal then later attempted/unknown invocation reusing callId/tool name stays uncertain (same pack and across packs).
- Real prepared owner + installed SDK + real tool/recorder: known refusal can reach an honest final answer or existing tools-off close, with zero job submissions.
- Known refusal followed by lost finish/transport failure: no executable fallback/recovery, zero submissions, at most one tools-disabled closing.
- Submitted terminal failure reaches the model, allows its second submission, and then an answer; the old one-generation/incomplete oracle is replaced. Thrown/aborted/timed-out/unknown effects and earlier uncertainty remain blocked; ordinary success remains successful.

SPEC PASS and owning-scope clearance precede TDD implementation. Named tools/recorder/provenance/prepared/model tests; no full gates/build/deploy/e2e/remotes or changes to Carver's export/files investigation.
