import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { buildAskResumeCapture } from "./ask-capture";
import type { AskCapturedResult } from "./ask-questions";

// A page the server fetched before the model ran, as the prepared context hands
// it to the first segment of a reply.
const PREFETCHED: ModelMessage[] = [
	{
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "pre-1",
				toolName: "fetch_url",
				input: { urls: ["https://example.com/a"] },
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "pre-1",
				toolName: "fetch_url",
				output: { type: "json", value: { pages: ["the whole page"] } },
			},
		],
	},
];

// What the run said and read before it asked: a search, then the question.
const RESPONSE: ModelMessage[] = [
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Let me look first." },
			{
				type: "tool-call",
				toolCallId: "call-search",
				toolName: "research_web",
				input: { query: "wall colours" },
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call-search",
				toolName: "research_web",
				output: { type: "json", value: { sources: ["the whole result"] } },
			},
		],
	},
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Which one?" },
			{
				type: "tool-call",
				toolCallId: "call-ask",
				toolName: "ask_user",
				input: { questions: [] },
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call-ask",
				toolName: "ask_user",
				output: { type: "json", value: { status: "waiting_for_user" } },
			},
		],
	},
];

const FETCH_ENTRY: ToolCallEntry = {
	callId: "pre-1",
	name: "fetch_url",
	input: { urls: ["https://example.com/a"] },
	status: "done",
	outputSummary: "Fetched 1 page.",
	resultDigest: "The page says the walls are white.",
	candidates: [
		{
			id: "src-a",
			title: "Page A",
			url: "https://example.com/a",
			sourceType: "web",
		},
	],
};

const SEARCH_ENTRY: ToolCallEntry = {
	callId: "call-search",
	name: "research_web",
	input: { query: "wall colours" },
	status: "done",
	outputSummary: "Found 2 sources.",
	resultDigest: "Source B prefers grey.",
	candidates: [
		{
			id: "src-b",
			title: "Page B",
			url: "https://example.com/b",
			sourceType: "web",
		},
		{ id: "src-c", title: "Page C", sourceType: "web" },
	],
};

const ASK_ENTRY: ToolCallEntry = {
	callId: "call-ask",
	name: "ask_user",
	input: { questions: [] },
	status: "done",
	outputSummary: "Asked the user; the reply paused for the answer.",
	metadata: { paused: true, questionId: "q-1" },
};

function capture(
	overrides: Partial<Parameters<typeof buildAskResumeCapture>[0]> = {},
) {
	return buildAskResumeCapture({
		continuationGiven: PREFETCHED,
		responseMessages: RESPONSE,
		toolCalls: [FETCH_ENTRY, SEARCH_ENTRY, ASK_ENTRY],
		priorResults: [],
		askToolCallId: "call-ask",
		...overrides,
	});
}

describe("buildAskResumeCapture", () => {
	it("keeps the prefetched exchange and the response messages, and one result row per tool result with its digest", () => {
		const result = capture();

		expect(result.v).toBe(1);
		// What follows the person's message in the model input, in order.
		expect(result.messages).toEqual([...PREFETCHED, ...RESPONSE]);
		// The prefetched fetch and the search, in the order the results come; the
		// ask call has no row.
		expect(result.results).toEqual([
			{
				toolCallId: "pre-1",
				toolName: "fetch_url",
				localDistilled: false,
				digest: {
					ok: true,
					summary: "Fetched 1 page.",
					detail: "The page says the walls are white.",
					sources: [{ title: "Page A", url: "https://example.com/a" }],
				},
			},
			{
				toolCallId: "call-search",
				toolName: "research_web",
				localDistilled: false,
				digest: {
					ok: true,
					summary: "Found 2 sources.",
					detail: "Source B prefers grey.",
					sources: [
						{ title: "Page B", url: "https://example.com/b" },
						{ title: "Page C" },
					],
				},
			},
		]);
	});

	it("keeps the full tool results in the messages, not their digests", () => {
		const result = capture();

		expect(JSON.stringify(result.messages)).toContain("the whole page");
		expect(JSON.stringify(result.messages)).toContain("the whole result");
	});

	it("marks a result a local model summarised", () => {
		const result = capture({
			toolCalls: [
				FETCH_ENTRY,
				{
					...SEARCH_ENTRY,
					callId: "call-search",
					metadata: { ok: true, localDistilled: true },
				},
				ASK_ENTRY,
			],
		});

		expect(result.results.map((row) => row.localDistilled)).toEqual([
			false,
			true,
		]);
	});

	it("reads a call that failed as a failure in its digest", () => {
		const result = capture({
			toolCalls: [
				FETCH_ENTRY,
				{
					...SEARCH_ENTRY,
					status: "failed",
					outputSummary: "Search timed out.",
				},
				ASK_ENTRY,
			],
		});

		expect(result.results[1]).toMatchObject({
			toolCallId: "call-search",
			digest: { ok: false, summary: "Search timed out." },
		});
	});

	it("keeps an earlier capture's rows and adds only new ones", () => {
		// The first segment's capture holds the prefetched fetch; this run was
		// handed those messages again as its continuation.
		const prior: AskCapturedResult[] = [
			{
				toolCallId: "pre-1",
				toolName: "fetch_url",
				localDistilled: true,
				digest: { ok: true, summary: "Kept from the first segment." },
			},
		];

		const result = capture({ priorResults: prior });

		expect(result.results).toEqual([
			prior[0],
			expect.objectContaining({ toolCallId: "call-search" }),
		]);
		// Not read again from the entry: the earlier row stands as it was.
		expect(result.results[0].digest.summary).toBe(
			"Kept from the first segment.",
		);
		expect(result.results[0].localDistilled).toBe(true);
	});

	it("makes no row for an ask call, this one or an earlier segment's answered one", () => {
		// The second segment's continuation carries the first segment's ask call
		// with the person's answer as its result.
		const answeredEarlier: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-ask-0",
						toolName: "ask_user",
						input: { questions: [] },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-ask-0",
						toolName: "ask_user",
						output: { type: "json", value: { status: "answered" } },
					},
				],
			},
		];

		const result = capture({
			continuationGiven: [...PREFETCHED, ...answeredEarlier],
			toolCalls: [FETCH_ENTRY, SEARCH_ENTRY, ASK_ENTRY],
		});

		expect(result.results.map((row) => row.toolCallId)).toEqual([
			"pre-1",
			"call-search",
		]);
	});

	it("gives a result whose call was never recorded a plain row, so nothing is left for a gate to miss", () => {
		const result = capture({ toolCalls: [SEARCH_ENTRY, ASK_ENTRY] });

		expect(result.results[0]).toEqual({
			toolCallId: "pre-1",
			toolName: "fetch_url",
			localDistilled: false,
			digest: { ok: true, summary: "Completed." },
		});
	});

	it("makes one row for a result that appears twice", () => {
		const result = capture({
			responseMessages: [
				...RESPONSE.slice(0, 2),
				...RESPONSE.slice(0, 2),
				...RESPONSE.slice(2),
			],
		});

		expect(
			result.results.filter((row) => row.toolCallId === "call-search"),
		).toHaveLength(1);
	});

	it("answers an empty capture for a run that said and read nothing", () => {
		const result = capture({
			continuationGiven: [],
			responseMessages: [],
			toolCalls: [],
		});

		expect(result).toEqual({ v: 1, messages: [], results: [] });
	});

	it("does not change what it was given", () => {
		const prior: AskCapturedResult[] = [];
		const continuation = [...PREFETCHED];
		const response = [...RESPONSE];
		const before = JSON.stringify({ prior, continuation, response });

		const result = capture({
			priorResults: prior,
			continuationGiven: continuation,
			responseMessages: response,
		});

		expect(JSON.stringify({ prior, continuation, response })).toBe(before);
		expect(result.messages).not.toBe(continuation);
		expect(prior).toEqual([]);
	});
});
