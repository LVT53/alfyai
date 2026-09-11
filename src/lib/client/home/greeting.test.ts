import { describe, expect, it } from "vitest";
import commonDict from "$lib/i18n/common";
import {
	classifyWeek,
	dayKeyFor,
	fitTopic,
	GREETING_CONTEXT_WEIGHT,
	GREETING_GENERIC_WEIGHT,
	GREETING_MAX_LINE_CHARS,
	GREETING_MEMORY_STORAGE_KEY,
	GREETING_POOL,
	GREETING_REFERENCE_NAME_CHARS,
	GREETING_TOPIC_MAX_WORDS,
	type GreetingContext,
	greetingSeedKey,
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
		name: "Admin User",
		userKey: "user-1",
		// A Tuesday afternoon: midweek, no other group matching by accident.
		now: new Date(2026, 8, 8, 14, 30),
		language,
		summaryLoaded: true,
		week: { counts: [], total: 0 },
		running: null,
		topTitle: null,
		connectedKinds: [],
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

	it("interpolates {topic} in exactly the continuity lines", () => {
		for (const variant of GREETING_POOL) {
			for (const language of ["en", "hu"] as const) {
				const dict = commonDict[language] as unknown as Dict;
				const hasTopic = dict[variant.named]?.includes("{topic}");
				expect(hasTopic, `${language}.${variant.named}`).toBe(
					Boolean(variant.topic),
				);
				expect(
					dict[variant.plain]?.includes("{topic}"),
					`${language}.${variant.plain}`,
				).toBe(Boolean(variant.topic));
			}
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
		// stops a new line being added that quietly wraps the heading. The
		// continuity lines are exempt here because their length is decided at
		// runtime by fitTopic, which is held to the same cap below.
		const name = "X".repeat(GREETING_REFERENCE_NAME_CHARS);
		for (const variant of GREETING_POOL) {
			if (variant.topic) continue;
			for (const language of ["en", "hu"] as const) {
				const dict = commonDict[language] as unknown as Dict;
				const rendered = (dict[variant.named] ?? "").replaceAll("{name}", name);
				expect(
					rendered.length,
					`${language}.${variant.named}: "${rendered}"`,
				).toBeLessThanOrEqual(GREETING_MAX_LINE_CHARS);
			}
		}
	});

	it("covers every group the design asks for", () => {
		const groups = new Set(GREETING_POOL.map((variant) => variant.group));
		expect([...groups].sort()).toEqual([
			"busy",
			"connections",
			"continuity",
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
			week: { counts: [20, 20, 20, 22, 1], total: 1 },
			running: { kind: "atlas" },
			topTitle: "Quarterly revenue",
			connectedKinds: ["google", "nextcloud"],
		});
		expect(counts.has("quiet")).toBe(false);
		expect(counts.has("busy")).toBe(false);
		expect(counts.has("continuity")).toBe(false);
		expect(counts.has("running")).toBe(false);
		expect(counts.has("connections")).toBe(false);
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

	it("only offers the Friday line on a Friday", () => {
		// 2026-09-11 is a Friday; 2026-09-08 is a Tuesday.
		const friday = new Set(
			Array.from(
				{ length: 300 },
				(_, index) =>
					pickGreeting(
						contextOf({
							now: new Date(2026, 8, 11, 14),
							userKey: `user-${index}`,
						}),
					).key,
			),
		);
		expect(friday.has("weekday.friday")).toBe(true);

		const tuesday = new Set(
			Array.from(
				{ length: 300 },
				(_, index) => pickGreeting(contextOf({ userKey: `user-${index}` })).key,
			),
		);
		expect(tuesday.has("weekday.friday")).toBe(false);
		expect(tuesday.has("weekday.midweek")).toBe(true);
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

	it("holds the plural connections line back until there are two accounts", () => {
		const one = new Set(
			Array.from(
				{ length: 300 },
				(_, index) =>
					pickGreeting(
						contextOf({ connectedKinds: ["google"], userKey: `user-${index}` }),
					).key,
			),
		);
		expect(one.has("connections.reach")).toBe(true);
		expect(one.has("connections.ready")).toBe(false);

		const two = new Set(
			Array.from(
				{ length: 300 },
				(_, index) =>
					pickGreeting(
						contextOf({
							connectedKinds: ["google", "nextcloud"],
							userKey: `user-${index}`,
						}),
					).key,
			),
		);
		expect(two.has("connections.ready")).toBe(true);
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
				topTitle: "Quarterly revenue",
				connectedKinds: ["google", "nextcloud"],
			},
			2000,
		);
		const generic = counts.get("generic") ?? 0;
		const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
		// Eight generic lines at 1 against eighteen matched lines at 3.
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
// Fitting a topic onto one row
// ---------------------------------------------------------------------------

describe("fitTopic", () => {
	const render = (topic: string) => `Back to ${topic}, Admin User?`;

	it("cuts a long title to six words first", () => {
		const fitted = fitTopic(
			"one two three four five six seven eight",
			(topic) => topic,
			200,
		);
		expect(fitted?.split(" ")).toHaveLength(GREETING_TOPIC_MAX_WORDS);
	});

	it("keeps dropping words until the rendered line fits", () => {
		const fitted = fitTopic("Quarterly revenue reconciliation", render);
		expect(fitted).not.toBeNull();
		expect(render(fitted as string).length).toBeLessThanOrEqual(
			GREETING_MAX_LINE_CHARS,
		);
	});

	it("hard-cuts a single word that will not fit on any boundary", () => {
		const fitted = fitTopic("Donaudampfschifffahrtsgesellschaft", render);
		expect(fitted).toMatch(/…$/);
		expect(render(fitted as string).length).toBeLessThanOrEqual(
			GREETING_MAX_LINE_CHARS,
		);
	});

	it("gives up rather than print a stub when the line leaves no room", () => {
		expect(
			fitTopic(
				"Quarterly revenue",
				(topic) => `Back to ${topic}, Bartholomew Fitzwilliam-Rutherford?`,
			),
		).toBeNull();
	});

	it("treats a blank or whitespace title as no title", () => {
		expect(fitTopic("", render)).toBeNull();
		expect(fitTopic("   \n\t ", render)).toBeNull();
	});

	it("collapses the whitespace inside a title", () => {
		expect(fitTopic("Tax  \n plan", (topic) => topic, 200)).toBe("Tax plan");
	});
});

describe("a topic line never runs past one row at 780px", () => {
	const titles = [
		"Quarterly revenue reconciliation notes for the board meeting",
		"Rewriting the onboarding email sequence end to end",
		"Donaudampfschifffahrtsgesellschaftskapitaen",
		"Taxes",
		"A negyedéves bevételek egyeztetése a vezetőségi ülésre",
		"2026 Q3",
	];

	for (const language of ["en", "hu"] as const) {
		it(`holds the ${GREETING_MAX_LINE_CHARS}-character cap in ${language}`, () => {
			let seen = 0;
			for (const topTitle of titles) {
				for (let index = 0; index < 200; index += 1) {
					const picked = pickGreeting(
						contextOf({ language, topTitle, userKey: `user-${index}` }),
					);
					if (picked.group !== "continuity") continue;
					seen += 1;
					expect(
						picked.named.length,
						`${language} / ${picked.key} / ${topTitle}`,
					).toBeLessThanOrEqual(GREETING_MAX_LINE_CHARS);
					expect(picked.named).not.toContain("{");
					expect(picked.plain).not.toContain("{");
				}
			}
			// The assertion above is only worth anything if continuity lines were
			// actually drawn.
			expect(seen).toBeGreaterThan(0);
		});
	}

	it("drops the continuity group entirely when no topic can be made to fit", () => {
		const keys = new Set(
			Array.from(
				{ length: 300 },
				(_, index) =>
					pickGreeting(
						contextOf({
							name: "Bartholomew Fitzwilliam-Rutherford",
							topTitle: "Quarterly revenue reconciliation",
							userKey: `user-${index}`,
						}),
					).group,
			),
		);
		expect(keys.has("continuity")).toBe(false);
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
					topTitle: "Quarterly revenue",
					running: { kind: "atlas" },
					firstVisitToday: true,
				}),
			);
			expect(picked.named).toContain("Admin User");
			expect(picked.plain).not.toContain("Admin User");
			expect(picked.named).not.toContain("{");
			expect(picked.plain).not.toContain("{");
		}
	});

	it("leaves no placeholder behind when the user has no display name", () => {
		const picked = pickGreeting(
			contextOf({ name: "", topTitle: "Quarterly revenue" }),
		);
		expect(picked.plain).not.toContain("{");
		expect(picked.named).not.toContain("{topic}");
	});
});
