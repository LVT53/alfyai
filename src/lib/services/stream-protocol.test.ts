import { describe, expect, it, vi } from "vitest";
import {
	containsToolCallMarkup,
	createInlineThinkingState,
	createLeakedToolDiagnosticsState,
	FRIENDLY_STREAM_ERRORS,
	flushInlineThinkingState,
	getLeakedToolDiagnosticPrefixLength,
	getTextContent,
	hasVisibleCharacter,
	mayStartLeadingThinkingPreamble,
	processInlineThinkingChunk,
	resetLeakedToolDiagnosticsForNewTextRun,
	splitLeadingThinkingPreamble,
	startsWithToolCallMarkup,
	stripLeadingResponseMarker,
	stripLeakedToolDiagnostics,
} from "./stream-protocol";

describe("stream-protocol", () => {
	it("uses provider-neutral fallback text for backend stream failures", () => {
		expect(FRIENDLY_STREAM_ERRORS.backend_failure).toContain("model provider");
		expect(FRIENDLY_STREAM_ERRORS.backend_failure).not.toMatch(/Langflow/i);
	});

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

	it("drops orphan closing thinking delimiters from visible output", () => {
		const state = createInlineThinkingState();
		const onVisible = vi.fn();
		const onThinking = vi.fn();

		processInlineThinkingChunk(state, "Before</thi", {
			onVisible,
			onThinking,
		});
		processInlineThinkingChunk(state, "nk>After", {
			onVisible,
			onThinking,
		});
		flushInlineThinkingState(state, {
			onVisible,
			onThinking,
		});

		expect(onVisible.mock.calls).toEqual([["Before"], ["After"]]);
		expect(onThinking).not.toHaveBeenCalled();
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

	it("uses the final provider content block output instead of concatenating tool dumps", () => {
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

	it("prefers clean provider content blocks over dirty top-level add_message text", () => {
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

	it("keeps multiple provider assistant output blocks when none look like tool output", () => {
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

	it("strips a leading response marker before visible output", () => {
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

	it("strips chained English web-progress narration before the final answer", () => {
		const cleaned = stripLeakedToolDiagnostics(
			[
				"The first batch of searches didn't return great results - the queries were too broad and some got pulled into unrelated territory. Let me run more targeted searches now.",
				"Let me try a couple more targeted fetches to get concrete details on the TUS SU marketplace and the PMI villages.",
				"Now I have solid data. Let me pull it all together.",
				"",
				"---",
				"",
				"## 5-Day vs 7-Day Accommodation - What It Means",
				"",
				"**It's about weekend access to your room:**",
			].join("\n"),
		);

		expect(cleaned).toBe(
			[
				"---",
				"",
				"## 5-Day vs 7-Day Accommodation - What It Means",
				"",
				"**It's about weekend access to your room:**",
			].join("\n"),
		);
		expect(cleaned).not.toContain("first batch of searches");
		expect(cleaned).not.toContain("Let me");
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

	it("strips Röviden-prefixed Hungarian web-planning narration and fetched page text before the final answer", () => {
		const cleaned = stripLeakedToolDiagnostics(
			[
				"Röviden kikeresem a vonóhorgos kerékpárszállítóra vonatkozó aktuális magyar rendszámtábla-szabályokat.Röviden ellenőrzöm a friss magyar forrásokat a részletekért.",
				"Természetjáró hírek - termeszet.hu",
				"Kategóriák",
				"Belépés",
				"Kapcsolat",
				"Belépés/Kapcsolat",
				"Kirándulás",
				"Kerékpárszállítás az autó hátulján?",
				"A vonóhorogra szerelt kerékpárszállító eltakarhatja az autó hátsó rendszámát.",
				"Ha a vonóhorgos kerékpárszállító eltakarja az autó rendszámát, külön rendszámtáblát kell felszerelni a tartóra.",
			].join("\n"),
		);

		expect(cleaned).toBe(
			"Ha a vonóhorgos kerékpárszállító eltakarja az autó rendszámát, külön rendszámtáblát kell felszerelni a tartóra.",
		);
		expect(cleaned).not.toContain("Röviden kikeresem");
		expect(cleaned).not.toContain("Természetjáró hírek");
		expect(cleaned).not.toContain("Kategóriák");
	});

	it("keeps ordinary Hungarian answers that start with Röviden", () => {
		expect(
			stripLeakedToolDiagnostics(
				"Röviden: ha a tartó eltakarja a rendszámot, külön tábla kell.",
			),
		).toBe("Röviden: ha a tartó eltakarja a rendszámot, külön tábla kell.");
		expect(
			stripLeakedToolDiagnostics(
				"Röviden, a szabály lényege az, hogy a rendszámnak láthatónak kell maradnia.",
			),
		).toBe(
			"Röviden, a szabály lényege az, hogy a rendszámnak láthatónak kell maradnia.",
		);
	});

	it("strips standalone Hungarian web-planning narration before the final answer", () => {
		expect(
			stripLeakedToolDiagnostics(
				"Kikeresem a vonóhorgos kerékpárszállító rendszámtáblával kapcsolatos aktuális magyar szabályokat.Ha a vonóhorgos kerékpárszállító eltakarja az autó rendszámát, külön rendszámtáblát kell felszerelni a tartóra.",
			),
		).toBe(
			"Ha a vonóhorgos kerékpárszállító eltakarja az autó rendszámát, külön rendszámtáblát kell felszerelni a tartóra.",
		);
		expect(getLeakedToolDiagnosticPrefixLength("Kikeres")).toBe(
			"Kikeres".length,
		);
		expect(getLeakedToolDiagnosticPrefixLength("Ki")).toBe("Ki".length);
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

	it("strips standalone raw fetched wiki page dumps without explicit tool markers", () => {
		const cleaned = stripLeakedToolDiagnostics(
			[
				"Anvil Arrow - Star Citizen Wiki",
				"Toggle search",
				"Search",
				"Toggle menu",
				"Star Citizen Wiki",
				"Navigation",
				"Home Recent changes Random page Special pages Upload file",
				"Vehicles",
				"Gameplay",
				"External",
				"Status page",
				"Contact us",
				"Discord",
				"Twitter",
				"GitHub",
				"Reddit",
				"Anvil Arrow",
				"From the Star Citizen Wiki, the fidelity encyclopedia",
				"404Fidelity neededThis page does not exist currently. Maybe soon?",
				"The article that you're looking for doesn't exist.",
				"Retrieved from ",
				"starcitizen.tools",
				"Privacy policy",
				"About us",
				"Disclaimers",
				"Cookie statement",
				"Status page",
				"GitHub",
				"Patreon",
				"Ko-fi",
			].join("\n"),
		);

		expect(cleaned).toBe("");
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
		expect(getLeakedToolDiagnosticPrefixLength("Röviden kikere")).toBe(
			"Röviden kikere".length,
		);
		expect(
			getLeakedToolDiagnosticPrefixLength(
				"Answer before Found 8 source files were useful",
			),
		).toBe(0);
	});

	it("does not hold ordinary first-person or search-feature prose as progress diagnostics", () => {
		expect(
			stripLeakedToolDiagnostics("I have two practical options for you."),
		).toBe("I have two practical options for you.");
		expect(getLeakedToolDiagnosticPrefixLength("I have")).toBe(0);
		expect(getLeakedToolDiagnosticPrefixLength("The search feature")).toBe(0);
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

	it("strips markdown JSON blocks containing raw tool call arguments", () => {
		const cleaned = stripLeakedToolDiagnostics(
			[
				"Here is what I found about the bicycle.",
				"",
				"```json",
				"{",
				'  "query": "Cube Kathmandu Hybrid One11 HPC SLT 800 Carbon 2026 specifications features",',
				'  "mode": "exact",',
				'  "freshness": "live",',
				'  "sourcePolicy": "commerce"',
				"}",
				"```",
			].join("\n"),
		);
		expect(cleaned.trim()).toBe("Here is what I found about the bicycle.");
		expect(cleaned).not.toContain("query");
		expect(cleaned).not.toContain("```json");
	});

	it("strips multiple consecutive markdown tool call blocks", () => {
		const cleaned = stripLeakedToolDiagnostics(
			[
				"Here are my searches:",
				"",
				"```json",
				'{"query": "first search", "mode": "quick"}',
				"```",
				"",
				"```json",
				'{"query": "second search", "mode": "exact", "freshness": "live"}',
				"```",
				"",
				"Based on the results, here is the answer.",
			].join("\n"),
		);
		expect(cleaned).toBe(
			[
				"Here are my searches:",
				"",
				"",
				"",
				"Based on the results, here is the answer.",
			].join("\n"),
		);
	});

	it("keeps legitimate markdown code blocks that are not tool calls", () => {
		const codeBlock = [
			"Here is a valid JSON example:",
			"",
			"```json",
			'{"name": "Alice", "age": 30}',
			"```",
		].join("\n");
		expect(stripLeakedToolDiagnostics(codeBlock)).toBe(codeBlock);
	});

	it("keeps markdown blocks with only one tool-like key", () => {
		const codeBlock = [
			"Query example:",
			"",
			"```json",
			'{"query": "example search"}',
			"```",
		].join("\n");
		expect(stripLeakedToolDiagnostics(codeBlock)).toBe(codeBlock);
	});

	it("detects partial markdown tool call blocks for streaming buffers", () => {
		expect(
			getLeakedToolDiagnosticPrefixLength(
				'Before text \n```json\n{"query": "test", "mode": "',
			),
		).toBe(37);
	});

	it("does not hold ordinary markdown code blocks as leaked prefixes", () => {
		expect(
			getLeakedToolDiagnosticPrefixLength('Here is code:\n```json\n{"a": 1}'),
		).toBe(0);
	});
});

// The cleanup of leaked tool output guesses at the START of a run of reply text.
// Asked of the rest of an answer, a sentence that reads like a narration began a
// hold-back that swallowed the table, the prices and the links after it (the
// owner's live test of "Ask me first", 2026-11-05).
describe("leaked tool output: the start of a run of reply text", () => {
	const middle = [
		"I found three options on the site.",
		"",
		"| Plan | Price |",
		"|------|-------|",
		"| Escape room | EUR 22 |",
	].join("\n");

	it("holds back what follows a narration on the very next line", () => {
		const state = createLeakedToolDiagnosticsState();
		expect(
			stripLeakedToolDiagnostics(
				"Let me search for that.\nSome page title\nHome\nLogin",
				state,
			),
		).toBe("");
		expect(state.suppressWebToolOutput).toBe(true);
	});

	it("keeps the answer that follows a narration after a paragraph break", () => {
		expect(
			stripLeakedToolDiagnostics(
				"Let me search for that.\n\nThe capital of Italy is Rome.",
			),
		).toBe("The capital of Italy is Rome.");
		const state = createLeakedToolDiagnosticsState();
		expect(stripLeakedToolDiagnostics(middle, state)).toBe(
			middle.replace("I found three options on the site.\n\n", ""),
		);
		expect(state.suppressWebToolOutput).toBe(false);
	});

	it("leaves the same sentence alone once an answer has begun", () => {
		const state = createLeakedToolDiagnosticsState();
		expect(stripLeakedToolDiagnostics(middle, state, { leading: false })).toBe(
			middle,
		);
		expect(state.suppressWebToolOutput).toBe(false);
	});

	it("reads a marker that says what it is wherever it stands", () => {
		const state = createLeakedToolDiagnosticsState();
		expect(
			stripLeakedToolDiagnostics(
				"The answer starts here. Found 8 sources and 16 evidence snippets\n\nThen the rest.",
				state,
				{ leading: false },
			),
		).toBe("The answer starts here.\n\nThen the rest.");
	});

	it("does not take 'search results:' in a sentence for a leaked header once an answer has begun", () => {
		const answer = [
			"Based on the search results:",
			"",
			"| Plan | Price |",
			"|------|-------|",
			"| Escape room | EUR 22 |",
			"",
			"Then the rest.",
		].join("\n");
		const state = createLeakedToolDiagnosticsState();
		expect(stripLeakedToolDiagnostics(answer, state, { leading: false })).toBe(
			answer,
		);
		expect(state.suppressWebToolOutput).toBe(false);
		// At the start of a run it is still where a leak puts its header.
		expect(
			stripLeakedToolDiagnostics(
				"Search results:\n1. title: Foo\nurl: https://x.test/a\nThe answer is Foo.",
			),
		).toBe("The answer is Foo.");
	});

	it("counts a narration without its full stop as complete only when the text is final", () => {
		expect(stripLeakedToolDiagnostics("Let me search")).toBe("Let me search");
		expect(
			stripLeakedToolDiagnostics("Let me search", undefined, { final: true }),
		).toBe("");
		expect(stripLeakedToolDiagnostics("Ki", undefined, { final: true })).toBe(
			"Ki",
		);
	});

	it("hands back a narration nothing follows yet, to be judged with what comes next", () => {
		const state = createLeakedToolDiagnosticsState();
		expect(
			stripLeakedToolDiagnostics(
				"Now I have the data. Let me pull it together.",
				state,
			),
		).toBe("Let me pull it together.");
		expect(state.suppressWebToolOutput).toBe(false);
	});

	it("holds the first letters of a narration only at the start of a run", () => {
		expect(getLeakedToolDiagnosticPrefixLength("Rome")).toBe("me".length);
		expect(
			getLeakedToolDiagnosticPrefixLength("Rome", { leading: false }),
		).toBe(0);
		expect(getLeakedToolDiagnosticPrefixLength("No", { leading: false })).toBe(
			0,
		);
		expect(
			getLeakedToolDiagnosticPrefixLength("Search resu", { leading: false }),
		).toBe(0);
		expect(getLeakedToolDiagnosticPrefixLength("Search resu")).toBe(
			"Search resu".length,
		);
		expect(
			getLeakedToolDiagnosticPrefixLength("fetch_content out", {
				leading: false,
			}),
		).toBe("fetch_content out".length);
	});

	it("ends the hold-back a narration began when a tool call ends the run", () => {
		const state = createLeakedToolDiagnosticsState();
		state.suppressPythonToolOutput = true;
		stripLeakedToolDiagnostics("Let me search for it.", state, { final: true });
		expect(state.suppressWebToolOutput).toBe(true);
		resetLeakedToolDiagnosticsForNewTextRun(state);
		expect(state.suppressWebToolOutput).toBe(false);
		expect(state.suppressPythonToolOutput).toBe(false);
		expect(
			stripLeakedToolDiagnostics(
				"Sunday evening in Limerick, with a group.",
				state,
			),
		).toBe("Sunday evening in Limerick, with a group.");
	});

	it("does not take an answer that opens with a sentence for a block of raw results, however many links it lists", () => {
		const answer = [
			"Sunday evening in Limerick with a group and an activity as the anchor.",
			"",
			"1. Escape room - EUR 22 pp - https://www.example.ie/escape-limerick",
			"2. Dinner at the Milk Market - EUR 30 pp - https://www.example.ie/menu",
			"3. Castletroy Park Hotel - EUR 140 a night - https://www.example.ie/castletroy",
			"4. Savoy Hotel Limerick - EUR 120 a night - https://www.example.ie/savoy",
			"5. Bus back to Dublin - EUR 15 - https://www.example.ie/bus",
		].join("\n");
		expect(stripLeakedToolDiagnostics(answer)).toBe(answer);
	});

	it("does not take a list of links for a block of raw results", () => {
		const answer = [
			"**Friday**",
			"- 18:00 Check in at the Castletroy Park Hotel - https://www.example.ie/castletroy",
			"- 20:00 Dinner at the Milk Market - https://www.example.ie/menu",
			"**Saturday**",
			"- 10:00 Cliffs of Moher tour - EUR 35 - https://www.example.ie/cliffs",
			"- 19:00 Escape room - EUR 22 - https://www.example.ie/escape",
		].join("\n");
		expect(stripLeakedToolDiagnostics(answer)).toBe(answer);
	});
});

// What counts as an answer on screen. Staging, 2026-11-10: Kimi and DeepSeek each
// "answered" a recovery request with one zero-width space, which `trim()` keeps and
// which the person sees as nothing.
describe("hasVisibleCharacter", () => {
	it("is false for no text and for text that is only whitespace", () => {
		expect(hasVisibleCharacter("")).toBe(false);
		expect(hasVisibleCharacter("   ")).toBe(false);
		expect(hasVisibleCharacter("\n\n\t \r\n")).toBe(false);
		// a no-break space and a line separator are whitespace too
		expect(hasVisibleCharacter("\u00A0\u2028\u3000")).toBe(false);
	});

	it.each([
		["a zero-width space", "\u200B"],
		["a zero-width non-joiner", "\u200C"],
		["a zero-width joiner", "\u200D"],
		["a word joiner", "\u2060"],
		["a byte order mark", "\uFEFF"],
		["all of them among whitespace", " \u200B\n\u200C\u200D\t\u2060\uFEFF "],
	])("is false for %s alone", (_name, text) => {
		expect(hasVisibleCharacter(text)).toBe(false);
	});

	it("is true as soon as one character can be seen", () => {
		expect(hasVisibleCharacter("a")).toBe(true);
		expect(hasVisibleCharacter("42")).toBe(true);
		expect(hasVisibleCharacter(".")).toBe(true);
		expect(hasVisibleCharacter("Árvíztűrő tükörfúrógép")).toBe(true);
		expect(hasVisibleCharacter("\u200B\u200B x \u200B")).toBe(true);
		expect(hasVisibleCharacter("\n\n\u200BThe total is 42.")).toBe(true);
	});

	it("sees a character outside the basic plane", () => {
		expect(hasVisibleCharacter("\u200B\u{1F600}")).toBe(true);
		expect(hasVisibleCharacter("\u{20BB7}")).toBe(true);
	});
});

// Explicit control syntax only: DeepSeek's markup token and a complete Hermes-style
// block (what Qwen writes) whose body is a JSON object with a string `name`.
// Never a rule on words, length or punctuation, and never text that Markdown draws
// as code (review 2, finding 2.8).
describe("containsToolCallMarkup", () => {
	const call = '{"name": "research_web", "arguments": {"query": "height"}}';
	const block = `<tool_call>\n${call}\n</tool_call>`;

	it.each([
		[
			"DeepSeek's token",
			'<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="x">',
		],
		[
			"DeepSeek's token after a visible preface",
			"I will verify that.\n\n<｜｜DSML｜｜ calls>",
		],
		["a Hermes-style block", block],
		[
			"a Hermes-style block after a visible preface",
			`Let me look that up.\n${block}`,
		],
		["a Hermes-style block on one line", `<tool_call>${call}</tool_call>`],
		["a Hermes-style block with CRLF line ends", block.replace(/\n/g, "\r\n")],
		[
			"a Hermes-style block with a nested object",
			'<tool_call>{"name":"f","arguments":{"a":{"b":[1,{"c":"</tool"}]}}}</tool_call>',
		],
		["two Hermes-style blocks", `${block}\n${block}`],
		[
			"a block that follows a prose mention of the tag",
			`The <tool_call> tag wraps a JSON object.\n${block}`,
		],
		[
			"a block that follows a closed code fence that showed one",
			`Format:\n\`\`\`\n${block}\n\`\`\`\nNow:\n${block}`,
		],
	])("recognises %s", (_name, text) => {
		expect(containsToolCallMarkup(text)).toBe(true);
	});

	it.each([
		["nothing", ""],
		["an ordinary answer", "Paris is the capital of France."],
		[
			"the tag mentioned in prose",
			"Qwen models wrap each call in a <tool_call> tag.",
		],
		[
			"both tags mentioned in prose",
			"Open it with <tool_call> and close it with </tool_call>.",
		],
		["the tags around words", "<tool_call>look it up</tool_call>"],
		[
			"a block that is not finished",
			`Let me look that up.\n<tool_call>\n${call}`,
		],
		[
			"a body that is not JSON",
			'<tool_call>{"name": "research_web", </tool_call>',
		],
		[
			"a body that is not an object",
			'<tool_call>[{"name": "research_web"}]</tool_call>',
		],
		["a body with no name", '<tool_call>{"tool": "research_web"}</tool_call>'],
		["a body whose name is not a string", '<tool_call>{"name": 7}</tool_call>'],
		["an empty body", "<tool_call>\n</tool_call>"],
		["a JSON-first answer", '{"name": "Alice", "age": 30}'],
		[
			"a JSON answer in a fence",
			'```json\n{"name": "Alice", "arguments": {}}\n```',
		],
		[
			"a prose mention of DeepSeek's token in a fence",
			"```\n<｜｜DSML｜｜ calls>\n```",
		],
	])("keeps %s as an answer", (_name, text) => {
		expect(containsToolCallMarkup(text)).toBe(false);
	});

	it.each([
		[
			"a backtick fence",
			`Here is the format:\n\`\`\`xml\n${block}\n\`\`\`\nThat is all.`,
		],
		["a fence with no info string", `\`\`\`\n${block}\n\`\`\``],
		["a tilde fence", `~~~\n${block}\n~~~`],
		[
			"a fence in a list item",
			`1. Send:\n    \`\`\`\n    ${block.replace(/\n/g, "\n    ")}\n    \`\`\`\n`,
		],
		[
			"a fence in a quote",
			"> Its calls start with:\n> ```\n> <｜｜DSML｜｜ calls>\n> ```",
		],
		[
			"a longer fence around a shorter one",
			`\`\`\`\`md\n\`\`\`\n${block}\n\`\`\`\n\`\`\`\``,
		],
		["a fence that is never closed", `Format:\n\`\`\`\n${block}`],
		[
			"DeepSeek's token",
			"Its calls start with:\n```\n<｜｜DSML｜｜ calls>\n```\nand end with a closing tag.",
		],
	])("ignores what %s shows", (_name, text) => {
		expect(containsToolCallMarkup(text)).toBe(false);
	});

	it("does not join the two sides of a fence into one block", () => {
		expect(
			containsToolCallMarkup(
				`<tool_call>\n\`\`\`\nnote\n\`\`\`\n${call}\n</tool_call>`,
			),
		).toBe(false);
	});

	it("still recognises markup that follows a fence the reply left open and then closed", () => {
		expect(containsToolCallMarkup(`\`\`\`\nnote\n\`\`\`\n${block}`)).toBe(true);
	});

	it("takes a closing line only of the same fence character, at least as long, with nothing after it", () => {
		// ``` is not closed by ~~~, by `` or by ```js: the block stays code to the end.
		for (const closer of ["~~~", "``", "```js"]) {
			expect(
				containsToolCallMarkup(`\`\`\`\n${closer}\n${block}`),
				closer,
			).toBe(false);
		}
	});
});

describe("startsWithToolCallMarkup", () => {
	it.each([
		"<｜｜DSML｜｜ calls>",
		"\u200B\n<｜｜DSML｜｜ calls>",
	])("recognises evidenced opener %j", (text) => {
		expect(startsWithToolCallMarkup(text)).toBe(true);
	});
	it.each([
		'```json\n{"query":"test","mode":"quick"}\n```',
		'```\n{"query":"test","mode":"quick"}',
		"The research_web tool found it.",
		"Mention <｜｜DSML｜｜ calls> in prose.",
		'```json\n{"name":"Alice","age":30}\n```',
		'```json\n{"query":"example"}\n```',
		"```ts\nconst tool_calls = [];\n```",
	])("retains prose and ordinary code %j", (text) => {
		expect(startsWithToolCallMarkup(text)).toBe(false);
	});
});
