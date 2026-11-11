# Review remediation — 2026-11-11

Baseline: `495282bf4` (validated code `29e51551f`, later documentation only). No provider calls, push or deployment in these fixes.

## 1.1 — Compact stored and read output events

- Original `zz-review-main-persisted-events-size` probe ran unchanged and passed its measurement oracle. Before: 307 / 3,166 / 6,009 stored events; 161,564 / 1,683,676 / 3,193,580 bytes for 1,500 / 9,785 / 20,000 answer characters (latter two include reasoning).
- Added desired invariant in `tests/integration/normal-chat-output-size.test.ts`: metadata <= total text bytes + 8,000 fixed overhead; <= 12 events for these one-step cases. RED: 161,564 was not < 9,500. Legacy-read test RED: 157,419 was not < 7,000.
- Compact snapshot journal combines each scoped block's deltas, preserves all structural events/first sequence and leaves live callbacks untouched. Finalize compacts defensively; message readers compact old per-token metadata without changing stored rows.
- GREEN: 6 focused files, 208 tests (`normal-chat-output-size`, shared reducer, finalize, messages, completion, completion SDK). Replay/scope/interleaving/idempotency/input-immutability covered.
- Logs: `/tmp/turn-completion-remediation/1.1-original-before.log`, `1.1-invariant-red.log`, `1.1-focused-green.log`.
- Existing oversized database rows are not rewritten here; reads serve compact output, but disk space/parse cost needs an explicit migration if desired.
- Docs checked: official Vitest CLI (https://vitest.dev/guide/cli.html), AI SDK generation guide (https://ai-sdk.dev/docs/ai-sdk-core/generating-text); no SDK API changed.

## 1.2 — Preserve JSON code-block answers

- Ran the original D sanitizer cases and A completion JSON case before changes: 4 failed (13 unrelated A cases filtered out). Log: `/tmp/turn-completion-remediation/1.2-original-red.log`.
- Explicit DSML remains control syntax; a JSON fence and ordinary property names do not determine output ownership. Structured final normalization and incremental prefix cleanup preserve fenced examples too; legacy nonstructural cleanup is unchanged.
- The old JSON-is-markup test oracle was corrected to require preservation, as identified in review section 6. Original exact-text assertions retained in permanent tests; additionally assert final normalized content exactly equals the entire answer.
- Original cases GREEN: 4 passed (`1.2-original-green.log`). Seven affected suites GREEN: 164 tests (`1.2-focused-green.log`), including explicit DSML/private-thinking protection and metadata size coverage.
- No new model calls, changes to completion policy or interpretation of prose words.

### 1.2 independent-review follow-up — generic JSON payloads

- Reviewer found structured final normalization still erased a valid `{version:1, blocks:[...]}` example through the legacy document-payload scanner.
- Added bare/fenced regressions for version/blocks, documentSource blocks/template and program/sourceCode, plus four incomplete JSON-prefix cases. RED: 8 failed, 4 passed (`/tmp/turn-completion-remediation/1.2-payload-red.log`).
- Restricted generic document/program payload scanning and prefix buffering to legacy leading cleanup. Structural answers keep these JSON shapes; explicit DSML and private-thinking removal still pass.
- GREEN: 3 suites, 110 tests (`/tmp/turn-completion-remediation/1.2-payload-green.log`). No changes to completion/UI files owned by the concurrent worker.

## 2.1 — Restore live answer streaming

- RED: two focused tests failed: first provisional chunk absent from the answer UI; SDK tool-start snapshot still provisional while its deferred execution waited. Log: `/tmp/turn-completion-remediation/2.1-red.log`.
- The answer area previews only the live current step's provisional blocks. Canonical `message.content` stays answer-only. First tool occurrence emits structural activity settlement immediately; later text in that step remains activity. Thinking presentation and completion eligibility are unchanged.
- GREEN: 427 tests across MessageBubble, ThinkingBlock, output view, completion, SDK and staging-verifier suites; two additional exact settlement/Stop tests pass. Logs: `2.1-focused-green.log`, `2.1-broad-green.log`, `2.1-settlement-green.log` in the same directory.
- Browser cases added with provider frame gates: visible first and subsequent chunks before finish; tool-call withdrawal; saved answer, reload, Copy and export exclude commentary. They await the orchestrator's release gate (no extra build run here).
- Current spec, thinking display amendment, ADR-0026/0056 and chat folder rules amended; historical verdicts remain unchanged. Official Svelte `$derived` docs and Vitest timer docs checked.

## 2.2 — Continue after known terminal file-job failure

- Original reviewer `zz-review-A-prepared.test.ts` copied into the permanent suite with its assertions unchanged. RED: one generation/submission instead of the expected three generations/two submissions; `/tmp/turn-completion-remediation/2.2-original-red.log`.
- Replaced the old submitted-failure oracle as requested. Additional invariant RED: five failures across known failure and returned/thrown/abort/timeout certainty tests (`2.2-invariant-red.log`).
- The file operation owner supplies a private identity-bound fact for settled failed jobs. The exact model result retains that fact through envelope compaction. A known failure remains in the working loop within its existing two-submission cap. Generic failed rows grant no certainty; running jobs and envelope errors are uncertain and cannot continue or close.
- GREEN: 158 tests in six suites, including the original reproducer, prepared turn, tool envelope, file patch mode, completion policy and real SDK orchestration (`2.2-broad-green.log`). Actual submitted in-flight and internally caught job-read timeout paths each stay at one generation/submission with `uncertain_execution`.
- Current contract spec, file refusal/certainty amendment and ADR-0026 now distinguish known failure from unknown effects. Official AI SDK tool-calling documentation checked (https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling); no new provider calls or SDK API changes.

## 1.3 — Stop fences capacity backoff

- Original C-capacity reproducer RED: two fresh POSTs after Stop, expected one (`/tmp/turn-completion-remediation/1.3-original-red.log`).
- Capacity retry captures the turn epoch and rechecks stream ownership before dispatch. Stop/new turn/navigation invalidates the scheduled action.
- GREEN: retained regression plus runtime suite, 363 tests (`1.3-green.log`). Original assertions retained in `normal-chat-capacity-stop.test.ts`.
