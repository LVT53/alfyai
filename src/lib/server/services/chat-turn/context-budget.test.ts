import { describe, expect, it } from "vitest";
import { deriveModelContextLimits } from "$lib/model-context-defaults";
import { CONTEXT_GUARD_MARGIN_TOKENS } from "../normal-chat-model/context-guard";
import {
	deriveBaselineMemoryProfileBudget,
	deriveCurrentTurnAttachmentBudget,
	deriveDocumentContextDepthBudget,
	deriveExplicitSourceSetBudget,
	deriveModelContextBudget,
	deriveProactiveConnectorContextBudget,
	deriveSessionHistoryBudget,
	fitContextLimitsToRequest,
	resolveCompletionMaxTokens,
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

	describe("pictures of the current message", () => {
		const contextBudget = deriveModelContextBudget({
			maxModelContext: 100_000,
		});
		const withoutPictures = deriveSessionHistoryBudget({
			contextBudget,
			minTotalBudget: 2_000,
			minRecentTurnCount: 3,
		});

		it("take their tokens out of the history budget", () => {
			const withPictures = deriveSessionHistoryBudget({
				contextBudget,
				minTotalBudget: 2_000,
				minRecentTurnCount: 3,
				pictureTokens: 4_400,
			});

			expect(withoutPictures.totalBudget).toBe(58_500);
			expect(withPictures.totalBudget).toBe(54_100);
		});

		it("change nothing when there are none", () => {
			expect(
				deriveSessionHistoryBudget({
					contextBudget,
					minTotalBudget: 2_000,
					minRecentTurnCount: 3,
					pictureTokens: 0,
				}),
			).toEqual(withoutPictures);
		});

		it("never take the history below its floor, nor above what it had", () => {
			const crowded = deriveSessionHistoryBudget({
				contextBudget,
				minTotalBudget: 2_000,
				minRecentTurnCount: 3,
				pictureTokens: 500_000,
			});
			expect(crowded.totalBudget).toBe(2_000);

			// A target below the floor already caps the history at the target.
			const tiny = deriveModelContextBudget({ maxModelContext: 1_000 });
			const small = deriveSessionHistoryBudget({
				contextBudget: tiny,
				minTotalBudget: 2_000,
				minRecentTurnCount: 3,
			});
			expect(
				deriveSessionHistoryBudget({
					contextBudget: tiny,
					minTotalBudget: 2_000,
					minRecentTurnCount: 3,
					pictureTokens: 1_900,
				}).totalBudget,
			).toBe(small.totalBudget);
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

describe("completion-only bounded output policy", () => {
	it.each([
		null,
		undefined,
		NaN,
		Infinity,
		-Infinity,
		0,
		-1,
	])("resolves absent/invalid selected caps from existing context defaults: %s", (maxTokens) => {
		expect(
			resolveCompletionMaxTokens({ maxModelContext: 8192, maxTokens }),
		).toBe(820);
	});
	it("keeps selected cap precedence, then provider cap, then application fallback", () => {
		expect(
			resolveCompletionMaxTokens({
				maxModelContext: 8192,
				maxTokens: 777,
				providerMaxOutputTokens: 321,
			}),
		).toBe(777);
		expect(
			resolveCompletionMaxTokens({
				maxModelContext: 8192,
				maxTokens: null,
				providerMaxOutputTokens: 321,
			}),
		).toBe(321);
		expect(
			resolveCompletionMaxTokens({
				maxModelContext: 8192,
				maxTokens: NaN,
				providerMaxOutputTokens: Infinity,
			}),
		).toBe(820);
		expect(resolveCompletionMaxTokens({ maxModelContext: 262144 })).toBe(26215);
		expect(resolveCompletionMaxTokens({ maxModelContext: undefined })).toBe(
			26215,
		);
		expect(
			resolveCompletionMaxTokens({ maxModelContext: 8192, maxTokens: 777.9 }),
		).toBe(777);
	});
	it("leaves generic nullable budgeting unchanged", () => {
		expect(
			deriveModelContextBudget({ maxModelContext: 8192, maxTokens: null }),
		).toMatchObject({ effectiveMaxTokens: null, outputReserve: 0 });
	});
});

// The engine (normal-chat-model/completion.ts) refuses a request before any
// provider call when messages + system + the tool catalogue + the output cap +
// CONTEXT_GUARD_MARGIN_TOKENS exceed the model's window. A context built to its
// target leaves the first three and the cap no room unless the target itself is
// held back for them: that is what preparation is handed.
describe("fitting the built context to the request around it", () => {
	// What the engine's own count charged for the real catalogue: with no
	// connector, and with all nine (the 2026-11-12 review's measurement).
	const catalogues = [0, 11_595, 16_529] as const;

	type Configuration = {
		name: string;
		maxModelContext: number;
		/** The configured TARGET_CONSTRUCTED_CONTEXT; absent is the default ratio. */
		target?: number;
		/** The configured max output tokens; absent is the application reserve. */
		cap?: number;
		/** The cap the request carries: the configured one, held to what the target leaves. */
		reserve: number;
		configuredTarget: number;
		/** The target the context is built to, for the catalogues above. */
		targets: [number, number, number];
	};
	const configurations: Configuration[] = [
		{
			name: "146,000 with an explicit target of 102,200 (the provider models)",
			maxModelContext: 146_000,
			target: 102_200,
			reserve: 14_600,
			configuredTarget: 102_200,
			targets: [102_200, 102_200, 102_200],
		},
		{
			name: "146,000 on the default ratios",
			maxModelContext: 146_000,
			reserve: 14_600,
			configuredTarget: 131_400,
			targets: [127_304, 115_709, 110_775],
		},
		{
			name: "131,072 on the default ratios",
			maxModelContext: 131_072,
			reserve: 13_108,
			configuredTarget: 117_964,
			targets: [113_868, 102_273, 97_339],
		},
		{
			name: "262,144 with an explicit target of 235,929 and no output cap (MODEL_1)",
			maxModelContext: 262_144,
			target: 235_929,
			reserve: 26_215,
			configuredTarget: 235_929,
			targets: [231_833, 220_238, 215_304],
		},
		{
			name: "262,144 with a 24,576 cap and a target of 102,200",
			maxModelContext: 262_144,
			target: 102_200,
			cap: 24_576,
			reserve: 24_576,
			configuredTarget: 102_200,
			targets: [102_200, 102_200, 102_200],
		},
		{
			// 384,000 is more than the 100,000 the default target leaves: the
			// existing clamp holds the cap to that, and the cap stays 100,000.
			name: "1,000,000 with a 384,000 cap on the default ratios (deepseek-flash)",
			maxModelContext: 1_000_000,
			cap: 384_000,
			reserve: 100_000,
			configuredTarget: 900_000,
			targets: [895_904, 884_309, 879_375],
		},
		{
			name: "1,048,576 with a 65,536 cap on the default ratios (kimi)",
			maxModelContext: 1_048_576,
			cap: 65_536,
			reserve: 65_536,
			configuredTarget: 943_718,
			targets: [943_718, 943_718, 943_718],
		},
		{
			name: "262,144 with a 24,576 cap on the default ratios (qwen3-6-27b)",
			maxModelContext: 262_144,
			cap: 24_576,
			reserve: 24_576,
			configuredTarget: 235_929,
			targets: [233_472, 221_877, 216_943],
		},
	];

	function request(configuration: Configuration) {
		return {
			limits: deriveModelContextLimits({
				maxModelContext: configuration.maxModelContext,
				targetConstructedContext: configuration.target,
			}),
			contextWindow: configuration.maxModelContext,
			maxTokens: resolveCompletionMaxTokens({
				maxModelContext: configuration.maxModelContext,
				maxTokens: configuration.cap,
			}),
			marginTokens: CONTEXT_GUARD_MARGIN_TOKENS,
		};
	}

	describe.each(configurations)("$name", (configuration) => {
		it.each(
			catalogues.map((tokens, index) => [tokens, index] as const),
		)("with a catalogue of %i tokens, a context built to its target plus the request fits the window", (toolCatalogueTokens, index) => {
			const given = request(configuration);
			expect(given.limits.targetConstructedContext).toBe(
				configuration.configuredTarget,
			);
			const fitted = fitContextLimitsToRequest({
				...given,
				toolCatalogueTokens,
			});

			// What preparation derives from what it is handed, with its own rules
			// (resolveOutputTokenBudget and buildConstructedContext): the cap must
			// not be given back, and the target is the one it builds to.
			const downstream = deriveModelContextBudget({
				...fitted.limits,
				maxTokens: fitted.maxTokens,
			});
			expect(fitted.maxTokens).toBe(configuration.reserve);
			expect(downstream.effectiveMaxTokens).toBe(configuration.reserve);
			expect(downstream.targetConstructedContext).toBe(
				configuration.targets[index],
			);
			expect(fitted.limits.targetConstructedContext).toBe(
				configuration.targets[index],
			);
			expect(
				downstream.targetConstructedContext +
					downstream.outputReserve +
					toolCatalogueTokens +
					CONTEXT_GUARD_MARGIN_TOKENS,
			).toBeLessThanOrEqual(configuration.maxModelContext);

			// The window is the model's own; the compaction threshold never sits
			// above a target that was held back.
			expect(fitted.limits.maxModelContext).toBe(given.limits.maxModelContext);
			const lowered =
				fitted.limits.targetConstructedContext <
				given.limits.targetConstructedContext;
			expect(fitted.limits.compactionUiThreshold).toBe(
				lowered
					? Math.min(
							given.limits.compactionUiThreshold,
							fitted.limits.targetConstructedContext,
						)
					: given.limits.compactionUiThreshold,
			);
		});

		it("lowers the target exactly when the configured one did not leave the room", () => {
			const given = request(configuration);
			for (const toolCatalogueTokens of catalogues) {
				const fitted = fitContextLimitsToRequest({
					...given,
					toolCatalogueTokens,
				});
				const unfitted =
					given.limits.targetConstructedContext +
					configuration.reserve +
					toolCatalogueTokens +
					CONTEXT_GUARD_MARGIN_TOKENS;
				if (unfitted > configuration.maxModelContext) {
					expect(fitted.limits.targetConstructedContext).toBeLessThan(
						given.limits.targetConstructedContext,
					);
				} else {
					// Nothing to lower: the same numbers, not a copy that drifts.
					expect(fitted).toEqual({
						limits: given.limits,
						maxTokens: configuration.reserve,
					});
				}
			}
		});
	});

	it("leaves the provider models' 146,000 / 102,200 exactly as configured", () => {
		const given = request(configurations[0]);
		for (const toolCatalogueTokens of catalogues) {
			expect(
				fitContextLimitsToRequest({ ...given, toolCatalogueTokens }),
			).toEqual({ limits: given.limits, maxTokens: 14_600 });
		}
	});

	it("measures the room from the window the engine checks, not from a placeholder in the limits", () => {
		// The provider says 8,192 while the limits carry the 262,144 placeholder:
		// the cap is held to what the limits' own target leaves (as preparation
		// does), and the target to what the real window leaves.
		const limits = deriveModelContextLimits({ maxModelContext: 262_144 });
		const fitted = fitContextLimitsToRequest({
			limits,
			contextWindow: 8_192,
			maxTokens: 820,
			toolCatalogueTokens: 0,
			marginTokens: CONTEXT_GUARD_MARGIN_TOKENS,
		});
		expect(fitted.maxTokens).toBe(820);
		expect(fitted.limits).toEqual({
			maxModelContext: 262_144,
			targetConstructedContext: 8_192 - 820 - CONTEXT_GUARD_MARGIN_TOKENS,
			compactionUiThreshold: 8_192 - 820 - CONTEXT_GUARD_MARGIN_TOKENS,
		});
	});

	it("keeps the cap a clamped turn already had, so the lowered target cannot give it back", () => {
		// 5,000 asked, 7,000 of 8,192 as the target: the target leaves 1,192.
		const limits = {
			maxModelContext: 8_192,
			targetConstructedContext: 7_000,
			compactionUiThreshold: 6_553,
		};
		const fitted = fitContextLimitsToRequest({
			limits,
			contextWindow: 8_192,
			maxTokens: 5_000,
			toolCatalogueTokens: 0,
			marginTokens: CONTEXT_GUARD_MARGIN_TOKENS,
		});
		expect(fitted.maxTokens).toBe(1_192);
		expect(fitted.limits.targetConstructedContext).toBe(
			8_192 - 1_192 - CONTEXT_GUARD_MARGIN_TOKENS,
		);
		// Handing the unclamped 5,000 to preparation would let its own rule
		// (the cap may use what the lowered target leaves) read the cap back as
		// 5,000, and nothing would fit.
		expect(
			deriveModelContextBudget({ ...fitted.limits, maxTokens: 5_000 })
				.effectiveMaxTokens,
		).toBe(5_000);
		expect(
			deriveModelContextBudget({
				...fitted.limits,
				maxTokens: fitted.maxTokens,
			}).effectiveMaxTokens,
		).toBe(1_192);
	});

	it("builds to one token when the window cannot hold the catalogue, and the engine refuses", () => {
		const given = request({
			name: "8,192",
			maxModelContext: 8_192,
			reserve: 820,
			configuredTarget: 7_372,
			targets: [0, 0, 0],
		});
		const fitted = fitContextLimitsToRequest({
			...given,
			toolCatalogueTokens: 11_595,
		});
		expect(fitted.maxTokens).toBe(820);
		expect(fitted.limits.targetConstructedContext).toBe(1);
		expect(fitted.limits.compactionUiThreshold).toBe(1);
		// A tools-off turn on the same window keeps what the margin leaves.
		expect(
			fitContextLimitsToRequest({ ...given, toolCatalogueTokens: 0 }).limits
				.targetConstructedContext,
		).toBe(8_192 - 820 - CONTEXT_GUARD_MARGIN_TOKENS);
	});
});
