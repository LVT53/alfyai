# Interim Thought Steps are durable turn state, not a rendering of raw reasoning

Proposed. AlfyAI will present the reasoning phase of a **Normal Chat Turn** as **Interim Thought Steps** — a short, ordered, localized sequence of what is happening — and will treat those steps as durable **Normal Chat Turn Completion** state rather than as transient UI decoration or a re-rendering of the **Thinking Trace**.

This amends [ADR-0015](0015-normal-chat-turn-completion-boundary.md). Completion already owns persisted messages, response-facing **Context Sources**, **Message Evidence**, skill state, and continuity side effects. Interim Thought Steps join that list: a completed turn's steps are part of what makes the turn durable, and they are written by the completion boundary in `chat-turn`, not by transport, not by the browser, and not by a second pipeline. [ADR-0022](0022-conversation-detail-read-model-boundary.md) continues to apply unchanged — the **Conversation Detail Read Model** projects persisted steps for refresh and hydration, and must not re-derive or regenerate them.

**Interim Thought Step** is already defined in `CONTEXT.md`. This decision fixes three things that definition left open: where steps come from, what makes them true, and what survives the turn.

## Where steps come from

A step is produced in one of three ways, and the source is recorded on the step:

- **Deterministic** — turn facts known without inference and without any model call: the resolved **Depth Profile**, the transition into the reasoning phase, observed reasoning-delta arrival, and the transition into answer output.
- **Event-derived** — from work the system actually performed: a tool call, a context-preparation activity class ([ADR-0042](0042-normal-chat-context-preparation-telemetry.md)), a **Normal Chat Deliberation Pass**. Already structured, already localized.
- **Classified** — from the model's reasoning stream, via a bounded call to the control model that **classifies** a reasoning chunk into a closed activity-class enum and may return one optional entity string. The control model never authors user-facing prose.

### The deterministic spine

The deterministic steps are not a fallback. They are a **spine** that is always present, on every turn, at every depth, with no model call and no external dependency. Event-derived and classified steps are inserted into that spine to raise its resolution.

This matters because the most common turn — `standard` depth, no tools — produces no deliberation passes and no tool events, and its context-preparation activity all occurs before the model is contacted. A design in which the reasoning phase is described *only* by classified steps would render an empty surface for precisely the stretch this decision exists to explain. The spine forecloses that: the reasoning phase always has at least a truthful, live, localized state driven by real delta arrival.

The rail therefore has no failure mode in which it is absent or empty. It varies in **resolution**, not in existence. A classifier that is slow, rate-limited, or unavailable produces a coarser rail, never a broken one, and never a rail that claims something did not happen.

This is also what makes the surface testable without a model: the spine is asserted deterministically, and classified steps are tested as enrichment on top of it.

Only class identifiers and validated entity strings cross the wire. User-facing copy is resolved from the app's own EN/HU dictionary, exactly as sanitized activity classes already work. This is what makes Hungarian parity structural rather than dependent on a small model's Hungarian prose.

Classes that imply an external action — searching, fetching, reading a connected account — may originate **only** from event-derived steps. A classifier may never assert that something happened outside the model.

## What makes a step true

Every step carries a **Thought Step Anchor**: the span of the **Thinking Trace** that produced it. A step that cannot name its anchor is not emitted. An optional entity string is dropped unless it appears verbatim in the anchored span.

The anchor is not only an audit record — it is the user-facing honesty affordance. Selecting a step opens the raw **Thinking Trace** scrolled to, and highlighting, the anchored span. That single interaction is what distinguishes a step rail from theatre, and it is why steps must be durable: an anchor that cannot be revisited later proves nothing.

Steps are append-only. An emitted step may be extended by a continuation verdict, but never reordered, rewritten, or retracted.

## The disclosure contract

- **While the turn runs**, the current step is visible without interaction, in place of the elapsed-time counter. Liveness is driven by real reasoning-delta arrival, never by a timer alone. Classification stops at the first visible answer token and must never delay visible answer text.
- **After completion**, the surface collapses to the retrospective duration. Expanding reveals the ordered step list, with event-derived and classified steps interleaved in one sequence.
- **The raw Thinking Trace** remains available one level below the steps, as a single continuous view reached through a step's anchor.

We considered making each step independently expandable to reveal only its own slice of reasoning. We rejected it: it fragments the trace for the users who read it, and nested disclosure inside a disclosure degrades badly on small screens. The anchored single view preserves both audiences.

Steps are a layer over the **Thinking Trace**, never a replacement for it. Nothing here makes reasoning text less available; it makes it navigable.

## Considered Options

- Render raw **Thinking Trace** only, as today, with an elapsed-time counter.
- Generate free-text step summaries with a cheap model and stream them as prose.
- Derive steps from discourse markers in the reasoning text.
- Treat steps as transient UI state, discarded at completion.
- Classify reasoning chunks into a closed, localized enum, anchored to the trace, and persist the result.

We chose the last. Raw trace with a counter quantifies a wait without explaining it, and the trace is in the model's reasoning language regardless of the user's — for a bilingual product that is not a user-facing surface. Free-text summarization has the highest fidelity ceiling and the highest hallucination surface, and would place user-visible prose in a small model's hands in two languages. Marker extraction is free but derives user-visible content from language-specific pattern matching, which is the failure mode [ADR-0055](0055-tool-usage-guidance-lives-in-the-tool-interface.md) exists to remove from this codebase; markers may decide *when* to sample, never *what a user reads*. Transient steps would make the anchor unverifiable after the fact and would leave conversation history less informative than the live view, which inverts the usual relationship.

## Consequences

- Interim Thought Steps become part of durable **Normal Chat Turn Completion**, persisted with the assistant message and projected by the **Conversation Detail Read Model**. They are traversable in conversation history.
- Steps travel on the existing browser activity stream part. This decision adds **no new AI SDK UI stream part names**; [ADR-0025](0025-ai-sdk-ui-stream-migration-sequencing.md) is unchanged.
- The rail's correctness never depends on a model call. The deterministic spine is the contract; classification raises its resolution. A classifier that is slow, unavailable, or rejected yields a coarser rail and must never fail, delay, or alter a user turn — the same invariant [ADR-0042](0042-normal-chat-context-preparation-telemetry.md) sets for timing diagnostics.
- Because the spine is model-free, the reasoning phase is never described by an empty surface, including at `standard` depth with no tool calls — the most common turn, and the one with no deliberation passes and no in-reasoning events.
- Classifier usage is tracked as ordinary model spend under [ADR-0047](0047-provider-cost-price-windows-and-cache-accounting.md).
- Step truthfulness is a release gate, not an aspiration. Because the **Thinking Trace** is persisted, emitted steps can be re-checked against their anchors offline. The rail does not ship to users until an audit over sampled real turns shows no fabricated action claims and no unanchored steps.
- `CONTEXT.md` gains **Thought Step Anchor** and sharpens **Interim Thought Step** to record durability and provenance.
- This decision does not reopen [ADR-0046](0046-automatic-depth-selection-is-deterministic.md). Depth selection remains deterministic and model-free; classification here describes reasoning that has already happened and never decides turn behaviour.
