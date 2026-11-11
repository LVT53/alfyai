# Remaining completion work — authoritative checklist

Resumed 2026-11-11 from `db028c4bd`, after the owner asked to finish the omissions. This ledger supplements, not erases, [the first remediation report](remediation-report-2026-11-11.md). No original `.txt` source is changed.

## Progress denominator

Count findings, not elapsed effort: original ordered defects = 31 (1.1–1.3:3, 1.4:10, 1.5:16, owner regressions:2). Prior pass evidenced29/31. Additional distinct section6 protection findings =20 (batch bound/dedup:2, runtime guards:6, verifier guards:7, browser oracles:4, small-context catalogue:1), prior pass19/20. Thus **48/51 original findings evidenced**, with wire overhead, watchdog bounds and 8192-context certification unfinished at that checkpoint. The resumed implementation now covers these; final integrated acceptance remains pending. This does not mean94% of remaining execution time is done.

All33 original files have a disposition below; incomplete subcase coverage is tracked separately rather than counted as success. Some files measure old behavior and intentionally fail once repaired. Their original assertions remain untouched; desired invariants need their own red/green evidence. The fresh full release gate, staging deployment and any new provider checks are separate pending acceptance steps.

## Remaining execution checklist

| ID | Work | Owner | Status |
|---|---|---|---|
| R1 | Compact live wire and remove duplicate reasoning without hiding streaming | server worker | Implemented; focused evidence below; final gate pending |
| R2 | Idle and admission-to-finalization deadline; tool activity and cancellation/uncertainty | server worker | Implemented; focused evidence below; final gate pending |
| R3 | 8192-context browser catalogue certification | browser worker | Initial real production-build browser pass; strengthened serialized-budget check awaits final gate |
| R4 | Close exact unverified shared/UI/producer/registry/race probe cases below | browser/server workers | All33 files mapped; shared/UI regressions fixed, exact remaining measurements run; final gate pending |
| R5 | Real per-attempt outcome and stop cause, independent of later closing result | inventory + server workers | Lifetime/ledger52 tests green (`f57be4a6e`); engine integrated9e88a4941 with10 focused passes |
| R6 | Safe post-tool failover and destination-specific prefetch | server worker / orchestrator | Prefetch/cancellation70 tests green (`c128f7749`); post-tool engine efe451c3d with178 focused passes |
| R7 | Explicit bounded, idempotent old-metadata repair; dry run first, staging only if applied | inventory worker | Tool7 tests green (`02a04d94e`, `401aad67b`); staging application pending |
| R8 | Review actual cleanup/canonical persistence risks; correct docs or fix proven defect | orchestrator | Canonical producerP4 and interrupted closing exact parity pass; lifecycle bounded cleanup under R2; no gratuitous rewrite |
| R9 | Fresh release gate and staging-only deployment | orchestrator | Pending |
| R10 | Appropriate real-model closing followthrough using synthetic data | orchestrator | DeepSeek/Kimi/Qwen bounded runner9 offline tests pass (`36374d7c0`); new live runs pending |

R5–R8 close concrete limitations named in the prior response. They are not permission for unrelated module redesign. Historical failed watchdog/Qwen reports stay failed; new results cannot overwrite them. Model-quality variation and the old21-reply legacy-preservation claim require honest evidence, not fabricated pass status.

## Original corpus disposition

Files are in the main checkout review `reproducers/` directory. Decode `~` to `/` and strip `.txt` for the intended path; `zz-review-main-*` go in integration except incognito observation in chat-turn. Current status is inherited evidence or pending, never an unperformed fresh run.

| Original file | Current disposition |
|---|---|
| `src~lib~client~zz-review-B-unsaved-answer-client.test.ts.txt` | Covered: completion-unsaved-observation/client-runtime tests, initial report 1.4c. |
| `src~lib~client~zz-review-C-capacity.test.ts.txt` | Covered: normal-chat-capacity-stop.test.ts, initial report 1.3. |
| `src~lib~client~zz-review-C-duplicate.test.ts.txt` | Covered: normal-chat-review-client.test.ts canonical duplicate replacement. |
| `src~lib~client~zz-review-C-erased-end.test.ts.txt` | Covered: normal-chat-review-client.test.ts malformed terminal restores queue. |
| `src~lib~client~zz-review-C-errorline.test.ts.txt` | Covered: normal-chat-review-client.test.ts unrelated error remains. |
| `src~lib~client~zz-review-C-noop-stop.test.ts.txt` | Covered: normal-chat-review-client.test.ts navigate/regenerate observer ownership. |
| `src~lib~client~zz-review-C-pending-stop.test.ts.txt` | Covered and strengthened immediate receipt: normal-chat-review-client.test.ts. |
| `src~lib~client~zz-review-C-retained.test.ts.txt` | Covered: normal-chat-retained-stop.test.ts, initial report 1.4e. |
| `src~lib~client~zz-review-C-scope.test.ts.txt` | Covered: normal-chat-observation-scope.test.ts, initial report 1.4d. |
| `src~lib~components~chat~zz-review-D-empty.test.ts.txt` | Original E1 failed, then passed; permanent `ThinkingBlock.empty-activity.test.ts`; six shared/UI fixes in97-test focused green run. |
| `src~lib~components~chat~zz-review-D-thinking.test.ts.txt` | All6 original cases passed, including X2/X3 batched identities; permanent `ThinkingBlock.review-disclosure.test.ts`. X1 also covered by inline-thinking test. X5 remains valid: answer area is MessageBubble. |
| `src~lib~server~services~artifacts~zz-review-D-keep.test.ts.txt` | Covered: keep-message-status.test.ts exact answer/title and refusal of label-only document. |
| `src~lib~server~services~chat-turn~zz-review-A-prepared.test.ts.txt` | Covered: original settled failure regression retained as zz-review-A-prepared; initial report 2.2. |
| `src~lib~server~services~chat-turn~zz-review-B-stopped-file-save-failure.test.ts.txt` | Covered: stream-completion test asserts error for stopped file save failure, initial report 1.5. |
| `src~lib~server~services~chat-turn~zz-review-B-unsaved-answer-observation.test.ts.txt` | Covered: completion-unsaved-observation/lifetime durable tests, initial report 1.4c. |
| `src~lib~server~services~chat-turn~zz-review-D-journal.test.ts.txt` | Covered bounded replay invariant: normal-chat-replay-size/transport tests; original J1 >2000-token check passed `/tmp/remaining-corpus-original.log`. |
| `src~lib~services~zz-review-C-observation-decode.test.ts.txt` | Covered: normal-chat-observation-decode.test.ts unavailable terminal decoding. |
| `src~lib~shared~zz-review-D-reducer.test.ts.txt` | Original D1–D4 and D6 failed; fixed with unchanged assertions; D5/D7/D7b/D8 passed. Permanent `normal-chat-output-ordering-review.test.ts`;97 focused tests green. D6 answer sanitizer needed its own fix beyond earlier display parser fix. |
| `src~lib~shared~zz-review-D-sanitize.test.ts.txt` | Covered: normal-chat-output and normalizer preserve all three legitimate JSON fixtures. |
| `tests~integration~zz-review-A-completion.test.ts.txt` | Covered: JSON, repair, failover, orphan call, DSML, invisible text, resumed usage, delivery assertions in completion SDK/review-engine/review-outcomes suites. |
| `tests~integration~zz-review-A-race.test.ts.txt` | Original45 scheduling cases passed in `/tmp/remaining-browser-original-red.log`; permanent `normal-chat-tool-fallback-race.test.ts`. Existing deterministic entered-tool guard remains. |
| `tests~integration~zz-review-D-producer.test.ts.txt` | Original P1/P3/P4 passed; P2 reused text ID failed and server worker reports fix; integrated gate pending. Permanent `normal-chat-output-producer-review.test.ts`; P4 canonical text_delta assertion retained. |
| `tests~integration~zz-review-E-identity.test.ts.txt` | E1 old-bug measurement deliberately becomes red after identity fix; desired model identity invariant green in accounting-review-guards. E2 original passed unchanged. Internal helper maps supplied IDs only to literal untracked; sole production caller `messages.ts:mapMessageWindowRows` supplies previously selected same-conversation assistant IDs. No foreign data read or exposed, no invented privacy defect. |
| `tests~integration~zz-review-E-plan.test.ts.txt` | Measurement only: query plan printing, no performance bound. Exact original rerun passed `/tmp/remaining-corpus-original.log`; query shape guarded by accounting review tests. |
| `tests~integration~zz-review-E-scale.test.ts.txt` | Measurement only: sizes200/2000/10000 synthetic rows; exact original rerun passed `/tmp/remaining-corpus-original.log`, no timing threshold claimed. |
| `tests~integration~zz-review-F-acquire.test.ts.txt` | All3 exact original registry start/observe/orphan cases passed `/tmp/remaining-corpus-original.log`; active-streams permanent coverage remains. |
| `tests~integration~zz-review-F-hung-stream.test.ts.txt` | Both exact original working-deadline measurements passed `/tmp/remaining-corpus-original.log`; idle/outer/preparation/finalization regressions are separate R2 work. |
| `tests~integration~zz-review-F-stop-closing.test.ts.txt` | Exact original request-count measurement passed; permanent `normal-chat-stop-closing-review.test.ts` additionally asserts exact prefix, stopped/user_stop/closing, one tool execution and no working text.8 focused tests passed (`401aad67b`). |
| `tests~integration~zz-review-F-transient.test.ts.txt` | Original weak measurement run; desired tools-on retry exact phase/tool/request assertions covered normal-chat-completion-transient-review.test.ts. |
| `zz-review-main-incognito-observation.test.ts.txt` | Covered: completion-incognito-observation.test.ts, original tracked/private assertions and restart. |
| `zz-review-main-journal-overflow.test.ts.txt` | Exact original now intentionally fails old overflow assertion:3,157 streamed tokens remain replayable. `/tmp/remaining-final-original-measurements.log`; bounded desired invariants green, no weakened original. |
| `zz-review-main-persisted-events-size.test.ts.txt` | Exact original size/legacyTextDeltaEvents=1 assertions pass `/tmp/remaining-final-original-measurements.log`. Compatibility canonical delta remains one; progressive provisional output travels structural events. Separate storage bounds enforce compactness. |
| `zz-review-main-read-cost.test.ts.txt` | Exact original synthetic50-reply read-cost measurement passed `/tmp/remaining-corpus-original.log`; bounded served-metadata tests green. This fixture proves no live performance claim; old rows use R7 explicit repair. |

## Evidence updates

Browser/shared probe baseline `/tmp/remaining-browser-original-red.log`:65 cases,7 failed/58 passed; subsequent shared/UI fixes97 focused passed, producerP2 fixed by server worker. Attempt audit baseline `/tmp/remaining-attempt-facts-red.log`:2 intended failures/44 pass. Official Vitest mocking and Drizzle transaction docs checked on 2026-11-11 for the attempt/persistence slice. No owner conversation content or credentials are used for tests.


### Resumed evidence and maintenance command

- Attempt audit: `/tmp/remaining-attempt-facts-red.log`2 failed/44 passed → `/tmp/remaining-attempt-facts-green.log`52 passed; separate admission deadline1 red before green. Failed working attempt remains failed/transport_error when closing answers; priced usage unchanged; non-null terminal facts cannot be rewritten or erased; legacy unknown remains unknown.
- Prefetch/cancellation: `/tmp/remaining-prefetch-abort-red.log`3 failed/32 passed → `/tmp/remaining-prefetch-bidirectional-green.log`70 passed. Completion preparation captures a native app-prefetch exchange once. Per-destination projection transforms only its structurally owned pair; user text/images and actual completed model tool exchanges remain exact. No extra fetch/preparation/model call. Cancellation after awaited preparation stops tool/model dispatch; late tool-pack return settles its lifetime exactly once (`1852aece7`).
- Remaining original corpus: `/tmp/remaining-corpus-original.log`11 passed/1 expected old-bug measurement failure (E1 expects model identity missing); `/tmp/remaining-final-original-measurements.log`38 passed/1 expected old-overflow measurement failure. Original files remain byte-for-byte unchanged in the main checkout; temporary runnable copies were removed.
- Repair tool: `/tmp/remaining-metadata-repair-red.log`4 failing acceptance tests before implementation; `/tmp/remaining-metadata-repair-final.log`7 passed. Standalone CLI dry run loads no app server, reports counts/bytes only, and refuses scratch/production apply. A full reducer projection comparison must remain equal. Invalid events, wrong scope, non-assistant rows, duplicate IDs or over32MiB batches refuse and roll back. All unrelated metadata/content remain unchanged. Repeating apply changes0 rows. Report output is reserved before mutation (`401aad67b`).

Create an explicit manifest containing1–100 objects with `userId`, `conversationId`, `messageId` for the intended assistant rows. No query discovers or exposes content automatically. From the staging release:

```sh
node --import tsx scripts/compact-normal-chat-metadata.ts \
  --database /home/alfydesign/apps/langflow-chat-dev/shared/data/chat.db \
  --manifest /tmp/completion-repair-manifest.json \
  --report /tmp/completion-repair-dry-run.json
# After reviewing the dry run, add --apply and use a fresh report path.
```

The CLI resolves the database realpath and only permits apply on the exact staging database. Each transaction is bounded to100 IDs and32MiB. It does not run VACUUM, rewrite content, modify production, run on startup, or call a provider. An apply reduces logical metadata bytes; database file-size reclamation is not claimed. No staging repair has run yet in this resumed pass.

### Final implementation checkpoint (release acceptance pending)

- Compact transport is explicitly negotiated by `X-Alfy-Output-Transport: compact-v1`; legacy consumers retain full canonical delivery and reconnect uses canonical broadcasts. Decoder111 focused passes; no speech-length/word/punctuation heuristic classifies commentary.
- Stream watchdog/finalization ownership: `be3856c96`,224 focused passes (`/tmp/remaining-watchdog-final-focused.log`). Additional ownership2 red and expired-admission1 red precede green. Preparation, stream reads, finalization reads and cleanup are bounded. An already-started database commit is not falsely claimed cancelled: transport detaches and the same owner settles the eventual receipt.
- Plain route: `915e75195`, `/tmp/remaining-plain-lifetime-red.log`3 failing hanging-bound tests before implementation → `/tmp/remaining-plain-lifetime-green.log`111 focused passes. Actual send-route tests cover hanging preflight and preparation, late user persistence fenced before assistant creation, and in-flight assistant persistence returning202 with stable scoped identity then finishing once. Cleanup hangs are bounded. The same absolute deadline spans preflight and model/finalization; configured longer budgets are preserved.
- Attempt engine:9e88a4941 (2 red →10 green); post-tool failover efe451c3d (1 red →178 focused green). Every terminal attempt records its own outcome/cause; later closing cannot rewrite working facts. Unsupported destinations fail safely without replaying tools.
- Remaining release acceptance: fresh full release gate, staging deployment, bounded staging legacy metadata dry-run/apply, and synthetic real-provider matrix. None is claimed passed by local focused tests.

- Plain ownership guard `3e6841f04`: `/tmp/remaining-plain-owner-red.log` proves prepared transfer fails when disabled; `/tmp/remaining-plain-owner-durable-red.log` proves terminal-before-link pending fails when owner retention is removed. Restored implementation: `/tmp/remaining-plain-owner-green.log`,58/58 pass. The durable fixture explicitly models terminal persistence before message linkage, then verifies released unsaved ownership becomes a failure. This is additional boundary coverage, not a claim that a new production defect was discovered.
- Stronger8192 browser certification remains pending: initial strengthened assertion incorrectly assumed a1024-token output reserve; actual policy applies820 for8192 context. The browser worker is aligning the assertion with the existing adaptive budget policy; the full serialized input-plus-reserve bound remains mandatory. This intermediate run is not a pass.
