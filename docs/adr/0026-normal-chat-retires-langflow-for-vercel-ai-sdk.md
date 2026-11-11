# AlfyAI retires Langflow for Vercel AI SDK

Accepted. AlfyAI will replace Langflow with Vercel AI SDK and should not deploy another remote version that still depends on Langflow. Temporary compatibility code may exist during local development, but the migration goal is full Langflow removal: runtime configuration, model-run transport, custom nodes, mocks, tool HTTP workarounds, admin flow/component fields, documentation, and tests should be removed after equivalent AI SDK coverage and provider validation exist.

**Considered Options**

- Keep deepening the existing Langflow runtime.
- Add Vercel AI SDK as an optional parallel runtime while Langflow remains the production default.
- Fully retire Langflow and make Vercel AI SDK the deployed default.

We chose full retirement because the recurring failures are concentrated around opaque, hard-to-test Langflow execution and tool paths. Vercel AI SDK still requires app-owned durability, tool idempotency, capability checks, and smoke tests, but it moves the main model/tool harness into source-controlled TypeScript where local fake-provider and third-party-provider testing can exercise the same runtime before deployment.

## Amendment (2026-11-11) — ModelRun owns bounded structural completion

Normal Chat opts into the [completion engine](../../src/lib/server/services/normal-chat-model/completion.ts) through `completionPolicy`; generic callers without that policy retain their existing model-run behavior and limits. Both transports consume the same prepared-run owner.

- Working text remains provisional until a clean terminal tool-free step settles it as answer; explicit closing text is answer output. One [shared projection](../../src/lib/shared/normal-chat-output.ts) preserves block identity and separates activity from answer across live, saved, Copy, export and history views; legacy messages retain explicit compatibility behavior.
- Eligible unfinished work receives at most one tools-disabled closing invocation per segment, with bounded output/deadline, no SDK generation retry or closing failover. It continues retained prepared context and real results, never re-prepares the turn or reruns tools. Stop, ask pause, expired deadline, content filtering and uncertain execution do not authorize closing.
- Automatic recovery after execution cannot regain tools. Admitted human input after an ask authorizes a new segment under ordinary tool/access policies; recorded executions are not replayed. This is not semantic exactly-once across independently generated operations.
- Every effective destination gets its own model/tool/privacy/vision projection. Incompatible or oversized complete continuation fails explicitly rather than leaking data, refetching evidence or silently substituting a digest.

We reject a second preparation pipeline, prose-based answer detection and mandatory extra generation for every response. Retained structural state costs complexity and delays ordinary answer placement until settlement, but avoids promoting working commentary or repeating completed work. Structural `answered` is not a semantic or formatting guarantee.

Evidence: [SDK interface tests](../../tests/integration/normal-chat-completion-sdk.test.ts), [completion integration tests](../../tests/integration/normal-chat-completion.test.ts), [prepared-turn tests](../../src/lib/server/services/chat-turn/prepared-normal-chat-turn.test.ts), [contract](../plans/turn-completion/contract/spec.md).
