# Context budget guards for tool results — implementation spec

Status: approved shape, ready to implement. Owner: orchestrator. Worktree: isolated clone at
`/Users/lvt53/Downloads/alfyai-ctxbudget` on branch `dev` (base `1f3b64648`).

## Why

A single live tool result can consume the whole model context window. On 2026-11-04 at 18:42 CET,
`files list` returned every entry of a Nextcloud folder. The next provider step carried **237,569
input tokens**; with `max_tokens` fixed at 24,576 the request summed to **262,145 against vLLM's
262,144 window**, and the provider answered HTTP 400. The app surfaced it as
"The model provider returned an error…". The turn then failed identically on retry, because the
tool-result cache replayed the same payload.

Nothing in the app bounds a single live tool result, nothing re-checks the window between steps, and
`max_tokens` never shrinks as the prompt grows.

## What the user sees after this change

- A folder of any size lists as a bounded page plus a summary: "…contains 4,312 items (4,180 files,
  132 folders), newest first — showing 1–50. Narrow the path or use `search` for a specific name."
- Finding a named file, reading a file, and every other tool behave exactly as today.
- A turn that would previously fail with a provider error instead completes, with the largest tool
  results shortened to fit.

## Non-goals

- No change to retrieval, memory, document, or history budgets.
- No pagination protocol beyond `nextOffset`; no UI changes; no new user-visible strings.
- No change to `max_tokens` per request, and no change to the non-retryable classification of
  `context_length_exceeded`.
- Do not remove `citations` from `modelPayload`: `observeResult` sees that payload and evidence may
  depend on it.

## Design

Three layers, in order of what fails first.

1. **The tool returns a bounded view** (`files list`). Product fix: the payload is useful and small
   whatever the folder holds.
2. **The tool envelope owns a hard ceiling** (`TOOL_RESULT_MAX_TOKENS = 32_000`). Safety net for
   every present and future tool: no single result can own the window. The existing `read` cap
   (100,000 chars ≈ 25–29k tokens) sits under it and is unaffected.
3. **The model run re-checks the window before every step** (`CONTEXT_GUARD_MARGIN_TOKENS = 4_096`).
   The guarantee: `estimate(messages) + maxOutputTokens + margin <= maxModelContext`, or the largest
   tool results are replaced by their digest.

The guard subsumes a turn-level ledger: it re-evaluates the whole message list each step, so
accumulation across steps is bounded by construction.

## Slices

Each slice has one owner and a disjoint write scope. Every slice is TDD: a failing test first.

### Slice 1 — `files list` returns a bounded view

Write scope: `src/lib/server/services/normal-chat-tools/files.ts`,
`src/lib/server/services/normal-chat-tools/files.test.ts`.

- Add `const MAX_LIST_RESULTS = 50;` beside `MAX_SEARCH_RESULTS`.
- In `listOutcome`: order entries newest first — `mtime` descending, tie-break `name` ascending,
  entries without a valid `mtime` last by `name`. Then slice to `MAX_LIST_RESULTS`.
- `modelPayload` gains: `total: number` (the pre-slice count), `byType: Array<{ ext: string;
  count: number }>` (top 5, count descending then `ext` ascending; `ext` is the lowercased extension
  without the dot, `""` when there is none), and `nextOffset: number | null`
  (`results.length < total ? results.length : null`).
- The `message` names the total and the page when truncated, in English only:
  `${folderLabel} contains ${total} items (${fileCount} files, ${dirCount} folders), newest first —
  showing 1–${shown}. Narrow the path or use \`search\` for a specific name.`
  When not truncated, keep today's sentence.
- Keep `results` item shape, `citations`, `candidates`, and `buildPayload`'s contract unchanged.

Tests (in `files.test.ts`, existing helpers/fixtures first):
- 12-entry folder: all 12 returned, `total` 12, `nextOffset` null, message unchanged in shape.
- 4,312-entry folder: 50 results, `total` 4312, `nextOffset` 50, message contains `4312` and
  `1–50`, `byType` top entry is the most common extension.
- Ordering: newest `mtime` first, tie-break by name, missing `mtime` last.
- `candidates` still carries one entry per citation for the entries returned.

### Slice 2 — the tool-result ceiling

Write scope: `src/lib/server/services/normal-chat-tools/model-payload-budget.ts` (new),
`src/lib/server/services/normal-chat-tools/model-payload-budget.test.ts` (new),
`src/lib/server/services/normal-chat-tools/shared.ts` (one call site).

- `export const TOOL_RESULT_MAX_TOKENS = 32_000;`
- `export function capModelPayload<T>(payload: T, maxTokens?: number): T`:
  - Non-object payloads and payloads whose `stableStringify` size is within budget are returned
    **by identity** (`===`), so the common path allocates nothing.
  - Over budget: shallow copy; truncate every top-level string value longer than 4,000 chars to
    4,000 chars + `…`; then fill array values in key order with a per-array share of the remaining
    budget (`remaining / arrayCount`), keeping items in their existing order and appending
    `{ omitted: n }`-style counts under a sibling key `omitted` when items were dropped; always add
    `truncated: true` and `hint: "<name> returned more than one step can carry; narrow the request
    to see the rest."`. Never drop `success`, `name`, `action`, `message`, `sourceType`.
  - Deterministic: no size sorting, no clock, no randomness. Same input → deep-equal output.
- In `executeToolWithEnvelope`, apply it to the success `modelPayload` immediately before
  `observeResult`/`record` and return the capped payload (one import, one line). Leave the error
  path alone: error payloads are static strings.
- The deterministic serializer lives in `normal-chat-tools/stable-stringify.ts`, imported by both
  `shared.ts` (which re-exports it, so existing callers are unchanged) and the ceiling module; the
  ceiling must measure the same bytes as the rest of the tool layer, and importing `shared.ts` back
  would be an import cycle.

Tests:
- A 20-item payload under budget is returned by identity.
- A 3,000-item array payload comes back under the ceiling, `omitted` states the drop count,
  `message`/`success`/`name`/`action` survive.
- A 1 MB `message` string is truncated.
- Two runs deep-equal (determinism).

### Slice 3 — the per-step window guard

Write scope: `src/lib/server/services/normal-chat-model/context-guard.ts` (new),
`src/lib/server/services/normal-chat-model/context-guard.test.ts` (new),
`src/lib/server/services/normal-chat-model/index.ts` (compose the guard into
`buildAttemptPrepareStep`, pass it the two numbers it needs).

- `export const CONTEXT_GUARD_MARGIN_TOKENS = 4_096;`
- `export function buildContextGuardPrepareStep(input: { maxModelContext?: number;
  maxOutputTokens?: number; systemPromptTokens?: number }): PrepareStepFunction<ToolSet> | undefined`
  — `undefined` when either number is missing.
- On each step: `prompt = estimateHistoryMessagesTokens(messages, estimateTokenCount) +
  systemPromptTokens`; `required = prompt + maxOutputTokens + CONTEXT_GUARD_MARGIN_TOKENS`. When
  `required <= maxModelContext`, return `undefined` (the step is left untouched).
- Otherwise replace tool results in place, largest first, with `deriveToolResultDigest(payload)` plus
  `"\n\n[truncated to fit the context window]"`, until the step fits. If no tool results remain and
  it still does not fit, truncate text in protection order — the model's own text first, then older
  user messages, and the person's newest user message only when nothing else can be freed — keeping
  each cut until the step fits. Never leave a tool result empty: fall back to
  `"Result omitted: it was too large for this step's context window."`
- Return `{ messages }` only. Log once per shrink on the folder's existing prefix, content-free:
  `[NORMAL_CHAT_MODEL] context guard step=<n> prompt=<before> required=<before> budget=<maxModelContext> shrunk=<count> after=<after>`.
- In `index.ts`: `buildAttemptPrepareStep` takes the run's `maxOutputTokens` and
  `systemPromptTokens` (from `params.system`, estimated once with `estimateTokenCount`) and composes
  the guard **third**, after the first-step tool choice and the vision step, through the existing
  `composePrepareSteps`. The run's provider already carries `maxModelContext`
  (`NormalChatModelRunProvider`), so no caller outside `normal-chat-model/` changes.

Tests:
- Prompt well under budget → `undefined`, messages untouched (identity).
- One huge tool result and a small window → returns `{ messages }` whose tool result is the digest,
  and the recomputed estimate fits.
- Two huge results → both shrunk, largest first.
- No tool results and still over → last-resort text truncation, messages still valid `ModelMessage[]`.
- Determinence: same input twice → deep-equal.

## Invariants

- English only in anything written into a model request (ruling 79 / I3): no Hungarian, no locale
  lookups, no user-facing strings added.
- Deterministic output; no `Date.now()`, no random, no environment reads.
- Use existing helpers: `estimateTokenCount` (`$lib/utils/tokens`), `stableStringify`,
  `deriveToolResultDigest`, `estimateHistoryMessagesTokens`.
- Runtime config stays behind `config-store.ts`; no `process.env` reads.
- No new top-level `src/lib/server/services/*.ts` boundary; the two new files live inside their
  feature folders.
- Do not weaken or skip any existing test; do not add blanket retries or longer timeouts.

## Verification

Node 22 (`.nvmrc`): `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` in every shell.

Workers run only their focused tests:

```bash
npx vitest run src/lib/server/services/normal-chat-tools/files.test.ts
npx vitest run src/lib/server/services/normal-chat-tools/model-payload-budget.test.ts
npx vitest run src/lib/server/services/normal-chat-model/context-guard.test.ts
```

The orchestrator then runs the repository gate once:

```bash
scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 4610
```

## Merge note (for the human, not the workers)

`feat/ask-me-first` in the main checkout already modifies
`src/lib/server/services/normal-chat-model/index.ts` and
`src/lib/server/services/normal-chat-tools/shared.ts`. This change touches the same two files, at
one call site each, on a base of `dev` (`1f3b64648`). Expect two small conflicts at merge time; the
edits are deliberately additive and one-line so they resolve by keeping both sides.
