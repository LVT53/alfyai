import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import type {
	AskAnswer,
	AskQuestion,
	AskQuestionDto,
} from "$lib/shared/ask-user";
import { uiLanguage } from "$lib/stores/settings";
import type { Translate } from "$lib/utils/tool-evidence-presentation";
import { askAnswerText, buildAskFoldedItem } from "./ask-card-view";

// The real translator of each language, as write-card-view.test.ts takes it: what
// is under test is the words the dictionary gives the line, quote marks included.
function translatorFor(language: "en" | "hu"): Translate {
	uiLanguage.set(language);
	return get(t);
}

const hu = translatorFor("hu");
const en = translatorFor("en");

// The mockup's cards (docs/plans/ask-me-first/mockups.html, sections 1 to 3).
const WAY: AskQuestion = {
	question: "Which way should we take it?",
	options: [
		{
			label: "A party at home",
			note: "Easiest to organise, and the whole family can come",
			recommended: true,
		},
		{
			label: "Dinner out, just close family",
			note: "Quieter; book three or four weeks ahead",
		},
		{
			label: "A weekend away together",
			note: "The most memorable, and the most to arrange",
		},
	],
};

const WAY_HU: AskQuestion = {
	question: "Merre induljunk el?",
	options: [
		{
			label: "Házibuli otthon",
			note: "Ezt a legkönnyebb megszervezni, és az egész család ott lehet",
			recommended: true,
		},
		{ label: "Vacsora étteremben, szűk családdal" },
		{ label: "Közös hétvége valahol" },
	],
};

// Takes several picks, and there a Recommended mark is optional (here there is none).
const WHO: AskQuestion = {
	question: "Who's coming?",
	multiple: true,
	options: [{ label: "Adults" }, { label: "Kids" }, { label: "Grandma" }],
};

const SPLIT: AskQuestion = {
	question: "How should the list be split?",
	options: [
		{
			label: "One shared list",
			note: "Shortest; you tick things off together",
			recommended: true,
		},
		{ label: "A list per person", note: "Everyone packs their own" },
	],
};

type OneAnswer = { picked: number[]; ownWords: string | null };

const pick = (...picked: number[]): OneAnswer => ({ picked, ownWords: null });
const own = (ownWords: string): OneAnswer => ({ picked: [], ownWords });

function card(
	questions: AskQuestion[],
	answer: AskAnswer | null,
	status: AskQuestionDto["status"] = "answered",
): AskQuestionDto {
	return {
		id: "q-1",
		conversationId: "conv-1",
		assistantMessageId: "msg-1",
		toolCallId: "call-1",
		questions,
		status,
		answer,
		createdAt: 1_700_000_000_000,
	};
}

const answered = (
	questions: AskQuestion[],
	...answers: OneAnswer[]
): AskQuestionDto => card(questions, { kind: "answered", answers });

// A row read from JSON that lacks the key has no `answer` at all, whatever the type says.
function withoutAnswer(questions: AskQuestion[]): AskQuestionDto {
	const row: Partial<AskQuestionDto> = card(questions, null);
	delete row.answer;
	return row as AskQuestionDto;
}

const LEFT: AskAnswer = { kind: "left_to_alfy" };
const CLOSED: AskAnswer = { kind: "closed" };

describe("buildAskFoldedItem", () => {
	it("folds a pick into one line: the question muted, the answer after it", () => {
		const item = buildAskFoldedItem(answered([WAY], pick(0)), en);

		expect(item).toMatchObject({
			key: "ask-q-1",
			status: "done",
			iconType: "ask",
			verb: "Which way should we take it?",
			object: "A party at home",
			meta: "",
			summaryLabel: "Which way should we take it?",
			title: "Which way should we take it? A party at home",
			pinned: true,
			alwaysOpen: false,
			body: {
				kind: "ask",
				pairs: [
					{
						question: "Which way should we take it?",
						answer: "A party at home",
					},
				],
			},
		});
		expect(item.objectSuffix).toBeUndefined();
	});

	it("quotes own words in the reader's marks", () => {
		const english = buildAskFoldedItem(
			answered([WAY], own("Smaller, maybe a picnic by the lake")),
			en,
		);
		expect(english.object).toBe("“Smaller, maybe a picnic by the lake”");
		expect(english.body).toEqual({
			kind: "ask",
			pairs: [
				{
					question: "Which way should we take it?",
					answer: "“Smaller, maybe a picnic by the lake”",
				},
			],
		});
		expect(english.objectSuffix).toBeUndefined();

		const hungarian = buildAskFoldedItem(
			answered([WAY_HU], own("Kisebbet, talán egy piknik a tónál")),
			hu,
		);
		expect(hungarian.object).toBe("„Kisebbet, talán egy piknik a tónál”");
		expect(hungarian.verb).toBe("Merre induljunk el?");
	});

	it("puts the person's words in the marks exactly as typed, $ signs included", () => {
		// The words go through the translator's {text} parameter, which must put them in
		// as they are: `$$`, `$&` and `$'` are not patterns when a person types them.
		const typed = "Nothing fancy: $$ at most, not $& or $' either";
		const item = buildAskFoldedItem(answered([WAY], own(typed)), en);

		expect(item.object).toBe(`“${typed}”`);
	});

	it("says a choice was left to Alfy after its Recommended answer", () => {
		const english = buildAskFoldedItem(card([WAY], LEFT), en);
		expect(english).toMatchObject({
			status: "done",
			iconType: "ask",
			verb: "Which way should we take it?",
			object: "A party at home",
			objectSuffix: "· left to Alfy",
			title: "Which way should we take it? A party at home · left to Alfy",
			body: {
				kind: "ask",
				pairs: [
					{
						question: "Which way should we take it?",
						answer: "A party at home",
					},
				],
			},
		});

		const hungarian = buildAskFoldedItem(card([WAY_HU], LEFT), hu);
		expect(hungarian).toMatchObject({
			object: "Házibuli otthon",
			objectSuffix: "· Alfyra bízva",
		});
	});

	it("says a closed card was closed, with nothing to open", () => {
		const english = buildAskFoldedItem(card([WAY], CLOSED, "closed"), en);
		expect(english).toMatchObject({
			key: "ask-q-1",
			status: "closed",
			iconType: "ask",
			verb: "Which way should we take it?",
			object: "",
			objectSuffix: "· closed",
			meta: "",
			summaryLabel: "Which way should we take it?",
			title: "Which way should we take it? · closed",
			pinned: true,
			alwaysOpen: false,
			body: null,
		});

		expect(
			buildAskFoldedItem(card([WAY_HU], CLOSED, "closed"), hu).objectSuffix,
		).toBe("· bezárva");
	});

	it("folds several questions into a count and their answers", () => {
		const items = answered(
			[WHO, SPLIT],
			pick(0, 1),
			own("One list, with a section for the kids' things"),
		);

		const english = buildAskFoldedItem(items, en);
		expect(english).toMatchObject({
			status: "done",
			verb: "2 questions",
			summaryLabel: "2 questions",
			object: "Adults, Kids · “One list, with a section for the kids' things”",
			body: {
				kind: "ask",
				pairs: [
					{ question: "Who's coming?", answer: "Adults, Kids" },
					{
						question: "How should the list be split?",
						answer: "“One list, with a section for the kids' things”",
					},
				],
			},
		});
		expect(english.objectSuffix).toBeUndefined();

		expect(buildAskFoldedItem(items, hu).verb).toBe("2 kérdés");
	});

	// Owner, 2026-11-05: a question may have four answers, so a several-pick question may be
	// answered with all four. The line names every pick, in the order they were made, and the
	// open line says them again beside the question; a choice left to Alfy names every
	// Recommended answer of such a question.
	it("names all four picks of a several-pick question, in the order they were picked", () => {
		const extras: AskQuestion = {
			question: "Which extras do you want?",
			multiple: true,
			options: [
				{ label: "Music", recommended: true },
				{ label: "Photos" },
				{ label: "A cake", recommended: true },
				{ label: "Candles" },
			],
		};

		const picked = buildAskFoldedItem(answered([extras], pick(3, 0, 2, 1)), en);
		expect(picked.object).toBe("Candles, Music, A cake, Photos");
		expect(picked.body).toEqual({
			kind: "ask",
			pairs: [
				{
					question: "Which extras do you want?",
					answer: "Candles, Music, A cake, Photos",
				},
			],
		});
		expect(picked.objectSuffix).toBeUndefined();

		const left = buildAskFoldedItem(card([extras], LEFT), en);
		expect(left.object).toBe("Music, A cake");
		expect(left.objectSuffix).toBe("· left to Alfy");
	});

	it("keys the line on the answer, not on the status: the resume is running while the question is answering", () => {
		// `answering` already holds the answer; only later does it read answered or closed.
		expect(
			buildAskFoldedItem(card([WAY], CLOSED, "answering"), en),
		).toMatchObject({ status: "closed", objectSuffix: "· closed", body: null });

		expect(
			buildAskFoldedItem(
				card([WAY], { kind: "answered", answers: [pick(1)] }, "answering"),
				en,
			),
		).toMatchObject({
			status: "done",
			object: "Dinner out, just close family",
		});

		expect(
			buildAskFoldedItem(card([WAY], LEFT, "answering"), en),
		).toMatchObject({ status: "done", objectSuffix: "· left to Alfy" });
	});

	it("draws a plain done line with its question and an empty object when the answer is unexpectedly null or missing", () => {
		// null is the row's own "no answer"; a row without the key reads undefined. Both
		// are missing, and neither may reach the answer's kind.
		for (const missing of [
			(questions: AskQuestion[]) => card(questions, null, "answered"),
			withoutAnswer,
		]) {
			const item = buildAskFoldedItem(missing([WAY]), en);

			expect(item).toMatchObject({
				key: "ask-q-1",
				status: "done",
				iconType: "ask",
				verb: "Which way should we take it?",
				object: "",
				body: null,
			});
			expect(item.objectSuffix).toBeUndefined();

			const several = buildAskFoldedItem(missing([WHO, SPLIT]), en);
			expect(several).toMatchObject({
				status: "done",
				verb: "2 questions",
				object: "",
				body: null,
			});
		}
	});

	it("says left to Alfy in the open line for a question with no Recommended answer", () => {
		// A question that takes several picks may carry no Recommended mark. "Decide for me"
		// leaves it to Alfy: the line's object has no answer to name, and the open line
		// does not show an empty one (Ruling 17).
		const alone = buildAskFoldedItem(card([WHO], LEFT), en);
		expect(alone).toMatchObject({
			status: "done",
			verb: "Who's coming?",
			object: "",
			objectSuffix: "· left to Alfy",
			body: {
				kind: "ask",
				pairs: [{ question: "Who's coming?", answer: "left to Alfy" }],
			},
		});

		// With another question that has one, the object names only that one: no
		// stray separator for the question that has nothing to name.
		const mixed = buildAskFoldedItem(card([WHO, SPLIT], LEFT), en);
		expect(mixed).toMatchObject({
			verb: "2 questions",
			object: "One shared list",
			objectSuffix: "· left to Alfy",
			body: {
				kind: "ask",
				pairs: [
					{ question: "Who's coming?", answer: "left to Alfy" },
					{
						question: "How should the list be split?",
						answer: "One shared list",
					},
				],
			},
		});

		expect(buildAskFoldedItem(card([WHO], LEFT), hu).body).toEqual({
			kind: "ask",
			pairs: [{ question: "Who's coming?", answer: "Alfyra bízva" }],
		});
	});
});

describe("askAnswerText", () => {
	it("names the options picked, in the order they were picked, joined by commas", () => {
		const answer: AskAnswer = { kind: "answered", answers: [pick(2, 0)] };

		expect(askAnswerText(WHO, answer, 0, en)).toBe("Grandma, Adults");
	});

	it("reads the entry of the question it is asked about", () => {
		const answer: AskAnswer = {
			kind: "answered",
			answers: [pick(0, 1), pick(1)],
		};

		expect(askAnswerText(WHO, answer, 0, en)).toBe("Adults, Kids");
		expect(askAnswerText(SPLIT, answer, 1, en)).toBe("A list per person");
	});

	it("gives own words in quotes in place of the picks they replaced", () => {
		const answer: AskAnswer = {
			kind: "answered",
			answers: [{ picked: [], ownWords: "Just the cousins" }],
		};

		expect(askAnswerText(WHO, answer, 0, en)).toBe("“Just the cousins”");
		expect(askAnswerText(WHO, answer, 0, hu)).toBe("„Just the cousins”");
	});

	it("gives the Recommended options for a choice left to Alfy, several when the question marks several", () => {
		const several: AskQuestion = {
			question: "Which days?",
			multiple: true,
			options: [
				{ label: "Friday", recommended: true },
				{ label: "Saturday" },
				{ label: "Sunday", recommended: true },
			],
		};

		expect(askAnswerText(WAY, LEFT, 0, en)).toBe("A party at home");
		expect(askAnswerText(several, LEFT, 0, en)).toBe("Friday, Sunday");
		expect(askAnswerText(WHO, LEFT, 0, en)).toBe("");
	});

	it("is empty for a closed card, and for a question the answer has no entry for", () => {
		expect(askAnswerText(WAY, CLOSED, 0, en)).toBe("");
		expect(askAnswerText(WAY, { kind: "answered", answers: [] }, 0, en)).toBe(
			"",
		);
		expect(
			askAnswerText(WAY, { kind: "answered", answers: [pick(0)] }, 1, en),
		).toBe("");
	});

	it("skips a pick that names no option, as the server does when it words the answer for the model", () => {
		const answer: AskAnswer = { kind: "answered", answers: [pick(7, 1)] };

		expect(askAnswerText(WAY, answer, 0, en)).toBe(
			"Dinner out, just close family",
		);
	});
});
