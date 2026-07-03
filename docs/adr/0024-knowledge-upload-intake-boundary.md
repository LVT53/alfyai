# Deepen Knowledge Upload Intake

Knowledge Upload Intake is the server-side boundary that completes a Knowledge Library upload after an authenticated adapter has received bytes or validated upload intent metadata. The boundary lives in `src/lib/server/services/knowledge/upload-intake.ts` and is consumed by multipart, raw, chunked, and upload-intent routes under `src/routes/api/knowledge/upload/`.

The service owns shared upload limit resolution, optional conversation validation, uploaded source persistence through the Knowledge store, normalized-document extraction, prompt-readiness resolution, and upload trace output. Routes may authenticate, parse HTTP metadata, receive multipart form data, stream raw bytes into a temporary file, persist and assemble chunks, and translate service errors into HTTP responses. They should not import Knowledge store persistence helpers or conversation lookup for durable upload completion.

Uploaded and normalized document bodies are not synced into Honcho persona memory by default. The normalized artifact remains important as the AI-facing prompt artifact: source-plus-normalized documents should stay bundled into one source row in the Knowledge Base Documents page, while the row keeps an on-demand panel (labeled "What the AI sees" in the UI as of ADR 0043; the architecture concept is still the normalized/AI-facing artifact) that fetches the normalized prompt artifact text for user inspection.

`knowledge/store/attachments.ts` remains the low-level attachment persistence module. It owns source artifact writes, filename-conflict auto-rename, optional `attached_to_conversation` links, and prompt attachment lookup helpers. Knowledge Upload Intake composes those helpers; it does not replace the artifact store or create a second upload persistence path.

Conversationless Knowledge Library uploads remain valid. When a route supplies `conversationId`, Knowledge Upload Intake validates ownership before artifact persistence or prompt-readiness linking, so chat-scoped uploads cannot silently attach to another user's conversation. Raw and chunked adapters may call the validation helper before writing large temporary bodies to fail invalid conversation ids early while still keeping conversation lookup inside the intake boundary.

**Implementation Status, 2026-06-18:** implemented. `src/routes/api/knowledge/upload/+server.ts`, `raw/+server.ts`, `chunk/+server.ts`, and `intent/+server.ts` now delegate limit and completion behavior to `upload-intake.ts`. The old partial `upload-completion.ts` helper was removed. Boundary tests cover multipart completion, raw and chunked early conversation rejection, shared limit calculation, prompt-readiness response assembly, skipped default Honcho document sync, and stale route import prevention.

**Considered Options**

- Keep multipart upload completion route-local and leave raw/chunked uploads on a partial completion helper.
- Move upload completion into `knowledge/store/attachments.ts`.
- Add a focused Knowledge Upload Intake boundary used by all upload adapters.

We chose the focused intake boundary because upload completion spans multiple concerns: HTTP-independent limit policy, conversation ownership, artifact persistence, extraction, prompt readiness, and traces. The store should stay responsible for artifact writes, and routes should stay transport adapters. A single intake boundary keeps the three upload paths behaviorally aligned without making the store or routes own too much.
