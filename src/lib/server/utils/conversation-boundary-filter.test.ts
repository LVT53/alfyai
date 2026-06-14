import { describe, expect, it } from "vitest";
import {
	applyConversationBoundaryPenalty,
	isCrossConversationArtifactEligible,
	shouldIncludePersonaMemoryInGeneratedContext,
} from "./conversation-boundary-filter";

describe("conversation-boundary-filter", () => {
	describe("isCrossConversationArtifactEligible", () => {
		it("cross-conversation artifact with matchScore=0 is not eligible", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: "conv-2",
				currentConversationId: "conv-1",
				matchScore: 0,
				explicitlyRequested: false,
			});
			expect(result).toBe(false);
		});

		it("cross-conversation artifact with matchScore=2 is not eligible (below threshold 3)", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: "conv-2",
				currentConversationId: "conv-1",
				matchScore: 2,
				explicitlyRequested: false,
			});
			expect(result).toBe(false);
		});

		it("cross-conversation artifact with matchScore=3 is eligible", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: "conv-2",
				currentConversationId: "conv-1",
				matchScore: 3,
				explicitlyRequested: false,
			});
			expect(result).toBe(true);
		});

		it("cross-conversation artifact with strong semantic confidence is eligible despite weak lexical match", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: "conv-2",
				currentConversationId: "conv-1",
				matchScore: 0,
				semanticScore: 0.82,
				explicitlyRequested: false,
			});
			expect(result).toBe(true);
		});

		it("cross-conversation artifact with strong rerank confidence is eligible despite weak lexical match", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: "conv-2",
				currentConversationId: "conv-1",
				matchScore: 0,
				rerankScore: 0.84,
				explicitlyRequested: false,
			});
			expect(result).toBe(true);
		});

		it("cross-conversation artifact with only weak lexical and semantic noise is not eligible", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: "conv-2",
				currentConversationId: "conv-1",
				matchScore: 1,
				semanticScore: 0.42,
				rerankScore: 0.38,
				explicitlyRequested: false,
			});
			expect(result).toBe(false);
		});

		it("cross-conversation artifact with matchScore=0 but explicitlyRequested=true is eligible", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: "conv-2",
				currentConversationId: "conv-1",
				matchScore: 0,
				explicitlyRequested: true,
			});
			expect(result).toBe(true);
		});

		it("same-conversation artifact with matchScore=0 is eligible", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: "conv-1",
				currentConversationId: "conv-1",
				matchScore: 0,
				explicitlyRequested: false,
			});
			expect(result).toBe(true);
		});

		it("artifact with null conversationId is eligible regardless of matchScore", () => {
			const result = isCrossConversationArtifactEligible({
				artifactConversationId: null,
				currentConversationId: "conv-1",
				matchScore: 0,
				explicitlyRequested: false,
			});
			expect(result).toBe(true);
		});
	});

	describe("applyConversationBoundaryPenalty", () => {
		it("same conversation returns score unchanged", () => {
			const result = applyConversationBoundaryPenalty({
				score: 10,
				isSameConversation: true,
				daysSinceLastAccess: 30,
			});
			expect(result).toBe(10);
		});

		it("cross conversation with 0 days has no penalty", () => {
			const result = applyConversationBoundaryPenalty({
				score: 10,
				isSameConversation: false,
				daysSinceLastAccess: 0,
			});
			expect(result).toBe(10);
		});

		it("cross conversation decay follows exp(-0.05 × days)", () => {
			const result = applyConversationBoundaryPenalty({
				score: 10,
				isSameConversation: false,
				daysSinceLastAccess: 10,
			});
			const expected = 10 * Math.exp(-0.05 * 10);
			expect(result).toBeCloseTo(expected, 10);
		});

		it("cross conversation floor is 0", () => {
			const result = applyConversationBoundaryPenalty({
				score: 10,
				isSameConversation: false,
				daysSinceLastAccess: 200,
			});
			expect(result).toBeGreaterThanOrEqual(0);
			expect(result).toBeLessThan(0.001);
		});

		it("cross conversation decay is monotonic with days", () => {
			const day0 = applyConversationBoundaryPenalty({
				score: 10,
				isSameConversation: false,
				daysSinceLastAccess: 0,
			});
			const day20 = applyConversationBoundaryPenalty({
				score: 10,
				isSameConversation: false,
				daysSinceLastAccess: 20,
			});
			expect(day0).toBeGreaterThan(day20);
		});
	});

	describe("shouldIncludePersonaMemoryInGeneratedContext", () => {
		it("normal chat (isGeneratedDocumentRequest=false) always includes memory", () => {
			const result = shouldIncludePersonaMemoryInGeneratedContext({
				memoryCanonicalText: "user prefers dark mode",
				currentQuery: "how do I change themes",
				queryOverlap: 0,
				isGeneratedDocumentRequest: false,
			});
			expect(result).toBe(true);
		});

		it("generated document request with zero query overlap does not include memory", () => {
			const result = shouldIncludePersonaMemoryInGeneratedContext({
				memoryCanonicalText: "user prefers dark mode",
				currentQuery: "how do I change themes",
				queryOverlap: 0,
				isGeneratedDocumentRequest: true,
			});
			expect(result).toBe(false);
		});

		it("generated document request with query overlap of 1 does not include memory", () => {
			const result = shouldIncludePersonaMemoryInGeneratedContext({
				memoryCanonicalText: "user prefers dark mode",
				currentQuery: "dark mode preference",
				queryOverlap: 1,
				isGeneratedDocumentRequest: true,
			});
			expect(result).toBe(false);
		});

		it("generated document request with query overlap of 2 includes memory", () => {
			const result = shouldIncludePersonaMemoryInGeneratedContext({
				memoryCanonicalText: "user prefers dark mode",
				currentQuery: "dark mode preference and colors",
				queryOverlap: 2,
				isGeneratedDocumentRequest: true,
			});
			expect(result).toBe(true);
		});

		it("generated document request with high query overlap includes memory", () => {
			const result = shouldIncludePersonaMemoryInGeneratedContext({
				memoryCanonicalText: "user prefers dark mode settings",
				currentQuery: "dark mode settings and theme customization",
				queryOverlap: 5,
				isGeneratedDocumentRequest: true,
			});
			expect(result).toBe(true);
		});
	});
});
