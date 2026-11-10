# A turn ends with an answer: implementation plan

**Spec:** `docs/plans/turn-completion/design.md` (read it first; it is short). **Goal:** D1 to D6 of the spec, in four
tasks, each built test-first by one agent and reviewed before the next starts.

## Global Constraints

- Work only in this worktree, on branch `fix/turn-completion`:
  `/private/tmp/claude-501/-Users-lvt53--claude-spares-spare-hyZLpc/a54c337d-c673-444c-a114-4a15a4a1ca87/scratchpad/wt-turn-completion`.
  Never touch the main checkout or another worktree. Never push. Every shell command starts with `cd` to that path.
- Node 22 only. Before `npx` or `npm`:
  `export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`.
  (`scripts/gates.sh` sets it itself.)
- Read the root `AGENTS.md` and the `AGENTS.md` of every folder you change code in, before changing it.
- Test first: for each behaviour write the test, run it and see it fail for the right reason, then write the code. The
  report shows the failing run and the passing run.
- Never weaken, skip or delete a test to get green, except the tests this plan names for removal or rewriting. No
  retries, no longer timeouts.
- Everything the app writes into a model request is ASCII English (ruling 79). `tests/integration/english-request-purity.test.ts`
  and `tests/integration/reply-language.test.ts` stay green.
- Every new UI string exists in English and Hungarian (`src/lib/i18n/chat.ts`). Svelte 5 runes only. No new inline SVG.
- No new top-level file in `src/lib/server/services/`. No new stream part type: the notice travels as one more value in
  the existing `completionWarningCodes` list.
- Stage named paths only (never `git add -A`). Small commits, one logical change each, the message says why. Commit
  attribution follows your own harness instructions.
- While iterating run single test files (`npx vitest run <file>`) and `npx biome check <changed files>`. Before
  reporting, once: `scripts/gates.sh agent "$PWD/../gate-task-N" --port 4310 --skip build,chunks,fallow,playwright`
  (N is your task number); every step it runs must exit 0. Never run `npm run build`.
- Be economical: targeted reads, short output tails. Say in the report which model you are and which docs you checked
  (for the AI SDK the installed source under `node_modules/ai/dist` is the reference: version 6.0.193).

## Task 1: Remove the `done` tool (D1)

**Files:** `src/lib/server/services/normal-chat-tools/index.ts`, `src/lib/server/services/normal-chat-model/index.ts`,
`src/lib/server/services/normal-chat-model/index.test.ts`, the tool catalogue snapshot
(`src/lib/server/services/normal-chat-tools/tool-catalogue.en.snapshot.txt`) and whatever test pins it, and any
`AGENTS.md`, README or e2e fake-provider text that names the `done` tool or `doneAfterAnswer` (grep `src`, `tests`,
the root docs; leave `docs/adr` and other dated documents alone).

**Behaviour:**

1. The tool set no longer has `done`. `ask_user` stays the catalogue's last tool.
2. In `normal-chat-model/index.ts` delete `DONE_TOOL_NAME`, `doneAfterAnswer`, the summary readers
   (`readDoneToolSummary`, `extractDoneToolSummaryFromCalls`, `extractDoneToolSummary`) and the three branches that hide
   `done` parts in `yieldStreamEvents`. `buildToolStopWhen` becomes `askedTheUser`, `stagnantProgress`,
   `stepCountIs(maxToolSteps)`. The plain run returns `result.text || ""`. Reword the comment on
   `buildFirstStepOnlyPrepareStep`, which explains itself through the deleted rule.
3. A call to a tool the run does not offer (a model may still call `done` from habit) is not shown: the run yields no
   `tool_call`, `tool_result` or `tool_error` event for a tool name that is not in the tool set this attempt was built
   with. The model still gets the SDK's error for it and the run goes on. An attempt built with no tool set at all is
   not filtered: it reports tool calls as before (the App generator reads that event to see a model that tried to
   call a tool; ruling after the Task 1 review).

**Tests** (`normal-chat-model/index.test.ts`):

- Remove the six tests that describe `done` ("uses a done tool summary as the plain assistant text", "keeps generating
  after a premature done call until answer text exists", "treats whitespace-only step text as no answer and keeps
  generating after done", "stops on a second premature done so an insistent model cannot loop", "stops immediately when
  done arrives in the same step as the answer text", "suppresses done tool summary text and neutral tool events in
  streaming runs") and helpers nothing else uses.
- Add: "goes on after a call to a tool it does not offer, and shows nothing of that call". Step 1 calls `done` (not in
  the tools, which hold one real tool); step 2 writes "The answer." Expect two requests, the text delivered, the second
  request carrying the SDK's error for the call, and no event whose `toolName` is `done`.
- Add: "the plain run returns the last step's text, and an empty string when that step has none".
- Add: "a preamble, a tool call, then a last step with text ends the run with that text" (two requests, finish `stop`).
- The catalogue snapshot and its token ceiling are regenerated the way their test says; `done` is gone from both.

If the SDK ends the run on an unknown tool instead of answering the model, stop and report NEEDS_CONTEXT with what it
does.

**Commit:** one, for example `fix(chat): remove the done tool; a reply ends when the model stops calling tools`.

## Task 2: The final-answer rule, the repair and the notice (D2, D3, D4)

**Files:** `src/lib/utils/tool-calls.ts` (+ its test), `src/lib/server/services/chat-turn/stream.ts`,
`stream-terminal.ts`, `stream-orchestrator.ts`, `stream-fallback.ts`, `stream-completion.ts` (+ their tests),
`src/lib/server/services/messages-types.ts`, `src/lib/components/chat/MessageBubble.svelte` (+ its test),
`src/lib/i18n/chat.ts`, `src/lib/server/services/chat-turn/AGENTS.md`.

**Behaviour:**

1. `isDeliveringToolName(name)` in `tool-calls.ts`: true for a file-production tool (`isFileProductionToolName`) and for
   `create_artifact`, `edit_artifact`, `make_image`, `suggest_instruction`, `ask_user`; false for every other name.
2. The chunk runtime (`createServerChunkRuntime`, `stream.ts`) keeps one more fact, `hasTextAfterLastToolCall`: false
   at the start; true once a visible chunk with a non-whitespace character has been put on screen (where
   `answerStarted` becomes true); false again at a tool-call event whose tool is not a delivering tool (where
   `answerStarted` is reset). `answerStarted` itself is not changed. For this fact a chunk is visible only when it
   holds a character that is neither whitespace nor zero-width (U+200B, U+200C, U+200D, U+2060, U+FEFF): on staging
   Kimi and DeepSeek each "answered" with one U+200B. Put that test in one exported helper beside the stream cleanup
   helpers (`src/lib/services/stream-protocol.ts`) so the repair (point 5) uses the same one.
   `hasVisibleAssistantAnswerOutput` keeps its meaning.
3. `stream-terminal.ts`, `completeOrRecoverAfterUpstreamEnd` only. New dependency `hasFinalAnswer()`. After the stop
   and the pause, in this order:
   - `hasFinalAnswer()` or a completed file-production call: success, as today.
   - else a completed non-file tool call, the policy allows it and a fallback runner exists: the repair, as today.
   - else `hasVisibleAssistantAnswerOutput()` (any visible text): success with `noFinalAnswer: true`.
   - else `failStream("backend_failure")`, as today.
   `completeSuccess` and `runCompleteStreamTurn` carry `noFinalAnswer`.
4. `stream-orchestrator.ts`: `hasFinalAnswer` reads the runtime's fact. In `fallbackToNonStreaming`, a repair that did
   not recover ends in `completeSuccess(false, { noFinalAnswer: true })` when any visible text exists, and in
   `failStream("backend_failure")` when none does. `emitResolvedAssistantText` puts a blank line (`"\n\n"`) before the
   repair's text when visible text already exists and the new text does not start with a line break.
5. `stream-fallback.ts`: an attempt counts as recovered only when the visible text grew during that attempt, by at
   least one visible character in the sense of point 2 (today "any visible text" passes at once after a preamble).
   Replace the `hasVisibleAssistantText` dependency with one that can tell.
6. `stream-completion.ts`: `noFinalAnswer` adds the code `no_final_answer` to `completionWarningCodes` (never on a
   stopped turn) and such a turn asks for no follow-up chips. `ChatTurnCompletionWarningCode` gets the value.
7. `MessageBubble.svelte` knows the code (`COMPLETION_WARNING_LABEL_KEYS`, `isKnownCompletionWarningCode`), key
   `chat.completionWarning.noFinalAnswer`. English: `The model stopped before writing its answer. Retry the message.`
   Hungarian: `A modell leállt, mielőtt megírta volna a választ. Próbáld újra az üzenetet.`
8. `chat-turn/AGENTS.md`: a short section "A Turn's Final Answer" that states the rule, where it lives, the delivering
   tools, the repair, the notice, and that the other four fallback sites keep "any visible text".

**Tests:**

- `tool-calls`: the delivering names, and three names that are not (`research_web`, `run_python`, `files`).
- `stream.ts` runtime: the fact is false at the start; true after visible text; false after a `research_web` call
  event; unchanged by a `create_artifact` call event; not set by text the cleanup removes.
- `stream-terminal.test.ts`: a final answer completes; a preamble with a completed non-file tool call goes to the
  repair and emits no error; a preamble when the repair was already attempted is saved with `noFinalAnswer: true`; a
  preamble with no completed tool call is saved with `noFinalAnswer: true`; no text and nothing to recover still
  fails; a completed file production with only a preamble still completes without the flag; the stop and the pause
  still win. Rewrite the two existing tests that use `hasVisibleAssistantAnswerOutput: true` to mean a final answer.
- `stream-fallback.test.ts`: recovered only when the visible text grew; rewrite "returns early if fallback text
  normalizes to no visible assistant text" and "retries once when fallback text normalizes to no visible output" on
  the new dependency.
- `stream-orchestrator.test.ts` (model the new tests on "recovers with non-stream fallback when a socket terminates
  after a completed non-file tool"):
  - preamble, `research_web` call and result, clean finish: the repair runs with tools off, its text arrives after a
    blank line, the turn completes without `noFinalAnswer`;
  - the same when the repair returns no text twice: the turn completes with `noFinalAnswer: true` and no
    `data-stream-error` is sent;
  - answer text after the tool result: no repair;
  - answer text, then a `create_artifact` call and result, then a clean finish: no repair;
  - no text, a tool result, the repair fails: the error, as today.
- `stream-completion.test.ts`: `no_final_answer` is in the terminal metadata and in the saved metadata; no follow-ups
  are generated for it; a stopped turn never carries it.
- `MessageBubble`: the notice renders for the code in both languages.

**Commits:** two or three (the rule and repair; the notice; the docs).

## Task 3: Every streamed turn records how it ended (D5)

**Files:** `src/lib/server/services/normal-chat-model/index.ts` (+ test), `chat-turn/stream.ts`,
`stream-orchestrator.ts`, `stream-completion.ts` (+ tests), the assistant metadata type where it is declared,
`chat-turn/AGENTS.md`.

**Behaviour:**

1. The model run's `finish` event gains `stepCount` (the number of steps the run made) and `lastStepOutputTokens`
   (the last step's output tokens, when the provider reports them).
   It also gains `droppedToolCalls`: how many calls to a tool the run does not offer it hid (Task 1's rule), and the
   run logs one content-free line per hidden call, `[NORMAL_CHAT_MODEL] dropped a call to a tool that is not offered`,
   with the tool's name cut to 40 characters. Today a hidden call leaves no trace anywhere.
2. The chunk runtime counts `visibleCharsAfterLastToolCall` (visible characters put on screen since the last
   tool-call event of a tool that is not delivering; reset with `hasTextAfterLastToolCall`) and `strippedVisibleChars`
   (characters `stripLeakedToolDiagnostics` removed from visible text over the whole turn).
3. Every streamed turn that is saved (answered, repaired, paused, stopped) stores in the assistant message's
   `metadata_json`:
   `completion: { end, finish, steps, lastStepOutputTokens, charsAfterLastToolCall, strippedChars, recovery, droppedToolCalls }`
   - `end`: `"stopped"` if stopped, else `"paused"` if it paused to ask, else `"no_final_answer"` if it carries that
     code, else `"recovered"` if the repair wrote the answer, else `"answered"`.
   - `finish`: the streamed run's last finish reason, `null` when the stream closed without one.
   - `steps`, `lastStepOutputTokens`: the streamed run's, `null` when unknown.
   - `recovery`: `"none"`, `"answered"` or `"failed"`.
   It is stored only: nothing sends it to the browser.
4. One log line per saved streamed turn, content-free:
   `[TURN_END] end=<end> finish=<finish or none> steps=<n or ?> lastStepOut=<n or ?> afterLastTool=<n> stripped=<n> recovery=<recovery> dropped=<n> model=<model id>`.
5. `chat-turn/AGENTS.md`: the record's fields in the "A Turn's Final Answer" section.

**Tests:** the `finish` event carries both fields for a one-step and a three-step run, and `droppedToolCalls` is 1
after one call to a tool that is not offered (0 otherwise), with the log line written once; the two counters (a tool call
resets the first, a delivering tool does not; a removed leak adds to the second); the saved metadata holds the record
for an answered, a repaired, a `no_final_answer`, a paused and a stopped turn; the log line has exactly those fields
and no message text.

**Commits:** two (the run's fields; the record and the line).

## Task 4: A tools-off recovery asks for no reasoning (D6)

**Files:** `src/lib/server/services/chat-turn/stream-fallback.ts` (+ test), `src/lib/services/stream-protocol.ts`
(+ test) only for a shared opener check, and only if the documentation requires it the replay in the fallback file.

**Behaviour:**

1. A recovery attempt that runs with tools off (`shouldDisableTools` in `buildFallbackAttemptParams`) asks the provider
   for no reasoning, through the seam the turn's reasoning depth already uses (what the "quick" depth sends for that
   provider family; a family without a switch is left alone). An attempt that keeps its tools keeps the turn's own
   setting. Do not add a second way to set provider options.
2. Check DeepSeek's API documentation on thinking mode with tool calls (say what you read and where). If a request with
   reasoning off must still pass `reasoning_content` back for assistant messages that carry tool calls, the replay for
   that family (`buildContinuationMessages`) is sent as text instead (`renderHistoryTurn` has a flatten mode). If not,
   the replay stays as it is.

3. A tools-off recovery is told plainly that it cannot call tools. In `buildFallbackAttemptSystemPrompt` the sentence
   for the ordinary case becomes: `The previous streaming attempt completed these tool calls before ending without a
   final answer. You cannot call tools in this reply. Use this compact tool context to write the final answer now, as
   plain text.` (one line in the code). The sentence for a file request stays as it is.
4. A recovery reply that is a tool call written out as text is no reply. On staging's old code DeepSeek's recovery
   twice returned its tool-call markup as the answer, and it was saved as one. The real replies are in
   `docs/plans/turn-completion/recovery-reply-samples.json` (the two `<｜｜DSML｜｜ calls>` entries; the
   bars are U+FF5C). A reply whose first visible characters open such a block counts as "returned no text" (the
   existing second attempt, then the failure path). Recognise DeepSeek's opener from the samples, and whatever
   tool-call openers the stream cleanup in `src/lib/services/stream-protocol.ts` already recognises; add no pattern
   that neither a sample nor an existing test backs. A reply with no visible character (Task 2's helper) also counts
   as no text.

**Tests:** the request a tools-off recovery sends for a DeepSeek-family provider and for a Qwen-family provider has
reasoning off (compare with what a "quick" turn sends for the same provider); a recovery that keeps its tools sends the
turn's own setting; if the replay changed, a test that shows the DeepSeek request holds no assistant message with tool
calls; the new instruction sentence is in the tools-off request and the old one is in none; each DSML sample is
treated as no text and leads to the second attempt, while a reply that merely mentions a tool in a sentence is kept;
a reply of one U+200B is treated as no text.

If neither step is a small change through existing seams, stop and report BLOCKED with what you found. Do not build a
new mechanism.

**Commit:** one.
