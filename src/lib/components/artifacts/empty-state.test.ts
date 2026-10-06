import { describe, expect, it } from "vitest";
import type { I18nKey } from "$lib/i18n";
import artifactsDict from "$lib/i18n/artifacts";
import { ARTIFACT_TOUR_DEFAULTS } from "$lib/server/artifact-tour-defaults";
import { SHIPPED_ARTIFACT_TOUR_TYPES } from "$lib/shared/artifacts/tours";
import { EMPTY_STATE_FALLBACK_KEYS, emptyStateLine } from "./empty-state";

// The empty state says what the tour says (Slice 6 T6): the resolved tour's
// summary when there is one in the reader's language, the dictionary's line when
// there is not. Both are shipped, and the last test makes them agree.

/** A `t` that answers from the real dictionary, in one language (English where a key is missing, as the app's own does). */
function translator(language: "en" | "hu") {
	const own = artifactsDict[language] as Record<string, string>;
	const fallback = artifactsDict.en as Record<string, string>;
	return (key: I18nKey) => own[key] ?? fallback[key] ?? key;
}

const SUMMARY = {
	en: "A blank board, ready for the first note.",
	hu: "Üres tábla, készen az első jegyzetre.",
};

describe("emptyStateLine", () => {
	it("returns the tour's summary when a tour resolves", () => {
		expect(emptyStateLine(SUMMARY, "en", translator("en"), "canvas")).toBe(
			SUMMARY.en,
		);
	});

	it("resolves the summary in Hungarian when the language is Hungarian", () => {
		expect(emptyStateLine(SUMMARY, "hu", translator("hu"), "canvas")).toBe(
			SUMMARY.hu,
		);
	});

	it("returns the dictionary's line when there is no tour, in the reader's language", () => {
		for (const summary of [null, undefined]) {
			expect(emptyStateLine(summary, "en", translator("en"), "canvas")).toBe(
				"Empty board. Insert a block or draw on it.",
			);
			expect(emptyStateLine(summary, "hu", translator("hu"), "canvas")).toBe(
				"Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá.",
			);
		}
	});

	it("returns the dictionary's line when the tour has no summary in this language", () => {
		for (const blank of ["", "   ", "\n"]) {
			const summary = { en: SUMMARY.en, hu: blank };
			// Not the English summary in a Hungarian page: the Hungarian line.
			expect(emptyStateLine(summary, "hu", translator("hu"), "app")).toBe(
				"Itt még nincs semmi. Kérd meg Alfyt, hogy építsen egy kis eszközt.",
			);
		}
		const missing = { en: SUMMARY.en } as never;
		expect(emptyStateLine(missing, "hu", translator("hu"), "document")).toBe(
			"Üres dokumentum. Kezdj el írni, vagy kérd meg Alfyt, hogy megírja.",
		);
	});

	it("never returns a bare key, for any kind in either language", () => {
		for (const kind of SHIPPED_ARTIFACT_TOUR_TYPES) {
			for (const language of ["en", "hu"] as const) {
				const line = emptyStateLine(null, language, translator(language), kind);
				expect(line.length).toBeGreaterThan(10);
				expect(line).not.toMatch(/^artifacts\./);
			}
		}
	});
});

// The drift guard: the code copy's summary and the dictionary's fallback are
// two copies of one sentence, which is how a product starts describing itself
// two ways. They live in two files (the server's defaults and the client's
// dictionary), so this reads both.
describe("the shipped default summary and its fallback", () => {
	it("are the same sentence, per kind and per language", () => {
		for (const kind of SHIPPED_ARTIFACT_TOUR_TYPES) {
			const key = EMPTY_STATE_FALLBACK_KEYS[kind];
			for (const language of ["en", "hu"] as const) {
				expect(
					artifactsDict[language][key],
					`${kind} (${language}): ${key}`,
				).toBe(ARTIFACT_TOUR_DEFAULTS[kind].summary[language]);
			}
		}
	});

	it("name a fallback for every kind that ships, and only for those", () => {
		expect(Object.keys(EMPTY_STATE_FALLBACK_KEYS).sort()).toEqual(
			[...SHIPPED_ARTIFACT_TOUR_TYPES].sort(),
		);
		expect(EMPTY_STATE_FALLBACK_KEYS).not.toHaveProperty("slides");
	});

	it("say the ratified words for the kind in Hungarian", () => {
		expect(artifactsDict.hu[EMPTY_STATE_FALLBACK_KEYS.document]).toMatch(
			/dokumentum/i,
		);
		expect(artifactsDict.hu[EMPTY_STATE_FALLBACK_KEYS.canvas]).toMatch(
			/tábla/i,
		);
	});
});
