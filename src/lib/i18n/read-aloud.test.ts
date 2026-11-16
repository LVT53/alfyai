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

	it("is watched by the parity test", () => {
		const keys = collectDictionaryKeys();
		expect(keys.en).toContain("readAloud.speaker.read");
		expect(keys.hu).toContain("readAloud.readFromHere");
	});
});
