# Isolated second check for Case 4

Case 4 was the clear durable miss in the [seven-fact trace](isolated-seven-current-fact-trace.md). Its original durability batch recorded four inconclusive results. That receipt used the same marker for a valid semantic judgment and a failed or invalid response, so it cannot establish what originally happened.

## Validation and exact replay

The isolated harness now records each attempt and distinguishes transport and HTTP errors, malformed response envelopes, incomplete responses, invalid JSON, shape, length and verdict values. It preserves a valid semantic inconclusive verdict without retrying it. After an unvalidated response it retries only still-unvalidated inputs, first as a group and then at most once per unresolved input. A failed provenance check stops the run. Six synthetic controls passed on the development machine and in the restricted staging executor.

The exact four-input batch replay used the sealed original order, unchanged durability rubric, local model alias and generation settings. The first response contained four valid verdicts. Case 4's position was a pass. The positional format can check shape and length, but it cannot establish whether the provider reordered a valid response. Before permitting publication, the harness sent Case 4 alone under the same rubric. The gateway completed normally and the sole verdict was a pass on the first attempt. There were no failure retries in either real call. Selection had no access to the frozen question, answer or grading labels.

## Targeted isolated arm

The targeted v3 arm was designed to add only the confirmed Case 4 assertion to the 21 automatic admissions from v2. The two protected edits and two unresolved holds carried forward. None of the other three diagnostic inputs were added. This preserves the comparison inventory and does not estimate what a full-cohort rerun would select. The arm used the original source date and scope and the same sealed allowed cohort. It did not process excluded messages.

Canonical isolated migration and delivery accepted 22 automatic sources and two protected edits. All 25 jobs succeeded, including provision. Six staging banks contained 29 published observations backed by 54 native rows, with no pending native operations. The v3 alias, database and tenant were separate from v1 and v2, whose evidence checksums still matched.

## Downstream check

The independent evaluator used the frozen question only after publication. In v2 the recorded recall evidence lacked the target, and a separate ordinary authenticated chat request completed without answering it. In v3 the current Memory reader returned two observations linked to the original dated, scoped source, including at least one intact assertion. Both explicit-query and default-query reads surfaced the support. The frozen answer test passed.

The evaluator also used the authenticated `/api/chat/send` route against a disposable clone of the isolated app. The v3 request returned HTTP 200, included the target observation in the app’s Remembered information section on the first and only model request, and produced an answer that passed the frozen grade. The unmodified question did not contain the target fact. The clone wrote an assistant chat row. Its Memory fingerprint and the original isolated database were unchanged.

This is a targeted recovery of one known miss. It leaves the original frozen panel scores unchanged and provides no estimate of a full-cohort retry or production performance. No live Memory worker, account, bank or release changed.
