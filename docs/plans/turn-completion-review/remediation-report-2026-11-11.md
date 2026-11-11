# Normal Chat completion remediation — 2026-11-11

**Local remediation evidence, not production approval.** Branch `fix/turn-completion`, worktree `/Users/lvt53/.codex/worktrees/turn-completion/alfyai`. Starting validated code: `29e51551f`; starting documentation tip: `495282bf4`. Final validated code baseline: `70a045514`; all release gates passed. Subsequent `eb2869fd6` changes documentation only. Staging release `eb2869fd6` and both explicitly authorized DeepSeek Flash closing cases passed; production remains `40f2d74fc`. Production must remain `40f2d74fc`; no merge/push to `dev` or `main` is authorized.

The independent [original review](/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/docs/plans/turn-completion-review/fable-verdict-2026-11-11.md) and its 33 saved `.txt` reproducers remain unchanged in the main checkout. The authoritative original path is `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/docs/plans/turn-completion-review/fable-verdict-2026-11-11.md`. The failed Stop v8, Natural v10 and read-only-addendum reports remain failed. No new result retroactively validates them.

## How to read the evidence

`R/` below means `/tmp/turn-completion-remediation/`; other `/tmp/` paths are literal local logs. Counts are focused runs, not additive release totals. “Fixed” means the cited deterministic test passed; final combined gate and bounded DeepSeek Flash evidence appear below. Permanent tests live in the branch; transient logs remain local. Original probes that deliberately assert old behavior are distinguished from desired invariants. Their source and assertions were not weakened.

Detailed slice reports: [initial priorities](remediation-progress.md), [engine/replay](remediation-engine-replay.md), [client/incognito](client-observation-remediation.md), [lower client/UI](client-ui-lower-remediation.md), [accounting/audit guards](remediation-accounting-guards.md). Server/lower guard evidence: [server outcomes and guards](remediation-server-guards.md), commits `012db58ce`, `c09da1a4e`, `c2d7e13c4`.

## Requested priority sequence

| Memo | Change and status | Before → after evidence | Permanent coverage |
|---|---|---|---|
| 1.1 | **Fixed:** stored snapshots/finalization/read responses compact deltas by scoped block; live callbacks unchanged | Original size measurement passed while exposing 161,564 / 1,683,676 / 3,193,580 bytes. New bounds failed, then passed: metadata ≤ text bytes + 8,000 and ≤12 events for fixtures; legacy reads bounded too. `R/1.1-original-before.log`, `1.1-invariant-red.log`, `1.1-focused-green.log` (208 tests) | `tests/integration/normal-chat-output-size.test.ts`; shared output reducer tests |
| 1.2 | **Fixed:** JSON fences/ordinary keys never classify answer ownership; generic document/program JSON preserved through final normalization | Original D sanitizer + A JSON case 4 failed →4 passed. Follow-up payload examples 8 failed →110 focused tests passed. `R/1.2-original-{red,green}.log`, `1.2-payload-{red,green}.log` | `normal-chat-completion.test.ts`, `normal-chat-output.test.ts`, stream-protocol/normalizer tests |
| 2.1 | **Fixed locally:** provisional chunks stream in answer area; first tool occurrence withdraws them; clean stop commits once | 2 red invariants →427 focused tests plus settlement tests passed. `R/2.1-red.log`, `2.1-broad-green.log`, `2.1-settlement-green.log`. Frame-gated browser additions passed the final release gate | `normal-chat-output-view.test.ts`, MessageBubble/ThinkingBlock, completion SDK; `tests/e2e/turn-completion-contract.spec.ts` |
| 2.2 | **Fixed:** settled file-job failure reaches model; working loop can correct it within existing two-submission cap | Original A-prepared:1 generation/1 submission instead of3/2 →original exact3/2/answer assertion passes; unknown/running/throw/abort/timeout remain uncertain. `R/2.2-original-red.log`, `2.2-invariant-red.log`, `2.2-broad-green.log` (158 tests) | `chat-turn/zz-review-A-prepared.test.ts`, `produce-file-patch-mode.test.ts`, tool-envelope certainty tests |
| 1.3 | **Fixed:** capacity callback checks captured epoch and stream ownership | Original C-capacity:2 fresh POSTs after Stop →1. `R/1.3-original-red.log`, `1.3-green.log` (363 tests) | `normal-chat-capacity-stop.test.ts` |
| 1.4 f | **Fixed:** completion shares existing deterministic JSON repair; no repair-model request | Original completion executed0 tools vs legacy1 →both1, both transports. `R/1.4f-original-{red,green}.log`, `1.4f-focused-green.log` (209 tests) | `tests/integration/normal-chat-completion.test.ts`, “keeps production tool-call JSON repair” |
| 1.4 c | **Fixed:** answered-without-saved-row is failed observation, retaining model fact; queue restored, not sent | Original server/client both failed →both passed; live finalizing owner remains pending. `R/1.4c-original-{red,green}.log`, `1.4c-focused-green.log` (382 tests) | `completion-unsaved-observation.test.ts`, durable-lifetime and client-runtime tests |

The two owner-ruled regressions were corrected in code and current documents: contract `spec.md`, `thinking-display-amendment.md`, `produce-file-refusal-certainty.md`, ADR-0026/0056, and chat component folder rules. Status-label content policy was also corrected in the contract and durable-file-linkage policy. Historical review verdicts were not rewritten.

The section5 invariants remain the intended contract: one engine for both transports, one tools-off closing per segment, Stop/pause precedence, no generation on observe/reconnect, exact saved-row adoption, durable file linkage before receipt, privacy-first/all-or-nothing accounting and unknown usage remaining unknown. Structural step/tool facts alone determine commentary versus answer; no word, length or punctuation classifier was added. The detailed scoped regressions exercise those boundaries; the final release gate passed as the combined check.

## Remaining 1.4 cases

| Memo | Status/change | Before → after; logs | Permanent test |
|---|---|---|---|
| a | **Fixed within bounded retention:** compact replay remains available for reviewed long turn; polling follows fixed server working+closing deadline plus30s grace (330s fallback for old server) | Original overflow measurement first; new 3,157-token invariant red →below40KB/30 frames. Client answered at140s previously expired at122s →140s/400s cases pass; finite expiry retained. `R/1.4a-original-before.log`, `1.4a-invariant-red.log`, `1.4a-focused-green.log`, `1.4a-client-{red,green}.log`, `1.4a-decoder-green.log` | `normal-chat-replay-size.test.ts`, `normal-chat-replay-transport.test.ts`, stream replay/runtime/lifetime tests |
| b | **Fixed:** incognito saved receipt is observable after module restart without accounting rows | Original unavailable →terminal,2 original assertions pass. `R/1.4b-original-{red,green}.log`, `1.4b-focused-green.log` | `completion-incognito-observation.test.ts` |
| d | **Fixed:** foreign-scope or pending-at-end observation settles unavailable, restores queue | Original3 cases still sending at10min →368 focused tests pass. `R/1.4d-original-red.log`, `1.4d-green.log` | `normal-chat-observation-scope.test.ts` |
| e | **Fixed:** unresolved Stop protects only its uncertain reply; navigation/historical Regenerate can proceed | Original historical-ready assertion failed →367 focused tests pass; permit release/ownership preserved. `R/1.4e-original-red.log`, `1.4e-green.log` | `normal-chat-retained-stop.test.ts` |
| g | **Fixed:** fallback context excludes failed attempt partial text/reasoning; audit retains them | Original g/h/i4 failed →4 passed; six suites150 passed. `R/1.4-ghi-original-red.log`, `1.4-ghi-green.log`, `1.4-ghij-focused-green.log` | `normal-chat-completion-review-engine.test.ts`, pre-work failover case |
| h | **Fixed:** closing omits unmatched calls proven not executed; uncertainty remains guarded | Same original g/h/i red/green logs; actual SDK closing request succeeds without orphan call | `normal-chat-completion-review-engine.test.ts`, “never sends closing an assistant tool call without its tool result” |
| i | **Fixed:** explicit DSML anywhere is control syntax, including after visible sentence | Original two DSML cases fail →pass in above logs; no ordinary-prose heuristic | `normal-chat-completion-review-engine.test.ts` |
| j | **Fixed:** one bounded same-provider working/tools-on retry only before any upstream output/tool occurrence; repeated failure ends failed | Original F-transient measurement ran; new exact tools/phase assertions red on both transports →green. `R/1.4j-original-before.log`, `1.4j-invariant-red.log`, `1.4-ghij-focused-green.log` | `normal-chat-completion-transient-review.test.ts` |

Replay still has hard200KB/10,000-frame limits. It does not promise unlimited retention or reduce live network traffic. Fallback lookup cancellation/deadline rechecks were added separately (`ba272d902`) so asynchronous selection cannot dispatch after cancellation/budget exhaustion.

## Every 1.5 item

| Review item | Status and evidence | Permanent coverage / log |
|---|---|---|
| Stopped file turn save failure was quiet | **Fixed locally:** original failure assertion red, now error exposed; quiet stop control retained | `stream-completion.test.ts`; `R/1.5-server-original-{red,green}.log` |
| Delivered file becomes failed after caption/closing errors | **Fixed locally:** delivery fact survives caption failure, avoiding a false failed-result retry invitation | `normal-chat-completion-review-outcomes.test.ts`, delivered-file case; same original logs |
| Resumed usage counts paused tokens twice | **Fixed locally:** only resumed segment usage reported; price behavior retained | Same outcomes file, “reports only the resumed segment's own usage”; same logs |
| Pending-observation Stop loses reread receipt | **Fixed:** original eventual-navigation check already repaired by1.4e; added immediate receipt assertion failed then passed | `normal-chat-review-client.test.ts`; `R/1.5-pending-receipt-red.log`, `1.5-stop-green.log` |
| No-op Stop retires normal observation | **Fixed:** owned finalizing read retains epoch; detached recovery still cancelled | Same client test; `R/1.5-client-original-red.log`, `1.5-stop-green.log`, `1.5-focused-correction.log` |
| Stop clears unrelated error | **Fixed:** private settlement does not clear another action's error | Same client test; same original/Stop logs |
| Canonical adoption duplicate after reload race | **Fixed:** replace racing durable duplicate, retain placeholder render identity | `_helpers`/`normal-chat-review-client.test.ts`; `R/1.5-observation-green.log` |
| Malformed terminal without marker drains queue | **Fixed:** explicitly unavailable; no clean end/queue drain | `normal-chat-observation-decode.test.ts`, client review tests; same observation log |
| Copy/Open/title includes English status label | **Fixed:** exact canonical bytes only; empty caption creates no kept document; localized UI owns status | `reply-text-empty-status.test.ts`, `artifacts/keep-message-status.test.ts`; `R/1.5-content-original-{red,green}.log` |
| Disclosed inline `<think>` leaks raw | **Fixed:** explicit control sanitizer on display only, narration preserved, stored blocks unchanged | `ThinkingBlock.inline-thinking.test.ts`; `R/1.5-disclosure-green.log` (2 tests), original X1 red |
| Invisible non-U+200B-only answer | **Fixed locally:** six original invisible-output cases fail →pass | `normal-chat-completion-review-outcomes.test.ts`; `R/1.5-server-original-{red,green}.log` |
| Omitted total becomes$0 | **Fixed end-to-end:** loader preserves omission, page carries unknown, composer/ring shows EN/HU unavailable; actual zero retained | `page-load.test.ts`, loaded-chat `page-runtime.test.ts`, `ContextUsageRing.cost.test.ts`; `/tmp/accounting-defects-{red,green}.log`, `accounting-ui-{red,green}.log` |
| Accounting read failure unlogged/model icon lost | **Fixed:** safe count-only warning; persisted validated model ID retained; no invented cost | `accounting-review-guards.test.ts`; original E measurement2 passed before; original E1 intentionally fails after, desired invariants pass. `/tmp/accounting-original-E{,-after}.log`, `accounting-defects-{red,green}.log` |
| ≈600bytes/token wire and duplicate reasoning | **OPEN:** storage/replay compaction does not change live per-token wire emission | Original measurement retained; no new bandwidth claim |
| Interrupted partial passed as complete history | **Fixed locally:** native and flat history label failed/stopped/incomplete partials | `context-selection.test.ts`; `R/1.5-history-red.log`, `1.5-server-focused-green.log` |
| Removed150s idle/300s outer timers; no overall prep/finalize bound | **OPEN:** old watchdogs not restored; current working/first-output guards now mutation-protected. No new preparation/finalization overall bound | F-hung-stream remains measurement of existing deadline behavior; no claim that all hangs are bounded |

Server lower slice original result:9 failed/1 control passed →10 passed; history2 new invariants red →green; six focused files400 passed (`R/1.5-server-focused-green.log`). Client lower suite initially exposed four compatibility regressions; corrected before394 focused tests passed. The earlier `1.5-focused.log` is **not a green run**: it also contained12 obsolete status-prefix oracles. Accounting/verifier slice171 passed; rendered missing/zero2 passed; final ring17 passed. The final full gate passed; see its durable summary below.

## Section 6 guard and oracle protection

| Guard/oracle | Added evidence | Status |
|---|---|---|
| Exact500-ID batches and dedup | Real SQLite bound parameters; ledger500→503, optional500→503, ledger Set removal, optional Set removal individually fail. `/tmp/accounting-mutation-{ledger,optional}-{bound,dedup}.log`; originals restored | **4/4 mutations killed**, `accounting-review-guards.test.ts` |
| Working-deadline timer | Remove timer →intended failure; restore →green | `normal-chat-completion-guards.test.ts`; `R/section6-mutation-working-timer.log` |
| First-output timer | Remove timer →intended failure; restore →green | Same file; `section6-mutation-first-output-timer.log` |
| Dispatch while another execution unsettled | Remove guard →2 intended failures; restore →green | Same file; `section6-mutation-unsettled-dispatch.log` |
| Leading explicit tool markup blanking | Remove guard →intended failure; restore →green | Same file; `section6-mutation-leading-markup.log` |
| Reconnect heartbeat | Remove emission →intended failure; restore →green | `stream-reconnect.test.ts`; `section6-mutation-heartbeat.log` |
| Reconnect prelude | Remove emission →intended failure; restore →green | Same file; `section6-mutation-prelude.log` |
| Audit missing rows | Corrupt fixture and isolated removal of its exact guard | **Killed**, `/tmp/audit-mutation-1.log` |
| Audit unscoped attempts | Same method | **Killed**, `audit-mutation-2.log` |
| Audit accounting ready | Same method, existing explicit pending-user-stop exception preserved | **Killed**, `audit-mutation-3.log` |
| Audit outcome equals receipt | Same method | **Killed**, `audit-mutation-4.log` |
| Audit duplicate terminal segment | Same method | **Killed**, `audit-mutation-5.log` |
| Audit known final token counts | Same method | **Killed**, `audit-mutation-6.log` |
| Audit outside-generated-ID rows | Same method | **Killed**, `audit-mutation-7.log` |
| Browser failed/incomplete regex | Exact mode outcome plus saved/reloaded outcome assertions added | **Passed final release gate** |
| Second browser observer never observes | Explicit completed observe POST and unchanged provider-call count added | **Passed final release gate** |
| Live text checked at one instant | Frame gates assert successive chunks before finish, then tool withdrawal and canonical actions | **Passed final release gate** |
| Reduced-motion variants assert no difference | Computed active thinking animation `none` versus `thinking-sweep` assertion added | **Passed final release gate** |
| Small8192-context browser catalogue | No certified small-context scenario added | **OPEN** |

Engine/reconnect guard baseline18 passed (`R/section6-guards-green.log`). Audit tests are `tests/integration/turn-completion-staging-harness.test.ts`, “review audit guard coverage”;7 new cases pass. Audit mutations use temporary module/test copies; the shipped verifier already contained the guards and was not edited. `--inspect` still does not certify matrix completeness by itself.

Contradictory existing oracles were corrected explicitly, not relaxed: submitted file failure now expects working continuation; unsaved answered receipt now expects failure; JSON fence now expects preserved content; stopped-file save error now expects an error; status-prefix tests require exact canonical bytes/empty content; sparse missing totals require `undefined`, with independent zero/positive checks. Two image eligibility phase expectations now require working retry, retaining request bounds/pixel/outcome assertions. The complete original review files remain unchanged.

## Unclaimed probes and remaining section 3 gaps

The saved33 files are a review corpus, not33 production gate files. Some intentionally pass while measuring defects. The table above maps actionable cases; unmatched subcases are not silently declared green:

- `main-persisted-events-size`, D-producer P1 and `main-read-cost` concern volume; new bounded persistence/read tests establish the fix, not a fresh staging performance benchmark. `main-journal-overflow`/D-journal concern replay; new bounded transport tests establish replay behavior. E-plan/E-scale are query-plan/performance measurements, not new defect oracles; no fresh performance certification claimed.
- E-identity E1 is the repaired identity-loss measurement. E2's arbitrary incognito-ID projection remains unchanged and outside this fix.
- D-reducer D8, D-keep K1/K2 and D-thinking X1 are retained for their memo findings. D-reducer D1–D5 adversarial identity/order cases, D6/D7 sanitizer cases beyond the mapped tests, D-thinking X2/X3 batched prop flips, X4/X6 native-reasoning disclosure, X5 old live-provisional expectations and D-empty retained-header behavior are not blanket release requirements. Original assertions remain available.
- D-producer P2 reused native text IDs/P3 decoder/P4 role structure, A-race, F-acquire and F-stop-closing are additional review coverage; absence of a named current rerun here is not a claim they passed. F-hung-stream measures existing cutoff behavior. F-transient's desired tools-on assertion is separately retained.

Still open unless later evidence below explicitly supersedes it: attempt `safeStopCause`/`outcome` remain initialized null and snapshots copy those original values; no real audit of non-null attempt facts is claimed. Destination-specific prefetch rebuilding, failover after completed tools, caller-managed `finish()` cleanup and the parallel flattened persistence channel were not rearchitected. Current README, image folder guidance and `.env.example` now describe the integrated lifetime and actual model deadline rather than the removed idle/outer watchdogs. Contract spec and ADR-0047 explicitly mark attempt outcome/stop-cause recording and post-tool failover as unimplemented/open; correcting those claims does not implement the missing behavior. Historical “same21 replies” evidence is branch-format output, not a production-history certification; old Qwen/Natural failures remain unresolved historical evidence. History partial labeling and unknown-total display are the section3 claims directly repaired here.

## Authorized provider proof — executed successfully

Owner explicitly approved both bounded DeepSeek Flash cases, **after fixes, full release gate and staging deployment**. The dedicated [proposal/runbook](closing-provider-proposal.md) and `scripts/verify-closing-provider.ts` implement that scope (`573976829`): fresh pre-titled synthetic conversations, exact synthetic account, verified staging cwd/origin/database, one harmless deterministic read tool for A, no tools for B, one working and one tools-off closing request per case. Hard transport cap2 per case includes failed dispatches; redirects and auxiliary network requests are blocked. A working cap512/closing512, B working32/closing1024; no automatic reruns or other models.

The runner drives the real streamed engine, lifetime, finalizer and pricing, then audits exact generated IDs through a read-only SQLite connection. It disables only optional turn-state maintenance and uses pre-titled conversations to avoid title calls. It proves **engine + persistence + accounting**, not browser routing/full preparation. Offline7/7 tests pass, including standalone `tsx` import with network blocked and missing-price failure despite a saved receipt (`/tmp/closing-runner-final.log`). Offline tests are separate from the real-provider results below. Kimi/Qwen closing remains untested.

## Final release gate — PASSED

- First gate code baseline: `c2d7e13c4`; report commit `5d84bf1a1` was documentation only.
- First release output: `/tmp/turn-completion-release-20261111/summary.txt`; elapsed15m56s.
- **First gate FAILED:** check0 errors/0 warnings; Biome1 formatting failure in `ContextUsageRing.svelte`; Vitest26,012 passed/20 failed/3 skipped; Playwright1,589 passed/3 failed/75 skipped/0 flaky. Build, chunks, migrations and Fallow passed.
- Corrections: `95450d420` scoped formatting; `44be15646` preserves original public delta counts despite compact replay; `577d1d653` makes refusal fixtures exercise both bounded attempts and scopes Copy to the answer; `aef404eb3` preserves literal trailing activity text and corrects obsolete status-prefix/navigation oracles without dropping exact-content assertions.
- **Second gate FAILED:** `/tmp/turn-completion-release-final-20261111/vitest.log` had26,032 unit passes/1 failure/3 skips; browser1,592 passed/75 skipped/0 failed/0 flaky. The remaining failure was the existing decode-worker fixture's50ms wall-clock startup race. `fde6466cc` cherry-picked only the known test fix: fake pool timers, await real worker startup, advance exactly50ms. Real termination/recovery assertions stay intact; no product timeout, assertion weakening or retry increase. All16 focused decode tests passed; no other dev commit merged.
- **Final release gate PASSED at `70a045514`:**26,033 unit tests passed/3 skipped;1,592 browser tests passed/75 skipped/0 failed/0 flaky; all static gates passed. Check:0 errors/0 warnings in9,114 files. Biome:exit0, one informational diagnostic. Build:exit0, unused-css0/aria0. Migrations/chunks passed; Fallow3.33.1 reports four existing circular dependencies and no new baseline findings. Elapsed13m51s, eight browser workers.
- Original final output: `/tmp/turn-completion-release-verified-20261111/summary.txt`. Durable verbatim copy: [release-gate-summary-2026-11-11.txt](release-gate-summary-2026-11-11.txt). Failed earlier gates remain recorded; later documentation-only commits do not change the validated code.

## Staging-only deployment — PASSED

- Deployed side branch release `eb2869fd6` (documentation-only difference from validated `70a045514`); deployment log `/tmp/turn-completion-staging-deploy-20261111.log`, exit0. Migrations completed, zero active streams drained, atomic release switch and service restart succeeded.
- Local/public health OK, draining=false, active streams=0, service active. [Concise durable evidence](staging-deployment-evidence-2026-11-11.txt).
- Production release symlink checked before and after: `40f2d74fc`, unchanged. No `dev`/`main` push and no production deployment. Later evidence-only commits do not change deployed code.

## DeepSeek Flash results — PASSED

[Durable safe report](closing-provider-results-2026-11-11.json), copied from `/tmp/turn-completion-closing-proof-20261111-authorized.json`; runner exit0, auxiliary calls0. Only the two approved cases ran, with no additional models or automatic reruns.

| Case | Working stop | Requests / executed tools | Closing deltas / answer bytes | Attempt costs (microUSD) | Saved receipt |
|---|---|---|---|---|---|
| A | `tool_budget` | 2 / 1 | 4 / 11 | 55 + 16 | Matches |
| B | Actual `length` | 2 / 0 | 454 / 938 | 23 + 287 | Matches |

Both reports have `phase=closing`, `outcome=answered`, `stopCause=natural_stop`, `closingAttempted=true`, no closing tools and exactly two priced attempts. Total recorded cost381 microUSD (**$0.000381**). This proves real-provider engine streaming, persistence and accounting under the dedicated harness budgets; it does not exercise HTTP admission/browser routing/full preparation or certify other providers.

## Still open

- Live per-token wire overhead and duplicate reasoning traffic; existing oversized stored rows are not migrated/reclaimed.
- The removed150s idle/300s outer watchdogs and an overall preparation/finalization bound; current model timers are covered, those broader bounds are not restored.
- 8,192-token catalogue/browser certification and real-provider Kimi/Qwen closing behavior.
- Actual per-attempt outcome/stop-cause recording (currently null), post-tool cross-provider failover, full destination-specific prefetch rebuilding, and the other section3 architectural/legacy-evidence limitations above.
- Unmapped review subcases explicitly listed above, including incognito arbitrary-ID projection; no blanket claim that every saved adversarial subcase passes.

The branch was deployed to **staging only**. Passing this gate and the two bounded Flash cases is not a production-ready declaration; the open items remain visible for owner review.
