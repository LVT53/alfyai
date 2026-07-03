import { describe, expect, it } from "vitest";
import { isOverLength } from "./char-count";

describe("isOverLength", () => {
	it("returns false when the message is under the limit", () => {
		expect(isOverLength(0, 10000)).toBe(false);
		expect(isOverLength(1, 10000)).toBe(false);
		expect(isOverLength(9999, 10000)).toBe(false);
		expect(isOverLength(8, 10)).toBe(false);
	});

	it("returns false when the message is exactly at the limit", () => {
		expect(isOverLength(10000, 10000)).toBe(false);
		expect(isOverLength(10, 10)).toBe(false);
		expect(isOverLength(0, 0)).toBe(false);
	});

	it("returns true when the message exceeds the limit", () => {
		expect(isOverLength(10001, 10000)).toBe(true);
		expect(isOverLength(11, 10)).toBe(true);
		expect(isOverLength(50000, 10000)).toBe(true);
	});
});
