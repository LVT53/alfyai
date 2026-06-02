# AlfyAI retires Langflow for Vercel AI SDK

Accepted. AlfyAI will replace Langflow with Vercel AI SDK and should not deploy another remote version that still depends on Langflow. Temporary compatibility code may exist during local development, but the migration goal is full Langflow removal: runtime configuration, model-run transport, custom nodes, mocks, tool HTTP workarounds, admin flow/component fields, documentation, and tests should be removed after equivalent AI SDK coverage and provider validation exist.

**Considered Options**

- Keep deepening the existing Langflow runtime.
- Add Vercel AI SDK as an optional parallel runtime while Langflow remains the production default.
- Fully retire Langflow and make Vercel AI SDK the deployed default.

We chose full retirement because the recurring failures are concentrated around opaque, hard-to-test Langflow execution and tool paths. Vercel AI SDK still requires app-owned durability, tool idempotency, capability checks, and smoke tests, but it moves the main model/tool harness into source-controlled TypeScript where local fake-provider and third-party-provider testing can exercise the same runtime before deployment.
