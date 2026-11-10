# A turn ends with an answer (fast route)

Spec, 2026-11-10. Branch `fix/turn-completion`, from `origin/dev`. The tasks are in `plan.md` beside this file.

## The problem

A Normal Chat turn can be saved as a finished reply when the model never wrote its answer. On 2026-11-10 a Kimi K3.1
Pro turn in production wrote one sentence ("I'll calculate the costs…"), ran `run_python`, called `done`, and was saved
as a 95-character reply with no warning. A **preamble** below means text like that sentence: words the model writes
before a tool call.

## What we know

Measured on production (read-only) and in the service journal, 2026-10-20 to 2026-11-10:

- The Kimi loop ended on its first `done` step. The loop's check for "the answer exists" accepts text from any step
  (`doneAfterAnswer`, `normal-chat-model/index.ts`), so the preamble passed as the answer.
- The stream terminal has the same weakness: `hasVisibleAssistantAnswerOutput` is "any visible text"
  (`stream-orchestrator.ts`), so a preamble suppresses the recovery that exists for a turn with no text at all.
- Five turns ended with no text at all. All five ended on a normal last step (four `stop`, one `length`), not through
  `done`, the step budget or stagnation. The recovery answered three and failed two: DeepSeek refused its replay with
  "The `reasoning_content` in the thinking mode must be passed back to the API". One of the three needed its second
  attempt, because the first again produced reasoning and no text.
- No run reached the step budget (14 steps; the longest was 13).
- About 50 of 837 streaming runs ended through `done` with the answer in the same step. Without `done` those runs end
  the same way: a step with no tool call ends the loop (`ai@6.0.193`, `dist/index.mjs`, the `streamStep` continue test).

## Decisions

**D1. Remove the `done` tool.** A reply ends when the model stops calling tools. Nothing else used `done` except a
one-line summary that stood in for a missing answer on the non-streaming run; that stand-in goes too.

**D2. One rule for "this turn has a final answer", owned by the stream terminal.** At a clean end of the model stream
the turn has a final answer when visible text was shown after the last tool call that needs words after it. Visible
means what the person sees, after the stream's cleanup. A **delivering tool** needs no words after it, because its
result is itself the thing asked for: file production (`isFileProductionToolName`), `create_artifact`,
`edit_artifact`, `make_image`, `suggest_instruction`, `ask_user`. Every other tool needs words after it.

**D3. A turn without a final answer is repaired once, by the recovery that exists** (the non-stream run with tools off
and the completed calls replayed, `stream-fallback.ts`). Its text is added after what is already on screen, separated
by a blank line. The recovery asks the model for no reasoning (D6).

**D4. Never silent, never lost.** When the repair produces nothing, the turn is saved as it is and carries a new
completion warning, `no_final_answer`, which the reply shows as a notice. It is not turned into an error: the words,
the tool results and the reasoning stay. A turn with no visible text at all still ends in the error it ends in today.
A turn with `no_final_answer` gets no follow-up chips.

**D5. Every streamed turn records how it ended**, in its saved metadata and in one content-free log line, so the next
audit reads data and not message text.

**D6. A recovery attempt that runs with tools off asks for no reasoning**, on every provider family that has a switch
for it. Three of the five empty endings were reasoning with no text, and a DeepSeek request without reasoning is not
held to passing `reasoning_content` back (to be confirmed against DeepSeek's documentation in Task 4, then on staging).

**D7. The repair's reply has to be an answer.** A tool call written out as text, or a reply with no visible character,
counts as no reply. A baseline on staging's old code (2026-11-10, made-up prompts) showed why: DeepSeek's recovery twice
returned its tool-call markup (`<｜｜DSML｜｜ calls>`) and it was saved as the answer, and Kimi and DeepSeek each returned
a single zero-width space. The same baseline saved 1 of 20 Kimi tool turns as a preamble with nothing after the tool.
The recovery is also told plainly that it cannot call tools.

## Where each rule lives

| Rule | Owner |
|---|---|
| Which tools deliver | `src/lib/utils/tool-calls.ts` |
| Whether visible text followed the last tool call that needs words | the chunk runtime, `chat-turn/stream.ts` |
| What a clean end does with it | `chat-turn/stream-terminal.ts`, wired in `stream-orchestrator.ts` |
| The warning code, the chips, the record | `chat-turn/stream-completion.ts` |
| The notice | `MessageBubble.svelte`, `src/lib/i18n/chat.ts` (English and Hungarian) |

The other four places that decide on a fallback (connect failure, an upstream error event, the idle timeout, a thrown
stream error) keep "any visible text". They already end in an error or a warning the person sees.

## Not in this change

Kept for a later decision, with the staging results in hand:

- One extra model step with tools off after a forced ending (step budget, stagnation). Neither was seen.
- A repair that continues from the run's own messages instead of the replayed digests (a better answer, streamed).
- Replies whose last step put some narration on screen and then stopped (two Qwen turns in 90 days). The record (D5)
  is what will show their cause.
- The non-streaming send route (`/api/chat/send`) and its record.

## What "enough" means on staging

Real models on ai.dev, made-up prompts only, in a fresh test account. For each of Kimi K3.1 Pro, Qwen 3.8 Flash Next
and DeepSeek:

1. At least 12 turns that use tools (Qwen: 20), among them the shape that failed (a calculation with `run_python`).
   Enough: every turn is saved with a final answer or with the notice, and at most one turn per model needed the
   repair or ended with the notice.
2. One turn that is told to call a tool and then write nothing. Enough: the repair writes the answer, on DeepSeek too.
3. No turn's record counts a hidden call to a tool that is not offered (`droppedToolCalls` is 0: no model still calls
   `done` from habit), and no new warning in the staging journal.

If a model misses 1 or 2, the work stops there and the deeper options above go to the owner.
