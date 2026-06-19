import { describe, expect, it, vi } from "vitest";
import type { DepthMetadata } from "$lib/types";
import {
	evaluateDepthClarificationGate,
	normalizeDepthClarificationClassifierDecision,
	renderDepthClarificationQuestion,
} from "./depth-clarification";

const highCostDepthMetadata: DepthMetadata = {
	requested: "auto",
	appliedProfile: "maximum",
	fallback: false,
	signals: {
		contextBreadth: "broad",
		outputRoom: "expanded",
		toolUse: "source_heavy",
	},
};

describe("Depth Clarification gate", () => {
	it("bypasses low-cost depth profiles deterministically", async () => {
		const result = await evaluateDepthClarificationGate({
			message: "Explain this function.",
			depthMetadata: {
				requested: "auto",
				appliedProfile: "standard",
				fallback: false,
			},
			classifier: vi.fn(),
		});

		expect(result.action).toBe("bypass");
	});

	it("renders Hungarian clarification text without model prose fallback", async () => {
		const text = renderDepthClarificationQuestion("hu");

		expect(text).toContain("Meg tudom csinálni");
		expect(text).toContain("Melyik platformot");
		expect(text).not.toContain("I can do that");
	});

	it("uses an injectable classifier hook when deterministic rules do not decide", async () => {
		const classifier = vi.fn(async () => ({
			outcome: "ask" as const,
			reason: "classifier",
			question: "Please choose a target.",
		}));

		const result = await evaluateDepthClarificationGate({
			message: "Investigate the migration risk.",
			depthMetadata: highCostDepthMetadata,
			classifier,
			language: "en",
		});

		expect(classifier).toHaveBeenCalledWith({
			message: "Investigate the migration risk.",
			depthMetadata: highCostDepthMetadata,
			language: "en",
		});
		expect(result).toMatchObject({
			action: "ask",
			text: "Please choose a target.",
			depthMetadata: {
				outcome: "clarification_requested",
				clarification: {
					outcome: "ask",
					reason: "classifier",
					classifierSource: "injected",
				},
			},
		});
	});

	it("blocks classifier clarification when the high-cost request is answerable", async () => {
		const classifier = vi.fn(async () => ({
			outcome: "ask" as const,
			reason: "classifier",
			question: "Please choose a target.",
		}));

		const result = await evaluateDepthClarificationGate({
			message:
				"Compare enterprise research assistant architectures for a SaaS team with cost, latency, citations, and Hungarian support constraints.",
			depthMetadata: highCostDepthMetadata,
			classifier,
			language: "en",
		});

		expect(result).toMatchObject({
			action: "proceed",
			depthMetadata: {
				outcome: "proceeded_with_assumption",
				clarification: {
					outcome: "proceed_with_assumption",
					reason: "classifier",
				},
			},
		});
	});

	it("still asks when the user explicitly leaves the target unknown", async () => {
		const result = await evaluateDepthClarificationGate({
			message:
				"Research all viable platform options for an unspecified source set and build a complete migration plan.",
			depthMetadata: highCostDepthMetadata,
			language: "en",
		});

		expect(result).toMatchObject({
			action: "ask",
			depthMetadata: {
				clarification: {
					outcome: "ask",
					reason: "multiple_plausible_targets",
				},
			},
		});
	});

	it("normalizes malformed classifier decisions to null", () => {
		expect(
			normalizeDepthClarificationClassifierDecision({
				outcome: "unexpected" as "ask",
				reason: "classifier",
			}),
		).toBeNull();
	});
});
