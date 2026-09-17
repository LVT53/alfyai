import { describe, expect, it } from "vitest";
import commonDict from "$lib/i18n/common";
import {
	classifyWeek,
	dayKeyFor,
	GREETING_CONTEXT_WEIGHT,
	GREETING_GENERIC_WEIGHT,
	GREETING_MAX_LINE_CHARS,
	GREETING_MEMORY_STORAGE_KEY,
	GREETING_POOL,
	GREETING_REFERENCE_NAME_CHARS,
	GREETING_WEEKDAYS,
	type GreetingContext,
	greetingFirstName,
	greetingSeedKey,
	isBackAfterGap,
	pickGreeting,
	readGreetingMemory,
	resolveGreetingMemory,
	timeOfDayFor,
	writeGreetingMemory,
} from "./greeting";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Dict = Record<string, string>;

/** The real dictionaries, so the tests measure the lines that will ship. */
function translatorFor(language: "en" | "hu") {
	const dict = commonDict[language] as unknown as Dict;
	const fallback = commonDict.en as unknown as Dict;
	return (key: string, params?: Record<string, string>) => {
		let value = dict[key] ?? fallback[key] ?? key;
		for (const [name, replacement] of Object.entries(params ?? {})) {
			value = value.replaceAll(`{${name}}`, replacement);
		}
		return value;
	};
}

function contextOf(overrides: Partial<GreetingContext> = {}): GreetingContext {
	const language = overrides.language ?? "en";
	return {
		// What the page feeds it: the first name, not the display name.
		name: greetingFirstName("Admin User"),
		userKey: "user-1",
		// A Tuesday afternoon: midweek, no other group matching by accident.
		now: new Date(2026, 8, 8, 14, 30),
		language,
		summaryLoaded: true,
		week: { counts: [], total: 0 },
		running: null,
		firstVisitToday: false,
		excludeKey: null,
		translate: translatorFor(language) as GreetingContext["translate"],
		...overrides,
	};
}

/** A memory-backed Storage good enough for the two calls under test. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
	const map = new Map(Object.entries(seed));
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key: string) => map.get(key) ?? null,
		key: (index: number) => [...map.keys()][index] ?? null,
		removeItem: (key: string) => map.delete(key),
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
	} as Storage;
}

const KEYS = GREETING_POOL.map((variant) => variant.key);

// ---------------------------------------------------------------------------
// The pools themselves
// ---------------------------------------------------------------------------

describe("greeting pool", () => {
	it("carries at least twenty-four lines in both languages", () => {
		expect(GREETING_POOL.length).toBeGreaterThanOrEqual(24);
	});

	it("has no duplicate keys", () => {
		expect(new Set(KEYS).size).toBe(KEYS.length);
	});

	it("resolves every named and plain form in en and hu", () => {
		for (const variant of GREETING_POOL) {
			for (const language of ["en", "hu"] as const) {
				const dict = commonDict[language] as unknown as Dict;
				for (const key of [variant.named, variant.plain]) {
					expect(typeof dict[key], `${language}.${key} is missing`).toBe(
						"string",
					);
					expect(dict[key]?.trim(), `${language}.${key} is empty`).not.toBe("");
				}
			}
		}
	});

	it("keeps the two pools at parity — no line exists in one language only", () => {
		const en = Object.keys(commonDict.en)
			.filter((key) => key.startsWith("landing."))
			.sort();
		const hu = Object.keys(commonDict.hu)
			.filter((key) => key.startsWith("landing."))
			.sort();

		expect(hu).toEqual(en);
		// Two forms per variant, and nothing in the dictionary the pool does not
		// use — a stale line is a line nobody will ever read.
		expect(en.length).toBe(GREETING_POOL.length * 2);
	});

	it("says something different in Hungarian, rather than the English line", () => {
		for (const variant of GREETING_POOL) {
			const en = commonDict.en as unknown as Dict;
			const hu = commonDict.hu as unknown as Dict;
			expect(hu[variant.named], `hu.${variant.named}`).not.toBe(
				en[variant.named],
			);
		}
	});

	it("puts {name} in every named form and keeps it out of every plain one", () => {
		for (const variant of GREETING_POOL) {
			for (const language of ["en", "hu"] as const) {
				const dict = commonDict[language] as unknown as Dict;
				expect(dict[variant.named], `${language}.${variant.named}`).toContain(
					"{name}",
				);
				expect(
					dict[variant.plain],
					`${language}.${variant.plain}`,
				).not.toContain("{name}");
			}
		}
	});

	it("interpolates the name and nothing else — never a conversation title", () => {
		// Titles are sentences a model wrote. Cut and pasted into a greeting they
		// came out too long or ungrammatical, so no line may carry {topic} — or
		// any placeholder other than {name}.
		for (const language of ["en", "hu"] as const) {
			const dict = commonDict[language] as unknown as Dict;
			for (const [key, value] of Object.entries(dict)) {
				if (!key.startsWith("landing.")) continue;
				expect(value, `${language}.${key}`).not.toContain("{topic}");
				expect(
					value.replaceAll("{name}", "").includes("{"),
					`${language}.${key} has a placeholder other than {name}`,
				).toBe(false);
			}
		}
	});

	it("says nothing about the user's accounts, or about reaching into them", () => {
		// "I can reach your accounts" read as ominous, and every rewording of it
		// does too. The greeting does not mention connections at all.
		const banned = {
			en: /account|reach|access|connect|link/i,
			hu: /fiók|elér|hozzáfér|csatlakoz|kapcsol/i,
		};
		for (const language of ["en", "hu"] as const) {
			const dict = commonDict[language] as unknown as Dict;
			for (const [key, value] of Object.entries(dict)) {
				if (!key.startsWith("landing.")) continue;
				expect(value, `${language}.${key}`).not.toMatch(banned[language]);
			}
		}
		for (const variant of GREETING_POOL) {
			expect(variant.key).not.toMatch(/^(connections|continuity)\./);
		}
	});

	it("keeps the app's voice: no exclamation marks and no emoji", () => {
		const emoji = /\p{Extended_Pictographic}/u;
		for (const language of ["en", "hu"] as const) {
			const dict = commonDict[language] as unknown as Dict;
			for (const [key, value] of Object.entries(dict)) {
				if (!key.startsWith("landing.")) continue;
				expect(value, `${language}.${key}`).not.toContain("!");
				expect(emoji.test(value), `${language}.${key} has emoji`).toBe(false);
			}
		}
	});

	it("authors every line short enough for one row at 780px", () => {
		// The cap is measured (see GREETING_MAX_LINE_CHARS), and this is what
		// stops a new line being added that quietly wraps the heading. The name
		// is the only thing a line interpolates, so the authored length with a
		// typical name in it IS the rendered length.
		expect(GREETING_REFERENCE_NAME_CHARS).toBe(12);
		const name = "X".repeat(GREETING_REFERENCE_NAME_CHARS);
		for (const variant of GREETING_POOL) {
			for (const language of ["en", "hu"] as const) {
				const dict = commonDict[language] as unknown as Dict;
				const rendered = (dict[variant.named] ?? "").replaceAll("{name}", name);
				expect(
					rendered.length,
					`${language}.${variant.named}: "${rendered}"`,
				).toBeLessThanOrEqual(GREETING_MAX_LINE_CHARS);
				// The nameless form is the named one minus the name, so it is
				// shorter — but it is a separately authored string, so say so.
				expect(
					(dict[variant.plain] ?? "").length,
					`${language}.${variant.plain}`,
				).toBeLessThan(rendered.length);
			}
		}
	});

	it("keeps the pool between thirty-six and forty lines", () => {
		expect(GREETING_POOL.length).toBeGreaterThanOrEqual(36);
		expect(GREETING_POOL.length).toBeLessThanOrEqual(40);
	});

	it("covers every group the design asks for", () => {
		const groups = new Set(GREETING_POOL.map((variant) => variant.group));
		expect([...groups].sort()).toEqual([
			"back",
			"busy",
			"firstVisit",
			"generic",
			"quiet",
			"running",
			"time",
			"weekday",
		]);
	});
});

// ---------------------------------------------------------------------------
// Reading the context
// ---------------------------------------------------------------------------

describe("greetingFirstName", () => {
	it("calls the user by their first name, never their full display name", () => {
		expect(greetingFirstName("Admin User")).toBe("Admin");
		expect(greetingFirstName("Ada Lovelace")).toBe("Ada");
		expect(greetingFirstName("  Levente   Alf  ")).toBe("Levente");
		expect(greetingFirstName("Kovács Anna Mária")).toBe("Kovács");
	});

	it("keeps a one-word name whole", () => {
		expect(greetingFirstName("Anna")).toBe("Anna");
	});

	it("drops the trailing punctuation of a directory-style name", () => {
		// "Good morning, Lovelace,." is the alternative.
		expect(greetingFirstName("Lovelace, Ada")).toBe("Lovelace");
	});

	it("falls back to the nameless form when there is no name to use", () => {
		expect(greetingFirstName("")).toBe("");
		expect(greetingFirstName("   ")).toBe("");
		expect(greetingFirstName(null)).toBe("");
		expect(greetingFirstName(undefined)).toBe("");
		// Punctuation alone is not a name.
		expect(greetingFirstName(".")).toBe("");
	});

	it("never greets an email address", () => {
		// Accounts seeded from an address are the common case, not a curiosity.
		expect(greetingFirstName("ada@example.com")).toBe("");
		expect(greetingFirstName("levente.alf@icloud.com")).toBe("");
		expect(greetingFirstName("Ada Lovelace <ada@example.com>")).toBe("");
	});

	it("drops a first name too long for the line it would sit in", () => {
		const twelve = "Bartholomeus"; // exactly at the cap
		expect(twelve.length).toBe(GREETING_REFERENCE_NAME_CHARS);
		expect(greetingFirstName(twelve)).toBe(twelve);
		expect(greetingFirstName(`${twelve}x`)).toBe("");
		expect(greetingFirstName("Nebuchadnezzar Smith")).toBe("");
	});

	it("never yields a name that overflows the authored line", () => {
		// The contract the 38-char cap rests on: whatever this returns, every
		// named line in either language still fits one row.
		const names = [
			"Admin User",
			"Bartholomeus",
			"Zsuzsanna Kiss",
			"ada@example.com",
			"",
		];
		for (const displayName of names) {
			const name = greetingFirstName(displayName);
			expect(name.length).toBeLessThanOrEqual(GREETING_REFERENCE_NAME_CHARS);
			for (const variant of GREETING_POOL) {
				for (const language of ["en", "hu"] as const) {
					const dict = commonDict[language] as unknown as Dict;
					const line = (dict[variant.named] ?? "").replaceAll("{name}", name);
					expect(
						line.length,
						`${language}.${variant.named}`,
					).toBeLessThanOrEqual(GREETING_MAX_LINE_CHARS);
				}
			}
		}
	});
});

describe("time of day", () => {
	it("splits the clock into the four named parts", () => {
		expect(timeOfDayFor(5)).toBe("morning");
		expect(timeOfDayFor(11)).toBe("morning");
		expect(timeOfDayFor(12)).toBe("afternoon");
		expect(timeOfDayFor(17)).toBe("afternoon");
		expect(timeOfDayFor(18)).toBe("evening");
		expect(timeOfDayFor(22)).toBe("evening");
		expect(timeOfDayFor(23)).toBe("night");
		expect(timeOfDayFor(0)).toBe("night");
		expect(timeOfDayFor(4)).toBe("night");
	});
});

describe("classifyWeek", () => {
	it("calls a week with no history steady, not quiet", () => {
		// A brand-new account draws no bars at all. Telling someone their first
		// week has been quiet is not an observation about them.
		expect(classifyWeek({ counts: [], total: 0 })).toBe("steady");
	});

	it("uses the absolutes when there is no baseline to compare against", () => {
		expect(classifyWeek({ counts: [0, 2], total: 2 })).toBe("quiet");
		expect(classifyWeek({ counts: [4, 30], total: 30 })).toBe("busy");
		expect(classifyWeek({ counts: [4, 7], total: 7 })).toBe("steady");
	});

	it("judges a middling week against the user's own median", () => {
		// Median of 20, 20, 20, 22 is 20: eight messages is half of it or less.
		expect(classifyWeek({ counts: [20, 20, 20, 22, 8], total: 8 })).toBe(
			"quiet",
		);
		// The same eight, for someone whose normal week is five, is busy.
		expect(classifyWeek({ counts: [5, 5, 4, 5, 8], total: 8 })).toBe("busy");
		// And a week that looks like the others is neither.
		expect(classifyWeek({ counts: [8, 9, 7, 8, 8], total: 8 })).toBe("steady");
	});
});

describe("isBackAfterGap", () => {
	it("reads an empty last week, after some life, as a return", () => {
		expect(isBackAfterGap({ counts: [6, 4, 0, 1], total: 1 })).toBe(true);
		expect(isBackAfterGap({ counts: [6, 0, 0, 0], total: 0 })).toBe(true);
	});

	it("does not welcome back an account that was never here", () => {
		expect(isBackAfterGap({ counts: [], total: 0 })).toBe(false);
		expect(isBackAfterGap({ counts: [0, 0, 0, 2], total: 2 })).toBe(false);
		// The shape a brand-new account actually has: /api/home/summary always
		// draws twelve buckets, so "no history" arrives as twelve zeroes rather
		// than as an empty array, and the empty-array case above would miss it.
		const fresh = new Array<number>(12).fill(0);
		expect(isBackAfterGap({ counts: fresh, total: 0 })).toBe(false);
		expect(isBackAfterGap({ counts: [...fresh.slice(1), 1], total: 1 })).toBe(
			false,
		);
	});

	it("keeps 'welcome back' out of a brand-new account's pool entirely", () => {
		// End to end rather than on the predicate: a new account must never be
		// welcomed back to somewhere it has never been.
		const fresh = { counts: new Array<number>(12).fill(0), total: 0 };
		for (let index = 0; index < 400; index += 1) {
			const picked = pickGreeting(
				contextOf({ week: fresh, userKey: `user-${index}` }),
			);
			expect(picked.group).not.toBe("back");
		}
	});

	it("needs the LAST week to have been empty, not just some week", () => {
		expect(isBackAfterGap({ counts: [6, 0, 5, 1], total: 1 })).toBe(false);
	});

	it("stops once this week is plainly under way", () => {
		expect(isBackAfterGap({ counts: [6, 4, 0, 9], total: 9 })).toBe(false);
	});

	it("needs enough history for 'last week' to mean something", () => {
		expect(isBackAfterGap({ counts: [0, 1], total: 1 })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("pickGreeting determinism", () => {
	it("returns the same line for the same user, day and slot", () => {
		const context = contextOf();
		const first = pickGreeting(context);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			expect(pickGreeting(contextOf())).toEqual(first);
		}
		// And it does not depend on the minute inside the slot.
		expect(
			pickGreeting(contextOf({ now: new Date(2026, 8, 8, 17, 59) })).key,
		).toBe(first.key);
	});

	it("keys on the user, so two people do not get the same line", () => {
		const keys = new Set(
			["u1", "u2", "u3", "u4", "u5", "u6"].map(
				(userKey) => pickGreeting(contextOf({ userKey })).key,
			),
		);
		expect(keys.size).toBeGreaterThan(1);
	});

	it("names the user, day, slot and language in the seed", () => {
		expect(greetingSeedKey(contextOf())).toBe("user-1|2026-09-08|afternoon|en");
	});

	it("moves across the day and across days", () => {
		const slots = [8, 14, 20, 1].map(
			(hour) =>
				pickGreeting(contextOf({ now: new Date(2026, 8, 8, hour) })).key,
		);
		expect(new Set(slots).size).toBeGreaterThan(1);

		const days = [8, 9, 10, 11, 12].map(
			(day) => pickGreeting(contextOf({ now: new Date(2026, 8, day, 14) })).key,
		);
		expect(new Set(days).size).toBeGreaterThan(1);
	});

	it("formats the day key in the local calendar, not UTC", () => {
		expect(dayKeyFor(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
	});
});

// ---------------------------------------------------------------------------
// Weighting and context matching
// ---------------------------------------------------------------------------

/**
 * Sweeps the seed space by varying the user key, which is the only seed
 * component a test can move without also moving what matches.
 */
function sampleGroups(overrides: Partial<GreetingContext>, samples = 600) {
	const counts = new Map<string, number>();
	for (let index = 0; index < samples; index += 1) {
		const picked = pickGreeting(
			contextOf({ ...overrides, userKey: `user-${index}` }),
		);
		counts.set(picked.group, (counts.get(picked.group) ?? 0) + 1);
	}
	return counts;
}

describe("context matching", () => {
	it("offers nothing beyond the clock and the calendar on an ordinary day", () => {
		// A Tuesday afternoon with an empty summary: the clock knows it is the
		// afternoon and the calendar knows it is midweek, and that is the whole
		// of what the greeting is entitled to say.
		const counts = sampleGroups({});
		expect([...counts.keys()].sort()).toEqual(["generic", "time", "weekday"]);
	});

	it("never offers a summary-fed line before the summary lands", () => {
		const counts = sampleGroups({
			summaryLoaded: false,
			week: { counts: [20, 20, 20, 0, 1], total: 1 },
			running: { kind: "atlas" },
		});
		expect(counts.has("quiet")).toBe(false);
		expect(counts.has("busy")).toBe(false);
		expect(counts.has("back")).toBe(false);
		expect(counts.has("running")).toBe(false);
		// The clock and the calendar are still fair game — they are the
		// browser's own, not the endpoint's.
		expect([...counts.keys()].sort()).toEqual(["generic", "time", "weekday"]);
	});

	it("offers the morning lines in the morning and never at night", () => {
		const morning = sampleGroups({ now: new Date(2026, 8, 8, 8) });
		expect(morning.get("time") ?? 0).toBeGreaterThan(0);

		for (const [index] of Array.from({ length: 200 }).entries()) {
			const picked = pickGreeting(
				contextOf({ now: new Date(2026, 8, 8, 8), userKey: `user-${index}` }),
			);
			expect(picked.key).not.toMatch(/^time\.(evening|lateOne|stillUp)/);
		}
	});

	it("only offers a weekday line on its own weekday", () => {
		// 2026-09-06 is a Sunday, so day-of-month 6 + n is weekday n.
		const seenOn = new Map<string, Set<number>>();
		for (let weekday = 0; weekday < 7; weekday += 1) {
			const now = new Date(2026, 8, 6 + weekday, 14);
			expect(now.getDay()).toBe(weekday);
			for (let index = 0; index < 400; index += 1) {
				const picked = pickGreeting(
					contextOf({ now, userKey: `user-${index}` }),
				);
				if (picked.group !== "weekday") continue;
				const days = seenOn.get(picked.key) ?? new Set<number>();
				days.add(weekday);
				seenOn.set(picked.key, days);
			}
		}

		// Every weekday line in the pool is in the table, was actually drawn,
		// and was drawn on exactly the days the table allows — "Friday already"
		// on Fridays only, the Monday lines on Mondays only, and so on.
		const weekdayKeys = GREETING_POOL.filter(
			(variant) => variant.group === "weekday",
		).map((variant) => variant.key);
		expect(weekdayKeys.sort()).toEqual(Object.keys(GREETING_WEEKDAYS).sort());
		for (const key of weekdayKeys) {
			expect([...(seenOn.get(key) ?? [])].sort(), key).toEqual(
				[...GREETING_WEEKDAYS[key]].sort(),
			);
		}
		expect(GREETING_WEEKDAYS["weekday.fridayAlready"]).toEqual([5]);
		expect(GREETING_WEEKDAYS["weekday.monday"]).toEqual([1]);
		expect(GREETING_WEEKDAYS["weekday.weekend"]).toEqual([0, 6]);
	});

	it("turns the weekday over at the user's own midnight, not UTC's", () => {
		// The gate reads context.now.getDay(), and context.now is the browser's
		// clock. 2026-09-06 is a Sunday: a minute before local midnight the pool
		// still holds Sunday's lines and none of Monday's, and a minute after it
		// holds Monday's and none of Sunday's. Under a UTC reading this would
		// flip at the wrong moment for every user west or east of Greenwich.
		const keysAt = (now: Date) =>
			new Set(
				Array.from(
					{ length: 400 },
					(_, index) =>
						pickGreeting(contextOf({ now, userKey: `user-${index}` })).key,
				),
			);

		const lateSunday = new Date(2026, 8, 6, 23, 59);
		expect(lateSunday.getDay()).toBe(0);
		const sunday = keysAt(lateSunday);
		expect(sunday.has("weekday.sunday")).toBe(true);
		expect(sunday.has("weekday.weekend")).toBe(true);
		expect(sunday.has("weekday.monday")).toBe(false);
		expect(sunday.has("weekday.newWeek")).toBe(false);

		const earlyMonday = new Date(2026, 8, 7, 0, 1);
		expect(earlyMonday.getDay()).toBe(1);
		const monday = keysAt(earlyMonday);
		expect(monday.has("weekday.monday")).toBe(true);
		expect(monday.has("weekday.newWeek")).toBe(true);
		expect(monday.has("weekday.sunday")).toBe(false);
		expect(monday.has("weekday.weekend")).toBe(false);

		// Both instants are the same "night" slot, so the day key is what moved.
		expect(greetingSeedKey(contextOf({ now: lateSunday }))).toBe(
			"user-1|2026-09-06|night|en",
		);
		expect(greetingSeedKey(contextOf({ now: earlyMonday }))).toBe(
			"user-1|2026-09-07|night|en",
		);
	});

	it("names the right day in the line itself", () => {
		const dayWords: Record<number, { en: RegExp; hu: RegExp }> = {
			0: { en: /Sunday|Weekend/, hu: /Vasárnap|Hétvége/ },
			1: { en: /Monday|New week/, hu: /Hétfő|Új hét/ },
			3: { en: /Wednesday|Midweek/, hu: /Szerda|Hét közepe/ },
			4: { en: /Thursday|Midweek/, hu: /Csütörtök|Hét közepe/ },
			5: { en: /Friday/, hu: /[Pp]éntek/ },
			6: { en: /Saturday|Weekend/, hu: /Szombat|Hétvége/ },
		};
		for (const [key, days] of Object.entries(GREETING_WEEKDAYS)) {
			for (const language of ["en", "hu"] as const) {
				const dict = commonDict[language] as unknown as Dict;
				const line = dict[`landing.${key}.plain`] ?? "";
				for (const day of days) {
					const words = dayWords[day];
					if (!words) continue; // Tuesday only ever gets "Midweek".
					expect(line, `${language}.${key} on day ${day}`).toMatch(
						words[language],
					);
				}
			}
		}
	});

	it("only calls the week's start slow while the week is still starting", () => {
		const quietWeek = { counts: [20, 20, 20, 22, 1], total: 1 };
		const keysOn = (day: number) =>
			new Set(
				Array.from(
					{ length: 400 },
					(_, index) =>
						pickGreeting(
							contextOf({
								now: new Date(2026, 8, day, 14),
								week: quietWeek,
								userKey: `user-${index}`,
							}),
						).key,
				),
			);
		// 2026-09-08 is a Tuesday, 2026-09-11 a Friday.
		expect(keysOn(8).has("quiet.slowStart")).toBe(true);
		expect(keysOn(11).has("quiet.slowStart")).toBe(false);
		expect(keysOn(11).has("quiet.soFar")).toBe(true);
	});

	it("welcomes the user back only after an empty week", () => {
		const keysFor = (week: { counts: number[]; total: number }) =>
			new Set(
				Array.from(
					{ length: 400 },
					(_, index) =>
						pickGreeting(contextOf({ week, userKey: `user-${index}` })).key,
				),
			);
		const back = keysFor({ counts: [6, 4, 0, 1], total: 1 });
		expect(back.has("back.welcome")).toBe(true);
		expect(back.has("back.beenAWhile")).toBe(true);

		const merelyQuiet = keysFor({ counts: [6, 4, 5, 1], total: 1 });
		expect(merelyQuiet.has("back.welcome")).toBe(false);
		expect(merelyQuiet.has("back.beenAWhile")).toBe(false);
	});

	it("matches the running job to its kind", () => {
		const atlas = new Set(
			Array.from(
				{ length: 300 },
				(_, index) =>
					pickGreeting(
						contextOf({ running: { kind: "atlas" }, userKey: `user-${index}` }),
					).key,
			),
		);
		expect(atlas.has("running.report")).toBe(true);
		expect(atlas.has("running.file")).toBe(false);

		const file = new Set(
			Array.from(
				{ length: 300 },
				(_, index) =>
					pickGreeting(
						contextOf({ running: { kind: "file" }, userKey: `user-${index}` }),
					).key,
			),
		);
		expect(file.has("running.file")).toBe(true);
		expect(file.has("running.report")).toBe(false);
	});
});

describe("weighting", () => {
	it("gives a matched line three times a generic line's share", () => {
		// Tuesday 14:30, first visit of the day: eight generic lines at 1, one
		// "midweek" and three first-visit lines at 3 — 8 against 12.
		const counts = sampleGroups({ firstVisitToday: true }, 4000);
		const generic = counts.get("generic") ?? 0;
		const context =
			(counts.get("weekday") ?? 0) + (counts.get("firstVisit") ?? 0);
		const expected =
			(4 * GREETING_CONTEXT_WEIGHT) / (8 * GREETING_GENERIC_WEIGHT);

		expect(context / generic).toBeGreaterThan(expected * 0.85);
		expect(context / generic).toBeLessThan(expected * 1.15);
	});

	it("leans the greeting towards context on a day full of it", () => {
		const counts = sampleGroups(
			{
				now: new Date(2026, 8, 11, 20), // Friday evening
				firstVisitToday: true,
				week: { counts: [4, 5, 4, 5, 30], total: 30 },
				running: { kind: "atlas" },
			},
			2000,
		);
		const generic = counts.get("generic") ?? 0;
		const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
		// Eight generic lines at 1 against twelve matched lines at 3: two for
		// the evening, two for Friday, three for the busy week, two for the
		// report and three for the first visit.
		expect(generic / total).toBeLessThan(0.2);
	});
});

// ---------------------------------------------------------------------------
// Not repeating yesterday
// ---------------------------------------------------------------------------

describe("the previous day's line", () => {
	it("is excluded from today's pool", () => {
		const today = pickGreeting(contextOf());
		const next = pickGreeting(contextOf({ excludeKey: today.key }));
		expect(next.key).not.toBe(today.key);
	});

	it("is never excluded within the same day — the remembered key IS today's", () => {
		const today = dayKeyFor(new Date(2026, 8, 8, 14, 30));
		expect(
			resolveGreetingMemory(
				{ day: today, firstSlot: "afternoon", key: "generic.ask" },
				today,
				"afternoon",
			),
		).toEqual({
			firstVisitToday: true,
			excludeKey: null,
			firstSlot: "afternoon",
		});
	});

	it("reads as the first visit, with yesterday's line to avoid, on a new day", () => {
		expect(
			resolveGreetingMemory(
				{ day: "2026-09-07", firstSlot: "evening", key: "generic.ask" },
				"2026-09-08",
				"morning",
			),
		).toEqual({
			firstVisitToday: true,
			excludeKey: "generic.ask",
			firstSlot: "morning",
		});
	});

	it("reads an absent memory as a first visit with nothing to avoid", () => {
		expect(resolveGreetingMemory(null, "2026-09-08", "night")).toEqual({
			firstVisitToday: true,
			excludeKey: null,
			firstSlot: "night",
		});
	});

	it("holds 'first today' for the whole slot it was first shown in", () => {
		// The point of pinning it to the slot rather than the load: a reload ten
		// minutes later must not swap the line out from under the reader.
		const memory = {
			day: "2026-09-08",
			firstSlot: "morning",
			key: "firstVisit.plan",
		} as const;
		expect(
			resolveGreetingMemory(memory, "2026-09-08", "morning").firstVisitToday,
		).toBe(true);
		// By the afternoon it is no longer the first of the day, and the seed has
		// moved on anyway.
		expect(
			resolveGreetingMemory(memory, "2026-09-08", "afternoon").firstVisitToday,
		).toBe(false);
		// And the day's first slot is carried forward, not overwritten with the
		// current one — otherwise the evening would claim first visit too.
		expect(resolveGreetingMemory(memory, "2026-09-08", "evening")).toEqual({
			firstVisitToday: false,
			excludeKey: null,
			firstSlot: "morning",
		});
	});

	it("keeps the line stable across a same-day reload", () => {
		// The whole loop: pick, persist, read back, pick again.
		const storage = fakeStorage();
		const now = new Date(2026, 8, 8, 9, 15);
		const today = dayKeyFor(now);

		const load = () => {
			const resolved = resolveGreetingMemory(
				readGreetingMemory(storage),
				today,
				timeOfDayFor(now.getHours()),
			);
			const picked = pickGreeting(
				contextOf({
					now,
					firstVisitToday: resolved.firstVisitToday,
					excludeKey: resolved.excludeKey,
				}),
			);
			writeGreetingMemory(
				{ day: today, firstSlot: resolved.firstSlot, key: picked.key },
				storage,
			);
			return picked.key;
		};

		const first = load();
		expect(load()).toBe(first);
		expect(load()).toBe(first);
	});

	it("round-trips through storage", () => {
		const storage = fakeStorage();
		writeGreetingMemory(
			{ day: "2026-09-08", firstSlot: "afternoon", key: "time.midday" },
			storage,
		);
		expect(readGreetingMemory(storage)).toEqual({
			day: "2026-09-08",
			firstSlot: "afternoon",
			key: "time.midday",
		});
		expect(storage.getItem(GREETING_MEMORY_STORAGE_KEY)).toBeTruthy();
	});

	it("survives storage that is absent, throwing, or holding nonsense", () => {
		expect(readGreetingMemory(null)).toBeNull();
		expect(readGreetingMemory(fakeStorage())).toBeNull();
		expect(
			readGreetingMemory(fakeStorage({ [GREETING_MEMORY_STORAGE_KEY]: "{{" })),
		).toBeNull();
		expect(
			readGreetingMemory(
				fakeStorage({ [GREETING_MEMORY_STORAGE_KEY]: '{"day":1}' }),
			),
		).toBeNull();
		// A memory written by an older build, before the slot was recorded.
		expect(
			readGreetingMemory(
				fakeStorage({
					[GREETING_MEMORY_STORAGE_KEY]: '{"day":"2026-09-08","key":"x"}',
				}),
			),
		).toBeNull();

		const hostile = {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		} as unknown as Storage;
		expect(readGreetingMemory(hostile)).toBeNull();
		expect(() =>
			writeGreetingMemory({ day: "d", firstSlot: "night", key: "k" }, hostile),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("the rendered line", () => {
	it("carries the name in the named form and not in the plain one", () => {
		for (let index = 0; index < 200; index += 1) {
			const picked = pickGreeting(
				contextOf({
					userKey: `user-${index}`,
					running: { kind: "atlas" },
					firstVisitToday: true,
				}),
			);
			expect(picked.named).toContain("Admin");
			// The first name and nothing more: the surname never reaches a line.
			expect(picked.named).not.toContain("Admin User");
			expect(picked.plain).not.toContain("Admin");
			expect(picked.named).not.toContain("{");
			expect(picked.plain).not.toContain("{");
		}
	});

	it("leaves no placeholder behind when the user has no display name", () => {
		for (let index = 0; index < 200; index += 1) {
			const picked = pickGreeting(
				contextOf({
					name: "",
					userKey: `user-${index}`,
					firstVisitToday: true,
					running: { kind: "file" },
				}),
			);
			expect(picked.plain).not.toContain("{");
			expect(picked.plain.trim()).not.toBe("");
		}
	});
});
