import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import {
	buildAskResumeCapture,
	capturedProvenanceResults,
	gateCapturedConnectorResults,
	holdsAskResult,
	renderAskContinuationAsText,
} from "./ask-capture";
import type { AskCapturedResult, AskResumeCapture } from "./ask-questions";

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

// A resume answers the ask's result, so a capture that does not hold it cannot be
// answered: the turn pauses only when what the run said and read holds it.
describe("holdsAskResult", () => {
	it("holds the ask's result when a tool message has it", () => {
		expect(holdsAskResult(RESPONSE, "call-ask")).toBe(true);
	});

	it("does not hold it when the run stopped before the step of the ask was captured", () => {
		// only the search step was captured
		expect(holdsAskResult(RESPONSE.slice(0, 2), "call-ask")).toBe(false);
	});

	it("does not hold it for the call alone", () => {
		// the assistant message that made the call, without the tool message after it
		expect(holdsAskResult(RESPONSE.slice(0, 3), "call-ask")).toBe(false);
	});

	it("does not hold it when nothing was captured", () => {
		expect(holdsAskResult([], "call-ask")).toBe(false);
	});

	it("reads the call's id, not the tool's name", () => {
		// a result of another ask call is not this ask's
		expect(holdsAskResult(RESPONSE, "call-ask-other")).toBe(false);
	});

	it("holds it whatever the result said: a resume replaces that result with the answer", () => {
		const refused: ModelMessage[] = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-ask",
						toolName: "ask_user",
						output: { type: "error-text", value: "The tool timed out." },
					},
				],
			},
		];

		expect(holdsAskResult(refused, "call-ask")).toBe(true);
	});
});

// --- what a resume does with the capture ------------------------------------

// A paused reply that read a page, searched, looked at the person's calendar and
// mail, and asked. `resumeCapture()` is what the store keeps; `resumeMessages()`
// is that capture as a resume sends it, with the person's answer where the pause
// was.
const QUESTIONS = [
	{
		question: "Which colour?",
		options: [{ label: "White", recommended: true }, { label: "Grey" }],
	},
	{
		question: "Which finish?",
		options: [{ label: "Matt", recommended: true }, { label: "Gloss" }],
	},
];

const CALENDAR_PAYLOAD = {
	events: [{ title: "Dentist with Dr. Kovacs", location: "Main St 5" }],
};
const EMAIL_SUMMARY = {
	summary: "One mail about the delivery.",
	link: "https://stranger.example/p?d=PRIVATE",
};

const PRIVATE_STEP: ModelMessage[] = [
	{
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "call-cal",
				toolName: "calendar",
				input: { action: "list_events" },
			},
			{
				type: "tool-call",
				toolCallId: "call-mail",
				toolName: "email",
				input: { action: "search" },
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call-cal",
				toolName: "calendar",
				output: { type: "json", value: CALENDAR_PAYLOAD },
			},
			{
				type: "tool-result",
				toolCallId: "call-mail",
				toolName: "email",
				output: { type: "json", value: EMAIL_SUMMARY },
			},
		],
	},
];

const CALENDAR_DIGEST = {
	ok: true,
	summary: "Found 1 event.",
	detail: "One appointment at 10:00.",
	sources: [{ title: "Dentist", url: "https://calendar.example/event/1" }],
};

const RESULT_ROWS: AskCapturedResult[] = [
	{
		toolCallId: "pre-1",
		toolName: "fetch_url",
		localDistilled: false,
		digest: { ok: true, summary: "Fetched 1 page." },
	},
	{
		toolCallId: "call-search",
		toolName: "research_web",
		localDistilled: false,
		digest: { ok: true, summary: "Found 2 sources." },
	},
	{
		toolCallId: "call-cal",
		toolName: "calendar",
		localDistilled: false,
		digest: CALENDAR_DIGEST,
	},
	{
		toolCallId: "call-mail",
		toolName: "email",
		localDistilled: true,
		digest: { ok: true, summary: "One mail about the delivery." },
	},
];

function askStep(answer: unknown): ModelMessage[] {
	return [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Which one?" },
				{
					type: "tool-call",
					toolCallId: "call-ask",
					toolName: "ask_user",
					input: { questions: QUESTIONS },
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
					output: { type: "json", value: answer as never },
				},
			],
		},
	];
}

// The messages a resume sends after the person's message: the prefetched page,
// the search step, the connector step and the ask with its answer.
// Indexes: 0-1 the page, 2-3 the search, 4-5 the connectors, 6-7 the ask.
function resumeMessages(answer: unknown = { status: "answered" }) {
	return [
		...PREFETCHED,
		...RESPONSE.slice(0, 2),
		...PRIVATE_STEP,
		...askStep(answer),
	];
}

function resumeCapture(): AskResumeCapture {
	return { v: 1, messages: resumeMessages(), results: RESULT_ROWS };
}

const CLOUD = {
	baseUrl: "https://api.fireworks.ai/inference/v1",
} as NormalChatModelRunProvider;
const HOME = {
	baseUrl: "http://192.168.1.20:8000/v1",
} as NormalChatModelRunProvider;

function resultOutput(messages: ModelMessage[], toolCallId: string): unknown {
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (part.type === "tool-result" && part.toolCallId === toolCallId) {
				return part.output;
			}
		}
	}
	return undefined;
}

// A model that is not on the person's box must never be sent what the setting
// keeps local. A resume's original messages are the captured ones, so each
// attempt's messages are gated from them here.
describe("gateCapturedConnectorResults", () => {
	it("gives an attempt off the person's box each raw connector result as its digest when they keep connector data local", () => {
		// both connector results are raw this time: the mail is not a summary
		const mailDigest = {
			ok: true,
			summary: "Found 1 mail.",
			detail: "From Anna.",
		};
		const gate = gateCapturedConnectorResults({
			results: [
				...RESULT_ROWS.slice(0, 3),
				{ ...RESULT_ROWS[3], localDistilled: false, digest: mailDigest },
			],
			keepConnectorDataLocal: true,
		});
		const messages = resumeMessages();

		const sent = gate(messages, CLOUD);

		// the raw calendar and mail results are their digests, as a later turn
		// would see them
		expect(resultOutput(sent, "call-cal")).toEqual({
			type: "json",
			value: CALENDAR_DIGEST,
		});
		expect(resultOutput(sent, "call-mail")).toEqual({
			type: "json",
			value: mailDigest,
		});
		const text = JSON.stringify(sent);
		expect(text).not.toContain("Dr. Kovacs");
		expect(text).not.toContain("Main St 5");
		expect(text).not.toContain("PRIVATE");
		// everything else is as it was: the page, the search and the question
		expect(resultOutput(sent, "pre-1")).toEqual(
			resultOutput(messages, "pre-1"),
		);
		expect(resultOutput(sent, "call-search")).toEqual(
			resultOutput(messages, "call-search"),
		);
		expect(resultOutput(sent, "call-ask")).toEqual(
			resultOutput(messages, "call-ask"),
		);
		expect(sent.map((message) => message.role)).toEqual(
			messages.map((message) => message.role),
		);
		// and the call parts of the connectors are where they were
		expect(sent[4]).toEqual(messages[4]);
	});

	it("does not change the messages it is given", () => {
		const gate = gateCapturedConnectorResults({
			results: RESULT_ROWS,
			keepConnectorDataLocal: true,
		});
		const messages = resumeMessages();
		const before = JSON.stringify(messages);

		const sent = gate(messages, CLOUD);

		expect(JSON.stringify(messages)).toBe(before);
		expect(sent).not.toBe(messages);
		// the message that changed is a new one, with new content
		expect(sent[5]).not.toBe(messages[5]);
		expect((sent[5] as { content: unknown }).content).not.toBe(
			(messages[5] as { content: unknown }).content,
		);
	});

	it("leaves a local attempt, a local summary and a result that is not a connector's as they are", () => {
		const messages = resumeMessages();

		// an attempt on the person's own box sees what the tool returned
		const local = gateCapturedConnectorResults({
			results: RESULT_ROWS,
			keepConnectorDataLocal: true,
		})(messages, HOME);
		expect(local).toEqual(messages);

		// the person does not keep connector data local
		const open = gateCapturedConnectorResults({
			results: RESULT_ROWS,
			keepConnectorDataLocal: false,
		})(messages, CLOUD);
		expect(open).toEqual(messages);

		// on a cloud attempt: the mail result is a local model's summary already
		// (its row says so), and the search and the page are not a connector's
		const cloud = gateCapturedConnectorResults({
			results: RESULT_ROWS,
			keepConnectorDataLocal: true,
		})(messages, CLOUD);
		expect(resultOutput(cloud, "call-mail")).toEqual(
			resultOutput(messages, "call-mail"),
		);
		expect(resultOutput(cloud, "call-search")).toEqual(
			resultOutput(messages, "call-search"),
		);
		expect(resultOutput(cloud, "pre-1")).toEqual(
			resultOutput(messages, "pre-1"),
		);
		// the calendar's raw result is the one that changed
		expect(resultOutput(cloud, "call-cal")).toEqual({
			type: "json",
			value: CALENDAR_DIGEST,
		});
	});

	it("leaves a connector result that has no row alone: the gate knows only what was captured", () => {
		const gate = gateCapturedConnectorResults({
			results: [],
			keepConnectorDataLocal: true,
		});
		const messages = resumeMessages();

		expect(gate(messages, CLOUD)).toEqual(messages);
	});

	it("decides again for each attempt it is asked for", () => {
		const gate = gateCapturedConnectorResults({
			results: RESULT_ROWS,
			keepConnectorDataLocal: true,
		});
		const messages = resumeMessages();

		// the first attempt is on the person's box, the failover is not
		expect(gate(messages, HOME)).toEqual(messages);
		expect(resultOutput(gate(messages, CLOUD), "call-cal")).toEqual({
			type: "json",
			value: CALENDAR_DIGEST,
		});
		expect(gate(messages, HOME)).toEqual(messages);
	});
});

// The resume's run is a new turn for the address check, but what the paused
// segment read is still what the model was handed, so an address in it is a
// tool's, and a connector summary counts through its sources alone (ADR-0068).
describe("capturedProvenanceResults", () => {
	it("reads each captured result as the tool result the model was handed, with its call's input and its sources", () => {
		const observed = capturedProvenanceResults(resumeCapture());

		expect(observed.map((result) => result.toolName)).toEqual([
			"fetch_url",
			"research_web",
			"calendar",
			"email",
		]);
		const [page, search, calendar] = observed;
		expect(page.payload).toEqual({ pages: ["the whole page"] });
		expect(page.entry?.input).toEqual({ urls: ["https://example.com/a"] });
		expect(search.payload).toEqual({ sources: ["the whole result"] });
		expect(calendar.payload).toEqual(CALENDAR_PAYLOAD);
		expect(calendar.entry?.input).toEqual({ action: "list_events" });
		// the digest's sources with an address are the call's candidates
		expect(calendar.entry?.candidates).toEqual([
			expect.objectContaining({
				title: "Dentist",
				url: "https://calendar.example/event/1",
			}),
		]);
	});

	it("marks a result a local model summarised, so only its sources count", () => {
		const observed = capturedProvenanceResults(resumeCapture());

		const mail = observed.find((result) => result.toolName === "email");
		const calendar = observed.find((result) => result.toolName === "calendar");
		expect(mail?.entry?.metadata).toEqual({ localDistilled: true });
		expect(calendar?.entry?.metadata).toBeUndefined();
	});

	it("makes no observation for the ask call: its result is the pause and then the person's answer", () => {
		const observed = capturedProvenanceResults(resumeCapture());

		expect(observed.some((result) => result.toolName === "ask_user")).toBe(
			false,
		);
	});

	it("keeps a row whose result is no longer in the messages, by its sources alone", () => {
		const observed = capturedProvenanceResults({
			v: 1,
			messages: [],
			results: [RESULT_ROWS[2]],
		});

		expect(observed).toHaveLength(1);
		expect(observed[0].payload).toBeUndefined();
		expect(observed[0].entry?.candidates).toHaveLength(1);
	});

	it("takes no payload from a result that failed", () => {
		const observed = capturedProvenanceResults({
			v: 1,
			messages: [
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "pre-1",
							toolName: "fetch_url",
							output: {
								type: "error-text",
								value: "Fetch failed for https://exfil.example/x",
							},
						},
					],
				},
			],
			results: [RESULT_ROWS[0]],
		});

		expect(observed[0].payload).toBeUndefined();
	});

	it("answers nothing for an empty capture", () => {
		expect(
			capturedProvenanceResults({ v: 1, messages: [], results: [] }),
		).toEqual([]);
	});
});

// A provider that rejects tool messages gets the continuation as text, in the
// lines a stored reply is said in for it (Task 6's): what it used, what it asked
// and what the person answered. Ruling 79: the scaffold is ASCII English; the
// questions and the answer are data.
describe("renderAskContinuationAsText", () => {
	function foldedLines(messages: ModelMessage[]): string[] {
		return messages.flatMap((message) => {
			expect(message.role).toBe("assistant");
			expect(typeof message.content).toBe("string");
			return (message.content as string).split("\n");
		});
	}

	it("folds the continuation into text for a provider that takes no tool messages", () => {
		const folded = renderAskContinuationAsText(
			resumeMessages({
				status: "answered",
				answers: [{ question: "Which colour?", picked: ["White"] }],
			}),
		);

		// no tool message and no tool part is left
		expect(folded.every((message) => message.role === "assistant")).toBe(true);
		expect(JSON.stringify(folded)).not.toContain("tool-call");
		expect(JSON.stringify(folded)).not.toContain("tool-result");
		expect(foldedLines(folded)).toEqual([
			'[used fetch_url: {"pages":["the whole page"]}]',
			"Let me look first.",
			'[used research_web: {"sources":["the whole result"]}]',
			`[used calendar: ${JSON.stringify(CALENDAR_PAYLOAD)}]`,
			`[used email: ${JSON.stringify(EMAIL_SUMMARY)}]`,
			"Which one?",
			"[asked the user: Which colour? / Which finish?]",
			`[the user's answer: {"status":"answered","answers":[{"question":"Which colour?","picked":["White"]}]}]`,
		]);
	});

	it("says a result that is a digest by its summary and detail", () => {
		const folded = renderAskContinuationAsText([
			PRIVATE_STEP[0],
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-cal",
						toolName: "calendar",
						output: { type: "json", value: CALENDAR_DIGEST },
					},
					{
						type: "tool-result",
						toolCallId: "call-mail",
						toolName: "email",
						output: { type: "text", value: "Two mails." },
					},
				],
			},
		]);

		expect(foldedLines(folded)).toEqual([
			"[used calendar: Found 1 event. One appointment at 10:00.]",
			"[used email: Two mails.]",
		]);
	});

	it("keeps every line within the length a stored reply's lines keep", () => {
		const folded = renderAskContinuationAsText(
			resumeMessages({ note: "x".repeat(2_000) }),
		);

		const lines = foldedLines(folded);
		expect(lines.some((line) => line.startsWith("[the user's answer: "))).toBe(
			true,
		);
		for (const line of lines) {
			if (line.startsWith("[")) expect(line.length).toBeLessThanOrEqual(400);
		}
	});

	it("says an ask that lost its questions without them, and the answer all the same", () => {
		const folded = renderAskContinuationAsText([
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-ask",
						toolName: "ask_user",
						input: { questions: "not a list" },
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
						output: {
							type: "json",
							value: { ok: true, summary: "Left to you." },
						},
					},
				],
			},
		]);

		expect(foldedLines(folded)).toEqual([
			"[asked the user]",
			"[the user's answer: Left to you.]",
		]);
	});

	it("writes a result that failed as it is, and drops the model's hidden reasoning", () => {
		const folded = renderAskContinuationAsText([
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "secret thoughts" },
					{ type: "text", text: "Trying." },
					{
						type: "tool-call",
						toolCallId: "c1",
						toolName: "fetch_url",
						input: {},
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "c1",
						toolName: "fetch_url",
						output: { type: "error-text", value: "Timed out." },
					},
				],
			},
		]);

		expect(foldedLines(folded)).toEqual([
			"Trying.",
			"[used fetch_url: Timed out.]",
		]);
		expect(JSON.stringify(folded)).not.toContain("secret thoughts");
	});

	it("keeps a message that is not the assistant's or a tool's where it was", () => {
		const user: ModelMessage = { role: "user", content: "And a mug." };

		const folded = renderAskContinuationAsText([
			{ role: "assistant", content: "Before." },
			user,
			{ role: "assistant", content: "After." },
		]);

		expect(folded).toEqual([
			{ role: "assistant", content: "Before." },
			user,
			{ role: "assistant", content: "After." },
		]);
	});

	it("answers nothing for nothing, and does not change what it was given", () => {
		expect(renderAskContinuationAsText([])).toEqual([]);
		const messages = resumeMessages();
		const before = JSON.stringify(messages);

		renderAskContinuationAsText(messages);

		expect(JSON.stringify(messages)).toBe(before);
	});
});
