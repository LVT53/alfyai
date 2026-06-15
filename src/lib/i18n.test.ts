import { describe, expect, it } from "vitest";
import chatDict from "./i18n/chat";
import settingsDict from "./i18n/settings";
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

	it("collects and sorts i18n keys for both languages", () => {
		const keys = collectDictionaryKeys();

		expect(keys.en).toEqual([...keys.en].sort());
		expect(keys.hu).toEqual([...keys.hu].sort());
		expect(new Set(keys.en).size).toBe(keys.en.length);
		expect(new Set(keys.hu).size).toBe(keys.hu.length);
	});
});
