import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import chatDict from "./chat";
import commonDict from "./common";
import connectionsDict from "./connections";
import knowledgeDict from "./knowledge";
import legalDict from "./legal";
import settingsDict from "./settings";
import skillsDict from "./skills";

const dictionaries = [
	commonDict,
	chatDict,
	connectionsDict,
	knowledgeDict,
	legalDict,
	settingsDict,
	skillsDict,
];

const enKeys = new Set(dictionaries.flatMap((dict) => Object.keys(dict.en)));
const huKeys = new Set(dictionaries.flatMap((dict) => Object.keys(dict.hu)));

// Analytics overhaul (frontend half) — the analytics surfaces gained ~35 new
// keys across two dictionaries. A key that only exists in `en` silently falls
// back to English for Hungarian users, and a key that exists in neither
// renders as the raw key id, so both surfaces are asserted from the source.
const ANALYTICS_UI_FILES = [
	"src/routes/(app)/settings/_components/SettingsSystemAnalytics.svelte",
	"src/routes/(app)/settings/_components/SettingsPersonalAnalytics.svelte",
	"src/lib/components/analytics/AnalyticsCard.svelte",
	"src/lib/components/analytics/MonthNav.svelte",
	"src/lib/components/analytics/SortableTable.svelte",
	"src/lib/components/analytics/StatCard.svelte",
];

function literalKeysUsedIn(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const keys = new Set<string>();
	for (const match of source.matchAll(/\$t\(\s*["']([^"']+)["']/g)) {
		keys.add(match[1]);
	}
	return [...keys];
}

describe("settings i18n dictionary", () => {
	it("has an en key for every hu key and vice versa", () => {
		expect(Object.keys(settingsDict.en).sort()).toEqual(
			Object.keys(settingsDict.hu).sort(),
		);
	});

	it("has no empty translations", () => {
		for (const [key, value] of Object.entries(settingsDict.en)) {
			expect(value.trim(), `en.${key}`).not.toBe("");
		}
		for (const [key, value] of Object.entries(settingsDict.hu)) {
			expect(value.trim(), `hu.${key}`).not.toBe("");
		}
	});
});

describe("analytics UI translation keys", () => {
	it.each(ANALYTICS_UI_FILES)("resolves every key used in %s", (file) => {
		const used = literalKeysUsedIn(file);
		const missingEn = used.filter((key) => !enKeys.has(key));
		const missingHu = used.filter((key) => !huKeys.has(key));

		expect(missingEn, `missing en keys in ${file}`).toEqual([]);
		expect(missingHu, `missing hu keys in ${file}`).toEqual([]);
	});

	it("finds the overhaul's own keys, so the scan is not silently empty", () => {
		const used = literalKeysUsedIn(ANALYTICS_UI_FILES[0]);
		expect(used).toEqual(
			expect.arrayContaining([
				"analytics.toolsAndLatency",
				"analytics.retiredGroupLabel",
				"analytics.showRetired",
				"analytics.modelsActiveConfigured",
			]),
		);
	});
});
