import { describe, expect, it } from "vitest";
import {
	ASK_LIMITS,
	ASK_PAUSE_STATUS,
	ASK_USER_TOOL_NAME,
	type AskQuestion,
	askCallPausedTheReply,
	checkAskAnswer,
	checkAskQuestions,
	isAskPauseOutput,
	isAskToolName,
	parseAskAnswer,
	parseAskQuestions,
} from "./ask-user";

const card: AskQuestion[] = [
	{
		question: "Which way should we take it?",
		options: [
			{
				label: "A party at home",
				note: "Easiest to organise, and the whole family can come",
				recommended: true,
			},
			{ label: "Dinner out, just close family" },
			{ label: "A weekend away together" },
		],
	},
];

/** The card's question with only its first `n` options marked recommended. */
function withRecommended(n: number, multiple?: boolean): AskQuestion {
	return {
		...card[0],
		...(multiple === undefined ? {} : { multiple }),
		options: card[0].options.map((option, index) => ({
			...option,
			recommended: index < n,
		})),
	};
}

/** A second question that takes several picks, to put beside the card's. */
const toppings: AskQuestion = {
	question: "Which extras do you want?",
	multiple: true,
	options: [{ label: "Music" }, { label: "Photos" }, { label: "A cake" }],
};

const oneAnswer = (picked: number[], ownWords: string | null) => ({
	picked,
	ownWords,
});

describe("the vocabulary", () => {
	it("fixes the tool name, the pause marker and the caps", () => {
		expect(ASK_USER_TOOL_NAME).toBe("ask_user");
		expect(ASK_PAUSE_STATUS).toBe("waiting_for_user");
		expect(ASK_LIMITS).toEqual({
			minQuestions: 1,
			maxQuestions: 3,
			minOptions: 2,
			maxOptions: 3,
			questionChars: 160,
			labelChars: 50,
			noteChars: 100,
			ownWordsChars: 500,
		});
	});
});

describe("checkAskQuestions", () => {
	it("takes the mockup's card", () =>
		expect(checkAskQuestions(card)).toEqual({ ok: true }));

	it("refuses a one-pick question with no Recommended option, or two", () => {
		const message =
			"Question 1 takes one pick: mark exactly one of its options recommended.";
		expect(
			checkAskQuestions([
				{
					...card[0],
					options: card[0].options.map((o) => ({ ...o, recommended: false })),
				},
			]),
		).toEqual({ ok: false, message });
		expect(checkAskQuestions([withRecommended(2)])).toEqual({
			ok: false,
			message,
		});
		expect(checkAskQuestions([withRecommended(3)])).toEqual({
			ok: false,
			message,
		});
		// "multiple: false" is a one-pick question as much as no flag at all
		expect(checkAskQuestions([withRecommended(0, false)])).toEqual({
			ok: false,
			message,
		});
	});

	it("names the question that breaks the rule by its 1-based number", () => {
		expect(checkAskQuestions([card[0], withRecommended(0)])).toEqual({
			ok: false,
			message:
				"Question 2 takes one pick: mark exactly one of its options recommended.",
		});
	});

	it("takes a several-pick question with any number of Recommended options, none included", () => {
		for (const n of [0, 1, 2, 3]) {
			expect(checkAskQuestions([withRecommended(n, true)])).toEqual({
				ok: true,
			});
		}
		expect(checkAskQuestions([card[0], toppings])).toEqual({ ok: true });
	});

	const cases: Array<[string, AskQuestion[], string]> = [
		["no question", [], "Ask 1 to 3 questions."],
		[
			"four questions",
			[card[0], card[0], card[0], card[0]],
			"Ask 1 to 3 questions.",
		],
		[
			"a question with one option",
			[{ ...card[0], options: card[0].options.slice(0, 1) }],
			"Question 1 needs 2 to 3 options.",
		],
		[
			"a question with four options",
			[{ ...card[0], options: [...card[0].options, { label: "Stay in" }] }],
			"Question 1 needs 2 to 3 options.",
		],
		[
			"a question without text",
			[card[0], { ...card[0], question: "  " }],
			"Question 2 has no text.",
		],
		[
			"a question over 160 characters",
			[{ ...card[0], question: "x".repeat(161) }],
			"Question 1 is longer than 160 characters.",
		],
		[
			"an option without a label",
			[{ ...card[0], options: [card[0].options[0], { label: " " }] }],
			"Option 2 of question 1 has no label.",
		],
		[
			"a label over 50 characters",
			[
				{
					...card[0],
					options: [card[0].options[0], { label: "x".repeat(51) }],
				},
			],
			"Option 2 of question 1 has a label longer than 50 characters.",
		],
		[
			"a note over 100 characters",
			[
				{
					...card[0],
					options: [
						{
							label: "A party at home",
							note: "x".repeat(101),
							recommended: true,
						},
						card[0].options[1],
					],
				},
			],
			"Option 1 of question 1 has a note longer than 100 characters.",
		],
	];

	for (const [name, questions, message] of cases) {
		it(`refuses ${name}, in printable ASCII English`, () => {
			expect(checkAskQuestions(questions)).toEqual({ ok: false, message });
			expect(message).toMatch(/^[\x20-\x7e]+$/);
			// what is read back is held to the same caps
			expect(
				parseAskQuestions(JSON.parse(JSON.stringify(questions))),
			).toBeNull();
		});
	}

	it("takes every cap exactly at its limit", () => {
		const atTheLimit: AskQuestion = {
			question: "q".repeat(ASK_LIMITS.questionChars),
			options: [
				{
					label: "l".repeat(ASK_LIMITS.labelChars),
					note: "n".repeat(ASK_LIMITS.noteChars),
					recommended: true,
				},
				{ label: "B" },
			],
		};
		const three = [atTheLimit, atTheLimit, atTheLimit];
		expect(checkAskQuestions(three)).toEqual({ ok: true });
		expect(parseAskQuestions(JSON.parse(JSON.stringify(three)))).toEqual(three);
	});
});

describe("checkAskAnswer", () => {
	it("takes an answer that fits the questions", () => {
		expect(
			checkAskAnswer(card, {
				kind: "answered",
				answers: [{ picked: [0], ownWords: null }],
			}).ok,
		).toBe(true);
		expect(
			checkAskAnswer(card, {
				kind: "answered",
				answers: [
					{ picked: [], ownWords: "Smaller, maybe a picnic by the lake" },
				],
			}).ok,
		).toBe(true);
		expect(checkAskAnswer(card, { kind: "left_to_alfy" }).ok).toBe(true);
		expect(checkAskAnswer(card, { kind: "closed" }).ok).toBe(true);
	});

	it("refuses an answer that does not fit", () => {
		for (const bad of [
			{ kind: "answered", answers: [{ picked: [0, 1], ownWords: null }] }, // two picks on one pick
			{ kind: "answered", answers: [{ picked: [3], ownWords: null }] }, // no such option
			{ kind: "answered", answers: [{ picked: [0], ownWords: "and this" }] }, // own words replace picks
			{ kind: "answered", answers: [{ picked: [], ownWords: null }] }, // no answer
			{ kind: "answered", answers: [] }, // a question left out
			{
				kind: "answered",
				answers: [{ picked: [], ownWords: "x".repeat(501) }],
			},
			{ kind: "maybe" },
			null,
			"closed",
		])
			expect(checkAskAnswer(card, bad).ok).toBe(false);
	});

	it("trims own words before it counts them", () => {
		const padded = `  ${"x".repeat(ASK_LIMITS.ownWordsChars)}\n `;
		const taken = checkAskAnswer(card, {
			kind: "answered",
			answers: [oneAnswer([], padded)],
		});
		expect(taken).toEqual({
			ok: true,
			answer: {
				kind: "answered",
				answers: [oneAnswer([], "x".repeat(ASK_LIMITS.ownWordsChars))],
			},
		});
		expect(
			checkAskAnswer(card, {
				kind: "answered",
				answers: [
					oneAnswer([], ` ${"x".repeat(ASK_LIMITS.ownWordsChars + 1)} `),
				],
			}).ok,
		).toBe(false);
	});

	it("counts own words that are empty after trimming as no own words", () => {
		for (const blank of ["", "   ", "\n\t "]) {
			// no picks and no words: no answer
			expect(
				checkAskAnswer(card, {
					kind: "answered",
					answers: [oneAnswer([], blank)],
				}).ok,
			).toBe(false);
		}
		// a pick beside blank words is the pick alone
		expect(
			checkAskAnswer(card, {
				kind: "answered",
				answers: [oneAnswer([1], "   ")],
			}),
		).toEqual({
			ok: true,
			answer: { kind: "answered", answers: [oneAnswer([1], null)] },
		});
	});

	it("wants one answer for each question, each with picks or words", () => {
		const questions = [card[0], toppings];
		const both = {
			kind: "answered",
			answers: [oneAnswer([2], null), oneAnswer([0, 2], null)],
		};
		expect(checkAskAnswer(questions, both)).toEqual({ ok: true, answer: both });
		expect(
			checkAskAnswer(questions, {
				kind: "answered",
				answers: [oneAnswer([], "A picnic"), oneAnswer([1], null)],
			}).ok,
		).toBe(true);
		expect(
			checkAskAnswer(questions, {
				kind: "answered",
				answers: [oneAnswer([2], null)],
			}).ok,
		).toBe(false); // the second question left out
		expect(
			checkAskAnswer(questions, {
				kind: "answered",
				answers: [
					oneAnswer([2], null),
					oneAnswer([0], null),
					oneAnswer([1], null),
				],
			}).ok,
		).toBe(false); // an answer for a question that was not asked
		expect(
			checkAskAnswer(questions, {
				kind: "answered",
				answers: [oneAnswer([2], null), oneAnswer([], null)],
			}).ok,
		).toBe(false); // the second question has neither
	});

	it("takes several picks only where the question allows them, each once and in range", () => {
		const answer = (picked: number[]) => ({
			kind: "answered",
			answers: [oneAnswer(picked, null)],
		});
		expect(checkAskAnswer([toppings], answer([0, 1, 2])).ok).toBe(true);
		expect(checkAskAnswer([toppings], answer([2, 0])).ok).toBe(true);
		expect(checkAskAnswer([toppings], answer([1, 1])).ok).toBe(false); // twice
		expect(checkAskAnswer([toppings], answer([1, 3])).ok).toBe(false); // no option 3
		expect(checkAskAnswer([toppings], answer([-1])).ok).toBe(false);
		expect(checkAskAnswer([toppings], answer([0.5])).ok).toBe(false);
		expect(checkAskAnswer([toppings], answer(["1" as never])).ok).toBe(false);
		expect(checkAskAnswer([toppings], answer([0, 1, 2, 0])).ok).toBe(false);
		// "multiple: false" allows one pick, as no flag does
		const stated = { ...card[0], multiple: false };
		expect(checkAskAnswer([stated], answer([0, 1])).ok).toBe(false);
		expect(checkAskAnswer([stated], answer([1])).ok).toBe(true);
	});

	it("refuses a body of the wrong shape", () => {
		for (const bad of [
			undefined,
			42,
			[],
			{},
			{ kind: "answered" },
			{ kind: "answered", answers: "none" },
			{ kind: "answered", answers: [null] },
			{ kind: "answered", answers: [{ ownWords: null }] },
			{ kind: "answered", answers: [{ picked: [0] }] },
			{ kind: "answered", answers: [{ picked: 0, ownWords: null }] },
			{ kind: "answered", answers: [{ picked: [0], ownWords: 7 }] },
			{ kind: "answered", answers: [{ picked: [0], ownWords: undefined }] },
		])
			expect(checkAskAnswer(card, bad).ok).toBe(false);
	});

	it("hands back the answer in its own shape, with nothing else the body carried", () => {
		expect(
			checkAskAnswer(card, { kind: "closed", answers: [oneAnswer([0], null)] }),
		).toEqual({ ok: true, answer: { kind: "closed" } });
		expect(
			checkAskAnswer(card, {
				kind: "answered",
				extra: true,
				answers: [{ picked: [0], ownWords: null, note: "ignored" }],
			}),
		).toEqual({
			ok: true,
			answer: { kind: "answered", answers: [oneAnswer([0], null)] },
		});
	});
});

describe("isAskPauseOutput and isAskToolName", () => {
	it("knows the pause result", () => {
		expect(isAskPauseOutput({ status: "waiting_for_user", note: "…" })).toBe(
			true,
		);
		expect(isAskPauseOutput({ ok: false, errorCode: "already_asked" })).toBe(
			false,
		);
		expect(isAskPauseOutput("waiting_for_user")).toBe(false);
		expect([isAskToolName("ask_user"), isAskToolName("done")]).toEqual([
			true,
			false,
		]);
	});

	it("reads nothing else as the pause result", () => {
		for (const other of [
			null,
			undefined,
			42,
			[],
			[{ status: "waiting_for_user" }],
			{},
			{ status: "answered" },
			{ status: "Waiting_For_User" },
		])
			expect(isAskPauseOutput(other)).toBe(false);
	});
});

// A stored call as the tool records it. The one that asked is marked `paused`;
// every call that asked nobody (not available in this run, a second card, bad
// questions, a store that failed) is a finished call marked `ok: false`.
describe("askCallPausedTheReply", () => {
	const paused = {
		name: "ask_user",
		status: "done",
		metadata: { paused: true, questionId: "question-1" },
	};

	it("is true for the ask call that paused the reply", () => {
		expect(askCallPausedTheReply(paused)).toBe(true);
	});

	it("stays true once the question is answered or the reply was stopped", () => {
		// Settling a call rewrites its summary and digest and leaves its marks: it
		// records that the reply asked, not that a question still waits.
		const answered = {
			...paused,
			outputSummary: "The user picked: A party at home",
			resultDigest: '{"status":"answered"}',
		};
		const stopped = {
			...paused,
			outputSummary: "The user stopped the reply before answering.",
		};
		expect(askCallPausedTheReply(answered)).toBe(true);
		expect(askCallPausedTheReply(stopped)).toBe(true);
	});

	it.each([
		"not_available",
		"invalid_questions",
		"already_asked",
		"ask_user_failed",
	])("is false for a card the tool refused (%s): it asked nobody", (reason) => {
		expect(
			askCallPausedTheReply({
				name: "ask_user",
				status: "done",
				metadata: { ok: false, evidenceReady: false, reason },
			}),
		).toBe(false);
	});

	it.each([
		"running",
		"failed",
		undefined,
		null,
	])("is false for an ask call that did not finish (status %s)", (status) => {
		expect(askCallPausedTheReply({ ...paused, status })).toBe(false);
	});

	it("is false for another tool, whatever its metadata says", () => {
		expect(askCallPausedTheReply({ ...paused, name: "research_web" })).toBe(
			false,
		);
	});

	it.each([
		["no metadata", undefined],
		["null metadata", null],
		["empty metadata", {}],
		["paused false", { paused: false }],
		["paused as text", { paused: "true" }],
		["paused as a number", { paused: 1 }],
	])("is false for an ask call with %s", (_name, metadata) => {
		expect(askCallPausedTheReply({ ...paused, metadata })).toBe(false);
	});
});

describe("reading stored questions and answers back", () => {
	it("reads stored questions and answers back, and nothing else", () => {
		expect(parseAskQuestions(JSON.parse(JSON.stringify(card)))).toEqual(card);
		expect(parseAskQuestions([{ question: "x", options: [] }])).toBeNull();
		expect(parseAskAnswer({ kind: "closed" })).toEqual({ kind: "closed" });
	});

	it("keeps what is stored, down to the flags it set", () => {
		const stored: AskQuestion[] = [
			card[0],
			toppings,
			withRecommended(1, false),
		];
		expect(parseAskQuestions(JSON.parse(JSON.stringify(stored)))).toEqual(
			stored,
		);
	});

	it("does not hold a stored question to the Recommended rule", () => {
		// the rule is for what Alfy may ask; a row already written is only read
		const stored = [withRecommended(0)];
		expect(checkAskQuestions(stored).ok).toBe(false);
		expect(parseAskQuestions(JSON.parse(JSON.stringify(stored)))).toEqual(
			stored,
		);
	});

	it("reads no questions from a value of the wrong shape", () => {
		for (const bad of [
			undefined,
			null,
			"questions",
			{},
			[],
			[null],
			[{ question: 5, options: card[0].options }],
			[{ options: card[0].options }],
			[{ question: "x" }],
			[{ question: "x", options: "A, B" }],
			[{ question: "x", options: [{ label: "A" }, { label: 7 }] }],
			[{ question: "x", options: [{ label: "A" }, { note: "no label" }] }],
			[{ question: "x", options: [{ label: "A" }, null] }],
			[{ question: "x", multiple: "yes", options: card[0].options }],
			[
				{
					question: "x",
					options: [{ label: "A" }, { label: "B", note: 3 }],
				},
			],
			[
				{
					question: "x",
					options: [{ label: "A" }, { label: "B", recommended: "yes" }],
				},
			],
		])
			expect(parseAskQuestions(bad)).toBeNull();
	});

	it("leaves out keys the types do not have", () => {
		expect(
			parseAskQuestions([
				{
					question: "x",
					extra: 1,
					options: [{ label: "A", extra: 2 }, { label: "B" }],
				},
			]),
		).toEqual([{ question: "x", options: [{ label: "A" }, { label: "B" }] }]);
	});

	it("reads an answer back in each of its three forms", () => {
		const answered = {
			kind: "answered",
			answers: [oneAnswer([0, 2], null), oneAnswer([], "Smaller, a picnic")],
		};
		expect(parseAskAnswer(JSON.parse(JSON.stringify(answered)))).toEqual(
			answered,
		);
		expect(parseAskAnswer({ kind: "left_to_alfy" })).toEqual({
			kind: "left_to_alfy",
		});
		expect(parseAskAnswer({ kind: "closed" })).toEqual({ kind: "closed" });
	});

	it("reads no answer from a value of the wrong shape", () => {
		for (const bad of [
			undefined,
			null,
			"closed",
			7,
			[],
			{},
			{ kind: "maybe" },
			{ kind: "answered" },
			{ kind: "answered", answers: [] },
			{ kind: "answered", answers: [oneAnswer([0], null), null] },
			{
				kind: "answered",
				answers: [
					oneAnswer([], null),
					oneAnswer([], null),
					oneAnswer([], null),
					oneAnswer([], null),
				],
			},
			{ kind: "answered", answers: [oneAnswer([-1], null)] },
			{ kind: "answered", answers: [oneAnswer([0.5], null)] },
			{ kind: "answered", answers: [{ picked: ["0"], ownWords: null }] },
			{ kind: "answered", answers: [{ picked: [], ownWords: 5 }] },
			{
				kind: "answered",
				answers: [oneAnswer([], "x".repeat(ASK_LIMITS.ownWordsChars + 1))],
			},
		])
			expect(parseAskAnswer(bad)).toBeNull();
	});

	it("trims stored own words, and reads blank ones as none", () => {
		expect(
			parseAskAnswer({
				kind: "answered",
				answers: [oneAnswer([], "  a picnic \n"), oneAnswer([1], "  ")],
			}),
		).toEqual({
			kind: "answered",
			answers: [oneAnswer([], "a picnic"), oneAnswer([1], null)],
		});
	});

	it("gives back a copy, not the value it was handed", () => {
		const body = { kind: "answered", answers: [oneAnswer([0], null)] };
		const answer = parseAskAnswer(body);
		// whatever happens to the request body afterwards, the answer stays
		body.answers[0].picked.push(2);
		body.answers[0].ownWords = "changed";
		expect(answer).toEqual({
			kind: "answered",
			answers: [oneAnswer([0], null)],
		});
	});
});
