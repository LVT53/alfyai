import { describe, expect, it } from "vitest";
import { isSameEmailAddress, normalizeEmailAddress } from "./email-address";

describe("normalizeEmailAddress", () => {
	it("trims and lowercases, which is how the server stores an address", () => {
		expect(normalizeEmailAddress("  New-Address@Example.COM ")).toBe(
			"new-address@example.com",
		);
	});

	it("leaves a normal address as it is", () => {
		expect(normalizeEmailAddress("ada@example.com")).toBe("ada@example.com");
	});
});

describe("isSameEmailAddress", () => {
	it("is true for the same address in other letters or with spaces", () => {
		expect(isSameEmailAddress("ADA@Example.com", "ada@example.com")).toBe(true);
		expect(isSameEmailAddress("  ada@example.com ", "ada@example.com")).toBe(
			true,
		);
	});

	it("reads both sides the same way, so a stored address in capitals matches too", () => {
		expect(isSameEmailAddress("ada@example.com", "Ada@Example.com")).toBe(true);
	});

	it("is false for another address", () => {
		expect(isSameEmailAddress("ada@example.com", "bob@example.com")).toBe(
			false,
		);
		expect(isSameEmailAddress("", "ada@example.com")).toBe(false);
	});
});
