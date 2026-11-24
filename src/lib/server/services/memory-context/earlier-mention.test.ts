import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	mentionBank,
	mentionsMemoryEntry,
	mentionWords,
} from "./earlier-mention";

/** Synthetic, written for this measurement: every entry and message is invented. */
const measurement: {
	entries: { lang: "en" | "hu"; text: string }[];
	unrelated: string[];
	about: { entry: number; message: string }[];
	crossLanguage: { entry: string; message: string }[];
} = JSON.parse(
	readFileSync(
		join(
			process.cwd(),
			"src/lib/server/services/memory-context/earlier-mention.fixtures.json",
		),
		"utf8",
	),
);

describe("mentionsMemoryEntry", () => {
	it("is true when the message shares a significant word with the entry", () => {
		expect(
			mentionsMemoryEntry(
				"How did the dentist go?",
				"The user had a dentist appointment for a filling.",
			),
		).toBe(true);
	});

	it("is false for a message that shares only small talk with the entry", () => {
		expect(
			mentionsMemoryEntry(
				"Thanks, that helps a lot!",
				"The user had a dentist appointment for a filling.",
			),
		).toBe(false);
	});

	it("folds case and accents as Workspace Search does", () => {
		expect(
			mentionsMemoryEntry(
				"PECSRE megyunk",
				"A felhasználó a hétvégén a szüleihez megy Pécsre.",
			),
		).toBe(true);
	});

	it("matches an inflected word by a shared prefix of at least five letters", () => {
		expect(
			mentionsMemoryEntry(
				"Budapesten lakom most",
				"The user had a job interview in Budapest.",
			),
		).toBe(true);
		expect(
			mentionsMemoryEntry(
				"Sikerült a záróvizsgám!",
				"A felhasználónak záróvizsgája volt.",
			),
		).toBe(true);
	});

	it("does not match words that only begin alike", () => {
		// "exam" and "example" share four letters: an example is no exam.
		expect(
			mentionsMemoryEntry(
				"Give me an example of a haiku.",
				"The user had a theory exam.",
			),
		).toBe(false);
	});

	it("ignores words under three letters, numbers and stop words in both languages", () => {
		expect(mentionWords("I am at it, 2025 or so")).toEqual([]);
		expect(mentionWords("Köszönöm szépen, ez nagyon jó volt")).toEqual([]);
		expect(mentionWords("What would you like to know about this?")).toEqual([]);
	});

	it("never counts the entry's own way of naming the person", () => {
		// Hindsight's entries say "The user" and "A felhasználó": a message
		// about users or a username must not reach every entry.
		expect(
			mentionsMemoryEntry(
				"How do I add a user to my database?",
				"The user had a dentist appointment.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"Hogyan törlök egy felhasználót?",
				"A felhasználó fogorvoshoz ment.",
			),
		).toBe(false);
	});

	it("splits words at punctuation, hyphens and apostrophes", () => {
		expect(
			mentionsMemoryEntry(
				"Is the house-sitting over?",
				"The user's neighbours asked them to house-sit.",
			),
		).toBe(true);
	});
});

describe("which words are one word", () => {
	it("matches a stem of four letters with an ending of at most two", () => {
		expect(
			mentionsMemoryEntry(
				"How did my exams go?",
				"The user's driving theory exam was coming up.",
			),
		).toBe(true);
		expect(
			mentionsMemoryEntry(
				"Both knees hurt again",
				"The user hurt a knee playing football.",
			),
		).toBe(true);
		expect(
			mentionsMemoryEntry(
				"Mit ültessek a kertbe?",
				"A felhasználó felásta a kertet.",
			),
		).toBe(true);
	});

	it("bounds the ending of a word that begins another", () => {
		// "kerül" (it costs) is not "kerület" (a district).
		expect(
			mentionsMemoryEntry(
				"Mennyibe kerül egy jó bicikli?",
				"A felhasználó a hetedik kerületbe költözött.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"My plant needs more light.",
				"The user visited a coffee plantation in Brazil.",
			),
		).toBe(false);
	});

	it("never counts month and weekday names, in either language", () => {
		expect(
			mentionsMemoryEntry(
				"The marching band was loud.",
				"The user had a dentist appointment in March.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"Any plans for Friday?",
				"The user's boiler was serviced on Friday.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"Márciusban mi a teendő a kertben?",
				"A felhasználó márciusban fogorvoshoz ment.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"Pénteken ráérsz?",
				"A felhasználó pénteken vizsgázott.",
			),
		).toBe(false);
	});

	it("never counts the everyday words for work, projects, plans and interest", () => {
		expect(
			mentionsMemoryEntry(
				"Can you help me get through my work today?",
				"The user flew to Lisbon for a work conference.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"I need to finish this project.",
				"The user's project report was due at noon.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"That's an interesting idea.",
				"The user was interested in learning the cello.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"Holnap sokáig kell dolgoznom.",
				"A felhasználó egy pékségben dolgozott.",
			),
		).toBe(false);
		expect(
			mentionsMemoryEntry(
				"Mit tervezel a hétvégére?",
				"A felhasználó a konyha felújítását tervezte.",
			),
		).toBe(false);
	});
});

describe("words common in the person's own bank", () => {
	const entries = [
		"The user's daughter Lili started school.",
		"Lili has a peanut allergy.",
		"The user and Lili went to Rome.",
		"Lili plays the violin and has a violin lesson every week.",
		"The user's partner plays the violin too.",
		"The user's violin teacher moved away.",
		"The user likes hiking near Graz.",
		"The user lives in Graz.",
	];
	const bank = mentionBank(entries);

	it("does not count a word that many of the bank's entries hold, alone", () => {
		expect(
			mentionsMemoryEntry(
				"What should I get Lili for her birthday?",
				entries[2],
				bank,
			),
		).toBe(false);
		// Without the bank, every shared word counts.
		expect(
			mentionsMemoryEntry(
				"What should I get Lili for her birthday?",
				entries[2],
			),
		).toBe(true);
	});

	it("counts a rare word, and two common ones together", () => {
		expect(mentionsMemoryEntry("Was Rome nice?", entries[2], bank)).toBe(true);
		expect(
			mentionsMemoryEntry("Lili's violin is out of tune.", entries[3], bank),
		).toBe(true);
	});

	it("reads a word one or two entries hold as rare", () => {
		expect(
			mentionsMemoryEntry("Is the allergy better?", entries[1], bank),
		).toBe(true);
		expect(
			mentionsMemoryEntry("Is Graz nice in spring?", entries[7], bank),
		).toBe(true);
	});
});

describe("the gate's cost on a turn", () => {
	/** A pasted megabyte: 200,000 distinct words and no mention in it. */
	const megabyte = () => {
		const words: string[] = [];
		let length = 0;
		for (let i = 0; length < 1_000_000; i++) {
			const word = `zq${i.toString(36)}vk`;
			words.push(word);
			length += word.length + 1;
		}
		return words.join(" ");
	};
	const entries = measurement.entries.slice(0, 6).map(({ text }) => text);

	it("reads a 1 MB message and checks six entries in under a quarter of a second", () => {
		// What one recall does: the message's words once, then at most six
		// Earlier entries (three places in each of two banks).
		const message = megabyte();
		const started = performance.now();
		const words = mentionWords(message);
		for (const entry of entries) mentionsMemoryEntry(words, entry);
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("reads the first 4,000 and the last 2,000 characters of a long message", () => {
		const filler = (length: number) => "lorem ".repeat(length / 6);
		const entry = "The user had a dentist appointment for a filling.";
		expect(
			mentionsMemoryEntry(
				`dentist ${filler(3_000)} ${filler(1_000_000)}`,
				entry,
			),
		).toBe(true);
		expect(
			mentionsMemoryEntry(
				`${filler(1_000_000)} ${filler(1_000)} dentist`,
				entry,
			),
		).toBe(true);
		expect(
			mentionsMemoryEntry(
				`${filler(6_000)} dentist ${filler(1_000_000)}`,
				entry,
			),
		).toBe(false);
	});

	it("weighs a bank of 1,000 entries and checks six entries in under a quarter of a second", () => {
		const texts = Array.from(
			{ length: 1_000 },
			(_, i) =>
				`The user had appointment number zq${i.toString(36)} with a dentist in Graz about a filling and a crown.`,
		);
		const started = performance.now();
		const bank = mentionBank(texts);
		const words = mentionWords(megabyte());
		for (const entry of texts.slice(0, 6))
			mentionsMemoryEntry(words, entry, bank);
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("lists each word once, in order", () => {
		expect(mentionWords("dentist filling dentist Dentist filling")).toEqual([
			"dentist",
			"filling",
		]);
	});
});

/**
 * The synthetic measurement (Memory label migration, Build B): Earlier
 * entries in English and Hungarian, messages about them and messages about
 * nothing in them. The worst case for rank is assumed: every Earlier entry is
 * in its bank's top three for every message, so the gate is the mention.
 */
describe("the Earlier mention measurement", () => {
	const entries = measurement.entries;
	// The entries are one bank, as recall weighs them.
	const bank = mentionBank(entries.map(({ text }) => text));
	const mentionsAny = (message: string) =>
		entries.some(({ text }) => mentionsMemoryEntry(message, text, bank));

	it("brings an Earlier entry for at most 1 in 10 unrelated messages", () => {
		const reached = measurement.unrelated.filter(mentionsAny).length;
		expect(measurement.unrelated.length).toBeGreaterThanOrEqual(20);
		expect(reached / measurement.unrelated.length).toBeLessThanOrEqual(0.1);
	});

	it("brings the entry for at least 8 in 10 messages about it", () => {
		const about = measurement.about;
		const brought = about.filter(({ message, entry }) =>
			mentionsMemoryEntry(message, entries[entry].text, bank),
		).length;
		expect(about.length).toBeGreaterThanOrEqual(20);
		expect(brought / about.length).toBeGreaterThanOrEqual(0.8);
	});

	it("holds in each language", () => {
		for (const lang of ["en", "hu"]) {
			const unrelated = measurement.unrelated.filter((_, i) =>
				lang === "en" ? i < 10 : i >= 10,
			);
			const about = measurement.about.filter(
				({ entry }) => entries[entry].lang === lang,
			);
			expect(unrelated.filter(mentionsAny).length).toBeLessThanOrEqual(1);
			expect(
				about.filter(({ message, entry }) =>
					mentionsMemoryEntry(message, entries[entry].text, bank),
				).length,
			).toBeGreaterThanOrEqual(8);
		}
	});
});
