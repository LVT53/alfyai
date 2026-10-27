import { describe, expect, it } from "vitest";
import { freshSeed, SEED_MAX } from "./seeds";

describe("freshSeed", () => {
	it("never returns a seed it must avoid", () => {
		const draws = [0.5, 0.5, 0.25];
		const avoided = freshSeed([], () => 0.5);
		const next = freshSeed([avoided], () => draws.shift() as number);
		expect(next).not.toBe(avoided);
		expect(draws).toEqual([]);
	});

	it("returns a whole number between 1 and SEED_MAX", () => {
		for (let i = 0; i < 1000; i++) {
			const seed = freshSeed([], Math.random);
			expect(Number.isInteger(seed)).toBe(true);
			expect(seed).toBeGreaterThanOrEqual(1);
			expect(seed).toBeLessThanOrEqual(SEED_MAX);
		}
		expect(freshSeed([], () => 0.999999999)).toBeLessThanOrEqual(SEED_MAX);
		expect(freshSeed([], () => 0)).toBe(1);
	});
});
