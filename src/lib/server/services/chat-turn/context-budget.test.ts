import { describe, expect, it } from "vitest";
import {
	deriveBaselineMemoryProfileBudget,
	deriveCurrentTurnAttachmentBudget,
	deriveDocumentContextDepthBudget,
	deriveExplicitSourceSetBudget,
	deriveModelContextBudget,
	deriveProactiveConnectorContextBudget,
	deriveSessionHistoryBudget,
} from "./context-budget";

describe("deriveModelContextBudget", () => {
	it("derives target and compaction defaults from usable model context", () => {
		expect(
			deriveModelContextBudget({
				maxModelContext: 1_000_000,
			}),
		).toMatchObject({
			maxModelContext: 1_000_000,
			usableModelContext: 1_000_000,
			targetConstructedContext: 900_000,
			compactionUiThreshold: 800_000,
		});
	});

	it("keeps explicit target and compaction overrides when present", () => {
		expect(
			deriveModelContextBudget({
				maxModelContext: 250_000,
				targetConstructedContext: 180_000,
				compactionUiThreshold: 150_000,
			}),
		).toMatchObject({
			maxModelContext: 250_000,
			targetConstructedContext: 180_000,
			compactionUiThreshold: 150_000,
		});
	});

	it("derives reserved, core, support, and awareness budgets from target context", () => {
		expect(
			deriveModelContextBudget({
				maxModelContext: 1_000_000,
				systemPromptTokens: 12_000,
				currentMessageTokens: 4_000,
				overheadReserveTokens: 512,
			}),
		).toMatchObject({
			targetConstructedContext: 900_000,
			reservedBudget: 90_000,
			coreBudget: 405_000,
			supportBudget: 283_500,
			awarenessBudget: 121_500,
		});
	});

	it("uses maxTokens as output reserve before deriving target and threshold", () => {
		expect(
			deriveModelContextBudget({
				maxModelContext: 1_000_000,
				maxTokens: 100_000,
				systemPromptTokens: 12_000,
				currentMessageTokens: 4_000,
				overheadReserveTokens: 512,
			}),
		).toMatchObject({
			outputReserve: 100_000,
			usableModelContext: 900_000,
			targetConstructedContext: 810_000,
			compactionUiThreshold: 720_000,
			outputReserveClamped: false,
		});
	});

	it("clamps output reserve against an explicit target override", () => {
		expect(
			deriveModelContextBudget({
				maxModelContext: 1_000_000,
				targetConstructedContext: 900_000,
				compactionUiThreshold: 800_000,
				maxTokens: 250_000,
				systemPromptTokens: 12_000,
				currentMessageTokens: 4_000,
				overheadReserveTokens: 512,
			}),
		).toMatchObject({
			outputReserve: 100_000,
			effectiveMaxTokens: 100_000,
			outputReserveClamped: true,
			targetConstructedContext: 900_000,
			compactionUiThreshold: 800_000,
		});
	});

	it("scales current-turn attachment budget from model capacity", () => {
		const contextBudget = deriveModelContextBudget({
			maxModelContext: 1_000_000,
		});

		expect(
			deriveCurrentTurnAttachmentBudget({
				contextBudget,
				attachmentCount: 12,
				minTotalBudget: 6_000,
				minPerAttachmentBudget: 2_400,
			}),
		).toEqual({
			totalBudget: 364_500,
			taskPerAttachmentBudget: 30_375,
			excerptPerAttachmentBudget: 30_375,
		});
	});

	it("scales explicit source-set budgets to preserve breadth", () => {
		const contextBudget = deriveModelContextBudget({
			maxModelContext: 1_000_000,
		});

		expect(
			deriveExplicitSourceSetBudget({
				contextBudget,
				sourceCount: 12,
				minTotalBudget: 9_000,
				minPerSourceBudget: 1_600,
			}),
		).toEqual({
			totalBudget: 240_975,
			perSourceBudget: 20_081,
		});
	});

	it("scales session history budget from model capacity", () => {
		const contextBudget = deriveModelContextBudget({
			maxModelContext: 1_000_000,
		});

		expect(
			deriveSessionHistoryBudget({
				contextBudget,
				minTotalBudget: 2_000,
				minRecentTurnCount: 3,
			}),
		).toEqual({
			totalBudget: 585_000,
			recentTurnCount: 32,
		});
	});

	it("derives baseline memory profile budget with a generous floor and ceiling", () => {
		expect(
			deriveBaselineMemoryProfileBudget({
				contextBudget: { targetConstructedContext: 40_000 },
			}),
		).toEqual({ totalBudget: 8_000 });

		expect(
			deriveBaselineMemoryProfileBudget({
				contextBudget: { targetConstructedContext: 250_000 },
			}),
		).toEqual({ totalBudget: 8_000 });

		expect(
			deriveBaselineMemoryProfileBudget({
				contextBudget: { targetConstructedContext: 1_000_000 },
			}),
		).toEqual({ totalBudget: 20_000 });
	});

	it("derives a proactive connector context budget with a much smaller floor/ceiling than the baseline memory profile", () => {
		expect(
			deriveProactiveConnectorContextBudget({
				contextBudget: { targetConstructedContext: 40_000 },
			}),
		).toEqual({ totalBudget: 300 });

		expect(
			deriveProactiveConnectorContextBudget({
				contextBudget: { targetConstructedContext: 250_000 },
			}),
		).toEqual({ totalBudget: 1_000 });

		// Ceiling clamps even a very large model context.
		expect(
			deriveProactiveConnectorContextBudget({
				contextBudget: { targetConstructedContext: 1_000_000 },
			}),
		).toEqual({ totalBudget: 1_200 });
	});

	it("honors custom min/max overrides for the proactive connector context budget", () => {
		expect(
			deriveProactiveConnectorContextBudget({
				contextBudget: { targetConstructedContext: 1_000_000 },
				minTotalBudget: 100,
				maxTotalBudget: 500,
			}),
		).toEqual({ totalBudget: 500 });
	});

	it("scales document depth from intent and preserves breadth across model sizes", () => {
		const smallContext = deriveModelContextBudget({ maxModelContext: 32_000 });
		const mediumContext = deriveModelContextBudget({
			maxModelContext: 250_000,
		});
		const largeContext = deriveModelContextBudget({
			maxModelContext: 1_000_000,
		});

		expect(
			deriveDocumentContextDepthBudget({
				contextBudget: smallContext,
				documentCount: 1,
				intent: "reference",
			}),
		).toMatchObject({
			depth: "reference",
			perArtifactLimit: 2,
			useFullContent: false,
		});

		const answerDepth = deriveDocumentContextDepthBudget({
			contextBudget: mediumContext,
			documentCount: 1,
			intent: "answer",
		});
		expect(answerDepth).toMatchObject({
			depth: "excerpt",
			perArtifactLimit: 4,
			useFullContent: false,
		});
		expect(answerDepth.perArtifactCharBudget).toBeGreaterThan(1_400);

		const taskDepth = deriveDocumentContextDepthBudget({
			contextBudget: largeContext,
			documentCount: 1,
			intent: "task",
		});
		expect(taskDepth).toMatchObject({
			depth: "task",
			perArtifactLimit: 8,
			useFullContent: true,
		});
		expect(taskDepth.perArtifactCharBudget).toBeGreaterThan(12_000);

		const directDepth = deriveDocumentContextDepthBudget({
			contextBudget: mediumContext,
			documentCount: 1,
			intent: "direct",
		});
		expect(directDepth).toMatchObject({
			depth: "task",
			perArtifactLimit: 8,
			useFullContent: true,
		});
		expect(directDepth.perArtifactCharBudget).toBeGreaterThanOrEqual(20_000);

		const broadTaskDepth = deriveDocumentContextDepthBudget({
			contextBudget: largeContext,
			documentCount: 12,
			intent: "task",
		});
		expect(broadTaskDepth.depth).toBe("task");
		expect(broadTaskDepth.perArtifactLimit).toBe(8);
		expect(broadTaskDepth.totalCharBudget).toBeGreaterThan(
			taskDepth.perArtifactCharBudget,
		);
		expect(broadTaskDepth.perArtifactCharBudget).toBeLessThan(
			taskDepth.perArtifactCharBudget,
		);
		expect(broadTaskDepth.perArtifactCharBudget).toBeGreaterThan(1_400);
	});

	it("sizes document text for the default context window in characters, with a separate token cap", () => {
		const defaultContext = deriveModelContextBudget({
			maxModelContext: 262_144,
			targetConstructedContext: 157_286,
			compactionUiThreshold: 209_715,
		});
		const sizes = (["reference", "answer", "task", "direct"] as const).map(
			(intent) => {
				const budget = deriveDocumentContextDepthBudget({
					contextBudget: defaultContext,
					documentCount: 1,
					intent,
				});
				return {
					intent,
					perArtifactCharBudget: budget.perArtifactCharBudget,
					totalCharBudget: budget.totalCharBudget,
					totalTokenBudget: budget.totalTokenBudget,
				};
			},
		);

		// Pinned: these are the per-document excerpt sizes that reach the model
		// on a default 262k-context model. Changing them changes how much
		// document text every document-grounded turn carries.
		expect(sizes).toEqual([
			{
				intent: "reference",
				perArtifactCharBudget: 1_400,
				totalCharBudget: 8_918,
				totalTokenBudget: 8_918,
			},
			{
				intent: "answer",
				perArtifactCharBudget: 18_000,
				totalCharBudget: 22_295,
				totalTokenBudget: 22_295,
			},
			{
				intent: "task",
				perArtifactCharBudget: 42_113,
				totalCharBudget: 42_113,
				totalTokenBudget: 42_113,
			},
			{
				intent: "direct",
				perArtifactCharBudget: 46_006,
				totalCharBudget: 46_006,
				totalTokenBudget: 46_006,
			},
		]);
	});
});
