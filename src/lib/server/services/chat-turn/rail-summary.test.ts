import { beforeEach, describe, expect, it, vi } from "vitest";

// The post-turn rail-summary step is the first real consumer of A2's
// `generateShortLocalText` seam. It lives in its own small module so it can be
// exercised hermetically: mock the generator and the persistence write-back,
// and drive only the skip/cap/timeout/degrade/persist behavior — no vLLM, no
// DB, no giant finalize dependency graph.
const { generateShortLocalTextMock, updateMessageRailSummaryMock } = vi.hoisted(
	() => ({
		generateShortLocalTextMock: vi.fn(),
		updateMessageRailSummaryMock: vi.fn(async () => {}),
	}),
);

vi.mock("./short-local-text", () => ({
	generateShortLocalText: generateShortLocalTextMock,
	// Deterministic stand-in for the real resolver (accents -> Hungarian). The
	// real one is exercised in short-local-text.test.ts; here we only need a
	// stable language signal.
	resolveShortTextLanguage: (message: string) =>
		/[áéíóöőúüű]/i.test(message) ? "hu" : "en",
}));

vi.mock("$lib/server/services/messages", () => ({
	updateMessageRailSummary: updateMessageRailSummaryMock,
}));

import {
	persistAssistantRailSummary,
	RAIL_SUMMARY_FEATURE,
	RAIL_SUMMARY_MAX_CONCURRENT,
	RAIL_SUMMARY_MIN_CONTENT_LENGTH,
	RAIL_SUMMARY_TIMEOUT_MS,
} from "./rail-summary";

// A reply comfortably above the skip threshold so generation is attempted.
const LONG_REPLY = `${"A long, substantive assistant answer that runs well past the glanceable verbatim start so the rail summary is worth generating. ".repeat(3)}`;

describe("persistAssistantRailSummary", () => {
	beforeEach(() => {
		generateShortLocalTextMock.mockReset();
		updateMessageRailSummaryMock.mockClear();
	});

	it("generates a summary for a long reply and persists it, passing the concurrency cap and timeout", async () => {
		generateShortLocalTextMock.mockResolvedValue("Concise Headline");

		await persistAssistantRailSummary({
			userId: "u1",
			conversationId: "c1",
			assistantMessageId: "a1",
			userMessage: "How did Q3 segments perform?",
			assistantResponse: LONG_REPLY,
		});

		expect(generateShortLocalTextMock).toHaveBeenCalledTimes(1);
		const [args] = generateShortLocalTextMock.mock.calls[0] as [
			{
				feature: string;
				maxConcurrent?: number;
				timeoutMs?: number;
				prompt: string;
				userId: string;
				conversationId: string;
				language?: string;
			},
		];
		// A2's cap + timeout are OPT-IN — this step must pass both so it never
		// runs uncapped/untimed on the shared vLLM.
		expect(args.feature).toBe(RAIL_SUMMARY_FEATURE);
		expect(args.maxConcurrent).toBe(RAIL_SUMMARY_MAX_CONCURRENT);
		expect(args.timeoutMs).toBe(RAIL_SUMMARY_TIMEOUT_MS);
		expect(args.userId).toBe("u1");
		expect(args.conversationId).toBe("c1");

		expect(updateMessageRailSummaryMock).toHaveBeenCalledWith(
			"a1",
			"Concise Headline",
		);
	});

	it("summarizes the ASSISTANT reply, not the user message (assistant-only, O-3)", async () => {
		generateShortLocalTextMock.mockResolvedValue("Concise Headline");

		await persistAssistantRailSummary({
			userId: "u1",
			conversationId: "c1",
			assistantMessageId: "a1",
			userMessage: "How did Q3 segments perform?",
			assistantResponse: LONG_REPLY,
		});

		const [args] = generateShortLocalTextMock.mock.calls[0] as [
			{ prompt: string },
		];
		// The prompt is derived from the assistant reply, never the user turn.
		expect(args.prompt).toContain("substantive assistant answer");
		expect(args.prompt).not.toContain("How did Q3 segments perform?");
	});

	it("persists nothing when the generator returns null (silent degrade)", async () => {
		generateShortLocalTextMock.mockResolvedValue(null);

		await persistAssistantRailSummary({
			userId: "u1",
			conversationId: "c1",
			assistantMessageId: "a1",
			userMessage: "How did Q3 segments perform?",
			assistantResponse: LONG_REPLY,
		});

		expect(generateShortLocalTextMock).toHaveBeenCalledTimes(1);
		expect(updateMessageRailSummaryMock).not.toHaveBeenCalled();
	});

	it("skips generation for a short reply whose verbatim start is already glanceable", async () => {
		const shortReply = "A".repeat(RAIL_SUMMARY_MIN_CONTENT_LENGTH - 1);

		await persistAssistantRailSummary({
			userId: "u1",
			conversationId: "c1",
			assistantMessageId: "a1",
			userMessage: "hi",
			assistantResponse: shortReply,
		});

		expect(generateShortLocalTextMock).not.toHaveBeenCalled();
		expect(updateMessageRailSummaryMock).not.toHaveBeenCalled();
	});

	it("skips generation for an empty reply", async () => {
		await persistAssistantRailSummary({
			userId: "u1",
			conversationId: "c1",
			assistantMessageId: "a1",
			userMessage: "hi",
			assistantResponse: "   ",
		});

		expect(generateShortLocalTextMock).not.toHaveBeenCalled();
		expect(updateMessageRailSummaryMock).not.toHaveBeenCalled();
	});

	it("never throws when the persistence write-back fails (fire-and-forget)", async () => {
		generateShortLocalTextMock.mockResolvedValue("Concise Headline");
		updateMessageRailSummaryMock.mockRejectedValueOnce(new Error("db offline"));

		await expect(
			persistAssistantRailSummary({
				userId: "u1",
				conversationId: "c1",
				assistantMessageId: "a1",
				userMessage: "How did Q3 segments perform?",
				assistantResponse: LONG_REPLY,
			}),
		).resolves.toBeUndefined();
	});
});
