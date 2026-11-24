import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mentionsMemoryEntry, mentionWords } from "./earlier-mention";

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

	it("does not match words that share fewer than five letters", () => {
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
	const mentionsAny = (message: string) =>
		entries.some(({ text }) => mentionsMemoryEntry(message, text));

	it("brings an Earlier entry for at most 1 in 10 unrelated messages", () => {
		const reached = measurement.unrelated.filter(mentionsAny).length;
		expect(measurement.unrelated.length).toBeGreaterThanOrEqual(20);
		expect(reached / measurement.unrelated.length).toBeLessThanOrEqual(0.1);
	});

	it("brings the entry for at least 8 in 10 messages about it", () => {
		const about = measurement.about;
		const brought = about.filter(({ message, entry }) =>
			mentionsMemoryEntry(message, entries[entry].text),
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
					mentionsMemoryEntry(message, entries[entry].text),
				).length,
			).toBeGreaterThanOrEqual(8);
		}
	});
});
