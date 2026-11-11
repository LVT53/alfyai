# Stream Admission happens before heavy Turn Preparation

Accepted. Normal Chat streaming may return the browser stream after **Stream Admission** and run heavier **Turn Preparation** inside the already-open stream.

**Stream Admission** is the cheap server-side decision that a parsed, authenticated Normal Chat stream request may open a browser stream for this user and conversation. Admission must complete before the `Response` is returned, and it must still reject HTTP-level failures that should not become streamed assistant state: auth failures, parse or request-validation failures, unsupported Atlas stream starts, stream capacity rejection, and conversation ownership or nonexistence failures.

**Turn Preparation** is the heavier chat-turn work that makes an admitted stream request ready for a Normal Chat Model Run: attachment readiness, linked source persistence, pending skill availability, skill session start, Reasoning Depth metadata resolution, skill prompt context resolution, and related prompt appendix inputs. For the stream transport, this work may happen after the SSE/AI SDK UI stream prelude is open so the browser can leave "Preparing response" sooner and receive real progress while the server continues preparation.

If Turn Preparation fails after Stream Admission, the route cannot convert that failure into a JSON HTTP response because the stream has already been admitted. The failure is sent through the existing AI SDK UI stream terminal error path: `data-stream-error`, `finish` with `finishReason: "error"`, and `[DONE]`. This preserves ADR-0025's AI SDK UI stream contract and avoids adding route-local stream part names.

This decision does not move durable Normal Chat Turn Completion into the route or browser stream transport. ADR-0015 still applies: durable completion, response-facing Context Sources, message evidence, skill side effects, Honcho/task/memory continuity, and persisted assistant-message metadata belong in the chat-turn completion boundary. It also does not move browser-side waiting, retry, reconnect, stop, or queue semantics into the transport; ADR-0060 governs turn-state ownership above the browser transport, and the Normal Chat Client Turn Runtime consumes decoded stream errors.

**Considered Options**

- Keep full Turn Preparation before returning the stream.
- Return the stream after auth and parse only, then discover capacity or conversation ownership failures inside the stream.
- Add a new post-admission request-error protocol separate from the AI SDK UI stream contract.
- Split Stream Admission from Turn Preparation and keep only cheap, security- and capacity-critical failures at HTTP level.

We chose the split because the slow preparation work is exactly what creates the user-visible pre-stream wait, while auth, request shape, unsupported Atlas streaming, capacity, and conversation ownership are still admission concerns. Returning a stream for an unauthorized, missing, unsupported, or over-capacity request would blur stable HTTP failures into runtime chat errors. Adding a second terminal-error protocol would duplicate the current AI SDK UI stream contract and make the browser runtime harder to reason about.

**Consequences**

- The stream route remains a transport adapter. It may parse, authenticate, reject unsupported Atlas stream starts, check capacity, and admit the conversation before returning a stream, but it should not wait on attachment readiness, linked-source persistence, skill prompt context, skill session start, or Reasoning Depth work in the HTTP response-start path.
- Stream orchestration owns the post-admission preparation lifecycle for Normal Chat streaming. It should emit the stream prelude before awaiting heavy Turn Preparation and then emit useful activity or terminal error frames through the shared stream framing boundary.
- Send and retry entrypoints may keep eager full preflight behavior unless a shared helper signature requires a mechanical adaptation; this ADR records the streaming contract, not a requirement to change every transport at once.
- Post-admission preparation errors are browser-visible stream failures, not route-local JSON responses. They must use existing AI SDK UI stream terminal semantics so reconnect, waiting, stop, queue, and error handling remain owned by the existing browser runtime and transport boundaries.
- **Stream Admission** and **Turn Preparation** are implementation contract terms. They do not require `CONTEXT.md` glossary entries unless they become user-facing product language later.

## Amendment (2026-11-11) — start and observation are distinct intents

Authenticated start-new admission allocates scoped requested-turn/segment identity before model work through [completion lifetime](../../src/lib/server/services/chat-turn/completion-lifetime.ts). Existing accepted identity cannot be admitted as fresh generation; observe-existing uses the [reconnect owner](../../src/lib/server/services/chat-turn/stream-reconnect.ts).

- Observation returns retained replay/live subscription, durable terminal truth, pending state or explicit unavailability/interruption. Completion between status and reconnect cannot start another run, including during drain.
- A lost process owner cannot reconstruct execution safely: abandoned accepted work is interrupted/uncertain, never regenerated. This is scoped turn accounting and observation, not a general durable job engine.
- Preserve cheap HTTP admission failures and the post-admission preparation/error split above. Regenerate retains its existing capacity exception while still respecting drain refusal; observation does not become new-turn admission.

We reject inferring generation intent from missing replay or a stale status check. Distinct intent avoids duplicate tools/model work at the cost of unavailable results when execution cannot be recovered. Browser lifecycle/Stop policy remains [ADR-0060](0060-client-turn-runtime-owns-turn-state.md).

Evidence: [reconnect tests](../../src/lib/server/services/chat-turn/stream-reconnect.test.ts), [ledger tests](../../src/lib/server/services/chat-turn/turn-ledger.test.ts), [lifetime tests](../../src/lib/server/services/chat-turn/completion-lifetime-durable.test.ts).
