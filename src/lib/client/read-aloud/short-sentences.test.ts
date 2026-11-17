import { describe, expect, it } from "vitest";
import { joinShortSentences, SHORT_SENTENCE_CHARS } from "./short-sentences";

// A draft as the speech script builds them, with the few fields the join reads: one word per
// token, so a sentence's written length is the text's.
type TestWord = { tokens: string[]; heading: boolean };
type TestDraft = {
	language: "en" | "hu";
	paragraphStart: boolean;
	words: TestWord[];
	unit: string;
	list: string | null;
	code: boolean;
};

function draft(
	text: string,
	options: Partial<
		Pick<TestDraft, "language" | "paragraphStart" | "unit" | "list" | "code">
	> & {
		heading?: boolean;
	} = {},
): TestDraft {
	return {
		language: options.language ?? "en",
		paragraphStart: options.paragraphStart ?? false,
		unit: options.unit ?? "0",
		list: options.list ?? null,
		code: options.code ?? false,
		words: text
			.split(" ")
			.map((token) => ({ tokens: [token], heading: options.heading ?? false })),
	};
}

/** A sentence of exactly `chars` characters (words of 4 letters and spaces, then a full stop). */
function sentence(chars: number, options: Parameters<typeof draft>[1] = {}) {
	let text = "";
	while (text.length + 5 < chars) text += "word ";
	text += `${"x".repeat(chars - text.length - 1)}.`;
	return draft(text, options);
}

const textOf = (d: TestDraft) => d.words.flatMap((w) => w.tokens).join(" ");
const MAX = 240;
const join = (drafts: TestDraft[]) => joinShortSentences(drafts, MAX);

describe("joining short sentences", () => {
	it("measures a sentence by its written characters and calls under fifty short", () => {
		expect(SHORT_SENTENCE_CHARS).toBe(50);
		expect(textOf(sentence(49)).length).toBe(49);
		expect(textOf(sentence(50)).length).toBe(50);
		expect(join([sentence(49), sentence(60)])).toHaveLength(1);
		expect(join([sentence(50), sentence(60)])).toHaveLength(2);
	});

	it("joins a short sentence to the next one of its paragraph, words in order", () => {
		const [out, ...rest] = join([
			draft("Sure, here you go.", { paragraphStart: true }),
			sentence(80),
		]);
		expect(rest).toEqual([]);
		expect(out?.paragraphStart).toBe(true);
		expect(textOf(out as TestDraft)).toBe(
			`Sure, here you go. ${textOf(sentence(80))}`,
		);
	});

	it("keeps going while the joined unit is still short", () => {
		const out = join([
			draft("Yes.", { paragraphStart: true }),
			draft("Sure."),
			draft("Okay."),
			sentence(60),
		]);
		expect(out).toHaveLength(1);
		expect(textOf(out[0] as TestDraft)).toBe(
			`Yes. Sure. Okay. ${textOf(sentence(60))}`,
		);
	});

	it("stops joining once the unit is long enough", () => {
		const out = join([sentence(30), sentence(25), sentence(20), sentence(70)]);
		// 30 + 1 + 25 = 56 characters is long enough; the third, short again, takes the fourth.
		expect(out.map((d) => textOf(d).length)).toEqual([56, 20 + 1 + 70]);
	});

	it("joins the last sentence of a paragraph, if short, to the one before it", () => {
		const out = join([
			sentence(90, { paragraphStart: true }),
			draft("Thanks."),
		]);
		expect(out).toHaveLength(1);
		expect(out[0]?.paragraphStart).toBe(true);
		expect(textOf(out[0] as TestDraft).endsWith(" Thanks.")).toBe(true);
	});

	it("takes a short sentence between two others into the next one", () => {
		const out = join([sentence(80), draft("Why not?"), sentence(80)]);
		expect(out).toHaveLength(2);
		expect(textOf(out[0] as TestDraft)).toBe(textOf(sentence(80)));
		expect(textOf(out[1] as TestDraft)).toBe(
			`Why not? ${textOf(sentence(80))}`,
		);
	});

	it("never joins a short sentence across a paragraph unless it is a paragraph of its own", () => {
		// "Ok." is the second sentence of its paragraph, not a paragraph of one sentence: the one
		// before is too long to take it (238 + 1 + 3 = 242) and the next paragraph is not its to join.
		const out = join([
			sentence(238, { unit: "0", paragraphStart: true }),
			draft("Ok.", { unit: "0" }),
			sentence(80, { unit: "1", paragraphStart: true }),
		]);
		expect(out.map((d) => textOf(d).length)).toEqual([238, 3, 80]);
	});

	it("leaves a paragraph of one short sentence alone", () => {
		const out = join([draft("Hello.", { paragraphStart: true })]);
		expect(out).toHaveLength(1);
		expect(textOf(out[0] as TestDraft)).toBe("Hello.");
	});

	it("never joins sentences of different languages", () => {
		const out = join([
			draft("Igen, rendben.", { language: "hu" }),
			sentence(80, { language: "en" }),
		]);
		expect(out).toHaveLength(2);
	});

	it("never joins a heading to anything", () => {
		const heading = draft("Ingredients.", {
			heading: true,
			paragraphStart: true,
		});
		expect(join([heading, sentence(80)])).toHaveLength(2);
		expect(join([sentence(80), heading])).toHaveLength(2);
		// A unit that holds a heading's words (the script joins a one-word heading to what follows
		// it) is not pulled into a larger one either.
		const withHeading: TestDraft = {
			...draft("Intro."),
			words: [
				{ tokens: ["Intro."], heading: true },
				{ tokens: ["Now", "go."], heading: false },
			],
		};
		expect(join([withHeading, sentence(80)])).toHaveLength(2);
	});

	it("never lets the joined unit pass the length the script splits at", () => {
		// 40 + 1 + 210 = 251: too long, so the short sentence stays alone.
		expect(join([sentence(40), sentence(210)])).toHaveLength(2);
		// 40 + 1 + 199 = 240: just fits.
		expect(join([sentence(40), sentence(199)])).toHaveLength(1);
		expect(
			textOf(join([sentence(40), sentence(199)])[0] as TestDraft).length,
		).toBe(240);
	});

	it("falls back to the sentence before when the next one is too long to join", () => {
		// 6 + 1 + 235 = 242 passes the limit, 100 + 1 + 6 does not.
		const out = join([sentence(100), draft("Right."), sentence(235)]);
		expect(out.map((d) => textOf(d).length)).toEqual([100 + 1 + 6, 235]);
	});

	it("leaves a short sentence alone when neither neighbour fits", () => {
		const out = join([sentence(230), sentence(30), sentence(230)]);
		expect(out.map((d) => textOf(d).length)).toEqual([230, 30, 230]);
	});

	it("counts the tokens a word is read as, and the spaces between them", () => {
		const reads: TestDraft = {
			language: "en",
			paragraphStart: false,
			unit: "0",
			list: null,
			code: false,
			words: [
				{ tokens: ["twelve", "thousand,", "nine", "hundred"], heading: false },
				{ tokens: ["dollars."], heading: false },
			],
		};
		// "twelve thousand, nine hundred dollars." is 38 characters: short.
		expect(join([reads, sentence(30)])).toHaveLength(1);
	});

	it("never joins the lines of a code block, which are units of their own", () => {
		const out = join([
			draft("a = 1", { unit: "3:0", code: true }),
			draft("b = 2", { unit: "3:1", code: true }),
			draft("c = 3", { unit: "3:2", code: true }),
		]);
		expect(out).toHaveLength(3);
	});

	it("changes nothing for sentences that are long enough, and does not touch its input", () => {
		const input = [sentence(80), sentence(90), sentence(120)];
		const before = JSON.stringify(input);
		const out = join(input);
		expect(out).toHaveLength(3);
		expect(JSON.stringify(input)).toBe(before);
		expect(join([])).toEqual([]);
	});

	it("does not mutate a draft it joins", () => {
		const first = draft("Sure.", { paragraphStart: true });
		const second = sentence(70);
		const before = JSON.stringify([first, second]);
		join([first, second]);
		expect(JSON.stringify([first, second])).toBe(before);
	});

	it("keeps the mark that ends a sentence and gives one that ends in none a full stop", () => {
		// "Wait" ends in no mark (a line break ends a sentence without one): the pause between it and
		// what follows is a full stop, which Zonos pauses at.
		const stopped = join([
			draft("Wait", { paragraphStart: true }),
			sentence(70),
		]);
		expect(textOf(stopped[0] as TestDraft).startsWith("Wait. word")).toBe(true);
		// A mark that pauses is kept as it is, not doubled: ".", "!", "?", "…", ",", ";" and ":".
		for (const mark of [".", "!", "?", "…", ",", ";", ":"]) {
			const kept = join([draft(`Wait${mark}`), sentence(70)]);
			expect(textOf(kept[0] as TestDraft).startsWith(`Wait${mark} word`)).toBe(
				true,
			);
		}
	});

	it("leaves a token at the length limit as it is rather than make it too long", () => {
		// The session route refuses a token over 80 characters: the stop is left off, and the
		// room it would have taken is not counted.
		const edge = "x".repeat(80);
		const out = join([
			draft(`hello ${edge}`, { unit: "0", paragraphStart: true }),
			draft("Thanks!", { unit: "1", paragraphStart: true }),
		]);
		expect(out).toHaveLength(1);
		expect(textOf(out[0] as TestDraft)).toBe(`hello ${edge} Thanks!`);
	});

	it("does not touch the tokens of a draft when it ends one with a stop", () => {
		const first = draft("Eggs", {
			unit: "1",
			list: "L1",
			paragraphStart: true,
		});
		const second = draft("Milk", { unit: "2", list: "L1" });
		const before = JSON.stringify([first, second]);
		const [out] = join([first, second]);
		expect(textOf(out as TestDraft)).toBe("Eggs. Milk");
		expect(JSON.stringify([first, second])).toBe(before);
	});
});

describe("joining the items of a list", () => {
	const item = (
		text: string,
		n: number,
		options: Parameters<typeof draft>[1] = {},
	) =>
		draft(text, { unit: `${n}`, list: "L1", paragraphStart: true, ...options });

	it("joins consecutive short items of one list into one unit, each ended by its own stop", () => {
		const out = join([
			item("Eggs", 1),
			item("Milk", 2),
			item("Flour", 3),
			item("Butter", 4),
		]);
		expect(out).toHaveLength(1);
		// The last item is not given a stop: the join adds one only where it joins.
		expect(textOf(out[0] as TestDraft)).toBe("Eggs. Milk. Flour. Butter");
		expect(out[0]?.paragraphStart).toBe(true);
		expect(out[0]?.unit).toBe("4");
	});

	it("keeps the stop an item has, and does not double it", () => {
		const out = join([item("Eggs.", 1), item("Milk;", 2), item("Flour", 3)]);
		expect(textOf(out[0] as TestDraft)).toBe("Eggs. Milk; Flour");
	});

	it("stops at fifty characters and starts the next unit", () => {
		// 30 + 1 + 30 = 61: long enough; the next two join each other the same way.
		const out = join([
			item(textOf(sentence(30)), 1),
			item(textOf(sentence(30)), 2),
			item(textOf(sentence(30)), 3),
			item(textOf(sentence(30)), 4),
		]);
		expect(out.map((d) => textOf(d).length)).toEqual([61, 61]);
		expect(out.map((d) => d.unit)).toEqual(["2", "4"]);
	});

	it("takes a short item into a long one after it, and into a long one before it", () => {
		const next = join([item("Eggs", 1), item(textOf(sentence(80)), 2)]);
		expect(next).toHaveLength(1);
		expect(textOf(next[0] as TestDraft)).toBe(`Eggs. ${textOf(sentence(80))}`);
		const before = join([item(textOf(sentence(80)), 1), item("Eggs", 2)]);
		expect(before).toHaveLength(1);
		expect(textOf(before[0] as TestDraft)).toBe(`${textOf(sentence(80))} Eggs`);
	});

	it("never lets a unit of items pass the length the script splits at", () => {
		// 230 + 1 + 30 = 261: the short item in the middle fits neither side.
		const out = join([
			item(textOf(sentence(230)), 1),
			item(textOf(sentence(30)), 2),
			item(textOf(sentence(230)), 3),
		]);
		expect(out.map((d) => textOf(d).length)).toEqual([230, 30, 230]);
	});

	it("counts the stop it adds towards the length limit, and only when it adds one", () => {
		// 39 characters with no stop: the stop makes it 40, and 40 + 1 + 199 = 240 fits.
		const bare = "w".repeat(39);
		const fits = join([item(bare, 1), item(textOf(sentence(199)), 2)]);
		expect(fits).toHaveLength(1);
		expect(textOf(fits[0] as TestDraft)).toHaveLength(240);
		// One character more does not.
		expect(join([item(bare, 1), item(textOf(sentence(200)), 2)])).toHaveLength(
			2,
		);
		// 40 characters that end in a stop need none: 40 + 1 + 199 = 240 fits as well.
		const stopped = `${"w".repeat(39)}.`;
		const kept = join([item(stopped, 1), item(textOf(sentence(199)), 2)]);
		expect(kept).toHaveLength(1);
		expect(textOf(kept[0] as TestDraft)).toHaveLength(240);
		expect(
			join([item(stopped, 1), item(textOf(sentence(200)), 2)]),
		).toHaveLength(2);
	});

	it("never joins the items of different lists", () => {
		const out = join([
			item("Eggs", 1, { list: "L1" }),
			item("Milk", 2, { list: "L2" }),
		]);
		expect(out).toHaveLength(2);
	});

	it("never joins an item to a paragraph that is not in its list", () => {
		// An item is not a one-line paragraph: only the items of its own list take it.
		const out = join([
			item("Eggs", 1),
			sentence(80, { unit: "2", paragraphStart: true }),
			sentence(80, { unit: "2" }),
		]);
		expect(out).toHaveLength(3);
	});

	it("never joins items across a heading, a code line or a change of language", () => {
		expect(
			join([
				item("Eggs", 1),
				draft("Milk.", { unit: "2", list: "L1", heading: true }),
			]),
		).toHaveLength(2);
		expect(
			join([
				item("Eggs", 1),
				draft("milk = 1", { unit: "2:0", list: "L1", code: true }),
			]),
		).toHaveLength(2);
		expect(
			join([item("Eggs", 1), item("Tej", 2, { language: "hu" })]),
		).toHaveLength(2);
	});

	it("leaves an item alone when it is the only one of its list and nothing near takes it", () => {
		const out = join([
			sentence(90, { unit: "0", paragraphStart: true }),
			item("Eggs", 1),
			sentence(90, { unit: "2", paragraphStart: true }),
		]);
		expect(out.map((d) => textOf(d).length)).toEqual([90, 4, 90]);
	});

	it("does not mutate the items it joins", () => {
		const input = [item("Eggs", 1), item("Milk", 2)];
		const before = JSON.stringify(input);
		join(input);
		expect(JSON.stringify(input)).toBe(before);
	});
});

describe("joining a paragraph of one short sentence", () => {
	const para = (
		text: string,
		n: number,
		options: Parameters<typeof draft>[1] = {},
	) => draft(text, { unit: `${n}`, paragraphStart: true, ...options });

	it("joins the next paragraph: 'Sure!' and the answer are one unit", () => {
		const out = join([
			para("Sure!", 0),
			sentence(80, { unit: "1", paragraphStart: true }),
			sentence(80, { unit: "1" }),
		]);
		expect(out).toHaveLength(2);
		expect(textOf(out[0] as TestDraft)).toBe(`Sure! ${textOf(sentence(80))}`);
		// The unit starts where "Sure!" does, and the sentence after it is no paragraph's start now.
		expect(out[0]?.paragraphStart).toBe(true);
		expect(out[1]?.paragraphStart).toBe(false);
		expect(textOf(out[1] as TestDraft)).toBe(textOf(sentence(80)));
	});

	it("takes only the first sentence of the next paragraph, not the whole paragraph", () => {
		const out = join([
			para("Sure!", 0),
			sentence(120, { unit: "1", paragraphStart: true }),
			sentence(120, { unit: "1" }),
			sentence(120, { unit: "1" }),
		]);
		expect(out.map((d) => textOf(d).length)).toEqual([5 + 1 + 120, 120, 120]);
	});

	it("gives the first sentence a full stop when it has no pause mark", () => {
		const out = join([
			para("Sure", 0),
			sentence(80, { unit: "1", paragraphStart: true }),
		]);
		expect(textOf(out[0] as TestDraft).startsWith("Sure. word")).toBe(true);
	});

	it("keeps joining paragraphs of one short sentence while the unit is short", () => {
		const out = join([
			para("Yes.", 0),
			para("Done.", 1),
			para("Okay.", 2),
			sentence(60, { unit: "3", paragraphStart: true }),
		]);
		expect(out).toHaveLength(1);
		expect(textOf(out[0] as TestDraft)).toBe(
			`Yes. Done. Okay. ${textOf(sentence(60))}`,
		);
		expect(out[0]?.paragraphStart).toBe(true);
	});

	it("goes on across paragraphs while the unit it has made is still short", () => {
		// "Hi." took the first sentence of the next paragraph; with that paragraph's other sentence
		// the unit is 11 characters, and still takes the paragraph after it.
		const out = join([
			para("Hi.", 0),
			para("Yo.", 1),
			draft("Ok.", { unit: "1" }),
			sentence(80, { unit: "2", paragraphStart: true }),
		]);
		expect(out).toHaveLength(1);
		expect(textOf(out[0] as TestDraft)).toBe(
			`Hi. Yo. Ok. ${textOf(sentence(80))}`,
		);
	});

	it("is not a paragraph of one sentence when it has two: those join each other, not the next paragraph", () => {
		const out = join([
			para("Ok.", 0),
			draft("Fine.", { unit: "0" }),
			sentence(80, { unit: "1", paragraphStart: true }),
		]);
		expect(out.map((d) => textOf(d))).toEqual([
			"Ok. Fine.",
			textOf(sentence(80)),
		]);
	});

	it("joins the paragraph before when it is the last one", () => {
		const out = join([
			sentence(90, { unit: "0", paragraphStart: true }),
			para("Thanks!", 1),
		]);
		expect(out).toHaveLength(1);
		expect(textOf(out[0] as TestDraft)).toBe(`${textOf(sentence(90))} Thanks!`);
		expect(out[0]?.paragraphStart).toBe(true);
	});

	it("joins the paragraph before when the one after it is not one it may join", () => {
		const heading = para("Next steps.", 2, { heading: true });
		const out = join([
			sentence(90, { unit: "0", paragraphStart: true }),
			para("Thanks!", 1),
			heading,
		]);
		expect(out).toHaveLength(2);
		expect(textOf(out[0] as TestDraft)).toBe(`${textOf(sentence(90))} Thanks!`);
		expect(out[1]).toBe(heading);
	});

	it("never joins a paragraph of one short sentence across a heading", () => {
		const out = join([
			para("Intro.", 0, { heading: true }),
			para("Sure!", 1),
			para("Next steps.", 2, { heading: true }),
		]);
		expect(out).toHaveLength(3);
	});

	it("never joins it to a code line, before or after", () => {
		const code = draft("a = 1", {
			unit: "1:0",
			code: true,
			paragraphStart: true,
		});
		expect(join([para("Sure!", 0), code])).toHaveLength(2);
		expect(join([code, para("Sure!", 2)])).toHaveLength(2);
	});

	it("never joins it to a paragraph in another language", () => {
		expect(
			join([
				para("Igen.", 0, { language: "hu" }),
				sentence(80, { unit: "1", paragraphStart: true, language: "en" }),
			]),
		).toHaveLength(2);
		expect(
			join([
				sentence(80, { unit: "0", paragraphStart: true, language: "en" }),
				para("Igen.", 1, { language: "hu" }),
			]),
		).toHaveLength(2);
	});

	it("never lets the joined unit pass the length the script splits at", () => {
		// "Sure!" 5 + 1 + 235 = 241; the paragraph before fits it (100 + 1 + 5).
		const out = join([
			sentence(100, { unit: "0", paragraphStart: true }),
			para("Sure!", 1),
			sentence(235, { unit: "2", paragraphStart: true }),
		]);
		expect(out.map((d) => textOf(d).length)).toEqual([100 + 1 + 5, 235]);
		// And stays alone when neither side has room.
		const alone = join([
			sentence(238, { unit: "0", paragraphStart: true }),
			para("Sure!", 1),
			sentence(238, { unit: "2", paragraphStart: true }),
		]);
		expect(alone.map((d) => textOf(d).length)).toEqual([238, 5, 238]);
	});

	it("joins the first item of a list, and the items after it by the list's rule", () => {
		const out = join([
			para("Ingredients:", 0),
			draft("Eggs", { unit: "1", list: "L1", paragraphStart: true }),
			draft("Milk", { unit: "2", list: "L1", paragraphStart: true }),
			draft("Flour", { unit: "3", list: "L1", paragraphStart: true }),
		]);
		expect(out).toHaveLength(1);
		// "Ingredients:" ends in a pause mark already: no stop after it.
		expect(textOf(out[0] as TestDraft)).toBe("Ingredients: Eggs. Milk. Flour");
	});

	it("joins the items before it when it is a paragraph of one short sentence after a list", () => {
		// The paragraph is the short one, so it takes the item before it; the items, which are not
		// one-line paragraphs, do not take the paragraph after them.
		const out = join([
			draft("Install the package", {
				unit: "1",
				list: "L1",
				paragraphStart: true,
			}),
			draft("Run the tests", { unit: "2", list: "L1", paragraphStart: true }),
			para("That is it!", 3),
		]);
		expect(out).toHaveLength(1);
		expect(textOf(out[0] as TestDraft)).toBe(
			"Install the package. Run the tests. That is it!",
		);
	});

	it("leaves a paragraph of one short sentence alone when nothing can take it", () => {
		expect(join([para("Hello.", 0)])).toHaveLength(1);
		expect(
			join([para("Hello.", 0), para("Next steps.", 1, { heading: true })]),
		).toHaveLength(2);
	});

	it("does not mutate the drafts it joins", () => {
		const input = [
			para("Sure", 0),
			sentence(80, { unit: "1", paragraphStart: true }),
		];
		const before = JSON.stringify(input);
		join(input);
		expect(JSON.stringify(input)).toBe(before);
	});
});
