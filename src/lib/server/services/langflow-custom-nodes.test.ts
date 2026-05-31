import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nodeSource = (filename: string) =>
	readFileSync(resolve(process.cwd(), "langflow_nodes", filename), "utf8");

const runVllmNodeReasoningRecoveryFixture = () => {
	const nodePath = resolve(
		process.cwd(),
		"langflow_nodes",
		"vllm_node_fixed.py",
	);
	const script = `
import importlib.util
import json
import sys
import types

class Dummy:
    def __init__(self, *args, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)

    def __init_subclass__(cls, **kwargs):
        return super().__init_subclass__(**kwargs)

    @classmethod
    def get_base_inputs(cls):
        return []

    def copy(self, update=None):
        clone = self.__class__()
        clone.__dict__.update(self.__dict__)
        clone.__dict__.update(update or {})
        return clone

def install_module(name, attrs=None):
    module = types.ModuleType(name)
    for key, value in (attrs or {}).items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module

for name in [
    "langchain_core",
    "langchain_core.language_models",
    "langchain_core.language_models.chat_models",
    "langchain_core.messages",
    "langchain_core.outputs",
    "langchain_openai",
    "pydantic",
    "pydantic.v1",
    "lfx",
    "lfx.base",
    "lfx.base.models",
    "lfx.base.models.model",
    "lfx.field_typing",
    "lfx.field_typing.range_spec",
    "lfx.inputs",
    "lfx.inputs.inputs",
    "lfx.log",
    "lfx.log.logger",
    "httpx",
    "requests",
]:
    install_module(name)

sys.modules["langchain_core.language_models.chat_models"].BaseChatModel = Dummy
sys.modules["langchain_core.messages"].AIMessage = Dummy
sys.modules["langchain_core.messages"].AIMessageChunk = Dummy
sys.modules["langchain_core.messages"].SystemMessage = Dummy
sys.modules["langchain_core.outputs"].ChatGenerationChunk = Dummy
sys.modules["langchain_core.outputs"].ChatResult = Dummy
sys.modules["langchain_openai"].ChatOpenAI = Dummy
sys.modules["pydantic.v1"].SecretStr = Dummy
sys.modules["lfx.base.models.model"].LCModelComponent = Dummy
sys.modules["lfx.field_typing"].LanguageModel = Dummy
sys.modules["lfx.field_typing.range_spec"].RangeSpec = Dummy
for attr in [
    "BoolInput",
    "DictInput",
    "IntInput",
    "MultilineInput",
    "SecretStrInput",
    "SliderInput",
    "StrInput",
]:
    setattr(sys.modules["lfx.inputs.inputs"], attr, Dummy)
sys.modules["lfx.log.logger"].logger = types.SimpleNamespace(
    debug=lambda *args, **kwargs: None,
    info=lambda *args, **kwargs: None,
    warning=lambda *args, **kwargs: None,
    error=lambda *args, **kwargs: None,
)
sys.modules["httpx"].Timeout = Dummy
sys.modules["requests"].get = lambda *args, **kwargs: Dummy(
    raise_for_status=lambda: None,
    json=lambda: {"data": []},
)

spec = importlib.util.spec_from_file_location("vllm_node_fixed", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

model = module.NemotronReasoningChatOpenAI()
model.reasoning_payload_field = "reasoning"
model._last_reasoning_content = ""

payload = {
    "messages": [
        {
            "role": "assistant",
            "content": "<thinking>a</thinking><thinking>b</thinking>visible",
        },
        {
            "role": "assistant",
            "content": "<thinking>tool reason</thinking>",
            "tool_calls": [
                {
                    "type": "function",
                    "id": "call_1",
                    "function": {"name": "lookup", "arguments": "{}"},
                }
            ],
        },
    ],
}

result = model._recover_reasoning_in_payload(payload)
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
`;
	return JSON.parse(
		execFileSync("python3", ["-c", script, nodePath], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		}),
	) as {
		messages: Array<{
			role: string;
			content: string;
			reasoning?: string;
			reasoning_content?: string;
			tool_calls?: unknown[];
		}>;
	};
};

const runVllmNodeReasoningStreamFixture = () => {
	const nodePath = resolve(
		process.cwd(),
		"langflow_nodes",
		"vllm_node_fixed.py",
	);
	const script = `
import asyncio
import importlib.util
import json
import sys
import types

class Dummy:
    def __init__(self, *args, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)

    def __init_subclass__(cls, **kwargs):
        return super().__init_subclass__(**kwargs)

    @classmethod
    def get_base_inputs(cls):
        return []

    def copy(self, update=None):
        clone = self.__class__()
        clone.__dict__.update(self.__dict__)
        clone.__dict__.update(update or {})
        return clone

def install_module(name, attrs=None):
    module = types.ModuleType(name)
    for key, value in (attrs or {}).items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module

for name in [
    "langchain_core",
    "langchain_core.language_models",
    "langchain_core.language_models.chat_models",
    "langchain_core.messages",
    "langchain_core.outputs",
    "langchain_openai",
    "pydantic",
    "pydantic.v1",
    "lfx",
    "lfx.base",
    "lfx.base.models",
    "lfx.base.models.model",
    "lfx.field_typing",
    "lfx.field_typing.range_spec",
    "lfx.inputs",
    "lfx.inputs.inputs",
    "lfx.log",
    "lfx.log.logger",
    "httpx",
    "requests",
]:
    install_module(name)

sys.modules["langchain_core.language_models.chat_models"].BaseChatModel = Dummy
sys.modules["langchain_core.messages"].AIMessage = Dummy
sys.modules["langchain_core.messages"].AIMessageChunk = Dummy
sys.modules["langchain_core.messages"].SystemMessage = Dummy
sys.modules["langchain_core.outputs"].ChatGenerationChunk = Dummy
sys.modules["langchain_core.outputs"].ChatResult = Dummy
sys.modules["langchain_openai"].ChatOpenAI = Dummy
sys.modules["pydantic.v1"].SecretStr = Dummy
sys.modules["lfx.base.models.model"].LCModelComponent = Dummy
sys.modules["lfx.field_typing"].LanguageModel = Dummy
sys.modules["lfx.field_typing.range_spec"].RangeSpec = Dummy
for attr in [
    "BoolInput",
    "DictInput",
    "IntInput",
    "MultilineInput",
    "SecretStrInput",
    "SliderInput",
    "StrInput",
]:
    setattr(sys.modules["lfx.inputs.inputs"], attr, Dummy)
sys.modules["lfx.log.logger"].logger = types.SimpleNamespace(
    debug=lambda *args, **kwargs: None,
    info=lambda *args, **kwargs: None,
    warning=lambda *args, **kwargs: None,
    error=lambda *args, **kwargs: None,
)
sys.modules["httpx"].Timeout = Dummy
sys.modules["requests"].get = lambda *args, **kwargs: Dummy(
    raise_for_status=lambda: None,
    json=lambda: {"data": []},
)

spec = importlib.util.spec_from_file_location("vllm_node_fixed", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeAsyncClient:
    async def create(self, **payload):
        async def stream():
            for reasoning in ["The", " search", " tool", " keeps", " returning", " no", " results"]:
                yield {"choices": [{"delta": {"reasoning_content": reasoning}}]}
            yield {"choices": [{"delta": {"content": "Final answer"}}]}
        return stream()

def fake_request_payload(self, messages, *args, **kwargs):
    return {"messages": []}

def fake_convert_chunk_to_generation_chunk(raw_chunk, default_chunk_class, generation_info):
    delta = (raw_chunk.get("choices") or [{}])[0].get("delta") or {}
    content = delta.get("content")
    if content:
        return module.ChatGenerationChunk(
            message=module.AIMessageChunk(content=content),
            generation_info={},
        )
    return None

async def main():
    model = module.NemotronReasoningChatOpenAI()
    model._get_request_payload = types.MethodType(fake_request_payload, model)
    model.async_client = FakeAsyncClient()
    model._convert_chunk_to_generation_chunk = fake_convert_chunk_to_generation_chunk

    chunks = []
    async for chunk in model._astream([]):
        chunks.append(chunk.message.content)
    print(json.dumps(chunks, ensure_ascii=False, separators=(",", ":")))

asyncio.run(main())
`;
	return JSON.parse(
		execFileSync("python3", ["-c", script, nodePath], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		}),
	) as string[];
};

describe("Langflow custom model node", () => {
	it("keeps streamed reasoning deltas in one thinking tag span", () => {
		const chunks = runVllmNodeReasoningStreamFixture();

		expect(chunks.join("")).toBe(
			"<thinking>The search tool keeps returning no results</thinking>Final answer",
		);
		expect(chunks.filter((chunk) => chunk === "<thinking>").length).toBe(1);
		expect(chunks.filter((chunk) => chunk === "</thinking>").length).toBe(1);
		expect(chunks).not.toContain("<thinking>The</thinking>");
	});

	it("recovers every tagged GPT-OSS thinking block before replaying assistant history to the model", () => {
		const recoveredPayload = runVllmNodeReasoningRecoveryFixture();
		const assistantMessage = recoveredPayload.messages[0];
		const toolCallMessage = recoveredPayload.messages[1];

		expect(assistantMessage.content).toBe("visible");
		expect(assistantMessage.reasoning).toBe("ab");
		expect(assistantMessage.reasoning_content).toBeUndefined();
		expect(toolCallMessage.content).toBe("");
		expect(toolCallMessage.reasoning).toBe("tool reason");
		expect(toolCallMessage.reasoning_content).toBeUndefined();
		expect(toolCallMessage.tool_calls).toEqual([
			{
				type: "function",
				id: "call_1",
				function: { name: "lookup", arguments: "{}" },
			},
		]);
		expect(JSON.stringify(recoveredPayload.messages)).not.toContain(
			"<thinking>",
		);
		expect(JSON.stringify(recoveredPayload.messages)).not.toContain(
			"</thinking>",
		);
	});

	it("routes GPT-OSS recovered tool-call reasoning through the Chat Completions reasoning field", () => {
		const source = nodeSource("vllm_node_fixed.py");

		expect(source).toContain("_uses_gpt_oss_reasoning_field(self.model_name)");
		expect(source).toContain(
			'parameters["reasoning_payload_field"] = "reasoning"',
		);
		expect(source).toContain(
			"msg[self.reasoning_payload_field] = reasoning_text",
		);
		expect(source).toContain('if self.reasoning_payload_field == "reasoning":');
		expect(source).toContain('msg.pop("reasoning_content", None)');
	});

	it("applies configured reasoning request body fields to streaming and non-streaming calls", () => {
		const source = nodeSource("vllm_node_fixed.py");
		const mergeCallCount =
			source.match(/payload = self\._merge_reasoning_body\(payload\)/g)
				?.length ?? 0;

		expect(mergeCallCount).toBeGreaterThanOrEqual(2);
		expect(source).toContain("response = self.client.create(**payload)");
	});

	it("preserves structured content parts when tagging non-stream reasoning", () => {
		const source = nodeSource("vllm_node_fixed.py");

		expect(source).toContain("_prepend_reasoning_to_content");
		expect(source).toContain("if isinstance(content, list):");
		expect(source).toContain('{"type": "text", "text": tagged_reasoning}');
		expect(source).toContain("return f\"{tagged_reasoning}{content or ''}\"");
		expect(source).toContain(
			"content=self._prepend_reasoning_to_content(current_content, tagged_reasoning)",
		);
		expect(source).not.toContain(
			'content=f"{tagged_reasoning}{current_content}"',
		);
	});

	it("keeps generic reasoning_content recovery for non-GPT-OSS providers", () => {
		const source = nodeSource("vllm_node_fixed.py");

		expect(source).toContain(
			'reasoning_payload_field: str = "reasoning_content"',
		);
		expect(source).toContain('return "reasoning_content" in msg');
		expect(source).toContain('message_dict["reasoning_content"] = reasoning');
		expect(source).toContain(
			"if has_tool_calls and self._last_reasoning_content:",
		);
	});

	it("keeps OpenAI-compatible tool-call message content string-shaped for vLLM", () => {
		const source = nodeSource("vllm_node_fixed.py");

		expect(source).toContain("_normalize_payload_message_content");
		expect(source).toContain(
			'msg["content"] = clean_content if clean_content or not has_tool_calls else ""',
		);
		expect(source).not.toContain(
			'msg["content"] = clean_content if clean_content or not has_tool_calls else None',
		);
		expect(source).toContain('if has_tool_calls and content in (None, ""):');
		expect(source).toContain('msg["content"] = ""');
		expect(source).toMatch(
			/payload = self\._normalize_payload_message_content\(payload\)[\s\S]*return self\._recover_reasoning_in_payload\(payload\)/,
		);
	});

	it("drops partial streaming tool calls before sending history back to vLLM", () => {
		const source = nodeSource("vllm_node_fixed.py");

		expect(source).toContain("_normalize_openai_compatible_tool_calls");
		expect(source).toContain('msg.pop("tool_call_chunks", None)');
		expect(source).toContain('msg.pop("tool_calls", None)');
		expect(source).toContain(
			"if not isinstance(tool_call_id, str) or not tool_call_id.strip():",
		);
		expect(source).toContain(
			"if not isinstance(function_name, str) or not function_name.strip():",
		);
		expect(source).toContain('"arguments": self._coerce_tool_call_arguments(');
		expect(source).toMatch(
			/has_tool_calls = self\._normalize_openai_compatible_tool_calls\(msg\)[\s\S]*if has_tool_calls and content in \(None, ""\):/,
		);
	});

	it("uses stream-friendly read timeout settings for local OpenAI-compatible models", () => {
		const source = nodeSource("vllm_node_fixed.py");

		expect(source).toContain("import httpx");
		expect(source).toContain("_build_openai_timeout");
		expect(source).toContain("read=None");
		expect(source).toContain(
			"configured_timeout = self._build_openai_timeout(",
		);
		expect(source).toContain('parameters["timeout"] = configured_timeout');
		expect(source).not.toContain('parameters["timeout"] = self.timeout');
	});

	it("keeps tool-call marker callbacks single-sourced per tool", () => {
		const source = nodeSource("agent_node.py");

		expect(source).toContain(
			"if not isinstance(callback, ToolCallEmitterCallback)",
		);
		expect(source).toContain("next_callbacks = existing + [cb]");
		expect(source).toContain('"callId": call_id');
	});

	it("keeps model-facing web research results compact", () => {
		const source = nodeSource("web_research_tool.py");

		expect(source).toContain("MODEL_ANSWER_BRIEF_MARKDOWN_MAX_CHARS = 12000");
		expect(source).toContain("_compact_sources_for_model");
		expect(source).toContain("_compact_evidence_for_model");
		expect(source).toContain(
			"model_sources = self._compact_sources_for_model(sources)",
		);
		expect(source).toContain(
			"model_evidence = self._compact_evidence_for_model(evidence)",
		);
		expect(source).toContain(
			'model_answer_brief_markdown = model_answer_brief.pop("markdown", "")',
		);
		expect(source).toContain('"answerBrief": model_answer_brief');
		expect(source).toContain(
			'"answerBriefMarkdown": model_answer_brief_markdown',
		);
		expect(source).toContain('"sources": model_sources');
		expect(source).toContain('"evidence": model_evidence');
		expect(source).toContain('"diagnostics": model_diagnostics');
	});

	it("keeps model-facing file-production status compact", () => {
		const source = nodeSource("file_production_tool.py");

		expect(source).toContain("MODEL_FILE_PRODUCTION_FILE_LIMIT = 5");
		expect(source).toContain("_compact_job_for_model");
		expect(source).toContain("model_job = self._compact_job_for_model(job)");
		expect(source).toContain('"candidates": model_files');
		expect(source).toContain('"job": model_job');
		expect(source).toContain("MODEL_FILE_PRODUCTION_ERROR_MAX_CHARS");
	});
});
