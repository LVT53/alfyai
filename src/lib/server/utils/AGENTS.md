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
| `token-budget.ts` | Context window budget management with compaction thresholds |
| `artifact-decay.ts` | Time-based salience decay for artifact retrieval |
| `conversation-boundary-filter.ts` | Detects conversation boundaries for context splitting |
| `extractive-compression.ts` | Text summarization without LLM |
| `topic-shift-detector.ts` | Detects topic changes for memory management |

## Usage by Service

| Util | Used by |
|------|---------|
| `json.ts` | `task-state/`, `knowledge/` |
| `text.ts` | `task-state/`, `messages.ts` |
| `$lib/utils/tokens.ts` | `prompt-context.ts`, `token-budget.ts`, chat/title/token accounting services |
| `prompt-context.ts` | `context-selection.ts`, `task-state.ts` |
| `token-budget.ts` | Context compaction decisions |
| `artifact-decay.ts` | Knowledge retrieval ranking |
| `conversation-boundary-filter.ts` | Chat context assembly |
| `topic-shift-detector.ts` | Memory event emission |

## Conventions

- **No side effects**: Pure functions only
- **No external I/O**: No network calls, file access, or DB access
- **Server-only location**: Keep these helpers free of network/DB side effects, but do not import `$lib/server/*` modules into client bundles. Shared client-safe helpers belong in `src/lib/utils/`.
- **Typed defaults**: JSON parsing returns typed defaults on failure, never throws

## Anti-Patterns

- **No mutable shared state**: Utils must not maintain module-level state that persists across calls
- **No DOM access**: Utils should not reference `window`, `document`, or other browser globals
- **No date/time in constructors**: Pass timestamps as parameters for testability
