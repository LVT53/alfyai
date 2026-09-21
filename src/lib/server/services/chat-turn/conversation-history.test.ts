import { describe, expect, it } from "vitest";

import { produceFileModelInputSchema } from "$lib/server/services/normal-chat-tools/produce-file";
import {
	buildHistoryModelMessages,
	buildHistoryToolDigest,
	estimateHistoryMessagesTokens,
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

	// The live failure this pins: a model produced `tobacco-cost-breakdown.pdf`
	// in turn 1, was asked "what is in the file you just made?" in turn 2, and
	// found NO evidence in its own history that it had produced anything —
	// `produce_file` was the one tool whose segment was never persisted. It
	// then retracted a true statement and produced a second PDF. The digest
	// below is what the next turn now sees: the filenames and job verdict in
	// the summary, and the way back into the file in the detail.
	it("carries a produce_file call and its outcome into the next turn's history", () => {
		const segment = {
			type: "tool_call" as const,
			callId: "call_pf",
			name: "produce_file",
			input: {
				requestTitle: "Tobacco cost breakdown",
				requestedOutputs: [{ type: "pdf" }],
				sourceMode: "document_source",
				documentSource: {
					contentHash: "9f1c2a",
					topLevelKeyCount: 4,
					serializedLength: 2184,
				},
			},
			status: "done" as const,
			outputSummary:
				"File production job job-42 succeeded: tobacco-cost-breakdown.pdf.",
			resultDigest:
				'Read it back with read_generated_file({filename:"tobacco-cost-breakdown.pdf"}). Change it with produce_file patches on "tobacco-cost-breakdown.pdf".',
			metadata: { ok: true, jobStatus: "succeeded", jobId: "job-42" },
		};

		expect(buildHistoryToolDigest(segment)).toEqual({
			ok: true,
			summary:
				"File production job job-42 succeeded: tobacco-cost-breakdown.pdf.",
			detail:
				'Read it back with read_generated_file({filename:"tobacco-cost-breakdown.pdf"}). Change it with produce_file patches on "tobacco-cost-breakdown.pdf".',
		});

		const out = renderHistoryTurn(
			turn("Make me a cost breakdown PDF", {
				content: "PDF attached.",
				thinkingSegments: [segment],
			}),
			"native",
		);
		const toolMessage = out.find((message) => message.role === "tool");
		expect(toolMessage).toBeDefined();
		expect(JSON.stringify(toolMessage)).toContain("tobacco-cost-breakdown.pdf");

		// The digest must stay cheap: it is paid on every turn the produced
		// file is still inside the history window. The document bytes never ride
		// along — `sanitizeProduceFileInput` reduces the source to a hash, a key
		// count and a length before it is ever recorded.
		const cost = estimateHistoryMessagesTokens(out, estimate);
		const baseline = estimateHistoryMessagesTokens(
			renderHistoryTurn(
				turn("Make me a cost breakdown PDF", { content: "PDF attached." }),
				"native",
			),
			estimate,
		);
		// 101 estimated tokens for this call as measured (67 of them the digest,
		// 25 the trimmed input, the rest message framing); it was 108 before the
		// input trim below and 83 before the digest gained its second clause.
		//
		// That clause — "Change it with produce_file patches on <name>" — is 18
		// tokens per produced file per turn in the window, and it buys the edit
		// path: without it the model regenerates the whole file (a second
		// production job and its bytes) instead of patching it, which live cost
		// two rejected tool calls and a full rewrite for a one-line change.
		expect(cost - baseline).toBeLessThan(110);
		// The telemetry-only shape of the source (a hash, a key count, a byte
		// length) is not something the model can use a turn later, so it does
		// not ride along — and the document bytes never did.
		const serialized = JSON.stringify(out);
		expect(serialized).not.toContain("contentHash");
		expect(serialized).not.toContain("serializedLength");
		expect(serialized).not.toContain("blocks");
		expect(serialized).toContain("document_source");
	});

	// THE LIVE FAILURE that follows from the one above: whatever this replays as
	// the call's `input` is what the model imitates next turn, so it has to be
	// an input `produce_file` would accept. It was not — an inline_text call
	// replayed `sourceMode: "inline_text"`, which the model-facing schema does
	// not admit, and a refused call replayed `content` as a hash/length object
	// where the schema declares a string. Both were rejected on sight.
	it.each([
		[
			"a file the server wrote itself",
			{
				requestTitle: "Release notes",
				requestedOutputs: [{ type: "md" }],
				documentIntent: "data export",
				inlineText: {
					files: [{ filename: "release-notes.md", outputType: "md" }],
					contentHash: "9f1c2a3b4c5d",
					contentLength: 184,
				},
			},
		],
		[
			"a call the server refused",
			{
				requestTitle: "Release notes",
				content: { contentHash: "9f1c2a3b4c5d", contentLength: 184 },
			},
		],
	])("replays %s as an input produce_file accepts", (_name, input) => {
		const out = renderHistoryTurn(
			turn("Write the release notes", {
				content: "Done.",
				thinkingSegments: [
					{
						type: "tool_call",
						callId: "call_pf",
						name: "produce_file",
						input,
						status: "done",
						outputSummary:
							"File production job job-1 succeeded: release-notes.md.",
					},
				],
			}),
			"native",
		);

		const call = out
			.flatMap((message) =>
				Array.isArray(message.content) ? message.content : [],
			)
			.find((part) => part.type === "tool-call");
		expect(call).toBeDefined();
		expect(
			produceFileModelInputSchema.safeParse((call as { input: unknown }).input)
				.success,
		).toBe(true);
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
