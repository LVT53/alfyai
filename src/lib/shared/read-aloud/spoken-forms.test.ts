import { describe, expect, it } from "vitest";
import {
	addressHost,
	codeKindOf,
	isSeparator,
	keepsSentenceOpen,
	speakWord,
	type WordKind,
} from "./spoken-forms";

// Spec §4.4 (refined 2026-11-16): the examples the owner approved, in both
// languages. The English forms are the spec's; the Hungarian ones the spec
// leaves open are the plan's (Decision 11).
const SPEC: Array<[shown: string, kind: WordKind, en: string, hu: string]> = [
	["ArrayList", "code", "Array List", "Array List"],
	["getUserName", "code", "get User Name", "get User Name"],
	["user_id", "code", "user id", "user id"],
	["MAX_SIZE", "code", "max size", "max size"],
	["a.b", "code", "a dot b", "a pont b"],
	["A::B", "code", "A double colon B", "A dupla kettőspont B"],
	["->", "code", "arrow", "nyíl"],
	["=>", "code", "arrow", "nyíl"],
	["=", "code", "equals", "egyenlő"],
	["==", "code", "double equals", "dupla egyenlő"],
	["===", "code", "triple equals", "tripla egyenlő"],
	["!=", "code", "not equals", "nem egyenlő"],
	["<", "code", "less than", "kisebb mint"],
	[">", "code", "greater than", "nagyobb mint"],
	["<=", "code", "less than or equal", "kisebb vagy egyenlő"],
	[">=", "code", "greater than or equal", "nagyobb vagy egyenlő"],
	["+", "code", "plus", "plusz"],
	["-", "code", "minus", "mínusz"],
	["my-class", "code", "my class", "my class"],
	["++", "code", "plus plus", "plusz plusz"],
	["--", "code", "minus minus", "mínusz mínusz"],
	["+=", "code", "plus equals", "plusz egyenlő"],
	["-=", "code", "minus equals", "mínusz egyenlő"],
	["!", "code", "not", "nem"],
	["%", "code", "mod", "modulo"],
	["&&", "code", "and", "és"],
	["||", "code", "or", "vagy"],
	["|", "shell", "pipe", "pájp"],
	["*", "code", "star", "csillag"],
	["src/lib", "code", "src slash lib", "src per lib"],
	["<T>", "code", "of T", "T típusú"],
	["List<T>", "code", "List of T", "List T típusú"],
	["foo();", "code", "foo", "foo"],
	["println", "code", "print line", "print lájn"],
	// The spec writes "console dot write line"; a name keeps its case, as "Array List" does.
	[
		"Console.WriteLine",
		"code",
		"console dot Write Line",
		"konzol pont Write Line",
	],
	["def", "code", "define", "definiál"],
	["elif", "code", "else if", "elsz if"],
	["__init__", "code", "dunder init", "dander init"],
	["kwargs", "code", "keyword args", "kulcsszavas argumentumok"],
	["len", "code", "length", "hossz"],
	["console.log", "code", "console dot log", "konzol pont log"],
	["NaN", "code", "not a number", "nem szám"],
	["printf", "code", "print f", "print ef"],
	["std::cout", "code", "standard c out", "standard szí aut"],
	["#include", "code", "include", "inklúd"],
	["fmt.Println", "code", "format dot print line", "format pont print lájn"],
	[":=", "code", "colon equals", "kettőspont egyenlő"],
	["fn", "code", "function", "függvény"],
	["mut", "code", "mutable", "módosítható"],
	["println!", "code", "print line", "print lájn"],
	["fun", "code", "function", "függvény"],
	["func", "code", "function", "függvény"],
	["$name", "code", "name", "name"],
	["SELECT", "code", "select", "szelekt"],
	["chmod", "shell", "change mode", "cséndzs mód"],
	["~", "shell", "home", "hóm"],
	["<div>", "code", "div tag", "div tag"],
	[".class", "code", "dot class", "pont class"],
	["SQL", "code", "S Q L", "esz kú el"],
	["JSON", "code", "Jason", "dzséjszon"],
	["API", "code", "A P I", "á pé í"],
	["URL", "code", "U R L", "ú er el"],
	["HTML", "code", "H T M L", "há té em el"],
	["CSS", "code", "C S S", "cé esz esz"],
	["npm", "code", "N P M", "en pé em"],
	["YAML", "code", "yamel", "jemel"],
	["GUI", "code", "gooey", "gúi"],
	[
		"https://www.example.com/a?b=1",
		"prose",
		"example dot com",
		"example pont com",
	],
	[
		"anna@example.com",
		"prose",
		"anna at example dot com",
		"anna kukac example pont com",
	],
	["report.pdf", "prose", "report dot pdf", "report pont pdf"],
	["×", "prose", "times", "szorozva"],
	["÷", "prose", "divided by", "osztva"],
	["±", "prose", "plus or minus", "plusz mínusz"],
	["≤", "prose", "less than or equal to", "kisebb vagy egyenlő"],
	["≥", "prose", "greater than or equal to", "nagyobb vagy egyenlő"],
	["≠", "prose", "not equal to", "nem egyenlő"],
	["≈", "prose", "approximately", "körülbelül"],
	["x²", "prose", "x squared", "x négyzet"],
	["x³", "prose", "x cubed", "x köb"],
	["½", "prose", "half", "fél"],
	["°", "prose", "degrees", "fok"],
	["%", "prose", "percent", "százalék"],
	["Ctrl+C", "prose", "Control C", "kontrol C"],
	["⌘K", "prose", "Command K", "kommand K"],
	["Shift+Enter", "prose", "Shift Enter", "sift Enter"],
	["v2.3.1", "prose", "version 2.3.1", "verzió 2.3.1"],
];

describe("spoken forms: the spec's examples", () => {
	it.each(SPEC)("reads %s as the spec says", (shown, kind, en, hu) => {
		expect(speakWord(shown, kind, "en").join(" ")).toBe(en);
		expect(speakWord(shown, kind, "hu").join(" ")).toBe(hu);
	});

	const ABBREVIATIONS: Array<
		[shown: string, language: "en" | "hu", spoken: string]
	> = [
		["pl.", "hu", "például"],
		["kb.", "hu", "körülbelül"],
		["stb.", "hu", "és a többi"],
		["ún.", "hu", "úgynevezett"],
		["ill.", "hu", "illetve"],
		["db", "hu", "darab"],
		["e.g.", "en", "for example"],
		["i.e.", "en", "that is"],
		["etc.", "en", "et cetera"],
	];
	it.each(
		ABBREVIATIONS,
	)("reads %s in %s as the spec says", (shown, language, spoken) =>
		expect(speakWord(shown, "prose", language).join(" ")).toBe(spoken));
});

describe("spoken forms: the rules around the examples", () => {
	it("reads an abbreviation only in its own language, keeping a capital and the marks after it", () => {
		expect(speakWord("Pl.", "prose", "hu")).toEqual(["Például"]);
		expect(speakWord("stb.,", "prose", "hu")).toEqual(["és", "a", "többi,"]);
		expect(speakWord("pl.", "prose", "en")).toEqual(["pl."]);
	});

	it("reads an acronym with a Hungarian suffix, and leaves lower-case prose alone", () => {
		expect(speakWord("API-t", "prose", "hu")).toEqual(["á", "pé", "ít"]);
		expect(speakWord("api", "prose", "hu")).toEqual(["api"]);
		expect(speakWord("JSON", "prose", "en")).toEqual(["Jason"]);
	});

	it("keeps the marks around an address", () => {
		expect(speakWord("(https://example.com/x).", "prose", "en")).toEqual([
			"example",
			"dot",
			"com).",
		]);
	});

	it("leaves numbers and units in prose to the speech service", () => {
		for (const word of ["20%", "20°C", "3×4", "12", "m²"]) {
			expect(speakWord(word, "prose", "en")).toEqual([word]);
			expect(speakWord(word, "prose", "hu")).toEqual([word]);
		}
	});

	it("skips long hashes, ids and keys, and reads a name that holds a digit", () => {
		expect(speakWord("a3f9c2b18e7d4b2a", "code", "en")).toEqual([]);
		expect(
			speakWord("550e8400-e29b-41d4-a716-446655440000", "code", "en"),
		).toEqual([]);
		expect(speakWord("getUserName2", "code", "en")).toEqual([
			"get",
			"User",
			"Name",
			"two",
		]);
	});

	it("writes whole numbers up to 99 in code as words", () => {
		expect(speakWord("x=2", "code", "hu")).toEqual(["x", "egyenlő", "kettő"]);
		expect(speakWord("1.5", "code", "en")).toEqual(["1.5"]);
		expect(speakWord("1_000", "code", "en")).toEqual(["1000"]);
		expect(speakWord("2026-11-16", "code", "en")).toEqual(["2026-11-16"]);
	});

	it("reads list numbers as words", () => {
		expect(speakWord("1.", "listNumber", "en")).toEqual(["One."]);
		expect(speakWord("1.", "listNumber", "hu")).toEqual(["Egy."]);
		expect(speakWord("12.", "listNumber", "hu")).toEqual(["Tizenkettő."]);
		expect(speakWord("21)", "listNumber", "en")).toEqual(["Twenty-one."]);
		expect(speakWord("120.", "listNumber", "en")).toEqual(["120,"]);
		expect(speakWord("120.", "listNumber", "hu")).toEqual(["120,"]);
	});

	it("reads an if test the way a teacher says it", () => {
		const read = (language: "en" | "hu") =>
			["if", "x", "<", "10"]
				.flatMap((word) => speakWord(word, "code", language))
				.join(" ");
		expect(read("en")).toBe("if x less than ten");
		expect(read("hu")).toBe("if x kisebb mint tíz");
	});

	it("tells a comparison from a generic and a tag", () => {
		expect(speakWord("i<10", "code", "en")).toEqual([
			"i",
			"less",
			"than",
			"ten",
		]);
		expect(speakWord("<div", "code", "en")).toEqual(["div", "tag"]);
		expect(speakWord('class="x">', "code", "en")).toEqual([
			"class",
			"equals",
			"x",
		]);
	});

	it("reads % as mod, and as percent after a number", () => {
		expect(speakWord("a%b", "code", "en")).toEqual(["a", "mod", "b"]);
		expect(speakWord("50%;", "code", "en")).toEqual(["fifty", "percent"]);
		expect(speakWord("50%;", "code", "hu")).toEqual(["ötven", "százalék"]);
	});

	it("says a pipe and home only where the shell is", () => {
		expect(codeKindOf("", "ls")).toBe("shell");
		expect(codeKindOf("python", "ls")).toBe("code");
		expect(codeKindOf("bash", "x")).toBe("shell");
		expect(speakWord("|", "code", "en")).toEqual([]);
		expect(speakWord("~", "code", "en")).toEqual([]);
		expect(speakWord("~/projects", "code", "en")).toEqual([
			"home",
			"slash",
			"projects",
		]);
	});

	it("never ends a sentence after a number or a listed abbreviation", () => {
		expect(keepsSentenceOpen("A vásár 2026. november 16.", "hu")).toBe(true);
		expect(keepsSentenceOpen("Ehhez pl.", "hu")).toBe(true);
		expect(keepsSentenceOpen("Fruit, e.g.", "en")).toBe(true);
		expect(keepsSentenceOpen("It costs five dollars.", "en")).toBe(false);
		expect(keepsSentenceOpen("Ehhez pl.", "en")).toBe(false);
	});

	it("knows the separators between items", () => {
		for (const mark of ["→", "->", "·", "•"])
			expect(isSeparator(mark)).toBe(true);
		expect(isSeparator("-")).toBe(false);
	});

	it("keeps every token short and free of whitespace", () => {
		for (const [shown, kind] of SPEC)
			for (const language of ["en", "hu"] as const)
				for (const token of speakWord(shown, kind, language))
					expect(token).toMatch(/^\S{1,80}$/);
		expect(speakWord("a".repeat(100), "prose", "en")).toEqual([]);
	});
});

// Rulings of the build (Plan 2, Task 0): cases the plan's tables leave open.
describe("spoken forms: rulings of the build", () => {
	it("does not say the full stop that follows inline code", () => {
		// A sentence's last word is "getUserName()." and its first character is
		// inside the code element, so it is read as code. The period is the
		// sentence's, not the dot operator.
		expect(speakWord("getUserName().", "code", "en")).toEqual([
			"get",
			"User",
			"Name",
		]);
		expect(speakWord("a.b.", "code", "en")).toEqual(["a", "dot", "b"]);
	});

	it("drops a prose word with no letter, digit or listed symbol", () => {
		for (const mark of ["—", "...", "(", "…", "|", "*", "-"])
			expect(speakWord(mark, "prose", "en")).toEqual([]);
	});

	it("reads the address inside a call in code, and the code around it", () => {
		expect(speakWord('fetch("https://example.com/api")', "code", "en")).toEqual(
			["fetch", "example", "dot", "com"],
		);
	});

	it("keeps an IPv4 host as written", () => {
		expect(speakWord("http://192.168.0.1:8080/x", "prose", "en")).toEqual([
			"192.168.0.1",
		]);
	});

	it("reads degrees Celsius and Fahrenheit on their own", () => {
		expect(speakWord("°C", "prose", "en")).toEqual(["degrees", "Celsius"]);
		expect(speakWord("°F", "prose", "hu")).toEqual(["Fahrenheit-fok"]);
	});

	it("gives nothing for a word that would pass 40 tokens or 160 characters", () => {
		// 41 names and 40 dots read as 81 tokens.
		expect(
			speakWord(Array.from({ length: 41 }, () => "a").join("."), "code", "en"),
		).toEqual([]);
		// 15 pieces of 11 letters read as 15 tokens and 179 characters.
		expect(speakWord("abcdefghijk_".repeat(15), "code", "en")).toEqual([]);
	});

	it("keeps the digits of a version-like word that has only one number", () => {
		expect(speakWord("v2", "prose", "en")).toEqual(["v2"]);
		expect(speakWord("V8", "prose", "en")).toEqual(["V8"]);
		expect(speakWord("1.2.3.4", "code", "en")).toEqual(["1.2.3.4"]);
		expect(speakWord("v1.2", "code", "en")).toEqual(["version", "1.2"]);
	});

	it("reads a shortcut key that follows modifier glyphs", () => {
		expect(speakWord("⌘⇧P", "prose", "en")).toEqual(["Command", "Shift", "P"]);
		expect(speakWord("Ctrl+Shift+P", "prose", "hu")).toEqual([
			"kontrol",
			"sift",
			"P",
		]);
	});
});

// The early review's R1: one crafted word froze the server (the request's
// words are read by `wordsFitReply` on Node's one thread, and the browser reads
// every word of a rendered reply with the same function).
describe("spoken forms: a word cannot take the thread", () => {
	it("reads nested brackets in linear time", () => {
		const nested = "_<(".repeat(22) + ")>".repeat(22);
		const started = performance.now();
		speakWord(nested, "code", "en");
		expect(performance.now() - started).toBeLessThan(50);
		// Brackets that read as nothing are consumed, not read again from inside.
		expect(speakWord("a<()>b", "code", "en")).toEqual(["a", "b"]);
		expect(speakWord("a<>b", "code", "en")).toEqual(["a", "b"]);
	});

	it("says nothing for a code word of more than 512 characters, and does it at once", () => {
		const long = "_<(".repeat(171); // 513 characters
		expect(long.length).toBeGreaterThan(512);
		const started = performance.now();
		expect(speakWord(long, "code", "en")).toEqual([]);
		expect(speakWord(long, "shell", "hu")).toEqual([]);
		expect(performance.now() - started).toBeLessThan(20);
		// A prose word of that length is not a code word: its token is too long to say.
		expect(speakWord("a".repeat(600), "prose", "en")).toEqual([]);
	});
});

describe("spoken forms: the host an address is spoken as", () => {
	it("names the site, without its scheme, its credentials, its port or www", () => {
		expect(addressHost("https://www.bbc.com/news/x")).toBe("bbc.com");
		expect(addressHost("http://user:pw@example.com:8080/x?y=1")).toBe(
			"example.com",
		);
		expect(addressHost("(www.example.com),")).toBe("example.com");
		expect(addressHost('fetch("https://x.org/a")')).toBe("x.org");
		expect(addressHost("http://192.168.0.1:8080/x")).toBe("192.168.0.1");
	});

	it("is null for a word that is no address", () => {
		for (const word of [
			"hello",
			"anna@example.com",
			"report.pdf",
			"Ctrl+C",
			"x.org",
		])
			expect(addressHost(word), word).toBeNull();
	});
});

// The early review's R6: code the dictionary read wrongly.
describe("spoken forms: code the early review found misread", () => {
	it("reads !== as one operator", () => {
		expect(speakWord("!==", "code", "en")).toEqual(["not", "double", "equals"]);
		expect(speakWord("!==", "code", "hu")).toEqual(["nem", "dupla", "egyenlő"]);
	});

	it("reads a hexadecimal literal as written", () => {
		expect(speakWord("0x1F", "code", "en")).toEqual(["0x1F"]);
		expect(speakWord("0xFF_AA;", "code", "hu")).toEqual(["0xFFAA"]);
		// A plain number after a name is still a number.
		expect(speakWord("x=0", "code", "en")).toEqual(["x", "equals", "zero"]);
	});

	it("reads a tag that follows another tag, or a closing tag, wherever it stands", () => {
		expect(speakWord("<b>x</b>", "code", "en")).toEqual([
			"b",
			"tag",
			"x",
			"closing",
			"b",
			"tag",
		]);
		expect(speakWord("<p>Hi</p>", "code", "en")).toEqual([
			"p",
			"tag",
			"Hi",
			"closing",
			"p",
			"tag",
		]);
		expect(speakWord("<div><span>", "code", "hu")).toEqual([
			"div",
			"tag",
			"span",
			"tag",
		]);
		// A generic after a name is still a generic.
		expect(speakWord("List<T>", "code", "en")).toEqual(["List", "of", "T"]);
	});
});

describe("spoken forms: simple math (the owner's staging find, 2026-11-17)", () => {
	const math = (shown: string, language: "en" | "hu") =>
		speakWord(shown, "math", language);

	it("reads the owner's sum: its numbers whole, € as their currency, in each language's way", () => {
		const sum = "(€4{,}341.0505 \\times 0.88 = €3{,}820.12444)";
		// "{,}" is a thousands separator; each number goes to the speech service's
		// normalizer whole, written the way its language's normalizer reads it.
		expect(math(sum, "en")).toEqual([
			"€4341.0505",
			"times",
			"0.88",
			"equals",
			"€3820.12444",
		]);
		expect(math(sum, "hu")).toEqual([
			"4341,0505",
			"€",
			"szorozva",
			"0,88",
			"egyenlő",
			"3820,12444",
			"€",
		]);
	});

	it("reads the common operators, fractions, powers and roots", () => {
		const cases: Array<[tex: string, en: string, hu: string]> = [
			["a \\cdot b", "a times b", "a szorozva b"],
			["a \\div b", "a divided by b", "a osztva b"],
			["a + b - c", "a plus b minus c", "a plusz b mínusz c"],
			["\\frac{a}{b}", "a over b", "a per b"],
			["x^2", "x squared", "x négyzet"],
			["x^{3}", "x cubed", "x köb"],
			["x^{n}", "x to the power of n", "x az n-edik hatványon"],
			["2^{10}", "2 to the power of 10", "2 a 10. hatványon"],
			["5^{5}", "5 to the power of 5", "5 az 5. hatványon"],
			["\\sqrt{x}", "the square root of x", "négyzetgyök x"],
			["50\\%", "50%", "50%"],
			["\\pi \\approx 3.14", "", ""],
			["x \\approx 3.14", "x approximately 3.14", "x körülbelül 3,14"],
			["E = mc^2", "E equals m c squared", "E egyenlő m c négyzet"],
		];
		for (const [tex, en, hu] of cases) {
			expect(math(tex, "en").join(" "), tex).toBe(en);
			expect(math(tex, "hu").join(" "), tex).toBe(hu);
		}
	});

	it("reads nothing it does not know: the formula stays skipped", () => {
		for (const tex of [
			"\\int_0^1 f(x)\\,dx",
			"\\sum_{i=1}^{n} i",
			"\\sqrt[3]{x}",
			"x_1 + x_2",
			"\\frac{a}{b",
		])
			expect(math(tex, "en"), tex).toEqual([]);
	});

	it("takes off the delimiters the page may show: $…$, \\(…\\) and plain brackets", () => {
		for (const shown of ["$x^2$", "\\(x^2\\)", "(x^2)", "$$x^2$$", "\\[x^2\\]"])
			expect(math(shown, "en"), shown).toEqual(["x", "squared"]);
	});
});
