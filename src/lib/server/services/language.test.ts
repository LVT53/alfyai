import { describe, expect, it } from "vitest";
import {
	classifyLanguageSignal,
	detectExplicitLanguageRequest,
	detectLanguage,
	resolveResponseLanguage,
} from "./language";

describe("detectLanguage", () => {
	it("defaults empty input to English", () => {
		expect(detectLanguage("")).toBe("en");
	});

	it("uses the old short-input fallback for Hungarian short words", () => {
		expect(detectLanguage("Szia")).toBe("hu");
		expect(detectLanguage("igen")).toBe("hu");
		expect(detectLanguage("hello")).toBe("en");
	});

	it("detects accented Hungarian text as Hungarian", () => {
		expect(detectLanguage("Kérlek írj egy rövid emailt.")).toBe("hu");
	});

	it("detects mixed Hungarian prompts without accents", () => {
		expect(detectLanguage("Irj egy angol emailt")).toBe("hu");
		expect(detectLanguage("Valaszolj angolul egy rovid levelben")).toBe("hu");
	});

	it("keeps plain English prompts as English", () => {
		expect(detectLanguage("Write a short email in English")).toBe("en");
		expect(detectLanguage("Hello, tell me about artificial intelligence")).toBe(
			"en",
		);
	});

	it("detects mixed Hungarian-English prompts as Hungarian", () => {
		expect(
			detectLanguage("Szeretnék egy CSV fájlt generálni az adatokból"),
		).toBe("hu");
		expect(
			detectLanguage("Kérlek készíts egy reportot a Q4 eredményekről"),
		).toBe("hu");
		expect(
			detectLanguage("Írj egy Python scriptet ami letölti a fájlokat"),
		).toBe("hu");
	});

	it("detects short Hungarian inputs without diacritics as Hungarian when they contain Hungarian function words", () => {
		expect(detectLanguage("Irj egy emailt")).toBe("hu");
		expect(detectLanguage("Mondd el mi a helyzet")).toBe("hu");
		expect(detectLanguage("Valaszolj angolul")).toBe("hu");
	});

	it("detects real-world Hungarian sentences as Hungarian", () => {
		expect(
			detectLanguage(
				"Hogyan tudom beállítani a környezeti változókat Linux alatt?",
			),
		).toBe("hu");
		expect(
			detectLanguage("Mi a legjobb gyakorlat React komponensek tesztelésére?"),
		).toBe("hu");
		expect(
			detectLanguage(
				"Kérlek magyarázd el a különbséget a REST és GraphQL között",
			),
		).toBe("hu");
	});

	it("keeps plain English prompts as English even with Hungarian-like substrings", () => {
		expect(
			detectLanguage("Write a report about the Hungarian parliament"),
		).toBe("en");
		expect(
			detectLanguage("How do I configure the environment variables?"),
		).toBe("en");
	});

	// Root-cause corpus (2026-09-25 investigation): these are the exact shapes
	// of English message that used to come back Hungarian. Each used to fail
	// via one of three defects in the old scorer:
	//  - HUNGARIAN_BIGRAMS scored common English "-ly/-ny/-gy/-ty" endings as
	//    Hungarian evidence ("only", "many", "energy", "company", "really").
	//  - HUNGARIAN_SUFFIXES matched ordinary English words ("urban" ends in
	//    "-ban", the Hungarian inessive suffix).
	//  - The final tie-break flipped to Hungarian on ANY accented letter
	//    anywhere in the message, including inside a name or loanword
	//    ("café", "résumé", "Zürich", "Győr", "József", "Beyoncé") or a
	//    single-letter code/list token ("a") colliding with the Hungarian
	//    definite article.
	it("keeps ordinary English words with Hungarian-looking bigrams/suffixes as English", () => {
		expect(
			detectLanguage("I only have a few minutes, can you keep it short?"),
		).toBe("en");
		expect(
			detectLanguage(
				"This is really important for the company's energy strategy going forward.",
			),
		).toBe("en");
		expect(
			detectLanguage("Any update on the party planning for the city event?"),
		).toBe("en");
		expect(
			detectLanguage("We need better urban planning in this neighborhood."),
		).toBe("en");
		expect(
			detectLanguage(
				"Many companies are investing heavily in renewable energy technology.",
			),
		).toBe("en");
	});

	it("keeps English sentences containing Hungarian names or accented loanwords as English", () => {
		expect(
			detectLanguage(
				"I visited Győr and Budapest last summer, it was beautiful.",
			),
		).toBe("en");
		expect(
			detectLanguage("My colleague József is joining the call at 3pm."),
		).toBe("en");
		expect(
			detectLanguage(
				"We're flying through Zürich on the way to the conference.",
			),
		).toBe("en");
		expect(
			detectLanguage(
				"Let's meet at the café near the office before the meeting.",
			),
		).toBe("en");
		expect(detectLanguage("Please send the résumé to HR before Friday.")).toBe(
			"en",
		);
		expect(
			detectLanguage("Beyoncé's new album just dropped, have you heard it?"),
		).toBe("en");
	});

	it("keeps English code snippets as English despite single-letter parameter collisions", () => {
		expect(
			detectLanguage(
				"Here's my function:\nfunction add(a, b) { return a + b; }\nWhy is it returning NaN?",
			),
		).toBe("en");
	});
});

describe("classifyLanguageSignal", () => {
	it("reports unknown for very short, non-listed input instead of guessing English", () => {
		expect(classifyLanguageSignal("ok")).toBe("unknown");
		expect(classifyLanguageSignal("thanks")).toBe("unknown");
	});

	it("reports unknown for a bare name with no other context", () => {
		expect(classifyLanguageSignal("Zoltán")).toBe("unknown");
		expect(classifyLanguageSignal("Józsi")).toBe("unknown");
	});

	it("reports unknown for a bare pasted URL", () => {
		expect(classifyLanguageSignal("https://example.com/some-path")).toBe(
			"unknown",
		);
	});

	it("reports unknown for bare code or numbers with no letter evidence", () => {
		expect(classifyLanguageSignal("x = 1")).toBe("unknown");
		expect(classifyLanguageSignal("42")).toBe("unknown");
	});

	it("still commits to a confident answer once there is real evidence", () => {
		expect(classifyLanguageSignal("How do I configure this?")).toBe("en");
		expect(classifyLanguageSignal("Szia, hogy vagy ma?")).toBe("hu");
	});

	// The short-input branch (< the 10-char threshold) used to look up the
	// WHOLE trimmed string as a single key in HUNGARIAN_SHORT_WORDS, so it
	// only ever matched a single-word short reply ("igen", "szia"). A short
	// reply that combines two known short words ("nem jó", "igen persze") is
	// just as common and just as unambiguous, but fell straight through to
	// "unknown" because "nem jó" is not itself an entry in the set. Requires
	// EVERY letter-token to be a known short word (not just one) so a short
	// phrase that only partially overlaps the list — one Hungarian word plus
	// an English word, a name, or a number — correctly stays "unknown".
	it("reports Hungarian for a short reply made of two known short words", () => {
		expect(classifyLanguageSignal("nem jó")).toBe("hu");
		expect(classifyLanguageSignal("igen persze")).toBe("hu");
		expect(classifyLanguageSignal("Nem jó!")).toBe("hu");
	});

	it("keeps a short phrase unknown when only some words are known Hungarian short words", () => {
		expect(classifyLanguageSignal("ok van")).toBe("unknown");
		expect(classifyLanguageSignal("nem 5")).toBe("unknown");
	});

	it("does not read a quoted word as the language the message is written in", () => {
		// The quoted word is what the message is ABOUT.
		expect(classifyLanguageSignal("What does 'szia' mean in Hungarian?")).toBe(
			"en",
		);
		expect(
			classifyLanguageSignal('How do you say "köszönöm" in English?'),
		).toBe("en");
		expect(classifyLanguageSignal("Translate 'Szia, hogy vagy ma?'")).toBe(
			"en",
		);
		expect(classifyLanguageSignal("Mit jelent az, hogy 'serendipity'?")).toBe(
			"hu",
		);
		expect(
			classifyLanguageSignal("Hogy mondják angolul, hogy „good morning”?"),
		).toBe("hu");
	});

	it("still reads a message that is nothing but a quote, and a contraction is not a quote", () => {
		expect(classifyLanguageSignal('"Szia, hogy vagy ma?"')).toBe("hu");
		expect(
			classifyLanguageSignal("Don't forget that it's Friday and let's go"),
		).toBe("en");
	});
});

describe("detectExplicitLanguageRequest", () => {
	it("recognizes an explicit request regardless of the request's own language", () => {
		expect(detectExplicitLanguageRequest("válaszolj angolul")).toBe("en");
		expect(
			detectExplicitLanguageRequest("Can you write this in Hungarian please?"),
		).toBe("hu");
		expect(detectExplicitLanguageRequest("please respond in English")).toBe(
			"en",
		);
		expect(detectExplicitLanguageRequest("kérlek magyarul")).toBe("hu");
	});

	it("returns null when there is no explicit request", () => {
		expect(detectExplicitLanguageRequest("just answer normally")).toBeNull();
		expect(detectExplicitLanguageRequest("Szia, hogy vagy?")).toBeNull();
	});
});

// "angolul" / "in Hungarian" in a message is a request to answer in that language
// only when the person asks for the answer in it. A message that merely MENTIONS
// the language (how do you say, what does it mean, translate, learn, can you speak)
// keeps the conversation's language: on the real model, "Hogy mondják angolul, hogy
// alma?" came back as "The word alma translates to apple" (an English reply to a
// Hungarian question), and "How do you say 'apple' in Hungarian?" as "Az alma."
describe("detectExplicitLanguageRequest: only an asked-for reply language flips", () => {
	describe("Hungarian message, English wanted", () => {
		it.each([
			"válaszolj angolul",
			"Válaszolj angolul",
			"angolul válaszolj",
			"Kérlek válaszolj angolul",
			"Válaszolj nekem angolul, kérlek",
			"Valaszolj angolul", // typed without accents
			"válaszolj angol nyelven",
			"írd angolul",
			"Írd meg angolul",
			"Írj egy rövid levelet angolul a főnökömnek",
			"beszéljünk angolul",
			"Beszélgessünk inkább angolul",
			"Folytassuk angolul",
			"Angolul kérlek",
			"Kérlek angolul",
			"Angolul, légy szíves",
			"Tudnál angolul válaszolni?",
			"Válaszolhatsz angolul is",
			"Angolul szeretnék beszélgetni",
			"Magyarázd el angolul",
			"Foglald össze angolul",
			"Legyen angolul a válasz",
			"Csak angolul",
			"Angolul.",
			"Nem, angolul!",
			"Válaszolj inkább angolul",
			"Szeretném, ha angolul válaszolnál",
			"A válaszod legyen angolul",
			"Tudsz angolul válaszolni?",
			"Írj angol nyelvű levelet a főnökömnek",
			// The instruction opens the sentence and the language word closes it, many
			// words later: the whole sentence is the request.
			"Írj egy rövid köszönő e-mailt a vendéglátónknak angolul",
			"Írj egy rövid, de udvarias köszönő e-mailt a hétvégi vacsoráért a vendéglátóinknak angolul",
			"Kérlek nézd át ezt a kódot, és válaszolj angolul.",
		])("%j asks for English", (text) => {
			expect(detectExplicitLanguageRequest(text)).toBe("en");
		});
	});

	describe("Hungarian message, Hungarian wanted", () => {
		it.each([
			"válaszolj magyarul",
			"magyarul válaszolj",
			"kérlek magyarul",
			"Beszéljünk magyarul",
			"Írd meg magyarul",
			"Tudnál magyarul válaszolni?",
			"Magyarul, légy szíves",
		])("%j asks for Hungarian", (text) => {
			expect(detectExplicitLanguageRequest(text)).toBe("hu");
		});
	});

	describe("Hungarian message that only mentions a language", () => {
		it.each([
			"Hogy mondják angolul, hogy alma?",
			"Hogy mondjuk angolul azt, hogy köszönöm?",
			"Mit jelent angolul az, hogy 'serendipity'?",
			"Mi a kutya angolul?",
			"Mi ennek a szónak a jelentése angolul?",
			"Hogyan tanuljak meg gyorsan angolul, ha csak napi húsz percem van?",
			"Szeretnék angolul tanulni, hol kezdjem?",
			"A fiam angolul tanul, segíts neki a házi feladatban",
			"Hol tudok angolul gyakorolni?",
			"Fordítsd le angolra: jó reggelt kívánok!",
			"Fordítsd le angolul, hogy 'köszönöm a segítséget'.",
			"Fordítsd le angolul ezt a mondatot: jó reggelt",
			"Hogyan írjam le angolul, hogy 'sajnálom a késést'?",
			"Hogyan válaszoljak angolul egy üzleti e-mailre?",
			"Hogy hívják angolul a rántottát?",
			"Hogyan fordítják angolul a 'kiszámíthatóság' szót?",
			"Melyik jobb a munkámhoz: angolul vagy németül tanulni?",
			"Tudsz angolul?",
			"Beszélsz angolul?",
			"Mondd meg, hogy van angolul az, hogy kutya",
			"Angolul hogy van az, hogy szeretlek?",
			"Hogy mondják magyarul, hogy 'serendipity'?",
			"Mit jelent magyarul az, hogy 'apple'?",
			"Fordítsd le magyarra: good morning",
			"Fordítsd le magyarul ezt a mondatot: good morning",
			"Hogyan tanuljak meg magyarul?",
			"Angolul vagy magyarul válaszoljak?",
			"Mi a magyar megfelelője angolul a 'mutex' szónak?",
			"Magyarul is tudsz?",
			"Tudsz angolul beszélni?",
			"Az angol nyelvű oldal hibás, mit tegyek?",
			// A directive that opens the sentence reaches a language word far away only
			// when the language is not the subject.
			"Írj egy hosszú összefoglalót arról, hogy hogyan lehet gyorsan megtanulni angolul",
		])("%j keeps the conversation's language", (text) => {
			expect(detectExplicitLanguageRequest(text)).toBeNull();
		});
	});

	describe("English message, a language wanted", () => {
		it.each([
			["please respond in English", "en"],
			["Answer in English", "en"],
			["Reply in English please", "en"],
			["in English please", "en"],
			["In English, please.", "en"],
			["English please", "en"],
			["Please summarize what this file is about in English.", "en"],
			["Please explain the attached deployment notes in English", "en"],
			["Can you write this in Hungarian please?", "hu"],
			["Please answer in Hungarian", "hu"],
			["Could you explain this in Hungarian?", "hu"],
			["Respond in Hungarian from now on", "hu"],
			["Speak Hungarian to me", "hu"],
			["Let's talk in Hungarian", "hu"],
			["Switch to Hungarian", "hu"],
			["Hungarian please", "hu"],
			["I would like you to answer in Hungarian", "hu"],
			["Write your reply in Hungarian", "hu"],
			["Give me the answer in Hungarian", "hu"],
			["Give me an English title", "en"],
			["Write a short thank-you email to our hosts in English", "en"],
			[
				"Write a polite reminder to the whole team about Friday's meeting in English",
				"en",
			],
			["Can we switch to Hungarian?", "hu"],
			["Let's speak Hungarian", "hu"],
			["Use English from now on", "en"],
			["No, in English!", "en"],
			["Explain it in plain English", "en"],
			["Answer me in simple English", "en"],
			["Only in Hungarian", "hu"],
		] as const)("%j asks for %s", (text, language) => {
			expect(detectExplicitLanguageRequest(text)).toBe(language);
		});
	});

	describe("English message that only mentions a language", () => {
		it.each([
			"How do you say 'apple' in Hungarian?",
			"How do I say thank you in Hungarian?",
			"How would you write 'good morning' in Hungarian?",
			"What does 'szia' mean in Hungarian?",
			"What is the word for 'cozy' in Hungarian?",
			"What's the plural of 'ablak' in Hungarian?",
			"Is there a word for 'cozy' in Hungarian?",
			"Translate 'good morning' into Hungarian.",
			"Translate this sentence in Hungarian: good morning",
			"How do you pronounce 'sz' in Hungarian?",
			"I'm learning to write in Hungarian, any tips?",
			"Can you speak Hungarian?",
			"Do you speak Hungarian?",
			"How long does it take to learn Hungarian?",
			"Is Hungarian harder than English?",
			"How do you say 'szia' in English?",
			"What does 'apple' mean in English?",
			"I write in English at work",
			"I want to learn Hungarian",
			"Should I write in Hungarian or English?",
			"Translate this in Hungarian please",
			"Write a long summary of how people learn to speak in English",
		])("%j keeps the conversation's language", (text) => {
			expect(detectExplicitLanguageRequest(text)).toBeNull();
		});
	});

	it("takes the latest request when a message asks for both", () => {
		expect(
			detectExplicitLanguageRequest(
				"Answer in English. Actually, answer in Hungarian.",
			),
		).toBe("hu");
		expect(
			detectExplicitLanguageRequest(
				"Hogy mondják angolul, hogy alma? Válaszolj magyarul.",
			),
		).toBe("hu");
	});
});

describe("resolveResponseLanguage", () => {
	it("uses the latest message when its language is clear", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "What time is the meeting tomorrow?",
			}),
		).toBe("en");
		expect(
			resolveResponseLanguage({ latestMessage: "Szia, hogy vagy ma?" }),
		).toBe("hu");
	});

	it("prefers the latest clear message over the prior conversation language", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "What time is the meeting tomorrow?",
				priorUserMessages: ["Szia, hogy vagy?"],
			}),
		).toBe("en");
	});

	it("falls back to the most recent clearly-detected prior user message when the latest one is ambiguous", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "ok",
				priorUserMessages: ["Szia, hogy vagy?", "Kérlek segíts nekem ezzel"],
			}),
		).toBe("hu");
		expect(
			resolveResponseLanguage({
				latestMessage: "thanks",
				priorUserMessages: ["How do I configure environment variables?"],
			}),
		).toBe("en");
	});

	it("skips ambiguous prior messages and keeps looking further back", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "ok",
				priorUserMessages: ["42", "https://example.com", "Szia, hogy vagy?"],
			}),
		).toBe("hu");
	});

	it("falls back to the UI language when the latest message and all prior messages are ambiguous", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "ok",
				priorUserMessages: ["thanks", "42"],
				uiLanguage: "hu",
			}),
		).toBe("hu");
	});

	it("defaults to English when nothing else resolves the language", () => {
		expect(resolveResponseLanguage({ latestMessage: "ok" })).toBe("en");
		expect(
			resolveResponseLanguage({ latestMessage: "ok", priorUserMessages: [] }),
		).toBe("en");
	});

	it("honours an explicit request even when the message itself is in the other language", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "Kérlek nézd át ezt a kódot, és válaszolj angolul.",
			}),
		).toBe("en");
		expect(
			resolveResponseLanguage({
				latestMessage: "Can you write this in Hungarian please?",
			}),
		).toBe("hu");
	});

	it("keeps the message's own language when it only mentions another language", () => {
		// The owner's trap: a Hungarian question that merely contains "angolul"
		// must be answered in Hungarian (and an English one that contains
		// "in Hungarian" in English).
		const resolve = (latestMessage: string) =>
			resolveResponseLanguage({
				latestMessage,
				priorUserMessages: [],
				uiLanguage: "en",
			});
		expect(resolve("Hogy mondják angolul, hogy alma?")).toBe("hu");
		expect(resolve("Mit jelent angolul az, hogy 'serendipity'?")).toBe("hu");
		expect(
			resolve(
				"Hogyan tanuljak meg gyorsan angolul, ha csak napi húsz percem van?",
			),
		).toBe("hu");
		expect(resolve("Hogyan írjam le angolul, hogy 'sajnálom a késést'?")).toBe(
			"hu",
		);
		expect(resolve("Fordítsd le angolul, hogy 'köszönöm a segítséget'.")).toBe(
			"hu",
		);
		expect(resolve("How do you say 'apple' in Hungarian?")).toBe("en");
		expect(resolve("What does 'szia' mean in Hungarian?")).toBe("en");
		expect(resolve("What is the word for 'cozy' in Hungarian?")).toBe("en");
	});

	it("still lets a real request change the language, even against the conversation's", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "Beszéljünk angolul, szeretnék gyakorolni.",
				priorUserMessages: ["Szia, hogy vagy?"],
				uiLanguage: "hu",
			}),
		).toBe("en");
		expect(
			resolveResponseLanguage({
				latestMessage: "Please answer in Hungarian: what is a mutex?",
				priorUserMessages: ["How do I configure environment variables?"],
				uiLanguage: "en",
			}),
		).toBe("hu");
	});

	// Release check (2026-09-25 language review): on a first turn — no prior
	// messages, English UI — each of these realistic Hungarian messages must
	// still resolve the WHOLE turn to Hungarian. Most carry no ő/ű and few
	// closed-class function words, which is exactly the shape the old
	// lingua-backed detector used to get right and the rewritten scorer must
	// not regress on.
	it("resolves a first English-UI turn to Hungarian for realistic short Hungarian messages", () => {
		const firstTurn = (latestMessage: string) =>
			resolveResponseLanguage({
				latestMessage,
				priorUserMessages: [],
				uiLanguage: "en",
			});

		expect(firstTurn("Írj egy checklistet a hétvégére")).toBe("hu");
		expect(firstTurn("Köszi!")).toBe("hu");
		expect(firstTurn("Szia")).toBe("hu");
		expect(firstTurn("igen")).toBe("hu");
		expect(firstTurn("nem jó")).toBe("hu");
		expect(firstTurn("Fordítsd le angolra: good morning")).toBe("hu");
		expect(firstTurn("Mi a helyzet?")).toBe("hu");
		expect(firstTurn("Csinálj egy táblázatot")).toBe("hu");
		expect(firstTurn("A React komponens nem renderel, mit csináljak?")).toBe(
			"hu",
		);
	});

	// Release check (2026-09-25 language review): a broader set of common,
	// unambiguous short Hungarian replies/greetings must each resolve the
	// WHOLE first turn to Hungarian even with an English UI language — proving
	// HUNGARIAN_SHORT_WORDS (not the uiLanguage fallback) is what recognizes
	// them. None of these collide with an everyday English short reply.
	describe("common short Hungarian replies and greetings", () => {
		const firstTurnEnglishUi = (latestMessage: string) =>
			resolveResponseLanguage({
				latestMessage,
				priorUserMessages: [],
				uiLanguage: "en",
			});

		it.each([
			"mehet",
			"oké",
			"rendben",
			"köszönöm",
			"köszi",
			"köszike",
			"szuper",
			"persze",
			"pontosan",
			"értem",
			"tovább",
			"folytasd",
			"kész",
			"megvan",
			"szia",
			"sziasztok",
			"helló",
			"hali",
			"jó reggelt",
			"jó éjt",
			"igen",
			"nem",
			"jó",
			"naná",
			"hogyne",
		])("resolves %j to Hungarian on a first turn despite an English UI language", (latestMessage) => {
			expect(firstTurnEnglishUi(latestMessage)).toBe("hu");
		});

		it.each([
			"ok",
			"thanks",
			"go on",
			"sure",
			"yes please",
		])("keeps the everyday English short reply %j as English", (latestMessage) => {
			expect(firstTurnEnglishUi(latestMessage)).toBe("en");
		});
	});

	it("never lets non-user context decide the language, because the signature has no field for it", () => {
		// priorUserMessages is documented as user-authored-only; memory facts,
		// project files, web results, and assistant text must never be passed
		// in here. This test exists as a signature-level guardrail: with an
		// ambiguous latest message and no (real) prior user evidence, the
		// resolver must fall through to the UI-language/default rule rather
		// than ever inventing a language from elsewhere.
		expect(
			resolveResponseLanguage({
				latestMessage: "ok",
				priorUserMessages: [],
				uiLanguage: "en",
			}),
		).toBe("en");
	});
});
