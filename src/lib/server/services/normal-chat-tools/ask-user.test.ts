import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAskQuestion } from "$lib/server/services/chat-turn/ask-questions";
import { ASK_LIMITS, type AskQuestion } from "$lib/shared/ask-user";
import { askUserInputSchema, createAskUserTool } from "./ask-user";
import { createToolCallRecorder } from "./shared";

// The store is the database; what the tool decides before and after it is what
// these tests are about.
vi.mock("$lib/server/services/chat-turn/ask-questions", () => ({
	recordAskQuestion: vi.fn(),
}));

const recordAskQuestionMock = vi.mocked(recordAskQuestion);

const PAUSE_NOTE = "Asked. The reply pauses here until the user chooses.";
const ONE_CARD_MESSAGE =
	"One card per pause: put every question into a single ask_user call.";
const ONE_PICK_MESSAGE =
	"Question 1 takes one pick: mark exactly one of its options recommended.";

const card: AskQuestion[] = [
	{
		question: "Which format should the summary take?",
		options: [
			{ label: "Short bullets", recommended: true },
			{ label: "A paragraph", note: "Reads like a letter." },
		],
	},
];

function ctx() {
	return {
		userId: "user-1",
		conversationId: "conv-1",
		canPause: false,
		recorder: createToolCallRecorder(),
		text: {
			description: "Ask the user.",
			errorPrefix: "Asking the user failed",
		},
	};
}

function opts(toolCallId: string): ToolExecutionOptions {
	return { toolCallId, messages: [] };
}

beforeEach(() => {
	recordAskQuestionMock.mockReset();
	recordAskQuestionMock.mockResolvedValue({ id: "q-1" });
});

describe("ask_user tool", () => {
	it("records the question and pauses when the turn can pause", async () => {
		const { tool, getTurnAsk } = createAskUserTool({
			...ctx(),
			canPause: true,
		});

		expect(await tool.execute({ questions: card }, opts("call-1"))).toEqual({
			status: "waiting_for_user",
			note: PAUSE_NOTE,
		});
		expect(recordAskQuestionMock).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			toolCallId: "call-1",
			questions: card,
		});
		expect(getTurnAsk()).toEqual({
			questionId: "q-1",
			toolCallId: "call-1",
			questions: card,
		});
	});

	it("records the call that paused as a done call that carries its question", async () => {
		const base = { ...ctx(), canPause: true };
		const { tool } = createAskUserTool(base);

		await tool.execute({ questions: card }, opts("call-1"));

		expect(base.recorder.getEntries()).toMatchObject([
			{
				callId: "call-1",
				name: "ask_user",
				input: { questions: card },
				status: "done",
				outputSummary: "Asked the user; the reply paused for the answer.",
				sourceType: "tool",
				metadata: { paused: true, questionId: "q-1" },
			},
		]);
		// A paused call is not a refusal: nothing marks it as one.
		expect(base.recorder.getEntries()[0]?.metadata).not.toHaveProperty("ok");
	});

	it("answers not_available and records nothing when the turn cannot pause", async () => {
		const base = ctx();
		const { tool, getTurnAsk } = createAskUserTool(base);

		expect(await tool.execute({ questions: card }, opts("call-1"))).toEqual({
			status: "not_available",
			note: "Asking is not available in this reply. Go on with your best judgment.",
		});

		expect(recordAskQuestionMock).not.toHaveBeenCalled();
		expect(getTurnAsk()).toBeNull();
		// The call itself is still recorded, as a done call that asked nothing.
		expect(base.recorder.getEntries()).toMatchObject([
			{
				callId: "call-1",
				name: "ask_user",
				input: { questions: card },
				status: "done",
				sourceType: "tool",
				metadata: { ok: false, reason: "not_available" },
			},
		]);
	});

	it("refuses a one-pick question without exactly one Recommended option, records nothing, and does not pause", async () => {
		const base = { ...ctx(), canPause: true };
		const { tool, getTurnAsk } = createAskUserTool(base);
		const noneRecommended: AskQuestion[] = [
			{
				question: "Which format should the summary take?",
				options: [{ label: "Short bullets" }, { label: "A paragraph" }],
			},
		];

		expect(
			await tool.execute({ questions: noneRecommended }, opts("call-1")),
		).toEqual({
			ok: false,
			errorCode: "invalid_questions",
			message: ONE_PICK_MESSAGE,
		});

		expect(recordAskQuestionMock).not.toHaveBeenCalled();
		expect(getTurnAsk()).toBeNull();
		expect(base.recorder.getEntries()).toMatchObject([
			{
				callId: "call-1",
				name: "ask_user",
				status: "done",
				outputSummary: ONE_PICK_MESSAGE,
				metadata: { ok: false, reason: "invalid_questions" },
			},
		]);
	});

	it("refuses a question that is only blank space", async () => {
		const { tool, getTurnAsk } = createAskUserTool({
			...ctx(),
			canPause: true,
		});
		const blank: AskQuestion[] = [
			{
				question: "   ",
				options: [{ label: "Yes", recommended: true }, { label: "No" }],
			},
		];

		expect(await tool.execute({ questions: blank }, opts("call-1"))).toEqual({
			ok: false,
			errorCode: "invalid_questions",
			message: "Question 1 has no text.",
		});
		expect(recordAskQuestionMock).not.toHaveBeenCalled();
		expect(getTurnAsk()).toBeNull();
	});

	it("lets a corrected call ask after an invalid one, since nothing was asked", async () => {
		const { tool, getTurnAsk } = createAskUserTool({
			...ctx(),
			canPause: true,
		});
		const noneRecommended: AskQuestion[] = [
			{
				question: "Which format should the summary take?",
				options: [{ label: "Short bullets" }, { label: "A paragraph" }],
			},
		];

		const refused = await tool.execute(
			{ questions: noneRecommended },
			opts("call-1"),
		);
		expect(refused).toMatchObject({ errorCode: "invalid_questions" });

		expect(await tool.execute({ questions: card }, opts("call-2"))).toEqual({
			status: "waiting_for_user",
			note: PAUSE_NOTE,
		});
		expect(recordAskQuestionMock).toHaveBeenCalledTimes(1);
		expect(getTurnAsk()).toMatchObject({ toolCallId: "call-2" });
	});

	it("refuses a second ask in the same turn, even in the same step", async () => {
		const base = { ...ctx(), canPause: true };
		const { tool } = createAskUserTool(base);
		const input = { questions: card };

		const [a, b] = await Promise.all([
			tool.execute(input, opts("a")),
			tool.execute(input, opts("b")),
		]);

		expect(recordAskQuestionMock).toHaveBeenCalledTimes(1);
		expect([a, b]).toContainEqual({
			ok: false,
			errorCode: "already_asked",
			message: ONE_CARD_MESSAGE,
		});
		expect([a, b]).toContainEqual({
			status: "waiting_for_user",
			note: PAUSE_NOTE,
		});
		// Both calls are recorded; only one of them paused.
		expect(base.recorder.getEntries()).toHaveLength(2);
		expect(
			base.recorder.getEntries().filter((entry) => entry.metadata?.paused),
		).toHaveLength(1);
	});

	it("refuses a second ask in a later step of the same turn", async () => {
		const { tool, getTurnAsk } = createAskUserTool({
			...ctx(),
			canPause: true,
		});

		await tool.execute({ questions: card }, opts("first"));
		const second = await tool.execute({ questions: card }, opts("second"));

		expect(second).toEqual({
			ok: false,
			errorCode: "already_asked",
			message: ONE_CARD_MESSAGE,
		});
		expect(recordAskQuestionMock).toHaveBeenCalledTimes(1);
		// The turn's ask stays the first one.
		expect(getTurnAsk()).toMatchObject({ toolCallId: "first" });
	});

	it("keeps each turn's ask apart", async () => {
		const first = createAskUserTool({ ...ctx(), canPause: true });
		const second = createAskUserTool({ ...ctx(), canPause: true });

		await first.tool.execute({ questions: card }, opts("first"));

		expect(second.getTurnAsk()).toBeNull();
		expect(
			await second.tool.execute({ questions: card }, opts("second")),
		).toMatchObject({ status: "waiting_for_user" });
	});

	it("answers ask_user_failed when the store fails", async () => {
		const base = { ...ctx(), canPause: true };
		const { tool, getTurnAsk } = createAskUserTool(base);
		recordAskQuestionMock.mockRejectedValueOnce(new Error("disk full"));

		expect(await tool.execute({ questions: card }, opts("call-1"))).toEqual({
			ok: false,
			errorCode: "ask_user_failed",
			message: "disk full",
		});

		expect(getTurnAsk()).toBeNull();
		expect(base.recorder.getEntries()).toMatchObject([
			{
				callId: "call-1",
				name: "ask_user",
				status: "done",
				metadata: { ok: false, reason: "ask_user_failed" },
			},
		]);
	});

	it("falls back to the error prefix when the failure says nothing", async () => {
		const { tool } = createAskUserTool({ ...ctx(), canPause: true });
		recordAskQuestionMock.mockRejectedValueOnce("");

		expect(await tool.execute({ questions: card }, opts("call-1"))).toEqual({
			ok: false,
			errorCode: "ask_user_failed",
			message: "Asking the user failed",
		});
	});

	it("lets the model ask again after a failed store, since no card was asked", async () => {
		const { tool, getTurnAsk } = createAskUserTool({
			...ctx(),
			canPause: true,
		});
		recordAskQuestionMock.mockRejectedValueOnce(new Error("busy"));

		const failed = await tool.execute({ questions: card }, opts("call-1"));
		expect(failed).toMatchObject({ errorCode: "ask_user_failed" });

		expect(await tool.execute({ questions: card }, opts("call-2"))).toEqual({
			status: "waiting_for_user",
			note: PAUSE_NOTE,
		});
		expect(getTurnAsk()).toEqual({
			questionId: "q-1",
			toolCallId: "call-2",
			questions: card,
		});
	});

	it("answers ask_user_failed, and asks nothing, when the call is already aborted", async () => {
		const { tool, getTurnAsk } = createAskUserTool({
			...ctx(),
			canPause: true,
		});
		const controller = new AbortController();
		controller.abort(new Error("stopped"));

		const result = await tool.execute(
			{ questions: card },
			{ ...opts("call-1"), abortSignal: controller.signal },
		);

		expect(result).toMatchObject({ ok: false, errorCode: "ask_user_failed" });
		expect(recordAskQuestionMock).not.toHaveBeenCalled();
		expect(getTurnAsk()).toBeNull();
	});
});

describe("askUserInputSchema", () => {
	const option = (label: string, recommended = false) => ({
		label,
		...(recommended ? { recommended } : {}),
	});
	const oneQuestion = (overrides: Record<string, unknown> = {}) => ({
		question: "Which one?",
		options: [option("A", true), option("B")],
		...overrides,
	});

	it("accepts a card, with and without multiple and notes", () => {
		expect(askUserInputSchema.safeParse({ questions: card }).success).toBe(
			true,
		);
		expect(
			askUserInputSchema.safeParse({
				questions: [
					oneQuestion({ multiple: true }),
					oneQuestion({
						options: [{ label: "A", note: "n" }, option("B"), option("C")],
					}),
					oneQuestion(),
				],
			}).success,
		).toBe(true);
	});

	it("holds the counts the vocabulary sets", () => {
		const many = (n: number, make: () => unknown) =>
			Array.from({ length: n }, make);
		const accepts = (input: unknown) =>
			askUserInputSchema.safeParse(input).success;

		expect(accepts({ questions: [] })).toBe(false);
		expect(
			accepts({ questions: many(ASK_LIMITS.maxQuestions, oneQuestion) }),
		).toBe(true);
		expect(
			accepts({ questions: many(ASK_LIMITS.maxQuestions + 1, oneQuestion) }),
		).toBe(false);
		expect(
			accepts({ questions: [oneQuestion({ options: [option("A")] })] }),
		).toBe(false);
		expect(
			accepts({
				questions: [
					oneQuestion({
						options: many(ASK_LIMITS.maxOptions + 1, () => option("A")),
					}),
				],
			}),
		).toBe(false);
	});

	it("holds the lengths the vocabulary sets, and refuses an empty text", () => {
		const accepts = (input: unknown) =>
			askUserInputSchema.safeParse(input).success;
		const withQuestion = (question: string) => ({
			questions: [oneQuestion({ question })],
		});
		const withLabel = (label: string) => ({
			questions: [oneQuestion({ options: [option(label, true), option("B")] })],
		});
		const withNote = (note: string) => ({
			questions: [
				oneQuestion({
					options: [{ label: "A", note, recommended: true }, option("B")],
				}),
			],
		});

		expect(accepts(withQuestion("q".repeat(ASK_LIMITS.questionChars)))).toBe(
			true,
		);
		expect(
			accepts(withQuestion("q".repeat(ASK_LIMITS.questionChars + 1))),
		).toBe(false);
		expect(accepts(withQuestion(""))).toBe(false);
		expect(accepts(withLabel("l".repeat(ASK_LIMITS.labelChars)))).toBe(true);
		expect(accepts(withLabel("l".repeat(ASK_LIMITS.labelChars + 1)))).toBe(
			false,
		);
		expect(accepts(withLabel(""))).toBe(false);
		expect(accepts(withNote("n".repeat(ASK_LIMITS.noteChars)))).toBe(true);
		expect(accepts(withNote("n".repeat(ASK_LIMITS.noteChars + 1)))).toBe(false);
		expect(accepts(withNote(""))).toBe(false);
	});
});
