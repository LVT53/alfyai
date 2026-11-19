import { describe, expect, it } from "vitest";
import { OWN_WORDS_MAX, ownWords, VOICE_SAMPLES } from "./voice-samples";

describe("the voice samples", () => {
	it("holds two sentences per language, each within the preview's 300 characters, the second a question", () => {
		for (const language of ["en", "hu"] as const) {
			const sample = VOICE_SAMPLES[language];
			expect(sample).toHaveLength(2);
			for (const sentence of sample) {
				expect(sentence.length).toBeGreaterThan(0);
				expect(sentence.length).toBeLessThanOrEqual(300);
			}
			expect(sample[1].endsWith("?")).toBe(true);
			// The preview sends both as one text.
			expect(sample.join(" ").length).toBeLessThanOrEqual(300);
		}
	});

	it("says the sentences the plan and the owner fixed", () => {
		expect(VOICE_SAMPLES.en).toEqual([
			"Here's the short version: feed it once a day, keep it somewhere warm, and it will double in about six hours.",
			"Shall I read you the long one?",
		]);
		expect(VOICE_SAMPLES.hu).toEqual([
			"Röviden: ha minden nap eteted, és meleg helyen tartod, körülbelül hat óra alatt megduplázódik.",
			"Elolvassam a hosszabb változatot is?",
		]);
	});
});

describe("the person's own words", () => {
	it("takes the person's words only when they hold a letter or a digit", () => {
		expect(OWN_WORDS_MAX).toBe(300);
		expect(ownWords("  ")).toBeNull();
		expect(ownWords("")).toBeNull();
		expect(ownWords("→ ★ …")).toBeNull();
		expect(ownWords("a".repeat(301))).toBeNull();
		expect(ownWords("  Hello there. ")).toBe("Hello there.");
		expect(ownWords("42")).toBe("42");
		expect(ownWords("Árvíztűrő tükörfúrógép")).toBe("Árvíztűrő tükörfúrógép");
	});

	it("counts code points, not UTF-16 units, against the limit", () => {
		expect(ownWords("a".repeat(300))).toBe("a".repeat(300));
		// 300 emoji are 600 UTF-16 units but 300 code points.
		expect(ownWords(`${"😀".repeat(299)}a`)).toBe(`${"😀".repeat(299)}a`);
		expect(ownWords(`${"😀".repeat(300)}a`)).toBeNull();
		// A huge text is refused without being walked.
		expect(ownWords("x".repeat(5_000_000))).toBeNull();
	});
});
