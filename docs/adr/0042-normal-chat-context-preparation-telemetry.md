# Normal Chat context-preparation telemetry separates raw stages from visible activity

Accepted. AlfyAI will treat Normal Chat context-preparation telemetry as three separate contracts: **Context Preparation Stage**, **Context Preparation Activity Class**, and **Context Preparation Timing**.

**Context Preparation Stage** is the internal stage-runner vocabulary owned by `src/lib/server/services/normal-chat-context-preparation.ts`. Raw stage ids such as `plan`, `constructed_context`, `automatic_compression`, `forced_web_prefetch`, and `prompt_budget` describe implementation steps in the Normal Chat context-preparation module. They may appear in server timing diagnostics, focused tests, and server-side debugging paths where precise implementation attribution is needed. They must not appear in visible chat copy, localized progress strings, or arbitrary browser-rendered labels.

**Context Preparation Activity Class** is the sanitized public activity vocabulary emitted toward the browser for live progress. Activity classes are stable, content-free discriminators that the chat UI maps to localized English and Hungarian copy. They may describe a broad kind of preparation work, but they must not expose raw stage ids, prompt text, user message text, source text, provider names, source labels, API keys, user ids, or debug labels. Unknown or future classes should fall back to generic localized context-preparation copy instead of rendering caller-provided text.

**Context Preparation Timing** is a content-free duration diagnostic for context preparation. Timing records may include raw stage ids, sanitized activity classes, start/completion timestamps, durations, and final statuses so server diagnostics and focused regression tests can explain slow preparation. These records are observability data, not user-turn control flow and not user-visible chat content.

Diagnostic slow-stage budgets are thresholds over Context Preparation Timing records only. An over-budget stage may be logged or marked for latency analysis, but it must not fail, skip, abort, retry, downgrade, or otherwise change the behavior of a user turn. Context preparation still either completes normally or fails for the same functional reasons it would have failed without timing diagnostics.

This decision preserves the existing stream and read-model boundaries. ADR-0025 keeps browser-facing stream framing on the AI SDK UI stream contract; context-preparation timing should use existing terminal stream metadata or server timing diagnostics rather than inventing new provider or browser stream part names. ADR-0019 keeps waiting, retry, reconnect, stop, and queue semantics in the Normal Chat Client Turn Runtime; that runtime may consume sanitized response activity, but it must not become the owner of raw stage timing semantics. ADR-0015 keeps durable Normal Chat Turn Completion in chat-turn. ADR-0022 keeps refreshable `/api/conversations/[id]` projection in the Conversation Detail Read Model. Terminal timing diagnostics may help operators understand a completed stream, but post-turn user-visible projection must continue to come from durable completion state through `src/lib/server/services/conversation-detail/read-model.ts`, not from raw timing telemetry.

**Considered Options**

- Expose raw context-preparation stage ids directly in visible chat progress.
- Keep only the existing generic `context-preparing` activity and make stage detail server-local.
- Treat slow-stage budgets as timeouts that can skip optional preparation work or abort a turn.
- Separate raw stages, sanitized activity classes, and content-free timing diagnostics.

We chose the three-contract split because the stage runner already has useful implementation depth, but that depth serves different audiences. Raw stage ids are useful for focused tests and latency diagnostics. Sanitized activity classes are useful for localized user progress without leaking internals. Timing records are useful for future performance work, but they should not become a hidden policy engine that changes turn behavior.

**Consequences**

- `src/lib/server/services/normal-chat-context-preparation.ts` remains the natural owner for raw stage vocabulary and the mapping from raw stages to sanitized activity classes.
- Visible chat surfaces, including `MessageBubble.svelte` and chat i18n, consume sanitized activity classes only and render localized copy from app-owned translations.
- Stream timeline and terminal metadata may carry content-free timing diagnostics, but they must not add new AI SDK UI stream part names casually or duplicate stream framing outside the existing stream helpers.
- Focused tests may assert raw stage ids and timing records; UI tests should assert that raw stage ids and arbitrary labels are not rendered.
- Slow-stage budget evaluation must be side-effect-free with respect to turn behavior. It can classify and report latency, but it cannot decide whether preparation work runs or whether a user turn succeeds.
