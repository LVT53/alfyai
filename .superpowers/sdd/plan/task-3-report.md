# Task 3 report — every saved streamed turn records its ending

Implemented by GPT-6 / Codex on `fix/turn-completion`, in `/Users/lvt53/.codex/worktrees/turn-completion/alfyai` only. Based on Task 2 `850eda177`; no subagents, push, deployment, build, full suite or full gate run.

## Commits

1. `a1b8a3501` — `Record model run ending facts so hidden calls and step limits are observable`.
2. `Persist private turn endings so every saved stream has an observable outcome` — the second focused commit contains the runtime, completion record, tests, documentation and this report.

All staging uses explicit named paths. The worktree was clean initially; no unrelated/controller edits were overwritten.

## Changes and ownership

- `src/lib/server/services/normal-chat-model/index.ts` and `index.test.ts`: finish events carry optional `stepCount`, `lastStepOutputTokens`, `droppedToolCalls` for compatibility with existing event mocks. Real production finish events always count `finish-step` parts and hidden tool calls, including zero. Last-step output tokens are assigned on every finish-step, so an unreported final step cannot accidentally retain the previous step's tokens. Hidden calls log exactly once per call; result/error parts stay hidden without logging again. Names are cut to 40 characters.
- `src/lib/server/services/chat-turn/stream.ts` and `stream-runtime.test.ts`: count visible characters after the last non-delivering call and visible diagnostic characters stripped over the entire segment. Reset the first counter at precisely the existing final-answer fact's reset seam; preserve it for delivering tools. Compare raw versus sanitized buffers before holdback, so repeated flushes do not count the same stripped text twice.
- `src/lib/server/services/chat-turn/stream-orchestrator.ts` and its test: carry original streamed finish/step/drop facts independently from recovery and from error-warning classification. A stream error without a finish leaves the telemetry finish null. Set recovery `answered` inside fallback's success callback BEFORE `completeSuccess`; set `failed` before failed repair saves. Successful and failed stop-during-repair regressions assert stopped precedence and recovery state.
- `src/lib/server/services/chat-turn/stream-completion.ts` and its test: save all eight completion fields on assistant metadata; determine end in order stopped, paused, no_final_answer, recovered, answered. Log the exact content-free field sequence once at the durable receipt, after successful save. Tests cover answered/recovered/no_final_answer/paused/stopped, priority collisions, original statistics, unknown nulls and omission from terminal browser metadata.
- `src/lib/server/services/messages-types.ts`: the private `TurnCompletionRecord` shape. `messages.ts`: declare it on persisted metadata only; no ChatMessage projection or browser protocol field added.
- `src/lib/server/services/chat-turn/AGENTS.md`: document fields, precedence, original-run statistics, visibility counting, private storage and the durable log.

## Test-first evidence

Commands used Node 22 through explicit PATH; shell calls used the designated explicit workdir and `login:false`.

1. Added model regressions, then ran `npx vitest run src/lib/server/services/normal-chat-model/index.test.ts -t 'records original finish statistics|goes on after a call to a tool it does not offer'`: **5 failed, 140 skipped** because finish statistics were absent. Log: `/tmp/task3-model-red.log`.
2. Implemented model facts, then ran the complete focused model file: **145 passed**, `/tmp/task3-model-green.log`.
3. Added runtime, saved-record and repair-orchestration regressions before their implementation. Ran the three changed chat-turn test files: **13 failed, 334 passed** because counters and completion records were absent. Log: `/tmp/task3-record-red.log`.
4. Implemented the record/counters and reran those three files: **347 passed**, `/tmp/task3-record-green.log`.
5. Initial `npm run check` found **1 error, 0 warnings** in `stream-orchestrator.test.ts`: its local neutral-event fixture type did not admit the new optional finish facts. Extended that directly affected fixture in the already-owned file; no out-of-scope fixture change was necessary.
6. Final focused run: **7 files, 599 tests passed** (`/tmp/task3-focused-final.log`):
   - `normal-chat-model/index.test.ts`;
   - `chat-turn/stream-runtime.test.ts`;
   - `chat-turn/stream-completion.test.ts`;
   - `chat-turn/stream-orchestrator.test.ts`;
   - `chat-turn/stream-fallback.test.ts`;
   - `chat-turn/stream-terminal.test.ts`;
   - `chat-turn/streaming-normal-chat-model-run.test.ts`.
7. Final `npm run check`: **0 errors, 0 warnings**, `/tmp/task3-check-final.log`.
8. `npx biome check` across all 10 changed TypeScript files: **10 checked, no fixes/issues** after formatting. `git diff --check`: clean.

## Documentation checked and decisions

- Read the Task 3 brief first, Global Constraints, root AGENTS and applicable services/chat-turn AGENTS; inspected only relevant implementation/test seams, not the whole plan/history.
- Confirmed installed `ai` is **6.0.193** (`node_modules/ai/package.json`). Checked `node_modules/ai/dist/index.d.ts`'s TextStreamPart finish-step usage and finish totalUsage, and installed `index.js` finish-step emission. Used this installed v6 reference rather than the now-v7 SDK web reference.
- No docs MCP tools were available. Checked official Vitest mocks/spies documentation: https://vitest.dev/api/vi.html#vi-spyon.
- Visibility counting uses Unicode code points accepted by the existing shared `hasVisibleCharacter`: whitespace and the documented invisible characters do not count, consistently with Task 2. It counts characters, not UTF-16 units or grapheme clusters.
- Unknown original streamed facts are null; their log placeholders are `none` for finish and `?` for numeric unknowns. Runtime counters start at zero. No raw finish reason/error, prompt, user text, assistant text, or tool arguments are logged by TURN_END.
- Kept upstream warning classification unchanged and introduced a separate original-finish fact because an error event must not pretend to be a finish event.
- Preserved the existing timer clear before end-event recovery, fallback visible-text getter, stop callback, and pause precedence.

## Concerns / remaining controller verification

No known Task 3 correctness/typecheck concerns. Full release/agent gates, build, Fallow and e2e remain for the controller's final integrated verification, as explicitly scoped by the user. The initial sandbox could not write this designated worktree; reviewed escalation permitted the requested edits/tests. No automatic approval rejection occurred.
