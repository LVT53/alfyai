# Second independent review: the remediation of Normal Chat completion

Reviewer: Claude Fable 5.2, 2026-11-12. Same method as the first review ([first verdict](fable-verdict-2026-11-11.md)): fresh isolated exports of the gated commit, four slice reviewers (two Opus 5.5, two Sonnet 5.5), and every finding below rerun by me. This time I also did the three items left for me: the Kimi output limit, the Qwen runner precondition, and the stale checklist entries.

## Update, later on 2026-11-12: ready for the owner's production decision

The owner asked for findings 2.1 and 2.2, the capacity risk and the provider proof to be fixed. That is done, and the verdict below is superseded by this section.

| Item | State |
|---|---|
| 2.1 reply discarded near the deadline | Fixed: finalization has its own 30-second window after the model deadline, on both transports (`bbe079a27`, `fc3732915`). The original reproducer passes |
| 2.2 delivered, nothing saved | Fixed: a failure for observers, queue kept (`6b2519910`, `bd0a08e4e`). The original reproducer passes |
| Capacity check against the tool catalogue | Fixed: preparation sizes the turn's real catalogue and leaves room for it (`42406f958` to `ea80fa788`). Production's three models keep exactly their target (102,200) and output cap, checked by a real run on old and new code |
| Proof runner | One cap field, the app's own context rule, 4,096 tokens for the length case's closing (`154358922`, `c6f8a0d4f`) |
| Full release gate on `ea80fa788` | Every step passed: typecheck 0 errors and 0 warnings in 9,128 files; 26,239 unit tests; 1,593 browser tests, 0 failed, 0 flaky; Fallow nothing new |
| Staging | `releases/ea80fa788`, health OK before and after the proof |
| Provider proof on `ea80fa788` | All six cases pass: DeepSeek Flash, Kimi and Qwen, each with the tool-budget case and the 32-token length case ending in a tools-off closing that answered. 12 provider calls |
| Independent check of the ten fix commits | Nothing above low severity. The model cannot exceed its request time, nothing is saved twice, the tool pack is built once with the same count the engine checks (16,529 tokens, about 1 ms per turn) |

Evidence is on the branch under `docs/plans/turn-completion-review/evidence-final-ea80fa788/`; the branch tip is `cca9ada0f` (documents only after `ea80fa788`), pushed to `fix/turn-completion` and nowhere else.

**What is still open** (none loses data; left out of this round by the owner's choice of scope):

- 2.6, the thinking header that appears while a plain answer streams: the owner is to look at it on staging.
- 2.3: failover after a tool has run sends the failed attempt's partial text to the second provider. Production has failover switched on, so this path exists there.
- 2.4, 2.5, 2.7 to 2.10, and the stale lines in the other documents listed in section 5.
- Low items from the last check: a turn whose preparation alone outlasts the 600-second deadline now ends as an empty incomplete reply instead of a timeout error; a pasted-URL fetch is not charged to a lowered context target (cannot occur with production's settings).
- Older than this work: the Apache config gives the plain route a 300-second proxy timeout while the app's request limit is 600 seconds.

**For a production deploy, when the owner decides:** the branch is 3 commits behind `origin/dev` (CI and test fixes); the deploy runs one additive migration (the two ledger tables), which the current production code ignores on rollback; production has no per-token rows, so no metadata repair is needed there. I have not deployed to production and this memo does not authorize it.

## Verdict at the time of the review: not ready yet, but close

The remediation is real. Every must-fix item of the first review is fixed, both owner rulings are implemented, the gate numbers are true, and no test was weakened to get there. Three things remain before the owner is asked to approve:

1. **One new defect from the remediation:** a reply that finishes close to the turn deadline is discarded and reported as failed (2.1 below).
2. **One display detail for the owner to look at on staging:** a thinking header appears while a plain answer streams and disappears when it commits (2.6).
3. **The provider proof is still partial.** Kimi's failed case was a defect of the test runner, now fixed, and the Qwen refusal is resolved, but neither has been rerun: the fix is committed locally and could not be pushed from this session.

This verdict never authorizes deployment.

## 0. What was reviewed

| Item | Value |
|---|---|
| Branch | `fix/turn-completion`, clean; `origin` at `36d2e374b` |
| Gated and staged runtime | `584cc9c3a` (72 commits and 44 source files after the first review's `29e51551f`); later commits were documents only |
| Staging | `current -> releases/584cc9c3a` (read-only check) |
| My commits (local, not pushed) | `154358922` runner fix; `d0fbabfa8` checklist cleanup |

## 1. First-review findings: status

The 33 original reproducers hold 121 test cases. On `29e51551f` 49 fail; on `584cc9c3a` 118 pass. The 3 that still fail are explained: two asserted the old behavior and now fail for the right reason (replay overflow, missing model identity), and one never releases a permit its own fixture was granted.

| Finding | Status | Evidence |
|---|---|---|
| 1.1 one saved event per token | Fixed | A 3,157-token reply stores 21 KB (was 1.66 MB); a 100-message window is 1.07 MB (was 83 MB). Old rows are compacted when read; staging's 192 old rows were repaired (41.2 MB to 4.0 MB) |
| 1.2 JSON-first answer erased | Fixed | Original and three new variants end `answered` with the exact text |
| 1.3 generation after Stop | Fixed | Original passes; a healthy backoff still resends |
| 1.4 a replay | Fixed | The journal now holds about 39,000 tokens (was about 300) |
| 1.4 b incognito, d hang, e blocked actions, f tool repair, h orphan call, i markup, j retry | Fixed | Originals pass |
| 1.4 c answered but not saved | Fixed for `answered` only | See 2.2 |
| 1.4 g failover carries partial output | Fixed before any tool ran only | See 2.3 |
| 1.5 rows | Fixed, except "delivered reported failed" | See 2.7 |
| 2.1 live answer streaming | Fixed, with two gaps | See 2.5 and 2.6 |
| 2.2 failed file job | Fixed | Three generations, two submissions, an answer; only `produce_file` with a settled job verdict counts, throws and timeouts stay uncertain |

Wire cost for the app's own browser is now 27 to 109 bytes per token (was about 600).

## 2. New or remaining defects

Each has a failing reproducer in `reproducers-2/` unless marked.

| # | Severity | Defect | Where | Trigger and effect |
|---|---|---|---|---|
| 2.1 | Medium-high, new | A reply finishing near the deadline is discarded and reported failed | `stream-orchestrator.ts:457-460`, `:1016`; `completion.ts:808-809`; plain route `send/+server.ts:107-112`, `plain-turn-lifetime.ts:84-91` | The new watchdog and the engine share one deadline, so finalization gets no time. In the test, closing ends 500 ms before the deadline: no row is saved and the browser gets an error. Before the remediation such a turn was saved as incomplete. Staging's limit is 600 s, so the trigger is rare; the loss is the whole reply |
| 2.2 | Medium | "Delivered, nothing saved" is still observed as success | `completion-lifetime.ts:285-286`; runtime `:2077-2081` | A file turn whose reply cannot be saved: an observing browser shows no error and sends the queued follow-up |
| 2.3 | Medium | Failover after a tool has run sends the failed attempt's partial text and reasoning to the second provider | `completion.ts:1343-1366` | Needs a configured fallback model (staging has failover off) |
| 2.4 | Medium, new | The browser's clock decides when a pending turn is given up | runtime `:2427-2449` | The server's absolute deadline is compared with the browser's clock. A clock running ahead gives "status unavailable" while the server still finishes |
| 2.5 | Medium-low | A stale preview stays in the answer area while the browser only polls | runtime `:4305-4310`, `:2441`; `MessageBubble.svelte:414` | Connection drops mid-step and replay is unavailable: "Let me search the web for that." stays shown as the answer until the turn ends |
| 2.6 | Medium-low | A thinking header appears while a plain answer streams and vanishes at commit | `MessageBubble.svelte:1251` | Every answer from a model that sends no reasoning. The owner's rule was that the thought-step UI stays as in production |
| 2.7 | Medium-low | A delivered file is still reported `failed` when a read-only lookup follows it and the last steps fail | `completion.ts:1467-1476` | Invites a Retry and a duplicate file |
| 2.8 | Low-medium, not a regression | Only DeepSeek's markup string counts as tool markup | `stream-protocol.ts:1033-1035` | Qwen-style `<tool_call>` after a sentence is saved as an answer; the local model is Qwen |
| 2.9 | Low | Clients that did not negotiate compact frames get no live text or reasoning | `stream-orchestrator.ts:385`, `:554`, `:1024` | Tabs still open from the old release during a deploy show the answer only at the end |
| 2.10 | Low, trace only | A malformed saved event can fail the read of a whole conversation | `messages.ts:437-446` | Needs corrupt metadata |

### A configuration-dependent risk: tool schemas in the capacity check

The engine now counts tool schemas when it checks that a request fits, and refuses before any provider request if it does not. Context preparation still budgets as before. Measured with the engine's own counting, the real catalogue costs **11,595 tokens** with no connectors and **16,529** with all nine.

| Context | Room left when the built context is at its target | Catalogue fits |
|---|---|---|
| 146,000 with staging's explicit target of 102,200 | 25,104 | Yes, both |
| 146,000 with the default target (90%) | 9,044 | No |
| 131,072 with the default target | 7,701 | No |
| 200,000 with the default target | 13,904 | Base only |

Staging is safe because `TARGET_CONSTRUCTED_CONTEXT` is set to 102,200. I did not read production's value. Any model whose context is about 14,000 tokens or less now refuses every tool turn, by design.

## 3. Kimi and Qwen

- **Kimi case B was a runner defect.** For staging's exact binding the app's adapter sends the cap as `max_completion_tokens: 1024` (checked with the real adapter code). The runner added `max_tokens: 32` beside it. Fireworks documents the two as aliases that "cannot be specified together", and kept the 1,024. The recorded `cap: 32` never applied. The `accounting_not_ready` label was misleading as well: accounting was complete.
- **Fix, test-first:** commit `154358922`. The gateway replaces whichever cap field the request carries. The Qwen precondition now accepts the catalogue row's context or, when the row has none, the runtime value the app itself uses. Four new tests failed first; gate on the commit: 26,159 unit tests passed, typecheck clean, Fallow unchanged (browser step skipped: script-only change).
- **Not done:** rerunning Kimi and running Qwen. The runner only runs from a staging release, and the push of `154358922` was refused by this session's permission check.
- **Known limits of the runner** (not fixed): it does not load admin overrides, so it runs on environment defaults; its report records no provider, model or cap field; `closingDeltas` counts reasoning deltas; my new cap test builds the request by hand and should be pinned to the real adapter.

Closing against real providers is so far proven for DeepSeek Flash (both cases, twice) and Kimi case A.

## 4. Gate and tests

- **Final gate, from its raw files:** ran at `584cc9c3a`; 26,155 unit tests passed, 3 skipped; 1,593 browser tests passed, 75 skipped, 0 failed, 0 flaky, retries 0; typecheck 0 errors and 0 warnings in 9,126 files; Fallow four known cycles, nothing new. The skipped tests are screenshot and recording helpers.
- **The two commits after the first failed gate are genuine corrections**, not loosened oracles. `584cc9c3a` only raises fake models' context from 8,192 to 131,072 in 14 browser files, because the new capacity check refused them.
- **No test was deleted, skipped or weakened.** Several were inverted on purpose, each with an exact replacement. One inversion the owner should know: **Copy, export and "Open as document" no longer mark an interrupted answer.** The first review found the English-only label inside copied content; the fix removed the label from content altogether, which matches production. `spec.md:95` and `chat-turn/AGENTS.md:96` still require a label.
- **"8,192 certified" is narrower than it reads:** refusal with the real catalogue is proven in the browser; the fitting case is a synthetic one-tool catalogue.

## 5. Documents

I corrected the stale entries in `remaining-work-checklist.md` (commit `d0fbabfa8`) and added a dated follow-up section. Still stale elsewhere, for Codex:

- `README.md:186-187` says attempt outcome and stop cause "currently remain null"; they are recorded now.
- `remediation-report-2026-11-11.md:5`, `:63`, `:65`, `:91`, `:106`, `:112`, `:143-146` describe items as open that were later done; `:163` and `FABLE-HANDOFF.md:37` carry the wrong Kimi explanation.
- `contract/verification.md` still presents `29e51551f` as current; `contract/implementation-plan.md:114` and `verification.md:39` say tool schemas are not counted.
- `contract/spec-review.md:5` still says the delayed answer is accepted, with no superseded note.
- The evidence file's Qwen entry is the `started` placeholder; no saved file shows the refusal.
- Neither new script is listed in `.fallowrc.json`.

## 6. Minimum before the owner is asked to approve

1. Give finalization its own time after the engine's deadline (2.1).
2. Treat "delivered, nothing saved" like "answered, nothing saved" (2.2).
3. Owner looks at 2.6 on staging and says whether the header is acceptable.
4. Push `154358922`, deploy to staging, rerun Kimi and run Qwen; record the result.
5. Confirm production's `TARGET_CONSTRUCTED_CONTEXT`, or make preparation subtract the catalogue.

Next in line: 2.3, 2.4, 2.5, 2.7, 2.8, then 2.9, 2.10 and the document list.

## Appendix

- `reproducers-2/`: 15 files, saved as `.txt`; `~` stands for `/`. Run them on an export of `584cc9c3a` as in the first memo.
- Staging reads were read-only and returned names, settings, lengths and counts only.
