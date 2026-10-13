import { describe, expect, it } from "vitest";
import { afterReplyLanguage, readReplyLanguage } from "./language";

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
		// "a", "is", "be", "de", "ha", "van", "volt", "mi", "ki", "el", "le", "meg"
		// and "az" prove nothing about either language, however often they come.
		const homographs = "a is be de ha van volt mi ki el le meg az ".repeat(20);
		expect(readReplyLanguage(homographs)).toBe("unknown");
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
});

describe("afterReplyLanguage", () => {
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
		).toEqual({ language: "en", read: "en" });
		expect(
			afterReplyLanguage({
				reply: HUNGARIAN_REPLIES[0],
				latestUserMessage: "Melyik jobb, a hőszivattyú vagy a gázkazán?",
				uiLanguage: "en",
			}),
		).toEqual({ language: "hu", read: "hu" });
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
		).toEqual({ language: "hu", read: "hu" });

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
		).toEqual({ language: "en", read: "en" });
	});

	it("an explicit request for the reply in a language is the language of the reply", () => {
		// "Válaszolj angolul: mi a fotoszintézis?" gets an all-English reply with no
		// Hungarian words in it: it stays English (the chips follow the reply).
		expect(
			afterReplyLanguage({
				reply:
					"Photosynthesis is the process by which plants, algae and some bacteria turn light into chemical energy. They take in carbon dioxide and water, and they release oxygen as a by-product.",
				latestUserMessage:
					"Válaszolj angolul, kérlek: mi a fotoszintézis, és hogyan működik?",
				uiLanguage: "hu",
			}),
		).toEqual({ language: "en", read: "en" });
	});

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
		).toEqual({ language: "en", read: "en" });
		// A short "ok" says nothing either: the language of the last reply.
		expect(
			afterReplyLanguage({
				reply: "Rendben.",
				latestUserMessage: "ok",
				previous: "hu",
				uiLanguage: "en",
			}),
		).toEqual({ language: "hu", read: "unknown" });
		// Nothing before it: the account's UI language.
		expect(
			afterReplyLanguage({
				reply: "Done.",
				latestUserMessage: "ok",
				uiLanguage: "hu",
			}),
		).toEqual({ language: "hu", read: "unknown" });
		// Not even that: English.
		expect(afterReplyLanguage({ reply: "", latestUserMessage: "" })).toEqual({
			language: "en",
			read: "unknown",
		});
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
		).toEqual({ language: "en", read: "en" });
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
		).toEqual({ language: "hu", read: "hu" });
	});

	it("the previous reply's language is a fallback only: it never overrules a reply that names a language", () => {
		// A short message the reader cannot name does not stand in for the chat's
		// language: the reply decides, and only a reply that says nothing falls back.
		expect(
			afterReplyLanguage({
				reply: ENGLISH_EMAIL_REPLY,
				latestUserMessage: "Fordítsd le angolra.",
				previous: "hu",
				uiLanguage: "hu",
			}),
		).toEqual({ language: "en", read: "en" });
		expect(
			afterReplyLanguage({
				reply: "Done.",
				latestUserMessage: "ok",
				previous: "hu",
				uiLanguage: "en",
			}),
		).toEqual({ language: "hu", read: "unknown" });
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
		).toEqual({ language: "en", read: "en" });
	});
});
