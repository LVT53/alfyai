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

	it("has thirty entries with unique ids, 7/6/4/4/5/4 per section", () => {
		expect(new Set(GUIDE_ENTRIES.map((e) => e.id)).size).toBe(30);
		expect(GUIDE_SECTION_IDS.map((s) => guideEntriesFor(s).length)).toEqual([
			7, 6, 4, 4, 5, 4,
		]);
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

	it("dates only Alfy asks first after the guide's baseline", () => {
		expect(
			GUIDE_ENTRIES.filter((e) => e.added !== BEFORE_THE_GUIDE).map(
				(e) => e.id,
			),
		).toEqual(["asksFirst"]);
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
