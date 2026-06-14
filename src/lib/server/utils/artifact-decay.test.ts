import { describe, expect, it } from "vitest";
import {
	computeCrossConversationDecay,
	computeDecayScore,
} from "./artifact-decay";

describe("artifact-decay", () => {
	describe("computeDecayScore", () => {
		it("old artifact with no query match returns heavily decayed value", () => {
			const score = computeDecayScore({
				importance: 1.0,
				ageSeconds: 86400,
				staleSeconds: 86400,
				queryOverlap: 0,
				queryLength: 5,
			});
			expect(score).toBeLessThan(0.5);
		});

		it("fresh artifact with high query match returns strong value", () => {
			const score = computeDecayScore({
				importance: 2.5,
				ageSeconds: 0,
				staleSeconds: 0,
				queryOverlap: 4,
				queryLength: 5,
			});
			expect(score).toBeGreaterThan(2.0);
		});

		it("uses default decayRate of 0.001 when not specified", () => {
			const score = computeDecayScore({
				importance: 1.0,
				ageSeconds: 1000,
				staleSeconds: 0,
				queryOverlap: 0,
				queryLength: 0,
			});
			expect(score).toBeCloseTo(0.368, 2);
		});

		it("applies custom decayRate when specified", () => {
			const score = computeDecayScore({
				importance: 1.0,
				ageSeconds: 1000,
				staleSeconds: 0,
				queryOverlap: 0,
				queryLength: 0,
				decayRate: 0.01,
			});
			expect(score).toBeCloseTo(0.000045, 5);
		});

		it("query overlap boost is 0 when queryLength is 0", () => {
			const score = computeDecayScore({
				importance: 1.0,
				ageSeconds: 0,
				staleSeconds: 0,
				queryOverlap: 5,
				queryLength: 0,
			});
			expect(score).toBe(1.0);
		});

		it("stale penalty compounds with age decay", () => {
			const notStale = computeDecayScore({
				importance: 1.0,
				ageSeconds: 100,
				staleSeconds: 0,
				queryOverlap: 0,
				queryLength: 0,
			});
			const veryStale = computeDecayScore({
				importance: 1.0,
				ageSeconds: 100,
				staleSeconds: 100,
				queryOverlap: 0,
				queryLength: 0,
			});
			expect(veryStale).toBeLessThan(notStale);
		});
	});

	describe("computeCrossConversationDecay", () => {
		it("same conversation returns baseScore unchanged", () => {
			const score = computeCrossConversationDecay({
				baseScore: 10,
				daysSinceLastAccess: 0,
				isSameConversation: true,
			});
			expect(score).toBe(10.0);
		});

		it("same conversation ignores daysSinceLastAccess", () => {
			const score = computeCrossConversationDecay({
				baseScore: 10,
				daysSinceLastAccess: 30,
				isSameConversation: true,
			});
			expect(score).toBe(10.0);
		});

		it("cross conversation 7 days decays significantly", () => {
			const score = computeCrossConversationDecay({
				baseScore: 10,
				daysSinceLastAccess: 7,
				isSameConversation: false,
			});
			expect(score).toBeLessThan(10);
			expect(score).toBeGreaterThan(0);
		});

		it("cross conversation with 0 days has no penalty", () => {
			const score = computeCrossConversationDecay({
				baseScore: 10,
				daysSinceLastAccess: 0,
				isSameConversation: false,
			});
			expect(score).toBe(10.0);
		});

		it("cross conversation floor is 0", () => {
			const score = computeCrossConversationDecay({
				baseScore: 10,
				daysSinceLastAccess: 100,
				isSameConversation: false,
			});
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThan(1);
		});

		it("cross conversation decay is monotonic with days", () => {
			const day0 = computeCrossConversationDecay({
				baseScore: 10,
				daysSinceLastAccess: 0,
				isSameConversation: false,
			});
			const day10 = computeCrossConversationDecay({
				baseScore: 10,
				daysSinceLastAccess: 10,
				isSameConversation: false,
			});
			const day20 = computeCrossConversationDecay({
				baseScore: 10,
				daysSinceLastAccess: 20,
				isSameConversation: false,
			});
			expect(day0).toBeGreaterThan(day10);
			expect(day10).toBeGreaterThan(day20);
		});
	});
});
