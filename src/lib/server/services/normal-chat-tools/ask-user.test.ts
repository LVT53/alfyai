import { asSchema } from "@ai-sdk/provider-utils";
import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAskQuestion } from "$lib/server/services/chat-turn/ask-questions";
import {
	ASK_LIMITS,
	type AskAnswer,
	type AskQuestion,
} from "$lib/shared/ask-user";
import {
	askUserInputSchema,
	buildAskAnswerRecord,
	createAskUserTool,
} from "./ask-user";
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

	// Owner, 2026-11-05, after the real-model measurement: one refusal names every problem of a
	// card. A card that broke a count and a mark used to be refused twice (the schema named the
	// count before `execute` ran, and the tool named the mark on the next try), at 4 to 7 seconds
	// a model step.
	describe("a card that breaks several rules", () => {
		const fiveAnswers: AskQuestion = {
			question: "Which format should the summary take?",
			options: [
				{ label: "Short bullets", recommended: true },
				{ label: "A paragraph" },
				{ label: "A table" },
				{ label: "A mind map" },
				{ label: "A poem" },
			],
		};
		const noMark: AskQuestion = {
			question: "How long should it be?",
			options: [{ label: "Short" }, { label: "Long" }],
		};
		const REFUSAL = [
			"Question 1 needs 2 to 4 options.",
			"Question 2 takes one pick: mark exactly one of its options recommended.",
		].join("\n");

		it("is refused once, with a line for each problem, records nothing and does not pause", async () => {
			const base = { ...ctx(), canPause: true };
			const { tool, getTurnAsk } = createAskUserTool(base);

			expect(
				await tool.execute(
					{ questions: [fiveAnswers, noMark] },
					opts("call-1"),
				),
			).toEqual({
				ok: false,
				errorCode: "invalid_questions",
				message: REFUSAL,
			});

			expect(recordAskQuestionMock).not.toHaveBeenCalled();
			expect(getTurnAsk()).toBeNull();
			// The recorded call says what the model was told, so a later turn replays it.
			expect(base.recorder.getEntries()).toMatchObject([
				{
					callId: "call-1",
					name: "ask_user",
					status: "done",
					outputSummary: REFUSAL,
					metadata: { ok: false, reason: "invalid_questions" },
				},
			]);
		});

		it("does not use up the ask: the card the model fixes from the refusal is asked", async () => {
			const { tool, getTurnAsk } = createAskUserTool({
				...ctx(),
				canPause: true,
			});
			const fixed: AskQuestion[] = [
				{ ...fiveAnswers, options: fiveAnswers.options.slice(0, 4) },
				{
					...noMark,
					options: [{ label: "Short", recommended: true }, { label: "Long" }],
				},
			];

			const refused = await tool.execute(
				{ questions: [fiveAnswers, noMark] },
				opts("call-1"),
			);
			expect(refused).toMatchObject({ errorCode: "invalid_questions" });

			expect(await tool.execute({ questions: fixed }, opts("call-2"))).toEqual({
				status: "waiting_for_user",
				note: PAUSE_NOTE,
			});
			expect(recordAskQuestionMock).toHaveBeenCalledTimes(1);
			expect(getTurnAsk()).toMatchObject({
				toolCallId: "call-2",
				questions: fixed,
			});
		});
	});

	// Owner, 2026-11-05: up to four answers a question.
	it("asks a question with four answers, and refuses one with five", async () => {
		const { tool, getTurnAsk } = createAskUserTool({
			...ctx(),
			canPause: true,
		});
		const options = [
			{ label: "A", recommended: true },
			{ label: "B" },
			{ label: "C" },
			{ label: "D" },
		];

		expect(
			await tool.execute(
				{
					questions: [
						{ question: "Which one?", options: [...options, { label: "E" }] },
					],
				},
				opts("call-1"),
			),
		).toEqual({
			ok: false,
			errorCode: "invalid_questions",
			message: "Question 1 needs 2 to 4 options.",
		});
		expect(recordAskQuestionMock).not.toHaveBeenCalled();

		expect(
			await tool.execute(
				{ questions: [{ question: "Which one?", options }] },
				opts("call-2"),
			),
		).toEqual({ status: "waiting_for_user", note: PAUSE_NOTE });
		expect(getTurnAsk()).toMatchObject({ toolCallId: "call-2" });
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

	// The schema is what `execute` needs and nothing more: the shape. The counts, the lengths and
	// the Recommended rule are `checkAskQuestions`'s, which names every problem of the card at
	// once. A schema that checked them refused a card for what it found first, in the SDK's own
	// wording with the whole input echoed back, and the rest only on the next try. The model is
	// still shown the caps (the JSON schema below), which is how it learns them.
	it("lets a card that breaks a cap or a rule through, for the check to name", () => {
		const many = (n: number, make: () => unknown) =>
			Array.from({ length: n }, make);
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

		// counts
		expect(accepts({ questions: [] })).toBe(true);
		expect(
			accepts({ questions: many(ASK_LIMITS.maxQuestions + 1, oneQuestion) }),
		).toBe(true);
		expect(
			accepts({ questions: [oneQuestion({ options: [option("A")] })] }),
		).toBe(true);
		expect(
			accepts({
				questions: [
					oneQuestion({
						options: many(ASK_LIMITS.maxOptions + 1, () => option("A")),
					}),
				],
			}),
		).toBe(true);
		// lengths, and empty texts
		expect(
			accepts(withQuestion("q".repeat(ASK_LIMITS.questionChars + 1))),
		).toBe(true);
		expect(accepts(withQuestion(""))).toBe(true);
		expect(accepts(withLabel("l".repeat(ASK_LIMITS.labelChars + 1)))).toBe(
			true,
		);
		expect(accepts(withLabel(""))).toBe(true);
		expect(accepts(withNote("n".repeat(ASK_LIMITS.noteChars + 1)))).toBe(true);
		expect(accepts(withNote(""))).toBe(true);
		// the Recommended rule
		expect(
			accepts({
				questions: [oneQuestion({ options: [option("A"), option("B")] })],
			}),
		).toBe(true);
	});

	it("still refuses what is not a card at all: the wrong types and the missing fields", () => {
		const refuses = (input: unknown) =>
			askUserInputSchema.safeParse(input).success === false;

		for (const bad of [
			undefined,
			null,
			{},
			{ questions: "A or B" },
			{ questions: [null] },
			{ questions: [{ options: [option("A", true), option("B")] }] },
			{ questions: [{ question: "Which one?" }] },
			{ questions: [oneQuestion({ options: "A, B" })] },
			{ questions: [oneQuestion({ options: [{ label: 5 }, option("B")] })] },
			{
				questions: [
					oneQuestion({ options: [{ note: "no label" }, option("B")] }),
				],
			},
			{ questions: [oneQuestion({ multiple: "yes" })] },
			{
				questions: [
					oneQuestion({
						options: [{ label: "A", recommended: "yes" }, option("B")],
					}),
				],
			},
			{
				questions: [
					oneQuestion({ options: [{ label: "A", note: 3 }, option("B")] }),
				],
			},
		]) {
			expect(refuses(bad), JSON.stringify(bad)).toBe(true);
		}
	});

	it("is the validation the tool runs: a card that breaks a cap reaches execute, a malformed one does not", async () => {
		const { tool } = createAskUserTool(ctx());
		const { validate } = asSchema(tool.inputSchema);
		const fiveAnswers = {
			questions: [
				oneQuestion({
					options: Array.from({ length: ASK_LIMITS.maxOptions + 1 }, (_, i) =>
						option(`Option ${i}`),
					),
				}),
			],
		};

		expect(await validate?.(fiveAnswers)).toMatchObject({ success: true });
		expect(
			await validate?.({
				questions: [{ question: "Which one?", options: "A, B" }],
			}),
		).toMatchObject({ success: false });
	});
});

// What the model is shown of the tool's input: the JSON schema the request carries. It
// is how the model learns the caps before it writes a card, so it says them, in the
// keywords (`maxItems`, `maxLength`) and in the words of the field descriptions.
describe("the JSON schema the model reads", () => {
	type Field = {
		description?: string;
		minItems?: number;
		maxItems?: number;
		maxLength?: number;
	};
	type Shown = {
		properties: {
			questions: Field & {
				items: {
					properties: {
						question: Field;
						options: Field & {
							items: { properties: { label: Field; note: Field } };
						};
					};
				};
			};
		};
	};

	function shownToTheModel(): Shown["properties"]["questions"] {
		const { tool } = createAskUserTool(ctx());
		const schema = asSchema(tool.inputSchema).jsonSchema as unknown as Shown;
		return schema.properties.questions;
	}

	it("carries every count and length the vocabulary sets", () => {
		const questions = shownToTheModel();
		const { question, options } = questions.items.properties;
		const { label, note } = options.items.properties;

		expect([questions.minItems, questions.maxItems]).toEqual([
			ASK_LIMITS.minQuestions,
			ASK_LIMITS.maxQuestions,
		]);
		expect([options.minItems, options.maxItems]).toEqual([
			ASK_LIMITS.minOptions,
			ASK_LIMITS.maxOptions,
		]);
		expect(question.maxLength).toBe(ASK_LIMITS.questionChars);
		expect(label.maxLength).toBe(ASK_LIMITS.labelChars);
		expect(note.maxLength).toBe(ASK_LIMITS.noteChars);
	});

	it("says the counts in words, as the vocabulary sets them", () => {
		const questions = shownToTheModel();
		const { options } = questions.items.properties;

		expect(questions.description).toMatch(/^1-3 questions\b/);
		// 2026-11-05: up to four answers a question (it said 2-3)
		expect(options.description).toMatch(/^2-4 options\b/);
		expect(options.description).toContain(
			`${ASK_LIMITS.minOptions}-${ASK_LIMITS.maxOptions} options`,
		);
	});
});

// What the model reads once the person has answered: fixed English around the
// person's own labels and words (ruling 79). The resume's slot for the ask's
// result, and the line and detail that later turns' history replays for it.
describe("buildAskAnswerRecord", () => {
	const ANSWERED_NOTE =
		"The user answered. Go on with the same reply from where it paused; do not repeat what is already written.";
	const LEFT_TO_YOU_NOTE =
		"The user left these choices to you: take your recommended option where you marked one, else your best judgment, and go on with the same reply.";
	const CLOSED_NOTE =
		"The user closed the question without answering. It may have been off. Go on with your best judgment or ask differently, and never ask the same thing again.";

	const party: AskQuestion[] = [
		{
			question: "Which way should we take it?",
			options: [
				{ label: "A party at home", recommended: true },
				{ label: "A table at a restaurant" },
			],
		},
	];
	const toppings: AskQuestion = {
		question: "Which toppings?",
		multiple: true,
		options: [
			{ label: "Olives" },
			{ label: "Mushrooms", recommended: true },
			{ label: "Peppers" },
		],
	};

	it("tells the model the picked labels, own words, a choice left to it, or the X, in fixed English", () => {
		const picked = buildAskAnswerRecord(party, {
			kind: "answered",
			answers: [{ picked: [0], ownWords: null }],
		});
		expect(picked.result).toEqual({
			status: "answered",
			answers: [
				{
					question: "Which way should we take it?",
					picked: ["A party at home"],
				},
			],
			note: ANSWERED_NOTE,
		});
		expect(picked.outputSummary).toBe("The user picked: A party at home");

		const ownWords = buildAskAnswerRecord(party, {
			kind: "answered",
			answers: [{ picked: [], ownWords: "Something outdoors, near the lake" }],
		});
		expect(ownWords.result).toEqual({
			status: "answered",
			answers: [
				{
					question: "Which way should we take it?",
					ownWords: "Something outdoors, near the lake",
				},
			],
			note: ANSWERED_NOTE,
		});
		expect(ownWords.outputSummary).toBe("The user answered in their own words");

		const leftToAlfy = buildAskAnswerRecord(party, { kind: "left_to_alfy" });
		expect(leftToAlfy.result).toEqual({
			status: "left_to_you",
			answers: [
				{
					question: "Which way should we take it?",
					recommended: ["A party at home"],
				},
			],
			note: LEFT_TO_YOU_NOTE,
		});
		expect(leftToAlfy.outputSummary).toBe("The user left it to Alfy");

		const closed = buildAskAnswerRecord(party, { kind: "closed" });
		expect(closed.result).toEqual({ status: "closed", note: CLOSED_NOTE });
		expect(closed.outputSummary).toBe("The user closed the question");
	});

	it("joins several picked labels, and says how many questions were answered when there are several", () => {
		const several = buildAskAnswerRecord([toppings], {
			kind: "answered",
			answers: [{ picked: [0, 2], ownWords: null }],
		});
		expect(several.result).toMatchObject({
			status: "answered",
			answers: [{ question: "Which toppings?", picked: ["Olives", "Peppers"] }],
		});
		expect(several.outputSummary).toBe("The user picked: Olives, Peppers");

		const two = buildAskAnswerRecord([...party, toppings], {
			kind: "answered",
			answers: [
				{ picked: [1], ownWords: null },
				{ picked: [], ownWords: "None, thanks" },
			],
		});
		expect(two.result).toEqual({
			status: "answered",
			answers: [
				{
					question: "Which way should we take it?",
					picked: ["A table at a restaurant"],
				},
				{ question: "Which toppings?", ownWords: "None, thanks" },
			],
			note: ANSWERED_NOTE,
		});
		expect(two.outputSummary).toBe("The user answered 2 questions");
	});

	it("names every recommended option of a question that takes several, and none where nothing was marked", () => {
		const record = buildAskAnswerRecord(
			[
				{
					...toppings,
					options: [
						{ label: "Olives", recommended: true },
						{ label: "Mushrooms", recommended: true },
						{ label: "Peppers" },
					],
				},
				{
					question: "Which sizes?",
					multiple: true,
					options: [{ label: "Small" }, { label: "Large" }],
				},
			],
			{ kind: "left_to_alfy" },
		);

		expect(record.result).toEqual({
			status: "left_to_you",
			answers: [
				{ question: "Which toppings?", recommended: ["Olives", "Mushrooms"] },
				{ question: "Which sizes?" },
			],
			note: LEFT_TO_YOU_NOTE,
		});
	});

	it("keeps the person's words and the labels as they are, in whatever language, and writes only ASCII itself", () => {
		const hungarian: AskQuestion[] = [
			{
				question: "Melyik színt válasszuk?",
				options: [{ label: "Zöld", recommended: true }, { label: "Kék" }],
			},
		];
		const picked = buildAskAnswerRecord(hungarian, {
			kind: "answered",
			answers: [{ picked: [1], ownWords: null }],
		});
		const own = buildAskAnswerRecord(hungarian, {
			kind: "answered",
			answers: [{ picked: [], ownWords: "őszülő árnyalat" }],
		});

		expect(picked.outputSummary).toBe("The user picked: Kék");
		expect(own.result).toMatchObject({
			answers: [{ ownWords: "őszülő árnyalat" }],
		});
		// the notes and the summaries of the other kinds are the app's own words
		for (const answer of [
			{ kind: "left_to_alfy" },
			{ kind: "closed" },
		] satisfies AskAnswer[]) {
			const record = buildAskAnswerRecord(hungarian, answer);
			expect(record.result.note).toMatch(/^[\x20-\x7e]+$/);
			expect(record.outputSummary).toMatch(/^[\x20-\x7e]+$/);
		}
		expect(picked.result.note).toMatch(/^[\x20-\x7e]+$/);
	});

	it("gives the digest a later turn's history replays: the answers where the summary cannot carry them, and nothing for a choice left to Alfy or the X", () => {
		const own = buildAskAnswerRecord([...party, toppings], {
			kind: "answered",
			answers: [
				{ picked: [0], ownWords: null },
				{ picked: [], ownWords: "None,\nthanks" },
			],
		});
		expect(own.resultDigest).toBe(
			[
				"answers:",
				"- Which way should we take it?: A party at home",
				'- Which toppings?: "None, thanks"',
			].join("\n"),
		);

		expect(
			buildAskAnswerRecord(party, { kind: "left_to_alfy" }).resultDigest,
		).toBe("");
		expect(buildAskAnswerRecord(party, { kind: "closed" }).resultDigest).toBe(
			"",
		);
	});

	it("says only that the user answered when no pick names an option", () => {
		const record = buildAskAnswerRecord(party, {
			kind: "answered",
			answers: [{ picked: [7], ownWords: null }],
		});

		expect(record.outputSummary).toBe("The user answered");
		expect(record.result).toMatchObject({
			answers: [{ question: "Which way should we take it?", picked: [] }],
		});
	});

	it("never throws on an answer that does not fit the questions: it leaves out what has no question or no option", () => {
		const record = buildAskAnswerRecord(party, {
			kind: "answered",
			answers: [
				{ picked: [5, 1], ownWords: null },
				{ picked: [0], ownWords: null },
			],
		});

		expect(record.result).toEqual({
			status: "answered",
			answers: [
				{
					question: "Which way should we take it?",
					picked: ["A table at a restaurant"],
				},
			],
			note: ANSWERED_NOTE,
		});
	});
});
