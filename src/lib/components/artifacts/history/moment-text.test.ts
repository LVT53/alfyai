import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import { at, makeMoment, makeStep } from "./__fixtures__/moments";
import {
	clockTime,
	dayLabel,
	entryA11yName,
	entryDetail,
	entryHeadline,
	entryTimeLabel,
	latestMomentPhrase,
	momentPhraseKey,
	statusLabel,
	type TextContext,
	whenLabel,
} from "./moment-text";
import { momentEntry, stepEntry } from "./rail-model";

const now = new Date("2026-10-11T12:00:00Z").getTime();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
});

afterEach(() => {
	vi.useRealTimers();
	uiLanguage.set("en");
});

describe("momentPhraseKey (the header's short headline of the latest moment)", () => {
	it("names who did what, from the author and the kind", () => {
		const cases: Array<[Parameters<typeof momentPhraseKey>, string]> = [
			[["document", "user", "user_edit"], "youEdited"],
			[["document", "user", "tick"], "youEdited"],
			[["document", "alfy", "alfy_edit"], "alfyChanged"],
			[["document", "alfy", "alfy_reply_edit"], "alfyChanged"],
			[["document", "alfy", "alfy_turn"], "alfyChanged"],
			[["document", "alfy", "first_draft"], "alfyWrote"],
			[["document", "user", "kept_from_chat"], "alfyWrote"],
			[["document", "alfy", "made_again"], "alfyWrote"],
			[["canvas", "alfy", "first_draft"], "alfyBuilt"],
			[["canvas", "alfy", "made_again"], "alfyBuilt"],
			[["app", "alfy", "app_made"], "alfyBuilt"],
			[["app", "alfy", "app_rebuilt"], "alfyRebuilt"],
			[["document", "user", "restore"], "youRestored"],
			[["document", "user", "undo_alfy_change"], "youUndid"],
			[["document", "user", "redo_alfy_change"], "youBroughtBack"],
			[["document", "user", "saved_as_copy"], "youEdited"],
			[["document", "user", "undo_restore"], "youEdited"],
		];
		for (const [args, expected] of cases) {
			expect(momentPhraseKey(...args), JSON.stringify(args)).toBe(
				`artifacts.history.phrase.${expected}`,
			);
		}
	});

	it("falls back on the author when the kind is not known yet (an item freshly opened from an older server), and on plain 'edited' when neither is", () => {
		expect(momentPhraseKey("document", "alfy", null)).toBe(
			"artifacts.history.phrase.alfyChanged",
		);
		expect(momentPhraseKey("document", "user", null)).toBe(
			"artifacts.history.phrase.youEdited",
		);
		expect(momentPhraseKey("document", null, null)).toBe(
			"artifacts.history.phrase.edited",
		);
	});
});

describe("latestMomentPhrase", () => {
	it("is the headline and the time the surfaces share, with an accessible name that is one sentence", () => {
		const phrase = latestMomentPhrase(
			"document",
			{ author: "alfy", kind: "alfy_edit", at: now - 12 * 60_000 },
			get(t),
		);
		expect(phrase).toEqual({
			headline: "Changed by Alfy",
			when: "12 min ago",
			text: "Changed by Alfy · 12 min ago",
			a11y: "History. Last change: changed by Alfy 12 min ago",
		});
	});

	it("speaks Hungarian in the second person, with the Hungarian time", () => {
		uiLanguage.set("hu");
		const phrase = latestMomentPhrase(
			"document",
			{ author: "user", kind: "restore", at: now - 5 * 60_000 },
			get(t),
		);
		expect(phrase).toEqual({
			headline: "Visszaállítottad",
			when: "5 perce",
			text: "Visszaállítottad · 5 perce",
			a11y: "Előzmények. Utolsó változás: visszaállítottad 5 perce",
		});
	});

	it("says just the headline when nothing says when", () => {
		expect(
			latestMomentPhrase(
				"app",
				{ author: "alfy", kind: "app_made", at: null },
				get(t),
			)?.text,
		).toBe("Built by Alfy");
	});

	it("is null when there is no moment at all (nothing has been heard about the item)", () => {
		expect(latestMomentPhrase("document", null, get(t))).toBeNull();
	});
});

// ---- the rail's words (versioning.md §3.2, §5.3, §8) ------------------------

// Sunday 11 October 2026, 12:00 local: "today" is the 11th, "yesterday" the 10th.
const NOW = at(2026, 10, 11, 12, 0);

function ctx(lang: "en" | "hu" = "en"): TextContext {
	uiLanguage.set(lang);
	return { t: get(t), lang, now: NOW };
}

describe("entryHeadline: who did what, in the reader's language", () => {
	const entry = (overrides: Parameters<typeof makeMoment>[0]) =>
		momentEntry(makeMoment(overrides));

	it("tells each kind in English", () => {
		const c = ctx();
		const cases: Array<[Parameters<typeof makeMoment>[0], string]> = [
			[
				{ versionNumber: 1, kind: "first_draft", author: "alfy" },
				"Alfy wrote the first draft",
			],
			[
				{
					versionNumber: 1,
					kind: "app_made",
					author: "alfy",
					text: "A tip calculator",
				},
				"Alfy built the app",
			],
			[
				{ versionNumber: 1, kind: "kept_from_chat" },
				"You kept Alfy's reply as a document",
			],
			[
				{ versionNumber: 1, kind: "saved_as_copy" },
				"You saved it as a new document",
			],
			[
				{ versionNumber: 2, kind: "made_again", author: "alfy" },
				"Alfy made it again",
			],
			[{ versionNumber: 2, kind: "user_edit" }, "You edited"],
			[
				{
					versionNumber: 2,
					kind: "tick",
					tick: { text: "Renew passport", checked: true },
				},
				"You ticked “Renew passport”",
			],
			[
				{
					versionNumber: 2,
					kind: "tick",
					tick: { text: "Renew passport", checked: false },
				},
				"You unticked “Renew passport”",
			],
			[
				{
					versionNumber: 3,
					kind: "alfy_edit",
					author: "alfy",
					text: "Moved the museum to Thursday",
				},
				"Alfy: Moved the museum to Thursday",
			],
			[
				{ versionNumber: 3, kind: "alfy_edit", author: "alfy", text: null },
				"Alfy changed it",
			],
			[
				{ versionNumber: 3, kind: "alfy_reply_edit", author: "alfy" },
				"Alfy changed it, answering your comment",
			],
			[
				{
					versionNumber: 3,
					kind: "app_rebuilt",
					author: "alfy",
					text: "make it blue",
				},
				"Alfy rebuilt the app: “make it blue”",
			],
			[{ versionNumber: 5, kind: "redo_alfy_change" }, "You brought it back"],
			[{ versionNumber: 6, kind: "undo_restore" }, "You undid the restore"],
		];
		for (const [overrides, expected] of cases) {
			expect(entryHeadline(entry(overrides), c), expected).toBe(expected);
		}
	});

	it("a board's first version and edits say board, not text", () => {
		const c = ctx();
		expect(
			entryHeadline(
				entry({ versionNumber: 1, kind: "first_draft", author: "alfy" }),
				c,
				"canvas",
			),
		).toBe("Alfy made the board");
		expect(
			entryHeadline(
				entry({ versionNumber: 2, kind: "user_edit" }),
				c,
				"canvas",
			),
		).toBe("You changed the board");
	});

	it("an Undo says which change when it is not folded onto it, and is short when it is", () => {
		const c = ctx();
		const loose = entry({
			versionNumber: 6,
			kind: "undo_alfy_change",
			target: {
				versionId: "v4",
				versionNumber: 4,
				at: NOW,
				text: "Rainy-day plan",
			},
		});
		expect(entryHeadline(loose, c)).toBe(
			"You undid Alfy's change “Rainy-day plan”",
		);
		expect(
			entryHeadline(
				entry({ versionNumber: 6, kind: "undo_alfy_change", target: null }),
				c,
			),
		).toBe("You undid Alfy's change");
		const folded = stepEntry(
			makeMoment({ versionNumber: 4, fold: "undone" }),
			makeStep({ versionNumber: 5, kind: "undo_alfy_change" }),
		);
		expect(entryHeadline(folded, c)).toBe("You undid it");
	});

	it("a restore names the version it brought back by day and time, or by its name", () => {
		const c = ctx();
		const restore = (
			restoredFrom: ReturnType<typeof makeMoment>["restoredFrom"],
			label?: string,
		) =>
			entry({
				versionNumber: 7,
				kind: "restore",
				restoredFrom,
				...(label ? { label } : {}),
			});
		expect(
			entryHeadline(
				restore({
					versionId: "v2",
					versionNumber: 2,
					at: at(2026, 10, 10, 10, 9),
				}),
				c,
			),
		).toBe("You restored yesterday 10:09");
		expect(entryHeadline(restore(null), c)).toBe(
			"You restored an earlier version",
		);
	});

	it("one turn of Alfy's edits counts them", () => {
		const turn = entry({
			versionNumber: 9,
			kind: "alfy_turn",
			author: "alfy",
			fold: "alfy_turn",
			steps: [
				makeStep({ versionNumber: 7, kind: "alfy_edit", author: "alfy" }),
				makeStep({ versionNumber: 8, kind: "alfy_edit", author: "alfy" }),
				makeStep({ versionNumber: 9, kind: "alfy_edit", author: "alfy" }),
			],
		});
		expect(entryHeadline(turn, ctx())).toBe("Alfy made 3 changes");
	});

	it("is Hungarian, second person informal, with no English left in it (T8)", () => {
		const c = ctx("hu");
		expect(
			entryHeadline(
				entry({ versionNumber: 1, kind: "first_draft", author: "alfy" }),
				c,
			),
		).toBe("Alfy megírta az első vázlatot");
		expect(entryHeadline(entry({ versionNumber: 2 }), c)).toBe(
			"Szerkesztetted",
		);
		expect(
			entryHeadline(
				entry({ versionNumber: 3, kind: "alfy_reply_edit", author: "alfy" }),
				c,
			),
		).toBe("Alfy módosította, válaszul a megjegyzésedre");
		expect(
			entryHeadline(
				entry({
					versionNumber: 3,
					kind: "app_rebuilt",
					author: "alfy",
					text: "kék legyen",
				}),
				c,
			),
		).toBe("Alfy újraépítette: „kék legyen”");
		expect(
			entryHeadline(entry({ versionNumber: 1, kind: "kept_from_chat" }), c),
		).toBe("Megtartottad Alfy válaszát dokumentumként");
		expect(
			entryHeadline(
				entry({
					versionNumber: 3,
					kind: "alfy_edit",
					author: "alfy",
					text: null,
				}),
				c,
			),
		).toBe("Alfy módosította");
		expect(
			entryHeadline(
				entry({
					versionNumber: 7,
					kind: "restore",
					restoredFrom: {
						versionId: "v2",
						versionNumber: 2,
						at: at(2026, 10, 10, 10, 9),
					},
				}),
				c,
			),
		).toBe("Visszaállítottad: tegnap 10:09");
	});
});

describe("entryDetail: what changed, as a noun phrase that serves both authors", () => {
	const doc = (
		overrides: Partial<{
			changed: { count: number; first: string | null };
			added: { count: number; first: string | null };
			removed: { count: number; first: string | null };
			tab: string | null;
		}>,
	) =>
		momentEntry(
			makeMoment({
				versionNumber: 3,
				detail: {
					type: "document",
					changed: { count: 0, first: null },
					added: { count: 0, first: null },
					removed: { count: 0, first: null },
					tab: null,
					...overrides,
				},
			}),
		);

	it("names the first block changed and counts the rest", () => {
		const c = ctx();
		expect(
			entryDetail(doc({ changed: { count: 1, first: "Saturday" } }), c),
		).toBe("Changed “Saturday”");
		expect(
			entryDetail(doc({ changed: { count: 3, first: "Saturday" } }), c),
		).toBe("Changed “Saturday” and 2 more");
		expect(
			entryDetail(doc({ added: { count: 1, first: "Museum tickets" } }), c),
		).toBe("New: “Museum tickets”");
		expect(entryDetail(doc({ removed: { count: 1, first: "Old" } }), c)).toBe(
			"Removed: 1 paragraph",
		);
		expect(entryDetail(doc({ removed: { count: 2, first: "Old" } }), c)).toBe(
			"Removed: 2 paragraphs",
		);
	});

	it("joins what happened, adds the tab when it is not the first, and falls back to counts for blocks with no words", () => {
		const c = ctx();
		expect(
			entryDetail(
				doc({
					changed: { count: 1, first: "Saturday" },
					added: { count: 1, first: "Rain plan" },
					tab: "Budget",
				}),
				c,
			),
		).toBe("Changed “Saturday” · New: “Rain plan” · in Budget");
		expect(entryDetail(doc({ changed: { count: 2, first: null } }), c)).toBe(
			"Changed 2 paragraphs",
		);
	});

	it("is Hungarian", () => {
		const c = ctx("hu");
		expect(
			entryDetail(doc({ changed: { count: 3, first: "Szombat" } }), c),
		).toBe("Módosult: „Szombat” és még 2");
		expect(
			entryDetail(
				doc({ removed: { count: 1, first: "x" }, tab: "Költségvetés" }),
				c,
			),
		).toBe("Törölve: 1 bekezdés · lap: Költségvetés");
	});

	it("says lines for an App, a large change as large, and nothing when nothing changed", () => {
		const c = ctx();
		expect(
			entryDetail(
				momentEntry(
					makeMoment({
						versionNumber: 2,
						detail: { type: "app", linesAdded: 30, linesRemoved: 12 },
					}),
				),
				c,
			),
		).toBe("42 lines changed");
		expect(
			entryDetail(
				momentEntry(
					makeMoment({ versionNumber: 2, detail: { type: "large" } }),
				),
				c,
			),
		).toBe("Large change");
		expect(
			entryDetail(
				momentEntry(makeMoment({ versionNumber: 2, detail: { type: "none" } })),
				c,
			),
		).toBeNull();
	});

	it("counts what a board's change touched", () => {
		const c = ctx();
		expect(
			entryDetail(
				momentEntry(
					makeMoment({
						versionNumber: 2,
						detail: {
							type: "canvas",
							blocksAdded: { count: 1, first: "Rain" },
							blocksChanged: { count: 0, first: null },
							blocksRemoved: { count: 0, first: null },
							blocksMoved: 3,
							blocksReparented: 0,
							arrowsAdded: 0,
							arrowsChanged: 0,
							arrowsRemoved: 0,
						},
					}),
				),
				c,
				"canvas",
			),
		).toBe("1 added, 3 moved");
	});
});

describe("times and day groups", () => {
	it("writes the clock the way a person reads it, in both languages", () => {
		expect(clockTime(at(2026, 10, 11, 9, 5), "en")).toBe("09:05");
		expect(clockTime(at(2026, 10, 11, 21, 40), "hu")).toBe("21:40");
	});

	it("says relative time under an hour and the clock after it", () => {
		const c = ctx();
		expect(entryTimeLabel(NOW - 5_000, c)).toBe("just now");
		expect(entryTimeLabel(NOW - 12 * 60_000, c)).toBe("12 min ago");
		expect(entryTimeLabel(at(2026, 10, 11, 10, 9), c)).toBe("10:09");
		expect(entryTimeLabel(at(2026, 10, 10, 18, 40), c)).toBe("18:40");
		expect(entryTimeLabel(NOW - 12 * 60_000, ctx("hu"))).toBe("12 perce");
	});

	it("names the day groups Today, Yesterday, then the weekday and date in the reader's locale", () => {
		expect(dayLabel(at(2026, 10, 11, 8, 0), ctx())).toBe("Today");
		expect(dayLabel(at(2026, 10, 10, 8, 0), ctx())).toBe("Yesterday");
		expect(dayLabel(at(2026, 10, 7, 8, 0), ctx())).toBe("Wednesday 7 October");
		expect(dayLabel(at(2026, 10, 11, 8, 0), ctx("hu"))).toBe("Ma");
		expect(dayLabel(at(2026, 10, 10, 8, 0), ctx("hu"))).toBe("Tegnap");
		expect(dayLabel(at(2026, 10, 7, 8, 0), ctx("hu"))).toBe(
			"október 7., szerda",
		);
	});

	it("writes a moment's day and time inside a sentence: today, yesterday, the weekday, then the date", () => {
		expect(whenLabel(at(2026, 10, 11, 10, 20), ctx())).toBe("today 10:20");
		expect(whenLabel(at(2026, 10, 10, 10, 9), ctx())).toBe("yesterday 10:09");
		expect(whenLabel(at(2026, 10, 7, 10, 9), ctx())).toBe("Wednesday 10:09");
		expect(whenLabel(at(2026, 8, 20, 10, 9), ctx())).toBe("20 Aug, 10:09");
		expect(whenLabel(at(2026, 10, 7, 10, 9), ctx("hu"))).toBe("szerda 10:09");
		expect(whenLabel(at(2026, 10, 11, 10, 20), ctx("hu"))).toBe("ma 10:20");
	});
});

describe("statusLabel and the option's accessible name", () => {
	it("says each review status in words", () => {
		const c = ctx();
		expect(statusLabel("waiting", c.t)).toBe("Waiting for you");
		expect(statusLabel("kept", c.t)).toBe("Kept");
		expect(statusLabel("undone", c.t)).toBe("Undone");
		expect(statusLabel("partly_kept", c.t)).toBe("Partly kept");
		expect(statusLabel("waiting", ctx("hu").t)).toBe("Rád vár");
	});

	it("reads an option as one sentence: day and time, headline, what changed, status", () => {
		const c = ctx();
		const entry = momentEntry(
			makeMoment({
				versionNumber: 4,
				kind: "alfy_edit",
				author: "alfy",
				text: "Rainy-day plan",
				at: at(2026, 10, 10, 10, 12),
				status: "undone",
				detail: {
					type: "document",
					changed: { count: 0, first: null },
					added: { count: 1, first: "Rain" },
					removed: { count: 0, first: null },
					tab: null,
				},
			}),
		);
		expect(entryA11yName(entry, c)).toBe(
			"Yesterday 10:12, Alfy: Rainy-day plan. New: “Rain”. Undone.",
		);
	});

	it("includes the reader's name for the version and where it stands now", () => {
		const c = ctx();
		const named = momentEntry(
			makeMoment({
				versionNumber: 3,
				label: "Before the client call",
				at: at(2026, 10, 11, 9, 30),
				isNewest: true,
				containsNewest: true,
			}),
		);
		expect(entryA11yName(named, c)).toBe(
			"Before the client call. Today 09:30, You edited. Now.",
		);
	});
});
