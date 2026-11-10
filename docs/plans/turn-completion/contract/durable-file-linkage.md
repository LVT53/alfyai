# Durable turn file linkage before completion

## Selected current contract

- Ownership comes only from exact job IDs in this occurrence's trusted raw
  producer receipts: stream server recorder and plain normalChatToolCalls before
  evidence filtering, including known running/failed receipts. Snapshot/delta
  ownership inference and its association-only plumbing are RETIRED. No trusted
  ID means no global orphan fallback; no-job refusal performs no job lookup.
- Existing user/conversation/export/other-assistant boundaries still apply. Save
  the assistant, then strictly assign the exact jobs and produced files before
  terminal receipt; heavy state/evidence/memory projection stays deferred on stream.
- On critical read/assignment failure, atomically persist a separate
  normalChatFinalization fact and saved identity/accounting link through the
  existing owner. Do not rewrite raw answer, immutable model completion, attempts,
  prices or usage. Explicit tracked identity is required; no untracked fallback.
- Sample the existing authenticated current Stop fact when failure is recorded.
  Stop remains stopped, including Stop during a held association; marker truth
  is monotonic. Deleted-chat quiet stop and secondary-storage-error handling remain.
- Failure wire is data-stream-metadata { observation, finalContent, saved identity,
  normalChatFinalization } → finish(error), or finish(stop) → DONE. No
  data-stream-error discards the marker. Observation carries effective failed/stopped
  completion and original modelCompletion. Live/reload/observe/Copy/export consume
  the same marker. Persistence-only failure offers no generation Retry or recovery.

This is the final selected policy approved by Kierkegaard. The earlier chronology
and amendment discussion below is retained only as historical review context and
must not be used to restore deleted ownership inference.

## Historical / superseded design and review record

Status: ordering, durable-failure amendment and client/wire policy approved by
Kierkegaard before their respective implementation. Final implementation review
and controller-owned release verification remain separate.
Review: `.superpowers/sdd/implementation-plan/durable-file-linkage-spec-judge.md`
and `durable-file-linkage-failure-review.md` in the same ignored review folder.

## Evidence and scope

At staging b5599daad a post-terminal full detail read returned bootstrap=false,
sidecarPending=false, generatedFiles=[], but a succeeded job 4ce11a00-fead-478e-a2c4-2f7056b63364
already carried file 21adf376-5bf1-414d-b2d8-1f3a2295209e. The assistant receipt
was e32dac4a-9927-4530-aa8b-e09a74514e2e. Current finalize sends the stream
receipt before starting the projection that assigns jobs/files to that assistant;
generatedFiles excludes null assistant IDs. This is an ordering defect.

Own only chat-turn/finalize.ts, finalize-steps.ts if necessary,
stream-completion.ts, their focused tests, and narrowly required interfaces.
No prepared/model/harness changes, new service, remote work, agents, gates,
build, deploy, polling workaround, export contract change or authorization widening.
Use existing judge chat 01a1c646-82ca-7122-8b6d-aa3366fb15a7 for review.

## Historical ordering (snapshot ownership superseded)

1. Capture the existing turn-start snapshot at turn start. Resolve it in the
   post-save critical phase before selection/linkage/terminal emission. Preserve existing late-snapshot correction using this turn's tool
   job metadata and snapshot timestamp. Never replace unavailable scope with an
   empty set that would adopt every unassigned job.
2. Persist user/assistant identities and existing pending-write/ask bookkeeping.
3. In the existing finalizer, select only eligible jobs under the existing
   user/conversation/start-snapshot rules (artifact exports stay excluded).
   Await assignment of those jobs AND their already-produced file rows to the
   saved assistant. Running/queued jobs are assigned without waiting for rendering;
   their eventual successful settlement already inherits the assistant ID.
4. Only after that critical durable linkage succeeds may a stream emit its
   successful terminal receipt, or a plain send return successful completion.
   A held/slower turn-state/evidence/memory projection cannot delay this linkage.
5. Keep heavy stream projection/tail deferred and memory sync best effort.
   Preserve plain send's existing response/turn-state shape; do not broaden this
   fix into redesigning its eager response projection. Its linkage runs before
   that projection as well. No duplicate assignment or memory synchronization.

## Failure and stop policy

An unavailable file start snapshot remains fail-closed for association: do not
adopt unrelated jobs. Proposed judgment: if this turn invoked a file-production
tool and its safe scope cannot be resolved, withhold normal successful receipt
and use the existing finalization error path; no fabricated terminal success.
Likewise, selection or durable assignment failure propagates before successful
receipt rather than being swallowed into an empty files list. Noncritical memory,
evidence and projection errors retain existing best-effort/background handling.

Stopping a turn does not wait for a renderer, restart/cancel a file job, or change
job status. Link only already-created eligible jobs to the persisted stopped
assistant before its receipt. Keep wasStopped semantics. A deleted conversation
continues through the existing quiet-stop path and does not resurrect rows.
No-file turns perform no new file lookup/wait. Failed/cancelled jobs retain their
status and do not acquire fabricated output files.

## TDD and validation

Before implementation, add deterministic focused tests and observe intended red:

- Stream: seed/simulate a succeeded same-turn job and linked null-assistant file;
  hold heavy turn-state projection unresolved; at receipt verify both durable
  associations and file visibility, not merely assignment invocation. Hold the
  assignment itself to prove no terminal success leaks before it resolves.
- Negatives: pre-existing unrelated job/file and artifact-export job/file remain
  untouched; preserve user/conversation arguments and exact selected IDs.
- Plain send: same critical linkage precedes heavy projection and final success;
  preserve existing generatedFiles response contract and no duplicate work.
- Assignment/selection failure: no success receipt; error path is observed.
- Snapshot rejection: no broad orphan adoption and no success claiming complete
  durable association. Preserve no-file fast path.
- Stopped/running case: assign without awaiting rendering or changing status;
  retain existing deleted-chat quiet-stop tests.

Use deferred promises/barriers, no sleeps, retries or polling. Reuse existing
module seams and add a DB-backed visibility assertion if the focused suite can
support it without broad new fixtures. Review tests for tautological mock-only
assertions. Run only focused Vitest files and scoped static checks as allowed;
report full gates/build deliberately not run. Check current official Vitest docs
before writing test code (MCP docs if available). Judge reviews the final diff
after focused green; controller owns broader integration and release verification.

## Durable association failure (approved amendment)

Expanded ownership: existing completion-lifetime/turn-ledger, message and shared
outward projection interfaces, plus the plain send adapter and its tests. No
prepared/model/tool changes. Client consumption belongs to coordinated owner
Bernoulli after the following interface is published and approved.

Persist a narrow `normalChatFinalization` message metadata fact:
`{ version: 1, status: "failed", cause: "file_association_failed", wasStopped: boolean }`.
It describes failed durable file association, never the quality/outcome of the
model run. Actual answer bytes, raw normalChatOutput events, ledger model terminal,
attempt manifests, usage and prices remain unchanged.

After an assistant is saved, catch strict scope-resolution/association errors inside
finalize. Move fallible stream snapshot/late-snapshot resolution into this existing
post-save critical phase via an optional resolver in GeneratedOutputReconciliationParams;
it still resolves before selection/linkage/receipt, never after terminal success.
Thus snapshot rejection also has a saved row to mark; it cannot leave a newly
introduced clean answered/null-message terminal. Plain's pre-generation snapshot
failure still refuses before any model lifetime is started.

Through the existing ledger/message
owner, atomically merge this fact into the scoped saved message AND link that
known saved message to the already-sealed ledger/accounting. Preserve terminal
conflict guards; do not settle a different model outcome. Untracked/incognito
turns still mark their saved message through the message owner, without creating
a ledger. Repeating the same marker/identity is idempotent; an incompatible
message identity is rejected. A concurrent/later ordinary finish(messageId) must
preserve the separate failure marker. No model retry, new generation or job restart.

Reload projects `ChatMessage.normalChatFinalization`. Observe-existing and the
wire failure receipt carry `normalChatFinalization` and an effective completion:
failed (uncertain_execution) normally, stopped (user_stop) when explicitly stopped.
uncertain_execution here is only the existing compatibility classification for an
outward failed completion; the exact actual cause is file_association_failed. It
does not assert uncertainty about whether a model tool executed.
Retain the original immutable model completion separately as `modelCompletion`
on a failed terminal observation. Bernoulli consumes the marker in saved/live
views and observation handling; no clean answered/null-message resolution for a
known saved failed-finalization row. The failure wire is exactly `data-stream-metadata { observation }`, then
`finish(error)` and DONE, or `finish(stop)` for an explicit stop. No
`data-stream-error` follows it: that path discards metadata. Client onEnd consumes
the observation before queue/retry decisions. Persistence failure never offers
generation Retry or starts automatic recovery. Plain failure preserves its error
status and additionally returns known saved identity, marker, effective completion
and raw modelCompletion.

If marking/accounting also fails (e.g. DB outage), log that secondary failure and
propagate the original association error, withhold normal success, and make no
claim that failure was durably recorded. Deleted-chat quiet stop remains unchanged.

Plain send's start snapshot read failure propagates via its existing pre-generation
error path; it is never converted to an empty exclusion set. A subsequent healthy
request must leave the old orphan unattached. No new retry/poll is introduced.

Add a functioning-DB test with real admitted/sealed answered model terminal and
real saved assistant, injected association failure, fresh reload/message read and
observe-existing. Assert separate failure, correct identity/accounting, unchanged
raw answer/model/attempt/usage/prices, repeated idempotent failure recording and
stopped precedence. Add the real plain adapter snapshot-failure/healthy-followup
negative. Judge verifies the expanded failure interface before expansion code and
reviews the complete scoped diff after focused tests pass.

Tracked failure writes require explicit mode and complete matching turn/segment/message scope; missing tracked snapshot identity is an error, never inferred or downgraded to untracked. Stop requested while association is held is sampled from the existing authenticated stop registry when failure is recorded; its marker is monotonic and remains stopped across reload/observe/wire.

## Approved ownership replacement amendment (selected policy above)

This supersedes the earlier start-snapshot/delta association policy. The existing
producer's server-recorded tool receipt `metadata.jobId` is the authority, not
creation time or the difference between global conversation job lists. Collect
only raw records for THIS occurrence (stream toolCallRecords; plain toolCalls or
prefetchedToolCalls before evidence filtering). Accept known IDs on running and
failed tool records as well as done records; never scan a prior resume transcript.
Select those exact IDs through existing user/conversation-scoped reads, excluding
artifact exports and jobs already assigned to a different assistant. An absent
ID is never replaced by a global orphan/delta fallback. A legitimate no-job refusal
does no association read/wait and cannot claim another producer's job.

Retire association-only start snapshots, late-snapshot correction and the unsafe
plain snapshot helper, including narrowly obsolete orchestrator capture plumbing
and public types that have no other consumer. Keep pending-write and reset facts
unchanged. No new registry, model/producer edits or competing ownership mechanism.
Keep durable assignment/read visibility before receipt, and keep the approved
atomic failure marker, identity/accounting and outward failure/stop behavior.

Meaningful regression: in the same user/conversation, create a valid unassigned
non-export foreign job after the old turn-start point alongside an intended
current tool job ID. At terminal, only the exact intended job and file have the
saved assistant; the concurrent foreign job/file and pre-existing orphan remain
unassigned. Exercise both stream/raw and plain/raw failed-or-running receipt
consumption, export/other-assistant/owner exclusions, no-ID refusal, and no extra
snapshot lookup. Retire tests that require chronology inference rather than keep
obsolete behavior behind test-only compatibility fields.
