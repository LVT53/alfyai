# Design: native message history, prompt diet, tool result hygiene

Implements proposals P1, P2 and P4 of `docs/harness-review-2026-09-05.md`.

## Goals and success criteria

| Goal | Measure | Baseline (30d prod) | Target |
|---|---|---|---|
| Model sees real conversation turns, including its own prior tool use | manual check of outbound `messages` in a multi-turn tool conversation | single flattened user message | system + alternating turns + tool parts |
| Prefix cache reuse across turns and steps | vLLM `prefix_cache_hits_total / prefix_cache_queries_total` | 52.6% | ≥ 75% on multi-turn conversations |
| Smaller fixed prompt | tokens of system prompt + tool schemas on a bare turn | ~7k | ≤ 4.5k |
| Fewer, cleaner tool payload tokens | chars of research_web result to the model | up to ~35k | ≤ 14k, no diagnostics/instruction strings |
| No behaviour regressions | full vitest suite, prompt tests, a scripted 3-turn live run | green | green |

Non-goals: compaction policy (P3), deliberation changes (P5), memory retrieval (P7). Those stay as they are; this design must not make them worse.

## P1 — Native message history

### Shape of the outbound call (after)

```
system:    <static base> … <dynamic runtime guidance last>
user:      <turn 1 user text>
assistant: <turn 1 text>  [+ tool-call parts if the turn used tools]
tool:      [tool-result parts for those calls]            (only when present)
…
user:      <constructed packet for THIS turn> + "## Current User Message" <text>
```

Prior turns are real `ModelMessage`s built from the stored rows. The current turn keeps the constructed packet (attachments, task state, evidence, session summary, baseline memory profile) exactly as today, but **without the `Session Context` section**, which becomes the message array. If a compression snapshot exists, only messages after the snapshot are emitted as turns (same rule as `selectRawSessionMessagesAfterCompressionSnapshot`); the snapshot and the session summary stay in the packet.

### Data source

`messages` rows already hold `content`, `role`, and `tool_calls` (a `ThinkingSegment[]` whose `tool_call` entries carry `callId?`, `name`, `input`, `status`, `outputSummary`, `candidates`, `metadata`). Text segments in `tool_calls` are reasoning, not answer text, and are never replayed.

New optional field on `ToolCallEntry`/`ThinkingSegment.tool_call`: `resultDigest?: string` (≤ 1,500 chars). Filled at recording time by each tool's recorder entry with the most useful compact excerpt of what the model actually saw (research_web/fetch_url: first lines of `answerBriefMarkdown`; memory_context: `content` head; connection tools: `message` + first 5 items as one-line bullets; map_route: `message`). Older rows without it fall back to `outputSummary` + candidate titles/urls.

### Builder

`src/lib/server/services/chat-turn/conversation-history.ts`

```ts
export type HistoryTurn = { user: PromptContextMessage; assistant?: PromptContextMessage };
export function buildHistoryModelMessages(params: {
  turns: HistoryTurn[];           // oldest → newest, already after the compression snapshot
  maxTokens: number;              // session history budget (unchanged derivation)
  toolMessages: "native" | "flatten";
  estimateTokens: (text: string) => number;
}): { messages: ModelMessage[]; includedTurnCount: number; omittedTurnCount: number; estimatedTokens: number }
```

Rules:
- Walk newest → oldest, include whole turns while the running estimate fits `maxTokens`; never split a turn; always include at least the newest completed turn (matches today's `minRecentTurnCount`).
- User message: stored text; fork-copy provenance prefix kept as today; attachment names appended as `[attachment: name]` lines when present.
- Assistant message content: `[{type:"text", text}]` plus, for each `tool_call` segment with a resolvable id, `{type:"tool-call", toolCallId, toolName, input}`; then one `tool` message with `{type:"tool-result", toolCallId, toolName, output:{type:"json", value: digest}}` where `digest = { ok, summary: outputSummary, detail: resultDigest?, sources: candidates.slice(0,6).map({title,url}) }`.
- `toolCallId`: stored `callId`, else deterministic `hist_<messageId>_<index>`.
- Empty assistant text with tool calls is allowed; an assistant row with neither text nor calls is skipped.
- `toolMessages: "flatten"`: tool activity is rendered into the assistant text as `[used research_web: <summary>]` lines. Used when the provider is marked incompatible with tool history or the turn runs with `disableTools`.
- Stopped/failed turns (`wasStopped`) are included as-is; the text is what the user saw.

### Wiring

- `buildConstructedContext` (both shallow and deep tiers) returns `historyMessages` alongside `inputValue`; it stops pushing the `Session Context` section when native history is on. `contextStatus.recentTurnCount` continues to reflect included turns.
- `PreparedOutboundChatContext` gains `historyMessages: ModelMessage[]`.
- `streaming-normal-chat-model-run.ts` and `plain-normal-chat-model-run.ts` send `messages: [...prepared.historyMessages, currentUserMessage]`.
- `estimateTurnPromptTokens` / `context-usage.ts` add the history estimate to the "estimated" prompt figure.
- Deliberation passes keep receiving the flat `inputValue` plus a flattened text rendering of the history (they are JSON control calls; unchanged budget).
- Non-streaming fallback receives the same `historyMessages` (it re-runs preparation, which rebuilds them identically).

### Provider compatibility

`provider-compatibility.ts` gains `historyToolMessages: "native" | "flatten"`, default `native`. Set `flatten` for providers known to reject `tool` role messages without a `tools` parameter; none are known today (OpenAI-compatible/vLLM, DeepSeek, Fireworks, Kimi all accept them), so the switch exists for incident response. When `tools` is undefined for the turn (disableTools) the builder is called with `flatten`.

### Prefix-cache friendliness

The system prompt is reordered (P2) so static text precedes dynamic text, and history messages are emitted from stored rows without re-rendering, so the token prefix `system + turn1 + … + turnN` is byte-identical between consecutive turns of a conversation and between tool-loop steps within a turn.

### Flag and rollout

`NATIVE_HISTORY_ENABLED` (env + admin config, default `true`). `false` restores the flattened `Session Context` section. Default on in production; the flag is the rollback.

## P2 — Prompt diet

### Base prompt (`prompts.ts`)

- Delete the tool table and the `### Web Research`, `### Calculations`, `### Files And Artifacts` sections. Replace with one short `## Tools` policy paragraph (≈600 chars): prefer research_web for current facts, fetch_url for a given link, memory_context proactively for preferences, produce_file for downloadable artifacts, say plainly when a tool is unavailable or fails, never invent a tool. Tool mechanics live only in tool descriptions.
- Merge `## Answer Shape` with `RICH_BLOCK_SYNTAX_GUIDE` into one `## Formatting` section in the base prompt; the runtime guidance no longer carries the guide.
- Keep the persona-in-documents rule in one place (`## Content Preservation`); remove it from `Retrieved Context Discipline` and from the `memory_context` description.

### System prompt assembly (`buildOutboundSystemPrompt`)

Order, static first: model header → base prompt (with formatting section) → user profile → `## Retrieved Context Discipline` (only when the packet contains memory, evidence or document sections; the caller passes `hasRetrievedContext`) → `## Runtime Guidance`: JSON formatting rules (only when tools are present), reasoning-depth contract, connections framing guard (only with connections), response-language guard, date context. Personality `## Response Style` is capped at 1,500 chars and placed directly after the base prompt's working-style rules with a one-line cross-reference.

Rationale for order: the date and language lines change most often; putting them last keeps the longer static prefix cacheable.

### Tool descriptions

- Remove the citation/"never paste raw output" sentences that duplicate the base prompt's reliability rules; keep parameter contracts and examples.
- Remove the persona rule sentence from `memory_context`.
Expected reduction: ~16.4k → ~12k chars EN; HU adjusted in parallel.

### Tests

`prompts.test.ts`, `normal-chat-context.test.ts` and `normal-chat-tools/index.test.ts` updated; a new test asserts the static prefix of two consecutive system prompts is identical when only date/language/depth differ.

## P4 — Tool result hygiene

- `executeToolWithEnvelope` runs `compactModelPayload()` on every `modelPayload`: drop `undefined`/`null`, empty arrays, empty objects and empty strings (except `success`, `name`, `action`, `message`).
- research_web/fetch_url payload: remove `diagnostics`, `answerBrief.instructions` and the trailing `instructions` string; cap `answerBriefMarkdown` at 12,000 chars (config `WEB_RESEARCH_BRIEF_MAX_CHARS`, default 12000); keep `sources` (≤ 8) and `evidence` (≤ 12). Diagnostics move to the recorder entry `metadata` for the admin view.
- memory_context: one payload shape per mode (`persona` → `{content, audit}`, `history` → `{conversations, selectedConversation, omitted}`, `project` → `{project, siblings, selectedSibling, omitted}`) plus `evidenceCandidates`; the per-call caution string is removed (the rule is in the base prompt).
- Connection tools: keep `message` + array; the envelope's compaction removes empty arrays and null citations.
- Errors: unchanged (`{success:false, error}` ≤ 500 chars).

## Implementation plan

Three worktrees in parallel, then integration:

| Package | Files | Owner |
|---|---|---|
| P1 history | `chat-turn/conversation-history.ts` (+test), `context-selection.ts`, `normal-chat-context.ts` (type + plumbing), `streaming/plain-normal-chat-model-run.ts`, `context-usage.ts`, `provider-compatibility.ts`, `messages-types.ts` (`resultDigest`), recorder entries in `normal-chat-tools/index.ts` (digest only), env/config flag | lead |
| P2 diet | `prompts.ts`, `buildOutboundSystemPrompt` in `normal-chat-context.ts` (that function only), `TOOL_I18N` descriptions in `normal-chat-tools/index.ts` (description strings only), i18n tests | agent A |
| P4 hygiene | `web-grounding.ts` payload builder, `normal-chat-tools/shared.ts` envelope, `memory-context.ts` payload, tests | agent B |

Conflict points: `normal-chat-context.ts` (P1 touches types/plumbing, P2 touches one function) and `normal-chat-tools/index.ts` (P1 touches recorder entries, P2 touches description strings). Both are line-disjoint.

## Verification

1. Unit: full suite green; new tests for the builder (budgeting, tool parts, flatten mode, legacy rows without digest), compaction helper, prompt ordering.
2. Live, from a local instance on the Mac pointed at the production vLLM through an SSH tunnel, with a seeded test user: run a 3-turn scripted conversation (question needing research_web → follow-up referencing it → unrelated question), capture the outbound `messages` array via a debug env flag (`NORMAL_CHAT_DEBUG_OUTBOUND=1` logs roles, part types and token estimates, never content in prod), and read vLLM prefix-cache counters before/after.
3. Deploy; watch the next production turns' `message_analytics` prompt tokens and the prefix-cache hit rate.

## Risks

- A provider rejecting `tool` messages → `historyToolMessages: "flatten"` per provider, flag off as last resort.
- Old rows without `resultDigest` give thinner tool results; acceptable, improves as new turns accrue.
- Prompt edits change model behaviour subtly; prompt tests cover structure, the live run covers behaviour, the flag does not cover P2 (rollback is a redeploy of the previous release).

## Review outcomes (two independent reviews, scores 3–7 before amendments)

Decisions taken in response, superseding the sections above where they differ:

1. **Prefix stability is a property of the whole system message and tool set, not of section order.** The system message and the rendered tool schemas precede every history token, so anything in them that varies per turn invalidates the conversation's prefix. Therefore: no per-turn conditional sections (`Retrieved Context Discipline` and the JSON formatting rules stay always-on but are shortened); the section order stays as it is today (Response Style remains last, preserving its precedence); `produce_file`/`read_generated_file` are registered on every turn instead of being gated by message pattern, with the description carrying the "only when the user asks for a downloadable file" rule; the degraded-hint and coverage-label text only change on operational events. A test asserts that two consecutive turns of one conversation produce a byte-identical system prompt and identical history prefix.
2. **History data plumbing**: `PromptContextMessage` gains `thinkingSegments`, selected in `loadSessionPromptContext` (`context-selection.ts:834-866`).
3. **Interrupted or failed tool calls** (`status !== "done"`) are emitted as a tool-call part paired with a synthesized `{ ok: false, summary: "interrupted before completion" }` tool result, so the request never carries a dangling call.
4. **Tool call ids**: stored `callId`, else `hist_<messageId>_<k>` with `k` the index within the filtered `tool_call` subsequence of that message.
5. **Flatten mode** goes through the same per-turn walk as native mode; the legacy `serializeBudgetedRoleTurns` (which ignores its budget) is no longer used for history.
6. **Mid-turn fallback** (`stream-fallback.ts`): the completed tool calls of the interrupted attempt are passed as structured assistant tool-call parts plus tool results appended after the current user message, instead of a text digest in the system prompt, so the continuation can use them without re-executing.
7. **Prompt diet keeps** the five cross-tool sentences the review identified (no calculator/date tool; do not pretend a tool exists; report result and method; runtime supplies conversationId/idempotency; image_search before documentSource images) in the base prompt's `## Tools` policy paragraph. `normalizeSystemPromptReference` and its legacy-migration constants are updated with the prompt so stored legacy overrides still resolve to the canonical prompt.
8. **Caps**: the 12,000-char brief cap applies to `research_web` only; `fetch_url` keeps `resolveFetchContentCharCap` (20k floor, model-scaled).
9. **memory_context** keeps the common envelope keys (`success`, `name`, `sourceType`, `mode`) and existing key names; it drops the per-call caution string and empty keys, and only includes the keys of the requested mode.
10. **Tests to update deliberately**: `prompts.test.ts` legacy-migration fixture, `web-grounding.test.ts` frozen payload keys and the 30,000 default, `normal-chat-tools/index.test.ts` memory_context shape, `normal-chat-tool-gating.test.ts` produce_file gating.

## Results (staging verification, 2026-09-05 evening)

Scripted three-turn conversation against staging (`langflow-chat-dev`, same vLLM as production), before and after the three packages:

| Measure | Before (release e5cf15fc) | P1+P4 (13bee467) | P1+P2+P4 (4dfa7797) |
|---|---|---|---|
| System prompt tokens (estimate) | n/a (old prompt) | 4,758 | 3,778 |
| Turn 1 (web research, 3 steps): prompt tokens summed | n/a | 26,452 | 23,371 |
| Turn 1 first visible token | 17.1 s (tried nonexistent `search`, failed) | 15.2 s | 9.3 s |
| Turn 2 (follow-up): outbound shape | 1 flattened user message | user, assistant+2 tool calls, tool results, user | same |
| Turn 2: tools called | image_search (irrelevant) | none — answered from prior results | none |
| Turn 2: prompt tokens | n/a | 10,825 | 9,760 |
| Turn 3 (arithmetic) | called phantom `evaluate_expression`, failed | no tool, correct | no tool, correct |
| Tool-call `resultDigest` persisted | no | yes (1,500 chars each) | yes |

Prefix-cache reuse is coarse on the current model server. Two byte-identical 4,057-token requests sent directly to vLLM produced zero `prefix_cache_hits`; a 13,057-token request repeated three times produced 9,600 and then 11,200 hits (six and seven aligned blocks). The server runs Qwen3.8-Flash-Next (hybrid attention/Mamba) with "Mamba cache mode align" and a 1,600-token attention block, so hits are only granted for whole aligned blocks of a long stable prefix. A turn's shared prefix here (system prompt plus tool schemas, roughly 7k tokens) yields at most four blocks, which matches the 6,400 hits measured across the three-turn run. The outbound message prefix is byte-stable turn to turn (verified from the shape logs), so the app side of the cache goal is complete; realising it needs a server-side change (a vLLM build with working hybrid prefix caching, or a dense model for the control path) and is tracked as an ops follow-up.

Follow-up worth measuring once the server caches: the current turn's user message is the constructed packet while its history entry is the raw text, so the reusable prefix ends one message earlier than it could; rendering the raw text first and the packet after it (or sending the packet as a separate trailing message) would extend the cacheable prefix through the previous turn's user message.
