import { describe, expect, it } from "vitest";
import chatDict from "./chat";

describe("chat i18n dictionary", () => {
	it("has an en key for every hu key and vice versa", () => {
		const enKeys = Object.keys(chatDict.en).sort();
		const huKeys = Object.keys(chatDict.hu).sort();

		expect(enKeys).toEqual(huKeys);
	});

	it("has no empty translations", () => {
		for (const [key, value] of Object.entries(chatDict.en)) {
			expect(value.trim(), `en.${key}`).not.toBe("");
		}
		for (const [key, value] of Object.entries(chatDict.hu)) {
			expect(value.trim(), `hu.${key}`).not.toBe("");
		}
	});
});

describe("composerTools.capabilities i18n keys (Issue 7.2)", () => {
	// Mirrors the capability set in $lib/server/services/connections/registry.ts
	// (Capability type / CAPABILITIES). Kept as a literal list here so a typo
	// in either the dictionary or this test fails loudly rather than silently
	// agreeing with itself.
	const capabilities = [
		"calendar",
		"files",
		"photos",
		"email",
		"location",
		"media",
		"contacts",
	];

	it("has a composerTools.capabilities.* key for every capability in both languages", () => {
		for (const capability of capabilities) {
			const key = `composerTools.capabilities.${capability}` as const;
			expect(chatDict.en, key).toHaveProperty(key);
			expect(chatDict.hu, key).toHaveProperty(key);
		}
	});

	it("has the multi-account sub-label key in both languages", () => {
		expect(chatDict.en).toHaveProperty(
			"composerTools.capabilitiesMultiAccount",
		);
		expect(chatDict.hu).toHaveProperty(
			"composerTools.capabilitiesMultiAccount",
		);
	});
});
