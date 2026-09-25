import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import {
	collectDictionaryKeys,
	mergedDictionaryModules,
} from "$lib/i18n.test-helpers";
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
