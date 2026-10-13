import { describe, expect, it } from "vitest";
import {
	afterReplyLanguage,
	readReplyLanguage,
	readShortTextLanguage,
} from "./language";

// The reader is for what the model wrote. It answers a language only when there
// is plenty of evidence, and "unknown" otherwise; none of these texts is a guess.

const ENGLISH_REPLIES = [
	"Heat pumps move heat instead of making it, so they usually need about a third of the energy a gas boiler needs for the same warmth. The catch is the upfront cost and the need for decent insulation.",
	"Rent a van in Budapest if you plan to visit more than two places outside the city: you will need it for Győr and Pécs, but you do not need it inside the centre, where the metro and the trams are faster. If you have a driving licence from outside the EU, check whether the agency wants an international permit.",
	'The word volt means two different things here. In the sentence you pasted it is the Hungarian past tense of "to be", and in your formula it is the unit of electric potential. If you ha-ha your way through the glossary, the van and the volt will still not be the same word, but de facto they sit next to each other in the list.',
	"A café in the Magyar quarter of the town will usually serve a long coffee with a glass of water. Ask for the menu before you sit down, because the prices are not always on the table, and there is often a cover charge that is not mentioned anywhere.",
	"Here is what I would do. First, write down the three things that must be finished by Friday. Then ask yourself which of them can be done in less than an hour, and do those first, because they will give you the momentum you need for the rest.",
];

const HUNGARIAN_REPLIES = [
	"A hőszivattyú a hőt nem előállítja, hanem átmozgatja, ezért általában a gázkazán energiájának körülbelül a harmadára van szüksége ugyanahhoz a meleghez. A hátránya a magas beruházási költség, és az, hogy jó szigetelés kell hozzá.",
	"Íme néhány ötlet a hétvégére: ha szeretnél kimozdulni, érdemes a Balatonra menni, mert ilyenkor még nincs tele a part. Ha viszont inkább pihennél, akkor a városban is sok minden van, amit nem láttál még.",
	"Természetesen segítek. Először gyűjtsd össze, hogy mi az, ami nem fér bele a határidőbe, aztán döntsd el, hogy melyiket lehet kihagyni. Végül írd le a kapott listát, és mondd el nekem, hogy mi változott.",
];

/** The same Hungarian, typed the way people type on a phone: no accents at all. */
const UNACCENTED_HUNGARIAN =
	"Szia! Nem tudom, hogy mit csinaljak ma, de szerintem menjunk el valahova es igyunk egy kavet. Kerlek, mondd meg, hogy mikor lenne jo neked, mert ez a het nagyon sok munka lesz, es nincs sok szabad idom.";

describe("readReplyLanguage", () => {
	it("reads a long English reply as English, whatever Hungarian-looking words it holds", () => {
		for (const reply of ENGLISH_REPLIES) {
			expect(readReplyLanguage(reply), reply.slice(0, 40)).toBe("en");
		}
	});

	it("reads a Hungarian reply as Hungarian", () => {
		for (const reply of HUNGARIAN_REPLIES) {
			expect(readReplyLanguage(reply), reply.slice(0, 40)).toBe("hu");
		}
	});

	it("reads Hungarian written without accents as Hungarian", () => {
		expect(readReplyLanguage(UNACCENTED_HUNGARIAN)).toBe("hu");
	});

	it("does not count the words both languages use", () => {
		// Each of these is an everyday word of the other language, or an English
		// name, unit or abbreviation (MIT, IDE, TI-84, "12 volt", "a van", "AZ",
		// "Meg", SEM, OTT, STB, RAM, "Mar 2024", OTA, IME), so none proves
		// anything about either language, however often it comes. One word at a time: a single one on either list would tip a text
		// made of it alone. The lists' comments name these words; this holds them to it.
		const homographs =
			"a az is be de ha van volt mi ki el le meg most mint fog mit ide hat ti ma ok at no hi en sem ott stb mire kik ram mar rad ota ime neha kerem rola".split(
				" ",
			);
		for (const word of homographs) {
			expect(readReplyLanguage(`${word} `.repeat(20)), word).toBe("unknown");
		}
		expect(readReplyLanguage(`${homographs.join(" ")} `.repeat(20))).toBe(
			"unknown",
		);
	});

	it("does not count names, places or loanwords", () => {
		expect(
			readReplyLanguage(
				"Győr, Magyar, café, Székesfehérvár, résumé, Budapest, Pécs, naïve, Szeged, Zürich, München, Győr.",
			),
		).toBe("unknown");
	});

	it("answers 'unknown' for code only, a bare link or a few words", () => {
		expect(
			readReplyLanguage(
				"```ts\nconst answer = await fetch(url);\nif (answer.ok) { return the.data; }\n```",
			),
		).toBe("unknown");
		expect(
			readReplyLanguage("https://example.com/the/best/of/all/and/more"),
		).toBe("unknown");
		expect(readReplyLanguage("ok")).toBe("unknown");
		expect(readReplyLanguage("Köszönöm!")).toBe("unknown");
		expect(readReplyLanguage("")).toBe("unknown");
	});

	it("needs at least four witnesses", () => {
		expect(readReplyLanguage("That was the end.")).toBe("unknown"); // that, was, the
		expect(readReplyLanguage("That was the end of it.")).toBe("en"); // + of, it
	});

	it("needs a lead of three to one, so a mixed text is 'unknown'", () => {
		const mixed =
			"Here is the text you asked for, and I think you will like it. Kedves Anna, remélem, hogy jól vagy, és nem felejtetted el, hogy holnap találkozunk, mert fontos.";
		expect(readReplyLanguage(mixed)).toBe("unknown");
	});

	it("does not count fenced code, inline code, addresses or quoted lines", () => {
		const hungarianWithEnglishAround = [
			"Íme a parancs, amit futtatnod kell, és amit nem szabad módosítanod:",
			"```sh",
			"echo the quick brown fox jumps over the lazy dog and then it was over",
			"```",
			"A `the and of to in that it` rész nem számít, mert ez csak kód.",
			"> The quote is in English, and it has been quoted, as you can see.",
			"Lásd még: https://example.com/the/best/of/all/and/more és www.example.com/the/and/of.",
		].join("\n");
		expect(readReplyLanguage(hungarianWithEnglishAround)).toBe("hu");

		const englishWithHungarianAround = [
			"Here is the command you need to run, and the one you should not change:",
			"```sh",
			"echo és hogy nem egy ez azt vagy mert kell lehet itt ott minden mindig",
			"```",
			"The `és hogy nem egy ez azt vagy mert` part is code, so it is not counted.",
			"> Ez egy idézet, amely magyarul van, és nem számít bele, mert idézet.",
			"See also https://example.com/és/hogy/nem/egy and www.example.com/ez/azt.",
		].join("\n");
		expect(readReplyLanguage(englishWithHungarianAround)).toBe("en");
	});

	it("strips an unterminated fence to the end", () => {
		const text = `Here is the file you asked me to write, and you can run it as it is.\n\`\`\`py\nprint("és hogy nem egy ez azt vagy mert kell lehet")`;
		expect(readReplyLanguage(text)).toBe("en");
	});

	it("counts contractions as English", () => {
		expect(
			readReplyLanguage("Don't worry, it's fine; we'll fix it. I'm sure."),
		).toBe("en");
	});

	it("counts 'I' and 'an' as English: neither is a Hungarian word", () => {
		// "I need an hour. I think an answer is near." holds no other closed-class
		// word of English than these (and "is", which both languages use).
		expect(
			readReplyLanguage("I need an hour. I think an answer is near."),
		).toBe("en");
	});

	it("does not count an email address", () => {
		const text =
			"Íme a cím, amelyet használnod kell, és amelyet nem szabad megváltoztatnod: the.and.of.to.in@that.with.from.com ennyi volt, kérlek írj, ha kell.";
		expect(readReplyLanguage(text)).toBe("hu");
		// The same text with the address left in its words reads as a mix.
		expect(readReplyLanguage(text.replace(/@/g, " "))).toBe("unknown");
	});

	// The reader runs on every reply the model writes, on the server's one thread,
	// and a reply can be a blob (a base64 string, a minified file, a pasted log).
	// A pattern that backtracks over a long run of non-space characters turns that
	// into seconds of a blocked server: before this was fixed, `\S+@\S+\.\S+` took
	// 1.4 s on 40 000 letters in a row and 0.3 s on 1 600 characters of "x@", and
	// `\]\([^)\s]*\)` took 1.9 s on 20 000 "](". The inputs are ordered by what
	// they cost then, so a regression fails at the first slow one instead of
	// hanging the suite.
	it("reads hostile or huge input in a fraction of a second (a blob must not block the server)", () => {
		const blob = Buffer.from(
			Uint8Array.from(
				{ length: 225_000 },
				(_, i) => (i * 7919 + (i >> 3)) % 251,
			),
		).toString("base64");
		const inputs: Array<[string, string]> = [
			["alternating x@", "x@".repeat(1_500)],
			["one long word", "a".repeat(40_000)],
			["link openers", "](".repeat(20_000)],
			["one long word, 400 KB", "a".repeat(400_000)],
			["email-like run, 400 KB", "x@".repeat(200_000)],
			["link openers, 400 KB", "](".repeat(200_000)],
			["double backticks", "``".repeat(100_000)],
			["fence lines", "```\n".repeat(60_000)],
			["alternating fences", "```\n~~~\n".repeat(30_000)],
			["blank lines with spaces", "   \t \n".repeat(60_000)],
			["base64 blob", blob],
			[
				"a long prose",
				"The cat sat on the mat and it was a very long day for all of us. ".repeat(
					6_000,
				),
			],
		];
		for (const [label, text] of inputs) {
			const start = performance.now();
			readReplyLanguage(text);
			expect(performance.now() - start, label).toBeLessThan(500);
		}

		const start = performance.now();
		afterReplyLanguage({
			reply: "a".repeat(400_000),
			latestUserMessage: "](".repeat(20_000),
		});
		expect(performance.now() - start, "afterReplyLanguage").toBeLessThan(500);
	});

	it("looks at the first 100 000 characters of a text and no more", () => {
		const sentence =
			"This is the end of it, and we will see what comes of that. ";
		const firstPart = sentence.repeat(1_700); // a little over 100 000 characters
		expect(firstPart.length).toBeGreaterThanOrEqual(100_000);
		const hungarian =
			"Ez a vége, és nem lesz több, mert ez már így van. ".repeat(3_000);
		// Read whole, the two halves would be about even (ten English witnesses a
		// sentence against eight or nine Hungarian ones) and the text "unknown":
		// the English first part decides, and the Hungarian tail is not read.
		expect(readReplyLanguage(firstPart + hungarian)).toBe("en");
		expect(readReplyLanguage(hungarian)).toBe("hu");
	});
});

// A title or a headline is a handful of content words: the reader of a reply
// (four closed-class words, a three-to-one lead) names almost none of them (it
// named 1 of 16 Hungarian titles and 4 of 16 English ones in review RV-L's
// probe), so the check that drops a line in the other language than asked for
// could hardly ever fire. The short-text reader counts what only Hungarian has
// as well: a word spelt with Hungarian letters that no English text borrows.
describe("readShortTextLanguage", () => {
	const HUNGARIAN_TITLES = [
		"Hőszivattyú vagy gázkazán",
		"Albérletkeresés Budapesten",
		"Heti kiadáskövető alkalmazás",
		"A fotoszintézis működése",
		"Önéletrajz szoftverfejlesztőknek",
		"Nyaralás tervezése Balatonon",
		"Python függvény hibakeresése",
		"Kerékpáros munkába járás előnyei",
		"Születésnapi üzenet kollégának",
		"Felújítási költségek becslése",
		"Ünnepnapok Magyarországon jövőre",
		"Hogyan válasszunk laptopot",
		"Mi a különbség a TCP és az UDP között",
		"Vonatjegy foglalása Bécsbe",
		"Konyhai csempe kiválasztása",
		"Késés jelzése a főnöknek",
	];
	const ENGLISH_TITLES = [
		"Heat pump vs gas boiler",
		"Apartment hunting in Budapest",
		"Weekly expense tracker app",
		"How photosynthesis works",
		"Resume for software developers",
		"Planning a Lake Balaton holiday",
		"Debugging a Python function",
		"Benefits of cycling to work",
		"Birthday message for a colleague",
		"Estimating renovation costs",
		"Public holidays in Hungary next year",
		"How to choose a laptop",
		"The difference between TCP and UDP",
		"Booking a train ticket to Vienna",
		"Choosing kitchen tiles",
		"Telling the boss you will be late",
	];

	it("names a Hungarian title Hungarian, and never English", () => {
		const reads = HUNGARIAN_TITLES.map((title) => readShortTextLanguage(title));
		expect(reads.filter((read) => read === "en")).toEqual([]);
		// 13 of 16: what is missed is a single long word beside a name or a short
		// word ("Albérletkeresés Budapesten", "Konyhai csempe kiválasztása"),
		// which one Hungarian-spelt word cannot make a clear mismatch of.
		expect(reads.filter((read) => read === "hu").length).toBeGreaterThanOrEqual(
			13,
		);
		for (const title of [
			"Hőszivattyú vagy gázkazán",
			"Heti kiadáskövető alkalmazás",
			"Felújítási költségek becslése",
			"Mi a különbség a TCP és az UDP között",
		]) {
			expect(readShortTextLanguage(title), title).toBe("hu");
		}
	});

	it("names an English title English when it holds an English word, and never Hungarian", () => {
		const reads = ENGLISH_TITLES.map((title) => readShortTextLanguage(title));
		expect(reads.filter((read) => read === "hu")).toEqual([]);
		// 10 of 16 carry a closed-class word; the rest are content words alone,
		// which say nothing and pass.
		expect(reads.filter((read) => read === "en").length).toBeGreaterThanOrEqual(
			10,
		);
		for (const title of [
			"How to choose a laptop",
			"The difference between TCP and UDP",
			"Telling the boss you will be late",
			"Apartment hunting in Budapest",
		]) {
			expect(readShortTextLanguage(title), title).toBe("en");
		}
		for (const title of ["Heat pump vs gas boiler", "Choosing kitchen tiles"]) {
			expect(readShortTextLanguage(title), title).toBe("unknown");
		}
	});

	it("does not call an English line Hungarian for the words and names that look Hungarian", () => {
		for (const title of [
			// Homographs: "van" and "volt" are Hungarian words, and a surname and a unit.
			"Van Gogh Biography",
			"Chevy Volt Review",
			"Rent a van in Budapest",
			"What is 12 volt in watts",
			// One accented word: a city, a loanword, a composer.
			"Zürich weekend",
			"Café culture in Vienna",
			"Béla Bartók biography",
			"Győr weekend trip",
			"Hévíz spa guide",
			"Székesfehérvár history",
			"Kürtőskalács recipe",
			// Words English text borrows, however many accents they carry.
			"Résumé tips for developers",
			"Protégé and the pokémon",
			"Schrödinger's cat explained",
			"München and Düsseldorf in a day",
		]) {
			expect(readShortTextLanguage(title), title).not.toBe("hu");
		}
	});

	it("does not count the Hungarian look of an English acronym or word that folds into it", () => {
		// "ram", "mar", "rad", "ota", "ime", "ott", "stb", "sem" are Hungarian
		// words without their accents (rám, már, rád, óta, íme) or Hungarian words
		// that English text uses as an acronym (OTT, STB, SEM): none is evidence.
		for (const title of [
			"8GB RAM vs 16GB RAM",
			"RAM and OTA updates",
			"OTT vs STB streaming",
			"SEM images of the sample",
			"Mar 2024 vs Mar 2025 sales",
			"IME setup on Linux",
			"Ride the rad ramp",
		]) {
			expect(readShortTextLanguage(title), title).not.toBe("hu");
		}
	});

	it("leaves a mixed line alone", () => {
		expect(readShortTextLanguage("Python for ciklus magyarázata")).toBe(
			"unknown",
		);
		expect(readShortTextLanguage("Hévíz spa guide for two days")).toBe(
			"unknown",
		);
	});

	it("answers 'unknown' for nothing to read", () => {
		for (const text of [
			"",
			"   ",
			"42",
			"https://example.com/the/best/of/all",
		]) {
			expect(readShortTextLanguage(text), text).toBe("unknown");
		}
	});
});

// The deterministic fallback for a turn whose call to the model, which names the
// language of the conversation for the person, did not answer
// (chat-turn/conversation-language.ts). It reads the reply and, when it can, the
// message, and cannot tell a requested piece, a pasted text and an explicit
// request for another language from the person's own: those turns are what the
// call is for (reply-language.test.ts holds them, with the call faked).
describe("afterReplyLanguage (the fallback)", () => {
	const ENGLISH_EMAIL_REPLY = [
		"Íme az e-mail, amit kértél, és amit szükség szerint még átírhatunk:",
		"",
		"Dear Anna, I am writing to let you know that I will not be able to come in tomorrow, because I am not feeling well. I will keep you posted, and I hope that this does not cause too much trouble for the team. If there is anything that cannot wait until I am back, please send it to Peter, who knows where everything is and who has agreed to cover for me. Thank you for your understanding, and I am sorry for the short notice.",
		"",
		"Ha szeretnéd, hogy rövidebb vagy hivatalosabb legyen, szólj nekem.",
	].join("\n");
	const HUNGARIAN_USER_MESSAGE =
		"Írj egy e-mailt angolul a kollégámnak, hogy holnap nem tudok bemenni, mert beteg vagyok.";

	it("a plain reply is the language it reads as", () => {
		expect(
			afterReplyLanguage({
				reply: ENGLISH_REPLIES[0],
				latestUserMessage: "Which is better, a heat pump or a gas boiler?",
				uiLanguage: "hu",
			}),
		).toBe("en");
		expect(
			afterReplyLanguage({
				reply: HUNGARIAN_REPLIES[0],
				latestUserMessage: "Melyik jobb, a hőszivattyú vagy a gázkazán?",
				uiLanguage: "en",
			}),
		).toBe("hu");
	});

	it("a requested piece in the other language does not change the language of the assistant's own words (both directions)", () => {
		// A Hungarian person asks for an English email: the reply reads as English
		// as a whole, but the words around the email are Hungarian, so are the chips.
		expect(readReplyLanguage(ENGLISH_EMAIL_REPLY)).toBe("en");
		expect(
			afterReplyLanguage({
				reply: ENGLISH_EMAIL_REPLY,
				latestUserMessage: HUNGARIAN_USER_MESSAGE,
				uiLanguage: "en",
			}),
		).toBe("hu");

		// An English person asks for a Hungarian email: English around it.
		const hungarianEmailReply = [
			"Here is the email you asked for:",
			"",
			"Kedves Anna, remélem, hogy jól vagy, és nem felejtetted el, hogy holnap találkozunk. Azt szeretném kérni, hogy hozd magaddal a dokumentumokat, mert nagyon fontosak lesznek, és minden egyes oldalra szükségünk lesz. Ha közben bármi változik, vagy ha valamit nem találsz, akkor írj nekem, mert addig még van időnk, és együtt biztosan meg tudjuk oldani. Köszönöm szépen, és várom a válaszodat, amint tudod. Ezt a levelet azért írom, mert fontos, hogy minden rendben legyen.",
			"",
			"Tell me if it should be shorter.",
		].join("\n");
		expect(readReplyLanguage(hungarianEmailReply)).toBe("hu");
		expect(
			afterReplyLanguage({
				reply: hungarianEmailReply,
				latestUserMessage:
					"Write an email in Hungarian to my colleague, saying that I will not come in tomorrow because I am ill.",
				uiLanguage: "hu",
			}),
		).toBe("en");
	});

	// There is no case here for "Válaszolj angolul: …" answered in English. The
	// chips, the headline and the title are in the language the person WRITES in
	// (a chip is their next message), so an explicit request for the replies in
	// another language does not flip them; the model's call says so
	// (conversation-language.ts), and this chain, which reads the reply, would
	// flip them. It cannot tell the request from the person's own writing, which
	// is why it is only the fallback.

	it("a reply that says nothing falls to the message, then the last reply, then the UI language", () => {
		const code = "```ts\nconsole.log(1);\n```";
		// The person's message reads clearly: that is the language.
		expect(
			afterReplyLanguage({
				reply: code,
				latestUserMessage:
					"Could you show me how to print a number to the console in the browser?",
				previous: "hu",
				uiLanguage: "hu",
			}),
		).toBe("en");
		// A short "ok" says nothing either: the language of the last reply.
		expect(
			afterReplyLanguage({
				reply: "Rendben.",
				latestUserMessage: "ok",
				previous: "hu",
				uiLanguage: "en",
			}),
		).toBe("hu");
		// Nothing before it: the account's UI language.
		expect(
			afterReplyLanguage({
				reply: "Done.",
				latestUserMessage: "ok",
				uiLanguage: "hu",
			}),
		).toBe("hu");
		// Not even that: English.
		expect(afterReplyLanguage({ reply: "", latestUserMessage: "" })).toBe("en");
	});

	it("a bare piece in the other language, with no commentary around it, is read through the message when the reader cannot name it", () => {
		// "Write an email in Hungarian to my colleague": the reply is the email and
		// nothing else. A short one has too few closed-class words to be named, so
		// the person's message says the language (English), not the previous reply
		// or the UI language.
		const bareHungarianEmail =
			"Kedves Anna!\n\nMa nem jövök be, beteg vagyok.\n\nÜdv,\nPéter";
		expect(readReplyLanguage(bareHungarianEmail)).toBe("unknown");
		expect(
			afterReplyLanguage({
				reply: bareHungarianEmail,
				latestUserMessage:
					"Write an email in Hungarian to my colleague, saying that I will not be in tomorrow because I am ill.",
				previous: "hu",
				uiLanguage: "hu",
			}),
		).toBe("en");
	});

	it("a long bare piece that the reader names is named: the reply wins when it holds none of the message's words", () => {
		// The reader cannot tell a bare piece from a reply written in that language
		// ("answer in Hungarian"), so a reply it names with nothing of the
		// message's language in it stands.
		const longBareHungarianEmail = HUNGARIAN_REPLIES[2];
		expect(readReplyLanguage(longBareHungarianEmail)).toBe("hu");
		expect(
			afterReplyLanguage({
				reply: longBareHungarianEmail,
				latestUserMessage:
					"Please answer in Hungarian: how do I plan the week so that nothing is forgotten?",
				uiLanguage: "en",
			}),
		).toBe("hu");
	});

	it("the stored language is a fallback only: it never overrules a reply that names a language, so a person who switches language is followed", () => {
		// The conversation was Hungarian; the person now writes English and gets an
		// English reply. What was stored must not hold them to Hungarian.
		expect(
			afterReplyLanguage({
				reply: ENGLISH_REPLIES[0],
				latestUserMessage: "Thanks. Can you say that again in plain words?",
				previous: "hu",
				uiLanguage: "hu",
			}),
		).toBe("en");
		// And a reply that says nothing falls back to it.
		expect(
			afterReplyLanguage({
				reply: "Done.",
				latestUserMessage: "ok",
				previous: "hu",
				uiLanguage: "en",
			}),
		).toBe("hu");
	});

	it("the message overrules the reply only when the reply holds two of its words", () => {
		// An English reply to a Hungarian message with a single Hungarian word in
		// it is an English reply (the model answered in English), not a Hungarian one.
		expect(
			afterReplyLanguage({
				reply:
					"The quarter is called Magyar, and you can reach it by tram; it is about ten minutes from the centre if the traffic is light and you do not stop on the way.",
				latestUserMessage: HUNGARIAN_USER_MESSAGE,
				uiLanguage: "hu",
			}),
		).toBe("en");
	});
});
