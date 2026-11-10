# Turn completion: verification and stopping point

2026-11-10. Tested code: `875db06348ae70a1b44031dc8769f5ce11b4d67a`, branch `fix/turn-completion`.
Staging: https://ai.dev.alfydesign.com, `langflow-chat-dev.service`, port 3002.

## Verdict

The fast route passed the agreed Kimi and Qwen checks. It is **not sufficient across all three models**:
DeepSeek rejected two ordinary tool continuations because its required `reasoning_content` was not passed back.
The tools-off recovery itself succeeded on DeepSeek. Implementation stops here, as the owner requested; no deeper
provider-continuation or recovery redesign was built.

## Implemented and reviewed

- Removed `done` and its summary stand-in. Unoffered calls are hidden/countable only for runs that offer tools;
  a tool-free App-generation run retains its existing tool-call event contract.
- A clean stream ending needs visible text after the latest tool requiring an answer, or a successful delivery.
  Artifact/image delivery and instruction offers use their producer's success metadata. Failed/pending delivery
  does not qualify; subsequent research invalidates an earlier delivery. Text and delivery facts remain separate.
- Existing recovery appends separated text and must add a visible character. Failed recovery preserves existing
  text with the localized `no_final_answer` notice and no follow-up chips. Stop and question-pause precedence remain.
- Tools-off recovery uses existing quick-depth provider controls, actually omits tools, and rejects invisible or
  recognized raw tool-call replies before emitting them.
- Every saved streamed turn stores a private completion record and writes one content-free `[TURN_END]` line.
- Reviews found and fixed idle-watchdog races during clean-end/error-event recovery and a stop race after successful
  recovery. A duplicate recovery is guarded at the shared entry.

Independent task and whole-branch reviews are complete, including scoped verification of their fixes.

## Local verification

Full command:

```sh
scripts/gates.sh agent /tmp/alfyai-turn-completion-gate --port 4710 --workers 4 \
  tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts \
  tests/e2e/ask-me-first.spec.ts tests/e2e/fake-provider-chat.spec.ts
```

| Check | Result |
|---|---|
| Unit suite | 24,803 passed; 3 existing skips; 1,297 files passed, 1 existing skipped file |
| Playwright | 90 passed; 0 failed, skipped or flaky |
| Build | Passed; compiler warnings clean |
| Biome, migrations, artifact chunks | Passed; Biome retains one existing informational diagnostic |
| Fallow 3.33.1 | Passed; four existing cycles unchanged; no new findings |
| Typecheck | Zero errors/warnings in 9,065 files |

The first full run exited 1 solely because the check command emitted human output while the gate parser expected
machine output. Commit `875db0634` selects documented `--output machine`; it does not relax parsing or warning
thresholds. Its 78 focused gate tests passed and its diff was independently reviewed. The corrected check-only gate
then exited 0. Product code did not change between the full run and that rerun. The complete unit/browser suite was
not redundantly rerun for this command-format correction.

Logs: `/tmp/alfyai-turn-completion-gate/`, `/tmp/alfyai-turn-completion-check/`,
`/tmp/alfyai-turn-completion-deploy.log` on the Mac.

## Real-model staging results

All prompts were synthetic, in new conversations in the existing dedicated staging test account. Reasoning depth
was explicitly `thorough`. Kimi ordinary turns comprise 12 tools prompts plus 8 repeated reproduction prompts.

| Model | Ordinary turns admitted | Ordinary outcomes | Silence/empty-reply controls |
|---|---:|---|---|
| Kimi K3.1 Pro, Fireworks | 20 | 20 answered directly; no recovery/notice/error | 4: 1 direct answer, 2 recovered, 1 missing-answer notice |
| Qwen 3.8 Flash Next, local | 20 | 20 answered directly; no recovery/notice/error | 4: 2 direct answers, 2 recovered |
| DeepSeek V4.1 Flash | 8 | 6 answered; 2 provider errors after `fetch_url` | 2: 1 direct answer, 1 recovered |

Four additional DeepSeek attempts were rejected with HTTP 503 `CAPACITY_EXCEEDED`, `reason=user_limit`, before
model generation: running three models together exceeded the test account's concurrency limit. Those rejections
are excluded from model-quality counts. Account limits were not changed. The initially interrupted DeepSeek control
sets were completed after Qwen finished. The ordinary suite was not extended after the two genuine failures.
DeepSeek therefore fails the acceptance bar and did not reach twelve admitted ordinary turns.

Across 62 attempted conversations: 56 assistant turns were saved, four requests were refused at admission, and two
ended in provider errors. The saved turns comprise **50 answered, 5 recovered, 1 explicitly flagged unanswered**.
Every saved turn had its completion record; the journal had exactly 56 `[TURN_END]` lines. The audit found:

- zero unflagged saved turns with tools and zero visible characters after the last relevant tool;
- zero dropped/unoffered-tool calls;
- correct provider model names in the test turns' usage rows: `accounts/fireworks/models/kimi-k3p1-pro`,
  `qwen3-6-27b`, `deepseek-flash` (staging's local display name remains the older “Nemotron 3 Super”).

The deliberately blank Kimi reply had a one-character invisible body, zero visible post-tool characters and failed
recovery. It carried `no_final_answer` in persisted and streamed metadata instead of silently completing. Both EN/HU
notice renderings passed component tests; a separate staging browser-DOM check of that notice was not performed.

Structured evidence: [staging-results-2026-11-10.json](./staging-results-2026-11-10.json).
Raw synthetic runs and the full per-ID audit remain on the server in `/tmp/turn-completion-codex/`.

## Why DeepSeek stops this run

The two errors are ordinary streamed tool-loop continuations after `fetch_url`, not the new recovery request.
The journal reports twice:

> The `reasoning_content` in the thinking mode must be passed back to the API.

The planned tools-off silent recovery did write an answer on DeepSeek. Its official documentation says a request
without `tools` does not require reasoning pass-back, and request-level tests verify tools are omitted. The next
bounded investigation should preserve the required native reasoning on DeepSeek's **main tool continuations**, then
rerun the two fetch cases and a full admitted ordinary suite. The exact adapter/prepare-step loss point has not been
isolated here. A general streamed closing/recovery redesign should be decided separately with this evidence.

## Deployment, data touched, and remaining scope

Only `origin/fix/turn-completion` was pushed. Staging moved from `68fff8c65` to `875db0634`; deployment and health
passed. The release was unchanged before and after model testing. Final health: `status=OK`, `draining=false`,
`activeStreams=0`. Staging remains on this side branch. No push to `dev`/`main`, production deployment, or production
DB access occurred in this continuation.

Server writes: staging release/deploy backup and normal release pruning; the synthetic account's conversations,
assistant metadata and usage/tool records; scripts/results under `/tmp/turn-completion-codex/`. The provider/model
rows copied earlier by Claude were already present and were not modified here. Read-only SQL was scoped to exact
assistant IDs from this run; journal reads covered the staging test window. No owner conversation/document became
test input.

Remaining by design: budget/stagnation closing steps, a streamed recovery from full original messages, semantic
recognition of narration in a final step, and non-streaming send-route completion. Deferred nonblocking findings:
empty `tools: {}` filtering, the older App raw-finish spelling mismatch, and recovery overwriting applied-depth
diagnostics while preserving requested depth.

## Rulings in this continuation

- Reused the saved branch in a managed worktree and available Codex subagents; Sonnet/Opus aliases were unavailable.
- Used focused tests per task and one full gate, with a targeted rerun for the gate-format defect; this avoids
  repeating the full suite without product changes.
- Reconciled D2 with the detailed plan by recognizing successful delivery independently of text; otherwise valid
  caption-free artifacts/images would be warned or discarded.
- Fixed the adjacent inherited error-event watchdog race because it can duplicate recovery; fallback eligibility
  predicates were preserved.
- Corrected the gate invocation instead of weakening its strict result parser.
- Excluded admission refusals from model outcomes, retained all evidence, and stopped after genuine DeepSeek failures.

The complete earlier and current decision ledger is [progress.md](./progress.md). No deferred deeper fix is approved
or implemented by this report.
