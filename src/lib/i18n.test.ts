import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import artifactsDict from "./i18n/artifacts";
import chatDict from "./i18n/chat";
import commonDict from "./i18n/common";
import connectionsDict from "./i18n/connections";
import instructionsDict from "./i18n/instructions";
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

	it("localizes every upload refusal the server can answer with", () => {
		// The server sends an English `error` plus one of these keys. A key that
		// landed in EN only would show the raw key to exactly the Hungarian
		// readers whose upload was just refused. `knowledge.` as a whole is not
		// audited, so the narrow `knowledge.upload` prefix in
		// `i18n.test-helpers.ts` is what makes the parity test above see these.
		const keys = collectDictionaryKeys();
		const uploadRefusalKeys = [
			"knowledge.uploadContentMismatch",
			"knowledge.uploadRejectedArchive",
			"knowledge.uploadRejectedConvertImage",
			"knowledge.uploadRejectedFormatNotEnabled",
			"knowledge.uploadRejectedMedia",
			"knowledge.uploadUnsupportedType",
		];

		for (const key of uploadRefusalKeys) {
			expect(keys.en).toContain(key);
			expect(keys.hu).toContain(key);
			expect(knowledgeDict.hu[key as keyof typeof knowledgeDict.hu]).not.toBe(
				knowledgeDict.en[key as keyof typeof knowledgeDict.en],
			);
		}
	});

	it("parameterizes the two drop-zone size limits", () => {
		// Both used to spell "100MB" in four places. They now read the limit the
		// server reports, so the placeholder has to survive translation.
		for (const value of [
			knowledgeDict.en["knowledge.dropFiles"],
			knowledgeDict.hu["knowledge.dropFiles"],
			chatDict.en["chat.dropZone.attach"],
			chatDict.hu["chat.dropZone.attach"],
		]) {
			expect(value).toContain("{max}");
			expect(value).not.toContain("100");
		}
	});

	it("parameterizes the minimum password length in the three strings that name it", () => {
		// They used to spell "8" in words, apart from MIN_PASSWORD_LENGTH, which the
		// server and both forms read. They now take it as {count}, so the placeholder
		// has to survive translation and the number must not creep back in. (That every
		// screen passes `count` is held by the rendered-text tests beside each one.)
		for (const value of [
			settingsDict.en["admin.passwordPlaceholder"],
			settingsDict.hu["admin.passwordPlaceholder"],
			settingsDict.en["profileTab.newPasswordPlaceholder"],
			settingsDict.hu["profileTab.newPasswordPlaceholder"],
			settingsDict.en.settings_passwordTooShort,
			settingsDict.hu.settings_passwordTooShort,
		]) {
			expect(value).toContain("{count}");
			expect(value).not.toMatch(/\b8\b/);
		}
	});

	it("gives Settings its own throttle sentence, which does not talk about signing in", () => {
		// The password re-asks of Settings (password and email change, archive,
		// clear memory, clear workspace, delete account) share the sign-in's
		// limiter, but nobody is signing in there: borrowing
		// `login.tooManyAttempts` told a person at a Delete account box that their
		// "sign-in attempts" had failed.
		expect(settingsDict.en["profileTab.currentPasswordTooManyAttempts"]).toBe(
			"Too many wrong passwords. Please wait a moment and try again.",
		);
		expect(settingsDict.hu["profileTab.currentPasswordTooManyAttempts"]).toBe(
			"Túl sok hibás jelszó. Várj egy pillanatot, majd próbáld újra.",
		);
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
			artifactsDict,
			chatDict,
			commonDict,
			connectionsDict,
			instructionsDict,
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

// One Hungarian name for the Skill concept: "készség". "Skill", "Képesség" and
// "Skill csomag" were all in the UI at once. This is an allow-list of the
// skills-related keys (not a regex over the whole dictionary) because
// "képesség" is the right word for tool and model capabilities, which live
// elsewhere and must keep it.
const HU_SKILL_KEY_PREFIXES = [
	"composerCommandRegistry.",
	"pendingSkill.",
	"skillDrafts.",
	"skills.",
	"skillsPicker.",
	"composerMenu.skills",
	"composerCommands.skill",
	"admin.systemSkills.",
	"admin.system.skills.",
	"settings_skills",
	"profileTab.skillsHelp",
	"profileTab.manageSkills",
	"profileTab.skillsCount",
] as const;
const HU_SKILL_KEYS = [
	"toolActivity.usedSkill",
	"toolActivity.usingSkill",
	"admin.system.pages.skills",
	"admin.composerCommandRegistryDescription",
	"analytics.commandsSkillsActions",
	"analytics.kindSkill",
	"searchModal.badgeSkillNote",
	"knowledge.skillNote",
	"knowledge.uploadLimitTooltip",
] as const;

describe("Hungarian skill terminology", () => {
	const hu: Record<string, string> = {
		...commonDict.hu,
		...chatDict.hu,
		...knowledgeDict.hu,
		...settingsDict.hu,
		...skillsDict.hu,
	};
	const skillKeys = Object.keys(hu).filter(
		(key) =>
			(HU_SKILL_KEYS as readonly string[]).includes(key) ||
			HU_SKILL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
	);

	it("covers every allow-listed key", () => {
		for (const key of HU_SKILL_KEYS) expect(hu[key], key).toBeTypeOf("string");
		expect(skillKeys.length).toBeGreaterThan(150);
	});

	it("calls a disabled skill 'letiltva' everywhere", () => {
		expect(hu["profileTab.skillsCountDisabled"]).toBe("{count} letiltva");
		expect(hu["skills.status.disabled"]).toBe("Letiltva");
		expect(hu["settings_skillsManagerStatus"]).toContain("letiltva");
	});

	it("uses only 'készség' for the Skill concept", () => {
		for (const key of skillKeys) {
			expect(hu[key], key).not.toMatch(/skill|képesség/i);
		}
	});
});

describe("composer skill status wording", () => {
	// Skills are loaded per turn; there is no durable Skill Session, so no
	// skill is "active" in a chat. A count of enabled skills must not say so.
	it("never calls an enabled skill active, in either language", () => {
		expect(Object.keys(chatDict.en)).not.toContain("composerMenu.skillsActive");
		for (const key of [
			"composerMenu.skillsAvailable",
			"skillsPicker.subtitle",
		]) {
			expect(chatDict.en[key as keyof typeof chatDict.en], key).not.toMatch(
				/active/i,
			);
			expect(chatDict.hu[key as keyof typeof chatDict.hu], key).not.toMatch(
				/aktív/i,
			);
		}
	});
	it("says available / elérhető", () => {
		expect(chatDict.en["composerMenu.skillsAvailable"]).toBe(
			"{count} available",
		);
		expect(chatDict.hu["composerMenu.skillsAvailable"]).toBe(
			"{count} elérhető",
		);
		expect(chatDict.en["skillsPicker.subtitle"]).toBe("{count} available");
		expect(chatDict.hu["skillsPicker.subtitle"]).toBe("{count} elérhető");
	});
});
