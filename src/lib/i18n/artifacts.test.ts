import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import {
	collectDictionaryKeys,
	mergedDictionaryModules,
} from "$lib/i18n.test-helpers";
import {
	BOARD_REFUSAL_REASONS,
	refusalLabelKey,
} from "$lib/shared/artifacts/board-ops";
import { uiLanguage } from "$lib/stores/settings";
import artifactsDict from "./artifacts";

// Every merged dictionary module, loaded as a real module object — the same
// set `src/lib/i18n/index.ts` merges, so a namespace added later is covered
// the day it is merged. The colocated tests are excluded: importing them
// eagerly would run their suites inside this one.
const dictionaryModules = import.meta.glob(["./*.ts", "!./*.test.ts"], {
	eager: true,
}) as Record<
	string,
	{ default?: { en: Record<string, string>; hu: Record<string, string> } }
>;

afterEach(() => {
	uiLanguage.set("en");
});

describe("the artifacts dictionary", () => {
	it("has every key in both languages", () => {
		expect(Object.keys(artifactsDict.hu).sort()).toEqual(
			Object.keys(artifactsDict.en).sort(),
		);
	});

	it("names the five types with ADR-0066's words — Canvas is Tábla in Hungarian", () => {
		expect({
			file: artifactsDict.en["artifacts.type.file"],
			document: artifactsDict.en["artifacts.type.document"],
			app: artifactsDict.en["artifacts.type.app"],
			canvas: artifactsDict.en["artifacts.type.canvas"],
			slides: artifactsDict.en["artifacts.type.slides"],
		}).toEqual({
			file: "File",
			document: "Document",
			app: "App",
			canvas: "Canvas",
			slides: "Slides",
		});
		expect({
			file: artifactsDict.hu["artifacts.type.file"],
			document: artifactsDict.hu["artifacts.type.document"],
			app: artifactsDict.hu["artifacts.type.app"],
			canvas: artifactsDict.hu["artifacts.type.canvas"],
			slides: artifactsDict.hu["artifacts.type.slides"],
		}).toEqual({
			file: "Fájl",
			document: "Dokumentum",
			app: "Alkalmazás",
			canvas: "Tábla",
			slides: "Diasor",
		});
	});

	it("is merged into the app's dictionary and watched by the parity test", () => {
		expect(mergedDictionaryModules()).toContain("artifacts");
		const keys = collectDictionaryKeys();
		expect(keys.en).toContain("artifacts.type.canvas");
		expect(keys.hu).toContain("artifacts.type.canvas");

		expect(get(t)("artifacts.type.canvas")).toBe("Canvas");
		uiLanguage.set("hu");
		expect(get(t)("artifacts.type.canvas")).toBe("Tábla");
	});

	it("counts items with a singular in English and none needed in Hungarian", () => {
		const translate = get(t);
		expect(translate("artifacts.panel.count", { count: 1 })).toBe(
			"1 item · newest first",
		);
		expect(translate("artifacts.panel.count", { count: 6 })).toBe(
			"6 items · newest first",
		);
		uiLanguage.set("hu");
		expect(get(t)("artifacts.panel.count", { count: 6 })).toBe(
			"6 elem · legújabb elöl",
		);
	});
});

// ADR-0066: "Artifact" is AlfyAI's engineering word; the UI never shows it,
// in English or Hungarian — not in a label, a title, an aria-label or an
// error. Checked across every dictionary the app merges, not just this
// feature's, because the rule is the app's.
describe("the word 'artifact' in the UI", () => {
	it("appears in no dictionary value, in either language", () => {
		const offenders: string[] = [];
		const modules = mergedDictionaryModules();
		for (const [path, loaded] of Object.entries(dictionaryModules)) {
			const name = path.replace(/^\.\//, "").replace(/\.ts$/, "");
			if (!modules.includes(name) || !loaded.default) continue;
			for (const language of ["en", "hu"] as const) {
				for (const [key, value] of Object.entries(loaded.default[language])) {
					if (/artifact|artefakt/i.test(value)) {
						offenders.push(`${name}.${language} ${key}: ${value}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
		// The walk above saw every merged module, so a pass is a real pass.
		expect(
			Object.keys(dictionaryModules).filter((path) =>
				modules.includes(path.replace(/^\.\//, "").replace(/\.ts$/, "")),
			),
		).toHaveLength(modules.length);
	});
});

// The Canvas tells the reader why a change of Alfy's skipped a block, in the
// reader's own language: every reason the board can refuse for has a sentence,
// in both. (`refusalLabelKey` is an exhaustive switch, so a new reason cannot
// compile without a key; this is the half the compiler cannot see.)
describe("the Canvas's refusal sentences", () => {
	it("has a sentence, in English and in Hungarian, for every reason a board refuses for", () => {
		for (const reason of BOARD_REFUSAL_REASONS) {
			const key = refusalLabelKey(reason);
			expect(artifactsDict.en, `${reason} in English`).toHaveProperty(key);
			expect(artifactsDict.hu, `${reason} in Hungarian`).toHaveProperty(key);
			expect((artifactsDict.hu as Record<string, string>)[key].trim()).not.toBe(
				"",
			);
		}
	});
});

// RV-3 Minor 8 and I2: a native speaker read the board's Hungarian and named the
// sentences that read as translations; the refused-save banner named nobody and
// blamed a reader "who was drawing". These pin what they were changed to.
describe("the Canvas's wording after the review (RV-3 Minor 8, I2, Minor 9)", () => {
	const en = artifactsDict.en as Record<string, string>;
	const hu = artifactsDict.hu as Record<string, string>;

	it("says in Hungarian what a Hungarian reader would say", () => {
		expect(hu["artifacts.canvas.redo"]).toBe("Saját lépés ismét");
		expect(hu["artifacts.canvas.offline"]).toBe(
			"Nincs kapcsolat. A rajzod megmarad, a módosításaidat a kapcsolat helyreálltával mentjük.",
		);
		expect(hu["artifacts.canvas.comment.placed"]).toBe(
			"Megjegyzés indítva — írd meg a listában.",
		);
		expect(hu["artifacts.canvas.arranging"]).toBe("Alfy dolgozik a táblán…");
		expect(hu["artifacts.canvas.arrangingSummary"]).toBe(
			"Alfy dolgozik a táblán: {summary}",
		);
		expect(hu["artifacts.canvas.staleBadge"]).toBe("Elavult");
		expect(hu["artifacts.canvas.comment.blockGone"]).toBe(
			"A blokk már nem létezik.",
		);
		expect(hu["artifacts.canvas.checklistReadOnlyNote"]).toBe(
			"Az itt kipipált elemeket a táblával együtt mentjük.",
		);
		expect(hu["artifacts.canvas.review.landedLeft"]).toBe(
			"{summary} {left} módosítást kihagyott. Nézd át a tábla alatt.",
		);
	});

	it("says what happened when a save is refused: Alfy or another window changed the board, and the last step was not saved", () => {
		const english = en["artifacts.canvas.saveConflict"];
		expect(english).toContain("Alfy");
		expect(english).toContain("your last step was not saved");
		expect(english).not.toMatch(/someone|drawing/i);
		const hungarian = hu["artifacts.canvas.saveConflict"];
		expect(hungarian).toContain("Alfy");
		expect(hungarian).toContain("utolsó lépésedet nem sikerült elmenteni");
		expect(hungarian).not.toMatch(/valaki|rajzolt/i);
	});

	it("gives the zoom group and the button that zooms in different names, in both languages", () => {
		for (const dict of [en, hu]) {
			expect(dict["artifacts.canvas.zoom"]).not.toBe(
				dict["artifacts.canvas.zoomIn"],
			);
			expect(dict["artifacts.canvas.zoom"]).not.toBe(
				dict["artifacts.canvas.zoomOut"],
			);
		}
		expect(hu["artifacts.canvas.zoom"]).toBe("Nagyítás mértéke");
	});
});
