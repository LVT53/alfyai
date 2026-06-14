import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "$lib/server/utils/math";
import {
	detectTopicShift,
	shouldSuppressCarryover,
} from "./topic-shift-detector";

describe("cosineSimilarity", () => {
	it("returns 1 for identical vectors", () => {
		const v = [0.5, 0.5, 0.5];
		expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
	});

	it("returns 0 for orthogonal vectors", () => {
		const a = [1, 0, 0];
		const b = [0, 1, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
	});

	it("returns 0 for empty vectors", () => {
		expect(cosineSimilarity([], [])).toBe(0);
	});

	it("returns 0 for dimension mismatch", () => {
		const a = [1, 0];
		const b = [1, 0, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
	});

	it("returns 0 for zero-magnitude vectors", () => {
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
	});
});

describe("detectTopicShift", () => {
	const embed = (a: number[], b: number[], threshold?: number) =>
		detectTopicShift({
			currentMessageEmbedding: a,
			previousMessageEmbedding: b,
			threshold,
		});

	it("does not detect shift when similarity > 0.5", () => {
		const a = [0.5, 0.5, 0.5, 0.5];
		const b = [0.6, 0.4, 0.6, 0.4];
		const result = embed(a, b);
		expect(result.isShift).toBe(false);
	});

	it("detects shift when similarity < 0.3", () => {
		const a = [1, 0, 0, 0];
		const b = [0, 1, 0, 0];
		const sim = cosineSimilarity(a, b);
		const result = embed(a, b);
		expect(sim).toBeLessThan(0.3);
		expect(result.isShift).toBe(true);
	});

	it("does not detect shift at exact threshold boundary (0.5)", () => {
		const a = [1, 0, 0];
		const b = [0.5, Math.sqrt(1 - 0.5 ** 2), 0];
		const sim = cosineSimilarity(a, b);
		expect(sim).toBeCloseTo(0.5, 5);
		const result = embed(a, b);
		expect(result.isShift).toBe(false);
	});

	it("returns not a shift for empty embeddings", () => {
		const result = embed([], [1, 2, 3]);
		expect(result.isShift).toBe(false);
		expect(result.distance).toBe(0);
	});

	it("returns not a shift for all-zero embeddings", () => {
		const result = embed([0, 0, 0], [0, 0, 0]);
		expect(result.isShift).toBe(false);
		expect(result.distance).toBe(0);
	});

	it("respects custom threshold override", () => {
		const a = [1, 0, 0, 0];
		const b = [0.5, 0.5, 0, 0];
		expect(embed(a, b).isShift).toBe(false);
		const result = embed(a, b, 0.8);
		expect(result.isShift).toBe(true);
	});

	it("returns correct distance = 1 - similarity", () => {
		const a = [1, 0];
		const b = [0, 1];
		const sim = cosineSimilarity(a, b);
		const result = embed(a, b);
		expect(result.distance).toBeCloseTo(1 - sim, 5);
	});
});

describe("shouldSuppressCarryover", () => {
	it("suppresses carryover when isShift is true", () => {
		const result = shouldSuppressCarryover({
			isShift: true,
			hasExplicitResetSignal: false,
			turnsSinceLastShift: 5,
		});
		expect(result).toBe(true);
	});

	it("suppresses carryover when hasExplicitResetSignal is true", () => {
		const result = shouldSuppressCarryover({
			isShift: false,
			hasExplicitResetSignal: true,
			turnsSinceLastShift: 0,
		});
		expect(result).toBe(true);
	});

	it("does not suppress carryover when both are false", () => {
		const result = shouldSuppressCarryover({
			isShift: false,
			hasExplicitResetSignal: false,
			turnsSinceLastShift: 0,
		});
		expect(result).toBe(false);
	});

	it("suppresses when both flags are true", () => {
		const result = shouldSuppressCarryover({
			isShift: true,
			hasExplicitResetSignal: true,
			turnsSinceLastShift: 10,
		});
		expect(result).toBe(true);
	});

	it("ignores turnsSinceLastShift in current implementation", () => {
		const base = { isShift: false, hasExplicitResetSignal: false };
		expect(shouldSuppressCarryover({ ...base, turnsSinceLastShift: 0 })).toBe(
			false,
		);
		expect(shouldSuppressCarryover({ ...base, turnsSinceLastShift: 5 })).toBe(
			false,
		);
		expect(shouldSuppressCarryover({ ...base, turnsSinceLastShift: 100 })).toBe(
			false,
		);
	});
});
