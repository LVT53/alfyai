import { describe, expect, it } from "vitest";
import { newId } from "./ids";

describe("newId", () => {
	it("mints prefix-time-counter ids, in base 36", () => {
		expect(newId("pen")).toMatch(/^pen-[0-9a-z]+-[0-9a-z]+$/);
	});

	it("never repeats within a session, even inside one millisecond", () => {
		const ids = new Set(Array.from({ length: 5000 }, () => newId("e")));
		expect(ids.size).toBe(5000);
	});

	it("stays inside the body's 128-character id limit for any sane prefix", () => {
		expect(newId("highlighter").length).toBeLessThanOrEqual(128);
	});
});
