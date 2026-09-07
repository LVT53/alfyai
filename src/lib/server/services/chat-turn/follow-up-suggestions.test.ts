import { beforeEach, describe, expect, it, vi } from "vitest";

// Same seaming discipline as rail-summary.test.ts: mock the shared
// control-model call primitive and the language resolver, then drive only
// this module's own skip/plausibility/persist-shape behavior — no vLLM.
const { callShortLocalControlModelMock } = vi.hoisted(() => ({
	callShortLocalControlModelMock: vi.fn(),
}));

vi.mock("./short-local-text", () => ({
	callShortLocalControlModel: callShortLocalControlModelMock,
	resolveShortTextLanguage: (message: string) =>
		/[áéíóöőúüű]/i.test(message) ? "hu" : "en",
}));

import {
	FOLLOW_UP_SUGGESTIONS_COUNT,
	FOLLOW_UP_SUGGESTIONS_FEATURE,
	FOLLOW_UP_SUGGESTIONS_MAX_CONCURRENT,
	FOLLOW_UP_SUGGESTIONS_MAX_WORDS,
	FOLLOW_UP_SUGGESTIONS_MIN_CONTENT_LENGTH,
	FOLLOW_UP_SUGGESTIONS_REQUESTED_COUNT,
	FOLLOW_UP_SUGGESTIONS_TIMEOUT_MS,
	generateFollowUpSuggestions,
	isPlausibleFollowUpSuggestion,
	looksLikeClarificationQuestion,
	renderFollowUpReply,
} from "./follow-up-suggestions";

const LONG_REPLY = `${"A long, substantive assistant answer with plenty of content to build a follow-up question on. ".repeat(3)}`;

function controlResult(text: string) {
	return {
		text,
		rawResponse: {},
		modelId: "model2" as const,
		modelDisplayName: "Model Two",
		usage: undefined,
	};
}

describe("isPlausibleFollowUpSuggestion", () => {
	it("accepts a short question ending in a bare question mark", () => {
		expect(isPlausibleFollowUpSuggestion("What about the sequel?")).toBe(true);
	});

	it("rejects text with no trailing question mark", () => {
		expect(isPlausibleFollowUpSuggestion("Tell me more")).toBe(false);
	});

	it("rejects text with punctuation beyond the trailing question mark", () => {
		expect(isPlausibleFollowUpSuggestion("Really, is that true?")).toBe(false);
	});

	it("accepts a question at the max word count", () => {
		// Seven words plus the bare "?" — inside the eight-word cap.
		expect(
			isPlausibleFollowUpSuggestion("Can you draft the email to them?"),
		).toBe(true);
	});

	it("rejects a question one word over the max word count", () => {
		// Nine words — one past the cap.
		expect(
			isPlausibleFollowUpSuggestion(
				"Can you draft the follow up email to them?",
			),
		).toBe(false);
	});

	it("rejects a question longer than the max word count", () => {
		expect(
			isPlausibleFollowUpSuggestion(
				"Is this one single question far too long to ever pass the eight word cap?",
			),
		).toBe(false);
	});

	it("rejects an empty or whitespace-only candidate", () => {
		expect(isPlausibleFollowUpSuggestion("   ")).toBe(false);
		expect(isPlausibleFollowUpSuggestion("?")).toBe(false);
	});
});

describe("renderFollowUpReply", () => {
	it("passes a reply inside the budget through unchanged", () => {
		expect(renderFollowUpReply(LONG_REPLY)).toBe(LONG_REPLY);
	});

	it("keeps the opening and the closing of a reply over the budget", () => {
		const reply = `HEAD_MARKER ${"filler ".repeat(1200)}TAIL_MARKER`;
		const rendered = renderFollowUpReply(reply);

		expect(rendered.startsWith("HEAD_MARKER")).toBe(true);
		expect(rendered.endsWith("TAIL_MARKER")).toBe(true);
		expect(rendered).toContain("[…]");
		expect(rendered.length).toBeLessThanOrEqual(1200 + 600 + 5);
	});
});

describe("looksLikeClarificationQuestion", () => {
	it("is true for a short reply ending in a question mark", () => {
		expect(looksLikeClarificationQuestion("Which city did you mean?")).toBe(
			true,
		);
	});

	it("is false once the reply is longer than the clarification length cap", () => {
		const longQuestion = `${"word ".repeat(80)}?`;
		expect(looksLikeClarificationQuestion(longQuestion)).toBe(false);
	});

	it("is false for a reply that does not end in a question mark", () => {
		expect(looksLikeClarificationQuestion("Here is the answer.")).toBe(false);
	});
});

describe("generateFollowUpSuggestions", () => {
	beforeEach(() => {
		callShortLocalControlModelMock.mockReset();
	});

	it("asks the control model with the right feature/model/cap/timeout/schema and returns the parsed suggestions", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: ["What about the sequel?", "Any similar examples?"],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Tell me about the movie.",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toEqual(["What about the sequel?", "Any similar examples?"]);
		expect(callShortLocalControlModelMock).toHaveBeenCalledTimes(1);
		const [args] = callShortLocalControlModelMock.mock.calls[0] as [
			{
				feature: string;
				modelId?: string;
				maxConcurrent?: number;
				timeoutMs?: number;
				jsonSchema?: unknown;
				userId: string;
				conversationId: string;
			},
		];
		expect(args.feature).toBe(FOLLOW_UP_SUGGESTIONS_FEATURE);
		expect(args.modelId).toBe("model2");
		expect(args.maxConcurrent).toBe(FOLLOW_UP_SUGGESTIONS_MAX_CONCURRENT);
		expect(args.timeoutMs).toBe(FOLLOW_UP_SUGGESTIONS_TIMEOUT_MS);
		expect(args.jsonSchema).toBeDefined();
		expect(args.userId).toBe("u1");
		expect(args.conversationId).toBe("c1");
	});

	it("returns the best two of the three candidates it asks for", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: ["Draft the email?", "Compare the two options?", "Cost?"],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Tell me about the movie.",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toEqual(["Draft the email?", "Compare the two options?"]);
		expect(result).toHaveLength(FOLLOW_UP_SUGGESTIONS_COUNT);
		const [args] = callShortLocalControlModelMock.mock.calls[0] as [
			{ systemPrompt: string; maxTokens: number },
		];
		// The prompt asks for three candidates even though two are returned.
		expect(args.systemPrompt).toContain(
			`Write exactly ${FOLLOW_UP_SUGGESTIONS_REQUESTED_COUNT} candidate questions`,
		);
		expect(args.systemPrompt).toContain(
			`at most ${FOLLOW_UP_SUGGESTIONS_MAX_WORDS} words`,
		);
		expect(args.systemPrompt).toContain("[string, string, string]");
		// Next-step framing, not comprehension checks.
		expect(args.systemPrompt).toContain("Draft the email?");
		expect(args.systemPrompt).toContain(
			"Never ask something the reply already answers",
		);
		expect(args.systemPrompt).toContain(
			"Never restate or rephrase anything the user has already asked",
		);
		expect(args.maxTokens).toBeGreaterThanOrEqual(120);
	});

	it("keeps the first two survivors when a candidate fails the filter", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: [
						"Not a question at all",
						"Draft the email?",
						"Compare the options?",
					],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toEqual(["Draft the email?", "Compare the options?"]);
	});

	it("puts the recent turns and the reply's head AND tail in the prompt", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(JSON.stringify({ followUps: ["Draft the email?"] })),
		);
		const reply = `HEAD_MARKER ${"filler ".repeat(1200)}TAIL_MARKER`;

		await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "And after that?",
			assistantResponse: reply,
			recentHistory: [
				{ role: "user", content: "What is the deadline?" },
				{ role: "assistant", content: "It is next Friday." },
			],
		});

		const [args] = callShortLocalControlModelMock.mock.calls[0] as [
			{ message: string },
		];
		expect(args.message).toContain("Earlier in this conversation:");
		expect(args.message).toContain("User: What is the deadline?");
		expect(args.message).toContain("Assistant: It is next Friday.");
		expect(args.message).toContain("Latest user message:\nAnd after that?");
		// Both ends of a reply too long for the budget survive, with the
		// truncated middle marked.
		expect(args.message).toContain("HEAD_MARKER");
		expect(args.message).toContain("TAIL_MARKER");
		expect(args.message).toContain("[…]");
		expect(args.message.length).toBeLessThan(reply.length);
	});

	it("keeps only the last three turns of history, truncated per message", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(JSON.stringify({ followUps: ["Draft the email?"] })),
		);

		await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "And after that?",
			assistantResponse: LONG_REPLY,
			recentHistory: [
				{ role: "user", content: "OLDEST_MARKER dropped turn" },
				{ role: "assistant", content: "dropped answer" },
				{ role: "user", content: "q2" },
				{ role: "assistant", content: "a2" },
				{ role: "user", content: "q3" },
				{ role: "assistant", content: "a3" },
				{ role: "user", content: `LONG_MARKER ${"x".repeat(600)}` },
				{ role: "assistant", content: "a4" },
			],
		});

		const [args] = callShortLocalControlModelMock.mock.calls[0] as [
			{ message: string },
		];
		expect(args.message).not.toContain("OLDEST_MARKER");
		expect(args.message).toContain("LONG_MARKER");
		expect(args.message).toContain("User: q3");
		const historyLine = args.message
			.split("\n")
			.find((line) => line.includes("LONG_MARKER")) as string;
		expect(historyLine.length).toBeLessThanOrEqual("User: ".length + 300);
	});

	it("writes the rules and the action example in Hungarian for a Hungarian turn", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(JSON.stringify({ followUps: ["Megírod az e-mailt?"] })),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Mesélj a filmről kérlek.",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toEqual(["Megírod az e-mailt?"]);
		const [args] = callShortLocalControlModelMock.mock.calls[0] as [
			{ systemPrompt: string },
		];
		expect(args.systemPrompt).toContain("in Hungarian");
		expect(args.systemPrompt).toContain("Megírod az e-mailt?");
		expect(args.systemPrompt).not.toContain("Draft the email?");
	});

	it("omits the history section entirely when there are no prior turns", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(JSON.stringify({ followUps: ["Draft the email?"] })),
		);

		await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
			recentHistory: [{ role: "user", content: "   " }],
		});

		const [args] = callShortLocalControlModelMock.mock.calls[0] as [
			{ message: string },
		];
		expect(args.message).not.toContain("Earlier in this conversation:");
		expect(args.message.startsWith("Latest user message:")).toBe(true);
	});

	it("caps the result at two suggestions even when the model returns more", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: ["First one?", "Second one?", "Third one?"],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toEqual(["First one?", "Second one?"]);
	});

	it("drops duplicate suggestions (case-insensitively) before capping", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: ["Same one?", "same one?", "Different one?"],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toEqual(["Same one?", "Different one?"]);
	});

	it("drops implausible candidates but keeps the plausible ones", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: ["This one has, extra punctuation?", "A fine follow-up?"],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toEqual(["A fine follow-up?"]);
	});

	it("returns null when every candidate is implausible", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(JSON.stringify({ followUps: ["no question mark here"] })),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toBeNull();
	});

	it("returns null when the control model call itself fails/times out (cap miss etc.)", async () => {
		callShortLocalControlModelMock.mockResolvedValue(null);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toBeNull();
	});

	it("returns null on malformed JSON without throwing", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult("not json at all"),
		);

		await expect(
			generateFollowUpSuggestions({
				userId: "u1",
				conversationId: "c1",
				userMessage: "hi",
				assistantResponse: LONG_REPLY,
			}),
		).resolves.toBeNull();
	});

	it("skips the control-model call entirely for a reply below the minimum length", async () => {
		const shortReply = "A".repeat(FOLLOW_UP_SUGGESTIONS_MIN_CONTENT_LENGTH - 1);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: shortReply,
		});

		expect(result).toBeNull();
		expect(callShortLocalControlModelMock).not.toHaveBeenCalled();
	});

	it("skips the control-model call when the reply itself looks like a clarification question", async () => {
		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Book me a flight.",
			assistantResponse: "Which city did you want to fly to?",
		});

		expect(result).toBeNull();
		expect(callShortLocalControlModelMock).not.toHaveBeenCalled();
	});
});
