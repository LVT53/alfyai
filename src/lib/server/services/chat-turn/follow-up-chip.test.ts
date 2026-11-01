import { describe, expect, it } from "vitest";
import {
	checkFollowUpChip,
	type FollowUpChipRejection,
} from "./follow-up-chip";

const MAX_WORDS = 8;

function check(text: string, language?: "en" | "hu") {
	return checkFollowUpChip(text, { language, maxWords: MAX_WORDS });
}

function rejectionOf(
	text: string,
	language?: "en" | "hu",
): FollowUpChipRejection | null {
	const result = check(text, language);
	return result.ok ? null : result.reason;
}

// A follow-up chip is the NEXT MESSAGE THE PERSON WOULD SEND to Alfy: tapping it
// sends its text, as it stands, as the person's own message. The strings below
// are the real chips the model wrote for the 26 captured conversations (before
// and after the prompt rewrite) unless a comment says where one comes from.
describe("a chip is the next message the person would send to Alfy", () => {
	describe("accepts an instruction or a first-person question about a named thing", () => {
		it.each([
			["Hasonlítsd össze a két opciót táblázatban", "hu"],
			["Készíts bevásárlólistát a heti étrendhez", "hu"],
			["Írd meg az e-mailt a bérbeadónak", "hu"],
			["Tedd formálisabbá a szöveget", "hu"],
			["Írd át hivatalosabb stílusra", "hu"],
			["Hozzáadnád a dátumot is?", "hu"],
			["Hogyan telepítem a Husky-t?", "hu"],
			["Milyen cipőt vegyek kezdőként?", "hu"],
			["Mit egyek futás előtt?", "hu"],
			["Melyik indexalapot ajánlod kezdésnek?", "hu"],
			["Mennyi lenmagpehely kell egy tojás helyett?", "hu"],
			["Mi a teendő, ha fáj a bokám?", "hu"],
			// A file name's dot is not a sentence break.
			["Mi a lint parancs a package.json-ban?", "hu"],
			// A question word is an opener, with or without the question mark.
			["Hogyan állapítsam meg a kockázati szintem", "hu"],
			["Kérlek, részletezd a bevásárlólistát", "hu"],
			["Szeretném látni a heti bevásárlólistát", "hu"],
			["Konkrét modelleket javasolnál?", "hu"],
			["Hogyan jutok el a Széchenyi fürdőbe?", "hu"],
			// A colon inside a question, a list's commas and a Hungarian ordinal's dot
			// are not a second sentence (each of these was a good chip the first
			// version of the check threw away).
			["Melyik a jobb: lenmag vagy banán?", "hu"],
			["Magyarázd el a 2. lépést részletesen", "hu"],
			// "reggel" ends like a second-person verb but is "in the morning".
			["Melyik vonattal utazzak, ha csak reggel indulhatok?", "hu"],
			["List songs using G, C and D", "en"],
			["Compare the two options in a table", "en"],
			["Turn the weekly menu into a shopping list", "en"],
			["Draft the email to my landlord", "en"],
			["Make it more formal", "en"],
			["Which pastries should I try in Belém?", "en"],
			["How do I get to Sintra from Lisbon?", "en"],
			["How does a mutex differ from a semaphore?", "en"],
			["Show a mutex example in Python", "en"],
			["Should I track calories daily?", "en"],
			["Can I use tap water instead?", "en"],
			["How do I find market salary data", "en"],
			["Can you draft a packing list?", "en"],
			["I want a comparison table of both options", "en"],
		] as const)("%s (%s)", (text, language) => {
			expect(check(text, language)).toEqual({ ok: true, text });
		});
	});

	describe("rejects Alfy offering", () => {
		it.each([
			["Szeretnéd rövidebbre venni?", "hu"],
			["Szeretnéd, hogy írok egy listát?", "hu"],
			["Írjam le a bemelegítő gyakorlatokat?", "hu"],
			["Küldök egy példát a hibára?", "hu"],
			["Megnézhetem a kódrészletet?", "hu"],
			["Kérsz egy példát?", "hu"],
			["Érdekelne egy négyhetes terv?", "hu"],
			["Segítsek összeállítani a listát?", "hu"],
			// The English ones are the shapes the old prompt's rule invited; the
			// model did not write them in 400 chips, so they are not model output.
			["Would you like me to draft the email?", "en"],
			["Do you want a vegan version?", "en"],
			["Want me to turn this into a checklist?", "en"],
			["Shall I write the email?", "en"],
			["Should I draft the email?", "en"],
			["Let me draft the email", "en"],
			["I can compare them for you", "en"],
			["Are you interested in a checklist?", "en"],
		] as const)("%s (%s)", (text, language) => {
			expect(rejectionOf(text, language)).toBe("offer");
		});

		it("keeps the person's own 'should I' questions", () => {
			expect(check("Should I use protein powder as a beginner?", "en").ok).toBe(
				true,
			);
			expect(check("Should I book a guided tour?", "en").ok).toBe(true);
			expect(check("Hogyan javítsam a ciklusfejet?", "hu").ok).toBe(true);
		});
	});

	describe("rejects a question put to the person, or a fact put in their mouth", () => {
		it.each([
			["Szeretsz sült krumplit vacsorára?", "hu", "asks_person"],
			["Melyik opció a jobb ha sokat autózol?", "hu", "asks_person"],
			// The brief's own example.
			["Mennyi a kereted?", "hu", "asks_person"],
			["Mekkora a költségvetésed?", "hu", "asks_person"],
			["Dolgozol otthonról?", "hu", "asks_person"],
			["Voltál már Bécsben?", "hu", "asks_person"],
			// "your boss" in the person's own mouth is "my boss".
			["Írj e-mailt a főnöködnek a prioritásokról", "hu", "asks_person"],
			// An instruction to the person: Alfy cannot paste or upload for them.
			["Ragaszd be a hibás Python kódrészletet", "hu", "asks_person"],
			["Paste the faulty snippet here", "en", "asks_person"],
			["Do you have a car?", "en", "asks_person"],
			["Are you vegetarian?", "en", "asks_person"],
			["What is your current salary range?", "en", "asks_person"],
			["How much do you earn?", "en", "asks_person"],
			// A statement about the person would put an invented fact in their mouth
			// (the model wrote these as "answers" to a reply that asked for details).
			["I work in software engineering in Hungary", "en", "not_a_request"],
			[
				"I am in automotive manufacturing near Stuttgart",
				"en",
				"not_a_request",
			],
			["I like winter because of snow", "en", "not_a_request"],
			["Szoftverfejlesztő vagyok", "hu", "not_a_request"],
			["Not a question at all", "en", "not_a_request"],
		] as const)("%s (%s)", (text, language, reason) => {
			expect(rejectionOf(text, language)).toBe(reason);
		});

		it("keeps the person asking Alfy", () => {
			expect(check("Which one would you recommend?", "en").ok).toBe(true);
			expect(check("Melyik márkát ajánlod?", "hu").ok).toBe(true);
		});
	});

	describe("rejects the generic ones: nothing is named", () => {
		it.each([
			["Tell me more", "en"],
			["Tell me more about this", "en"],
			["Go on", "en"],
			["What else?", "en"],
			["Anything else?", "en"],
			["Explain further", "en"],
			["What are the next steps?", "en"],
			["Can you elaborate?", "en"],
			["Give me an example", "en"],
			["Mondj többet", "hu"],
			["Mesélj többet erről", "hu"],
			["Mi a következő lépés?", "hu"],
			["Még valami?", "hu"],
			["Magyarázd el ezt", "hu"],
			["Mutass egy példát", "hu"],
		] as const)("%s (%s)", (text, language) => {
			expect(rejectionOf(text, language)).toBe("generic");
		});

		it("a one-word chip is too short to name anything", () => {
			expect(rejectionOf("Cost?")).toBe("too_short");
			expect(rejectionOf("Folytasd")).toBe("too_short");
		});

		it("keeps a chip that names a thing, however plain the verb", () => {
			expect(check("Mondd el részletesebben a második lépést", "hu").ok).toBe(
				true,
			);
			expect(check("Tell me more about the Sintra day trip", "en").ok).toBe(
				true,
			);
		});
	});

	describe("is in the turn's language, and in Latin script", () => {
		it.each([
			["Can you recommend specific ruin bars?", "hu"],
			["Which specific models fit this budget?", "hu"],
			["Are there any local food tours?", "hu"],
			["Melyik podcast appot ajánlod?", "en"],
			["Hogyan találjak nyelvi cserét?", "en"],
		] as const)("%s is not %s", (text, language) => {
			expect(rejectionOf(text, language)).toBe("language");
		});

		// The real-model check of the language call (C0-ru6, repetition 1): the
		// chips request said "in English" and "Fejtsd ki részletesebben a két
		// szakaszt" was kept. Nothing in it is on the short list of words only
		// Hungarian has, and it holds one word spelt the Hungarian way, which the
		// reader of a title never counts as enough. A chip is a sentence: four words
		// or more with no English word in them and a Hungarian one is not English.
		it.each([
			["Fejtsd ki részletesebben a két szakaszt", "en"],
			["Sorold fel a három lépést pontosabban", "en"],
			["Hasonlítsd össze a két módszert részletesen", "en"],
			["Mutasd meg a lépéseket egyszerűbben", "en"],
			["Explain the Calvin cycle in more detail", "hu"],
			["Show the steps in a simpler way", "hu"],
		] as const)("%s is not %s", (text, language) => {
			expect(rejectionOf(text, language)).toBe("language");
		});

		// English chips that carry a Hungarian name, a place or one of the English
		// words that are Hungarian words too ("van", "volt"), and Hungarian chips
		// that carry an English product name, are in their language.
		it.each([
			["Compare Győr and Székesfehérvár in a table", "en"],
			["Show me Van Gogh's most famous paintings", "en"],
			["How many volt does a Chevy Volt use?", "en"],
			["Explain how a 12 volt battery works", "en"],
			["Show me Győr and Pécs weekend plans", "en"],
			["Hasonlítsd össze a két Python verziót", "hu"],
			["Magyarázd el a Docker Compose fájlt", "hu"],
		] as const)("%s stays %s", (text, language) => {
			expect(check(text, language)).toEqual({ ok: true, text });
		});

		it("does not read a short Hungarian chip without accents as English", () => {
			// The app's detector reads this one as English: no accent, no function
			// word. A chip is judged on words only the other language has.
			expect(check("Melyik romkocsma a legjobb?", "hu").ok).toBe(true);
			expect(check("Melyik app a legjobb szavakhoz?", "hu").ok).toBe(true);
		});

		it("rejects a chip with characters from another script", () => {
			expect(
				rejectionOf("Kell hozzá额外 garancia vagy biztosítás?", "hu"),
			).toBe("script");
		});

		it("checks both languages when none is given", () => {
			expect(check("Compare the two options in a table").ok).toBe(true);
			expect(check("Hasonlítsd össze a két opciót táblázatban").ok).toBe(true);
			expect(check("Szeretnéd rövidebbre venni?").ok).toBe(false);
		});
	});

	describe("is one short plain sentence", () => {
		it("rejects an empty candidate", () => {
			expect(rejectionOf("")).toBe("empty");
			expect(rejectionOf("   ")).toBe("empty");
			expect(rejectionOf("?")).toBe("empty");
		});

		it("accepts a chip at the word budget and rejects one word over it", () => {
			// Eight words.
			expect(check("Can you draft the email to my landlord?", "en").ok).toBe(
				true,
			);
			// Nine.
			expect(rejectionOf("Can you draft the follow up email to them?")).toBe(
				"too_long",
			);
		});

		it.each([
			"Is that true. Really?",
			"Compare {both} options",
			"**Compare** the two options",
			"1. Compare the two options",
			"Melyik olcsóbb hosszú távon? Részletes számítás",
			"Hogyan töltsük ki a [Name] helyét?",
			"Compare, the two, options, in, a table",
		])("rejects %j as not one plain sentence", (text) => {
			expect(rejectionOf(text)).toBe("format");
		});

		it("normalizes whitespace, wrapping quotes and a closing full stop", () => {
			expect(check("  Compare   the two  options.  ", "en")).toEqual({
				ok: true,
				text: "Compare the two options",
			});
			expect(check('"Compare the two options"', "en")).toEqual({
				ok: true,
				text: "Compare the two options",
			});
			expect(check("Hasonlítsd össze a két opciót!", "hu")).toEqual({
				ok: true,
				text: "Hasonlítsd össze a két opciót",
			});
		});
	});
});

// Task 17 (rehearsal P5), fix round 1: after a turn whose message carried marks,
// a chip offered "Move the new sofa to the spot in box B". Marks belong to the
// one message they were drawn for and are let go when it is sent, so in a chat
// that had marks a chip that names one of ITS mark letters in a mark context is
// stale. Only there: a chat that never had marks keeps every chip, and words like
// "Area C", "box B" or "jelölésű" stay what they mean.
const MARKS_GONE = ["A", "B", "C"];

function rejectionInMarkedChat(
	text: string,
	language: "en" | "hu",
	letters: string[] = MARKS_GONE,
): FollowUpChipRejection | null {
	const result = checkFollowUpChip(text, {
		language,
		maxWords: 12,
		goneMarkLetters: letters,
	});
	return result.ok ? null : result.reason;
}

describe("a chip never names a mark that is gone", () => {
	it.each([
		["Move the new sofa to the spot in box B", "en"],
		["Make box A a little brighter", "en"],
		["Fill boxes A and B with plants", "en"],
		["Put a lamp in mark C", "en"],
		["Tedd a kanapét a B keretbe", "hu"],
		["Színezd át az A jelölésen belüli részt", "hu"],
		["Tegyél növényt a C dobozba", "hu"],
	] as const)("rejects %j in a chat whose marks are gone", (text, language) => {
		expect(rejectionInMarkedChat(text, language)).toBe("stale_mark");
	});

	// The review's false positives: everyday chips in a chat that never had marks.
	it.each([
		["Explain the legal status of Area C in the West Bank", "en"],
		["Work out the odds of drawing red from box B", "en"],
		["Compare frames A and B of the animation", "en"],
		["Mark A as the default option", "en"],
		["Hasonlítsd össze az A és B jelölésű hűtőket", "hu"],
		["Számold ki a valószínűséget a B dobozra", "hu"],
		["Move the new sofa to the spot in box B", "en"],
	] as const)("keeps %j in a chat that never had marks", (text, language) => {
		expect(rejectionOf(text, language)).not.toBe("stale_mark");
	});

	it.each([
		["Explain the legal status of Area C in the West Bank", "en"],
		["Compare frames A and B of the animation", "en"],
		["Mark A as the default option", "en"],
		["Hasonlítsd össze az A és B jelölésű hűtőket", "hu"],
		["Pack the books into a box for the move", "en"],
		["Compare plan A and plan B in a table", "en"],
		["Készíts listát a dobozokba pakoláshoz", "hu"],
		["A keretszerződést foglald össze röviden", "hu"],
	] as const)("keeps %j in a chat with marks, where it names no mark", (text, language) => {
		expect(rejectionInMarkedChat(text, language)).not.toBe("stale_mark");
	});

	it("keeps a box whose letter was never drawn in this chat", () => {
		expect(
			rejectionInMarkedChat("Make box D a little brighter", "en", ["A"]),
		).not.toBe("stale_mark");
	});
});
