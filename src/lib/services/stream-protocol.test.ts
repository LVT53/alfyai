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

	it("uses the final Langflow content block output instead of concatenating tool dumps", () => {
		const rawSearchDump = [
			"Szürke rendszám - Tudj meg mindent a szürke rendszámról!",
			"Keresés",
			"Kapcsolat",
			"Belépés",
			"Kosár",
			"Kerékpárszállítók",
			"Adatvédelmi nyilatkozat",
			"Elfogadom",
		].join("\n");
		const rawFetchDump = [
			"Bicikliszállítás az autó hátulján?",
			"Otthon",
			"Kirándulás",
			"Kategóriák",
			"Címlapon",
			"Előző cikk",
			"Következő cikk",
			"2026-05-22",
		].join("\n");

		expect(
			getTextContent({
				content_blocks: [
					{
						title: "Agent Steps",
						contents: [
							{
								type: "text",
								text: "Rákeresek a vonóhorgos szabályokra.",
								header: { title: "Output", icon: "Bot" },
							},
							{
								type: "text",
								text: rawSearchDump,
								header: { title: "Output", icon: "Search" },
							},
							{
								type: "text",
								text: rawFetchDump,
								header: { title: "Output", icon: "FileText" },
							},
							{
								type: "text",
								text: "Magyarországon hivatalosan szürke rendszámot lehet igényelni.",
								header: { title: "Output", icon: "Bot" },
							},
						],
					},
				],
			}),
		).toBe("Magyarországon hivatalosan szürke rendszámot lehet igényelni.");
	});

	it("prefers clean Langflow content blocks over dirty top-level add_message text", () => {
		expect(
			getTextContent({
				text: "get_contents output:\nRaw web page text that should not be shown.",
				content_blocks: [
					{
						title: "Agent Steps",
						contents: [
							{
								type: "text",
								text: "The visible answer uses the fetched page without dumping it.",
								header: { title: "Output", icon: "Bot" },
							},
						],
					},
				],
			}),
		).toBe("The visible answer uses the fetched page without dumping it.");
	});

	it("keeps multiple Langflow assistant output blocks when none look like tool output", () => {
		expect(
			getTextContent({
				content_blocks: [
					{
						title: "Answer",
						contents: [
							{
								type: "text",
								text: "First paragraph.",
								header: { title: "Output", icon: "Bot" },
							},
							{
								type: "text",
								text: "Second paragraph.",
								header: { title: "Output", icon: "Bot" },
							},
						],
					},
				],
			}),
		).toBe("First paragraph.\nSecond paragraph.");
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

	it("strips leading tool-action narration before the final answer", () => {
		expect(
			stripLeakedToolDiagnostics(
				"Friss adatokat keresek a magyar szabályozásról.1. A szürke rendszám igényelhető.",
			),
		).toBe("1. A szürke rendszám igényelhető.");
		expect(
			stripLeakedToolDiagnostics(
				"Rákeresek a rendszámtábla szabályaira.\n\nA rövid válasz: igényelhető.",
			),
		).toBe("A rövid válasz: igényelhető.");
	});

	it("strips consecutive Hungarian web-planning narration and raw page text before the final answer", () => {
		expect(
			stripLeakedToolDiagnostics(
				[
					"Rákeresek a vonóhorgos kerékpárszállítóra szerelhető rendszámtábla szabályaira és beszerzési lehetőségeire.Két konkrét, friss magyar forrást is lekérdezek a részletekért.",
					"Szürke rendszám - Tudj meg mindent a szürke rendszámról!",
					"Keresés",
					"Kapcsolat",
					"Belépés",
					"Kosár",
					"Kerékpárszállítók",
					"Adatvédelmi nyilatkozat",
					"Elfogadom",
					"Magyarországon hivatalosan szürke rendszámot lehet igényelni vonóhorgos kerékpártartóra.",
				].join("\n"),
			),
		).toBe(
			"Magyarországon hivatalosan szürke rendszámot lehet igényelni vonóhorgos kerékpártartóra.",
		);
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

	it("strips plain article prose after leaked web get_contents output markers", () => {
		expect(
			stripLeakedToolDiagnostics(
				[
					"get_contents output:",
					"Bicikliszállítás az autó hátulján?",
					"A kerékpárszállító használata előtt fontos ellenőrizni a rendszám láthatóságát.",
					"Ha a rendszám takarásban van, külön rendszámtábla szükséges.",
					"",
					"Based on the fetched source, the key point is that a visible rear plate is required.",
				].join("\n"),
			),
		).toBe(
			"Based on the fetched source, the key point is that a visible rear plate is required.",
		);
	});

	it("does not treat generic article prose as the final answer after web output markers", () => {
		expect(
			stripLeakedToolDiagnostics(
				[
					"get_contents output:",
					"This article explains how rear-mounted bicycle carriers affect license plate visibility.",
					"The regulation depends on whether the plate is obscured.",
					"",
					"Here is the final answer: use an additional visible plate when the original is covered.",
				].join("\n"),
			),
		).toBe(
			"Here is the final answer: use an additional visible plate when the original is covered.",
		);
	});

	it("strips direct raw documentSource and program payloads before the final answer", () => {
		expect(
			stripLeakedToolDiagnostics(
				[
					'{"documentSource":{"version":1,"template":"alfyai_standard_report","title":"Draft","blocks":[{"type":"paragraph","text":"Raw document payload."}]}}',
					"Here is the concise answer without the raw document payload.",
				].join("\n"),
			),
		).toBe("Here is the concise answer without the raw document payload.");

		expect(
			stripLeakedToolDiagnostics(
				[
					'{"program":{"language":"python","sourceCode":"from pathlib import Path\\nPath(\\"/output/data.csv\\").write_text(\\"a,b\\")","filename":"data.csv"}}',
					"The file request has been started.",
				].join("\n"),
			),
		).toBe("The file request has been started.");
	});

	it("strips split raw documentSource payloads without repair narration", () => {
		expect(
			stripLeakedToolDiagnostics(
				[
					'{"documentSource": {',
					'  "version": 1,',
					'  "template": "alfyai_standard_report",',
					'  "title": "Draft",',
					'  "blocks": [',
					'    {"type":"paragraph","text":"Raw split document payload."}',
					"  ]",
					"}}",
					"Here is the final user-facing answer.",
				].join("\n"),
			),
		).toBe("Here is the final user-facing answer.");
	});

	it("keeps ordinary leading document block JSON examples outside repair context", () => {
		const jsonExample =
			'{"type":"paragraph","text":"Use this shape inside documentSource."}';

		expect(stripLeakedToolDiagnostics(jsonExample)).toBe(jsonExample);
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

	it("does not hold ordinary JSON examples as leaked diagnostic prefixes", () => {
		expect(getLeakedToolDiagnosticPrefixLength("Here is JSON: {")).toBe(0);
		expect(getLeakedToolDiagnosticPrefixLength('Here is JSON: {"type":')).toBe(
			0,
		);
	});

	it("holds split raw file-production payload prefixes in streaming buffers", () => {
		expect(getLeakedToolDiagnosticPrefixLength('{"documentSource":')).toBe(
			'{"documentSource":'.length,
		);
		expect(
			getLeakedToolDiagnosticPrefixLength('Answer before {"program":'),
		).toBe('{"program":'.length);
		expect(getLeakedToolDiagnosticPrefixLength('{"version":1,"blocks"')).toBe(
			'{"version":1,"blocks"'.length,
		);
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
