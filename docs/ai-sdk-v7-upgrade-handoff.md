# AI SDK v7 Upgrade — Findings & Planning Handoff

**Date:** 2026-09-16
**Status:** Not started. This is a scoped-but-unstarted piece of work. The repo remains on the Vercel **AI SDK v6** (newest v6). A v7 attempt was made, evaluated, and **reverted** to a clean v6 tree.
**Purpose:** Capture everything learned so a future session can plan and execute the upgrade in detail.

> Terminology: "Vercel" here means the **Vercel AI SDK** (`ai` + `@ai-sdk/*`), not the Vercel hosting platform. This app is self-hosted on `@sveltejs/adapter-node` (systemd), not deployed on Vercel.

---

## 1. Current vs latest

| Package | Installed (v6 line) | Latest (`latest` tag) | In `package.json`? |
|---|---|---|---|
| `ai` | 6.0.283 | **7.0.102** | direct dep (`^6.0.193`) |
| `@ai-sdk/openai-compatible` | 2.0.75 | 3.0.49 | direct dep (`^2.0.48`) |
| `@ai-sdk/provider-utils` | 4.0.51 | 5.0.41 | transitive (imported directly) |
| `@ai-sdk/provider` | 2.x | 4.0.15 | transitive (imported directly) |
| `@ai-sdk/gateway` | 3.0.194 | 4.0.82 | transitive |

`ai` dist-tags: `ai-v6 = 6.0.283` (current install is the newest v6), `latest = 7.0.102`, `beta = 7.0.0-beta.*`.

**No urgency:** v6 is current and maintained (the `ai-v6` tag tracks it). The low-severity `ai`/`@ai-sdk` npm-audit items were already fixed *within* v6 — there is no security pressure forcing v7.

---

## 2. How this codebase uses the SDK

Import counts (`from "ai"`): 24 files. Directly-imported `@ai-sdk/*`: `provider` (`JSONSchema7`), `provider-utils` (`asSchema`), `openai-compatible` (`createOpenAICompatible`).

Exports in use: `tool` (pervasive — ~19 model-facing tools), `jsonSchema` (~88), `embed` (~29), `generateText` (~25), `streamText` (~8), `createOpenAICompatible` (~4), `stepCountIs` (~2), `createUIMessageStream` (~2).

**The app already uses the modern v6 surface** — `stopWhen` (not the old `maxSteps`), `maxOutputTokens`, `providerOptions`, `toolChoice`, `abortSignal`, `onError`, `maxRetries`. It does **not** use the deprecated `experimental_*` options that v7 renames — with one exception, `experimental_repairToolCall` (see below), whose alias v7 still accepts.

Key files (the blast radius of the upgrade):

- `src/lib/server/services/normal-chat-tools/index.ts` — all tool definitions; the custom `asExecutableTool()` wrapper and `RequiredExecuteTool<TInput, TOutput>` type (lines ~176–184).
- `src/lib/server/services/normal-chat-tools/shared.ts` — `executeToolWithEnvelope`, uses `ToolExecutionOptions` (line ~299), `asSchema` from provider-utils (line ~394).
- `src/lib/server/services/normal-chat-tools/tool-health-hints.ts` — local `ToolLike = { description?: string }` (line 12).
- `src/lib/server/services/normal-chat-model/index.ts` — the hand-rolled `streamText`/`generateText` calls; `experimental_repairToolCall` at lines ~1287 and ~1595.
- `src/lib/server/services/normal-chat-model/openai-compatible-provider.ts` — `createOpenAICompatible`.
- `src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts` — `ToolPack` type (line ~210) and `NormalChatModelTools = Partial<ReturnType<typeof createNormalChatTools>["tools"]>` (line ~194).
- `src/lib/server/services/chat-turn/{plain,streaming}-normal-chat-model-run.ts` — where the tool set flows into the model call.

---

## 3. The upgrade has two very different halves

### Part A — Landing v7 at all (compatibility)

Even keeping current behavior, v7 reshaped the core `Tool` types:
- `Tool<INPUT, OUTPUT>` → `Tool<INPUT, OUTPUT, CONTEXT>` (3rd generic, defaults but changes inference).
- `ToolExecutionOptions` → **generic** `ToolExecutionOptions<CONTEXT>` (no default; every bare use is now an error).
- `Tool.description` widened to `string | ((options) => string)`.

A real attempt produced **40 type errors in 2 files**, from **3 root causes** (plus two mechanical ones):

1. **`asExecutableTool` / `RequiredExecuteTool` generics** (~18 sites in `index.ts`) — the 2-generic wrapper no longer accepts what v7's `tool()` returns. Likely fix: infer the whole tool type, e.g. `function asExecutableTool<T extends Tool<any, any, any>>(t: T): T & { execute: NonNullable<T["execute"]> }`.
2. **Test `.execute(input, { toolCallId, messages })` calls** (20 sites in `index.test.ts`) — v7's `ToolExecutionOptions`/`ToolCallOptions` shape needs more fields; a shared test-options factory is the clean fix.
3. **`.split()` on `description`** (2 sites) — description is now `string | fn`; narrow with `typeof d === "string"` before string ops.

Mechanical, also required:
- `ToolExecutionOptions` → `ToolExecutionOptions<never>` (~19 sites in `index.ts` + `shared.ts`). The app has no tool context, so `never` is correct.
- `NormalChatModelTools = Partial<...>` yields `Tool | undefined` values that don't satisfy v7's `ToolSet` (`Record<string, Tool>`) at the `streamText`/`generateText` call sites — needs the tool-set type reworked so present values aren't `| undefined` (the conditional tools like `research_web` make keys optional).
- `experimental_repairToolCall` → `repairToolCall` (optional; the `experimental_` alias still type-checks in v7).

**Estimated effort:** ~1 day. **Value on its own: zero functional gain.** This half only makes v6 behavior compile on v7, so it is not worth doing as an end in itself — it's the foundation for Part B.

### Part B — Actually using v7 (the real upgrade)

The v7 breaking changes are otherwise almost all `experimental_*` → stable renames (most keep deprecated aliases): `experimental_activeTools`→`activeTools`, `experimental_telemetry`→`telemetry`, `experimental_onToolCall{Start,Finish}`→`onToolExecution{Start,End}`, `experimental_context`→`contextSchema`+`toolsContext`/`runtimeContext`, `needsApproval`(on tool)→`toolApproval`(on call/agent), `ToolCallOptions`→`ToolExecutionOptions`. The app uses none of these today, so they're not migration work — they're **new capabilities to adopt**:

| v7 capability | Fit for AlfyAI | Effort | Notes |
|---|---|---|---|
| **`toolApproval` — human-in-the-loop tool gating** | **High** | Medium–large (full-stack) | Best safety-to-effort ratio. Gate side-effectful connection tools (`email` send, `repos` write, `tasks`, `calendar` write, `contacts`) behind explicit user confirmation. Emits `tool-approval-request`; needs a chat approval UI + streaming-protocol handling. Start here. |
| **`WorkflowAgent` (`@ai-sdk/workflow`) — durable, resumable agents** | **High for Atlas** | Large | Atlas already persists/resumes long multi-step jobs via job rows by hand; v7 durable agents survive process restarts and pause for approval natively. Could replace bespoke worker orchestration (`atlas`, `atlas-v2`, `atlas-v3`). New dependency. |
| **Scoped `toolsContext` + shared `runtimeContext`** | Medium | Medium | Replaces manual threading of `CreateNormalChatToolsContext` (userId, modelId, `enabledConnectionCapabilities`) into every tool. Cleaner, less error-prone. |
| **`ToolLoopAgent`** | Optional | Large, higher-risk | Your hand-rolled loop in `normal-chat-model` could move onto v7's agent (built-in `stopWhen`/`activeTools`/`toolOrder`, plus `allowSystemInMessages` prompt-injection guard). Big core rewrite — only if the maintenance win justifies it. |
| **`toolOrder`, stable `telemetry`, `onToolExecutionStart/End`** | Low-hanging | Small | Tool ordering can affect selection quality; stable telemetry hooks pair well with the existing Sentry wiring. |
| **Native sandbox (`SandboxSession` in tool `execute`)** | Unknown | Investigate | v7 has a sandbox concept; the app runs its own Docker sandbox (`sandbox/config.ts`, `run_python`/`produce_file`). Worth checking whether it integrates or overlaps. |

---

## 4. Migration mechanics (verified)

- **Coordinated bump required:** `ai@7` + `@ai-sdk/openai-compatible@3` together (pulls `@ai-sdk/provider-utils@5`, `@ai-sdk/provider@4`, `@ai-sdk/gateway@4`). Mixing v7 `ai` with v2 `openai-compatible` will not work.
- **Node:** `ai@7` engines = `node >=22` — compatible with the project's `22.x` pin.
- **zod:** `ai@7` and `@ai-sdk/openai-compatible@3` peer-depend on `zod ^3.25.76 || ^4.1.8`; the project has `zod ^4.1.12` — compatible.
- **`createUIMessageStream`** (2 sites) did not error in the attempt — but exercise it in a real streamed turn to be sure.
- Command: `npm install ai@7 @ai-sdk/openai-compatible@3` (do **not** downgrade anything else).

---

## 5. Recommended sequencing

1. **Phase 0 — Compat land + verify.** Apply Part A on a branch, get `npm run check` + `npm test` + `npm run build` green, then **verify on staging (node 22, live model): a real tool-calling chat turn AND a full Atlas run.** This is the non-negotiable gate — mocked unit tests do not prove the streamed tool loop works.
2. **Phase 1 — `toolApproval`** for the destructive connection tools (highest value, self-contained).
3. **Phase 2 — Evaluate `WorkflowAgent`** for Atlas durability.
4. **Phase 3 (optional) — `toolsContext`/`runtimeContext`** cleanup and/or `ToolLoopAgent`.

## 6. Why this wasn't done in-session

- It touches the **highest-blast-radius code in the app** (the chat-and-tools loop + Atlas).
- The dev environment here **cannot verify it**: system node is 26 (project pins 22; no nvm/fnm), there's no staging, and no live model — so "type-checks + mocked tests pass" would be a false all-clear.
- The value (Part B) is genuine engineering (backend + a bit of frontend for approvals), not a dependency bump.

## 7. References

- Official migration guide: `https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0`
- `ToolLoopAgent`: `https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent`
- Tool approvals: `https://ai-sdk.dev/docs/agents/tool-approvals`
- `WorkflowAgent`: `https://ai-sdk.dev/docs/reference/ai-sdk-workflow/workflow-agent`
