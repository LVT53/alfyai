import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import chatDict from "./i18n/chat";
import commonDict from "./i18n/common";
import connectionsDict from "./i18n/connections";
import knowledgeDict from "./i18n/knowledge";
import legalDict from "./i18n/legal";
import settingsDict from "./i18n/settings";
import skillsDict from "./i18n/skills";
import { collectDictionaryKeys } from "./i18n.test-helpers";

describe("i18n composer and skills namespaces", () => {
	it("keeps English and Hungarian keys in parity", () => {
		const keys = collectDictionaryKeys();

		expect(keys.hu).toEqual(keys.en);
		expect(keys.en.length).toBeGreaterThan(0);
	});

	it("localizes every conversation fork creation failure code", () => {
		const keys = collectDictionaryKeys();
		const expectedForkErrorKeys = [
			"fork.errors.emptySourceMessage",
			"fork.errors.invalidSourceMessage",
			"fork.errors.requiredArtifactUnauthorized",
			"fork.errors.requiredArtifactUnavailable",
			"fork.errors.requiredGeneratedWorkUnavailable",
			"fork.errors.sequenceConflict",
			"fork.errors.sourceConversationNotFound",
			"fork.errors.stoppedSourceMessage",
		];

		for (const key of expectedForkErrorKeys) {
			expect(keys.en).toContain(key);
			expect(keys.hu).toContain(key);
		}
	});

	it("localizes the inherited Skill Draft copy guard", () => {
		const keys = collectDictionaryKeys();

		expect(keys.en).toContain("skillDrafts.inheritedCopyBlocked");
		expect(keys.hu).toContain("skillDrafts.inheritedCopyBlocked");
	});

	it("uses localized Hungarian labels for depth profiles", () => {
		expect(chatDict.hu["messageBubble.depthProfileExtended"]).not.toBe(
			chatDict.en["messageBubble.depthProfileExtended"],
		);
		expect(chatDict.hu["messageBubble.depthProfileMaximum"]).not.toBe(
			chatDict.en["messageBubble.depthProfileMaximum"],
		);
		expect(chatDict.hu["messageBubble.depthProfileStandard"]).not.toBe(
			chatDict.en["messageBubble.depthProfileStandard"],
		);
	});

	it("localizes the response audit details labels", () => {
		expect(chatDict.hu["messageBubble.responseAuditDetails"]).not.toBe(
			chatDict.en["messageBubble.responseAuditDetails"],
		);
		expect(chatDict.hu["messageBubble.auditSources"]).not.toBe(
			chatDict.en["messageBubble.auditSources"],
		);
		expect(chatDict.hu["messageBubble.auditMaxTurns"]).not.toBe(
			chatDict.en["messageBubble.auditMaxTurns"],
		);
	});

	it("localizes approved Privacy and Data Controls labels", () => {
		expect(settingsDict.en.settings_privacyControls).toBe(
			"Privacy and Data Controls",
		);
		expect(settingsDict.en.settings_downloadMyData).toBe("Download my data");
		expect(settingsDict.en.settings_clearMemoryAndKnowledge).toBe(
			"Clear memory and knowledge",
		);
		expect(settingsDict.en.settings_clearWorkspaceData).toBe(
			"Clear workspace data",
		);
		expect(settingsDict.en.settings_deleteAccountPrivacy).toBe(
			"Delete account",
		);

		expect(settingsDict.hu.settings_privacyControls).toBe(
			"Adatvédelmi és adatkezelési vezérlők",
		);
		expect(settingsDict.hu.settings_downloadMyData).toBe("Adataim letöltése");
		expect(settingsDict.hu.settings_clearMemoryAndKnowledge).toBe(
			"Memória és tudás törlése",
		);
		expect(settingsDict.hu.settings_clearWorkspaceData).toBe(
			"Munkaterületi adatok törlése",
		);
		expect(settingsDict.hu.settings_deleteAccountPrivacy).toBe("Fiók törlése");
	});

	it("renders ICU-style plural blocks for singular and plural counts", () => {
		const translate = get(t);

		expect(translate("memoryProfile.autoExpiresInDays", { count: 1 })).toBe(
			"auto-expires in 1 day",
		);
		expect(translate("memoryProfile.autoExpiresInDays", { count: 10 })).toBe(
			"auto-expires in 10 days",
		);
	});

	it("keeps every interpolation parameter on both sides of a key", () => {
		// The Hungarian collapsed-activity strip lost `{verb}` and hardcoded the
		// settled form ("Emlékek felidézve"), so a recall still in flight said
		// the opposite of what was happening. A dropped parameter is always a
		// broken sentence, never a stylistic choice, so this guards ALL keys —
		// scripts/validate-i18n.ts checks the same thing, but only when someone
		// remembers to run it.
		// `{count, plural, one {y} other {ies}}` is ONE parameter, `count`, not
		// three — collapse the ICU form to a plain placeholder first, or the
		// suffixes inside it read as parameters of their own. Hungarian needs
		// no plural branch (the numeral already carries number), so an EN key
		// with a branch and a HU key without one is correct, not a mismatch.
		const collapseIcu = (value: string) =>
			value.replace(
				/\{(\w+),\s*plural,\s*one\s*\{[^{}]*\}\s*other\s*\{[^{}]*\}\}/g,
				"{$1}",
			);
		const params = (value: string) =>
			new Set([...collapseIcu(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
		const dicts = [
			chatDict,
			commonDict,
			connectionsDict,
			knowledgeDict,
			legalDict,
			settingsDict,
			skillsDict,
		];
		const en: Record<string, string> = Object.assign(
			{},
			...dicts.map((d) => d.en),
		);
		const hu: Record<string, string> = Object.assign(
			{},
			...dicts.map((d) => d.hu),
		);
		const mismatched: string[] = [];

		for (const [key, enValue] of Object.entries(en)) {
			const huValue = hu[key];
			if (huValue === undefined) continue;
			const a = params(enValue);
			const b = params(huValue);
			if (a.size !== b.size || ![...a].every((p) => b.has(p))) {
				mismatched.push(`${key}: EN=[${[...a]}] HU=[${[...b]}]`);
			}
		}

		expect(mismatched).toEqual([]);
	});

	it("localizes the memory-recall summary for both verb forms", () => {
		// `{verb}` on this key is filled from exactly two other keys — the
		// running and settled recall verbs — and the Hungarian has to be a
		// sentence with either one in it. Pin both renderings, not just the
		// presence of the placeholder.
		const hu = chatDict.hu["toolActivity.summaryMemories"];

		expect(hu).toContain("{verb}");
		expect(hu.replace("{verb}", chatDict.hu["toolActivity.recalling"])).toBe(
			"Felidézés: emlékek",
		);
		expect(hu.replace("{verb}", chatDict.hu["toolActivity.recalled"])).toBe(
			"Felidézve: emlékek",
		);
	});

	it("collects and sorts i18n keys for both languages", () => {
		const keys = collectDictionaryKeys();

		expect(keys.en).toEqual([...keys.en].sort());
		expect(keys.hu).toEqual([...keys.hu].sort());
		expect(new Set(keys.en).size).toBe(keys.en.length);
		expect(new Set(keys.hu).size).toBe(keys.hu.length);
	});
});
