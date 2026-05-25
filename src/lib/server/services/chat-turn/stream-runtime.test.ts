import { describe, expect, it } from "vitest";
import {
	classifyStreamError,
	createServerChunkRuntime,
	extractAssistantChunk,
	extractErrorMessage,
} from "./stream";

function tokenTexts(chunks: string[]): string[] {
	return chunks
		.filter((chunk) => chunk.startsWith("event: token"))
		.map((chunk) => JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? "{}").text);
}

function thinkingTexts(chunks: string[]): string[] {
	return chunks
		.filter((chunk) => chunk.startsWith("event: thinking"))
		.map((chunk) => JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? "{}").text);
}

describe("createServerChunkRuntime", () => {
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

		expect(
			chunks.filter((chunk) => chunk.startsWith("event: tool_call")),
		).toHaveLength(2);
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

		expect(
			chunks.filter((chunk) => chunk.startsWith("event: tool_call")),
		).toHaveLength(2);
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

		expect(
			chunks.filter((chunk) => chunk.startsWith("event: tool_call")),
		).toHaveLength(2);
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

		expect(
			chunks.filter((chunk) => chunk.startsWith("event: tool_call")),
		).toHaveLength(2);
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

describe("extractAssistantChunk", () => {
	it("does not expose token text from tool senders as assistant output", () => {
		expect(
			extractAssistantChunk("token", {
				sender: "Search",
				text: "Raw fetched page text should stay in the tool channel.",
			}),
		).toBe("");
		expect(
			extractAssistantChunk("token", {
				data: {
					sender_name: "Tool",
					text: "Raw tool result",
				},
			}),
		).toBe("");
	});
});

describe("stream error extraction", () => {
	it("keeps nested Langflow API connection diagnostics instead of only Code: None", () => {
		const message = extractErrorMessage({
			text_key: "text",
			data: {
				text: "Code: None\n",
				content_blocks: [
					{
						title: "Error",
						contents: [
							{
								reason: "**APIConnectionError**\n - **Code: None**\n",
								traceback:
									"Traceback...\nhttpcore connect_tcp failed: All connection attempts failed",
							},
						],
					},
				],
			},
		});

		expect(message).toContain("Code: None");
		expect(message).toContain("APIConnectionError");
		expect(message).toContain("connect_tcp");
		expect(classifyStreamError(message)).toBe("network");
	});
});
