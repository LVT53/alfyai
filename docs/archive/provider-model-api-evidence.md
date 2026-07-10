# Provider Model API Evidence

Generated: 2026-06-29

This document records the official public evidence used for the provider compatibility and stream-fixture work. It is intentionally conservative: undocumented stream details are marked for manual or live verification rather than modeled as fixtures.

## Evidence Matrix

### DeepSeek V4

- Sources: [chat completion](https://api-docs.deepseek.com/api/create-chat-completion), [pricing/models](https://api-docs.deepseek.com/quick_start/pricing), [V4 thinking](https://api-docs.deepseek.com/guides/thinking_mode), [legacy reasoning caveat](https://api-docs.deepseek.com/guides/reasoning_model).
- Names: `deepseek-v4-flash`, `deepseek-v4-pro`; legacy `deepseek-chat` and `deepseek-reasoner` are deprecated aliases in the current docs.
- API shape: OpenAI-compatible `https://api.deepseek.com` plus `/chat/completions`; token field is `max_tokens`.
- Reasoning: `thinking.type` supports `enabled` and `disabled`; `reasoning_effort` supports `high` and `max`, with lower values documented as compatibility mappings.
- Stream evidence: `delta.reasoning_content`, `delta.content`, `delta.tool_calls`, optional final usage chunk via `stream_options.include_usage`, and `[DONE]`.
- Policy note: V4 supports thinking plus tools; do not apply older `deepseek-reasoner` no-tool stripping to V4 tool loops.
- Fixture coverage: `deepseek-v4-reasoning-text`, `deepseek-v4-reasoning-tool-calls`.

### Xiaomi MiMo

- Sources: [llms.txt](https://mimo.mi.com/llms.txt), [OpenAI Chat API](https://mimo.mi.com/static/docs/api/chat/openai-api.md), [models](https://mimo.mi.com/static/docs/quick-start/summary/model.md), [deep thinking](https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md), [hyperparameters](https://mimo.mi.com/static/docs/api/guidance/model-hyperparameters.md).
- Names: `mimo-v2.5-pro`, `mimo-v2.5`, `mimo-v2-flash`, legacy `mimo-v2-pro`, `mimo-v2-omni`.
- API shape: OpenAI-compatible `https://api.xiaomimimo.com/v1` plus `/chat/completions`; Token Plan base is `https://token-plan-cn.xiaomimimo.com/v1`.
- Tokens/reasoning: token field is `max_completion_tokens`; `thinking.type` supports `enabled` and `disabled`. Thinking defaults enabled for V2.5 Pro/V2.5/V2 Pro/V2 Omni and disabled for Flash.
- Stream evidence: `delta.content`, `delta.reasoning_content`, `delta.tool_calls`, and `usage` are documented. `[DONE]` and `stream_options.include_usage` were not explicit in the checked page, so live verification is still useful for sentinel and usage topology.
- Policy note: tool loops must preserve prior `reasoning_content`; `tool_choice` is effectively `auto` only.
- Fixture coverage: `xiaomi-mimo-arguments-before-name`, `xiaomi-mimo-final-text`, `xiaomi-mimo-v2-5-reasoning-tool-calls`.

### Kimi K2.x

- Sources: [chat API](https://platform.kimi.ai/docs/api/chat.md), [models](https://platform.kimi.ai/docs/models.md), [model overview](https://platform.kimi.ai/docs/api/models-overview.md), [K2 thinking guide](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model.md).
- Names: `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, `kimi-k2.5`; older preview/thinking names are discontinued.
- API shape: `https://api.moonshot.ai/v1` plus `/chat/completions`.
- Tokens/reasoning: docs prefer `max_completion_tokens`; `max_tokens` is deprecated. K2.7 Code always uses `thinking.type: enabled` and errors on disabled thinking; K2.6 and K2.5 support enabled/disabled thinking.
- Stream evidence: `delta.reasoning_content`, `delta.content`, `delta.tool_calls`, usage chunks, and `[DONE]`.
- Policy note: K2.6/K2.7 do not allow temperature/top-p/n/penalty overrides; preserve reasoning through tool loops.
- Fixture coverage: `kimi-k2-split-arguments`, `kimi-k2-7-code-reasoning-tool-calls`.

### GLM 5.x / Z.ai

- Sources: [chat completion](https://docs.z.ai/api-reference/llm/chat-completion.md), [thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode.md), [streaming](https://docs.z.ai/guides/capabilities/streaming.md), [tool streaming](https://docs.z.ai/guides/capabilities/stream-tool.md), [GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2.md).
- Names: `glm-5.2`, `glm-5.1`, `glm-5`, `glm-5-turbo`; coding docs also mention `glm-5.2[1m]`.
- API shape: OpenAI-compatible `https://api.z.ai/api/paas/v4/` and `/paas/v4/chat/completions`; coding endpoint is `https://api.z.ai/api/coding/paas/v4`.
- Tokens/reasoning: token field is `max_tokens`; `thinking.type` supports `enabled` and `disabled`; GLM-5.2 adds `reasoning_effort` values `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Stream evidence: `delta.content`, `delta.reasoning_content`, `delta.tool_calls`, final `usage`, and `[DONE]`.
- Policy note: `tool_choice` is `auto`; streaming tool calls require `tool_stream: true` where supported.
- Fixture coverage: `glm-5-parameterless-tool`, `glm-5-2-reasoning-tool-calls`.

### Qwen 3.x / Alibaba Model Studio

- Sources: [OpenAI-compatible DashScope](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope), [Model Studio models](https://www.alibabacloud.com/help/en/model-studio/models), [deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking), [Qwen vLLM](https://qwen.readthedocs.io/en/latest/deployment/vllm.html), [Qwen function calling](https://qwen.readthedocs.io/en/latest/framework/function_call.html).
- Names: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-max-preview`, `qwen3.6-plus`, `qwen3.6-flash`, `qwen3.6-35b-a3b`, plus current Qwen aliases such as `qwen-plus`, `qwen-max`, `qwen-flash`, and `qwen-turbo`.
- API shape: regional DashScope Model Studio OpenAI-compatible base ending in `/compatible-mode/v1`, then `/chat/completions`.
- Tokens/reasoning: hosted API uses `max_tokens`; thinking support is documented through Model Studio `extra_body.enable_thinking` on the deep-thinking page and through OSS/self-host `extra_body.chat_template_kwargs.enable_thinking`.
- Stream evidence: OpenAI-compatible page documents `delta.content`, `function_call`, `tool_calls`, `[DONE]`, and include-usage empty `choices` chunks. Because Alibaba-hosted examples also warn that `tools` can be incompatible with `stream=True` for some models/modes, the fixture coverage models content plus include-usage only.
- Policy note: some Alibaba-hosted examples warn that tools cannot be combined with `stream=True` for specific models or modes; request-policy work should gate this per documented model/provider rather than assuming universal streamed tools.
- Fixture coverage: `qwen-3-reasoning-usage`, `qwen-3-dashscope-content-usage`.

### Current-Generation Mistral

- Sources: [models overview](https://docs.mistral.ai/models/overview), [chat API](https://docs.mistral.ai/api), [reasoning](https://docs.mistral.ai/studio-api/conversations/reasoning).
- Names: `mistral-medium-3-5`, `mistral-small-latest`, `mistral-large-latest`, `mistral-large-2512`, `mistral-small-2603`, `ministral-3-*`.
- API shape: `https://api.mistral.ai/v1/chat/completions`; token field is `max_tokens`.
- Reasoning: `reasoning_effort` is documented as `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`; `prompt_mode: "reasoning"` exists for reasoning mode.
- Stream evidence: docs describe streaming content deltas and chunk-list reasoning in some modes, plus tool fields and `parallel_tool_calls`; exact usage/tool delta topology was not specific enough for a no-guess fixture in this slice.
- Policy note: add request-policy support from the documented fields, but require manual/live stream capture before modeling Mistral streamed usage or tool-call chunks.
- Fixture coverage: none yet; marked `manual/live verification needed`.

### NVIDIA Nemotron 3

- Sources: [Ultra hosted infer](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer), [Super hosted infer](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer), [Nano hosted infer](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b-infer).
- Names: `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nemotron-3-nano-30b-a3b`.
- API shape: OpenAI-compatible `https://integrate.api.nvidia.com/v1/chat/completions`; token field is `max_tokens`.
- Reasoning: hosted Super/Ultra expose `reasoning_effort` and `reasoning_budget`; NVIDIA examples also use `extra_body.chat_template_kwargs.enable_thinking`.
- Stream evidence: docs describe data-only SSE and `[DONE]`, but the hosted pages inspected did not fully enumerate text/reasoning/tool delta fields.
- Policy note: support hosted request fields by model tier; keep streamed tool/reasoning fixture coverage behind manual/live verification.
- Fixture coverage: none yet; marked `manual/live verification needed`.

### MiniMax M2.7-M3

- Sources: [models intro](https://platform.minimax.io/docs/guides/models-intro.md), [OpenAI Chat Completions](https://platform.minimax.io/docs/api-reference/text-chat-openai.md), [M3 function call](https://platform.minimax.io/docs/guides/text-m3-function-call.md), [M3 model page](https://www.minimax.io/models/text/m3), [M2.7 model page](https://www.minimax.io/models/text/m27).
- Names: `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`, `MiniMax-M2.1`, `MiniMax-M2`.
- API shape: OpenAI-compatible `https://api.minimax.io/v1/chat/completions`; model pages also show legacy `https://api.minimax.io/v1/text/chatcompletion_v2`.
- Tokens/reasoning: token field is `max_completion_tokens`; `max_tokens` is deprecated. M3 supports `thinking.type: disabled|adaptive`; `reasoning_split: true` separates reasoning in responses.
- Stream evidence: OpenAI-compatible docs document `chat.completion.chunk`, `choices[].delta.content`, final usage when included, and `[DONE]`. Separate streamed reasoning/tool-call delta fields were not specific enough in public docs for fixture modeling.
- Policy note: use `reasoning_split: true` for app-visible reasoning and preserve full assistant responses through M3 tool loops.
- Fixture coverage: `minimax-m3-content-usage`.

### Gemma 4

- Sources: [Gemma 4 overview](https://ai.google.dev/gemma/docs/core), [thinking](https://ai.google.dev/gemma/docs/capabilities/thinking), [function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4), [NVIDIA Gemma 4 hosted infer](https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer).
- Names: `google/gemma-4-E2B-it`, `google/gemma-4-E4B-it`, `google/gemma-4-12B-it`, `google/gemma-4-31B-it`, `google/gemma-4-26B-A4B-it`; NVIDIA hosted name `google/gemma-4-31b-it`.
- API shape: Google docs are local/HF-oriented and do not define a universal OpenAI-compatible base URL. NVIDIA NIM hosts an OpenAI-compatible endpoint with `max_tokens` and `chat_template_kwargs.enable_thinking`.
- Stream evidence: Google docs use local generation, not SSE. NVIDIA documents OpenAI-like SSE and `[DONE]`, but not enough exact delta fields for a fixture.
- Policy note: treat Gemma 4 request handling as provider-host specific; preserve thoughts during function/tool-call turns where the serving stack requires it.
- Fixture coverage: none yet; marked `manual/live verification needed`.

### GPT-OSS

- Sources: [OpenAI gpt-oss repository](https://github.com/openai/gpt-oss), [OpenAI vLLM cookbook](https://developers.openai.com/cookbook/articles/gpt-oss/run-vllm), official repo response API files referenced from the research summaries, [NVIDIA GPT-OSS hosted infer](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-120b-infer).
- Names: `gpt-oss-120b`, `gpt-oss-20b`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, Ollama-style `gpt-oss:120b`, `gpt-oss:20b`.
- API shape: official sample server supports Responses API `/v1/responses` with `max_output_tokens` and `reasoning.effort`; vLLM can expose OpenAI-compatible chat and responses endpoints; NVIDIA NIM exposes OpenAI-compatible chat with `max_tokens` and `reasoning_effort`.
- Stream evidence: Responses API events include `response.output_text.delta`, `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`, output item events, and `response.completed`. NVIDIA chat docs do not fully specify chunk deltas.
- Policy note: support two profiles: Responses-style GPT-OSS and OpenAI-compatible chat gateway. Do not feed Responses event fixtures into the OpenAI-compatible chat normalizer.
- Fixture coverage: none yet; marked `manual/live verification needed`.

### Fireworks And Gateway Aliases

- Sources: [Fireworks chat completions API](https://docs.fireworks.ai/api-reference/post-chatcompletions).
- Source strategy: Fireworks and similar gateways often expose third-party models under gateway-specific IDs while retaining OpenAI-compatible chat semantics. Fireworks documents gateway model IDs such as `accounts/fireworks/models/kimi-k2-instruct-0905`, `max_tokens`, `max_completion_tokens`, `thinking`, `tool_choice`, streaming chunks, and `[DONE]`. The provider facade should detect family behavior from canonical model names plus admin-managed aliases, not from provider display name alone.
- Alias policy: canonical names stay as the outbound `model` value for the configured provider row; aliases are for family detection and admin mapping. Gateway aliases should be stored per provider model so `deepseek-v4-pro`, `accounts/fireworks/models/...`, or another gateway ID can resolve to the same provider family without hardcoding every gateway string.
- Verification policy: when a gateway changes the stream schema, add a gateway fixture only from official gateway docs or a sanctioned live capture.

## Supported Names And Types

| Family | Supported names/types from official evidence | Request profile status | Stream fixture status |
| --- | --- | --- | --- |
| DeepSeek V4 | `deepseek-v4-flash`, `deepseek-v4-pro`; deprecated aliases `deepseek-chat`, `deepseek-reasoner` | OpenAI-compatible chat, `max_tokens`, V4 thinking/tool policy | Covered |
| Xiaomi MiMo | `mimo-v2.5-pro`, `mimo-v2.5`, `mimo-v2-flash`, `mimo-v2-pro`, `mimo-v2-omni` | OpenAI-compatible chat, `max_completion_tokens`, MiMo thinking/tool policy | Covered for documented deltas; sentinel needs live confirmation |
| Kimi K2.x | `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, `kimi-k2.5` | OpenAI-compatible chat, `max_completion_tokens`, K2.7 always-thinking policy | Covered |
| GLM 5.x | `glm-5.2`, `glm-5.2[1m]`, `glm-5.1`, `glm-5`, `glm-5-turbo` | OpenAI-compatible chat, `max_tokens`, GLM thinking/reasoning/tool-stream policy | Covered |
| Qwen 3.x | `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-max-preview`, `qwen3.6-plus`, `qwen3.6-flash`, `qwen3.6-35b-a3b`, `qwen-plus`, `qwen-max`, `qwen-flash`, `qwen-turbo` | DashScope/OpenAI-compatible chat, `max_tokens`, hosted/OSS thinking split | Covered for DashScope content/usage shapes; tool+stream policy needs per-model gating |
| Mistral current gen | `mistral-medium-3-5`, `mistral-small-latest`, `mistral-large-latest`, `mistral-large-2512`, `mistral-small-2603`, `ministral-3-*` | OpenAI-compatible chat, `max_tokens`, `reasoning_effort` | Manual/live stream fixture needed |
| NVIDIA Nemotron 3 | `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nemotron-3-nano-30b-a3b` | NVIDIA NIM OpenAI-compatible chat, `max_tokens`, tiered reasoning fields | Manual/live stream fixture needed |
| MiniMax M2.7-M3 | `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`, `MiniMax-M2.1`, `MiniMax-M2` | OpenAI-compatible chat, `max_completion_tokens`, M3 thinking/reasoning split | Covered for content/usage only |
| Gemma 4 | `google/gemma-4-E2B-it`, `google/gemma-4-E4B-it`, `google/gemma-4-12B-it`, `google/gemma-4-31B-it`, `google/gemma-4-26B-A4B-it`, `google/gemma-4-31b-it` | Provider-host specific; NVIDIA NIM OpenAI-compatible host available | Manual/live stream fixture needed |
| GPT-OSS | `gpt-oss-120b`, `gpt-oss-20b`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `gpt-oss:120b`, `gpt-oss:20b` | Responses API and OpenAI-compatible gateway variants | Manual/live chat fixture needed; Responses events are separate |

## Fixture Notes

- Added no Mistral, NVIDIA, Gemma 4, or GPT-OSS OpenAI-compatible chat fixture in this slice because the public docs reviewed did not specify enough exact chat chunk fields to model without guessing.
- Added MiniMax M3 only as content plus usage because public docs did not specify streamed reasoning or tool-call deltas.
- Added Qwen/DashScope content/usage fixture and intentionally did not model streamed tool calls because per-model restrictions around `tools` plus `stream` need live/provider-specific confirmation.
