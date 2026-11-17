import { describe, expect, it } from "vitest";
import readAloudDict from "$lib/i18n/read-aloud";
import {
	type Knobs,
	STYLES,
	ZERO_KNOBS,
} from "$lib/shared/read-aloud/voice-knobs";
import { suggestVoiceName } from "./voice-name";

/** The app's `t`, for the read-aloud words only. */
const translate =
	(locale: "en" | "hu") =>
	(key: string, values: Record<string, string> = {}) => {
		const dict: Record<string, string> = readAloudDict[locale];
		let text = dict[key] ?? key;
		for (const [name, value] of Object.entries(values))
			text = text.replace(`{${name}}`, value);
		return text;
	};

const named = (
	voiceName: string,
	knobs: Partial<Knobs>,
	locale: "en" | "hu" = "en",
) =>
	suggestVoiceName({
		voiceName,
		knobs: { ...ZERO_KNOBS, ...knobs },
		t: translate(locale),
		locale,
	});

const bedtime =
	STYLES.find((style) => style.key === "bedtime")?.knobs ?? ZERO_KNOBS;

describe("suggestVoiceName", () => {
	it("names a style with the voice", () => {
		expect(named("Imogen", bedtime)).toBe("Bedtime Imogen");
		expect(named("Imogen", bedtime, "hu")).toBe("Esti Imogen");
	});

	it("names the two biggest changes, lower-cased", () => {
		expect(named("Imogen", { pace: -1, energy: -3 })).toBe(
			"Imogen, very calm and slower",
		);
		expect(named("Imogen", { pace: -1, energy: -3 }, "hu")).toBe(
			"Imogen, nagyon nyugodt és lassabb",
		);
	});

	it("names only the first change when two would make it longer than 40", () => {
		// "Savannah, a little slower and a little livelier" is 47 characters.
		expect(named("Savannah", { pace: -0.6, energy: 1.2 })).toBe(
			"Savannah, a little slower",
		);
	});

	it("names one change", () => {
		expect(named("Rupert", { pitch: -1.5 })).toBe("Rupert, much lower");
	});

	it("says it is the person's own when nothing changed", () => {
		expect(named("Imogen", {})).toBe("My Imogen");
		expect(named("Imogen", {}, "hu")).toBe("Saját Imogen");
	});

	it("cuts a long voice name to 40", () => {
		const name = named("W".repeat(50), {});
		expect([...name]).toHaveLength(40);
		expect(name.startsWith("My WWW")).toBe(true);
	});
});
