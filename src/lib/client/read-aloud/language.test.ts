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
		// Latin shows nothing only English or only Hungarian writes, so the detector decides.
		const LATIN =
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.";
		const unsure = (text: string) => (text === LATIN ? "" : detect(text));
		expect(assignLanguages([ENGLISH, LATIN], unsure)).toEqual(["en", "en"]);
	});

	it("a reply of only short paragraphs is detected as a whole", () => {
		expect(
			assignLanguages(["Hozzávalók", "Liszt", "Víz", "Só"], detect),
		).toEqual(["hu", "hu", "hu", "hu"]);
	});

	it("reads a reply of only short paragraphs as English or Hungarian, never as a language it guessed", () => {
		// tinyld alone names these French, German, Irish, Berber and Dutch.
		expect(assignLanguages(["Rendben."], detect)).toEqual(["hu"]);
		expect(assignLanguages(["Igen, pontosan."], detect)).toEqual(["hu"]);
		expect(assignLanguages(["Great question."], detect)).toEqual(["en"]);
		expect(assignLanguages(["Yes."], detect)).toEqual(["en"]);
		expect(
			assignLanguages(["Ingredients", "Flour", "Water", "Salt"], detect),
		).toEqual(["en", "en", "en", "en"]);
	});

	it("names ordinary English and Hungarian paragraphs right where tinyld alone misnames them", () => {
		// tinyld alone: German, Czech, Czech and Hungarian (early review R12); then Hungarian
		// and English (the final review's minor 15). An English voice never reads Hungarian,
		// and a Hungarian or English paragraph is never skipped as another language.
		const cases: [string, string][] = [
			["A fájlt a beállítások menüben tudod feltölteni.", "hu"],
			["Az API-t a JSON formátumú válasz miatt érdemes használni.", "hu"],
			["The API returns JSON with an id, a name and an array of tags.", "en"],
			["The Python script reads the CSV file and prints the total.", "en"],
			["Budapest, Debrecen, Szeged, Pécs and Győr are large cities.", "en"],
			[
				"Futtasd az npm install parancsot, majd az npm run dev parancsot a szerver indításához.",
				"hu",
			],
		];
		for (const [paragraph, code] of cases)
			expect(assignLanguages([paragraph], detect), paragraph).toEqual([code]);
	});

	it("still names a paragraph in a language with no voice", () => {
		expect(
			assignLanguages(
				[
					"Der Hund läuft schnell durch den großen Garten. Die Kinder spielen draußen mit dem Ball und lachen laut.",
				],
				detect,
			),
		).toEqual(["de"]);
		expect(
			assignLanguages(
				[
					"Le chien court chaque matin dans le parc et aboie très fort, parce qu'il est content de respirer l'air frais.",
				],
				detect,
			),
		).toEqual(["fr"]);
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
