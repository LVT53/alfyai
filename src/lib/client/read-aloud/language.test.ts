import { beforeAll, describe, expect, it } from "vitest";
import {
	assignLanguages,
	isVoiced,
	languageDisplayName,
	loadDetector,
	SHORT_PARAGRAPH_LETTERS,
} from "./language";

const ENGLISH =
	"Mix the flour with the water, then add a pinch of salt. Knead the dough for ten minutes until it is smooth.";
const HUNGARIAN =
	"Keverd össze a lisztet a vízzel, majd adj hozzá egy csipet sót. Gyúrd a tésztát tíz percig, amíg sima nem lesz.";
const GERMAN =
	"Mische das Mehl mit dem Wasser und gib eine Prise Salz dazu. Knete den Teig zehn Minuten lang, bis er glatt ist.";

describe("the read-aloud language detector", () => {
	let detect: (text: string) => string;

	beforeAll(async () => {
		detect = await loadDetector();
	});

	it("loads tinyld once and keeps it", async () => {
		expect(await loadDetector()).toBe(detect);
	});

	it("names English and Hungarian paragraphs", () => {
		expect(assignLanguages([ENGLISH, HUNGARIAN], detect)).toEqual(["en", "hu"]);
	});

	it("names German, so the note can say so", () => {
		expect(assignLanguages([GERMAN], detect)).toEqual(["de"]);
	});

	it("a short paragraph takes the language before it", () => {
		// tinyld alone reads "Ingredients" as French.
		expect("Ingredients".length).toBeLessThan(SHORT_PARAGRAPH_LETTERS);
		expect(
			assignLanguages([ENGLISH, "Ingredients", HUNGARIAN], detect),
		).toEqual(["en", "en", "hu"]);
	});

	it("a short opening paragraph takes the next named one", () => {
		expect(
			assignLanguages(["Hozzávalók", "", HUNGARIAN, ENGLISH], detect),
		).toEqual(["hu", "hu", "hu", "en"]);
	});

	it("a paragraph the detector cannot name takes the language before it", () => {
		const unsure = (text: string) => (text === HUNGARIAN ? "" : detect(text));
		expect(assignLanguages([ENGLISH, HUNGARIAN], unsure)).toEqual(["en", "en"]);
	});

	it("a reply of only short paragraphs is detected as a whole", () => {
		expect(
			assignLanguages(["Hozzávalók", "Liszt", "Víz", "Só"], detect),
		).toEqual(["hu", "hu", "hu", "hu"]);
	});

	it("a reply with nothing to name gives no language", () => {
		expect(assignLanguages(["12", ""], detect)).toEqual(["", ""]);
		expect(assignLanguages([], detect)).toEqual([]);
	});
});

describe("voices and language names", () => {
	it("voices English and Hungarian only", () => {
		expect(isVoiced("en")).toBe(true);
		expect(isVoiced("hu")).toBe(true);
		expect(isVoiced("de")).toBe(false);
		expect(isVoiced("")).toBe(false);
	});

	it("names a language in the UI language, capitalised", () => {
		expect(languageDisplayName("de", "hu")).toBe("Német");
		expect(languageDisplayName("de", "en")).toBe("German");
	});

	it("names no language it does not know", () => {
		expect(languageDisplayName("xx", "en")).toBeNull();
		expect(languageDisplayName("", "en")).toBeNull();
		expect(languageDisplayName("not a code", "hu")).toBeNull();
	});
});
