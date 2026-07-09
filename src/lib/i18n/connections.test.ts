import { describe, expect, it } from "vitest";
import connectionsDict from "./connections";

describe("connections i18n dictionary", () => {
	it("has an en key for every hu key and vice versa", () => {
		const enKeys = Object.keys(connectionsDict.en).sort();
		const huKeys = Object.keys(connectionsDict.hu).sort();

		expect(enKeys).toEqual(huKeys);
	});

	it("has no empty translations", () => {
		for (const [key, value] of Object.entries(connectionsDict.en)) {
			expect(value.trim(), `en.${key}`).not.toBe("");
		}
		for (const [key, value] of Object.entries(connectionsDict.hu)) {
			expect(value.trim(), `hu.${key}`).not.toBe("");
		}
	});

	it("every key is namespaced under connections.", () => {
		for (const key of Object.keys(connectionsDict.en)) {
			expect(key.startsWith("connections.")).toBe(true);
		}
	});
});
