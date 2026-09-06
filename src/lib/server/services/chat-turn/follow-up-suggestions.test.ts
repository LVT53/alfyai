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
	FOLLOW_UP_SUGGESTIONS_FEATURE,
	FOLLOW_UP_SUGGESTIONS_MAX_CONCURRENT,
	FOLLOW_UP_SUGGESTIONS_MIN_CONTENT_LENGTH,
	FOLLOW_UP_SUGGESTIONS_TIMEOUT_MS,
	generateFollowUpSuggestions,
	isPlausibleFollowUpSuggestion,
	looksLikeClarificationQuestion,
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

	it("rejects a question longer than the max word count", () => {
		expect(
			isPlausibleFollowUpSuggestion(
				"Is this one single question far too long to ever pass the six word cap?",
			),
		).toBe(false);
	});

	it("rejects an empty or whitespace-only candidate", () => {
		expect(isPlausibleFollowUpSuggestion("   ")).toBe(false);
		expect(isPlausibleFollowUpSuggestion("?")).toBe(false);
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
