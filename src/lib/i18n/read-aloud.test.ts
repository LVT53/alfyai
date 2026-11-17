import { describe, expect, it } from "vitest";
import { collectDictionaryKeys } from "../i18n.test-helpers";
import readAloudDict from "./read-aloud";

const placeholders = (text: string) =>
	[...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("read aloud i18n dictionary", () => {
	it("has an en key for every hu key and vice versa", () => {
		expect(Object.keys(readAloudDict.hu).sort()).toEqual(
			Object.keys(readAloudDict.en).sort(),
		);
	});

	it("has no empty translations, and every key is under readAloud.", () => {
		for (const language of ["en", "hu"] as const) {
			for (const [key, value] of Object.entries(readAloudDict[language])) {
				expect(key.startsWith("readAloud."), key).toBe(true);
				expect(value.trim(), `${language}.${key}`).not.toBe("");
			}
		}
	});

	it("keeps every placeholder in both languages", () => {
		for (const [key, value] of Object.entries(readAloudDict.en)) {
			const hu = readAloudDict.hu[key as keyof typeof readAloudDict.hu];
			expect(placeholders(hu), key).toEqual(placeholders(value));
		}
	});

	it("says the notes in the Copy section's words", () => {
		expect(
			readAloudDict.en["readAloud.note.noVoice"].replace(
				"{language}",
				"German",
			),
		).toBe("Read aloud isn't available in German yet.");
		expect(
			readAloudDict.hu["readAloud.note.noVoice"].replace("{language}", "Német"),
		).toBe("Német nyelvű felolvasás még nem érhető el.");
		expect(
			readAloudDict.hu["readAloud.scrubber.value"]
				.replace("{n}", "4")
				.replace("{total}", "9"),
		).toBe("4. mondat, összesen 9");
	});

	it("says the spec's sentences", () => {
		const en: Record<string, string> = readAloudDict.en;
		expect(en["readAloud.settings.empty"]).toBe(
			"Make a voice of your own: start from one of the built-in voices and change how it sounds. Only you will see it.",
		);
		expect(
			en["readAloud.settings.baseMissingEn"]?.replace("{voice}", "Imogen"),
		).toBe(
			"Imogen isn't available any more, so this voice reads as your English voice for now.",
		);
		// The spec writes a note and its button as one sentence; the button's label
		// ("Try again", Plan 2's, reused) has no full stop of its own.
		expect(
			`${en["readAloud.editor.sampleFailed"]} ${en["readAloud.tryAgain"]}.`,
		).toBe("Couldn't play the sample. Try again.");
		expect(
			`${en["readAloud.editor.saveFailed"]} ${en["readAloud.tryAgain"]}.`,
		).toBe("Couldn't save this voice. Try again.");
	});

	it("names every knob word of the spec, in order", () => {
		// Spec §4.6, low to high; the keys in KNOB_KEYS order (voice-knobs.ts).
		const spec: Record<string, string[]> = {
			pace: [
				"Much slower",
				"Slower",
				"A little slower",
				"Normal",
				"A little faster",
				"Faster",
				"Much faster",
			],
			pitch: [
				"Much lower",
				"Lower",
				"A little lower",
				"Normal",
				"A little higher",
				"Higher",
			],
			depth: ["Normal", "A little fuller", "Deeper", "Much deeper"],
			energy: [
				"Very calm",
				"Calm",
				"A little calmer",
				"Normal",
				"A little livelier",
				"Lively",
				"Very lively",
			],
			projection: [
				"Breathy",
				"Softer",
				"A little softer",
				"Normal",
				"A little clearer",
				"Clearer",
				"Projected",
			],
		};
		const words = (language: "en" | "hu", knob: string) => {
			const dict: Record<string, string> = readAloudDict[language];
			const out: string[] = [];
			for (let i = 0; dict[`readAloud.knob.${knob}.${i}`] !== undefined; i++)
				out.push(dict[`readAloud.knob.${knob}.${i}`] as string);
			return out;
		};
		expect(Object.keys(spec)).toEqual([
			"pace",
			"pitch",
			"depth",
			"energy",
			"projection",
		]);
		expect(Object.values(spec).map((list) => list.length)).toEqual([
			7, 6, 4, 7, 7,
		]);
		const ends: Record<string, [string, string]> = {
			pace: ["Slower", "Faster"],
			pitch: ["Lower", "Higher"],
			depth: ["Normal", "Deeper"],
			energy: ["Calmer", "Livelier"],
			projection: ["Softer", "Projected"],
		};
		const en: Record<string, string> = readAloudDict.en;
		for (const [knob, list] of Object.entries(spec)) {
			expect(words("en", knob), knob).toEqual(list);
			expect(words("hu", knob), knob).toHaveLength(list.length);
			expect(en[`readAloud.knob.${knob}`], knob).toBeTruthy();
			expect(
				[en[`readAloud.knob.${knob}.low`], en[`readAloud.knob.${knob}.high`]],
				knob,
			).toEqual(ends[knob]);
		}
	});

	it("names every style and built-in voice", () => {
		const en: Record<string, string> = readAloudDict.en;
		const hu: Record<string, string> = readAloudDict.hu;
		const styles: Record<string, [string, string]> = {
			original: ["Original", "Eredeti"],
			bedtime: ["Bedtime", "Esti"],
			storyteller: ["Storyteller", "Mesélő"],
			brisk: ["Brisk", "Lendületes"],
			calmAndClear: ["Calm and clear", "Nyugodt és tiszta"],
			cheerful: ["Cheerful", "Vidám"],
			newsreader: ["Newsreader", "Hírolvasó"],
		};
		for (const [key, [english, hungarian]] of Object.entries(styles)) {
			expect(en[`readAloud.style.${key}`]).toBe(english);
			expect(hu[`readAloud.style.${key}`]).toBe(hungarian);
		}
		const voices: Record<string, [string, string]> = {
			imogen: ["British woman", "Brit nő"],
			rupert: ["British man", "Brit férfi"],
			savannah: ["American woman", "Amerikai nő"],
			wyatt: ["American man", "Amerikai férfi"],
			berta: ["Hungarian woman", "Magyar nő"],
			imre: ["Hungarian man", "Magyar férfi"],
		};
		for (const [key, [english, hungarian]] of Object.entries(voices)) {
			expect(en[`readAloud.voice.${key}`]).toBe(english);
			expect(hu[`readAloud.voice.${key}`]).toBe(hungarian);
		}
		expect(
			en["readAloud.voice.option"]
				?.replace("{name}", "Imogen")
				.replace("{description}", "British woman"),
		).toBe("Imogen · British woman");
		expect([en["readAloud.language.en"], hu["readAloud.language.hu"]]).toEqual([
			"English",
			"Magyar",
		]);
	});

	it("is watched by the parity test", () => {
		const keys = collectDictionaryKeys();
		expect(keys.en).toContain("readAloud.speaker.read");
		expect(keys.hu).toContain("readAloud.readFromHere");
	});
});
