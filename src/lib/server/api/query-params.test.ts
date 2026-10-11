import { describe, expect, it } from "vitest";
import { optionalPositiveIntegerParam } from "./query-params";

describe("optionalPositiveIntegerParam", () => {
	it("reads a whole number of at least one", () => {
		expect(optionalPositiveIntegerParam("1")).toBe(1);
		expect(optionalPositiveIntegerParam("50")).toBe(50);
		expect(optionalPositiveIntegerParam("999999999")).toBe(999_999_999);
	});

	it("reads an absent parameter as not asked", () => {
		expect(optionalPositiveIntegerParam(null)).toBeUndefined();
	});

	it("reads anything else that is present as malformed", () => {
		for (const bad of [
			"",
			"0",
			"-2",
			"1.5",
			"abc",
			"1e3",
			" 3",
			"3 ",
			"+3",
			"1000000000",
			"0x10",
		]) {
			expect(optionalPositiveIntegerParam(bad), bad).toBeNull();
		}
	});
});
