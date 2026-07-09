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
