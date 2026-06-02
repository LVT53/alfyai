import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { describe, expect, it } from "vitest";
import {
	aiSdkUiStreamContractSequence,
	encodeAiSdkUiFixtureFrames,
	malformedAiSdkUiStreamFrames,
	oldBrowserSseNamedEndEvent,
	oldBrowserSseNamedTokenEvent,
} from "../../../../../tests/fixtures/ai-sdk-ui-stream-contract";
import {
	createServerChunkRuntime,
	createUiMessageStreamDoneFrame,
	decodeUiMessageStreamParts,
	encodeUiMessageStreamPart,
} from "./stream";

describe("stream helper retirement", () => {
	it("does not expose retired upstream stream parser helpers through the stream facade", async () => {
		const streamFacade = await readFile(
			join(process.cwd(), "src/lib/server/services/chat-turn/stream.ts"),
			"utf8",
		);

		expect(streamFacade).not.toMatch(
			/\b(parseUpstreamEvents|parseEventBlock|parseJsonBlock|parseSseBlock|parseMaybeJson|extractAssistantChunk|toIncrementalChunk|extractErrorMessage)\b/,
		);
	});
});

describe("AI SDK UI stream contract fixture", () => {
	it("round-trips the allowed fixture grammar through the app-owned server encoder", () => {
		const encodedByServer = aiSdkUiStreamContractSequence.map((payload) =>
			payload === "[DONE]"
				? createUiMessageStreamDoneFrame()
				: encodeUiMessageStreamPart(
						payload as Parameters<typeof encodeUiMessageStreamPart>[0],
					),
		);

		expect(encodedByServer).toEqual(
			encodeAiSdkUiFixtureFrames(aiSdkUiStreamContractSequence),
		);
		expect(decodeUiMessageStreamParts(encodedByServer.join(""))).toEqual(
			aiSdkUiStreamContractSequence,
		);
	});

	it("ignores malformed frames and old Browser SSE named events", () => {
		const decoded = decodeUiMessageStreamParts(
			[
				...malformedAiSdkUiStreamFrames,
				oldBrowserSseNamedTokenEvent,
				oldBrowserSseNamedEndEvent,
				createUiMessageStreamDoneFrame(),
			].join(""),
		);

		expect(decoded).toEqual(["[DONE]"]);
	});
});

function eventData(chunks: string[], eventName: string): unknown[] {
	return chunks
		.flatMap((chunk) => decodeUiMessageStreamParts(chunk))
		.filter((event) => event !== "[DONE]" && event.type === eventName)
		.map((event) => ("data" in event ? event.data : event));
}

function tokenTexts(chunks: string[]): string[] {
	return eventData(chunks, "text-delta").map((data) =>
		typeof data === "object" && data !== null && "delta" in data
			? String((data as { delta?: unknown }).delta ?? "")
			: "",
	);
}

function thinkingTexts(chunks: string[]): string[] {
	return eventData(chunks, "reasoning-delta").map((data) =>
		typeof data === "object" && data !== null && "delta" in data
			? String((data as { delta?: unknown }).delta ?? "")
			: "",
	);
}

function toolCallEvents(chunks: string[]): unknown[] {
	return eventData(chunks, "data-tool-call");
}

describe("createServerChunkRuntime", () => {
	it("keeps the app-owned encoder compatible with installed AI SDK UI stream framing", async () => {
		const stream = createUIMessageStream({
			execute({ writer }) {
				writer.write({ type: "text-start", id: "answer" });
				writer.write({ type: "text-delta", id: "answer", delta: "Hi" });
				writer.write({
					type: "data-stream-metadata",
					data: { responseTokenCount: 1 },
					transient: true,
				});
				writer.write({ type: "finish", finishReason: "stop" });
			},
		});
		const response = createUIMessageStreamResponse({ stream });
		const body = await response.text();

		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		expect(body).toContain(
			encodeUiMessageStreamPart({ type: "text-start", id: "answer" }),
		);
		expect(body).toContain(
			encodeUiMessageStreamPart({
				type: "text-delta",
				id: "answer",
				delta: "Hi",
			}),
		);
		expect(body).toContain(
			encodeUiMessageStreamPart({
				type: "data-stream-metadata",
				data: { responseTokenCount: 1 },
				transient: true,
			}),
		);
		expect(body).toContain(
			encodeUiMessageStreamPart({
				type: "finish",
				finishReason: "stop",
			}),
		);
		expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	it("does not emit a split DeepSeek response marker before a thinking preamble", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
			thinkingBatchMin: 1,
		});

		runtime.emitChunkWithOutputHandling("response Th");
		expect(chunks).toEqual([]);

		runtime.emitChunkWithOutputHandling(
			"e user is asking me to write 500 words about the USA. This is a straightforward content request.\n\n",
		);
		runtime.emitChunkWithOutputHandling(
			"The United States is a large and diverse country.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"The United States is a large and diverse country.",
		);
		expect(thinkingTexts(chunks).join("")).toContain(
			"The user is asking me to write 500 words about the USA.",
		);
		expect(tokenTexts(chunks).join("")).not.toContain("response");
	});

	it("strips a DeepSeek response marker glued to an inline thinking tag", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
			thinkingBatchMin: 1,
		});

		runtime.emitChunkWithOutputHandling("response<");
		expect(chunks).toEqual([]);

		runtime.emitChunkWithOutputHandling(
			"think>The model is planning.</think>The visible answer.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("The visible answer.");
		expect(thinkingTexts(chunks).join("")).toBe("The model is planning.");
		expect(tokenTexts(chunks).join("")).not.toContain("response");
	});

	it("strips leaked web research diagnostics from visible tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Qudelix alternatives");
		runtime.emitChunkWithOutputHandling("Found 8 source(s)");
		runtime.emitChunkWithOutputHandling(
			" and 16 evidence snippet(s)\n\nThe answer starts here.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"Qudelix alternatives\n\nThe answer starts here.",
		);
	});

	it("strips split leading web-search narration before visible answer tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Friss adatokat keresek");
		runtime.emitChunkWithOutputHandling(
			" a vonóhorgos kerékpárszállító szabályairól.",
		);
		runtime.emitChunkWithOutputHandling(
			"1. A szürke rendszám kormányablaknál igényelhető.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"1. A szürke rendszám kormányablaknál igényelhető.",
		);
		expect(runtime.fullResponse).not.toContain("Friss adatokat keresek");
	});

	it("strips split standalone Hungarian web-planning narration before visible answer tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Ki");
		runtime.emitChunkWithOutputHandling("ker");
		runtime.emitChunkWithOutputHandling("esem");
		runtime.emitChunkWithOutputHandling(
			" a vonóhorgos kerékpárszállító rendszámtáblával kapcsolatos aktuális magyar szabályokat.",
		);
		runtime.emitChunkWithOutputHandling(
			"Ha a vonóhorgos kerékpárszállító eltakarja az autó rendszámát, külön rendszámtáblát kell felszerelni a tartóra.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"Ha a vonóhorgos kerékpárszállító eltakarja az autó rendszámát, külön rendszámtáblát kell felszerelni a tartóra.",
		);
		expect(runtime.fullResponse).not.toContain("Kikeresem");
	});

	it("drops unresolved short web-planning prefixes at stream flush", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Ki");
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("");
		expect(runtime.fullResponse).toBe("");
	});

	it("holds unresolved short web-planning prefixes with trailing whitespace", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Ki\n\n");
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("");
		expect(runtime.fullResponse).toBe("");
	});

	it("holds one-character starts of web-planning prefixes", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("K");
		runtime.emitChunkWithOutputHandling("i\n\n");
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("");
		expect(runtime.fullResponse).toBe("");
	});

	it("strips streamed file-production repair narration and pretty-printed document-source JSON", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling(
			"Let me fix the JSON formatting for the document source.\n",
		);
		runtime.emitChunkWithOutputHandling("{\n");
		runtime.emitChunkWithOutputHandling('  "version": 1,\n');
		runtime.emitChunkWithOutputHandling(
			'  "template": "alfyai_standard_report",\n',
		);
		runtime.emitChunkWithOutputHandling('  "title": "Project summary",\n');
		runtime.emitChunkWithOutputHandling('  "blocks": [\n');
		runtime.emitChunkWithOutputHandling(
			'    {"type": "paragraph", "text": "Actionable takeaways from past work in this folder:"},\n',
		);
		runtime.emitChunkWithOutputHandling('    {"type": "list", "items": [\n');
		runtime.emitChunkWithOutputHandling(
			'      "Disk - Schedule recurring docker system prune",\n',
		);
		runtime.emitChunkWithOutputHandling(
			'      "Memory - Keep Honcho snapshots separate"\n',
		);
		runtime.emitChunkWithOutputHandling("    ]}\n");
		runtime.emitChunkWithOutputHandling("  ]\n");
		runtime.emitChunkWithOutputHandling("}\n");
		runtime.emitChunkWithOutputHandling("Your PDF is being generated now.");
		runtime.flushInlineThinkingBuffer();

		const visible = tokenTexts(chunks).join("");
		expect(visible).toBe("Your PDF is being generated now.");
		expect(runtime.fullResponse).toBe("Your PDF is being generated now.");
		expect(visible).not.toContain("Let me fix");
		expect(visible).not.toContain("Actionable takeaways");
		expect(visible).not.toContain("Disk - Schedule");
		expect(visible).not.toContain('"blocks"');
	});

	it("strips leaked raw web research result blocks from visible tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Qudelix alternatives");
		runtime.emitChunkWithOutputHandling("Found 8 source(s)");
		runtime.emitChunkWithOutputHandling(
			[
				" and 16 evidence snippet(s)",
				"1. title: Qudelix product page",
				"url: https://example.com/qudelix",
				"evidence: Raw search snippets are tool output.",
				"Based on the sources, the Qudelix 5K is the direct comparison point.",
			].join("\n"),
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			[
				"Qudelix alternatives",
				"Based on the sources, the Qudelix 5K is the direct comparison point.",
			].join("\n"),
		);
	});

	it("holds and strips split standalone fetched web page dumps", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Anvil Arrow - Star Citizen Wiki\n");
		runtime.emitChunkWithOutputHandling("Toggle search\nSearch\nToggle menu\n");
		runtime.emitChunkWithOutputHandling(
			[
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
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("");
		expect(runtime.fullResponse).toBe("");
	});

	it("strips split bare source reference markers from visible tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("The newer model");
		runtime.emitChunkWithOutputHandling(" 【S");
		runtime.emitChunkWithOutputHandling("5】 was released recently.");
		runtime.emitChunkWithOutputHandling(
			"\n\nSources:\n- [Official release notes](https://example.com/release)",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"The newer model was released recently.\n\nSources:\n- [Official release notes](https://example.com/release)",
		);
		expect(runtime.fullResponse).not.toContain("【S5】");
	});

	it("strips leaked Python REPL transcripts from visible tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("run_python_");
		runtime.emitChunkWithOutputHandling("repl: import subprocess\n");
		runtime.emitChunkWithOutputHandling(
			"Successfully imported modules: ['math', 'pandas']Code execution completed successfully=== DISK OVERVIEW ===\n",
		);
		runtime.emitChunkWithOutputHandling(
			"Filesystem Size Used Avail Use% Mounted on\noverlay 200G 131G 70G 66% /\nnot found\n",
		);
		runtime.emitChunkWithOutputHandling(
			"MISSING: /run/containerd/containerd.sockI see the root filesystem is 66% used.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"I see the root filesystem is 66% used.",
		);
	});

	it("strips complete Skill Control Envelope blocks from visible stream tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Question?\n<skill_control");
		runtime.emitChunkWithOutputHandling(
			'_v1>{"version":1,"operations":[{"operationId":"op-1","kind":"session_transition","transition":"awaiting_user"}]}</skill_control_v1>',
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("Question?\n");
		expect(runtime.fullResponse).toBe("Question?\n");
		expect(runtime.skillControlEnvelopePayloads).toEqual([
			'{"version":1,"operations":[{"operationId":"op-1","kind":"session_transition","transition":"awaiting_user"}]}',
		]);
	});

	it("keeps file-production tool calls out of persisted thinking segments", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitToolCallEvent(
			"produce_file",
			{ requestTitle: "Report" },
			"running",
		);
		runtime.emitToolCallEvent("produce_file", {}, "done");

		expect(toolCallEvents(chunks)).toHaveLength(2);
		expect(runtime.toolCallRecords).toEqual([
			expect.objectContaining({ name: "produce_file", status: "done" }),
		]);
		expect(runtime.serverSegments).toEqual([]);
	});

	it("coalesces duplicate tool starts by call id and completes that call", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitToolCallEvent(
			"research_web",
			{ query: "SvelteKit streaming docs" },
			"running",
			{ callId: "tool-call-1" },
		);
		runtime.emitToolCallEvent(
			"research_web",
			{ query: "SvelteKit streaming docs" },
			"running",
			{ callId: "tool-call-1" },
		);
		runtime.emitToolCallEvent("research_web", {}, "done", {
			callId: "tool-call-1",
			sourceType: "web",
			outputSummary: "Found sources",
		});

		expect(toolCallEvents(chunks)).toHaveLength(2);
		expect(runtime.toolCallRecords).toEqual([
			expect.objectContaining({
				callId: "tool-call-1",
				name: "research_web",
				status: "done",
				outputSummary: "Found sources",
			}),
		]);
		expect(runtime.serverSegments).toEqual([
			expect.objectContaining({
				callId: "tool-call-1",
				name: "research_web",
				status: "done",
			}),
		]);
	});

	it("aliases duplicate tool starts with different marker ids so either end completes immediately", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitToolCallEvent(
			"research_web",
			{ query: "SvelteKit streaming docs" },
			"running",
			{ callId: "langchain-run-1" },
		);
		runtime.emitToolCallEvent(
			"research_web",
			{ query: "SvelteKit streaming docs" },
			"running",
			{ callId: "native-marker-1" },
		);
		runtime.emitToolCallEvent("research_web", {}, "done", {
			callId: "native-marker-1",
			sourceType: "web",
			outputSummary: "Found sources",
		});
		runtime.emitToolCallEvent("research_web", {}, "done", {
			callId: "langchain-run-1",
			sourceType: "web",
			outputSummary: "Found sources",
		});

		expect(toolCallEvents(chunks)).toHaveLength(2);
		expect(runtime.toolCallRecords).toEqual([
			expect.objectContaining({
				callId: "langchain-run-1",
				name: "research_web",
				status: "done",
				outputSummary: "Found sources",
			}),
		]);
		expect(runtime.serverSegments).toEqual([
			expect.objectContaining({
				callId: "langchain-run-1",
				name: "research_web",
				status: "done",
				outputSummary: "Found sources",
			}),
		]);
	});

	it("suppresses delayed duplicate native markers after the callback marker completed", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitToolCallEvent(
			"research_web",
			{ query: "SvelteKit streaming docs" },
			"running",
			{ callId: "langchain-run-1" },
		);
		runtime.emitToolCallEvent("research_web", {}, "done", {
			callId: "langchain-run-1",
			sourceType: "web",
			outputSummary: "Found sources",
		});
		runtime.emitToolCallEvent(
			"research_web",
			{ query: "SvelteKit streaming docs" },
			"running",
			{ callId: "native-marker-1" },
		);
		runtime.emitToolCallEvent("research_web", {}, "done", {
			callId: "native-marker-1",
			sourceType: "web",
			outputSummary: "Found sources",
		});

		expect(toolCallEvents(chunks)).toHaveLength(2);
		expect(runtime.toolCallRecords).toEqual([
			expect.objectContaining({
				callId: "langchain-run-1",
				name: "research_web",
				status: "done",
				outputSummary: "Found sources",
			}),
		]);
		expect(runtime.serverSegments).toEqual([
			expect.objectContaining({
				callId: "langchain-run-1",
				name: "research_web",
				status: "done",
				outputSummary: "Found sources",
			}),
		]);
	});
});
