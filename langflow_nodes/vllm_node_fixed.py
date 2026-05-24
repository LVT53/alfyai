from __future__ import annotations

import json
from typing import Any, ClassVar

import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, SystemMessage
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_openai import ChatOpenAI
from pydantic.v1 import SecretStr

from lfx.base.models.model import LCModelComponent
from lfx.field_typing import LanguageModel
from lfx.field_typing.range_spec import RangeSpec
from lfx.inputs.inputs import BoolInput, DictInput, IntInput, MultilineInput, SecretStrInput, SliderInput, StrInput
from lfx.log.logger import logger

import requests


def _clean_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}

    cleaned: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            continue
        normalized_key = key.strip()
        if not normalized_key:
            continue
        cleaned[normalized_key] = _clean_mapping(item) if isinstance(item, dict) else item
    return cleaned


def _normalize_openai_compatible_base_url(base_url: str) -> str:
    base = str(base_url or "").strip().rstrip("/")
    if not base:
        return base

    lower = base.lower()
    for suffix in ("/v1/chat/completions", "/chat/completions"):
        if lower.endswith(suffix):
            base = base[: -len(suffix)]
            lower = base.lower()
            break

    if lower.endswith("/models"):
        base = base[: -len("/models")]
        lower = base.lower()

    if lower.endswith("/v1"):
        return base

    return f"{base}/v1"


def _allows_chat_template_kwargs(base_url: str) -> bool:
    normalized = str(base_url or "").strip().lower()
    return (
        "localhost" in normalized
        or "127.0.0.1" in normalized
        or "0.0.0.0" in normalized
        or "://10." in normalized
        or "://192.168." in normalized
        or "://172.16." in normalized
        or "://172.17." in normalized
        or "://172.18." in normalized
        or "://172.19." in normalized
        or "://172.20." in normalized
        or "://172.21." in normalized
        or "://172.22." in normalized
        or "://172.23." in normalized
        or "://172.24." in normalized
        or "://172.25." in normalized
        or "://172.26." in normalized
        or "://172.27." in normalized
        or "://172.28." in normalized
        or "://172.29." in normalized
        or "://172.30." in normalized
        or "://172.31." in normalized
    )


def _is_fireworks_base_url(base_url: str) -> bool:
    return "api.fireworks.ai" in str(base_url or "").strip().lower()


def _uses_gpt_oss_reasoning_field(model_name: str) -> bool:
    return "gpt-oss" in str(model_name or "").strip().lower().replace("_", "-")


class NemotronReasoningChatOpenAI(ChatOpenAI):
    """ChatOpenAI subclass for OpenAI-compatible models with optional reasoning capture.

    Why this exists:
    - vLLM and some OpenAI-compatible providers can emit separate reasoning chunks
      (`delta.reasoning` or `delta.reasoning_content`)
    - Langflow's current Agent stream pipeline only forwards `AIMessageChunk.content`
    - to avoid patching Langflow core, this model injects streamed reasoning into the
      content stream using tagged text:

        <thinking>...</thinking>

    This preserves the reasoning signal through the current Langflow Agent pipeline.

    Important:
    - This does not magically create a separate reasoning field in Langflow's stream.
    - It preserves reasoning in a way that can later be parsed back out cleanly.
    """

    reasoning_open_tag: ClassVar[str] = "<thinking>"
    reasoning_close_tag: ClassVar[str] = "</thinking>"

    system_prompt: str = ""
    reasoning_effort: str = ""
    thinking_type: str = ""
    enable_thinking: bool = True
    use_chat_template_kwargs: bool = True
    reasoning_payload_field: str = "reasoning_content"
    _last_reasoning_content: str = ""

    @staticmethod
    def _strip_blank_reasoning_fields(payload: dict[str, Any]) -> dict[str, Any]:
        if not str(payload.get("reasoning_effort") or "").strip():
            payload.pop("reasoning_effort", None)
        return payload

    @staticmethod
    def _coerce_openai_compatible_content(content: Any) -> str:
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                    continue
                if isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str):
                        parts.append(text)
                        continue
                try:
                    parts.append(json.dumps(part, ensure_ascii=False, separators=(",", ":")))
                except TypeError:
                    parts.append(str(part))
            return "".join(parts)
        return str(content)

    def _normalize_payload_message_content(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Keep assistant/tool history valid for vLLM's OpenAI-compatible validator."""
        messages = payload.get("messages")
        if not isinstance(messages, list):
            return payload

        string_content_roles = {"assistant", "tool", "function", "system", "developer"}
        for msg in messages:
            if not isinstance(msg, dict):
                continue

            role = msg.get("role")
            has_tool_calls = bool(msg.get("tool_calls"))
            content = msg.get("content")
            if has_tool_calls and content in (None, ""):
                msg["content"] = ""
                continue
            if role in string_content_roles and "content" in msg:
                msg["content"] = self._coerce_openai_compatible_content(content)
        return payload

    def _merge_reasoning_body(self, payload: dict[str, Any]) -> dict[str, Any]:
        payload = self._strip_blank_reasoning_fields(payload)
        reasoning_effort = str(self.reasoning_effort or "").strip()
        if reasoning_effort:
            payload["reasoning_effort"] = reasoning_effort

        if not self.enable_thinking or not self.use_chat_template_kwargs:
            return payload

        extra_body = _clean_mapping(payload.get("extra_body") or {})
        chat_template_kwargs = dict(extra_body.get("chat_template_kwargs") or {})
        chat_template_kwargs["enable_thinking"] = True
        extra_body["chat_template_kwargs"] = chat_template_kwargs
        payload["extra_body"] = extra_body
        return payload

    def _recover_reasoning_in_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Recover reasoning from <thinking> tags for APIs that require it.

        The classic Langchain AgentExecutor can reconstruct messages from strings,
        losing additional_kwargs. This last-mile patch scans the final payload
        messages, extracts reasoning from embedded <thinking> tags, and injects the
        provider-appropriate reasoning field so the API accepts the request.
        """
        open_tag = self.reasoning_open_tag
        close_tag = self.reasoning_close_tag
        messages = payload.get("messages")
        if not isinstance(messages, list):
            logger.debug("[REASONING_RECOVER] No messages in payload")
            return payload

        logger.debug("[REASONING_RECOVER] Scanning %d messages", len(messages))
        for idx, msg in enumerate(messages):
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            has_tool_calls = bool(msg.get("tool_calls"))
            content = msg.get("content", "") or ""
            has_reasoning = self._normalize_existing_payload_reasoning(msg)
            logger.debug(
                "[REASONING_RECOVER] msg[%d] role=%s content_len=%d has_reasoning=%s",
                idx,
                role,
                len(content) if isinstance(content, str) else 0,
                has_reasoning,
            )
            if role != "assistant":
                continue
            if not isinstance(content, str):
                continue

            # Case 1: content contains <thinking>...</thinking> tags
            if open_tag in content and close_tag in content:
                start = content.find(open_tag)
                end = content.find(close_tag) + len(close_tag)
                inner_start = start + len(open_tag)
                inner_end = content.find(close_tag)
                reasoning_text = content[inner_start:inner_end]
                clean_content = content[:start] + content[end:]
                msg["content"] = clean_content if clean_content or not has_tool_calls else ""
                if reasoning_text:
                    self._set_payload_reasoning(msg, reasoning_text)
                # Cache for fallback on later turns
                if reasoning_text:
                    self._last_reasoning_content = reasoning_text
                logger.debug(
                    "[REASONING_RECOVER] msg[%d] extracted reasoning len=%d",
                    idx,
                    len(reasoning_text),
                )
                continue

            if has_tool_calls and content in (None, ""):
                msg["content"] = ""

            # Case 2: message already has reasoning_content in additional_kwargs
            # (langchain_openai's _convert_message_to_dict does NOT preserve it,
            # but if a downstream patch does, we don't need to do anything)
            if has_reasoning:
                logger.debug("[REASONING_RECOVER] msg[%d] already has reasoning_content", idx)
                continue

            # Case 3: assistant message with tool_calls but no reasoning_content —
            # DeepSeek requires reasoning_content for any previous assistant turn
            # that had reasoning. Inject the cached last reasoning as a fallback.
            if has_tool_calls and self._last_reasoning_content:
                self._set_payload_reasoning(msg, self._last_reasoning_content)
                logger.debug(
                    "[REASONING_RECOVER] msg[%d] injected cached reasoning len=%d",
                    idx,
                    len(self._last_reasoning_content),
                )
                continue

        return payload

    def _set_payload_reasoning(self, msg: dict[str, Any], reasoning_text: str) -> None:
        msg[self.reasoning_payload_field] = reasoning_text
        if self.reasoning_payload_field == "reasoning":
            msg.pop("reasoning_content", None)

    def _normalize_existing_payload_reasoning(self, msg: dict[str, Any]) -> bool:
        existing = msg.get(self.reasoning_payload_field)
        if isinstance(existing, str) and existing:
            if self.reasoning_payload_field == "reasoning":
                msg.pop("reasoning_content", None)
            return True

        if self.reasoning_payload_field == "reasoning":
            fallback = msg.get("reasoning_content")
            if isinstance(fallback, str) and fallback:
                msg["reasoning"] = fallback
                msg.pop("reasoning_content", None)
                return True

        return "reasoning_content" in msg

    def _reasoning_to_tagged_content(self, reasoning: str) -> str:
        return f"{self.reasoning_open_tag}{reasoning}{self.reasoning_close_tag}"

    def _extract_reasoning_from_stream_chunk(self, raw_chunk: dict[str, Any]) -> str | None:
        choices = raw_chunk.get("choices") or []
        if not choices:
            return None

        first_choice = choices[0] or {}
        delta = first_choice.get("delta") or {}
        reasoning = delta.get("reasoning") or delta.get("reasoning_content")

        if isinstance(reasoning, str) and reasoning:
            return reasoning
        return None

    def _extract_reasoning_from_final_response(self, response: Any, index: int) -> str | None:
        choices = None
        if isinstance(response, dict):
            choices = response.get("choices")
        elif hasattr(response, "choices"):
            choices = response.choices

        if not choices or index >= len(choices):
            return None

        choice = choices[index]
        if isinstance(choice, dict):
            message = choice.get("message") or {}
        else:
            message = getattr(choice, "message", None) or {}

        if isinstance(message, dict):
            reasoning = message.get("reasoning") or message.get("reasoning_content")
        else:
            reasoning = getattr(message, "reasoning", None) or getattr(message, "reasoning_content", None)

        if isinstance(reasoning, str) and reasoning:
            return reasoning
        return None

    @staticmethod
    def _has_stream_choices(raw_chunk: dict[str, Any]) -> bool:
        choices = raw_chunk.get("choices")
        if not isinstance(choices, list) or len(choices) == 0:
            return False

        first_choice = choices[0]
        return isinstance(first_choice, dict)

    def _merge_runtime_system_prompt(self, messages: Any) -> list[Any]:
        """Ensure the AlfyAI runtime system prompt reaches the model.

        Langflow Agent flows already pass a SystemMessage into the model. The
        previous implementation skipped `self.system_prompt` in that case, which
        meant app-side style, search, and source-authority guidance could be
        configured but ineffective. Merge the runtime prompt into the first
        existing SystemMessage instead.
        """
        runtime_prompt = str(self.system_prompt or "").strip()
        message_list = list(messages)
        if not runtime_prompt:
            return message_list

        for index, message in enumerate(message_list):
            if not isinstance(message, SystemMessage):
                continue

            existing = str(getattr(message, "content", "") or "").strip()
            if runtime_prompt in existing:
                return message_list

            combined = f"{runtime_prompt}\n\n{existing}" if existing else runtime_prompt
            try:
                message_list[index] = message.copy(update={"content": combined})
            except Exception:
                message_list[index] = SystemMessage(content=combined)
            return message_list

        return [SystemMessage(content=runtime_prompt)] + message_list

    def _get_request_payload(self, messages, stop=None, **kwargs: Any) -> dict[str, Any]:
        """Override to recover reasoning_content from <thinking> tags before sending to the API."""
        payload = super()._get_request_payload(messages, stop=stop, **kwargs)
        payload = self._strip_blank_reasoning_fields(payload)
        payload = self._normalize_payload_message_content(payload)
        return self._recover_reasoning_in_payload(payload)

    async def _astream(self, messages: Any, *args: Any, **kwargs: Any):
        """Stream model output while preserving reasoning in content tags."""
        messages = self._merge_runtime_system_prompt(messages)
        kwargs["stream"] = True
        payload = self._get_request_payload(messages, *args, **kwargs)
        payload = self._merge_reasoning_body(payload)

        logger.debug("Executing Nemotron reasoning stream request")

        response = await self.async_client.create(**payload)
        default_chunk_class = AIMessageChunk

        async for raw_chunk in response:
            if not isinstance(raw_chunk, dict):
                raw_chunk = raw_chunk.model_dump()

            reasoning = self._extract_reasoning_from_stream_chunk(raw_chunk)
            if reasoning:
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content=self._reasoning_to_tagged_content(reasoning)),
                    generation_info={},
                )

            if not self._has_stream_choices(raw_chunk):
                logger.debug("[REASONING_STREAM] Skipping provider stream chunk without choices")
                continue

            try:
                generation_chunk = self._convert_chunk_to_generation_chunk(
                    raw_chunk,
                    default_chunk_class,
                    {},
                )
            except (IndexError, KeyError, TypeError) as exc:
                logger.warning(
                    "[REASONING_STREAM] Skipping malformed provider stream chunk: %s",
                    exc,
                )
                continue
            if generation_chunk is None:
                continue

            default_chunk_class = generation_chunk.message.__class__
            yield generation_chunk

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:  # noqa: ARG002
        """Send non-streaming requests with the same reasoning body merge as streaming."""
        messages = self._merge_runtime_system_prompt(messages)
        payload = self._get_request_payload(messages, stop=stop, **kwargs)
        payload = self._merge_reasoning_body(payload)
        response = self.client.create(**payload)
        return self._create_chat_result(response)

    def _create_chat_result(self, response: Any, generation_info: dict[str, Any] | None = None) -> ChatResult:
        """Preserve non-stream reasoning by prepending tagged reasoning to content."""
        result = super()._create_chat_result(response, generation_info=generation_info)

        for index, generation in enumerate(result.generations):
            reasoning = self._extract_reasoning_from_final_response(response, index)
            if not reasoning:
                continue

            message = generation.message
            current_content = getattr(message, "content", "") or ""
            tagged_reasoning = self._reasoning_to_tagged_content(reasoning)

            if self._content_has_tagged_reasoning(current_content, tagged_reasoning):
                continue

            additional_kwargs = dict(getattr(message, "additional_kwargs", {}) or {})
            additional_kwargs["reasoning_content"] = reasoning

            generation.message = AIMessage(
                content=self._prepend_reasoning_to_content(current_content, tagged_reasoning),
                additional_kwargs=additional_kwargs,
                response_metadata=dict(getattr(message, "response_metadata", {}) or {}),
                tool_calls=list(getattr(message, "tool_calls", []) or []),
                invalid_tool_calls=list(getattr(message, "invalid_tool_calls", []) or []),
                usage_metadata=getattr(message, "usage_metadata", None),
            )

        return result

    @staticmethod
    def _content_has_tagged_reasoning(content: Any, tagged_reasoning: str) -> bool:
        if isinstance(content, str):
            return tagged_reasoning in content
        if isinstance(content, list):
            for part in content:
                if isinstance(part, str) and tagged_reasoning in part:
                    return True
                if isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str) and tagged_reasoning in text:
                        return True
            return False
        return False

    @staticmethod
    def _prepend_reasoning_to_content(content: Any, tagged_reasoning: str) -> Any:
        if isinstance(content, list):
            return [{"type": "text", "text": tagged_reasoning}, *content]
        return f"{tagged_reasoning}{content or ''}"

    @classmethod
    def _extract_reasoning_from_content(cls, content: Any) -> tuple[Any, str | None]:
        """Extract reasoning from <thinking> tags and return (clean_content, reasoning)."""
        if not content or not isinstance(content, str):
            return content, None
        open_tag = cls.reasoning_open_tag
        close_tag = cls.reasoning_close_tag
        if open_tag in content and close_tag in content:
            start = content.find(open_tag)
            end = content.find(close_tag) + len(close_tag)
            inner_start = start + len(open_tag)
            inner_end = content.find(close_tag)
            reasoning_text = content[inner_start:inner_end]
            clean_content = content[:start] + content[end:]
            return clean_content, reasoning_text
        return content, None

    @classmethod
    def _convert_message_to_dict(cls, message):
        """Override to preserve reasoning_content in API payload for thinking-mode models."""
        from langchain_core.messages import AIMessage, AIMessageChunk
        message_dict = super()._convert_message_to_dict(message)
        if isinstance(message, (AIMessage, AIMessageChunk)):
            reasoning = message.additional_kwargs.get("reasoning_content")
            content = message_dict.get("content", "")
            if not reasoning and isinstance(content, str):
                clean_content, reasoning = cls._extract_reasoning_from_content(content)
                if reasoning:
                    message_dict["content"] = clean_content
                    message_dict["reasoning_content"] = reasoning
            elif reasoning:
                if isinstance(content, str):
                    clean_content, _ = cls._extract_reasoning_from_content(content)
                    message_dict["content"] = clean_content
                message_dict["reasoning_content"] = reasoning
        return message_dict


class NemotronReasoningVllmComponent(LCModelComponent):
    display_name = "OpenAI Compatible Reasoning"
    description = "OpenAI-compatible chat model for local and third-party providers that preserves reasoning in tagged content."
    icon = "vLLM"
    name = "NemotronReasoningVllmModel"

    inputs = [
        *LCModelComponent.get_base_inputs(),
        IntInput(
            name="max_tokens",
            display_name="Max Tokens",
            advanced=True,
            info="The maximum number of tokens to generate. Set to 0 for unlimited tokens.",
            range_spec=RangeSpec(min=0, max=128000),
        ),
        DictInput(
            name="model_kwargs",
            display_name="Model Kwargs",
            advanced=True,
            info="Additional top-level OpenAI-compatible keyword arguments.",
        ),
        DictInput(
            name="extra_body",
            display_name="Extra Body",
            advanced=True,
            info="Optional provider-specific extra_body fields.",
        ),
        BoolInput(
            name="json_mode",
            display_name="JSON Mode",
            advanced=True,
            info="If True, it will output JSON regardless of passing a schema.",
        ),
        StrInput(
            name="model_name",
            display_name="Model Name",
            advanced=True,
            info="The served model name. Populated automatically from app tweaks.",
            value="nemotron-super",
        ),
        StrInput(
            name="api_base",
            display_name="API Base",
            advanced=True,
            info="The OpenAI-compatible API base URL. Populated automatically from app tweaks.",
            value="http://localhost:8000/v1",
        ),
        MultilineInput(
            name="system_prompt",
            display_name="System Prompt",
            advanced=True,
            info="System prompt to set model behavior. Populated automatically from app config.",
            value="You are a helpful AI assistant.",
        ),
        SecretStrInput(
            name="api_key",
            display_name="API Key",
            info="The API key to use for the OpenAI-compatible model.",
            advanced=True,
            value="",
            required=False,
        ),
        BoolInput(
            name="enable_thinking",
            display_name="Enable Thinking",
            advanced=True,
            info="When true, local vLLM-style endpoints receive chat_template_kwargs.enable_thinking. Public providers use their own thinking/reasoning parameters while reasoning chunks are still preserved in <thinking> tags.",
            value=True,
        ),
        StrInput(
            name="reasoning_effort",
            display_name="Reasoning Effort",
            advanced=True,
            info="Optional provider reasoning_effort value. Leave empty to omit.",
            value="",
            required=False,
        ),
        StrInput(
            name="thinking_type",
            display_name="Thinking Type",
            advanced=True,
            info="Optional provider thinking.type value, for example enabled or disabled. Leave empty to omit.",
            value="",
            required=False,
        ),
        BoolInput(
            name="validate_model_on_build",
            display_name="Validate Model On Build",
            advanced=True,
            info="Call /models before each build. Usually leave off because AlfyAI validates providers in admin settings.",
            value=False,
        ),
        SliderInput(
            name="temperature",
            display_name="Temperature",
            value=0.1,
            range_spec=RangeSpec(min=0, max=1, step=0.01),
            show=True,
        ),
        SliderInput(
            name="top_p",
            display_name="Top P",
            value=1.0,
            range_spec=RangeSpec(min=0, max=1, step=0.01),
            advanced=True,
            info="Nucleus sampling: only tokens whose cumulative probability reaches top_p are considered. "
                 "1.0 disables filtering (default).",
        ),
        IntInput(
            name="top_k",
            display_name="Top K",
            value=-1,
            advanced=True,
            info="Limits sampling to the top-k most likely tokens at each step. "
                 "Set to -1 to disable (vLLM default).",
        ),
        IntInput(
            name="seed",
            display_name="Seed",
            info="Controls reproducibility. Set to -1 to disable.",
            advanced=True,
            value=-1,
            required=False,
        ),
        IntInput(
            name="max_retries",
            display_name="Max Retries",
            info="Max retries when generating. Set to -1 to disable.",
            advanced=True,
            value=-1,
            required=False,
        ),
        IntInput(
            name="timeout",
            display_name="Timeout",
            info="Timeout for requests to vLLM completion API. Set to -1 to disable.",
            advanced=True,
            value=300,
            required=False,
        ),
    ]

    @staticmethod
    def _build_openai_timeout(timeout_seconds: Any, allow_long_stream_reads: bool) -> Any:
        if timeout_seconds is None or timeout_seconds == -1:
            return None

        try:
            seconds = float(timeout_seconds)
        except (TypeError, ValueError):
            return timeout_seconds

        if seconds <= 0:
            return None
        if not allow_long_stream_reads:
            return seconds

        connect_timeout = min(10.0, seconds)
        return httpx.Timeout(
            timeout=seconds,
            connect=connect_timeout,
            read=None,
            write=seconds,
            pool=connect_timeout,
        )

    def _validate_model_exists(self, base_url: str, model_name: str, api_key: str | None = None) -> bool:
        """Validate that the model exists on the OpenAI-compatible server."""
        try:
            headers = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            
            response = requests.get(f"{base_url.rstrip('/')}/models", headers=headers, timeout=10)
            response.raise_for_status()
            
            data = response.json()
            available_models = [m.get("id") for m in data.get("data", [])]
            
            logger.info(f"Available models on {base_url}: {available_models}")
            logger.info(f"Looking for model: {model_name}")
            
            if model_name not in available_models:
                logger.error(f"Model '{model_name}' not found. Available: {available_models}")
                return False
            
            return True
        except Exception as e:
            logger.error(f"Failed to validate model: {e}")
            return False

    def build_model(self) -> LanguageModel:  # type: ignore[type-var]
        # Debug: Log what values we received
        normalized_api_base = _normalize_openai_compatible_base_url(self.api_base or "http://localhost:8000/v1")
        logger.info(f"=== OPENAI COMPATIBLE MODEL NODE DEBUG ===")
        logger.info(f"model_name field value: {self.model_name}")
        logger.info(f"api_base field value: {self.api_base}")
        logger.info(f"normalized api_base value: {normalized_api_base}")
        logger.info(f"api_key is set: {bool(self.api_key)}")
        logger.info(f"system_prompt is set: {bool(self.system_prompt)}")
        
        # Optional: provider validation is normally handled by the AlfyAI admin UI.
        if self.validate_model_on_build and not self._validate_model_exists(normalized_api_base, self.model_name, self.api_key or None):
            raise ValueError(
                f"Model '{self.model_name}' does not exist on OpenAI-compatible server at {normalized_api_base}. "
                f"Check your provider settings and ensure the model is available."
            )
        
        logger.info(f"Building model with name={self.model_name}, base_url={normalized_api_base}")

        uses_gpt_oss_reasoning_field = _uses_gpt_oss_reasoning_field(self.model_name)
        user_extra_body = _clean_mapping(self.extra_body or {})
        use_chat_template_kwargs = (
            bool(self.enable_thinking)
            and _allows_chat_template_kwargs(normalized_api_base)
        )
        if use_chat_template_kwargs:
            chat_template_kwargs = dict(user_extra_body.get("chat_template_kwargs") or {})
            chat_template_kwargs["enable_thinking"] = True
            user_extra_body["chat_template_kwargs"] = chat_template_kwargs

        user_model_kwargs = _clean_mapping(self.model_kwargs or {})
        thinking_type = str(getattr(self, "thinking_type", "") or "").strip()
        if thinking_type and not uses_gpt_oss_reasoning_field:
            thinking_config: dict[str, Any] = {"type": thinking_type}
            if thinking_type == "enabled" and _is_fireworks_base_url(normalized_api_base):
                thinking_config["budget_tokens"] = 4096
            user_extra_body["thinking"] = thinking_config

        # top_k is vLLM-specific and not part of the OpenAI spec, so it goes in extra_body.
        # -1 is vLLM's default (no limit), so we only set it when the user has changed it.
        if self.top_k is not None and self.top_k != -1:
            user_extra_body["top_k"] = self.top_k

        parameters: dict[str, Any] = {
            "api_key": SecretStr(self.api_key).get_secret_value() if self.api_key else None,
            "model": self.model_name,
            "max_tokens": self.max_tokens or None,
            "model_kwargs": user_model_kwargs,
            "extra_body": user_extra_body,
            "base_url": normalized_api_base,
            "temperature": self.temperature if self.temperature is not None else 0.1,
            "top_p": self.top_p if self.top_p is not None else 1.0,
            "system_prompt": self.system_prompt or "",
            "enable_thinking": bool(self.enable_thinking),
            "use_chat_template_kwargs": use_chat_template_kwargs,
        }
        if uses_gpt_oss_reasoning_field:
            parameters["reasoning_payload_field"] = "reasoning"

        reasoning_effort = str(getattr(self, "reasoning_effort", "") or "").strip()

        if reasoning_effort and (not thinking_type or uses_gpt_oss_reasoning_field):
            parameters["reasoning_effort"] = reasoning_effort
        if thinking_type and not uses_gpt_oss_reasoning_field:
            parameters["thinking_type"] = thinking_type

        if self.seed is not None and self.seed != -1:
            parameters["seed"] = self.seed
        configured_timeout = self._build_openai_timeout(
            self.timeout,
            allow_long_stream_reads=_allows_chat_template_kwargs(normalized_api_base),
        )
        if configured_timeout is not None:
            parameters["timeout"] = configured_timeout
        if self.max_retries is not None and self.max_retries != -1:
            parameters["max_retries"] = self.max_retries

        logger.info(f"=== OPENAI COMPATIBLE MODEL PARAMETERS ===")
        logger.info(f"model: {parameters.get('model')}")
        logger.info(f"base_url: {parameters.get('base_url')}")
        logger.info(f"enable_thinking: {parameters.get('enable_thinking')}")
        logger.info(f"use_chat_template_kwargs: {parameters.get('use_chat_template_kwargs')}")
        logger.info(f"reasoning_effort set: {bool(parameters.get('reasoning_effort'))}")
        logger.info(f"thinking_type set: {bool(thinking_type)}")
        logger.info(f"========================")

        output: BaseChatModel = NemotronReasoningChatOpenAI(**parameters)

        if self.json_mode:
            output = output.bind(response_format={"type": "json_object"})

        return output

    def update_build_config(self, build_config: dict, field_value: Any, field_name: str | None = None) -> dict:  # noqa: ARG002
        return build_config
