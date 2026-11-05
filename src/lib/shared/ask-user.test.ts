import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** What the card is told when it holds more (or fewer) questions than the one it may hold. */
const COUNT_LINE =
	"A card holds exactly 1 question: ask the one that matters most, and the next after the answer.";

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
			// 1 since 2026-11-05 (owner, after his first live test: "I only want 1 ask
			// card at a time"); a stored card from before that day holds up to 3, and is
			// still read and drawn.
			maxQuestions: 1,
			maxStoredQuestions: 3,
			minOptions: 2,
			// 4 since 2026-11-05 (owner, after the real-model measurement): the production
			// model wrote four answers on three of the four cards the app turned back.
			maxOptions: 4,
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
		// a second question is itself too many, and still has its problems named
		expect(checkAskQuestions([card[0], withRecommended(0)])).toEqual({
			ok: false,
			message: [
				COUNT_LINE,
				"Question 2 takes one pick: mark exactly one of its options recommended.",
			].join("\n"),
		});
	});

	it("takes a several-pick question with any number of Recommended options, none included", () => {
		for (const n of [0, 1, 2, 3]) {
			expect(checkAskQuestions([withRecommended(n, true)])).toEqual({
				ok: true,
			});
		}
		expect(checkAskQuestions([toppings])).toEqual({ ok: true });
	});

	const cases: Array<[string, AskQuestion[], string]> = [
		["no question", [], COUNT_LINE],
		[
			"a question with one option",
			[{ ...card[0], options: card[0].options.slice(0, 1) }],
			"Question 1 needs 2 to 4 options.",
		],
		[
			"a question with five options",
			[
				{
					...card[0],
					options: [
						...card[0].options,
						{ label: "Stay in" },
						{ label: "Go camping" },
					],
				},
			],
			"Question 1 needs 2 to 4 options.",
		],
		[
			"a question without text",
			[{ ...card[0], question: "  " }],
			"Question 1 has no text.",
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
		// the tool's schema used to refuse an empty note (`min(1)`) before the check ran; the
		// check now holds that rule, so the one refusal can name it with the others
		[
			"an empty note",
			[
				{
					...card[0],
					options: [
						{ label: "A party at home", note: "", recommended: true },
						card[0].options[1],
					],
				},
			],
			"Option 1 of question 1 has an empty note.",
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

	// Owner, 2026-11-05: a question may have up to four answers (it was two or three).
	it("takes a question with four answers, as asked and as read back", () => {
		const four: AskQuestion = {
			...card[0],
			options: [...card[0].options, { label: "Stay in" }],
		};
		expect(four.options).toHaveLength(4);
		expect(checkAskQuestions([four])).toEqual({ ok: true });
		expect(parseAskQuestions(JSON.parse(JSON.stringify([four])))).toEqual([
			four,
		]);
		// ... and on every question of a stored card of three
		expect(
			parseAskQuestions(JSON.parse(JSON.stringify([four, four, four]))),
		).toEqual([four, four, four]);
	});

	// Owner, 2026-11-05, after his first live test: "I only want 1 ask card at a time". A card
	// asked before that day held up to three questions, and the page still draws it and takes
	// its answer, so what is read back is held to the larger count and what is asked to one.
	it("takes one question to ask, and up to three to read back", () => {
		const q = card[0];
		expect(checkAskQuestions([q])).toEqual({ ok: true });
		for (const count of [2, 3, 4]) {
			const questions = Array.from({ length: count }, () => q);
			const checked = checkAskQuestions(questions);
			expect(checked).toEqual({ ok: false, message: COUNT_LINE });
			expect(COUNT_LINE).toMatch(/^[\x20-\x7e]+$/);
		}
		for (const count of [1, 2, 3]) {
			const questions = Array.from({ length: count }, () => q);
			expect(parseAskQuestions(JSON.parse(JSON.stringify(questions)))).toEqual(
				questions,
			);
		}
		expect(
			parseAskQuestions(JSON.parse(JSON.stringify([q, q, q, q]))),
		).toBeNull();
		// ... and so is its answer: one entry a question, up to three of them
		const threeAnswers = {
			kind: "answered",
			answers: [oneAnswer([0], null), oneAnswer([1], null), oneAnswer([], "x")],
		};
		expect(parseAskAnswer(threeAnswers)).toEqual(threeAnswers);
		expect(
			parseAskAnswer({
				kind: "answered",
				answers: [...threeAnswers.answers, oneAnswer([0], null)],
			}),
		).toBeNull();
	});

	// Owner, 2026-11-05, after the real-model measurement: one refusal names every problem of
	// a card, so the model fixes the whole card in one retry. Before, a card that broke a count
	// and a mark was refused twice: the schema named the count, and only the next try met the
	// mark; the Hungarian holiday card was still refused after its retry.
	describe("every problem of a card, in one refusal", () => {
		const MARK = "takes one pick: mark exactly one of its options recommended.";
		const fiveOptions: AskQuestion = {
			...card[0],
			options: [
				...card[0].options,
				{ label: "Stay in" },
				{ label: "Go camping" },
			],
		};
		const noMark: AskQuestion = {
			...card[0],
			options: card[0].options.map(({ label }) => ({ label })),
		};
		const lines = (questions: AskQuestion[]) => {
			const checked = checkAskQuestions(questions);
			if (checked.ok) throw new Error("expected a refusal");
			return checked.message.split("\n");
		};

		it("names a count and a mark at once, one line each", () => {
			expect(checkAskQuestions([fiveOptions, noMark])).toEqual({
				ok: false,
				message: [
					COUNT_LINE,
					"Question 1 needs 2 to 4 options.",
					`Question 2 ${MARK}`,
				].join("\n"),
			});
		});

		it("names both problems of one question, the count and then the mark", () => {
			// five options and no Recommended one
			const fiveNoMark: AskQuestion = {
				...fiveOptions,
				options: fiveOptions.options.map(({ label }) => ({ label })),
			};

			expect(lines([fiveNoMark])).toEqual([
				"Question 1 needs 2 to 4 options.",
				`Question 1 ${MARK}`,
			]);
		});

		it("names every problem of a card that has several, in the order of the card", () => {
			const blankQuestion: AskQuestion = {
				question: "  ",
				options: [{ label: "A" }],
			};
			const crowded: AskQuestion = {
				question: "x".repeat(161),
				multiple: true,
				options: [
					{ label: "A" },
					{ label: " " },
					{ label: "l".repeat(51) },
					{ label: "B", note: "n".repeat(101) },
					{ label: "E" },
				],
			};

			// four questions, so the card's count is the first line; then each question in turn:
			// its text, its number of options, its mark, its options
			expect(lines([blankQuestion, crowded, card[0], card[0]])).toEqual([
				COUNT_LINE,
				"Question 1 has no text.",
				"Question 1 needs 2 to 4 options.",
				`Question 1 ${MARK}`,
				"Question 2 is longer than 160 characters.",
				"Question 2 needs 2 to 4 options.",
				"Option 2 of question 2 has no label.",
				"Option 3 of question 2 has a label longer than 50 characters.",
				"Option 4 of question 2 has a note longer than 100 characters.",
			]);
		});

		it("is one printable ASCII line a problem, and never repeats the model's own words", () => {
			const wordy: AskQuestion = {
				question: "Hová menjünk nyaralni?",
				options: [
					{ label: "Tenger" },
					{ label: "Hegyek" },
					{ label: "Város" },
					{ label: "Falu" },
					{ label: "Sivatag" },
				],
			};
			const all = lines([wordy, noMark]);

			expect(all).toHaveLength(4);
			for (const line of all) {
				expect(line).toMatch(/^[\x20-\x7e]+$/);
				expect(line).not.toMatch(/Hová|Tenger|Sivatag|Short bullets/);
			}
		});

		it("keeps a long list short: it lists 30 problems and says how many more there are", () => {
			// three questions of ten options each, every label blank: 11 problems a question,
			// and the card's own count, which is one question too many twice over
			const blankLabels = (n: number): AskQuestion => ({
				question: "Which?",
				multiple: true,
				options: Array.from({ length: n }, () => ({ label: " " })),
			});
			const all = lines([blankLabels(10), blankLabels(10), blankLabels(10)]);

			expect(all).toHaveLength(31);
			expect(all.slice(0, 30).every((line) => !line.startsWith("And "))).toBe(
				true,
			);
			expect(all[30]).toBe("And 4 more.");
			// a card with exactly 30 problems (the count, then 11 + 11 + 7) is listed whole
			expect(
				lines([blankLabels(10), blankLabels(10), blankLabels(6)]),
			).toHaveLength(30);
		});

		it("holds what is read back only to the counts and lengths, never to the mark", () => {
			// the same rule as before: a row already written is only read
			const stored = [noMark];
			expect(checkAskQuestions(stored).ok).toBe(false);
			expect(parseAskQuestions(JSON.parse(JSON.stringify(stored)))).toEqual(
				stored,
			);
			// ... and a count it breaks is still refused when read back
			expect(
				parseAskQuestions(JSON.parse(JSON.stringify([fiveOptions]))),
			).toBeNull();
		});
	});

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
		const one = [atTheLimit];
		expect(checkAskQuestions(one)).toEqual({ ok: true });
		expect(parseAskQuestions(JSON.parse(JSON.stringify(one)))).toEqual(one);
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

	// Owner, 2026-11-05: four answers a question. A several-pick question may then be
	// answered with all four, which an answer read back used to refuse (more picks than
	// the cap on answers).
	it("takes all four picks on a several-pick question of four answers, and no more", () => {
		const fourToppings: AskQuestion = {
			...toppings,
			options: [...toppings.options, { label: "Candles" }],
		};
		const answer = (picked: number[]) => ({
			kind: "answered",
			answers: [oneAnswer(picked, null)],
		});
		expect(checkAskAnswer([fourToppings], answer([0, 1, 2, 3])).ok).toBe(true);
		expect(checkAskAnswer([fourToppings], answer([3, 1])).ok).toBe(true);
		expect(checkAskAnswer([fourToppings], answer([0, 1, 2, 3, 0])).ok).toBe(
			false,
		); // a fifth pick can only be a repeat
		expect(parseAskAnswer(answer([0, 1, 2, 3]))).toEqual(answer([0, 1, 2, 3]));
		expect(parseAskAnswer(answer([0, 1, 2, 3, 4]))).toBeNull();
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

describe("module hygiene", () => {
	// The same zero-value-import guard the other shared leaves carry
	// (extraction-status.ts, reply-text.ts). This module is reached from the model run,
	// the tool, the store, the routes and the chat page's components, so anything it
	// imported would travel to all of them (the browser bundle too) or close an import
	// cycle: the leaf property is what keeps Fallow's cycles at four and the bundle small.
	it("has no value imports", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(path.join(here, "ask-user.ts"), "utf8");
		expect(source.match(/^import\s(?!type)/gm)).toBeNull();
	});
});
