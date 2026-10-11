import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import { latestMomentPhrase, momentPhraseKey } from "./moment-text";

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
