import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "$lib/server/services/connections/registry";
import { isCapability } from "./capabilities";

describe("isCapability", () => {
	it("accepts every known capability", () => {
		for (const cap of CAPABILITIES) {
			expect(isCapability(cap)).toBe(true);
		}
	});

	it("rejects unknown strings and non-strings", () => {
		expect(isCapability("not-a-capability")).toBe(false);
		expect(isCapability(123)).toBe(false);
		expect(isCapability(null)).toBe(false);
		expect(isCapability(undefined)).toBe(false);
		expect(isCapability({})).toBe(false);
	});
});
