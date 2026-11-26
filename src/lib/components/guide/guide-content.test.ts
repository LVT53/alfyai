import { describe, expect, it } from "vitest";
import { APP_PLACES, SPOTLIGHT_IDS } from "$lib/app-places";
import guideDict from "$lib/i18n/guide";
import {
	BEFORE_THE_GUIDE,
	GUIDE_ENTRIES,
	GUIDE_NEW_FOR_DAYS,
	GUIDE_SECTION_IDS,
	guideEntriesFor,
	guideEntryKey,
	guideSectionKey,
	isGuideEntryNew,
} from "./guide-content";

const LANGUAGES = ["en", "hu"] as const;

// The dictionary is typed by its own keys, and the key builders return the
// app-wide `I18nKey`: read the dictionary as plain words to look a built key up.
const words: Record<
	(typeof LANGUAGES)[number],
	Record<string, string>
> = guideDict;

describe("the feature guide's content", () => {
	it("has six sections in the approved order", () => {
		expect(GUIDE_SECTION_IDS).toEqual([
			"ask",
			"make",
			"knowsYou",
			"yourThings",
			"organized",
			"account",
		]);
	});

	it("has thirty-five entries with unique ids, 8/7/6/4/5/5 per section", () => {
		expect(new Set(GUIDE_ENTRIES.map((e) => e.id)).size).toBe(35);
		expect(GUIDE_SECTION_IDS.map((s) => guideEntriesFor(s).length)).toEqual([
			8, 7, 6, 4, 5, 5,
		]);
	});

	// The person's own Pictures and videos switch (Settings > Profile, the
	// Assistant card): Show me rings its row, and the row lights the switch the
	// Knows-you drawing draws after Memory.
	it("lists Pictures and videos in It knows you, before Voices, with Show me on its Settings row", () => {
		const knowsYou = guideEntriesFor("knowsYou");
		expect(knowsYou.at(-2)).toEqual({
			id: "picturesAndVideos",
			section: "knowsYou",
			drawingSpot: "pictures",
			action: {
				kind: "showMe",
				place: "settings",
				spotlight: "settings.pictures",
			},
			added: "2026-11-17",
		});
		const expected = {
			en: {
				"guide.entry.picturesAndVideos.name": "Pictures and videos",
				"guide.entry.picturesAndVideos.line":
					"Alfy makes them only when you ask, and you can switch them off.",
			},
			hu: {
				"guide.entry.picturesAndVideos.name": "Képek és videók",
				"guide.entry.picturesAndVideos.line":
					"Alfy csak kérésre készít ilyet, és ki is kapcsolhatod.",
			},
		} as const;
		for (const lang of LANGUAGES) {
			for (const [key, value] of Object.entries(expected[lang])) {
				expect(words[lang][key], `${lang} ${key}`).toBe(value);
			}
			expect(
				words[lang]["guide.entry.picturesAndVideos.example"],
			).toBeUndefined();
		}
	});

	// The person's own Send with Enter switch (Settings > Profile, the last row of
	// the Preferences card): Show me rings its row. The Your account drawing
	// shows only that card's first two rows, so the entry lights nothing.
	it("lists Send with Enter in Your account, after Language and look, with Show me on its Settings row", () => {
		const account = guideEntriesFor("account");
		expect(account.map((e) => e.id).slice(0, 2)).toEqual([
			"languageAndLook",
			"sendWithEnter",
		]);
		expect(account[1]).toEqual({
			id: "sendWithEnter",
			section: "account",
			drawingSpot: null,
			action: {
				kind: "showMe",
				place: "settings",
				spotlight: "settings.sendWithEnter",
			},
			added: "2026-11-18",
		});
		const expected = {
			en: {
				"guide.entry.sendWithEnter.name": "Send with Enter",
				"guide.entry.sendWithEnter.line":
					"Enter sends your message and Shift+Enter starts a new line.",
			},
			hu: {
				"guide.entry.sendWithEnter.name": "Küldés Enterrel",
				"guide.entry.sendWithEnter.line":
					"Az Enter elküldi az üzenetet, a Shift+Enter új sort kezd.",
			},
		} as const;
		for (const lang of LANGUAGES) {
			for (const [key, value] of Object.entries(expected[lang])) {
				expect(words[lang][key], `${lang} ${key}`).toBe(value);
			}
			// A Show me has no example: only Try it has one.
			expect(words[lang]["guide.entry.sendWithEnter.example"]).toBeUndefined();
		}
	});

	// Read aloud (Plan 4, Task 1). The speaker needs a finished reply, so its
	// entry has Try it and its row lights the speaker in the chat drawing; Show me
	// goes to the Read aloud card in Settings, which is always there when the
	// feature is on (the guide's rule: Show me only where the control is).
	it("lists Listen to a reply last in Ask, with Try it, and Voices that read to you last in It knows you, with Show me on the Read aloud card", () => {
		expect(guideEntriesFor("ask").at(-1)).toEqual({
			id: "listenToAReply",
			section: "ask",
			drawingSpot: "readAloud",
			action: { kind: "tryIt" },
			added: "2026-11-17",
		});
		expect(guideEntriesFor("knowsYou").at(-1)).toEqual({
			id: "yourVoices",
			section: "knowsYou",
			// The Knows-you drawing has no room for the Read aloud card (see the entry).
			drawingSpot: null,
			action: {
				kind: "showMe",
				place: "settings",
				spotlight: "settings.readAloud",
			},
			added: "2026-11-17",
		});
	});

	// Read aloud on Documents and reports (read-aloud-documents): the same entry
	// says a document or a report can be read too.
	it("words the two read-aloud entries in English and Hungarian", () => {
		const expected = {
			en: {
				"guide.entry.listenToAReply.name": "Listen to a reply or a document",
				"guide.entry.listenToAReply.line":
					"Press the speaker under a reply, or at the top of a document or a report, to hear it, and follow the words as they are read.",
				"guide.entry.listenToAReply.example":
					"Tell me a short story about a lighthouse keeper.",
				"guide.entry.yourVoices.name": "Voices that read to you",
				"guide.entry.yourVoices.line":
					"Choose a voice for each language and the speed it starts at, or make a voice of your own.",
			},
			hu: {
				"guide.entry.listenToAReply.name":
					"Hallgasd meg a választ vagy a dokumentumot",
				"guide.entry.listenToAReply.line":
					"Nyomd meg a hangszórót a válasz alatt, vagy egy dokumentum vagy jelentés tetején, és kövesd a szavakat, ahogy elhangzanak.",
				"guide.entry.listenToAReply.example":
					"Mesélj egy rövid történetet egy világítótorony-őrről.",
				"guide.entry.yourVoices.name": "Felolvasó hangok",
				"guide.entry.yourVoices.line":
					"Válassz hangot minden nyelvhez és kezdősebességet, vagy készíts saját hangot.",
			},
		} as const;
		for (const lang of LANGUAGES) {
			for (const [key, value] of Object.entries(expected[lang])) {
				expect(words[lang][key], `${lang} ${key}`).toBe(value);
			}
		}
		// A Show me has no example: only Try it has one.
		for (const lang of LANGUAGES) {
			expect(words[lang]["guide.entry.yourVoices.example"]).toBeUndefined();
		}
	});

	it("gives every entry a name and a line, and every Try it an example, in both languages", () => {
		for (const e of GUIDE_ENTRIES) {
			for (const lang of LANGUAGES) {
				expect(words[lang][guideEntryKey(e.id, "name")]).toBeTruthy();
				expect(words[lang][guideEntryKey(e.id, "line")]).toBeTruthy();
				if (e.action.kind === "tryIt") {
					expect(words[lang][guideEntryKey(e.id, "example")]).toBeTruthy();
				}
			}
		}
	});

	it("has the connected-files entry say the same three facts in both languages", () => {
		// The connected accounts are still there for Alfy to read; a file it
		// finds in Nextcloud comes back under the reply, where its picture opens
		// in the app; and every file opens in Nextcloud. The three must hold for
		// every shape the reply draws — one picture, a strip, or documents with
		// no picture at all (a quiet line, no picture) — so the purpose clause
		// is not "pictures you can open" and the line promises no list and no
		// card. Both languages must carry all three, each regex strong enough
		// that dropping a fact fails: the earlier Hungarian regexes were weak
		// enough that a line dropping "amit megnyithatsz" or "minden fájl"
		// still passed. Keywords, not sentences, so a later rewording stays
		// free.
		const facts = [
			{
				fact: "for Alfy to read",
				en: /Alfy to read/i,
				hu: /amit Alfy elolvashat/i,
			},
			{
				fact: "pictures open in the app",
				en: /pictures open in the app/i,
				hu: /a képek az alkalmazásban nyílnak meg/i,
			},
			{
				fact: "every file opens in Nextcloud",
				en: /every file opens in Nextcloud/i,
				hu: /minden fájl a Nextcloudban nyílik meg/i,
			},
		] as const;
		// The parity check: every language names every fact, in the same order,
		// and the filter can only keep a fact its own language's line carries.
		for (const lang of LANGUAGES) {
			const line = words[lang][guideEntryKey("connectedAccounts", "line")];
			expect(
				facts.filter((f) => f[lang].test(line)).map((f) => f.fact),
				`${lang} says`,
			).toEqual(facts.map((f) => f.fact));
		}
	});

	it("gives every section a name and an intro, in both languages", () => {
		expect(guideSectionKey("knowsYou", "name")).toBe(
			"guide.section.knowsYou.name",
		);
		expect(guideEntryKey("askAnything", "line")).toBe(
			"guide.entry.askAnything.line",
		);
		for (const section of GUIDE_SECTION_IDS) {
			for (const lang of LANGUAGES) {
				expect(words[lang][guideSectionKey(section, "name")]).toBeTruthy();
				expect(words[lang][guideSectionKey(section, "intro")]).toBeTruthy();
			}
		}
	});

	it("has the page's own words in both languages, and names the entry in both buttons' accessible names", () => {
		const pageKeys = [
			"guide.title",
			"guide.subtitle",
			"guide.sectionsLabel",
			"guide.tryIt",
			"guide.tryItA11y",
			"guide.showMe",
			"guide.showMeA11y",
			"guide.new",
			"guide.tryItDraftKept",
			"guide.shortcuts.title",
			"guide.shortcuts.search",
			"guide.shortcuts.focus",
			"guide.shortcuts.send",
			"guide.shortcuts.newLine",
			"guide.shortcuts.close",
			"guide.shortcuts.commandsLead",
		];
		for (const lang of LANGUAGES) {
			for (const key of pageKeys) {
				expect(words[lang][key], `${lang} ${key}`).toBeTruthy();
			}
			expect(words[lang]["guide.tryItA11y"]).toContain("{name}");
			expect(words[lang]["guide.showMeA11y"]).toContain("{name}");
		}
	});

	it("points every Show me at a known place and spotlight, each spotlight used once", () => {
		const shows = GUIDE_ENTRIES.flatMap((e) =>
			e.action.kind === "showMe" ? [e.action] : [],
		);
		expect(shows.map((a) => a.spotlight).sort()).toEqual(
			[...SPOTLIGHT_IDS].sort(),
		);
		for (const a of shows) {
			if (a.place) expect(APP_PLACES[a.place]).toBeDefined();
		}
	});

	it("dates only the entries that landed after the guide's baseline", () => {
		expect(
			GUIDE_ENTRIES.filter((e) => e.added !== BEFORE_THE_GUIDE).map(
				(e) => e.id,
			),
		).toEqual([
			"asksFirst",
			"listenToAReply",
			"videos",
			"memory",
			"picturesAndVideos",
			"yourVoices",
			"sendWithEnter",
		]);
	});

	it("marks Memory NEW for the redesign that reached the app on 24 November", () => {
		// The subject page and the Overview: the entry's line already describes
		// both ("grouped by subject", "Earlier", "the overview").
		const memory = GUIDE_ENTRIES.find((e) => e.id === "memory");
		expect(memory?.added).toBe("2026-11-24");
		expect(
			isGuideEntryNew(memory?.added ?? "", new Date("2026-11-24T10:00:00Z")),
		).toBe(true);
		expect(
			isGuideEntryNew(memory?.added ?? "", new Date("2026-12-23T23:59:59Z")),
		).toBe(true);
		expect(
			isGuideEntryNew(memory?.added ?? "", new Date("2026-12-24T00:00:00Z")),
		).toBe(false);
	});

	it("shows NEW for thirty days from the added date", () => {
		expect(GUIDE_NEW_FOR_DAYS).toBe(30);
		expect(
			isGuideEntryNew("2026-11-05", new Date("2026-11-05T00:00:00Z")),
		).toBe(true);
		expect(
			isGuideEntryNew("2026-11-05", new Date("2026-12-04T23:59:59Z")),
		).toBe(true);
		expect(
			isGuideEntryNew("2026-11-05", new Date("2026-12-05T00:00:00Z")),
		).toBe(false);
		expect(
			isGuideEntryNew("2026-11-05", new Date("2026-11-04T23:59:59Z")),
		).toBe(false);
	});
});
