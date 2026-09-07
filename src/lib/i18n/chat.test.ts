import { describe, expect, it } from "vitest";
import { TOOL_ACTIVITY_I18N_KEYS } from "$lib/utils/tool-activity";
import chatDict from "./chat";

describe("chat i18n dictionary", () => {
	it("has an en key for every hu key and vice versa", () => {
		const enKeys = Object.keys(chatDict.en).sort();
		const huKeys = Object.keys(chatDict.hu).sort();

		expect(enKeys).toEqual(huKeys);
	});

	// Unified tool activity rows — a verb the dictionary is missing would not
	// fail a build; it would silently print the raw key ("toolActivity.read")
	// in the chat. This pins every key a row can emit, in both languages.
	it("resolves every tool activity row key in both en and hu", () => {
		for (const key of TOOL_ACTIVITY_I18N_KEYS) {
			for (const lang of ["en", "hu"] as const) {
				const value =
					chatDict[lang][key as keyof (typeof chatDict)[typeof lang]];
				expect(typeof value, `${lang}.${key} is missing`).toBe("string");
				expect(String(value).trim(), `${lang}.${key} is empty`).not.toBe("");
			}
		}
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
