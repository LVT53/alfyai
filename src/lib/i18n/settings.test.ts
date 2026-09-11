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

	// Two English strings that say different things must not collapse into one
	// Hungarian string WITHIN THE SAME SCREEN. The profile redesign shipped two
	// of these: the irreversible card's "Clear…" and "Delete…" both became
	// "Törlés…", so its three buttons read identically in Hungarian while
	// English tells two of them from the third; and the photo editor's zoom
	// SLIDER and its zoom-IN button both became "Nagyítás", giving two controls
	// in one dialog the same accessible name.
	//
	// Scoped per key namespace, which is the unit that maps to a screen. Across
	// screens a shared Hungarian word is usually right — "Messages" and "Msgs"
	// are both "Üzenetek" — and policing that dictionary-wide would be noise.
	it("does not collapse two distinct English strings into one Hungarian one on the same screen", () => {
		const namespaces = ["profileTab", "avatarEditor"];
		const collisions: string[] = [];

		for (const namespace of namespaces) {
			const byHungarian = new Map<string, string[]>();
			for (const [key, value] of Object.entries(settingsDict.hu)) {
				if (!key.startsWith(`${namespace}.`)) continue;
				const keys = byHungarian.get(value) ?? [];
				keys.push(key);
				byHungarian.set(value, keys);
			}

			for (const [hungarian, keys] of byHungarian) {
				if (keys.length < 2) continue;
				const english = new Set(
					keys.map(
						(key) => settingsDict.en[key as keyof typeof settingsDict.en],
					),
				);
				if (english.size > 1) {
					collisions.push(
						`"${hungarian}" is shared by ${keys.join(", ")} — English says ${[
							...english,
						]
							.map((value) => `"${value}"`)
							.join(" vs ")}`,
					);
				}
			}
		}

		expect(collisions).toEqual([]);
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
