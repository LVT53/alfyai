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

import { checkFollowUpChip } from "./follow-up-chip";
import {
	FOLLOW_UP_CHIP_EXAMPLES,
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
	it("accepts a short question about a named thing", () => {
		expect(isPlausibleFollowUpSuggestion("What about the sequel?")).toBe(true);
	});

	it("accepts an instruction to the assistant, with no question mark", () => {
		// A chip is the user's next message: "Compare the two options in a table"
		// is how a person asks, and the old rule (a question mark was required)
		// threw it away.
		expect(
			isPlausibleFollowUpSuggestion("Compare the two options in a table", "en"),
		).toBe(true);
		expect(
			isPlausibleFollowUpSuggestion("Hasonlítsd össze a két opciót", "hu"),
		).toBe(true);
	});

	it("rejects the assistant offering, in both languages", () => {
		expect(
			isPlausibleFollowUpSuggestion(
				"Would you like me to draft the email?",
				"en",
			),
		).toBe(false);
		expect(
			isPlausibleFollowUpSuggestion("Szeretnéd rövidebbre venni?", "hu"),
		).toBe(false);
		expect(
			isPlausibleFollowUpSuggestion(
				"Írjam le a bemelegítő gyakorlatokat?",
				"hu",
			),
		).toBe(false);
	});

	it("rejects a question put to the user, in both languages", () => {
		expect(isPlausibleFollowUpSuggestion("What's your budget?", "en")).toBe(
			false,
		);
		expect(isPlausibleFollowUpSuggestion("Mennyi a kereted?", "hu")).toBe(
			false,
		);
	});

	it("rejects a generic chip, in both languages", () => {
		expect(isPlausibleFollowUpSuggestion("Tell me more")).toBe(false);
		expect(isPlausibleFollowUpSuggestion("Mondj többet erről", "hu")).toBe(
			false,
		);
	});

	it("rejects a chip in the other language than the turn's", () => {
		expect(
			isPlausibleFollowUpSuggestion(
				"Can you recommend specific ruin bars?",
				"hu",
			),
		).toBe(false);
		expect(
			isPlausibleFollowUpSuggestion("Melyik podcast appot ajánlod?", "en"),
		).toBe(false);
	});

	it("rejects a statement that is neither a question nor a request", () => {
		expect(isPlausibleFollowUpSuggestion("Not a question at all")).toBe(false);
	});

	it("rejects text with a sentence break inside", () => {
		expect(isPlausibleFollowUpSuggestion("Is that true. Really?")).toBe(false);
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
			`Write exactly ${FOLLOW_UP_SUGGESTIONS_REQUESTED_COUNT} candidate messages`,
		);
		expect(args.systemPrompt).toContain(
			`at most ${FOLLOW_UP_SUGGESTIONS_MAX_WORDS} words`,
		);
		expect(args.systemPrompt).toContain("[string, string, string]");
		// Next-step framing, not comprehension checks.
		expect(args.systemPrompt).toContain("Draft the email to the contractor");
		expect(args.systemPrompt).toContain(
			"Never ask for something the reply already gives",
		);
		expect(args.systemPrompt).toContain(
			"never repeat anything the user has already asked",
		);
		expect(args.maxTokens).toBeGreaterThanOrEqual(160);
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

	it("writes the rules and the examples in Hungarian for a Hungarian turn", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({ followUps: ["Írd meg az e-mailt a vendéglátónak"] }),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Mesélj a filmről kérlek.",
			assistantResponse: LONG_REPLY,
		});

		expect(result).toEqual(["Írd meg az e-mailt a vendéglátónak"]);
		const [args] = callShortLocalControlModelMock.mock.calls[0] as [
			{ systemPrompt: string },
		];
		expect(args.systemPrompt).toContain("in Hungarian");
		for (const example of FOLLOW_UP_CHIP_EXAMPLES.hu) {
			expect(args.systemPrompt).toContain(example);
		}
		expect(args.systemPrompt).not.toContain(
			"Draft the email to the contractor",
		);
	});

	it("writes in the language the turn resolved, whatever the latest message alone reads as", async () => {
		// The chat reply's language is decided once per turn (latest message, the
		// recent user messages, then the UI language). Read from the latest message
		// alone, a Hungarian message typed without accents, or one the detector has
		// too little evidence on, reads as English: on the real model 4 of 10
		// Hungarian conversations got English chips beside a Hungarian reply.
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({ followUps: ["Írd meg az e-mailt a vendéglátónak"] }),
			),
		);

		await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Mikor ultessem el a paradicsompalantakat?",
			assistantResponse: LONG_REPLY,
			responseLanguage: "hu",
		});
		const [hu] = callShortLocalControlModelMock.mock.calls[0] as [
			{ systemPrompt: string },
		];
		expect(hu.systemPrompt).toContain("in Hungarian");
		expect(hu.systemPrompt).toContain(FOLLOW_UP_CHIP_EXAMPLES.hu[0]);

		callShortLocalControlModelMock.mockClear();
		await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Mesélj a filmről kérlek, angolul.",
			assistantResponse: LONG_REPLY,
			responseLanguage: "en",
		});
		const [en] = callShortLocalControlModelMock.mock.calls[0] as [
			{ systemPrompt: string },
		];
		expect(en.systemPrompt).toContain("in English");
		expect(en.systemPrompt).toContain(FOLLOW_UP_CHIP_EXAMPLES.en[0]);
	});

	it("returns instructions that have no question mark, and drops the generic one", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: [
						"Compare the two options in a table",
						"Tell me more",
						"Draft the email to my landlord",
					],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Which flat should I take?",
			assistantResponse: LONG_REPLY,
			responseLanguage: "en",
		});

		expect(result).toEqual([
			"Compare the two options in a table",
			"Draft the email to my landlord",
		]);
	});

	it("drops the assistant's offers and questions to the user, keeps the user's own messages", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: [
						"Szeretnéd, hogy összeállítsak egy órarendet?",
						"Mennyi a kereted?",
						"Készíts bevásárlólistát a heti étrendhez",
						"Hogyan telepítem a Husky-t?",
					],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Segíts az étrenddel",
			assistantResponse: LONG_REPLY,
			responseLanguage: "hu",
		});

		expect(result).toEqual([
			"Készíts bevásárlólistát a heti étrendhez",
			"Hogyan telepítem a Husky-t?",
		]);
	});

	it("drops a chip written in the other language than the turn's", async () => {
		// On the real model a Hungarian conversation got "Can you recommend
		// specific ruin bars?" beside its Hungarian reply.
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: [
						"Can you recommend specific ruin bars?",
						"Oszd be a három napot óránként",
						"Foglald táblázatba a három nap programját",
					],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Három napot szeretnék Budapesten tölteni",
			assistantResponse: LONG_REPLY,
			responseLanguage: "hu",
		});

		expect(result).toEqual([
			"Oszd be a három napot óránként",
			"Foglald táblázatba a három nap programját",
		]);
	});

	it("persists a chip in its normalized form", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(
				JSON.stringify({
					followUps: [
						'"Compare the two options in a table."',
						"  Draft the  email. ",
					],
				}),
			),
		);

		const result = await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
			responseLanguage: "en",
		});

		expect(result).toEqual([
			"Compare the two options in a table",
			"Draft the email",
		]);
	});

	it("tells the model a chip is the user's next message, never the assistant's offer or a question to the user", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			controlResult(JSON.stringify({ followUps: ["Draft the email"] })),
		);

		await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: "hi",
			assistantResponse: LONG_REPLY,
			responseLanguage: "en",
		});

		const [args] = callShortLocalControlModelMock.mock.calls[0] as [
			{ systemPrompt: string },
		];
		const prompt = args.systemPrompt;
		expect(prompt).toContain("NEXT MESSAGE THE USER WOULD SEND");
		expect(prompt).toContain("exactly as written");
		expect(prompt).toContain("Each names what it acts on");
		expect(prompt).toContain('No offers ("Would you like me to…"');
		expect(prompt).toContain(
			'no questions to the user ("What is your budget?")',
		);
		expect(prompt).toContain("no statements about the user");
		expect(prompt).toContain(
			"Never answer a question the assistant asked the user",
		);
		expect(prompt).toContain(
			"If the reply ends by offering something, the first message accepts that offer",
		);
		expect(prompt).toContain('Avoid "you"');
		expect(prompt).toContain("never for sending, booking, buying or calling");
	});

	it("only teaches with examples that are themselves chips", () => {
		for (const language of ["en", "hu"] as const) {
			for (const example of FOLLOW_UP_CHIP_EXAMPLES[language]) {
				expect(
					checkFollowUpChip(example, {
						language,
						maxWords: FOLLOW_UP_SUGGESTIONS_MAX_WORDS,
					}),
				).toEqual({ ok: true, text: example });
			}
		}
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
					followUps: ["Would you like me to draft it?", "A fine follow-up?"],
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
			controlResult(
				JSON.stringify({
					followUps: [
						"no question mark here",
						"Tell me more",
						"What's your budget?",
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
