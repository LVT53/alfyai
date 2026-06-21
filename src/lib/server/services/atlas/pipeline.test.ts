import { describe, expect, it, vi } from "vitest";
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import type { RunAtlasPipelineInput } from "./pipeline";
import type {
	AtlasGapProposal,
	AtlasPipelineJobContext,
	AtlasProfile,
} from "./types";

describe("Atlas pipeline slices", () => {
	function stageUsage(inputTokens = 1, outputTokens = 1) {
		return {
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
			costUsdMicros: 1,
		};
	}

	function atlasJob(input: {
		id: string;
		profile: AtlasProfile;
		query?: string;
		title?: string;
	}): AtlasPipelineJobContext {
		return {
			id: input.id,
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			action: "create" as const,
			parentAtlasJobId: null,
			profile: input.profile,
			title: input.title ?? "Gap Fill Atlas",
			query:
				input.query ??
				"Compare current enterprise RAG architectures for regulated SaaS",
			lifecycle: {
				family: {
					familyId: input.id,
					mode: "new_family" as const,
					action: "create" as const,
					rootAtlasJobId: input.id,
					currentAtlasJobId: input.id,
					parentAtlasJobId: null,
					forkedFromAtlasJobId: null,
				},
				seed: null,
			},
		};
	}

	function gapProposal(input: {
		targetSearchQuery: string;
		missingQuestion?: string;
		whyCurrentEvidenceIsWeak?: string;
		desiredEvidenceType?: string;
		affectedSection?: string;
		priority?: AtlasGapProposal["priority"];
	}): AtlasGapProposal {
		return {
			missingQuestion:
				input.missingQuestion ??
				"Which current evidence answers the report section with source-grounded detail?",
			whyCurrentEvidenceIsWeak:
				input.whyCurrentEvidenceIsWeak ??
				"Current Evidence Packs cover the report section only thinly, and no accepted source gives current evidence for the requested comparison.",
			targetSearchQuery: input.targetSearchQuery,
			desiredEvidenceType:
				input.desiredEvidenceType ?? "official current web source",
			affectedSection: input.affectedSection ?? "Evidence gaps",
			priority: input.priority ?? "high",
		};
	}

	function coverageReviewText(
		proposals: AtlasGapProposal[],
		sufficient = false,
	): string {
		return JSON.stringify({ sufficient, proposals });
	}

	function assembledReport(): string {
		return [
			"# Gap Fill Atlas",
			"",
			"## Executive Summary",
			"The accepted evidence supports a current enterprise RAG architecture comparison with explicit limits around source coverage, cost signals, and adoption evidence.",
			"",
			"## Findings",
			"Initial and gap-fill evidence should be merged before synthesis so the report can compare architecture, cost, adoption, and contested evidence without starting another Atlas job.",
			"",
			"## Limitations",
			"Remaining stale or contested evidence is stated as a limitation instead of triggering unbounded research.",
		].join("\n");
	}

	function substantiveExecutiveSummary(): string {
		return [
			"## Executive Summary",
			"The accepted evidence supports a current enterprise RAG architecture comparison with explicit limits around source coverage, cost signals, and adoption evidence. The report should use the model-generated title only in app-owned chrome while the body starts with this executive summary and continues with source-grounded findings for regulated SaaS teams.",
			"",
			"## Findings",
			"Hybrid retrieval, reranking, and governance logging remain the strongest architecture pattern when teams need exact policy recall, semantic discovery, and auditable evidence trails. The evidence base is narrow enough that remaining uncertainty should be stated as a limitation instead of hidden behind broader claims.",
			"",
			"## Limitations",
			"Accepted sources are representative rather than exhaustive, so the report should avoid unsupported certainty.",
		].join("\n");
	}

	it("uses a valid structured generated title as the canonical document title and checkpoints section briefs", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const checkpoints: Array<{
			roundNumber: number;
			checkpoint: Record<string, unknown>;
			documentSourceSummary: Record<string, unknown>;
		}> = [];
		const applyGeneratedTitle = vi.fn(async () => {});
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-generated-title",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		const result = await runAtlasPipeline({
			job: atlasJob({
				id: "atlas-generated-title",
				profile: "overview",
				title: "Compare current enterprise RAG architectures",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-rag",
							title: "Enterprise RAG architecture evidence",
							url: "https://example.com/rag",
							snippet:
								"Fetched page excerpt: 2026 enterprise RAG architecture evidence covers hybrid retrieval, reranking, and governance logging for regulated teams.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "2026 enterprise RAG architecture regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle:
									"Enterprise RAG Architecture Strategy for Regulated SaaS",
								bodyMarkdown: substantiveExecutiveSummary(),
								sectionBriefs: [
									{
										sectionTitle: "Executive Summary",
										brief:
											"Summarizes the architecture recommendation and its evidence limits.",
										evidencePackIds: ["pack-web-rag"],
										sourceAssociations: [
											{
												sourceId: "web-rag",
												sourceKind: "web",
												sourceTitle: "Enterprise RAG architecture evidence",
												evidencePackId: "pack-web-rag",
												relevance:
													"Supports hybrid retrieval, reranking, and governance logging claims.",
											},
										],
									},
								],
							}),
							usage: stageUsage(),
						};
					}
					return { text: `${input.stage} result`, usage: stageUsage() };
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpoints.push(input as (typeof checkpoints)[number]);
				}),
				renderOutputs,
				applyGeneratedTitle,
			},
		});

		expect(applyGeneratedTitle).toHaveBeenCalledWith({
			jobId: "atlas-generated-title",
			title: "Enterprise RAG Architecture Strategy for Regulated SaaS",
		});
		expect(result.title).toBe(
			"Enterprise RAG Architecture Strategy for Regulated SaaS",
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Enterprise RAG Architecture Strategy for Regulated SaaS",
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "heading",
						text: "Executive Summary",
					}),
				]),
			}),
		);
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				assembly: {
					version: "atlas.assembly.v1",
					generatedTitle:
						"Enterprise RAG Architecture Strategy for Regulated SaaS",
					sectionBriefs: [
						{
							sectionTitle: "Executive Summary",
							evidencePackIds: ["pack-web-rag"],
							sourceAssociations: [
								expect.objectContaining({
									sourceId: "web-rag",
									evidencePackId: "pack-web-rag",
								}),
							],
						},
					],
				},
			},
			documentSourceSummary: {
				title: "Enterprise RAG Architecture Strategy for Regulated SaaS",
			},
		});
	});

	it("passes Evidence Packs and section briefs into basis audit and checkpoints Claim Basis data", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const checkpoints: Array<{
			roundNumber: number;
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
			documentSourceSummary: Record<string, unknown>;
		}> = [];
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-claim-basis",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));
		const auditBasis = vi.fn(async (input) => {
			const packId = input.evidencePacks[0]?.id ?? "missing-pack";
			return {
				passed: true,
				honestyMarkers: [],
				retryRequested: false,
				claimBasis: [
					{
						version: "atlas.claim-basis.v1" as const,
						id: "atlas-claim-test",
						locator: {
							sectionTitle: "Executive Summary",
							paragraphIndex: 0,
							claimIndex: 0,
							claimText:
								"Hybrid retrieval remains the strongest architecture pattern.",
							quote:
								"Hybrid retrieval remains the strongest architecture pattern",
							startOffset: 0,
							endOffset: 63,
						},
						supportLevel: "supported" as const,
						evidencePackIds: [packId],
						sourceRefs: input.evidencePacks[0]?.sourceRefs ?? [],
						supportRationale:
							"The accepted Evidence Pack supports the hybrid retrieval recommendation.",
						auditConcernCode: null,
					},
				],
				basisLimitations: [],
				basisDiagnostics: [
					{
						code: "atlas_claim_basis_generated",
						severity: "info" as const,
						message: "Claim Basis generated for accepted evidence.",
					},
				],
				claimBasisCoverageBySection: [
					{
						sectionTitle: "Executive Summary",
						factualClaimCount: 1,
						basisCount: 1,
						supportedCount: 1,
						partialCount: 0,
						unsupportedCount: 0,
						density: 1,
					},
				],
				claimBasisStatus: "succeeded" as const,
				claimBasisFailureReason: null,
			};
		});

		await runAtlasPipeline({
			job: atlasJob({
				id: "atlas-claim-basis-checkpoint",
				profile: "overview",
				title: "Claim Basis Atlas",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-rag",
							title: "Enterprise RAG architecture evidence",
							url: "https://example.com/rag",
							snippet:
								"Fetched page excerpt: 2026 enterprise RAG architecture evidence covers hybrid retrieval, reranking, and governance logging for regulated teams.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "2026 enterprise RAG architecture regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "Claim Basis Architecture Atlas",
								bodyMarkdown: substantiveExecutiveSummary(),
								sectionBriefs: [
									{
										sectionTitle: "Executive Summary",
										brief:
											"Summarizes the architecture recommendation and support limits.",
										evidencePackIds: [],
										sourceAssociations: [
											{
												sourceId: "web-rag",
												sourceKind: "web",
												sourceTitle: "Enterprise RAG architecture evidence",
												relevance:
													"Supports hybrid retrieval and reranking claims.",
											},
										],
									},
								],
							}),
							usage: stageUsage(),
						};
					}
					return { text: `${input.stage} result`, usage: stageUsage() };
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async (input) => {
					checkpoints.push(input as (typeof checkpoints)[number]);
				}),
				renderOutputs,
			},
		});

		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				evidencePacks: [
					expect.objectContaining({
						sourceRefs: [
							expect.objectContaining({
								id: "web-rag",
								kind: "web",
							}),
						],
					}),
				],
				sectionBriefs: [
					expect.objectContaining({
						sectionTitle: "Executive Summary",
					}),
				],
				assemblyMetadata: expect.objectContaining({
					generatedTitle: "Claim Basis Architecture Atlas",
				}),
			}),
		);
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				claimBasis: [
					expect.objectContaining({
						id: "atlas-claim-test",
						supportLevel: "supported",
					}),
				],
				basisDiagnostics: [
					expect.objectContaining({ code: "atlas_claim_basis_generated" }),
				],
				claimBasisFailureReason: null,
				claimBasisCoverageBySection: [
					expect.objectContaining({
						sectionTitle: "Executive Summary",
						density: 1,
					}),
				],
			},
			qualityDiagnostics: {
				claimBasis: [expect.objectContaining({ id: "atlas-claim-test" })],
				basisDiagnostics: [
					expect.objectContaining({ code: "atlas_claim_basis_generated" }),
				],
			},
			documentSourceSummary: {
				claimBasis: expect.objectContaining({
					status: "succeeded",
					count: 1,
				}),
			},
		});
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "paragraph",
						basisMarkers: expect.arrayContaining([
							expect.objectContaining({
								id: "atlas-claim-test",
								support: "supported",
							}),
						]),
					}),
				]),
			}),
		);
	});

	it("keeps the job title fallback when structured generated title is invalid", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const applyGeneratedTitle = vi.fn(async () => {});
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-invalid-title",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));
		const job = atlasJob({
			id: "atlas-invalid-title",
			profile: "overview",
			title: "Current AI Regulation Fallback",
		});
		job.lifecycle.seed = {
			parentAtlasJobId: "atlas-parent",
			compressedFindings: { generatedTitle: "Parent Generated Title" },
			curatedSourcePool: null,
			checkpoint: {
				assembly: { generatedTitle: "Parent Generated Title" },
			},
			documentSourceSummary: { title: "Parent Generated Title" },
		};

		const result = await runAtlasPipeline({
			job,
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-ai-reg",
							title: "Current AI regulation evidence",
							url: "https://example.com/ai-regulation",
							snippet:
								"Fetched page excerpt: 2026 AI regulation evidence covers enforcement updates and source limitations for enterprise policy teams.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "2026 AI regulation enforcement enterprise policy",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "  ",
								reportMarkdown: substantiveExecutiveSummary(),
							}),
							usage: stageUsage(),
						};
					}
					return { text: `${input.stage} result`, usage: stageUsage() };
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
				applyGeneratedTitle,
			},
		});

		expect(applyGeneratedTitle).not.toHaveBeenCalled();
		expect(result.title).toBe("Current AI Regulation Fallback");
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Current AI Regulation Fallback",
			}),
		);
	});

	it("runs two useful Exhaustive gap-fill rounds inside the same Atlas job and stops by the profile cap", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const searchWeb = vi
			.fn()
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-initial",
						title: "Initial RAG architecture evidence",
						url: "https://example.com/rag-architecture",
						snippet:
							"Fetched page excerpt: 2026 architecture evidence covers hybrid retrieval and governance but not cost benchmarks or adoption data.",
					},
				],
				rejectedSources: [],
				limitation: null,
			})
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-cost",
						title: "2026 RAG cost benchmark",
						url: "https://example.com/rag-cost-benchmark",
						snippet:
							"Fetched page excerpt: 2026 benchmark evidence compares cost per query for hybrid retrieval, reranking, and governance logging.",
					},
				],
				rejectedSources: [],
				limitation: null,
			})
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-adoption",
						title: "2026 regulated SaaS RAG adoption survey",
						url: "https://example.com/rag-adoption-survey",
						snippet:
							"Fetched page excerpt: 2026 adoption evidence reports regulated SaaS teams choosing hybrid RAG when auditability and exact policy language matter.",
					},
				],
				rejectedSources: [],
				limitation: null,
			});
		const checkpoints: Array<{
			roundNumber: number;
			checkpoint: Record<string, unknown>;
			curatedSourcePool: { web?: unknown[] };
			qualityDiagnostics: unknown;
		}> = [];
		let coverageReviewCalls = 0;

		const result = await runAtlasPipeline({
			job: atlasJob({ id: "atlas-gap-cap", profile: "exhaustive" }),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "2026 enterprise RAG architecture regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						coverageReviewCalls += 1;
						const proposals =
							coverageReviewCalls === 1
								? [
										gapProposal({
											targetSearchQuery:
												"2026 enterprise RAG cost benchmark hybrid retrieval official report",
											affectedSection: "Cost benchmarks",
										}),
									]
								: coverageReviewCalls === 2
									? [
											gapProposal({
												targetSearchQuery:
													"2026 regulated SaaS RAG adoption survey hybrid retrieval auditability",
												affectedSection: "Adoption evidence",
											}),
										]
									: [
											gapProposal({
												targetSearchQuery:
													"2026 regulated SaaS RAG deployment incidents hybrid retrieval auditability",
												affectedSection: "Residual risks",
											}),
										];
						return {
							text: coverageReviewText(proposals),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "assemble"
								? assembledReport()
								: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpoints.push(input as (typeof checkpoints)[number]);
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-gap-cap",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(searchWeb.mock.calls.map(([queries]) => queries)).toEqual([
			[
				"enterprise RAG architecture regulated SaaS 2026",
				"Compare current enterprise RAG architectures for regulated SaaS recent news 2026",
				"Compare current enterprise RAG architectures for regulated SaaS latest updates 2026",
			],
			["2026 enterprise RAG cost benchmark hybrid retrieval official report"],
			["2026 regulated SaaS RAG adoption survey hybrid retrieval auditability"],
		]);
		expect(checkpoints.map((checkpoint) => checkpoint.roundNumber)).toEqual([
			1, 2, 3,
		]);
		expect(checkpoints[2].checkpoint.coverageReview).toMatchObject({
			approvedGapCandidates: [],
			diagnostics: [
				expect.objectContaining({ code: "atlas_gap_fill_cap_exhausted" }),
			],
		});
		expect(result.sourceCounts).toMatchObject({
			web: 3,
			accepted: 3,
		});
	});

	it("runs only one useful In-Depth gap-fill round", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const searchWeb = vi
			.fn()
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-initial",
						title: "Initial governance evidence",
						url: "https://example.com/governance",
						snippet:
							"Fetched page excerpt: Initial governance evidence covers controls but not current enforcement updates.",
					},
				],
				rejectedSources: [],
				limitation: null,
			})
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-enforcement",
						title: "2026 AI enforcement update",
						url: "https://example.com/ai-enforcement-2026",
						snippet:
							"Fetched page excerpt: 2026 enforcement update evidence explains current regulator priorities for AI governance controls.",
					},
				],
				rejectedSources: [],
				limitation: null,
			});
		const checkpoints: Array<{ roundNumber: number; checkpoint: unknown }> = [];
		let coverageReviewCalls = 0;

		await runAtlasPipeline({
			job: atlasJob({
				id: "atlas-in-depth-gap",
				profile: "in-depth",
				query: "Compare current AI governance enforcement updates",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "2026 AI governance enforcement controls",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						coverageReviewCalls += 1;
						return {
							text: coverageReviewText([
								gapProposal({
									targetSearchQuery:
										coverageReviewCalls === 1
											? "2026 AI governance regulatory enforcement updates official controls"
											: "2026 AI governance enforcement penalties regulator current report",
									affectedSection: "Governance enforcement",
								}),
							]),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "assemble"
								? assembledReport()
								: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpoints.push(input);
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-in-depth",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(searchWeb.mock.calls.map(([queries]) => queries)).toEqual([
			[
				"AI governance enforcement controls 2026",
				"Compare current AI governance enforcement updates recent news 2026",
				"Compare current AI governance enforcement updates latest updates 2026",
			],
			["2026 AI governance regulatory enforcement updates official controls"],
		]);
		expect(checkpoints.map((checkpoint) => checkpoint.roundNumber)).toEqual([
			1, 2,
		]);
	});

	it("skips a second allowed gap-fill round when the previous round adds no useful evidence", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const searchWeb = vi
			.fn()
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-initial",
						title: "Initial benchmark evidence",
						url: "https://example.com/benchmarks",
						snippet:
							"Fetched page excerpt: 2026 benchmark evidence covers evaluation categories for hybrid RAG systems.",
					},
				],
				rejectedSources: [],
				limitation: null,
			})
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-duplicate",
						title: "Duplicate benchmark evidence",
						url: "https://example.com/benchmarks#duplicate",
						snippet:
							"Fetched page excerpt: 2026 benchmark evidence covers evaluation categories for hybrid RAG systems.",
					},
				],
				rejectedSources: [],
				limitation: null,
			});
		const checkpoints: Array<{
			roundNumber: number;
			curatedSourcePool: { web?: unknown[]; rejectedWeb?: unknown[] };
			qualityDiagnostics: {
				gapFill?: { useful?: boolean; stopReason?: string };
			};
		}> = [];

		await runAtlasPipeline({
			job: atlasJob({ id: "atlas-gap-no-useful", profile: "exhaustive" }),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "2026 hybrid RAG benchmark evaluation",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return {
							text: coverageReviewText([
								gapProposal({
									targetSearchQuery:
										"2026 hybrid RAG benchmark evaluation official current report",
									affectedSection: "Evaluation",
								}),
							]),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "assemble"
								? assembledReport()
								: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpoints.push(input as (typeof checkpoints)[number]);
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-no-useful",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(searchWeb).toHaveBeenCalledTimes(2);
		expect(checkpoints.map((checkpoint) => checkpoint.roundNumber)).toEqual([
			1, 2,
		]);
		expect(checkpoints[1].curatedSourcePool.web).toHaveLength(1);
		expect(checkpoints[1].qualityDiagnostics.gapFill).toMatchObject({
			useful: false,
			stopReason: "no_materially_new_evidence",
		});
	});

	it("deduplicates gap-fill sources by canonical URL and repeated material", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const searchWeb = vi
			.fn()
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-initial",
						title: "Hybrid RAG evidence",
						url: "https://example.com/rag?b=2&a=1#summary",
						snippet:
							"Fetched page excerpt: Hybrid RAG evidence says lexical retrieval, vector retrieval, and reranking should remain auditable layers.",
					},
				],
				rejectedSources: [],
				limitation: null,
			})
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-same-url",
						title: "Same URL",
						url: "https://example.com/rag?a=1&b=2",
						snippet:
							"Fetched page excerpt: Different text from the same canonical page should not be accepted again.",
					},
					{
						id: "web-same-material",
						title: "Repeated material",
						url: "https://other.example.com/rag-repeat",
						snippet:
							"Fetched page excerpt: Hybrid RAG evidence says lexical retrieval, vector retrieval, and reranking should remain auditable layers.",
					},
				],
				rejectedSources: [],
				limitation: null,
			});
		const checkpoints: Array<{
			roundNumber: number;
			curatedSourcePool: { web?: unknown[]; rejectedWeb?: unknown[] };
		}> = [];

		const result = await runAtlasPipeline({
			job: atlasJob({ id: "atlas-gap-dedupe", profile: "exhaustive" }),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "hybrid RAG auditable retrieval layers",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return {
							text: coverageReviewText([
								gapProposal({
									targetSearchQuery:
										"hybrid RAG auditable retrieval layers regulator evidence 2026",
									affectedSection: "Architecture evidence",
								}),
							]),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "assemble"
								? assembledReport()
								: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpoints.push(input as (typeof checkpoints)[number]);
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-dedupe",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(result.sourceCounts.web).toBe(1);
		expect(checkpoints[1].curatedSourcePool.web).toHaveLength(1);
		expect(checkpoints[1].curatedSourcePool.rejectedWeb).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rejectionReason: "duplicate_url" }),
				expect.objectContaining({ rejectionReason: "duplicate_material" }),
			]),
		);
	});

	it("preserves contradictions discovered during gap fill in Evidence Packs and checkpoints", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const prompts: Record<string, string> = {};
		const checkpoints: Array<{ roundNumber: number; checkpoint: unknown }> = [];
		const searchWeb = vi
			.fn()
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-initial",
						title: "Initial security evidence",
						url: "https://example.com/security-baseline",
						snippet:
							"Fetched page excerpt: Baseline evidence says managed RAG deployment reduces security review workload for regulated SaaS teams.",
					},
				],
				rejectedSources: [],
				limitation: null,
			})
			.mockResolvedValueOnce({
				sources: [
					{
						id: "web-contradiction",
						title: "Conflicting security evidence",
						url: "https://example.com/security-conflict",
						snippet:
							"Fetched page excerpt: Conflicting 2026 evidence contradicts the baseline and says managed RAG deployment can increase security review workload when logging and retention controls are immature.",
					},
				],
				rejectedSources: [],
				limitation: null,
			});

		await runAtlasPipeline({
			job: atlasJob({ id: "atlas-gap-contradiction", profile: "in-depth" }),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => {
					prompts[input.stage] = input.prompt;
					if (input.stage === "decompose") {
						return {
							text: "managed RAG deployment security workload 2026",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return {
							text: coverageReviewText([
								gapProposal({
									targetSearchQuery:
										"2026 managed RAG deployment security workload logging retention controls",
									affectedSection: "Security workload",
								}),
							]),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "assemble"
								? assembledReport()
								: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpoints.push(input);
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-contradiction",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		const synthesizePrompt = JSON.parse(prompts.synthesize);
		expect(synthesizePrompt.evidencePacks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceRefs: [expect.objectContaining({ id: "web-contradiction" })],
					conflicts: [expect.stringContaining("Conflicting 2026 evidence")],
				}),
			]),
		);
		expect(checkpoints[1].checkpoint).toMatchObject({
			evidencePacks: expect.arrayContaining([
				expect.objectContaining({
					conflicts: [expect.stringContaining("Conflicting 2026 evidence")],
				}),
			]),
		});
	});

	it("builds evidence packs after curation, checkpoints them, and uses them in model-facing later stages", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const prompts: Record<string, string> = {};
		let checkpointInput: unknown = null;

		await runAtlasPipeline({
			job: {
				id: "atlas-evidence-pack-job",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Evidence pack Atlas",
				query: "Compare retrieval architectures for regulated SaaS",
				lifecycle: {
					family: {
						familyId: "atlas-evidence-pack-job",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-evidence-pack-job",
						currentAtlasJobId: "atlas-evidence-pack-job",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({
					localSources: [
						{
							id: "local-explicit",
							title: "Internal architecture memo",
							authority: "explicit",
							text: "Internal architecture memo: regulated SaaS search should preserve exact compliance language while adding vector discovery.",
						},
					],
				})),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Hybrid retrieval guide",
							url: "https://example.com/hybrid-retrieval",
							snippet:
								"Fetched page excerpt: Hybrid retrieval combines lexical and semantic retrieval, then reranks candidates before synthesis.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					prompts[input.stage] = input.prompt;
					const textByStage: Record<string, string> = {
						decompose: "regulated SaaS retrieval architecture",
						curate:
							"Curated fact: explicit local constraints and accepted web evidence both support hybrid retrieval with reranking.",
						synthesize:
							"Finding: hybrid retrieval with reranking is the strongest evidenced pattern.",
						integrate:
							"Outline: Executive Summary; Retrieval architecture; Limitations.",
						assemble: [
							"# Evidence pack Atlas",
							"",
							"## Executive Summary",
							"Hybrid retrieval with reranking is the strongest evidenced pattern for regulated SaaS search because it preserves exact compliance language while still supporting semantic discovery.",
							"",
							"## Retrieval Architecture",
							"The evidence supports keeping lexical retrieval, vector retrieval, and reranking as separate responsibilities. This lets teams inspect exact-match coverage and candidate narrowing before synthesis.",
							"",
							"## Limitations",
							"The evidence is representative and should be validated against the deployment corpus.",
						].join("\n"),
					};
					return {
						text: textByStage[input.stage] ?? `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpointInput = input;
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		const synthesizePrompt = JSON.parse(prompts.synthesize);
		const integratePrompt = JSON.parse(prompts.integrate);
		const assemblePrompt = JSON.parse(prompts.assemble);

		expect(synthesizePrompt.evidencePacks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceKind: "local",
					authority: "explicit_local",
					sourceRefs: [
						expect.objectContaining({
							id: "local-explicit",
							kind: "local",
						}),
					],
				}),
				expect.objectContaining({
					sourceKind: "web",
					authority: "accepted_web",
					sourceRefs: [
						expect.objectContaining({
							id: "web-1",
							kind: "web",
							url: "https://example.com/hybrid-retrieval",
						}),
					],
				}),
			]),
		);
		expect(synthesizePrompt.local).toBeUndefined();
		expect(synthesizePrompt.web).toBeUndefined();
		expect(integratePrompt.evidencePacks).toEqual(
			synthesizePrompt.evidencePacks,
		);
		expect(assemblePrompt.evidencePacks).toEqual(
			synthesizePrompt.evidencePacks,
		);
		expect(assemblePrompt.acceptedSources).toBeUndefined();
		expect(checkpointInput).toMatchObject({
			checkpoint: {
				evidencePacksVersion: synthesizePrompt.evidencePacksVersion,
				evidencePacks: synthesizePrompt.evidencePacks,
				evidencePackDiagnostics: [],
			},
			documentSourceSummary: {
				evidencePacks: {
					version: synthesizePrompt.evidencePacksVersion,
					count: 2,
					diagnostics: [],
				},
			},
		});
	});

	it("runs coverage review after evidence packs and checkpoints diagnostics without executing gap fill yet", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const prompts: Record<string, string> = {};
		const stages: string[] = [];
		let checkpointInput: unknown = null;
		const searchWeb = vi.fn(async () => ({
			sources: [
				{
					id: "web-coverage-1",
					title: "Coverage source",
					url: "https://example.com/coverage-source",
					snippet:
						"Fetched page excerpt: Accepted source covers the main governance framing but not current benchmark evidence.",
				},
			],
			rejectedSources: [],
			limitation: null,
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-coverage-review-job",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "in-depth",
				title: "Coverage Review Atlas",
				query: "Compare current governance benchmarks for AI systems",
				lifecycle: {
					family: {
						familyId: "atlas-coverage-review-job",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-coverage-review-job",
						currentAtlasJobId: "atlas-coverage-review-job",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => {
					stages.push(input.stage);
					prompts[input.stage] = input.prompt;
					const textByStage: Record<string, string> = {
						decompose: "current AI governance benchmarks 2026",
						curate:
							"Curated fact: accepted evidence covers governance framing but not benchmark comparison.",
						"coverage-review": "not valid json",
						synthesize:
							"Finding: current benchmark coverage remains limited by the accepted sources.",
						integrate:
							"Outline: Executive Summary; Governance benchmarks; Limitations.",
						assemble: [
							"# Coverage Review Atlas",
							"",
							"## Executive Summary",
							"Current benchmark coverage remains limited by the accepted sources, so the report should present governance comparisons cautiously.",
							"",
							"## Governance Benchmarks",
							"The accepted evidence supports governance framing but not a definitive benchmark ranking. The report should therefore compare control categories, adoption constraints, and validation needs without claiming that one benchmark source settles the whole question. This keeps the analysis useful while preserving the weak-evidence boundary.",
							"",
							"## Limitations",
							"Coverage review output was malformed, so no gap-fill candidate was approved in this round.",
						].join("\n"),
					};
					return {
						text: textByStage[input.stage] ?? `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpointInput = input;
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-coverage",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		const coveragePrompt = JSON.parse(prompts["coverage-review"]);
		expect(stages).toEqual([
			"decompose",
			"curate",
			"coverage-review",
			"synthesize",
			"integrate",
			"assemble",
		]);
		expect(coveragePrompt.evidencePacks).toHaveLength(1);
		expect(coveragePrompt.intendedQuestions).toEqual([
			"Compare current governance benchmarks for AI systems",
			"current AI governance benchmarks 2026",
		]);
		expect(searchWeb).toHaveBeenCalledTimes(1);
		expect(checkpointInput).toMatchObject({
			checkpoint: {
				coverageReview: {
					approvedGapCandidates: [],
					diagnostics: [
						expect.objectContaining({
							code: "atlas_coverage_review_invalid_json",
						}),
					],
				},
			},
			documentSourceSummary: {
				coverageReview: {
					sufficient: false,
					proposalCount: 0,
					approvedGapCandidateCount: 0,
					diagnostics: [
						expect.objectContaining({
							code: "atlas_coverage_review_invalid_json",
						}),
					],
				},
			},
		});
	});

	it("runs the fixed pipeline order, writes checkpoints only after completed rounds, audits Basis Markers, and renders sibling outputs", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const stages: string[] = [];
		const checkpointRounds: number[] = [];
		const heartbeat = vi.fn(async () => {});

		const result = await runAtlasPipeline({
			job: {
				id: "atlas-job-1",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "in-depth",
				title: "Atlas research",
				query: "Compare enterprise search architectures",
				lifecycle: {
					family: {
						familyId: "atlas-job-1",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-job-1",
						currentAtlasJobId: "atlas-job-1",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({
					localSources: [
						{
							id: "local-1",
							title: "Architecture notes",
							authority: "explicit",
							text: "Internal architecture constraints",
						},
					],
				})),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Vendor docs",
							url: "https://example.com/docs",
							snippet: "Official vendor docs",
						},
					],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					stages.push(input.stage);
					if (input.stage === "decompose") {
						return {
							text: "- enterprise search retrieval architecture\n- hybrid search evaluation methods",
							usage: {
								inputTokens: 10,
								outputTokens: 5,
								totalTokens: 15,
								costUsdMicros: 25,
							},
						};
					}
					if (input.stage === "assemble") {
						return {
							text: [
								"# Enterprise Search Architectures",
								"",
								"## Executive Summary",
								"Enterprise search architecture choices are mainly about balancing lexical recall, semantic matching, governance, and operational cost. Hybrid retrieval is the most defensible default when teams need reliable coverage and explainable matching across varied internal content.",
								"",
								"## Findings",
								"Keyword search remains useful for exact terminology, product names, error codes, and compliance language. Vector retrieval improves semantic discovery when users describe concepts rather than exact strings. A reranking layer is valuable because it can narrow broad candidate sets into evidence that better matches the user's intent.",
								"",
								"## Limitations",
								"This overview is based on representative sources and should be validated against the specific corpus, access model, and latency budget before implementation.",
							].join("\n"),
							usage: {
								inputTokens: 10,
								outputTokens: 5,
								totalTokens: 15,
								costUsdMicros: 25,
							},
						};
					}
					return {
						text: `${input.stage} result`,
						usage: {
							inputTokens: 10,
							outputTokens: 5,
							totalTokens: 15,
							costUsdMicros: 25,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [
						{
							code: "limited_web",
							message: "Web evidence is representative, not exhaustive.",
							severity: "info" as const,
						},
					],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (checkpoint) => {
					checkpointRounds.push(checkpoint.roundNumber);
				}),
				heartbeat,
				renderOutputs: vi.fn(async (source) => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
					sourceTitle: source.title,
				})),
			},
		});

		expect(stages).toEqual([
			"decompose",
			"curate",
			"coverage-review",
			"synthesize",
			"integrate",
			"assemble",
		]);
		expect(heartbeat).toHaveBeenCalledWith({
			stage: "search",
			progressPercent: 25,
			progressDetails: {
				queries: [
					"enterprise search retrieval architecture",
					"hybrid search evaluation methods",
				],
			},
		});
		expect(checkpointRounds).toEqual([1]);
		expect(result).toMatchObject({
			status: "succeeded",
			stage: "render",
			outputs: {
				fileProductionJobId: "fp-job-1",
				htmlChatGeneratedFileId: "file-html",
				pdfChatGeneratedFileId: "file-pdf",
				markdownChatGeneratedFileId: "file-md",
			},
			audit: {
				honestyMarkers: [
					{
						code: "limited_web",
						severity: "info",
					},
				],
			},
			usage: {
				inputTokens: 60,
				outputTokens: 30,
				totalTokens: 90,
				costUsdMicros: 150,
			},
		});
	});

	it("renders a source-backed report with limitations when soft audit retry is exhausted", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const auditBasis = vi.fn(async () => ({
			passed: false,
			honestyMarkers: [
				{
					code: "limited_web",
					message: "Web evidence is representative, not exhaustive.",
					severity: "warning" as const,
				},
			],
			retryRequested: true,
			claimBasis: [
				{
					version: "atlas.claim-basis.v1" as const,
					id: "basis-soft-retry",
					locator: {
						sectionTitle: "Executive Summary",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText:
							"Hybrid retrieval remains the strongest architecture pattern.",
						quote: "Hybrid retrieval",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial" as const,
					evidencePackIds: ["pack-web-rag"],
					sourceRefs: [
						{
							id: "web-rag",
							kind: "web" as const,
							title: "Enterprise RAG architecture evidence",
							url: "https://example.com/rag",
							authority: "accepted_web" as const,
						},
					],
					supportRationale:
						"The accepted source supports the pattern, but the evidence is representative rather than exhaustive.",
					auditConcernCode: "limited_web",
				},
			],
			basisLimitations: [
				{
					code: "limited_web",
					message: "Web evidence is representative, not exhaustive.",
					basisIds: ["basis-soft-retry"],
					sectionTitle: "Executive Summary",
				},
			],
			basisDiagnostics: [],
			claimBasisCoverageBySection: [],
			claimBasisStatus: "succeeded" as const,
			claimBasisFailureReason: null,
		}));
		const renderOutputs = vi.fn(async (_source: { blocks: unknown[] }) => ({
			fileProductionJobId: "fp-job-soft-retry",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		const result = await runAtlasPipeline({
			job: atlasJob({
				id: "atlas-soft-retry",
				profile: "overview",
				title: "Soft Retry Atlas",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-rag",
							title: "Enterprise RAG architecture evidence",
							url: "https://example.com/rag",
							snippet:
								"Fetched page excerpt: Hybrid retrieval remains the strongest architecture pattern in representative current evidence.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "2026 enterprise RAG architecture regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					return {
						text:
							input.stage === "assemble"
								? substantiveExecutiveSummary()
								: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(auditBasis).toHaveBeenCalledTimes(2);
		expect(result.stage).toBe("render");
		expect(renderOutputs).toHaveBeenCalled();
		const renderedSource = renderOutputs.mock.calls[0]?.[0];
		if (!renderedSource) throw new Error("Atlas report was not rendered.");
		expect(JSON.stringify(renderedSource)).toContain("Limitations");
		expect(JSON.stringify(renderedSource)).toContain("Basis Markers");
		expect(JSON.stringify(renderedSource)).not.toContain("honesty markers");
		expect(renderedSource.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "paragraph",
					basisMarkers: expect.arrayContaining([
						expect.objectContaining({
							id: "basis-soft-retry",
							support: "partial",
						}),
					]),
				}),
			]),
		);
	});

	it("renders structured image candidates when assembly does not author Markdown images", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		let renderedBlocks: Array<{ type?: string; [key: string]: unknown }> = [];
		let checkpoint: unknown = null;

		const result = await runAtlasPipeline({
			job: {
				id: "atlas-image-job",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Enterprise Search Images",
				query: "Compare enterprise search architectures with useful visuals",
				lifecycle: {
					family: {
						familyId: "atlas-image-job",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-image-job",
						currentAtlasJobId: "atlas-image-job",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Enterprise search architecture evidence",
							url: "https://example.com/report",
							snippet:
								"Evidence on hybrid search architecture, reranking, governance, and visual architecture patterns.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				searchImages: vi.fn(async () => ({
					imageCandidates: [
						{
							id: "image-1",
							query: "enterprise search architecture",
							title: "Enterprise search architecture diagram",
							imageUrl: "https://cdn.example.com/architecture.png",
							sourcePageUrl: "https://example.com/report",
							sourceTitle: "Example Research",
							thumbnailUrl: null,
							width: 1200,
							height: 800,
							caption: "Enterprise search architecture diagram",
							selectionReason:
								"Image result for enterprise search architecture.",
						},
					],
					imageLimitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "enterprise search architecture\nhybrid retrieval reranking",
							usage: {
								inputTokens: 1,
								outputTokens: 1,
								totalTokens: 2,
								costUsdMicros: 0,
							},
						};
					}
					if (input.stage === "assemble") {
						return {
							text: [
								"# Enterprise Search Images",
								"",
								"## Executive Summary",
								"Enterprise search architecture decisions should combine lexical retrieval, semantic retrieval, and reranking when teams need both exact recall and concept-level discovery. The accepted evidence supports hybrid retrieval as the default because governance, latency, source permissions, and evaluation workflows all become easier to reason about when every layer has a narrow responsibility.",
								"",
								"## Architecture Findings",
								"Hybrid search architecture works best when ingestion, lexical indexes, vector indexes, and rerankers are observable as separate components. This makes failures easier to isolate, gives compliance reviewers clearer control points, and lets product teams tune relevance without replacing the whole retrieval stack.",
								"",
								"## Limitations",
								"The evidence set is representative rather than exhaustive, so implementation choices should still be validated against corpus size, access rules, and latency budgets.",
							].join("\n"),
							usage: {
								inputTokens: 1,
								outputTokens: 1,
								totalTokens: 2,
								costUsdMicros: 0,
							},
						};
					}
					return {
						text: `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 0,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (input) => {
					checkpoint = input.checkpoint;
				}),
				renderOutputs: vi.fn(async (source) => {
					renderedBlocks = source.blocks;
					return {
						fileProductionJobId: "fp-job-1",
						htmlChatGeneratedFileId: "file-html",
						pdfChatGeneratedFileId: "file-pdf",
						markdownChatGeneratedFileId: "file-md",
					};
				}),
			},
		});

		expect(result.status).toBe("succeeded");
		expect(renderedBlocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image",
					source: {
						kind: "https",
						url: "https://cdn.example.com/architecture.png",
					},
					caption: "Enterprise search architecture diagram",
					sourceAttribution: {
						title: "Example Research",
						url: "https://example.com/report",
					},
				}),
			]),
		);
		expect(checkpoint).toMatchObject({
			selectedImageCandidateIds: ["image-1"],
		});
	});

	it("continues successfully when Atlas image search fails", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		let renderedBlocks: Array<{ type?: string; [key: string]: unknown }> = [];

		const result = await runAtlasPipeline({
			job: {
				id: "atlas-image-failure-job",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Enterprise Search Without Images",
				query: "Compare enterprise search architectures",
				lifecycle: {
					family: {
						familyId: "atlas-image-failure-job",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-image-failure-job",
						currentAtlasJobId: "atlas-image-failure-job",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Enterprise search architecture evidence",
							url: "https://example.com/report",
							snippet:
								"Evidence on hybrid search architecture, reranking, governance, and evaluation workflows.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				searchImages: vi.fn(async () => {
					throw new Error("image endpoint unavailable");
				}),
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose"
							? "enterprise search architecture"
							: input.stage === "assemble"
								? [
										"# Enterprise Search Without Images",
										"",
										"## Executive Summary",
										"Enterprise search architecture decisions should combine lexical retrieval, semantic retrieval, and reranking when teams need both exact recall and concept-level discovery. The accepted evidence supports hybrid retrieval as a default because governance, latency, permissions, and evaluation workflows are easier to reason about when each retrieval layer has a narrow responsibility.",
										"",
										"## Findings",
										"Hybrid retrieval gives teams a practical way to preserve exact terminology while still supporting natural language discovery. Reranking then gives the system a narrower and more inspectable final evidence set for answer generation.",
										"",
										"## Limitations",
										"The evidence set is representative rather than exhaustive.",
									].join("\n")
								: `${input.stage} result`,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 0,
					},
				})),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs: vi.fn(async (source) => {
					renderedBlocks = source.blocks;
					return {
						fileProductionJobId: "fp-job-1",
						htmlChatGeneratedFileId: "file-html",
						pdfChatGeneratedFileId: "file-pdf",
						markdownChatGeneratedFileId: "file-md",
					};
				}),
			},
		});

		expect(result.status).toBe("succeeded");
		expect(renderedBlocks.some((block) => block.type === "image")).toBe(false);
	});

	it("threads same-family lifecycle seeds into prompts, checkpoints, and rendered source metadata", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const prompts: Record<string, string> = {};
		const writeCheckpoint = vi.fn(async () => {});
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-child-1",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-2",
				action: "revise",
				parentAtlasJobId: "atlas-parent-1",
				profile: "in-depth",
				title: "Revised Atlas research",
				query: "Revise the report for implementation risks",
				lifecycle: {
					family: {
						familyId: "atlas-family-1",
						mode: "same_family",
						action: "revise",
						rootAtlasJobId: "atlas-root-1",
						currentAtlasJobId: "atlas-child-1",
						parentAtlasJobId: "atlas-parent-1",
						forkedFromAtlasJobId: null,
					},
					seed: {
						parentAtlasJobId: "atlas-parent-1",
						compressedFindings: {
							synthesize: "Prior compressed findings",
						},
						curatedSourcePool: {
							local: [{ id: "parent-local", title: "Parent source" }],
						},
						checkpoint: { assembledMarkdown: "Prior report" },
						documentSourceSummary: {
							atlasFamily: { familyId: "atlas-family-1" },
						},
					},
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					prompts[input.stage] = input.prompt;
					return {
						text: `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint,
				renderOutputs,
			},
		});

		expect(JSON.parse(prompts.decompose)).toMatchObject({
			query: "Revise the report for implementation risks",
			detectedLanguage: "en",
			atlasLifecycle: {
				action: "revise",
				parentSeed: {
					parentAtlasJobId: "atlas-parent-1",
					compressedFindings: { synthesize: "Prior compressed findings" },
				},
			},
		});
		expect(JSON.parse(prompts.curate)).toMatchObject({
			detectedLanguage: "en",
			parentCuratedSourcePool: {
				local: [{ id: "parent-local", title: "Parent source" }],
			},
			atlasLifecycle: {
				familyId: "atlas-family-1",
				mode: "same_family",
			},
		});
		expect(JSON.parse(prompts.synthesize)).toMatchObject({
			detectedLanguage: "en",
			parentCompressedFindings: { synthesize: "Prior compressed findings" },
		});
		expect(writeCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({
				documentSourceSummary: expect.objectContaining({
					atlasFamily: expect.objectContaining({
						familyId: "atlas-family-1",
						mode: "same_family",
						action: "revise",
					}),
					parentSeedUsed: {
						parentAtlasJobId: "atlas-parent-1",
						compressedFindings: true,
						curatedSourcePool: true,
					},
				}),
			}),
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				cover: expect.objectContaining({
					eyebrow: "Report date: 2026-06-19",
				}),
			}),
		);
	});

	it("assembles final report content from curated evidence and synthesized findings rather than process summaries", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const prompts: Record<string, string> = {};
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-findings-1",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Retrieval Strategy Atlas",
				query: "Compare retrieval strategies",
				lifecycle: {
					family: {
						familyId: "atlas-findings-1",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-findings-1",
						currentAtlasJobId: "atlas-findings-1",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Evaluation report",
							url: "https://example.com/eval",
							snippet: "Hybrid retrieval improves recall but needs reranking.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					prompts[input.stage] = input.prompt;
					const textByStage: Record<string, string> = {
						decompose: "retrieval strategy evaluation",
						curate:
							"Curated fact: hybrid retrieval improves recall and reranking reduces noise.",
						synthesize:
							"Finding: hybrid retrieval is strongest when lexical recall is followed by semantic reranking.",
						integrate:
							"Outline: Executive Summary; Hybrid retrieval tradeoffs; Limitations.",
						assemble: [
							"# Retrieval Strategy Atlas",
							"",
							"## Executive Summary",
							"Hybrid retrieval is strongest when lexical recall is followed by semantic reranking. The accepted evidence points to a practical pattern: keyword retrieval preserves exact-match coverage, vector retrieval broadens conceptual recall, and reranking helps control noisy matches before the report or answer layer consumes the evidence.",
							"",
							"## Findings",
							"The evidence shows recall improves when keyword and vector retrieval are combined, but source quality depends on reranking. Teams should treat the first retrieval pass as a candidate generator rather than a final evidence set. The stronger architecture keeps search broad, then converges on fewer accepted sources that can be quoted and audited.",
							"",
							"## Limitations",
							"This finding is bounded by the accepted source set and should be validated with corpus-specific evaluation before production rollout.",
						].join("\n"),
					};
					return {
						text: textByStage[input.stage] ?? `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		const assemblePrompt = JSON.parse(prompts.assemble);
		expect(assemblePrompt.curatedEvidence).toContain("Curated fact");
		expect(assemblePrompt.synthesis).toContain("Finding: hybrid retrieval");
		expect(assemblePrompt.outline).toContain("Hybrid retrieval tradeoffs");
		expect(assemblePrompt.instructions).toContain(
			"Do not write a process report",
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "paragraph",
						text: expect.stringContaining("Hybrid retrieval is strongest"),
					}),
				]),
			}),
		);
	});

	it("repairs a process-only assembled draft before audit and rendering", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		let assembleCalls = 0;
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-process-repair",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Process repair report",
				query: "Compare retrieval systems",
				lifecycle: {
					family: {
						familyId: "atlas-process-repair",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-process-repair",
						currentAtlasJobId: "atlas-process-repair",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Retrieval systems",
							url: "https://example.com/retrieval",
							snippet:
								"Fetched page excerpt: Hybrid retrieval combines lexical and semantic recall.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text:
								assembleCalls === 1
									? "I checked the sources and synthesized findings for the report."
									: [
											"# Retrieval Systems",
											"",
											"## Executive Summary",
											"The evidence shows hybrid retrieval combines lexical and semantic recall. That combination is useful because lexical matching keeps exact domain terms visible while semantic search catches related concepts that do not share the same wording.",
											"",
											"## Findings",
											"Hybrid retrieval improves breadth while reranking controls noisy matches. A broad first pass should not become the quoted evidence set by itself; the system needs a convergence step that ranks, filters, and keeps only the strongest accepted sources for final claims.",
											"",
											"## Limitations",
											"The conclusion is limited to the accepted evidence in this smoke fixture and does not claim that one retrieval stack is universally best.",
										].join("\n"),
							usage: {
								inputTokens: 1,
								outputTokens: 1,
								totalTokens: 2,
								costUsdMicros: 1,
							},
						};
					}
					return {
						text:
							input.stage === "decompose"
								? "retrieval systems"
								: `${input.stage} substantive output`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(assembleCalls).toBe(2);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("hybrid retrieval"),
			}),
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "paragraph",
						text: expect.stringContaining("hybrid retrieval"),
					}),
				]),
			}),
		);
	});

	it("falls back to synthesized findings when assembly remains source-only", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-source-only",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Source-only report",
				query: "Explain routing docs history",
				lifecycle: {
					family: {
						familyId: "atlas-source-only",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-source-only",
						currentAtlasJobId: "atlas-source-only",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Routing docs",
							url: "https://example.com/routing",
							snippet:
								"Fetched page excerpt: SvelteKit routing is filesystem based.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose"
							? "SvelteKit routing docs"
							: input.stage === "synthesize"
								? "SvelteKit routing documentation centers on filesystem routing and route files, with later documentation clarifying layout, server-only endpoints, and dynamic parameters."
								: input.stage === "curate"
									? "Curated evidence: SvelteKit docs describe src/routes as the routing root and +page.svelte, +layout.svelte, and +server files as route file conventions."
									: input.stage === "integrate"
										? "Outline: Executive Summary; Findings; Limitations."
										: "# Source-only report\n\n2026-06-19",
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 1,
					},
				})),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("## Executive Summary"),
			}),
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "paragraph",
						text: expect.stringContaining("filesystem based"),
					}),
				]),
			}),
		);
	});

	it("preserves synthesized structure instead of stitching source excerpts when assembly collapses", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-source-derived-fallback",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Source-derived fallback",
				query: "Explain routing docs history without a process summary",
				lifecycle: {
					family: {
						familyId: "atlas-source-derived-fallback",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-source-derived-fallback",
						currentAtlasJobId: "atlas-source-derived-fallback",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Routing docs",
							url: "https://example.com/routing",
							snippet:
								"Search result snippet: At the heart of SvelteKit is a filesystem-based router. Fetched page excerpt: The routes of your app are defined by the directories in your codebase, with src/routes as the root route.",
						},
						{
							id: "web-2",
							title: "Route files docs",
							url: "https://example.com/route-files",
							snippet:
								"Fetched page excerpt: A +page.svelte component defines a page of your app, while +server files define API endpoints for matching routes.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose"
							? "SvelteKit routing docs"
							: input.stage === "synthesize"
								? [
										"Executive Summary: SvelteKit routing is filesystem-centered and route-file based.",
										"Framework Fit: The accepted routing docs support treating src/routes and route files as the durable ownership boundary.",
										"Operational Tradeoffs: Route files keep page, layout, and endpoint behavior close together, but teams need conventions for dynamic parameters and nested layouts.",
										"Recommendation: Use the route tree as the primary framework boundary and document where +page, +layout, and +server responsibilities sit.",
										"Limitations: The accepted evidence is limited to routing documentation excerpts.",
									].join("\n")
								: input.stage === "integrate"
									? [
											"Executive Summary - summarize the route-boundary conclusion.",
											"Framework Fit - explain why filesystem routing is the main framework fit point.",
											"Operational Tradeoffs - cover endpoint/layout/dynamic-parameter tradeoffs.",
											"Recommendation - give the implementation boundary recommendation.",
											"Limitations - state the evidence limits.",
										].join("\n")
									: input.stage === "assemble"
										? "I checked the sources and synthesized findings for the report."
										: `${input.stage} result`,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 1,
					},
				})),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).toContain("## Executive Summary");
		expect(auditInput?.assembledMarkdown).toContain("## Framework Fit");
		expect(auditInput?.assembledMarkdown).toContain("## Operational Tradeoffs");
		expect(auditInput?.assembledMarkdown).toContain("## Recommendation");
		expect(auditInput?.assembledMarkdown).toContain("## Limitations");
		expect(auditInput?.assembledMarkdown).not.toContain(
			"The accepted evidence supports a cautious, source-grounded report rather than a broad unsupported narrative.",
		);
		expect(auditInput?.assembledMarkdown).not.toContain(
			'"Routing docs" shows that',
		);
		expect(auditInput?.assemblyMetadata).toMatchObject({
			structured: true,
			sectionBriefs: expect.arrayContaining([
				expect.objectContaining({ sectionTitle: "Framework Fit" }),
				expect.objectContaining({ sectionTitle: "Operational Tradeoffs" }),
				expect.objectContaining({ sectionTitle: "Recommendation" }),
			]),
		});

		const renderCalls = renderOutputs.mock.calls as unknown as Array<
			[GeneratedDocumentSource]
		>;
		const renderedSource = renderCalls[0]?.[0];
		const headings =
			renderedSource?.blocks
				.filter((block) => block.type === "heading")
				.map((block) => block.text) ?? [];
		expect(headings).toEqual(
			expect.arrayContaining([
				"Executive Summary",
				"Framework Fit",
				"Operational Tradeoffs",
				"Recommendation",
				"Limitations",
			]),
		);
		expect(renderedSource?.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "paragraph",
					text: expect.stringContaining('"Routing docs" shows that'),
				}),
			]),
		);
	});

	it("falls back to generated search variants when decompose returns no usable search queries", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const searchWeb = vi.fn(async () => ({
			sources: [
				{
					id: "web-1",
					title: "Caching docs",
					url: "https://example.com/cache",
					snippet: "Cache strategy docs",
				},
			],
			limitation: null,
		}));
		const heartbeat = vi.fn(async () => {});

		await runAtlasPipeline({
			job: {
				id: "atlas-fallback-queries",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Browser caching",
				query: "Compare browser caching strategies for SaaS dashboards",
				lifecycle: {
					family: {
						familyId: "atlas-fallback-queries",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-fallback-queries",
						currentAtlasJobId: "atlas-fallback-queries",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => ({
					text: input.stage === "decompose" ? "" : `${input.stage} result`,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 1,
					},
				})),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async () => {}),
				heartbeat,
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		const expectedQueries = [
			"browser caching strategies SaaS dashboards evidence",
			"browser caching strategies SaaS dashboards comparison",
			"browser caching strategies SaaS dashboards best practices",
		];
		expect(searchWeb).toHaveBeenCalledWith(expectedQueries);
		expect(heartbeat).toHaveBeenCalledWith({
			stage: "search",
			progressPercent: 25,
			progressDetails: {
				queries: expectedQueries,
			},
		});
	});

	it("adds current-date grounding to freshness-sensitive news searches instead of trusting stale model years", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const searchWeb = vi.fn(async () => ({
			sources: [
				{
					id: "web-1",
					title: "Current AI regulation news",
					url: "https://example.com/ai-regulation-2026",
					snippet: "Fresh 2026 reporting on AI regulation.",
				},
			],
			limitation: null,
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-current-news",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Current news Atlas",
				query: "What is the latest news on AI regulation?",
				lifecycle: {
					family: {
						familyId: "atlas-current-news",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-current-news",
						currentAtlasJobId: "atlas-current-news",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose"
							? "AI regulation latest news 2024"
							: `${input.stage} result`,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 1,
					},
				})),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(searchWeb).toHaveBeenCalledWith(
			expect.arrayContaining([
				"AI regulation latest news 2026",
				"What is the latest news on AI regulation recent news 2026",
			]),
		);
		expect(searchWeb).not.toHaveBeenCalledWith(
			expect.arrayContaining(["AI regulation latest news 2024"]),
		);
	});

	it("does not surface the original prompt as the only research query when decompose echoes it", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const userPrompt =
			"Please research the current enterprise RAG architecture patterns for regulated SaaS teams";
		const searchWeb = vi.fn(async () => ({
			sources: [
				{
					id: "web-1",
					title: "RAG architecture docs",
					url: "https://example.com/rag",
					snippet: "RAG architecture docs",
				},
			],
			limitation: null,
		}));
		const heartbeat = vi.fn(async () => {});

		await runAtlasPipeline({
			job: {
				id: "atlas-prompt-echo",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "RAG architecture",
				query: userPrompt,
				lifecycle: {
					family: {
						familyId: "atlas-prompt-echo",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-prompt-echo",
						currentAtlasJobId: "atlas-prompt-echo",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose" ? userPrompt : `${input.stage} result`,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 1,
					},
				})),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async () => {}),
				heartbeat,
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		const expectedQueries = [
			"current enterprise RAG architecture patterns regulated SaaS teams evidence 2026",
			"current enterprise RAG architecture patterns regulated SaaS teams comparison 2026",
			"current enterprise RAG architecture patterns regulated SaaS teams best practices 2026",
			"Please research the current enterprise RAG architecture patterns for regulated SaaS teams recent news 2026",
			"Please research the current enterprise RAG architecture patterns for regulated SaaS teams latest updates 2026",
		];
		expect(searchWeb).toHaveBeenCalledWith(expectedQueries);
		expect(searchWeb).not.toHaveBeenCalledWith([userPrompt]);
		expect(heartbeat).toHaveBeenCalledWith({
			stage: "search",
			progressPercent: 25,
			progressDetails: { queries: expectedQueries },
		});
	});

	it("uses the selected Atlas profile to change search breadth", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const queryCountsByProfile: Record<string, number> = {};
		const decomposeSystemsByProfile: Record<string, string> = {};
		const manyQueries = Array.from(
			{ length: 28 },
			(_value, index) => `SvelteKit routing profile query ${index + 1}`,
		).join("\n");

		for (const profile of ["overview", "in-depth", "exhaustive"] as const) {
			await runAtlasPipeline({
				job: {
					id: `atlas-profile-${profile}`,
					userId: "user-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-1",
					action: "create",
					parentAtlasJobId: null,
					profile,
					title: `Profile ${profile}`,
					query: "Compare SvelteKit routing documentation history",
					lifecycle: {
						family: {
							familyId: `atlas-profile-${profile}`,
							mode: "new_family",
							action: "create",
							rootAtlasJobId: `atlas-profile-${profile}`,
							currentAtlasJobId: `atlas-profile-${profile}`,
							parentAtlasJobId: null,
							forkedFromAtlasJobId: null,
						},
						seed: null,
					},
				},
				dependencies: {
					resolveSources: vi.fn(async () => ({ localSources: [] })),
					searchWeb: vi.fn(async (queries) => {
						queryCountsByProfile[profile] = queries.length;
						return {
							sources: [
								{
									id: `web-${profile}`,
									title: "Routing docs",
									url: "https://example.com/routing",
									snippet:
										"SvelteKit routing documentation describes filesystem routes.",
								},
							],
							rejectedSources: [],
							limitation: null,
						};
					}),
					runModelStage: vi.fn(async (input) => ({
						text: (() => {
							if (input.stage === "decompose") {
								decomposeSystemsByProfile[profile] = input.system;
								return manyQueries;
							}
							return [
								"# Profile report",
								"",
								"## Executive Summary",
								"The evidence shows SvelteKit routing documentation centers on filesystem routes and route files, with enough detail for a concise profile comparison report.",
								"",
								"## Findings",
								"Profile-specific search breadth should change how many decomposed queries reach search, while the fixed pipeline and audit still run for every profile.",
								"",
								"## Limitations",
								"This fixture uses one accepted source and focuses on profile routing behavior.",
							].join("\n");
						})(),
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					})),
					auditBasis: vi.fn(async () => ({
						passed: true,
						honestyMarkers: [],
						retryRequested: false,
					})),
					writeCheckpoint: vi.fn(async () => {}),
					renderOutputs: vi.fn(async () => ({
						fileProductionJobId: `fp-${profile}`,
						htmlChatGeneratedFileId: `html-${profile}`,
						pdfChatGeneratedFileId: `pdf-${profile}`,
						markdownChatGeneratedFileId: `md-${profile}`,
					})),
				},
			});
		}

		expect(queryCountsByProfile).toEqual({
			overview: 6,
			"in-depth": 14,
			exhaustive: 28,
		});
		expect(decomposeSystemsByProfile.overview).toContain(
			"Profile posture: Overview",
		);
		expect(decomposeSystemsByProfile["in-depth"]).toContain(
			"Profile posture: In-Depth",
		);
		expect(decomposeSystemsByProfile.exhaustive).toContain(
			"Profile posture: Exhaustive",
		);
	});

	it("fails the pipeline instead of rendering outputs when the audit gate has critical markers", async () => {
		const { AtlasPipelineQualityError, runAtlasPipeline } = await import(
			"./pipeline"
		);
		const writeCheckpoint = vi.fn(async () => {});
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await expect(
			runAtlasPipeline({
				job: {
					id: "atlas-no-sources",
					userId: "user-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-1",
					action: "create",
					parentAtlasJobId: null,
					profile: "overview",
					title: "No-source report",
					query: "Research without sources",
					lifecycle: {
						family: {
							familyId: "atlas-no-sources",
							mode: "new_family",
							action: "create",
							rootAtlasJobId: "atlas-no-sources",
							currentAtlasJobId: "atlas-no-sources",
							parentAtlasJobId: null,
							forkedFromAtlasJobId: null,
						},
						seed: null,
					},
				},
				dependencies: {
					resolveSources: vi.fn(async () => ({ localSources: [] })),
					searchWeb: vi.fn(async () => ({
						sources: [],
						limitation: null,
					})),
					runModelStage: vi.fn(async (input) => ({
						text:
							input.stage === "decompose"
								? "Research without sources"
								: `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					})),
					auditBasis: vi.fn(async () => ({
						passed: false,
						honestyMarkers: [
							{
								code: "atlas_no_sources",
								message: "Atlas could not attach external sources.",
								severity: "critical" as const,
							},
						],
						retryRequested: false,
					})),
					writeCheckpoint,
					renderOutputs,
				},
			}),
		).rejects.toBeInstanceOf(AtlasPipelineQualityError);

		expect(writeCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({
				qualityDiagnostics: expect.objectContaining({
					passed: false,
				}),
			}),
		);
		expect(renderOutputs).not.toHaveBeenCalled();
	});

	it("detects Hungarian Atlas requests and carries that language through stage prompts and audit", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const systems: Record<string, string> = {};
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-hu-1",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Magyar Atlas",
				query: "Kérlek kutasd meg a magyar vállalati keresési megoldásokat",
				lifecycle: {
					family: {
						familyId: "atlas-hu-1",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-hu-1",
						currentAtlasJobId: "atlas-hu-1",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({ sources: [], limitation: null })),
				runModelStage: vi.fn(async (input) => {
					systems[input.stage] = input.system;
					return {
						text:
							input.stage === "decompose" ? "- vállalati keresés" : "eredmény",
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(systems.decompose).toContain("magyar");
		expect(systems.assemble).toContain("magyar");
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({ language: "hu" }),
		);
	});
});
