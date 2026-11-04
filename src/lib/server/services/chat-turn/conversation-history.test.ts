import { describe, expect, it } from "vitest";

import type { ThinkingSegment } from "$lib/server/services/messages-types";
import { produceFileModelInputSchema } from "$lib/server/services/normal-chat-tools/produce-file";
import {
	buildHistoryModelMessages,
	buildHistoryToolDigest,
	estimateHistoryMessagesTokens,
	type HistoryTurn,
	historyToolCallId,
	isHistoryToolDigest,
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

type ToolCallSegment = Extract<ThinkingSegment, { type: "tool_call" }>;

// A reply that stopped to ask: the ask call as its first segment stores it once
// the person has answered (the answer replaces the paused summary and adds the
// digest), and a research call it made before asking.
const WHICH_WAY_QUESTIONS = [
	{
		question: "Which way should we take it?",
		options: [
			{ label: "A party at home", recommended: true },
			{ label: "A restaurant table" },
		],
	},
];
const ASK_ANSWER_DIGEST =
	'{"status":"answered","answers":[{"question":"Which way should we take it?","picked":["A party at home"]}]}';

function askCall(overrides: Partial<ToolCallSegment> = {}): ToolCallSegment {
	return {
		type: "tool_call",
		callId: "call_ask",
		name: "ask_user",
		input: { questions: WHICH_WAY_QUESTIONS },
		status: "done",
		outputSummary: "The user picked: A party at home",
		resultDigest: ASK_ANSWER_DIGEST,
		metadata: { paused: true, questionId: "question-1" },
		...overrides,
	};
}

const researchCall: ToolCallSegment = {
	type: "tool_call",
	callId: "call_research",
	name: "research_web",
	input: { query: "party ideas" },
	status: "done",
	outputSummary: "Web research returned 2 sources.",
	resultDigest: "Two venues were found.",
};

// A card the tool refused: recorded as a finished call marked `ok: false`. It
// asked nobody, so a later turn reads it as any other call.
const NOT_AVAILABLE_SUMMARY =
	"Asking is not available in this reply. Go on with your best judgment.";

function refusedAskCall(
	overrides: Partial<ToolCallSegment> = {},
): ToolCallSegment {
	return {
		type: "tool_call",
		callId: "call_ask_refused",
		name: "ask_user",
		input: { questions: WHICH_WAY_QUESTIONS },
		status: "done",
		outputSummary: NOT_AVAILABLE_SUMMARY,
		sourceType: "tool",
		metadata: { ok: false, evidenceReady: false, reason: "not_available" },
		...overrides,
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
		// The answer follows the tool's result, as it was written: replayed before
		// the call, it taught the model to answer first and call after (Task 11:
		// "Added - a slim brass floor lamp..." said before make_image, then again
		// after its result).
		expect(out).toHaveLength(4);
		expect(out[3]).toEqual({ role: "assistant", content: "It is 15°C." });
		expect(out[1]).toEqual({
			role: "assistant",
			content: [
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

	it("renders a segment that asked: its other calls first, then its words with the ask call, then the answer as the call's result", () => {
		const out = renderHistoryTurn(
			turn("Plan the party", {
				content: "I found two ways to go.",
				thinkingSegments: [
					{ type: "text", content: "private reasoning" },
					researchCall,
					askCall(),
				],
			}),
			"native",
		);
		expect(out.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
			"tool",
		]);
		expect(out[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call_research",
					toolName: "research_web",
					input: { query: "party ideas" },
				},
			],
		});
		expect(out[2]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_research",
					toolName: "research_web",
					output: {
						type: "json",
						value: {
							ok: true,
							summary: "Web research returned 2 sources.",
							detail: "Two venues were found.",
						},
					},
				},
			],
		});
		// The words were said before the question, so they go with the call and not
		// after its result.
		expect(out[3]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "I found two ways to go." },
				{
					type: "tool-call",
					toolCallId: "call_ask",
					toolName: "ask_user",
					input: { questions: WHICH_WAY_QUESTIONS },
				},
			],
		});
		expect(out[4]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_ask",
					toolName: "ask_user",
					output: {
						type: "json",
						value: {
							ok: true,
							summary: "The user picked: A party at home",
							detail: ASK_ANSWER_DIGEST,
						},
					},
				},
			],
		});
		expect(JSON.stringify(out)).not.toContain("private reasoning");
	});

	it("renders a segment that asked with no other calls and no words as the ask call and its result alone", () => {
		const out = renderHistoryTurn(
			turn("Plan the party", {
				id: "seg-1",
				content: "",
				thinkingSegments: [askCall({ callId: undefined })],
			}),
			"native",
		);
		expect(out.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
		// No stored callId: the same derived id pairs the call with its result.
		expect(out[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "hist_seg-1_0",
					toolName: "ask_user",
					input: { questions: WHICH_WAY_QUESTIONS },
				},
			],
		});
		const result = out[2];
		if (result.role !== "tool") throw new Error("expected tool message");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "tool-result",
				toolCallId: "hist_seg-1_0",
				toolName: "ask_user",
			}),
		]);
	});

	it("numbers the calls of a segment that asked as it numbers any message's calls", () => {
		const out = renderHistoryTurn(
			turn("Plan the party", {
				id: "seg-1",
				content: "Two ways to go.",
				thinkingSegments: [
					{ ...researchCall, callId: undefined },
					askCall({ callId: undefined }),
				],
			}),
			"native",
		);
		const ids = out.flatMap((message) =>
			typeof message.content === "string"
				? []
				: message.content.flatMap((part) =>
						part.type === "tool-call" || part.type === "tool-result"
							? [part.toolCallId]
							: [],
					),
		);
		expect(ids).toEqual([
			"hist_seg-1_0",
			"hist_seg-1_0",
			"hist_seg-1_1",
			"hist_seg-1_1",
		]);
	});

	it("renders the next segment as any reply, after one user message", () => {
		const out = renderHistoryTurn(
			{
				messages: [
					{ id: "u-1", role: "user", content: "Plan the party" },
					{
						id: "seg-1",
						role: "assistant",
						content: "I found two ways to go.",
						thinkingSegments: [askCall()],
					},
					{
						id: "seg-2",
						role: "assistant",
						content: "A party at home it is. Start with the guest list.",
						thinkingSegments: [researchCall],
					},
				],
			},
			"native",
		);
		expect(out.map((message) => message.role)).toEqual([
			"user",
			"assistant", // seg-1: its words with the ask call
			"tool", // the answer
			"assistant", // seg-2: its call
			"tool", // its result
			"assistant", // its words
		]);
		expect(out.filter((message) => message.role === "user")).toHaveLength(1);
		expect(out[5]).toEqual({
			role: "assistant",
			content: "A party at home it is. Start with the guest list.",
		});
	});

	it("says the question and the answer as lines in flatten mode", () => {
		const out = renderHistoryTurn(
			turn("Plan the party", {
				content: "I found two ways to go.",
				thinkingSegments: [researchCall, askCall()],
			}),
			"flatten",
		);
		expect(out).toEqual([
			{ role: "user", content: "Plan the party" },
			{
				role: "assistant",
				content: [
					"[used research_web: Web research returned 2 sources. Two venues were found.]",
					"I found two ways to go.",
					"[asked the user: Which way should we take it?]",
					"[the user's answer: The user picked: A party at home]",
				].join("\n"),
			},
		]);
	});

	it("joins the questions of one ask with a slash, and keeps each flattened line within the limit", () => {
		const questions = ["A", "B", "C"].map((letter) => ({
			question: letter.repeat(160),
			options: [{ label: "Yes", recommended: true }, { label: "No" }],
		}));
		const out = renderHistoryTurn(
			turn("Plan the party", {
				content: "",
				thinkingSegments: [
					askCall({
						input: { questions },
						outputSummary: `The user wrote: ${"z".repeat(600)}`,
					}),
				],
			}),
			"flatten",
		);
		const assistant = out[1];
		if (assistant.role !== "assistant" || typeof assistant.content !== "string")
			throw new Error("expected assistant text");
		const [asked, answer] = assistant.content.split("\n");
		expect(asked).toHaveLength(400);
		expect(
			asked.startsWith(
				`[asked the user: ${"A".repeat(160)} / ${"B".repeat(160)} / `,
			),
		).toBe(true);
		expect(answer).toHaveLength(400);
		expect(answer.startsWith("[the user's answer: The user wrote: zzz")).toBe(
			true,
		);
	});

	it("names an ask whose questions cannot be read without them, in flatten mode", () => {
		const out = renderHistoryTurn(
			turn("Plan the party", {
				content: "",
				thinkingSegments: [askCall({ input: {} })],
			}),
			"flatten",
		);
		expect(out[1]).toEqual({
			role: "assistant",
			content:
				"[asked the user]\n[the user's answer: The user picked: A party at home]",
		});
	});

	// Only an ask that paused the reply gets the asked shape. A refused card asked
	// nobody, and an ask that did not finish asked nobody either: the words go
	// after their results as in any reply, and nothing says a question was put.
	describe("an ask call that did not pause the reply", () => {
		it("renders a refused card like any other call: the call, its result, then the words", () => {
			const out = renderHistoryTurn(
				turn("Plan the party", {
					content: "A party at home it is.",
					thinkingSegments: [refusedAskCall()],
				}),
				"native",
			);
			expect(out).toEqual([
				{ role: "user", content: "Plan the party" },
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "call_ask_refused",
							toolName: "ask_user",
							input: { questions: WHICH_WAY_QUESTIONS },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call_ask_refused",
							toolName: "ask_user",
							output: {
								type: "json",
								value: { ok: true, summary: NOT_AVAILABLE_SUMMARY },
							},
						},
					],
				},
				{ role: "assistant", content: "A party at home it is." },
			]);
		});

		it("says a refused card as a used-tool line in flatten mode, and asks nobody", () => {
			const out = renderHistoryTurn(
				turn("Plan the party", {
					content: "A party at home it is.",
					thinkingSegments: [refusedAskCall()],
				}),
				"flatten",
			);
			expect(out).toEqual([
				{ role: "user", content: "Plan the party" },
				{
					role: "assistant",
					content: `[used ask_user: ${NOT_AVAILABLE_SUMMARY}]\nA party at home it is.`,
				},
			]);
		});

		it("renders a refused card among the other calls when a corrected card paused the reply", () => {
			const refused = refusedAskCall({
				callId: "call_ask_bad",
				outputSummary:
					"Question 1 takes one pick: mark exactly one of its options recommended.",
				metadata: {
					ok: false,
					evidenceReady: false,
					reason: "invalid_questions",
				},
			});
			const out = renderHistoryTurn(
				turn("Plan the party", {
					content: "I found two ways to go.",
					thinkingSegments: [researchCall, refused, askCall()],
				}),
				"native",
			);
			expect(out.map((message) => message.role)).toEqual([
				"user",
				"assistant", // the research call and the refused card
				"tool", // their results
				"assistant", // the words with the card that paused the reply
				"tool", // its answer
			]);
			const calls = out[1];
			if (calls.role !== "assistant" || typeof calls.content === "string")
				throw new Error("expected assistant parts");
			expect(
				calls.content.map((part) =>
					part.type === "tool-call" ? part.toolCallId : null,
				),
			).toEqual(["call_research", "call_ask_bad"]);
			const results = out[2];
			if (results.role !== "tool") throw new Error("expected tool message");
			expect(
				results.content.map((part) =>
					part.type === "tool-result" ? part.toolCallId : null,
				),
			).toEqual(["call_research", "call_ask_bad"]);
			expect(out[3]).toEqual({
				role: "assistant",
				content: [
					{ type: "text", text: "I found two ways to go." },
					expect.objectContaining({
						type: "tool-call",
						toolCallId: "call_ask",
						toolName: "ask_user",
					}),
				],
			});
			expect(out[4]).toEqual({
				role: "tool",
				content: [
					expect.objectContaining({
						type: "tool-result",
						toolCallId: "call_ask",
					}),
				],
			});
		});

		it("says a refused card as a used-tool line among the other calls' lines in flatten mode", () => {
			const refused = refusedAskCall({
				callId: "call_ask_bad",
				outputSummary: "Question 1 has no text.",
				metadata: {
					ok: false,
					evidenceReady: false,
					reason: "invalid_questions",
				},
			});
			const out = renderHistoryTurn(
				turn("Plan the party", {
					content: "I found two ways to go.",
					thinkingSegments: [researchCall, refused, askCall()],
				}),
				"flatten",
			);
			expect(out[1]).toEqual({
				role: "assistant",
				content: [
					"[used research_web: Web research returned 2 sources. Two venues were found.]",
					"[used ask_user: Question 1 has no text.]",
					"I found two ways to go.",
					"[asked the user: Which way should we take it?]",
					"[the user's answer: The user picked: A party at home]",
				].join("\n"),
			});
		});

		it.each([
			"running",
			"failed",
		] as const)("renders an ask call that did not finish (%s) like any other call", (status) => {
			const unfinished = askCall({
				status,
				outputSummary: null,
				resultDigest: null,
			});
			const native = renderHistoryTurn(
				turn("Plan the party", {
					content: "A party at home it is.",
					thinkingSegments: [unfinished],
				}),
				"native",
			);
			// The call, its result, then the words: no card, no answer.
			expect(native.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"tool",
				"assistant",
			]);
			expect(native[3]).toEqual({
				role: "assistant",
				content: "A party at home it is.",
			});
			const flat = renderHistoryTurn(
				turn("Plan the party", {
					content: "A party at home it is.",
					thinkingSegments: [unfinished],
				}),
				"flatten",
			);
			const text = JSON.stringify(flat);
			expect(text).toContain("[used ask_user:");
			expect(text).not.toContain("[asked the user");
			expect(text).not.toContain("the user's answer");
		});
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

	it("shows a picture's stored description instead of only its name", () => {
		const out = renderHistoryTurn(
			{
				messages: [
					{
						role: "user",
						content: "What do you think of this kitchen?",
						attachments: [
							{
								name: "kitchen.jpg",
								description: "A small white kitchen with a window.",
							},
						],
					},
				],
			},
			"native",
		);
		expect(out).toEqual([
			{
				role: "user",
				content:
					"What do you think of this kitchen?\n[image: kitchen.jpg: A small white kitchen with a window.]",
			},
		]);
	});

	it("says the pictures beside the uploads as short lines, never pixels", () => {
		const out = renderHistoryTurn(
			{
				messages: [
					{
						role: "user",
						content: "Make the sofa blue",
						pictures: {
							refs: [
								{ imageFileId: "f1", number: 1, name: "Cosy living room" },
							],
							open: { imageFileId: "f2", name: "Garden\nview" },
							marks: {
								imageFileId: "f1",
								markedFileId: "f3",
								letters: ["A", "B"],
							},
						},
					},
				],
			},
			"native",
		);
		expect(out).toEqual([
			{
				role: "user",
				content:
					"Make the sofa blue\n[picture: Cosy living room]\n[open picture: Garden view]\n[marks: A, B on Cosy living room]",
			},
		]);
		expect(JSON.stringify(out)).not.toContain("f3");
	});

	it("says a picture that was attached and also open once, as the open picture", () => {
		const out = renderHistoryTurn(
			{
				messages: [
					{
						role: "user",
						content: "Use this",
						pictures: {
							refs: [
								{
									imageFileId: "f1",
									number: 1,
									name: "Cosy living room",
									open: true,
								},
							],
							open: null,
							marks: null,
						},
					},
				],
			},
			"native",
		);
		expect(out[0].content).toBe("Use this\n[open picture: Cosy living room]");
	});

	it("names marks on the open picture, and a marked picture it cannot find as a picture", () => {
		const base = {
			role: "user" as const,
			content: "Here",
		};
		expect(
			renderHistoryTurn(
				{
					messages: [
						{
							...base,
							pictures: {
								refs: [],
								open: { imageFileId: "f2", name: "Garden view" },
								marks: {
									imageFileId: "f2",
									markedFileId: "f3",
									letters: ["C"],
								},
							},
						},
					],
				},
				"native",
			)[0].content,
		).toBe("Here\n[open picture: Garden view]\n[marks: C on Garden view]");
		expect(
			renderHistoryTurn(
				{
					messages: [
						{
							...base,
							pictures: {
								refs: [],
								open: null,
								marks: {
									imageFileId: "gone",
									markedFileId: "f3",
									letters: ["A"],
								},
							},
						},
					],
				},
				"native",
			)[0].content,
		).toBe("Here\n[marks: A on a picture]");
	});

	it("falls back to the name for a picture with no description yet, and for any other file", () => {
		const out = renderHistoryTurn(
			{
				messages: [
					{
						role: "user",
						content: "Compare these",
						attachments: [
							{ name: "kitchen.jpg" },
							{ name: "garden.png", description: "   " },
							{ name: "brief.pdf" },
							{
								name: "hall.jpg",
								description: "A narrow hall with a coat rack.",
							},
						],
					},
				],
			},
			"native",
		);
		expect(out).toEqual([
			{
				role: "user",
				content: [
					"Compare these",
					"[attachment: kitchen.jpg]",
					"[attachment: garden.png]",
					"[attachment: brief.pdf]",
					"[image: hall.jpg: A narrow hall with a coat rack.]",
				].join("\n"),
			},
		]);
	});

	it("drops an attachment with no name, described or not", () => {
		const out = renderHistoryTurn(
			{
				messages: [
					{
						role: "user",
						content: "Look",
						attachments: [{ name: " ", description: "A picture of nothing." }],
					},
				],
			},
			"native",
		);
		expect(out).toEqual([{ role: "user", content: "Look" }]);
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

		const parts = out.flatMap((message) =>
			Array.isArray(message.content)
				? (message.content as Array<{ type: string; input?: unknown }>)
				: [],
		);
		const call = parts.find((part) => part.type === "tool-call");
		expect(call).toBeDefined();
		expect(produceFileModelInputSchema.safeParse(call?.input).success).toBe(
			true,
		);
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

// The one test of "this is a digest": a stored capture is read with it and so is
// a continuation's tool result (ask-capture.ts).
describe("isHistoryToolDigest", () => {
	it("knows what buildHistoryToolDigest builds, with or without detail and sources", () => {
		const call = {
			status: "done" as const,
			outputSummary: "Found 2 sources.",
			resultDigest: "A detail.",
			candidates: [
				{
					id: "a",
					title: "A",
					url: "https://a.example",
					sourceType: "web" as const,
				},
				{ id: "b", title: "B", sourceType: "web" as const },
			],
		};

		expect(isHistoryToolDigest(buildHistoryToolDigest(call))).toBe(true);
		expect(
			isHistoryToolDigest(buildHistoryToolDigest({ status: "done" })),
		).toBe(true);
		expect(
			isHistoryToolDigest(buildHistoryToolDigest({ status: "failed" })),
		).toBe(true);
	});

	it("refuses what lacks an ok or a summary of the right kind, a detail or a source that is not one, and what is not a record", () => {
		for (const value of [
			null,
			undefined,
			"text",
			["ok"],
			{ ok: true },
			{ summary: "s" },
			{ ok: "yes", summary: "s" },
			{ ok: true, summary: 3 },
			{ ok: true, summary: "s", detail: 3 },
			{ ok: true, summary: "s", sources: "none" },
			{ ok: true, summary: "s", sources: [{}] },
			{ ok: true, summary: "s", sources: [{ title: "t", url: 3 }] },
		]) {
			expect(isHistoryToolDigest(value), JSON.stringify(value)).toBe(false);
		}
	});

	it("does not look at keys it does not know", () => {
		expect(isHistoryToolDigest({ ok: true, summary: "s", events: [] })).toBe(
			true,
		);
	});
});
