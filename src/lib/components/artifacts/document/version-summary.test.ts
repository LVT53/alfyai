import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import { uiLanguage } from "$lib/stores/settings";
import { localizeVersionSummary } from "./version-summary";

afterEach(() => {
	uiLanguage.set("en");
});

describe("localizeVersionSummary", () => {
	it("keeps a free-form (Alfy-authored) summary exactly as stored, in every language", () => {
		uiLanguage.set("hu");
		expect(localizeVersionSummary("Moved the museum to Thursday", get(t))).toBe(
			"Moved the museum to Thursday",
		);
	});

	it("shows Undo's own summary in the reader's language (spec §4.2 item 6)", () => {
		expect(
			localizeVersionSummary(VERSION_SUMMARY.undidAlfyChange, get(t)),
		).toBe("Undid Alfy's change");
		uiLanguage.set("hu");
		expect(
			localizeVersionSummary(VERSION_SUMMARY.undidAlfyChange, get(t)),
		).toBe("Alfy módosításának visszavonása");
	});

	it("localizes every fixed summary the server writes itself", () => {
		uiLanguage.set("hu");
		expect(localizeVersionSummary(VERSION_SUMMARY.edited, get(t))).toBe(
			"Szerkesztve",
		);
		expect(localizeVersionSummary(VERSION_SUMMARY.alfyFirstDraft, get(t))).toBe(
			"Alfy megírta az első vázlatot",
		);
		expect(localizeVersionSummary(VERSION_SUMMARY.savedAsCopy, get(t))).toBe(
			"Mentve új dokumentumként",
		);
	});

	it("names the version a restore came from, in the reader's language", () => {
		expect(localizeVersionSummary("Restored v3", get(t))).toBe("Restored v3");
		uiLanguage.set("hu");
		expect(localizeVersionSummary("Restored v3", get(t))).toBe(
			"Visszaállítva: v3",
		);
	});

	it("still localizes the older restore wrapper (rows written before a restore named its version) and whatever it wraps, however deep", () => {
		uiLanguage.set("hu");
		expect(localizeVersionSummary("restored Edited", get(t))).toBe(
			"visszaállítva: Szerkesztve",
		);
		expect(localizeVersionSummary("restored Undid Alfy's change", get(t))).toBe(
			"visszaállítva: Alfy módosításának visszavonása",
		);
		expect(localizeVersionSummary("restored restored Edited", get(t))).toBe(
			"visszaállítva: visszaállítva: Szerkesztve",
		);
		expect(localizeVersionSummary("restored Shortened Saturday", get(t))).toBe(
			"visszaállítva: Shortened Saturday",
		);
	});

	it("never mistakes an inherited property name for a fixed summary", () => {
		for (const text of ["toString", "constructor", "__proto__"]) {
			expect(localizeVersionSummary(text, get(t))).toBe(text);
		}
	});
});
