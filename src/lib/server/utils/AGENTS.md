# Server Utils — Shared Helpers

Low-level utilities consumed across server services. Pure functions, no side effects, no external dependencies.

## Structure

| File | Purpose |
|------|---------|
| `json.ts` | Safe JSON parsing with fallback defaults |
| `text.ts` | Whitespace normalization, text clipping |
| `constants.ts` | Shared retrieval/context thresholds |
| `math.ts` | Numeric helpers such as cosine similarity |
| `markdown-parser.ts` | Frontmatter + markdown body splitting |
| `prompt-context.ts` | Context section building, compaction, serialization to token budget |
| `artifact-decay.ts` | Time-based salience decay for artifact retrieval |
| `conversation-boundary-filter.ts` | Detects conversation boundaries for context splitting |
| `extractive-compression.ts` | Text summarization without LLM |
| `topic-shift-detector.ts` | Detects topic changes for memory management |
| `tool-refusal.ts` | The error a tool throws to turn a call down before it dispatched anything; the tool envelope records it as proven not executed |
| `turn-deadline-reason.ts` | The reason the completion engine's own timer aborts a model call with when the time for the model's work runs out, and `abortedByTurnDeadline`, which the tool envelope reads to tell that clock from a stop; a tool that only reads and was cut off by it has failed, any other abort leaves the call uncertain |

## Usage by Service

| Util | Used by |
|------|---------|
| `json.ts` | `task-state/`, `knowledge/` |
| `text.ts` | `task-state/`, `messages.ts` |
| `$lib/utils/tokens.ts` | `prompt-context.ts`, chat/title/token accounting services |
| `prompt-context.ts` | `context-selection.ts`, `task-state.ts` |
| `artifact-decay.ts` | `computeDecayScore`: the working set's message match only, never a sum of signals (`working-set.ts`); `computeCrossConversationDecay`: evidence ranking (`task-state.ts`) |
| `conversation-boundary-filter.ts` | Chat context assembly |
| `topic-shift-detector.ts` | Memory event emission |
| `tool-refusal.ts` | `normal-chat-tools/` (the envelope in `shared.ts`, `fetch-url.ts`), `memory-context/history.ts` |
| `turn-deadline-reason.ts` | `normal-chat-model/completion.ts` (the timer's abort reason), `normal-chat-tools/shared.ts` (the envelope reads it) |

## Conventions

- **No side effects**: Pure functions only
- **No external I/O**: No network calls, file access, or DB access
- **Server-only location**: Keep these helpers free of network/DB side effects, but do not import `$lib/server/*` modules into client bundles. Shared client-safe helpers belong in `src/lib/utils/`.
- **Typed defaults**: JSON parsing returns typed defaults on failure, never throws

## Anti-Patterns

- **No mutable shared state**: Utils must not maintain module-level state that persists across calls
- **No DOM access**: Utils should not reference `window`, `document`, or other browser globals
- **No date/time in constructors**: Pass timestamps as parameters for testability
