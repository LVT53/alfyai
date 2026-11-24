import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import {
	foldedGlob,
	foldedSnippet,
	indexPhrase,
	likeSpellings,
	usesSearchIndex,
	wordSpellings,
} from "./patterns";

// The patterns are only worth what SQLite does with them, so these run on a
// real in-memory SQLite, the same engine the app bundles.
const sqlite = new Database(":memory:");
afterAll(() => sqlite.close());

function globHits(text: string, term: string): boolean {
	const row = sqlite
		.prepare("select ? glob ? as hit")
		.get(text, foldedGlob(term));
	return (row as { hit: number }).hit === 1;
}

function likeHits(text: string, word: string): boolean {
	const row = sqlite
		.prepare(
			`select ${likeSpellings(word)
				.map(() => "? like ? escape '\\'")
				.join(" or ")} as hit`,
		)
		.get(...likeSpellings(word).flatMap((pattern) => [text, pattern]));
	return (row as { hit: number }).hit === 1;
}

describe("wordSpellings", () => {
	it("gives the word as typed, capitalised and in capitals, once each", () => {
		expect(wordSpellings("árvíz")).toEqual(["árvíz", "Árvíz", "ÁRVÍZ"]);
		expect(wordSpellings("kitchen")).toEqual(["kitchen", "Kitchen", "KITCHEN"]);
		expect(wordSpellings("ő")).toEqual(["ő", "Ő"]);
		expect(wordSpellings("123")).toEqual(["123"]);
	});

	it("capitalises the first letter, not the first code unit", () => {
		expect(wordSpellings("😀ab")).toEqual(["😀ab", "😀AB"]);
		expect(wordSpellings("😀")).toEqual(["😀"]);
	});
});

describe("likeSpellings", () => {
	it("wraps each spelling for LIKE and escapes its wildcards", () => {
		expect(likeSpellings("árvíz")).toEqual(["%árvíz%", "%Árvíz%", "%ÁRVÍZ%"]);
		expect(likeSpellings("100%_\\")).toEqual(["%100\\%\\_\\\\%"]);
	});

	it("matches the typed, capitalised and capital spellings in SQLite", () => {
		expect(likeHits("Az Árvíztűrő tükörfúrógép", "árvíz")).toBe(true);
		expect(likeHits("AZ ÁRVÍZTŰRŐ", "árvíz")).toBe(true);
		expect(likeHits("az árvíztűrő", "árvíz")).toBe(true);
		expect(likeHits("100 percent", "100%")).toBe(false);
		expect(likeHits("a 100% rise", "100%")).toBe(true);
		expect(likeHits("axb", "a_b")).toBe(false);
		expect(likeHits("a_b", "a_b")).toBe(true);
	});
});

describe("foldedGlob", () => {
	it("finds a word anywhere in a text, ignoring case and accents", () => {
		for (const text of [
			"Árvíztűrő tükörfúrógép",
			"ÁRVÍZ",
			"arviz",
			"xx árvíz yy",
			"Az ÁrVíZtűrő",
		]) {
			expect(globHits(text, "arviz"), text).toBe(true);
		}
		expect(globHits("arvi z", "arviz")).toBe(false);
		expect(globHits("árv", "arviz")).toBe(false);
		expect(globHits("Kitchen plan", "arviz")).toBe(false);
	});

	it("takes an accented term the same way", () => {
		expect(globHits("arviz", "árvíz")).toBe(true);
		expect(globHits("ÁRVÍZTŰRŐ", "árvíz")).toBe(true);
		expect(globHits("Tűrő", "turo")).toBe(true);
		expect(globHits("Mouse", "mouse")).toBe(true);
		expect(globHits("Naïve café", "naive cafe")).toBe(true);
	});

	it("keeps digits and inner punctuation, and reads GLOB's own characters as text", () => {
		expect(globHits("Send an E-Mail now", "e-mail")).toBe(true);
		expect(globHits("scale 1:50", "1:50")).toBe(true);
		expect(globHits("xa*by", "a*b")).toBe(true);
		expect(globHits("axxb", "a*b")).toBe(false);
		expect(globHits("w?z", "w?z")).toBe(true);
		expect(globHits("wuz", "w?z")).toBe(false);
		expect(globHits("q[b]c", "q[b]c")).toBe(true);
		expect(globHits("qbc", "q[b]c")).toBe(false);
		expect(globHits("a%b", "a%b")).toBe(true);
		expect(globHits("axb", "a%b")).toBe(false);
	});

	it("stays inside SQLite's pattern length for the longest word", () => {
		// SQLite refuses a LIKE or GLOB pattern over 50,000 bytes. A word is at
		// most 64 characters, and the letters with the most variants (u, o, e)
		// are the worst case.
		for (const letter of ["a", "e", "o", "u"]) {
			const word = letter.repeat(64);
			const pattern = foldedGlob(word);
			expect(Buffer.byteLength(pattern)).toBeLessThan(50_000);
			const row = sqlite.prepare("select ? glob ? as hit").get(word, pattern);
			expect((row as { hit: number }).hit).toBe(1);
		}
	});
});

describe("the index's words", () => {
	it("doubles a quote inside a phrase, and quotes the whole word", () => {
		expect(indexPhrase('o"neil')).toBe('"o""neil"');
		expect(indexPhrase("árvíz")).toBe('"árvíz"');
		// SQLite reads the doubled quote back as one quote.
		sqlite.exec(
			"create virtual table if not exists phrase_probe using fts5(t, tokenize='trigram remove_diacritics 1')",
		);
		sqlite
			.prepare("insert into phrase_probe(t) values (?)")
			.run('say o"neil now');
		const hits = sqlite
			.prepare(
				"select count(*) as hits from phrase_probe where phrase_probe match ?",
			)
			.get(indexPhrase('o"neil')) as { hits: number };
		expect(hits.hits).toBe(1);
	});

	it("uses the index for a word of three letters or more", () => {
		expect(usesSearchIndex("ai")).toBe(false);
		expect(usesSearchIndex("új")).toBe(false);
		expect(usesSearchIndex("árv")).toBe(true);
		// Characters, not UTF-16 units: two emoji are two characters.
		expect(usesSearchIndex("😀😀")).toBe(false);
	});
});

describe("foldedSnippet", () => {
	it("finds a word typed without accents far into a long text", () => {
		const text = `${"x".repeat(900_000)} the Árvíztűrő machine ${"y".repeat(100_000)}`;
		const snippet = foldedSnippet(text, ["arviz"], 160);
		expect(snippet).toContain("Árvíztűrő");
		expect(snippet?.startsWith("…")).toBe(true);
		expect(snippet?.length).toBeLessThanOrEqual(162);
	});

	it("still finds it when folding shifts positions past the window", () => {
		const text = `${"ﬁ".repeat(1_000)} then Árvíz here`;
		expect(foldedSnippet(text, ["arviz"], 160)).toContain("Árvíz");
	});

	it("returns null when no word is there", () => {
		expect(foldedSnippet("nothing to see", ["arviz"], 160)).toBeNull();
		expect(foldedSnippet("", ["arviz"], 160)).toBeNull();
	});
});
