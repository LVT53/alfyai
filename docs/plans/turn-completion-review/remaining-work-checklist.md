# Remaining completion work — authoritative checklist

Resumed 2026-11-11 from `db028c4bd`, after the owner asked to finish the omissions. This ledger supplements, not erases, [the first remediation report](remediation-report-2026-11-11.md). No original `.txt` source is changed.

## Historical progress denominator (before final acceptance)

Count findings, not elapsed effort: original ordered defects = 31 (1.1–1.3:3, 1.4:10, 1.5:16, owner regressions:2). Prior pass evidenced29/31. Additional distinct section6 protection findings =20 (batch bound/dedup:2, runtime guards:6, verifier guards:7, browser oracles:4, small-context catalogue:1), prior pass19/20. Thus **48/51 original findings evidenced**, with wire overhead, watchdog bounds and 8192-context certification unfinished at that checkpoint. The resumed implementation now covers these, and the final integrated gate passed on `584cc9c3a` (see Final staging acceptance). This does not mean94% of remaining execution time is done.

All33 original files have a disposition below; incomplete subcase coverage is tracked separately rather than counted as success. Some files measure old behavior and intentionally fail once repaired. Their original assertions remain untouched; desired invariants need their own red/green evidence. The fresh full release gate and the staging deployment are complete; the provider checks are partial (see Final staging acceptance and the 2026-11-12 follow-up).

## Remaining execution checklist

| ID | Work | Owner | Status |
|---|---|---|---|
| R1 | Compact live wire and remove duplicate reasoning without hiding streaming | server worker | Implemented; final integrated release gate passed |
| R2 | Idle and admission-to-finalization deadline; tool activity and cancellation/uncertainty | server worker | Implemented; final integrated release gate passed |
| R3 | 8192-context browser catalogue certification | browser worker | Certified safe capacity refusal at 8192 with zero dispatch (real catalogue, browser). The fitting case is a synthetic one-tool catalogue at engine level; no browser turn succeeds at 8,192 |
| R4 | Close exact unverified shared/UI/producer/registry/race probe cases below | browser/server workers | All 33 original files mapped; integrated release gate passed |
| R5 | Real per-attempt outcome and stop cause, independent of later closing result | inventory + server workers | Immutable attempt facts covered; integrated release gate passed |
| R6 | Safe post-tool failover and destination-specific prefetch | server worker / orchestrator | Safe failover and destination prefetch covered; integrated release gate passed |
| R7 | Explicit bounded, idempotent old-metadata repair; dry run first, staging only if applied | inventory worker | Staging repair complete: 229 selected, 192 compacted, repeated apply 0 changes |
| R8 | Review actual cleanup/canonical persistence risks; correct docs or fix proven defect | orchestrator | Canonical persistence/ownership coverage passed integrated gate |
| R9 | Fresh release gate and staging-only deployment | orchestrator | Full release gate passed; staging runtime 584cc9c3a deployed and healthy |
| R10 | Appropriate real-model closing followthrough using synthetic data | orchestrator | Complete on `ea80fa788` (2026-11-12): DeepSeek Flash, Kimi and Qwen each pass cases A and B. The `584cc9c3a` run stays recorded as partial (Kimi B failed, Qwen refused); both were defects of the proof runner |

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
| `src~lib~client~zz-review-C-retained.test.ts.txt` | Covered: normal-chat-retained-stop.test.ts, initial report 1.4e. The original itself still fails on `584cc9c3a` (`expected 'superseded' to be 'ready'`): its fixture never releases the navigate permit it is granted, so later requests are superseded. A copy that only adds the release passes. |
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
| `tests~integration~zz-review-D-producer.test.ts.txt` | Original P1/P3/P4 passed; P2 (reused text ID) failed and was fixed in `57ed28e19`; all four pass on `584cc9c3a` and the integrated gate passed. Permanent `normal-chat-output-producer-review.test.ts`; P4 canonical text_delta assertion retained. |
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

## Historical implementation evidence (before final acceptance)

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

The CLI resolves the database realpath and only permits apply on the exact staging database. Each transaction is bounded to100 IDs and32MiB. It does not run VACUUM, rewrite content, modify production, run on startup, or call a provider. An apply reduces logical metadata bytes; database file-size reclamation is not claimed. The staging repair ran later in this pass (see Explicit legacy metadata maintenance).

### Historical implementation checkpoint (acceptance was pending)

- Compact transport is explicitly negotiated by `X-Alfy-Output-Transport: compact-v1`; legacy consumers retain full canonical delivery and reconnect uses canonical broadcasts. Decoder111 focused passes; no speech-length/word/punctuation heuristic classifies commentary.
- Stream watchdog/finalization ownership: `be3856c96`,224 focused passes (`/tmp/remaining-watchdog-final-focused.log`). Additional ownership2 red and expired-admission1 red precede green. Preparation, stream reads, finalization reads and cleanup are bounded. An already-started database commit is not falsely claimed cancelled: transport detaches and the same owner settles the eventual receipt.
- Plain route: `915e75195`, `/tmp/remaining-plain-lifetime-red.log`3 failing hanging-bound tests before implementation → `/tmp/remaining-plain-lifetime-green.log`111 focused passes. Actual send-route tests cover hanging preflight and preparation, late user persistence fenced before assistant creation, and in-flight assistant persistence returning202 with stable scoped identity then finishing once. Cleanup hangs are bounded. The same absolute deadline spans preflight and model/finalization; configured longer budgets are preserved.
- Attempt engine:9e88a4941 (2 red →10 green); post-tool failover efe451c3d (1 red →178 focused green). Every terminal attempt records its own outcome/cause; later closing cannot rewrite working facts. Unsupported destinations fail safely without replaying tools.
- At that checkpoint the remaining acceptance steps were the fresh full release gate, the staging deployment, the bounded staging metadata dry run and apply, and the synthetic real-provider matrix. The first three are now complete and the matrix is partial (Final staging acceptance).

- Plain ownership guard `3e6841f04`: `/tmp/remaining-plain-owner-red.log` proves prepared transfer fails when disabled; `/tmp/remaining-plain-owner-durable-red.log` proves terminal-before-link pending fails when owner retention is removed. Restored implementation: `/tmp/remaining-plain-owner-green.log`,58/58 pass. The durable fixture explicitly models terminal persistence before message linkage, then verifies released unsaved ownership becomes a failure. This is additional boundary coverage, not a claim that a new production defect was discovered.
- Stronger8192 browser certification was pending at that checkpoint and was later resolved as an explicit capacity refusal (next section): initial strengthened assertion incorrectly assumed a1024-token output reserve; actual policy applies820 for8192 context. The browser worker is aligning the assertion with the existing adaptive budget policy; the full serialized input-plus-reserve bound remains mandatory. This intermediate run is not a pass.

### Historical 8192-context defect discovered during stronger certification

The stronger browser check exposed a real budget defect: serialized messages plus tool definitions and reserved output totaled **14,355 tokens against8,192**. The earlier successful browser run did not certify that bound. This is not merely an820-versus1024 output-reserve assertion issue.

The server fix must count the actual serialized tool schemas and fail closed before dispatch when the complete request cannot fit. The full catalogue therefore has an explicit capacity-failure expectation with **zero provider requests** at8,192; supporting a14,355-token catalogue inside8,192 is not claimed. Positive actual-SDK tests with a small tool catalogue must prove a fitting request in both plain and streaming transports. Both the gate and the strengthened browser evidence passed on `584cc9c3a`.

The new browser test's initial assumption that the full catalogue should succeed has been revised to the required safe capacity behavior. No assertion in any of the33 original review reproducers was weakened or rewritten. The original review requested small-context certification; this boundary covers both fit and explicit refusal rather than silently omitting required context or tool definitions.


## Final staging acceptance — 2026-11-11

Validated runtime commit: `584cc9c3a226fc11ddde2f2c70bb0472ebb81d10`. Full release gate `/tmp/turn-completion-remaining-release-final-20261111`: every step exit 0; check 0 errors/0 warnings; 26,155 unit passed/3 skipped; 1,593 browser passed/75 skipped/0 failed/0 flaky; Fallow four known cycles, zero new findings; elapsed 13m52s. Compiler warning scan clean. The first full gate failed 5 unit / 40 browser tests; preserved summary and subsequent test-only corrections `886a146fa`, `584cc9c3a` retain intended oracles. Neither the failed gate nor original probe evidence is erased.

Exact tested SHA pushed only to `fix/turn-completion`; staging deployed `releases/584cc9c3a`. Local 3002 and public `https://ai.dev.alfydesign.com/api/health` both returned status OK, draining false, activeStreams 0; staging service active. Production symlink remained `releases/40f2d74fc` before and after; no production mutation. Deploy backup `shared/backups/chat-20261111T222204Z-584cc9c3a.db`; migrations current. Deployment completed successfully. Dependency installation separately reported 37 npm audit findings/deprecations and a gradio/Pillow dependency conflict; sandbox imports passed. These are not compiler warnings or newly resolved dependencies. Bounded staging journal since 22:22UTC had no error/failed/warn matches.

### Bounded real-provider evidence: partial, not a green matrix

Evidence files: [final evidence directory](evidence-final-584cc9c3a/). All fixtures use the dedicated synthetic account; no owner content or credentials in reports. These test engine, persistence and accounting, not full authenticated HTTP/browser transport.

- DeepSeek Flash: A and B passed, 4 total provider calls, zero auxiliary calls; persisted receipts and priced attempt audits pass.
- Kimi: A passed with working+closing calls. B failed `accounting_not_ready`: one working request recorded cap 32, but provider returned 179 output tokens, natural_stop/answered, no closing attempt; receipt matches and priced working audit exists. The failure is preserved; no rerun or pass reclassification. Superseded on 2026-11-12: a competing `max_completion_tokens` field does exist. It comes from the app's Kimi adapter, not from the SDK (see the follow-up section). Kimi length-to-closing certification remains open until the case is rerun.
- Qwen: refused before any provider call (`provider_binding_mismatch`). Both enabled configured Qwen models have null `max_model_context`; the runner requires an explicit value>= 8192. Provider/model names themselves match. No alias, admin configuration or deployed code was changed to bypass this guard. Qwen matrix remains unverified.

Total actual provider calls in this final matrix 7 (11 across the task, counting the four earlier DeepSeek calls on `eb2869fd6`); no blind reruns. Historical failed reports remain failures. No claim of complete provider certification or production readiness.

### Explicit legacy metadata maintenance

Three exact-ID manifests selected 229 staging assistant rows, each batch<= 100 IDs and 32 MiB. All dry runs passed before apply. Apply compacted 192 rows, reducing logical metadata bytes 41,153,823→4,000,610 (37,153,213 saved). Every batch's immediate second apply changed 0 rows. The tool verifies complete canonical projection equality, preserves unrelated metadata/content, and uses scoped compare-and-swap transactions. No content printed, no production operation, no VACUUM, and no database-file-size reclamation claim. Aggregate dry/apply/repeat results are in `evidence-final-584cc9c3a/completion-final-operations-584cc9c3a.json`; exact manifests stay on staging `/tmp/completion-final-repair-manifest-{0,1,2}.json`.

R1–R8 local integrated gate coverage and R7 staging maintenance now have acceptance evidence; R9 staging release is complete. R10 remains partially unverified for the reasons above. Independent Fable review is prepared, not launched or passed.

Read-only follow-up: Qwen refusal is a **stricter verifier precondition**, not evidence the app cannot run Qwen. The production engine falls back from absent provider context through runtime config to `getMaxModelContext(modelId)` (`normal-chat-model/index.ts`, `config-store.ts`); the provider-ID form uses the global setting, and staging's admin `MAX_MODEL_CONTEXT` is 146000. The verifier currently insists on a non-null catalogue row. Kimi B's synthetic persisted answer has 153 bytes, 55 lines, 54 integer-only lines, no ellipsis and no `END=200`; it did not satisfy the requested 200-integer list despite its upstream natural-stop classification. No raw answer, reasoning, or owner content was retrieved into evidence. These limitations remain open for independent review.

## Follow-up by the independent review — 2026-11-12

- **Kimi B is explained: it was a defect of the proof runner, not of the app or the provider.** For staging's exact binding (`fireworks-ai`, `accounts/fireworks/models/kimi-k3p1-pro`) the app's adapter resolves the Kimi family and sends the output cap as `max_completion_tokens` (`provider-compatibility.ts:446-458`). The runner's gateway then added `max_tokens: 32` beside the adapter's `max_completion_tokens: 1024`. Fireworks' API reference describes `max_completion_tokens` as "Alias for max_tokens. Cannot be specified together with max_tokens." The 32-token cap therefore never applied, and the recorded `cap: 32` was the intended cap, not the effective one. The `accounting_not_ready` code on that case was misleading too: accounting was complete, the working step simply ended naturally. Why the model stopped after 54 integers under a 1,024-token cap is model behavior and stays unexplained.
- **Runner fix:** commit `154358922`. The gateway replaces whichever cap field the request already carries. The context precondition accepts the catalogue row's value or, when the row has none, the runtime value the app itself would use, and refuses an effective context below 8,192 as `model_context_too_small`. Gate on that commit: 26,159 unit tests passed, typecheck 0 errors and 0 warnings, Fallow unchanged; the browser step was skipped because only a script and its test changed.
- **Qwen:** the refusal came from that precondition (both staging rows have no context size). It is resolved in the same commit and not yet exercised.
- **First rerun, staging `d0fbabfa8`** (pushed and deployed with the owner's permission): Kimi passed both cases; with one cap field the working attempt ended on `length` after exactly 32 output tokens and closing answered. Qwen passed case A. In case B it reached closing, spent the proof's whole 1,024-token closing cap on reasoning and ended `incomplete` with no answer, which the engine reported honestly. The app gives closing the turn's own output reserve (14,600 tokens on that model), so the proof's closing cap was widened to 4,096 in `c6f8a0d4f`.
- **Fixes for the second review's findings 2.1, 2.2 and the capacity budget**, each test-first: finalization has its own 30-second window after the model deadline (`bbe079a27`, `fc3732915`); a delivered turn with no saved reply is a failure for observers (`6b2519910`, `bd0a08e4e`); context preparation sizes the turn's real tool catalogue and leaves room for it (`42406f958`, `8a98ec377`, `d2c675836`, `c60836b7d`, `fd8093bfb`, `ea80fa788`). Production's three provider models keep their exact target and output cap.
- **Final acceptance on `ea80fa788`:** full release gate, every step exit 0: typecheck 0 errors and 0 warnings in 9,128 files; 26,239 unit tests passed, 3 skipped; 1,593 browser tests passed, 75 skipped, 0 failed, 0 flaky; Fallow four known cycles, nothing new. Pushed only to `fix/turn-completion`; staging runs `releases/ea80fa788`, health OK, not draining, 0 active streams before and after the proof.
- **Final provider matrix on `ea80fa788`: all six cases pass** (12 provider calls, no auxiliary calls). DeepSeek Flash, Kimi and Qwen each: tool budget then a tools-off closing that answered, and a 32-token `length` stop then a closing that answered. Reports, gate summary and health are in `evidence-final-ea80fa788/`. R10 is complete.
- **Still open, by the owner's choice of scope:** the second verdict's findings 2.3 to 2.10 (none loses data), and the thinking header shown while a plain answer streams, which the owner is to judge on staging.
- The second review's verdict and reproducers are in the main checkout: `docs/plans/turn-completion-review/fable-verdict-2-2026-11-12.md`.
