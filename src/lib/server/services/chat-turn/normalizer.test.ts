import { describe, expect, it } from "vitest";
import { normalizeAssistantOutput } from "./normalizer";
import { getReasoningContent } from "./thinking-normalizer";

describe("normalizeAssistantOutput", () => {
	it("strips <thinking> blocks from text", () => {
		const result = normalizeAssistantOutput(
			"<thinking>Internal reasoning</thinking>Visible text",
		);
		expect(result).toBe("Visible text");
	});

	it("strips Qwen/DeepSeek <think> blocks from text", () => {
		const result = normalizeAssistantOutput(
			"<think>Internal reasoning with punctuation, math: 2 > 1.</think>\nVisible text",
		);
		expect(result).toBe("Visible text");
	});

	it("strips Mistral [THINK] blocks from text", () => {
		const result = normalizeAssistantOutput(
			"[THINK]Internal reasoning[/THINK]\nVisible text",
		);
		expect(result).toBe("Visible text");
	});

	it("strips Qwen ChatML analysis blocks from text", () => {
		const result = normalizeAssistantOutput(
			"Before<|im_start|>analysis\nInternal reasoning<|im_end|>Visible text",
		);
		expect(result).toBe("BeforeVisible text");
	});

	it("treats unclosed thinking blocks as thinking content", () => {
		const result = normalizeAssistantOutput(
			"Before <thinking>unclosed thinking and <thinking>more",
		);
		expect(result).toBe("Before");
	});

	it("passes through text with no tags unchanged", () => {
		const result = normalizeAssistantOutput("Plain text response");
		expect(result).toBe("Plain text response");
	});

	it("handles empty string", () => {
		const result = normalizeAssistantOutput("");
		expect(result).toBe("");
	});

	it("strips tool-call markers from text", () => {
		const result = normalizeAssistantOutput(
			'Before text\u0002TOOL_START\u001f{"name":"search"}\u0003during search\u0002TOOL_END\u001f{"name":"search","outputSummary":"done"}\u0003After text',
		);
		expect(result).toBe("Before textduring searchAfter text");
	});

	it("strips untagged Qwen planning preambles from text", () => {
		const result = normalizeAssistantOutput(
			"responseThe user wants me to write 500 words about the USA. This is a straightforward content request. I will write an informative piece.\n\n" +
				"I need to wrap the content in XML-style wrapper tags and provide it in English.\n\n" +
				"The United States is a large and diverse country.",
		);
		expect(result).toBe("The United States is a large and diverse country.");
	});

	it("strips leaked research_web diagnostic text from assistant output", () => {
		const result = normalizeAssistantOutput(
			"Qudelix alternativesFound 8 source(s) and 16 evidence snippet(s)\n\nThe answer starts here.",
		);

		expect(result).toBe("Qudelix alternatives\n\nThe answer starts here.");
	});

	it("strips leaked Python REPL transcripts from assistant output", () => {
		const result = normalizeAssistantOutput(
			[
				"run_python_repl: import subprocess",
				"run_python_repl: print('disk check')",
				"Successfully imported modules: ['math', 'pandas']Code execution completed successfully=== DISK OVERVIEW ===",
				"Filesystem Size Used Avail Use% Mounted on",
				"overlay 200G 131G 70G 66% /",
				"stderr:",
				"not found",
				"MISSING: /run/containerd/containerd.sockI see the root filesystem is 66% used.",
			].join("\n"),
		);

		expect(result).toBe("I see the root filesystem is 66% used.");
	});

	it("strips thinking and tool markers combined", () => {
		const result = normalizeAssistantOutput(
			"<thinking>reason</thinking>" +
				'\u0002TOOL_START\u001f{"name":"calc"}\u0003' +
				"hello",
		);
		expect(result).toBe("hello");
	});

	it("strips complete Skill Control Envelope blocks from visible assistant output", () => {
		const result = normalizeAssistantOutput(
			[
				"I need one detail before continuing.",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "question-1",
							kind: "session_transition",
							transition: "awaiting_user",
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
		);

		expect(result).toBe("I need one detail before continuing.");
	});

	it("handles whitespace-only input", () => {
		const result = normalizeAssistantOutput("   \n\t  ");
		expect(result).toBe("");
	});

	it("extracts reasoning from LangChain chunk additional kwargs", () => {
		const result = getReasoningContent({
			data: {
				chunk: {
					content: "",
					additional_kwargs: {
						reasoning_content: "Qwen hidden reasoning",
					},
				},
			},
		});

		expect(result).toBe("Qwen hidden reasoning");
	});

	it("extracts reasoning from camelCase provider payloads", () => {
		const result = getReasoningContent({
			choices: [
				{
					delta: {
						reasoningContent: "Qwen 3 hidden reasoning",
						content: "",
					},
				},
			],
		});

		expect(result).toBe("Qwen 3 hidden reasoning");
	});

	it("extracts reasoning from nested LangChain kwargs payloads", () => {
		const result = getReasoningContent({
			data: {
				chunk: {
					kwargs: {
						additional_kwargs: {
							reasoning_content_delta: "Nested Qwen reasoning",
						},
					},
				},
			},
		});

		expect(result).toBe("Nested Qwen reasoning");
	});
});
