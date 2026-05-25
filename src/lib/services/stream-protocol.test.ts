import { describe, expect, it, vi } from "vitest";
import {
	createInlineThinkingState,
	flushInlineThinkingState,
	getLeakedToolDiagnosticPrefixLength,
	getTextContent,
	mayStartLeadingThinkingPreamble,
	processInlineThinkingChunk,
	splitLeadingThinkingPreamble,
	stripLeadingResponseMarker,
	stripLeakedToolDiagnostics,
} from "./stream-protocol";

describe("stream-protocol", () => {
	it("routes inline thinking tags into separate visible and thinking emissions", () => {
		const state = createInlineThinkingState();
		const onVisible = vi.fn();
		const onThinking = vi.fn();

		processInlineThinkingChunk(
			state,
			"Before<thinking>Need to reason</thinking>After",
			{
				onVisible,
				onThinking,
			},
		);

		expect(onVisible.mock.calls).toEqual([["Before"], ["After"]]);
		expect(onThinking.mock.calls).toEqual([["Need to reason"]]);
	});

	it("handles thinking tags split across chunks and tag boundaries", () => {
		const state = createInlineThinkingState();
		const onVisible = vi.fn();
		const onThinking = vi.fn();

		processInlineThinkingChunk(state, "Before<think", {
			onVisible,
			onThinking,
		});
		processInlineThinkingChunk(state, ">Need to rea", {
			onVisible,
			onThinking,
		});
		processInlineThinkingChunk(state, "son</think>After", {
			onVisible,
			onThinking,
		});

		expect(onVisible.mock.calls).toEqual([["Before"], ["After"]]);
		expect(onThinking.mock.calls).toEqual([["Need to rea"], ["son"]]);
	});

	it("handles mixed-case Qwen thinking tags", () => {
		const state = createInlineThinkingState();
		const onVisible = vi.fn();
		const onThinking = vi.fn();

		processInlineThinkingChunk(
			state,
			"Before<Think>Need to reason</THINK>After",
			{
				onVisible,
				onThinking,
			},
		);

		expect(onVisible.mock.calls).toEqual([["Before"], ["After"]]);
		expect(onThinking.mock.calls).toEqual([["Need to reason"]]);
	});

	it("routes Qwen ChatML thinking traces into thinking emissions", () => {
		const state = createInlineThinkingState();
		const onVisible = vi.fn();
		const onThinking = vi.fn();

		processInlineThinkingChunk(state, "Before<|im_start|>analysis\nTrace", {
			onVisible,
			onThinking,
		});
		processInlineThinkingChunk(state, " details<|im_end|>After", {
			onVisible,
			onThinking,
		});

		expect(onVisible.mock.calls).toEqual([["Before"], ["After"]]);
		expect(onThinking.mock.calls).toEqual([["\nTrace"], [" details"]]);
	});

	it("treats bracketed THINK text as ordinary visible output", () => {
		const state = createInlineThinkingState();
		const visibleChunks: string[] = [];
		const onThinking = vi.fn();

		processInlineThinkingChunk(state, "Before[TH", {
			onVisible(chunk) {
				visibleChunks.push(chunk);
			},
			onThinking,
		});
		processInlineThinkingChunk(state, "INK]Bracketed plan[/THINK]After", {
			onVisible(chunk) {
				visibleChunks.push(chunk);
			},
			onThinking,
		});

		expect(visibleChunks.join("")).toBe(
			"Before[THINK]Bracketed plan[/THINK]After",
		);
		expect(onThinking).not.toHaveBeenCalled();
	});

	it("drops a trailing partial open tag when flushing visible content", () => {
		const state = createInlineThinkingState();
		const onVisible = vi.fn();
		const onThinking = vi.fn();

		processInlineThinkingChunk(state, "Visible<think", {
			onVisible,
			onThinking,
		});
		flushInlineThinkingState(state, { onVisible, onThinking });

		expect(onVisible.mock.calls).toEqual([["Visible"]]);
		expect(onThinking).not.toHaveBeenCalled();
	});

	it("flushes unfinished inline thinking as thinking content", () => {
		const state = createInlineThinkingState();
		const onVisible = vi.fn();
		const onThinking = vi.fn();

		processInlineThinkingChunk(state, "<thinking>Unfinished", {
			onVisible,
			onThinking,
		});
		flushInlineThinkingState(state, { onVisible, onThinking });

		expect(onVisible).not.toHaveBeenCalled();
		expect(onThinking.mock.calls).toEqual([["Unfinished"]]);
	});

	it("extracts assistant text from nested LangChain chunk payloads", () => {
		expect(
			getTextContent({
				data: {
					chunk: {
						content: "Nested assistant text",
					},
				},
			}),
		).toBe("Nested assistant text");
	});

	it("extracts assistant text from OpenAI content part arrays", () => {
		expect(
			getTextContent({
				choices: [
					{
						delta: {
							content: [
								{ type: "text", text: "Part one" },
								{ type: "text", text: " and two" },
							],
						},
					},
				],
			}),
		).toBe("Part one and two");
	});

	it("extracts assistant text from Responses-style output arrays", () => {
		const output = [
			{
				type: "reasoning",
				content: [
					{
						type: "reasoning_text",
						text: "Private reasoning",
					},
				],
			},
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: "Visible answer",
					},
				],
			},
		];

		expect(getTextContent({ output })).toBe("Visible answer");
		expect(getTextContent(output)).toBe("Visible answer");
	});

	it("does not expose reasoning_text content parts as assistant text", () => {
		expect(
			getTextContent({
				content: [
					{
						type: "reasoning_text",
						text: "Private reasoning",
					},
					{
						type: "output_text",
						text: "Visible answer",
					},
				],
			}),
		).toBe("Visible answer");
	});

	it("strips a leading Langflow response marker before visible output", () => {
		expect(
			stripLeadingResponseMarker("responseThe United States is large."),
		).toBe("The United States is large.");
		expect(
			stripLeadingResponseMarker("response:The United States is large."),
		).toBe("The United States is large.");
		expect(
			stripLeadingResponseMarker("response The United States is large."),
		).toBe("The United States is large.");
		expect(
			stripLeadingResponseMarker("response The user wants me to answer."),
		).toBe("The user wants me to answer.");
		expect(
			stripLeadingResponseMarker("response\nThe user wants me to answer."),
		).toBe("The user wants me to answer.");
		expect(stripLeadingResponseMarker("response<think>reason</think>")).toBe(
			"<think>reason</think>",
		);
		expect(stripLeadingResponseMarker("response time can be slow.")).toBe(
			"response time can be slow.",
		);
	});

	it("keeps buffering a partial response-prefixed thinking preamble", () => {
		expect(mayStartLeadingThinkingPreamble("response Th")).toBe(true);
		expect(mayStartLeadingThinkingPreamble("response The")).toBe(true);
		expect(mayStartLeadingThinkingPreamble("response<")).toBe(true);
		expect(mayStartLeadingThinkingPreamble("response<th")).toBe(true);
		expect(mayStartLeadingThinkingPreamble("response time")).toBe(false);
	});

	it("strips leaked web research diagnostic result text", () => {
		expect(
			stripLeakedToolDiagnostics(
				"Qudelix 5K alternatives that match itFound 8 source(s) and 16 evidence snippet(s)\n\nNext paragraph.",
			),
		).toBe("Qudelix 5K alternatives that match it\n\nNext paragraph.");
		expect(
			stripLeakedToolDiagnostics(
				"Found 8 sources and 16 evidenceThe answer starts here.",
			),
		).toBe("The answer starts here.");
	});

	it("strips raw web search and fetch result blocks after leaked diagnostics", () => {
		expect(
			stripLeakedToolDiagnostics(
				[
					"Qudelix alternativesFound 8 source(s) and 16 evidence snippet(s)",
					"1. title: Qudelix product page",
					"url: https://example.com/qudelix",
					"evidence: The page text and search snippets are tool evidence.",
					"Based on the sources, the Qudelix 5K is the direct comparison point.",
				].join("\n"),
			),
		).toBe(
			[
				"Qudelix alternatives",
				"Based on the sources, the Qudelix 5K is the direct comparison point.",
			].join("\n"),
		);

		expect(
			stripLeakedToolDiagnostics(
				[
					"fetch_content output:",
					"{",
					'  "answerBriefMarkdown": "raw fetched page text",',
					'  "sources": [{"title": "Example", "url": "https://example.com"}]',
					"}",
					"The final answer uses the fetched page without dumping it.",
				].join("\n"),
			),
		).toBe("The final answer uses the fetched page without dumping it.");
	});

	it("strips leaked Python REPL invocation and execution output", () => {
		const cleaned = stripLeakedToolDiagnostics(
			[
				"run_python_repl: import subprocess",
				"run_python_repl: print('disk check')",
				"I'll inspect the server first.Successfully imported modules: ['math', 'pandas']Code execution completed successfully=== DISK OVERVIEW ===",
				"Filesystem Size Used Avail Use% Mounted on",
				"overlay 200G 131G 70G 66% /",
				"stderr:",
				"not found",
				"MISSING: /run/containerd/containerd.sockI see the root filesystem is 66% used.",
			].join("\n"),
		);

		expect(cleaned).not.toContain("run_python_repl");
		expect(cleaned).not.toContain("Successfully imported modules");
		expect(cleaned).not.toContain("Code execution completed");
		expect(cleaned).not.toContain("Filesystem Size");
		expect(cleaned).not.toContain("not found");
		expect(cleaned).not.toContain("MISSING:");
		expect(cleaned).toContain("I see the root filesystem is 66% used.");
	});

	it("detects partial leaked web research diagnostics for streaming buffers", () => {
		expect(
			getLeakedToolDiagnosticPrefixLength("Answer before Found 8 sour"),
		).toBe(13);
		expect(
			getLeakedToolDiagnosticPrefixLength(
				"Answer before Found 8 source files were useful",
			),
		).toBe(0);
	});

	it("detects partial leaked Python REPL diagnostics for streaming buffers", () => {
		expect(getLeakedToolDiagnosticPrefixLength("run_python_")).toBe(11);
		expect(getLeakedToolDiagnosticPrefixLength("Recovered answer")).toBe(0);
		expect(
			getLeakedToolDiagnosticPrefixLength(
				"Before text Successfully imported mod",
			),
		).toBe(25);
		expect(
			getLeakedToolDiagnosticPrefixLength("Before text Code execution complet"),
		).toBe(22);
	});

	it("splits an untagged Qwen planning preamble from visible prose", () => {
		const split = splitLeadingThinkingPreamble(
			"responseThe user wants me to write 500 words about the USA. This is a straightforward content request. I will write an informative piece.\n\n" +
				"I need to wrap the content in XML-style wrapper tags and provide it in English.\n\n" +
				"The United States is a large and diverse country.",
		);

		expect(split).toEqual({
			thinkingText:
				"The user wants me to write 500 words about the USA. This is a straightforward content request. I will write an informative piece.\n\n" +
				"I need to wrap the content in XML-style wrapper tags and provide it in English.",
			visibleText: "The United States is a large and diverse country.",
		});
	});

	it("strips dangling thinking delimiters from Qwen planning preambles", () => {
		const split = splitLeadingThinkingPreamble(
			"The user is asking me to write 500 words about the USA. This is a straightforward content request. Let me aim for approximately 500 words.\n</think>\n\n" +
				"The United States is a large and diverse country.",
		);

		expect(split).toEqual({
			thinkingText:
				"The user is asking me to write 500 words about the USA. This is a straightforward content request. Let me aim for approximately 500 words.",
			visibleText: "The United States is a large and diverse country.",
		});
	});

	it("does not classify ordinary first-person answers as planning preambles", () => {
		expect(
			splitLeadingThinkingPreamble(
				"I need a clear thesis, strong evidence, and a concise conclusion.",
			),
		).toBeNull();
	});
});
