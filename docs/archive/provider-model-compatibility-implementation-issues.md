# Provider Model Compatibility Implementation Issues

Generated: 2026-06-29

## Goal

Deepen the unified Normal Chat provider facade with documented, provider-specific request and stream behavior for the current model families the app must support, add admin-editable model aliases for provider-specific naming differences, extend verification through the downstream AI SDK UI stream contract, and stop before implementing any remaining candidate options until there is a separate discussion.

## Constraints

- Use official provider documentation for every provider/model shape before implementation. Do not infer request fields, enum values, thinking controls, or model IDs from memory.
- Keep model execution inside `src/lib/server/services/normal-chat-model/`.
- Keep provider model persistence inside `src/lib/server/services/provider-models.ts` and `provider_models`.
- Keep admin UI changes inside the existing settings Administration provider/model surface.
- Preserve AI SDK UI stream frame names unless the parser, runtime, and tests are updated together.
- Run `npm run check` and Fallow before calling the patch finished.

## Issue 1: Build The Official Provider API Evidence Matrix

**Triage label:** architecture/provider-compatibility

### Acceptance Criteria

- A local evidence document lists official documentation sources for each requested provider/model family:
  - current gen Mistral
  - GLM 5.2
  - Kimi K2.6
  - Kimi K2.7 Code
  - Qwen 3.6-3.7
  - DeepSeek V4
  - Nvidia Nemotron 3
  - MiniMax M2.7-M3
  - Gemma 4
  - GPT-OSS
  - previously discussed DeepSeek, Xiaomi MiMo, Kimi K2.x, GLM 5.x, Qwen 3.x
- For each family, the matrix records:
  - official provider or project URL
  - canonical model names found in docs
  - OpenAI-compatible base URL/path when documented
  - thinking/reasoning request fields and allowed values
  - whether `max_tokens` or `max_completion_tokens` is documented
  - streaming shape for text, reasoning, usage, tool calls, and `[DONE]`
  - unsupported or conditional tool/reasoning combinations
- Any provider whose official API details are not public/crawlable is marked as `needs manual confirmation`, with the official page that proves the gap.

### Technical Notes

- Store the matrix in `docs/provider-model-api-evidence.md`.
- Include links only to official docs/sites, except where an official page links to generated OpenAPI/reference content.
- This issue blocks request-body policy changes for any provider family whose shape is still unknown.

## Issue 2: Add A Versioned Provider Family Registry

**Triage label:** architecture/provider-compatibility

### Acceptance Criteria

- Provider family detection recognizes all documented model families from Issue 1 when the provider name/base URL is generic, including gateway deployments such as Fireworks AI.
- Detection uses canonical model names and editable aliases rather than brittle one-off regexes.
- The public `OpenAICompatibleProviderAdapterProfile` still resolves to a single profile for request transforms, provider options, stream normalization hints, and error classification.
- Tests prove official names and likely gateway aliases resolve to the expected family without breaking existing DeepSeek, MiMo, Kimi, GLM, Qwen, and generic behavior.

### Technical Notes

- Start in `src/lib/server/services/normal-chat-model/provider-compatibility.ts`.
- Consider a documented model-family registry module if the profile file becomes too dense.
- Keep aliases data-driven enough that admin-provided model aliases can flow into the same matching path.

### Dependencies

- Depends on Issue 1.

## Issue 3: Implement Provider-Specific Request Policies From Official Shapes

**Triage label:** architecture/provider-compatibility

### Acceptance Criteria

- Each supported provider family has explicit tests for request transform behavior documented in Issue 1.
- Thinking/reasoning fields are added, removed, or disabled only where the official docs require it.
- Tool-choice suppression is provider-specific and covered by tests for tool-enabled and no-tool requests.
- Token limit field handling uses the official shape for each provider/model family.
- The plain and streaming Normal Chat Model Run paths consume the same provider profile behavior.

### Technical Notes

- Keep request policy in `provider-compatibility.ts` or a directly owned submodule.
- AI SDK integration still flows through `createOpenAICompatible`, `providerOptions`, `transformRequestBody`, and the existing model-run facade.
- Use Context7 AI SDK docs for AI SDK-specific semantics and official provider docs for provider-specific semantics.

### Dependencies

- Depends on Issues 1 and 2.

## Issue 4: Add Admin-Editable Model Aliases End To End

**Triage label:** admin/provider-models

### Acceptance Criteria

- Admins can edit aliases for each provider model in the Settings -> Administration -> System provider/model surface.
- The UI displays one model per row and lets the admin add/remove aliases for the selected model.
- Aliases persist durably with provider models and are returned by the provider model admin APIs.
- Runtime family detection uses the provider model's canonical name and aliases, so official providers and gateway providers such as Fireworks AI can resolve the same family even when model strings differ.
- Alias validation trims whitespace, deduplicates case-insensitively, rejects empty aliases, and rejects aliases that collide with another model name or alias under the same provider.
- Tests cover persistence parsing, create/update APIs, runtime detection, and the Svelte admin model form behavior.

### Technical Notes

- Likely schema change: add `aliases_json` to `provider_models`.
- Update `src/lib/server/db/schema.ts`, a new `drizzle/*.sql` migration, `scripts/prepare-db.ts`, `src/lib/server/services/provider-models.ts`, `src/lib/client/api/admin.ts`, and `ModelForm.svelte`.
- Use the existing provider model form and model list rather than adding a separate admin page.

### Dependencies

- Can start after Issue 2 defines the runtime alias contract.

## Issue 5: Extend Provider Fixtures Through The AI SDK UI Stream Contract

**Triage label:** test/provider-streaming

### Acceptance Criteria

- Provider stream fixtures for supported families replay through:
  - raw provider stream normalization
  - AI SDK `streamText().fullStream`
  - Neutral Normal Chat Model Run events
  - downstream AI SDK UI stream contract frames used by the browser
- Fixture coverage includes text deltas, reasoning deltas, tool-call input/call/result/error paths where supported, usage frames, finish frames, raw/unknown frames where relevant, and abort/error handling.
- Tests prove no provider fixture introduces new browser frame shapes accidentally.

### Technical Notes

- Start from `tests/fixtures/ai/openai-compatible-stream-fixtures.ts`.
- Existing contract ownership is in `src/lib/services/ai-sdk-ui-stream-contract.ts` and `src/lib/server/services/chat-turn/stream.ts`.
- Do not add new UI stream part names unless the browser parser and tests are intentionally updated.

### Dependencies

- Depends on Issues 1 through 3.

## Issue 6: Publish Supported Model Names And Types

**Triage label:** docs/provider-compatibility

### Acceptance Criteria

- A concise local document lists every model name/type now supported by the provider compatibility registry.
- The list distinguishes canonical names, aliases, provider family, request policy, thinking/reasoning support, tool support notes, and source documentation.
- The final user report includes a concise version of the same list.

### Technical Notes

- Store the detailed list in `docs/provider-model-support-matrix.md`.
- Keep this generated from or visibly aligned with the runtime registry where practical.

### Dependencies

- Depends on Issues 1 through 5.

## Issue 7: Verification, Gates, And Push

**Triage label:** verification

### Acceptance Criteria

- Focused provider compatibility, provider model, admin model form, stream fixture, and UI contract tests pass.
- `npm run check` passes with 0 errors and 0 warnings.
- Fallow passes without new findings.
- `npm run lint`, `npm test`, and `npm run build` are run or any inability to run is explained with exact failure cause.
- Changes are committed and pushed to `main`.

### Dependencies

- Depends on Issues 1 through 6.

## Explicit Non-Issue: Remaining Candidate Options

Do not implement remaining candidate options in this pass. The user requested a separate discussion before any implementation there.

## Completion Notes

### 2026-06-29 Stream Fixture And Evidence Slice

- Added `docs/provider-model-api-evidence.md` with official source links, provider-policy notes, uncertainty markers, and supported names/types.
- Extended the OpenAI-compatible stream fixture catalog with documented current DeepSeek V4, Xiaomi MiMo V2.5, Kimi K2.7 Code, GLM 5.2, Qwen/DashScope, and MiniMax M3 stream shapes.
- Did not add Mistral, NVIDIA Nemotron, Gemma 4, or GPT-OSS OpenAI-compatible chat fixtures where the official docs reviewed did not specify exact stream delta fields.
- Added `docs/provider-model-support-matrix.md` as the concise supported names/types matrix.
- Kept the Qwen/DashScope fixture to documented content/usage streaming only; streamed tool calls remain per-model/live verification work.
