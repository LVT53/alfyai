import { describe, expect, it } from "vitest";

import {
	buildHistoryModelMessages,
	buildHistoryToolDigest,
	type HistoryTurn,
	historyToolCallId,
	renderHistoryAsText,
	renderHistoryTurn,
} from "./conversation-history";

const estimate = (text: string) => Math.ceil(text.length / 4);

function turn(
	user: string,
	assistant?: Partial<HistoryTurn["messages"][number]> & { content: string },
): HistoryTurn {
	return {
		messages: [
			{ id: `u-${user.slice(0, 6)}`, role: "user", content: user },
			...(assistant
				? [
						{
							id: `a-${user.slice(0, 6)}`,
							role: "assistant" as const,
							...assistant,
						},
					]
				: []),
		],
	};
}

describe("renderHistoryTurn", () => {
	it("renders a plain text exchange as user and assistant messages", () => {
		const out = renderHistoryTurn(turn("Hi", { content: "Hello!" }), "native");
		expect(out).toEqual([
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: "Hello!" },
		]);
	});

	it("emits tool-call parts and a paired tool message for tool turns", () => {
		const out = renderHistoryTurn(
			turn("Weather in Cork?", {
				content: "It is 15°C.",
				thinkingSegments: [
					{ type: "text", content: "thinking…" },
					{
						type: "tool_call",
						callId: "call_1",
						name: "research_web",
						input: { query: "Cork weather" },
						status: "done",
						outputSummary: "Web research returned 2 sources.",
						resultDigest: "Cork: 15°C, light rain.",
						candidates: [
							{
								id: "s1",
								title: "Met Éireann",
								url: "https://met.ie",
								sourceType: "web",
							},
						],
					},
				],
			}),
			"native",
		);
		expect(out).toHaveLength(3);
		expect(out[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "It is 15°C." },
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "research_web",
					input: { query: "Cork weather" },
				},
			],
		});
		expect(out[2]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_1",
					toolName: "research_web",
					output: {
						type: "json",
						value: {
							ok: true,
							summary: "Web research returned 2 sources.",
							detail: "Cork: 15°C, light rain.",
							sources: [{ title: "Met Éireann", url: "https://met.ie" }],
						},
					},
				},
			],
		});
	});

	it("never replays reasoning text segments", () => {
		const out = renderHistoryTurn(
			turn("q", {
				content: "answer",
				thinkingSegments: [{ type: "text", content: "private reasoning" }],
			}),
			"native",
		);
		expect(JSON.stringify(out)).not.toContain("private reasoning");
	});

	it("pairs interrupted or failed calls with a synthesized failed result", () => {
		const out = renderHistoryTurn(
			turn("q", {
				content: "",
				thinkingSegments: [
					{
						type: "tool_call",
						name: "fetch_url",
						input: { urls: ["x"] },
						status: "running",
					},
					{
						type: "tool_call",
						name: "map_route",
						input: { action: "route" },
						status: "failed",
						outputSummary: "Routing failed: timeout",
					},
				],
			}),
			"native",
		);
		const toolMessage = out[2];
		if (toolMessage.role !== "tool") throw new Error("expected tool message");
		expect(toolMessage.content).toHaveLength(2);
		const outputs = toolMessage.content.map((part) =>
			part.type === "tool-result" ? part.output : null,
		);
		expect(outputs[0]).toEqual({
			type: "json",
			value: {
				ok: false,
				summary: "The tool call was interrupted before it completed.",
			},
		});
		expect(outputs[1]).toEqual({
			type: "json",
			value: { ok: false, summary: "Routing failed: timeout" },
		});
		// Assistant text was empty but the calls still produce an assistant part list.
		expect(out[1].role).toBe("assistant");
	});

	it("derives deterministic ids from the tool_call subsequence when callId is missing", () => {
		const message = {
			id: "m1",
			role: "assistant" as const,
			content: "",
			thinkingSegments: [
				{ type: "text" as const, content: "r" },
				{
					type: "tool_call" as const,
					name: "a",
					input: {},
					status: "done" as const,
				},
				{
					type: "status" as const,
					id: "s",
					label: "x",
					status: "done" as const,
				},
				{
					type: "tool_call" as const,
					name: "b",
					input: {},
					status: "done" as const,
				},
			],
		};
		const calls = message.thinkingSegments.filter(
			(s) => s.type === "tool_call",
		);
		expect(historyToolCallId(message, calls[0] as never, 0)).toBe("hist_m1_0");
		expect(historyToolCallId(message, calls[1] as never, 1)).toBe("hist_m1_1");
		const out = renderHistoryTurn({ messages: [message] }, "native");
		const assistant = out[0];
		if (
			assistant.role !== "assistant" ||
			typeof assistant.content === "string"
		) {
			throw new Error("expected assistant parts");
		}
		expect(
			assistant.content.map((p) =>
				p.type === "tool-call" ? p.toolCallId : null,
			),
		).toEqual(["hist_m1_0", "hist_m1_1"]);
	});

	it("flattens tool activity into assistant text in flatten mode", () => {
		const out = renderHistoryTurn(
			turn("q", {
				content: "Done.",
				thinkingSegments: [
					{
						type: "tool_call",
						name: "research_web",
						input: {},
						status: "done",
						outputSummary: "Web research returned 1 source.",
					},
				],
			}),
			"flatten",
		);
		expect(out).toEqual([
			{ role: "user", content: "q" },
			{
				role: "assistant",
				content: "[used research_web: Web research returned 1 source.]\nDone.",
			},
		]);
	});

	it("appends attachment names and provenance prefixes to user turns and skips empty assistant rows", () => {
		const out = renderHistoryTurn(
			{
				messages: [
					{
						role: "user",
						content: "Summarize this",
						attachments: [{ name: "brief.pdf" }],
						contentPrefix: "[Inherited copied turn]",
					},
					{ role: "assistant", content: "   " },
				],
			},
			"native",
		);
		expect(out).toEqual([
			{
				role: "user",
				content:
					"[Inherited copied turn]\nSummarize this\n[attachment: brief.pdf]",
			},
		]);
	});
});

describe("buildHistoryModelMessages", () => {
	it("keeps whole turns newest-first within the budget and always keeps the newest", () => {
		const turns = [
			turn("first ".repeat(40), { content: "one ".repeat(40) }),
			turn("second ".repeat(40), { content: "two ".repeat(40) }),
			turn("third", { content: "three" }),
		];
		const result = buildHistoryModelMessages({
			turns,
			maxTokens: 150,
			toolMessages: "native",
			estimateTokens: estimate,
		});
		expect(result.includedTurnCount).toBe(2);
		expect(result.omittedTurnCount).toBe(1);
		expect(result.messages[0]).toEqual({
			role: "user",
			content: "second ".repeat(40).trim(),
		});
		expect(result.messages.at(-1)).toEqual({
			role: "assistant",
			content: "three",
		});
		const tiny = buildHistoryModelMessages({
			turns,
			maxTokens: 1,
			toolMessages: "native",
			estimateTokens: estimate,
		});
		expect(tiny.includedTurnCount).toBe(1);
		expect(tiny.messages).toEqual([
			{ role: "user", content: "third" },
			{ role: "assistant", content: "three" },
		]);
	});

	it("is byte-stable: the same stored rows render to the same messages every time", () => {
		const turns = [turn("a", { content: "b" }), turn("c", { content: "d" })];
		const first = buildHistoryModelMessages({
			turns,
			maxTokens: 1000,
			toolMessages: "native",
			estimateTokens: estimate,
		});
		const second = buildHistoryModelMessages({
			turns,
			maxTokens: 1000,
			toolMessages: "native",
			estimateTokens: estimate,
		});
		expect(JSON.stringify(first.messages)).toBe(
			JSON.stringify(second.messages),
		);
		// Adding a newer turn only appends; the earlier prefix is unchanged.
		const extended = buildHistoryModelMessages({
			turns: [...turns, turn("e", { content: "f" })],
			maxTokens: 1000,
			toolMessages: "native",
			estimateTokens: estimate,
		});
		expect(
			JSON.stringify(extended.messages.slice(0, first.messages.length)),
		).toBe(JSON.stringify(first.messages));
	});
});

describe("digest and text rendering", () => {
	it("builds a compact digest from legacy rows without resultDigest", () => {
		expect(
			buildHistoryToolDigest({
				status: "done",
				outputSummary: "Found 3 events.",
				candidates: [{ id: "c", title: "Standup", sourceType: "tool" }],
			}),
		).toEqual({
			ok: true,
			summary: "Found 3 events.",
			sources: [{ title: "Standup" }],
		});
	});

	it("renders history as flat text for control calls", () => {
		const text = renderHistoryAsText(
			renderHistoryTurn(
				turn("q", {
					content: "a",
					thinkingSegments: [
						{
							type: "tool_call",
							callId: "c1",
							name: "t",
							input: { x: 1 },
							status: "done",
							outputSummary: "ok",
						},
					],
				}),
				"native",
			),
		);
		expect(text).toContain("USER: q");
		expect(text).toContain("ASSISTANT: a");
		expect(text).toContain("TOOL RESULT:");
	});
});
