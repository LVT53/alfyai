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
};

function draft(
	text: string,
	options: Partial<Pick<TestDraft, "language" | "paragraphStart" | "unit">> & {
		heading?: boolean;
	} = {},
): TestDraft {
	return {
		language: options.language ?? "en",
		paragraphStart: options.paragraphStart ?? false,
		unit: options.unit ?? "0",
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

	it("never joins across a paragraph", () => {
		const out = join([
			sentence(80, { unit: "0", paragraphStart: true }),
			draft("Short one.", { unit: "1", paragraphStart: true }),
			sentence(80, { unit: "2", paragraphStart: true }),
		]);
		expect(out).toHaveLength(3);
		expect(out.map((d) => d.unit)).toEqual(["0", "1", "2"]);
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
			draft("a = 1", { unit: "3:0" }),
			draft("b = 2", { unit: "3:1" }),
			draft("c = 3", { unit: "3:2" }),
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

	it("makes no pause mark of its own: the marks that end the sentences stay as they are", () => {
		const out = join([draft("Wait", { paragraphStart: true }), sentence(70)]);
		// A sentence that ends in no mark is joined as it stands (the script's sentences end in one).
		expect(textOf(out[0] as TestDraft).startsWith("Wait word")).toBe(true);
	});
});
