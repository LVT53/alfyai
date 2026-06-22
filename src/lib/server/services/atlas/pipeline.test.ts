import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import type { RunAtlasPipelineInput } from "./pipeline";
import type {
	AtlasGapProposal,
	AtlasPipelineJobContext,
	AtlasProfile,
} from "./types";
import type { AtlasWriterEvidenceCardReranker } from "./writer-evidence-cards";

describe("Atlas pipeline slices", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

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

	function decisionQualityReport(): string {
		const body = [
			"For a regulated SaaS team, the best default is a hybrid retrieval stack with lexical retrieval, vector retrieval, and reranking kept as separate operational responsibilities. This structure answers the request directly because it preserves exact policy language, broadens recall for related concepts, and gives reviewers a clear evidence trail before generation.",
			"We recommend starting with hybrid retrieval plus reranking, then validating latency and recall against the team's own corpus before scaling. Keyword-only retrieval is too brittle for conceptual discovery, while vector-only retrieval makes exact compliance language and audit review harder to control.",
			"The practical tradeoff is latency and operating complexity: reranking adds another step, but it narrows noisy candidates and makes final evidence selection easier to inspect. Teams should set a latency budget, measure recall on representative documents, and keep source-level logging in the evaluation loop.",
		].join(" ");
		return [
			"## Executive Summary",
			body,
			"",
			"## Recommended Architecture",
			body,
			"",
			"## Tradeoffs",
			body,
			"",
			"## Limitations",
			"The evidence is representative rather than exhaustive, so the final stack should be validated against production documents, access rules, and response-time targets before rollout.",
		].join("\n");
	}

	function underdevelopedMultiSectionDraft(): string {
		return [
			"## Executive Summary",
			"Hybrid retrieval with reranking is the likely default for regulated SaaS teams because it preserves exact policy terms while still finding conceptually related evidence. The draft names the operating implications but gives only enough detail to sketch the decision, not enough to settle rollout confidence for the team. It also leaves evaluation ownership and rollout sequencing mostly implicit.",
			"",
			"## Model Shortlist",
			"Keyword retrieval, vector retrieval, hybrid retrieval, and reranking all remain plausible choices when the corpus includes policy language and product documentation. Hybrid retrieval appears strongest because it keeps exact matches visible, but the draft leaves the shortlist at a high level and does not compare implementation burden deeply. The comparison needs sharper ranking and adoption criteria.",
			"",
			"## Retrieval Quality",
			"Retrieval quality depends on recall, precision, chunking, metadata filters, and whether reranking can remove noisy candidates before generation. The accepted evidence supports measuring these factors together, but this section only summarizes the criteria and does not yet translate them into a validation plan. It also omits the reviewer workflow for failed retrieval and the evidence owner for weak answers.",
			"",
			"## Latency and Cost",
			"Latency and cost depend on the number of retrieval passes, embedding dimensions, reranker depth, cache behavior, and infrastructure overhead. The draft says reranking adds cost, yet it does not quantify tradeoffs or describe how to decide whether the added step is justified. It also omits a budget rule for reranking depth before teams commit to production service limits.",
			"",
			"## Deployment Implications",
			"Production rollout needs observability, source logging, access controls, and clear failure handling so reviewers can inspect why evidence was selected. These concerns are named here, but the draft still lacks concrete sequencing for rollout, monitoring, and escalation when retrieved evidence conflicts. It also needs clearer ownership between platform and compliance teams during pilot review and after launch.",
			"",
			"## Recommendation",
			"We recommend starting with hybrid retrieval plus reranking and validating it against the team's own corpus before wider rollout. That recommendation is directionally useful, but it remains too compact to explain the operational threshold for moving from pilot to production.",
			"",
			"## Tradeoffs",
			"Vector-only retrieval is simpler to reason about at the application layer, while keyword retrieval keeps precise compliance terms visible. Hybrid retrieval combines those strengths, but the draft only sketches the comparison and leaves unclear which tradeoffs matter most for regulated SaaS.",
			"",
			"## Evidence Gaps",
			"The accepted sources do not provide identical measurements for the same corpus, latency budget, and governance requirements. This limits confidence, especially when comparing benchmark behavior with production behavior under access controls and reviewer workflows.",
			"",
			"## Limitations",
			"Evidence is representative rather than exhaustive, so the team should treat the recommendation as a starting point. The draft should be expanded before audit so the final report does not rely on source projection or deterministic fallback prose.",
		].join("\n");
	}

	function liveSparseEvidenceRichDecisionDraft(): string {
		return [
			"## Executive Summary",
			"For the self-hosted embedding decision, the evidence points toward a compact, well-supported model paired with a reranker rather than a single largest benchmark leader. The draft names the main criteria, but it still gives each criterion only a narrow treatment: English technical-document recall, p95 latency, memory residency, serving maturity, and reranker compatibility are all present without enough prioritization for a production choice. That makes the answer readable, yet still too sparse for the amount of accepted evidence available to the writer. It should also connect the recommendation to a concrete operator workflow instead of leaving the evidence as parallel considerations.",
			"",
			"## Model Shortlist",
			"The shortlist should compare BGE, GTE, E5, Jina, Nomic, and Qwen-style options by production fit instead of treating them as interchangeable model names. This draft says a smaller model may be preferable, but it does not explain which candidates should lead the evaluation lane, which should remain fallback options, or when a larger embedding dimension is worth the memory and indexing cost. The evidence cards support a sharper ranking than this compact summary provides. A stronger pass would separate default candidates from experimental candidates and explain why each tier belongs there.",
			"",
			"## Retrieval Quality",
			"Retrieval quality depends on chunking, domain vocabulary, benchmark transfer, reranker availability, and validation against representative technical documents. The draft mentions those factors, but it stops before translating them into a measurable evaluation plan for recall, citation coverage, and reviewer acceptance. A decision report should explain how to compare recall improvements against the cost of additional reranking or larger embedding vectors, especially when source evidence is broad but not perfectly matched. Without that plan, the shortlist remains plausible but not yet actionable for a team choosing production defaults.",
			"",
			"## Latency and Cost",
			"Latency and cost depend on resident model size, batching behavior, vector dimension, reranker depth, quantization, cache strategy, and serving runtime maturity. This draft identifies the variables without giving the operator a practical budget rule for single-machine deployment. It should describe how to keep p95 latency bounded while testing whether a reranker or higher-dimension embedder materially improves accepted-source quality on the target corpus. A fuller answer would state when to spend latency on reranking and when to keep the embedder smaller.",
			"",
			"## Limitations",
			"Deployment needs more than a model pick: the team must plan index rebuilds, observability, source-level logging, rollback, and hardware headroom for both embedding and reranking. The draft flags these concerns but leaves rollout sequencing, ownership, and failure handling mostly implicit. With sixteen accepted evidence cards, the report should give a richer path from shortlist testing to a production pilot rather than leaving those operational consequences compressed. Those details matter because a model that benchmarks well can still fail operationally if rebuilds and inspections are too costly.",
			"",
			"## Recommendation",
			"We recommend starting with a compact, actively supported embedding model plus a compatible reranker, then promoting a larger model only if corpus tests show a material recall gain inside the latency budget. That recommendation is directionally useful, but it still needs more explanation of evaluation thresholds, deployment risk, and what to avoid. The evidence is representative rather than exhaustive, so the final choice should be validated on the actual technical-document corpus before rollout. A stronger final report would turn this into a staged decision with explicit pass and fail criteria.",
		].join("\n");
	}

	function evidenceRichEmbeddingSources() {
		return Array.from({ length: 16 }, (_, index) => {
			const sourceNumber = index + 1;
			return {
				id: `web-embedding-rich-${sourceNumber}`,
				title: `Self-hosted embedding evidence ${sourceNumber}`,
				url: `https://example.com/embedding-evidence-${sourceNumber}`,
				snippet: [
					`Accepted evidence ${sourceNumber} covers self-hosted embedding model selection for English technical-document retrieval.`,
					"It discusses retrieval quality, latency, memory residency, serving maturity, reranker compatibility, and production validation limits.",
				].join(" "),
			};
		});
	}

	const noopWriterEvidenceCardReranker: AtlasWriterEvidenceCardReranker =
		async (params) => ({
			items: params.items.map((item, index) => ({
				item,
				index,
				score: 0,
			})),
		});

	async function runAtlasPipelineWithNoopReranker(
		input: RunAtlasPipelineInput,
	) {
		const { runAtlasPipeline } = await import("./pipeline");
		return runAtlasPipeline({
			...input,
			dependencies: {
				...input.dependencies,
				rerankWriterEvidenceCards:
					input.dependencies.rerankWriterEvidenceCards ??
					noopWriterEvidenceCardReranker,
			},
		});
	}

	it("does not consult ambient TEI routing in unit tests when a no-op writer reranker is supplied", async () => {
		vi.stubEnv("TEI_RERANKER_URL", "http://tei.example.test/rerank");
		const fetchTripwire = vi.fn(async () => {
			throw new Error("Unit tests must not call ambient TEI");
		});
		vi.stubGlobal("fetch", fetchTripwire);

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-no-ambient-tei",
				profile: "overview",
				query: "Recommend retrieval architecture for regulated SaaS",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-no-ambient-tei",
							title: "Hybrid retrieval deterministic evidence",
							url: "https://example.com/no-ambient-tei",
							snippet:
								"Hybrid retrieval evidence supports exact recall, semantic discovery, reranking, governance, and latency validation.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "hybrid retrieval regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "No Ambient TEI Atlas",
								bodyMarkdown: decisionQualityReport(),
								sectionBriefs: [],
								limitations: [],
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-no-ambient-tei",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(fetchTripwire).not.toHaveBeenCalled();
	});

	it("uses a valid structured generated title as the canonical document title and checkpoints section briefs", async () => {
		const checkpoints: Array<{
			roundNumber: number;
			checkpoint: Record<string, unknown>;
			documentSourceSummary: Record<string, unknown>;
		}> = [];
		const applyGeneratedTitle = vi.fn(async () => {});
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-generated-title",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		const result = await runAtlasPipelineWithNoopReranker({
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
		const checkpoints: Array<{
			roundNumber: number;
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
			documentSourceSummary: Record<string, unknown>;
		}> = [];
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
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
						sectionTitle: "Findings",
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
					sectionTitle: "Findings",
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

		await runAtlasPipelineWithNoopReranker({
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
						sectionTitle: "Findings",
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
		const applyGeneratedTitle = vi.fn(async () => {});
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
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

		const result = await runAtlasPipelineWithNoopReranker({
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

		const result = await runAtlasPipelineWithNoopReranker({
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

	it("excludes source_cap from the quality rejection count in sourceCounts", async () => {
		const checkpoints: Array<{ roundNumber: number; checkpoint: unknown }> = [];
		const result = await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-source-cap-rejection",
				profile: "overview",
				query: "Compare enterprise RAG architectures",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-good",
							title: "Good RAG source",
							url: "https://example.com/rag-good",
							snippet: "Substantive evidence about RAG architectures with detailed benchmarks and deployment patterns for enterprise environments.",
						},
					],
					rejectedSources: [
						{
							id: "web-cap-rejected-1",
							title: "Capped source 1",
							url: "https://example.com/capped-1",
							snippet: "Additional evidence beyond the acceptance cap.",
							rejectionReason: "source_cap",
						},
						{
							id: "web-cap-rejected-2",
							title: "Capped source 2",
							url: "https://example.com/capped-2",
							snippet: "More capped evidence.",
							rejectionReason: "source_cap",
						},
						{
							id: "web-dup",
							title: "Duplicate source",
							url: "https://example.com/rag-good#section",
							snippet: "Duplicate URL evidence.",
							rejectionReason: "duplicate_url",
						},
					],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "enterprise RAG architecture patterns\nvector database comparison",
							usage: stageUsage(),
						};
					}
					if (input.stage === "curate") {
						return { text: "Curated evidence", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return {
							text: JSON.stringify({
								sufficient: true,
								proposals: [],
								approvedGapCandidates: [],
								diagnostics: [],
								limitations: [],
							}),
							usage: stageUsage(),
						};
					}
					if (input.stage === "assemble") {
						return {
							text: [
								"## Executive Summary",
								"RAG architectures vary by enterprise requirements including governance, retrieval quality, and deployment constraints.",
								"",
								"## Findings",
								"Vector databases combined with reranking pipelines offer the best retrieval quality for regulated SaaS environments.",
								"",
								"## Limitations",
								"This analysis is based on a single accepted web source and may not capture the full landscape.",
							].join("\n"),
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-reject",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(result.sourceCounts).toMatchObject({
			local: 0,
			web: 1,
			accepted: 1,
			rejected: 1,
		});
	});

	it("runs only one useful In-Depth gap-fill round", async () => {
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

		await runAtlasPipelineWithNoopReranker({
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

		await runAtlasPipelineWithNoopReranker({
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

		const result = await runAtlasPipelineWithNoopReranker({
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

		await runAtlasPipelineWithNoopReranker({
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
		const prompts: Record<string, string> = {};
		let checkpointInput: unknown = null;

		await runAtlasPipelineWithNoopReranker({
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
		expect(assemblePrompt.writerEvidenceCards).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceTitle: "Internal architecture memo",
					evidencePackIds: [expect.stringMatching(/^atlas-pack-v1-/)],
				}),
				expect.objectContaining({
					sourceTitle: "Hybrid retrieval guide",
					url: "https://example.com/hybrid-retrieval",
					evidencePackIds: [expect.stringMatching(/^atlas-pack-v1-/)],
				}),
			]),
		);
		expect(assemblePrompt.writerEvidenceCardsVersion).toBe(
			"atlas.writer-evidence-card.v1",
		);
		expect(assemblePrompt.evidencePacks).toBeUndefined();
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

	it("routes writer evidence cards before assembling the writer prompt", async () => {
		const prompts: Record<string, string> = {};
		const rerankWriterEvidenceCards = vi.fn<AtlasWriterEvidenceCardReranker>(
			async (params) => {
				const zetaIndex = params.items.findIndex(
					(card) => card.sourceTitle === "Zeta hybrid retrieval guide",
				);
				const alphaIndex = params.items.findIndex(
					(card) => card.sourceTitle === "Alpha vector retrieval notes",
				);
				return {
					items: [
						{
							item: params.items[zetaIndex],
							index: zetaIndex,
							score: 0.92,
						},
						{
							item: params.items[alphaIndex],
							index: alphaIndex,
							score: 0.31,
						},
					],
				};
			},
		);

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-routed-writer-cards",
				profile: "overview",
				query:
					"Which retrieval architecture should a regulated SaaS assistant use?",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-alpha-vector",
							title: "Alpha vector retrieval notes",
							url: "https://example.com/alpha-vector",
							snippet:
								"Vector retrieval broadens semantic recall but needs exact-match safeguards for compliance terms.",
						},
						{
							id: "web-zeta-hybrid",
							title: "Zeta hybrid retrieval guide",
							url: "https://example.com/zeta-hybrid",
							snippet:
								"Hybrid retrieval preserves exact policy language while adding semantic discovery and reranking.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					prompts[input.stage] = input.prompt;
					if (input.stage === "decompose") {
						return {
							text: "regulated SaaS retrieval architecture",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "integrate") {
						return {
							text: JSON.stringify({
								sectionBriefs: [
									{
										sectionTitle: "Recommended Architecture",
										brief:
											"Choose the retrieval architecture with the strongest evidence.",
										evidencePackIds: [],
										sourceAssociations: [],
										limitations: [],
									},
								],
							}),
							usage: stageUsage(),
						};
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "Regulated SaaS Retrieval Choice",
								bodyMarkdown: decisionQualityReport(),
								sectionBriefs: [],
								limitations: [],
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-routed-writer-cards",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
				rerankWriterEvidenceCards,
			},
		});

		const assemblePrompt = JSON.parse(prompts.assemble);
		expect(
			assemblePrompt.writerEvidenceCards.map(
				(card: { sourceTitle: string }) => card.sourceTitle,
			),
		).toEqual(["Zeta hybrid retrieval guide", "Alpha vector retrieval notes"]);
		expect(assemblePrompt.writerEvidenceCardDiagnostics).toEqual([
			expect.objectContaining({
				code: "atlas_writer_evidence_cards_routing_reranked",
				severity: "info",
			}),
		]);
		expect(
			JSON.stringify(assemblePrompt.writerEvidenceCardDiagnostics),
		).not.toMatch(/score|confidence|0\.92|0\.31/i);
	});

	it("completes with deterministic writer card order when TEI routing is unavailable", async () => {
		const checkpoints: Array<{ checkpoint: Record<string, unknown> }> = [];
		const rerankWriterEvidenceCards = vi
			.fn<AtlasWriterEvidenceCardReranker>()
			.mockResolvedValue(null);

		const result = await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-writer-routing-fallback",
				profile: "overview",
				query: "Recommend retrieval architecture for regulated SaaS",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-alpha-vector-fallback",
							title: "Alpha vector retrieval fallback notes",
							url: "https://example.com/alpha-vector-fallback",
							snippet:
								"Vector retrieval fallback evidence covers semantic recall and compliance safeguards.",
						},
						{
							id: "web-zeta-hybrid-fallback",
							title: "Zeta hybrid retrieval fallback guide",
							url: "https://example.com/zeta-hybrid-fallback",
							snippet:
								"Hybrid retrieval fallback evidence covers exact policy language, semantic discovery, and reranking.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "regulated SaaS retrieval architecture",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "Writer Routing Fallback",
								bodyMarkdown: decisionQualityReport(),
								sectionBriefs: [],
								limitations: [],
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-routing-fallback",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
				rerankWriterEvidenceCards,
			},
		});

		expect(result.status).toBe("succeeded");
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				writer: {
					evidenceCards: {
						diagnostics: [
							expect.objectContaining({
								code: "atlas_writer_evidence_cards_routing_fallback",
							}),
						],
					},
				},
				writerEvidenceCards: [
					expect.objectContaining({
						sourceTitle: "Alpha vector retrieval fallback notes",
					}),
					expect.objectContaining({
						sourceTitle: "Zeta hybrid retrieval fallback guide",
					}),
				],
			},
		});
		const writerDiagnostics = JSON.stringify(
			(
				checkpoints.at(-1)?.checkpoint.writer as {
					evidenceCards?: { diagnostics?: unknown };
				}
			)?.evidenceCards?.diagnostics,
		);
		expect(writerDiagnostics).not.toMatch(/score|confidence/i);
	});

	it("runs coverage review after evidence packs and checkpoints diagnostics without executing gap fill yet", async () => {
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

		await runAtlasPipelineWithNoopReranker({
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
		const stages: string[] = [];
		const checkpointRounds: number[] = [];
		const heartbeat = vi.fn(async () => {});

		const result = await runAtlasPipelineWithNoopReranker({
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
						sectionTitle: "Findings",
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
					sectionTitle: "Findings",
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

		const result = await runAtlasPipelineWithNoopReranker({
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
		let renderedBlocks: Array<{ type?: string; [key: string]: unknown }> = [];
		let checkpoint: unknown = null;

		const result = await runAtlasPipelineWithNoopReranker({
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
		let renderedBlocks: Array<{ type?: string; [key: string]: unknown }> = [];

		const result = await runAtlasPipelineWithNoopReranker({
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
		const prompts: Record<string, string> = {};
		const writeCheckpoint = vi.fn(async () => {});
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
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
						checkpoint: {
							assembledMarkdown:
								"PRIOR_RAW_CHECKPOINT_SENTINEL raw appendix text from the parent checkpoint",
						},
						documentSourceSummary: {
							atlasFamily: { familyId: "atlas-family-1" },
							evidenceAppendixSummary: {
								status: "checkpoint_only",
								publishedReportIncludesRawExcerpts: false,
								rawExcerptPresent: true,
								rawSentinelForTest:
									"PRIOR_RAW_APPENDIX_SUMMARY_SENTINEL should not enter writer context",
							},
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
		expect(JSON.stringify(prompts)).not.toMatch(
			/PRIOR_RAW_CHECKPOINT_SENTINEL|PRIOR_RAW_APPENDIX_SUMMARY_SENTINEL/,
		);
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
		const prompts: Record<string, string> = {};
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
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
		expect(assemblePrompt.synthesis).toContain("Finding: hybrid retrieval");
		expect(assemblePrompt.outline).toContain("Hybrid retrieval tradeoffs");
		expect(assemblePrompt.curatedEvidence).toBeUndefined();
		expect(assemblePrompt.writerEvidenceCards).toEqual([
			expect.objectContaining({
				sourceTitle: "Evaluation report",
				relevantFacts: expect.arrayContaining([
					expect.stringContaining("Hybrid retrieval improves recall"),
				]),
			}),
		]);
		expect(assemblePrompt.instructions).toContain("decision-quality");
		expect(assemblePrompt.instructions).toContain(
			"Do not write Markdown Sources",
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

	it("keeps raw fetched excerpts out of the writer prompt while preserving them in checkpoints", async () => {
		const rawSnippet = [
			"Search result snippet: Retrieval docs explain hybrid retrieval ownership.",
			"Fetched page excerpt:",
			Array.from(
				{ length: 60 },
				(_, index) =>
					`RAW_WRITER_PROMPT_SENTINEL_${index} navigation boilerplate copied from the fetched page`,
			).join(" "),
		].join(" ");
		const prompts: Record<string, string> = {};
		const checkpoints: Array<{
			curatedSourcePool: {
				web: Array<{ snippet: string | null }>;
			};
		}> = [];

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-writer-cards-no-source-dump",
				profile: "overview",
				query:
					"Recommend the best retrieval architecture for a regulated SaaS knowledge assistant",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-hybrid",
							title: "Hybrid retrieval evidence",
							url: "https://example.com/hybrid",
							snippet: rawSnippet,
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					prompts[input.stage] = input.prompt;
					if (input.stage === "decompose") {
						return {
							text: "hybrid retrieval regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "Hybrid Retrieval Recommendation",
								bodyMarkdown: decisionQualityReport(),
								sectionBriefs: [
									{
										sectionTitle: "Recommended Architecture",
										brief: "Recommends hybrid retrieval with reranking.",
										evidencePackIds: [],
									},
								],
								limitations: [],
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-writer-cards",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		const assemblePrompt = JSON.parse(prompts.assemble);
		expect(assemblePrompt.writerEvidenceCards).toEqual([
			expect.objectContaining({
				sourceTitle: "Hybrid retrieval evidence",
				url: "https://example.com/hybrid",
				evidencePackIds: [expect.stringMatching(/^atlas-pack-v1-/)],
			}),
		]);
		expect(assemblePrompt.evidencePacks).toBeUndefined();
		expect(assemblePrompt.curatedEvidence).toBeUndefined();
		expect(JSON.stringify(assemblePrompt)).not.toMatch(
			/Fetched page excerpt|Search result snippet|RAW_WRITER_PROMPT_SENTINEL/i,
		);
		expect(checkpoints.at(-1)?.curatedSourcePool.web[0]?.snippet).toContain(
			"RAW_WRITER_PROMPT_SENTINEL_59",
		);
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				writer: {
					evidenceCards: {
						version: "atlas.writer-evidence-card.v1",
						count: 1,
					},
					improvement: {
						ran: false,
					},
				},
			},
		});
	});

	it("runs one bounded writer improvement pass for a thin non-decisive first draft", async () => {
		const assemblePrompts: string[] = [];
		const checkpoints: Array<{
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
		}> = [];
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const firstDraft = [
			"## Executive Summary",
			"Hybrid retrieval is relevant for regulated SaaS, but the first draft does not decide the architecture or explain the tradeoffs in enough detail.",
			"",
			"## Findings",
			"The accepted evidence mentions exact recall, semantic discovery, reranking, governance, latency, and validation, but the draft remains shallow.",
			"",
			"## Recommendation",
			"The evidence remains broad, and the final path is left unresolved.",
			"",
			"## Limitations",
			"Evidence is representative rather than exhaustive.",
		].join("\n");
		const secondDraft = [
			"## Executive Summary",
			"The report still remains concise after the bounded improvement pass, but it now states that hybrid retrieval with reranking is the preferred starting point.",
			"",
			"## Findings",
			"Hybrid retrieval keeps exact terms visible while semantic retrieval broadens recall, and reranking narrows candidates before generation. The draft is still intentionally compact for this regression.",
			"",
			"## Recommendation",
			"Use hybrid retrieval with reranking as the default and validate latency on the production corpus before rollout.",
			"",
			"## Limitations",
			"Evidence is representative rather than exhaustive.",
		].join("\n");

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-writer-improvement",
				profile: "overview",
				query:
					"Choose the best retrieval architecture for regulated SaaS with minimal latency",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-retrieval",
							title: "Hybrid retrieval latency evidence",
							url: "https://example.com/retrieval-latency",
							snippet:
								"Hybrid retrieval combines exact recall, semantic discovery, reranking, governance logging, and latency validation for regulated teams.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "hybrid retrieval latency regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						assemblePrompts.push(input.prompt);
						return {
							text: JSON.stringify({
								generatedTitle: "Regulated SaaS Retrieval Choice",
								bodyMarkdown:
									assemblePrompts.length === 1 ? firstDraft : secondDraft,
								sectionBriefs: [],
								limitations: ["Evidence is representative."],
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-writer-improvement",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assemblePrompts).toHaveLength(2);
		const improvementPrompt = JSON.parse(assemblePrompts[1]);
		expect(improvementPrompt.writerImprovement).toMatchObject({
			pass: 1,
			maxPasses: 1,
		});
		expect(improvementPrompt.currentDraft).toContain(
			"does not decide the architecture",
		);
		expect(JSON.stringify(improvementPrompt)).toContain("Do not add sources");
		expect(improvementPrompt.writerEvidenceCards).toEqual([
			expect.objectContaining({
				sourceTitle: "Hybrid retrieval latency evidence",
			}),
		]);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("preferred starting point"),
			}),
		);
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				reportShapeDiagnostics: expect.objectContaining({
					warnings: expect.arrayContaining([
						expect.objectContaining({
							code: "atlas_report_body_too_thin",
						}),
					]),
				}),
				writer: {
					improvement: {
						ran: true,
						passCount: 1,
					},
				},
			},
			qualityDiagnostics: {
				reportShapeDiagnostics: expect.objectContaining({
					warnings: expect.any(Array),
				}),
				writerImprovement: expect.objectContaining({
					ran: true,
					passCount: 1,
				}),
			},
		});
	});

	it("runs the bounded writer improvement pass after structural assembly repair returns a thin draft", async () => {
		const assemblePrompts: string[] = [];
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const repairedThinDraft = [
			"## Executive Summary",
			"Hybrid retrieval is relevant for regulated SaaS, but this repaired draft still does not decide the path or explain operational tradeoffs.",
			"",
			"## Findings",
			"The accepted evidence mentions exact recall, semantic discovery, reranking, governance, latency, and validation, but the synthesis remains shallow.",
			"",
			"## Recommendation",
			"The evidence remains broad, and the final path is left unresolved.",
			"",
			"## Limitations",
			"Evidence is representative rather than exhaustive.",
		].join("\n");
		const improvedDraft = [
			"## Executive Summary",
			decisionQualityReport().replace(/^## Executive Summary\n/, ""),
		].join("\n");

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-repair-then-improve",
				profile: "overview",
				query:
					"Choose the best retrieval architecture for regulated SaaS with minimal latency",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-retrieval-repair",
							title: "Hybrid retrieval repair evidence",
							url: "https://example.com/retrieval-repair",
							snippet:
								"Hybrid retrieval combines exact recall, semantic discovery, reranking, governance logging, latency validation, and auditability for regulated teams.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "hybrid retrieval latency regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						assemblePrompts.push(input.prompt);
						const assembleCall = assemblePrompts.length;
						return {
							text:
								assembleCall === 1
									? "I checked the sources and synthesized findings for the report."
									: JSON.stringify({
											generatedTitle: "Regulated SaaS Retrieval Choice",
											bodyMarkdown:
												assembleCall === 2 ? repairedThinDraft : improvedDraft,
											sectionBriefs: [],
											limitations: ["Evidence is representative."],
										}),
							usage: stageUsage(),
						};
					}
					return { text: `${input.stage} result`, usage: stageUsage() };
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-repair-then-improve",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assemblePrompts).toHaveLength(3);
		expect(JSON.parse(assemblePrompts[1]).repairInstruction).toContain(
			"process summary",
		);
		expect(JSON.parse(assemblePrompts[2]).writerImprovement).toMatchObject({
			pass: 1,
			maxPasses: 1,
		});
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining(
					"We recommend starting with hybrid retrieval",
				),
			}),
		);
	});

	it("skips writer improvement when honest fallback is used after failed assembly repair", async () => {
		const assemblePrompts: string[] = [];
		const checkpoints: Array<{
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
		}> = [];
		const fallbackStageText = [
			"Executive Summary: English technical-document retrieval needs a source-grounded comparison across retrieval quality, latency, cost, hardware fit, deployment risk, reranking support, language coverage, and maintenance boundaries, but the fallback draft only names those dimensions without turning them into a deployment decision for the operator.",
			"Findings: BGE, GTE, E5, Jina, and Nomic model families appear in the accepted evidence with different multilingual coverage, embedding dimensions, serving assumptions, and operational maturity.",
			"Tradeoffs: Quality signals, memory pressure, batching behavior, reranking depth, and model dimension choices interact in production, but the fallback draft does not rank the consequences.",
			"Recommendation: Recommendation for English Technical-Document Retrieval.",
			"Model Shortlist: The candidate set needs ranking by retrieval quality, single-GPU fit, serving maturity, multilingual behavior, and whether a compatible reranker is practical.",
			"Retrieval Quality: Benchmark references are useful but incomplete because production retrieval depends on chunking, query mix, reranker availability, and validation against representative technical documents.",
			"Latency and Cost: Latency and cost depend on embedding dimension, batching, quantization, reranking depth, serving runtime, and resident memory for both embedder and reranker.",
			"Deployment Implications: Single-RT deployment favors predictable memory requirements, stable serving support, clear licensing, simple observability, and enough English-first technical-domain coverage.",
			"Evidence Gaps: Several accepted sources discuss benchmarks or production factors separately, but few connect all constraints into a definitive single-GPU deployment comparison.",
			"Limitations: The accepted evidence remains incomplete across identical hardware, identical corpora, and current production latency measurements, so confidence is bounded by source coverage.",
		].join("\n");
		const improvedDraft = [
			"## Executive Summary",
			"For English technical-document retrieval on a single RT-class machine, start with a strong small-to-mid multilingual embedding model plus a reranker rather than picking the largest embedder by benchmark score alone. This is the most robust recommendation because quality, latency, memory residency, and serving maturity all affect production retrieval more than one leaderboard position. The accepted evidence supports a shortlist-oriented decision rather than a broad source recap.",
			"",
			"## Ranked Shortlist",
			"Rank the candidates by production fit: first choose the model family that gives the best quality-per-parameter ratio on your corpus, then validate a compatible reranker, and only then consider larger embedding dimensions. BGE/GTE/E5-style families remain credible candidates because the decision hinges on English technical recall, serving support, and reranker compatibility. Jina and Nomic-style options should stay in the shortlist when licensing, dimensions, or deployment tooling better match the stack.",
			"",
			"## Tradeoffs and Deployment Implications",
			"The key tradeoff is not only retrieval quality; it is whether the embedder and reranker can stay resident with acceptable batch latency. Higher dimensions may improve recall but increase storage, bandwidth, and reranking pressure, while smaller models can win if they leave enough room for a reranker. Validate chunking, query mix, recall@10, NDCG, and p95 latency on the actual technical corpus before locking the stack.",
			"",
			"## Recommendation",
			"We recommend deploying a compact, well-supported embedding model with a compatible reranker as the default path, then promoting a larger model only if corpus tests show a material recall gain within the latency budget. This gives the team a measurable rollout path: benchmark the shortlist, keep source-level logging, and tune reranking depth before scaling.",
			"",
			"## Key tradeoff",
			"8B-class models can improve benchmark quality, but they are not the default for a latency-constrained single-RT deployment unless measured corpus recall justifies the memory and serving cost.",
			"",
			"## - Nemotron-8B",
			"Nemotron-style larger models belong in the high-accuracy evaluation lane, not as a heading that replaces the recommendation structure.",
			"",
			"## Limitations",
			"The accepted evidence does not provide identical hardware and corpus measurements for every candidate, so the recommendation should be treated as a deployment starting point. Final selection still depends on licensing, serving runtime, available memory, and measured latency on the user's documents.",
		].join("\n");
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-fallback-then-improve",
				profile: "overview",
				query:
					"Find the most intelligent embedding model with minimal latency and cost that can be self-hosted on a single RT-class machine",
			}),
			now: new Date("2026-06-22T02:12:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-embedding-models",
							title: "Best self-hosted embedding model evidence",
							url: "https://example.com/embedding-models",
							snippet:
								"Self-hosted embedding model selection depends on retrieval quality, latency, embedding dimensions, serving support, reranking compatibility, and production validation.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "self hosted embedding models English technical document retrieval latency cost single GPU reranker",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "synthesize") {
						return { text: fallbackStageText, usage: stageUsage() };
					}
					if (input.stage === "integrate") {
						return {
							text: [
								"Executive Summary",
								"Model Shortlist",
								"Retrieval Quality",
								"Latency and Cost",
								"Deployment Implications",
								"Recommendation",
								"Limitations",
								"Evidence Gaps",
							].join("; "),
							usage: stageUsage(),
						};
					}
					if (input.stage === "assemble") {
						assemblePrompts.push(input.prompt);
						return {
							text:
								assemblePrompts.length < 4
									? "I checked the sources and synthesized findings for the report."
									: JSON.stringify({
											generatedTitle: "Self-Hosted Embedding Model Choice",
											bodyMarkdown: improvedDraft,
											sectionBriefs: [],
											limitations: [
												"Identical hardware measurements are not available for every candidate.",
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-fallback-then-improve",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assemblePrompts).toHaveLength(3);
		expect(JSON.parse(assemblePrompts[1]).repairInstruction).toContain(
			"process summary",
		);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("## Evidence Summary"),
			}),
		);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).toContain("could not synthesize");
		expect(auditInput?.assembledMarkdown).toContain(
			"Self-hosted embedding model selection depends on retrieval quality",
		);
		expect(auditInput?.assembledMarkdown).toContain("## Limitations");
		expect(auditInput?.assembledMarkdown).not.toContain("## Findings");
		expect(auditInput?.assembledMarkdown).not.toContain("## Tradeoffs");
		expect(auditInput?.assembledMarkdown).not.toContain("## Recommendation");
		expect(auditInput?.assemblyMetadata.sectionBriefs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sectionTitle: "Executive Summary" }),
				expect.objectContaining({ sectionTitle: "Evidence Summary" }),
				expect.objectContaining({ sectionTitle: "Limitations" }),
			]),
		);
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				writer: {
					improvement: {
						ran: false,
						passCount: 0,
						startedAfterDeterministicFallback: true,
						skippedReason: "honest_fallback_does_not_need_improvement",
					},
					firstDraftReportShapeDiagnostics: expect.objectContaining({
						warnings: expect.arrayContaining([
							expect.objectContaining({
								code: "atlas_report_body_too_thin",
							}),
						]),
					}),
				},
			},
			qualityDiagnostics: {
				writerImprovement: expect.objectContaining({
					ran: false,
					passCount: 0,
					startedAfterDeterministicFallback: true,
					skippedReason: "honest_fallback_does_not_need_improvement",
				}),
			},
		});
	});

	it("uses honest fallback when the writer improvement pass returns malformed output", async () => {
		const assemblePrompts: string[] = [];
		const checkpoints: Array<{
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
		}> = [];
		const firstDraft = [
			"## Executive Summary",
			"Self-hosted embedding choices depend on retrieval quality, latency, memory use, serving maturity, reranker fit, and validation against representative technical documents. The current evidence points to a shortlist, but this report keeps the production implications compressed.",
			"",
			"## Recommendation",
			"The options remain plausible, but this paragraph stays too compact for production deployment.",
			"",
			"## Limitations",
			"Evidence is representative and still needs local validation across the target corpus, hardware budget, and review workflow.",
		].join("\n");
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-improvement-malformed-fallback",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-improvement-malformed-fallback",
				profile: "overview",
				query:
					"Compare the best self-hosted embedding models for English technical-document retrieval with minimal latency and cost on a single RT-class machine",
			}),
			now: new Date("2026-06-22T08:30:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: evidenceRichEmbeddingSources(),
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "self hosted embedding models English technical document retrieval latency cost single GPU reranker",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "synthesize") {
						return {
							text: "The accepted evidence supports an embedding shortlist, latency budget, reranker fit analysis, and production validation limits.",
							usage: stageUsage(),
						};
					}
					if (input.stage === "integrate") {
						return {
							text: [
								"Executive Summary",
								"Architecture Families",
								"Serving Profile",
								"Evaluation Plan",
								"Operator Workflow",
								"Recommendation",
								"Limitations",
							].join("; "),
							usage: stageUsage(),
						};
					}
					if (input.stage === "assemble") {
						assemblePrompts.push(input.prompt);
						if (assemblePrompts.length === 1) {
							return {
								text: JSON.stringify({
									generatedTitle: "Self-Hosted Embedding Model Choice",
									bodyMarkdown: firstDraft,
									sectionBriefs: [],
									limitations: [],
								}),
								usage: stageUsage(),
							};
						}
						return {
							text: "I checked the sources and synthesized findings for the report.",
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

		expect(assemblePrompts).toHaveLength(2);
		const improvementPrompt = JSON.parse(assemblePrompts[1]);
		expect(improvementPrompt.writerImprovement).toMatchObject({
			pass: 1,
			maxPasses: 1,
		});
		expect(improvementPrompt.currentDraft).toContain(
			"production implications compressed",
		);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("## Evidence Summary"),
			}),
		);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).toContain("could not synthesize");
		expect(auditInput?.assembledMarkdown).toContain(
			"Accepted evidence 1 covers self-hosted embedding model selection",
		);
		expect(auditInput?.assembledMarkdown).not.toContain("## Recommendation");
		expect(auditInput?.assembledMarkdown).not.toContain("## Tradeoffs");
		const renderedSource = renderOutputs.mock.calls[0]?.[0];
		const renderedText = renderedSource.blocks
			.flatMap((block) => {
				if (block.type === "heading" || block.type === "paragraph") {
					return [block.text];
				}
				if (block.type === "list") return block.items;
				return [];
			})
			.join("\n");
		expect(renderedText).toContain("could not synthesize");
		expect(renderedText).toContain("raw and unranked");
		expect(checkpoints.at(-1)).toMatchObject({
			qualityDiagnostics: {
				writerImprovement: expect.objectContaining({
					ran: true,
					passCount: 1,
					startedAfterDeterministicFallback: false,
				}),
			},
		});
	});

	it("runs the bounded writer improvement pass for a 450-600 word multi-section draft before audit", async () => {
		const assemblePrompts: string[] = [];
		const checkpoints: Array<{
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
		}> = [];
		const firstDraft = underdevelopedMultiSectionDraft();
		const improvedDraft = [
			"## Executive Summary",
			"For regulated SaaS, use hybrid retrieval plus reranking as the default because it balances exact policy recall, semantic discovery, and auditable evidence selection. Keyword-only retrieval is too brittle for conceptual questions, while vector-only retrieval can miss exact compliance wording that reviewers need to inspect. The practical decision is to keep retrieval broad at first, then use reranking and source-level logging to make final evidence selection reviewable.",
			"",
			"## Ranked Architecture Choice",
			"First, deploy hybrid retrieval with lexical and vector candidates feeding a reranker. Second, keep vector-only retrieval as a fallback for exploratory discovery where exact policy language is less important. Third, avoid keyword-only retrieval for the main assistant path unless the corpus is narrow and the questions are predictable. This ranking gives the team a default architecture and a clear reason to reject simpler but weaker alternatives.",
			"",
			"## Deployment and Operating Implications",
			"The rollout should begin with corpus-specific recall and latency tests, not a generic benchmark decision. Measure recall@10, reranker precision, citation coverage, p95 latency, and reviewer acceptance on representative policy, support, and product documents. Keep query logs, selected source IDs, reranker scores, and rejected-source samples so compliance reviewers can inspect both what the assistant used and what it ignored.",
			"",
			"## Recommendation",
			"We recommend piloting hybrid retrieval plus reranking on the highest-value regulated workflows first, then expanding only if the measured recall gain justifies the extra latency and operating cost. Set a latency budget before rollout, tune reranking depth inside that budget, and require evidence-level logging before exposing the assistant to production users.",
			"",
			"## Limitations",
			"The evidence is representative rather than exhaustive, so the final architecture still needs validation against the team's corpus, access rules, and compliance review process. If reranking does not materially improve accepted-source quality inside the latency budget, the team should reduce reranker depth or limit it to high-risk queries.",
		].join("\n");
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-underdeveloped-multisection-improvement",
				profile: "overview",
				query:
					"Choose the best retrieval architecture for regulated SaaS with auditable evidence and low latency",
			}),
			now: new Date("2026-06-22T08:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-underdeveloped-retrieval",
							title: "Hybrid retrieval deployment evidence",
							url: "https://example.com/hybrid-retrieval-deployment",
							snippet:
								"Hybrid retrieval evidence covers exact policy recall, semantic discovery, reranking, source logging, latency budgets, and regulated SaaS validation.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "hybrid retrieval reranking regulated SaaS auditability latency",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						assemblePrompts.push(input.prompt);
						return {
							text: JSON.stringify({
								generatedTitle: "Regulated SaaS Retrieval Architecture",
								bodyMarkdown:
									assemblePrompts.length === 1 ? firstDraft : improvedDraft,
								sectionBriefs: [],
								limitations: ["Evidence is representative."],
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-underdeveloped-multisection",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assemblePrompts).toHaveLength(2);
		const improvementPrompt = JSON.parse(assemblePrompts[1]);
		expect(improvementPrompt.writerImprovement).toMatchObject({
			pass: 1,
			maxPasses: 1,
			warningCodes: expect.arrayContaining([
				"atlas_report_underdeveloped_for_section_count",
			]),
		});
		expect(improvementPrompt.reportShapeDiagnostics).toMatchObject({
			sectionCount: 9,
			warnings: expect.arrayContaining([
				expect.objectContaining({
					code: "atlas_report_underdeveloped_for_section_count",
				}),
			]),
		});
		expect(
			improvementPrompt.reportShapeDiagnostics.bodyWordCount,
		).toBeGreaterThanOrEqual(450);
		expect(
			improvementPrompt.reportShapeDiagnostics.bodyWordCount,
		).toBeLessThanOrEqual(600);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining(
					"For regulated SaaS, use hybrid retrieval plus reranking",
				),
			}),
		);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		expect(auditCalls[0]?.[0].assembledMarkdown).not.toContain(
			"the draft still lacks concrete sequencing",
		);
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				writer: {
					improvement: {
						ran: true,
						passCount: 1,
						reasonWarningCodes: expect.arrayContaining([
							"atlas_report_underdeveloped_for_section_count",
						]),
					},
					firstDraftReportShapeDiagnostics: expect.objectContaining({
						bodyWordCount: expect.any(Number),
						sectionCount: 9,
						warnings: expect.arrayContaining([
							expect.objectContaining({
								code: "atlas_report_underdeveloped_for_section_count",
							}),
						]),
					}),
				},
			},
			qualityDiagnostics: {
				writerImprovement: expect.objectContaining({
					ran: true,
					passCount: 1,
					reasonWarningCodes: expect.arrayContaining([
						"atlas_report_underdeveloped_for_section_count",
					]),
				}),
			},
		});
	});

	it("runs one writer improvement pass for an evidence-rich sparse decision draft before audit", async () => {
		const assemblePrompts: string[] = [];
		const checkpoints: Array<{
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
		}> = [];
		const firstDraft = liveSparseEvidenceRichDecisionDraft();
		const improvedDraft = [
			"## Executive Summary",
			"For English technical-document retrieval on a single self-hosted machine, start with a compact, actively supported embedding model and a compatible reranker rather than defaulting to the largest benchmark leader. This choice gives the team a practical balance of recall, latency, memory headroom, and source-level review. The accepted evidence supports a decision workflow: shortlist credible model families, test them on the target corpus, and promote the larger option only when measured recall justifies the extra serving cost. The decision is therefore not a generic model leaderboard choice; it is an operating choice about how much latency and memory the retrieval layer can spend for better accepted-source quality.",
			"",
			"## Ranked Shortlist",
			"Keep BGE, GTE, E5, Jina, Nomic, and Qwen-style candidates in the evaluation lane, but rank them by production fit rather than name recognition. The first tier should be models with stable serving support, acceptable dimensions, and a reranker path that fits the hardware budget. The second tier should include larger or more specialized models that may win on recall but need evidence that the improvement survives latency, indexing, and memory constraints. This ranking lets the team test credible defaults first while keeping high-cost candidates available for cases where corpus-specific recall is not good enough.",
			"",
			"## Evaluation Plan",
			"Run the shortlist against representative technical documents with fixed chunking, metadata filters, and queries that reflect real user work. Measure recall@10, citation coverage, reranker lift, p95 latency, memory residency, and reviewer acceptance. Promote a larger embedder only if it improves accepted-source quality enough to justify the operational cost; otherwise keep the compact model and spend the latency budget on reranking depth. The evaluation should include failed or borderline queries because those cases reveal whether the reranker improves evidence selection or only reshuffles already obvious matches.",
			"",
			"## Deployment and Operating Implications",
			"Treat deployment as a staged pilot. Keep source IDs, reranker scores, rejected-source samples, index build metadata, and rollback plans visible so operators can inspect failures without guessing why evidence was selected. Reserve memory for the reranker and serving runtime, set a p95 latency budget before launch, and avoid model choices that require frequent index rebuilds without a measurable quality gain. The rollout should start with a narrow technical-document workflow, then expand after operators can explain misses, stale matches, and latency spikes from recorded retrieval traces.",
			"",
			"## Recommendation",
			"We recommend a compact embedding model with a compatible reranker as the default deployment path, validated against the user's technical-document corpus before rollout. Avoid choosing an 8B-class or high-dimension model solely from benchmark position unless the team proves a material recall gain within the latency and memory budget. The evidence is strong enough for a ranked starting point, but final selection still depends on corpus tests and hardware measurements. If the compact model misses critical technical terms, first tune chunking and reranking depth; only then move to a larger embedder if the measured gain is material.",
			"",
			"## Limitations",
			"The accepted evidence does not provide identical hardware, corpus, and latency measurements for every candidate, so the final choice should remain tied to the user's validation data. Treat the recommendation as a deployment starting point, not as a universal benchmark claim. Licensing, serving runtime, quantization support, and document mix can all change the result, so the team should keep the shortlist active until pilot measurements show a stable quality and latency margin.",
		].join("\n");
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-evidence-rich-sparse-decision-improvement",
				profile: "overview",
				query:
					"Compare and recommend the best self-hosted embedding model for English technical-document retrieval with minimal latency and cost",
			}),
			now: new Date("2026-06-22T09:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: evidenceRichEmbeddingSources(),
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "self hosted embedding model comparison technical document retrieval latency cost reranker",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "synthesize") {
						return {
							text: "The evidence supports a source-grounded model shortlist, latency budget, reranker fit analysis, and deployment recommendation.",
							usage: stageUsage(),
						};
					}
					if (input.stage === "integrate") {
						return {
							text: [
								"Executive Summary",
								"Model Shortlist",
								"Retrieval Quality",
								"Latency and Cost",
								"Deployment Implications",
								"Recommendation",
							].join("; "),
							usage: stageUsage(),
						};
					}
					if (input.stage === "assemble") {
						assemblePrompts.push(input.prompt);
						return {
							text: JSON.stringify({
								generatedTitle: "Self-Hosted Embedding Model Decision",
								bodyMarkdown:
									assemblePrompts.length === 1 ? firstDraft : improvedDraft,
								sectionBriefs: [],
								limitations: ["Evidence is representative."],
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-evidence-rich-sparse",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assemblePrompts).toHaveLength(2);
		const firstWriterPrompt = JSON.parse(assemblePrompts[0]);
		expect(firstWriterPrompt.writerEvidenceCards).toHaveLength(16);
		const improvementPrompt = JSON.parse(assemblePrompts[1]);
		const firstWarningCodes =
			improvementPrompt.reportShapeDiagnostics.warnings.map(
				(warning: { code: string }) => warning.code,
			);
		expect(improvementPrompt.writerImprovement).toMatchObject({
			pass: 1,
			maxPasses: 1,
			warningCodes: expect.arrayContaining([
				"atlas_evidence_rich_decision_report_underdeveloped",
			]),
		});
		expect(improvementPrompt.reportShapeDiagnostics).toMatchObject({
			sectionCount: 6,
			hasDecisionOrRecommendationSignal: true,
		});
		expect(
			improvementPrompt.reportShapeDiagnostics.bodyWordCount,
		).toBeGreaterThanOrEqual(550);
		expect(
			improvementPrompt.reportShapeDiagnostics.bodyWordCount,
		).toBeLessThanOrEqual(590);
		expect(firstWarningCodes).toContain(
			"atlas_evidence_rich_decision_report_underdeveloped",
		);
		expect(firstWarningCodes).not.toContain(
			"atlas_report_underdeveloped_for_section_count",
		);
		expect(auditBasis).toHaveBeenCalledTimes(1);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining(
					"For English technical-document retrieval on a single self-hosted machine",
				),
			}),
		);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		expect(auditCalls[0]?.[0].assembledMarkdown).not.toContain(
			"still gives each criterion only a narrow treatment",
		);
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				writer: {
					evidenceCards: {
						count: 16,
					},
					improvement: {
						ran: true,
						passCount: 1,
						reasonWarningCodes: expect.arrayContaining([
							"atlas_evidence_rich_decision_report_underdeveloped",
						]),
					},
					firstDraftReportShapeDiagnostics: expect.objectContaining({
						bodyWordCount: expect.any(Number),
						sectionCount: 6,
						warnings: expect.arrayContaining([
							expect.objectContaining({
								code: "atlas_evidence_rich_decision_report_underdeveloped",
							}),
						]),
					}),
				},
			},
			qualityDiagnostics: {
				writerImprovement: expect.objectContaining({
					ran: true,
					passCount: 1,
					reasonWarningCodes: expect.arrayContaining([
						"atlas_evidence_rich_decision_report_underdeveloped",
					]),
				}),
			},
		});
	});

	it("appends additional limitations instead of replacing hollow post-audit output", async () => {
		const checkpoints: Array<{
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
		}> = [];
		const sourceDump = Array.from(
			{ length: 620 },
			(_, index) => `sourceword${index}`,
		).join(" ");
		const hollowImprovedDraft = [
			"## Executive Summary",
			"Self-hosted embedding model selection needs evidence across quality, latency, memory, and reranker fit, but the draft still leaves most deployment consequences underdeveloped.",
			"",
			"## No single model dominates all domains",
			"Benchmark leaders vary by domain and deployment constraint.",
			"",
			"## Qwen3 supports output dimensions 32-1024",
			"Dimension flexibility matters for storage and latency.",
			"",
			"## Model Shortlist",
			"BGE, GTE, E5, Jina, Nomic, and Qwen-style candidates remain plausible depending on the corpus.",
			"",
			"## Retrieval Quality",
			"Quality depends on chunking, query mix, reranking, and domain vocabulary.",
			"",
			"## Latency and Cost",
			"Latency depends on dimension count, batching, quantization, and serving runtime.",
			"",
			"## Deployment Implications",
			"Single-machine deployment needs predictable memory and stable operational support.",
			"",
			"## Recommendation",
			"Recommendation for English Technical-Document Retrieval.",
			"",
			"## Evidence Gaps",
			"Few sources compare every model on identical hardware and corpus settings.",
			"",
			"## Limitations",
			"The evidence remains representative rather than exhaustive.",
		].join("\n");
		let assembleCalls = 0;
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-final-expansion",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-final-quality-expansion",
				profile: "overview",
				query:
					"Live Atlas regression check 2026-06-22T01:06:07.989Z. Compare the best self-hosted embedding models for English technical-document retrieval with minimal latency and cost. Use current web evidence. Include",
			}),
			now: new Date("2026-06-22T02:42:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-embedding-models-final",
							title: "Self-hosted embedding model deployment evidence",
							url: "https://example.com/embedding-models-final",
							snippet: `Self-hosted embedding model evidence covers retrieval quality, latency, memory, embedding dimensions, reranker compatibility, serving maturity, and production validation. ${sourceDump}`,
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				searchImages: vi.fn(async () => ({
					imageCandidates: [
						{
							id: "image-generic-cover",
							query: "embedding model retrieval reranking architecture",
							title: "Blog cover image",
							imageUrl:
								"https://zilliz.com/blog/assets/embedding-rag-cover.png",
							sourcePageUrl: "https://zilliz.com/blog/embedding-models-rag",
							sourceTitle: "Zilliz blog cover for embedding models",
							thumbnailUrl: null,
							width: 1200,
							height: 675,
							caption: "Featured image for an embedding models article",
							selectionReason: "Image result for embedding retrieval.",
						},
					],
					imageLimitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "self hosted embedding models English technical document retrieval latency cost single GPU reranker",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "synthesize") {
						return {
							text: [
								"Executive Summary: English technical-document retrieval needs a source-grounded model comparison across retrieval quality, latency, cost, hardware fit, deployment risk, reranking support, language coverage, and maintenance boundaries.",
								"Findings: Accepted evidence connects embedding dimensions, serving maturity, reranker compatibility, memory pressure, and production validation to the model choice.",
								"Tradeoffs: Larger dimensions and benchmark leaders can improve quality but increase storage, memory, and latency pressure.",
								"Recommendation: Comprehensive comparison of the best embedding models in 2026. MTEB benchmarks, multilingual performance, and recommendations for your RAG applications. News Embedding Models 2026: Benchmark and Comparison April 21, 2026 10 min read Ailog Team.",
							].join("\n"),
							usage: stageUsage(),
						};
					}
					if (input.stage === "integrate") {
						return {
							text: [
								"Executive Summary",
								"Model Shortlist",
								"Retrieval Quality",
								"Latency and Cost",
								"Deployment Implications",
								"Recommendation",
								"Limitations",
								"Evidence Gaps",
							].join("; "),
							usage: stageUsage(),
						};
					}
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text:
								assembleCalls === 1
									? JSON.stringify({
											generatedTitle:
												"self-hosted embedding models for English technical-document retrieval in 2026. Use current web evidence. Include",
											bodyMarkdown:
												"## Executive Summary\nThe first draft is too shallow and does not decide the deployment path.",
											sectionBriefs: [],
											limitations: [],
										})
									: JSON.stringify({
											generatedTitle:
												"self-hosted embedding models for English technical-document retrieval in 2026. Use current web evidence. Include",
											bodyMarkdown: hollowImprovedDraft,
											sectionBriefs: [],
											limitations: [
												"Identical hardware measurements are not available for every candidate.",
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

		expect(auditBasis).toHaveBeenCalledTimes(1);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const firstAuditInput = auditCalls[0]?.[0];
		expect(firstAuditInput?.assembledMarkdown).toContain(
			"No single model dominates all domains",
		);
		expect(firstAuditInput?.assembledMarkdown).toContain(
			"Qwen3 supports output dimensions 32-1024",
		);
		const renderedSource = renderOutputs.mock.calls[0]?.[0];
		expect(renderedSource.title).toBe(
			"Self-hosted embedding models for English technical-document retrieval in 2026",
		);
		expect(
			renderedSource.blocks.filter((block) => block.type === "image"),
		).toHaveLength(0);
		const renderedText = renderedSource.blocks
			.flatMap((block) => {
				if (block.type === "heading" || block.type === "paragraph") {
					return [block.text];
				}
				return [];
			})
			.join("\n");
		expect(renderedText).toContain("No single model dominates all domains");
		expect(renderedText).toContain("Qwen3 supports output dimensions 32-1024");
		expect(renderedText).toContain("Additional Limitations");
		expect(renderedText).toContain(
			"report may be too thin, too source-dominated, or too shallow",
		);
		expect(renderedText).toContain("Self-hosted embedding model selection");
		expect(renderedText).not.toContain("That makes this section useful");
		expect(renderedText).not.toContain(
			"The evidence should therefore be read as a decision checkpoint",
		);
		const finalCheckpoint = checkpoints.at(-1);
		expect(finalCheckpoint).toMatchObject({
			checkpoint: {
				writer: {
					finalReportQualityGate: expect.objectContaining({
						passed: false,
						fallbackApplied: false,
						reasonWarningCodes: expect.arrayContaining([
							"atlas_report_sections_too_sparse",
							"atlas_too_many_one_sentence_sections",
							"atlas_final_body_word_count_too_low",
						]),
					}),
					finalReportShapeDiagnostics: expect.objectContaining({
						sourceWordShare: expect.any(Number),
					}),
				},
			},
			qualityDiagnostics: {
				writer: {
					finalReportQualityGate: expect.objectContaining({
						fallbackApplied: false,
					}),
				},
			},
		});
		expect(
			(
				finalCheckpoint?.checkpoint.writer as {
					finalReportShapeDiagnostics?: { sourceWordShare: number };
				}
			).finalReportShapeDiagnostics?.sourceWordShare,
		).toEqual(expect.any(Number));
	});

	it("does not run the writer improvement pass for a substantive first draft", async () => {
		const assemblePrompts: string[] = [];
		const checkpoints: Array<{ checkpoint: Record<string, unknown> }> = [];

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-writer-no-improvement",
				profile: "overview",
				query: "Recommend the best retrieval architecture for regulated SaaS",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-retrieval-good",
							title: "Hybrid retrieval decision evidence",
							url: "https://example.com/retrieval-good",
							snippet:
								"Hybrid retrieval evidence supports exact recall, semantic discovery, reranking, governance, latency validation, and auditability for regulated SaaS.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "hybrid retrieval regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						assemblePrompts.push(input.prompt);
						return {
							text: JSON.stringify({
								generatedTitle: "Hybrid Retrieval Decision",
								bodyMarkdown: decisionQualityReport(),
								sectionBriefs: [],
								limitations: [],
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-no-improvement",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assemblePrompts).toHaveLength(1);
		expect(checkpoints.at(-1)).toMatchObject({
			checkpoint: {
				reportShapeDiagnostics: expect.objectContaining({
					warnings: [],
				}),
				writer: {
					improvement: {
						ran: false,
						passCount: 0,
					},
				},
			},
		});
	});

	it("checkpoints final report-shape diagnostics from the rendered document source", async () => {
		const checkpoints: Array<{
			checkpoint: Record<string, unknown>;
			qualityDiagnostics: Record<string, unknown>;
			documentSourceSummary: Record<string, unknown>;
		}> = [];
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-document-source-shape",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));
		const thinMarkdownWithoutImages = [
			"## Executive Summary",
			"We recommend hybrid retrieval for regulated SaaS because it preserves exact policy language while still supporting semantic discovery.",
			"",
			"## Hybrid Architecture",
			"Hybrid retrieval keeps lexical and vector search separate so reviewers can inspect why evidence was selected.",
			"",
			"## Reranking Layer",
			"Reranking narrows noisy candidates before generation and gives the team a clear review point.",
			"",
			"## Governance Controls",
			"Governance logging should record source selection and final citations for later audit.",
			"",
			"## Latency Budget",
			"Teams should validate the reranking step against their own latency target before rollout.",
			"",
			"## Limitations",
			"Evidence is representative and should be validated against the production corpus.",
		].join("\n");

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-document-source-shape",
				profile: "overview",
				query: "Recommend hybrid retrieval architecture for regulated SaaS",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-document-source-shape",
							title: "Hybrid retrieval architecture evidence",
							url: "https://example.com/hybrid-architecture",
							snippet:
								"Hybrid retrieval architecture evidence covers reranking, governance controls, and latency budgets for regulated SaaS.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				searchImages: vi.fn(async () => ({
					imageCandidates: [
						{
							id: "image-hybrid-architecture",
							query: "hybrid retrieval architecture regulated SaaS",
							title: "Hybrid retrieval architecture diagram",
							imageUrl: "https://cdn.example.com/hybrid-architecture.png",
							sourcePageUrl: "https://example.com/hybrid-architecture",
							sourceTitle: "Hybrid retrieval architecture evidence",
							thumbnailUrl:
								"https://cdn.example.com/hybrid-architecture-thumb.png",
							width: 1200,
							height: 675,
							caption:
								"Hybrid retrieval architecture diagram for regulated SaaS evidence selection.",
							selectionReason:
								"Matches the hybrid architecture section in the report.",
						},
						{
							id: "image-reranking-layer",
							query: "reranking layer evidence selection",
							title: "Reranking layer workflow",
							imageUrl: "https://cdn.example.com/reranking-layer.png",
							sourcePageUrl: "https://example.com/reranking-layer",
							sourceTitle: "Hybrid retrieval architecture evidence",
							thumbnailUrl: "https://cdn.example.com/reranking-layer-thumb.png",
							width: 1200,
							height: 675,
							caption:
								"Reranking layer workflow for narrowing evidence candidates before generation.",
							selectionReason:
								"Matches the reranking layer section in the report.",
						},
					],
					imageLimitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return {
							text: "hybrid retrieval architecture regulated SaaS",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "Rendered Source Shape Atlas",
								bodyMarkdown: thinMarkdownWithoutImages,
								sectionBriefs: [],
								limitations: [],
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
			},
		});

		const finalCheckpoint = checkpoints.at(-1);
		const renderedSource = renderOutputs.mock.calls[0]?.[0];
		expect(
			renderedSource?.blocks.filter((block) => block.type === "image"),
		).toHaveLength(1);
		expect(finalCheckpoint).toMatchObject({
			checkpoint: {
				reportShapeDiagnostics: expect.objectContaining({
					imageCount: 1,
				}),
			},
			qualityDiagnostics: {
				reportShapeDiagnostics: expect.objectContaining({
					imageCount: 1,
				}),
			},
			documentSourceSummary: {
				writer: {
					reportShapeDiagnostics: expect.objectContaining({
						imageCount: 1,
					}),
				},
			},
		});
	});

	it("repairs a process-only assembled draft before audit and rendering", async () => {
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

		await runAtlasPipelineWithNoopReranker({
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

	it("falls back to an honest evidence summary when assembly remains source-only", async () => {
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

		await runAtlasPipelineWithNoopReranker({
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
				assembledMarkdown: expect.stringContaining("## Evidence Summary"),
			}),
		);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).toContain("could not synthesize");
		expect(auditInput?.assembledMarkdown).toContain("## Limitations");
		expect(auditInput?.assembledMarkdown).not.toContain("## Findings");
		expect(auditInput?.assembledMarkdown).not.toContain("## Recommendation");
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "list",
						items: expect.arrayContaining([
							expect.stringContaining("filesystem based"),
						]),
					}),
				]),
			}),
		);
	});

	it("uses the honest fallback no-evidence message when no accepted evidence packs are available", async () => {
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-empty-evidence",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-empty-honest-fallback",
				profile: "overview",
				title: "Empty evidence fallback",
				query: "Compare current enterprise RAG architectures",
			}),
			now: new Date("2026-06-21T18:32:54.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [],
					rejectedSources: [],
					limitation: {
						code: "atlas_search_no_results",
						message: "Search returned no accepted current web evidence.",
					},
				})),
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "coverage-review"
							? coverageReviewText([], true)
							: input.stage === "assemble"
								? "I checked the sources and synthesized findings for the report."
								: `${input.stage} result`,
					usage: stageUsage(),
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
		expect(auditInput?.assembledMarkdown).toContain(
			"Atlas gathered 0 accepted evidence packs",
		);
		expect(auditInput?.assembledMarkdown).toContain("## Evidence Summary");
		expect(auditInput?.assembledMarkdown).toContain(
			"No usable evidence pack summaries were available.",
		);
		expect(auditInput?.assembledMarkdown).toContain(
			"Search returned no accepted current web evidence.",
		);
		expect(auditInput?.assembledMarkdown).not.toContain("## Findings");
		expect(auditInput?.assembledMarkdown).not.toContain("## Recommendation");
		const renderedSource = renderOutputs.mock.calls[0]?.[0];
		const renderedText = renderedSource.blocks
			.flatMap((block) => {
				if (block.type === "heading" || block.type === "paragraph") {
					return [block.text];
				}
				if (block.type === "list") return block.items;
				return [];
			})
			.join("\n");
		expect(renderedText).toContain(
			"No usable evidence pack summaries were available.",
		);
	});

	it("localizes the honest fallback shape for Hungarian reports", async () => {
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-hu-fallback",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-hu-honest-fallback",
				profile: "overview",
				title: "Magyar Atlas fallback",
				query:
					"Hasonlítsd össze a saját üzemeltetésű beágyazási modelleket magyar és angol műszaki dokumentumokhoz",
			}),
			now: new Date("2026-06-21T18:32:54.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-hu-embedding",
							title: "Saját üzemeltetésű beágyazási modellek",
							url: "https://example.com/hu-embedding",
							snippet:
								"A BGE-M3 gyakorlati saját üzemeltetésű jelölt, mert többnyelvű keresést, hibrid visszakeresést és helyi validációt támogat.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "coverage-review"
							? coverageReviewText([], true)
							: input.stage === "assemble"
								? "Ellenőriztem a forrásokat és szintetizáltam a jelentést."
								: `${input.stage} eredmény`,
					usage: stageUsage(),
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
		expect(auditInput?.assembledMarkdown).toContain("## Vezetői összefoglaló");
		expect(auditInput?.assembledMarkdown).toContain(
			"## Bizonyíték összefoglaló",
		);
		expect(auditInput?.assembledMarkdown).toContain("## Korlátok");
		expect(auditInput?.assembledMarkdown).toContain(
			"nem tudta döntési minőségű jelentéssé szintetizálni",
		);
		expect(auditInput?.assembledMarkdown).toContain(
			"A BGE-M3 gyakorlati saját üzemeltetésű jelölt",
		);
		expect(auditInput?.assembledMarkdown).not.toContain("## Findings");
		expect(auditInput?.assembledMarkdown).not.toContain("## Recommendation");
		expect(auditInput?.assemblyMetadata.sectionBriefs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sectionTitle: "Vezetői összefoglaló" }),
				expect.objectContaining({
					sectionTitle: "Bizonyíték összefoglaló",
				}),
				expect.objectContaining({ sectionTitle: "Korlátok" }),
			]),
		);
	});

	it("falls back before audit when assembly turns metadata and source titles into sections", async () => {
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

		await runAtlasPipelineWithNoopReranker({
			job: {
				id: "atlas-metadata-source-heading-collapse",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Embedding model report",
				query:
					"Compare self-hosted embedding models for English technical-document retrieval",
				lifecycle: {
					family: {
						familyId: "atlas-metadata-source-heading-collapse",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-metadata-source-heading-collapse",
						currentAtlasJobId: "atlas-metadata-source-heading-collapse",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-21T18:32:54.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Best Self-Hosted Embedding Models in 2026",
							url: "https://mixpeek.com/curated-lists/best-self-hosted-embedding-models",
							snippet:
								"BGE-M3 is a practical self-hosted option for multilingual and hybrid retrieval.",
						},
						{
							id: "web-2",
							title: "Best Embedding Models for RAG in 2026",
							url: "https://innovativeais.com/blog/best-embedding-models-for-rag-in-2026",
							snippet:
								"NVIDIA NV-Embed-v2 leads benchmark accuracy while BGE-M3 is a production workhorse.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					const malformedAssembly = [
						"# Best self-hosted embedding models",
						"",
						"2026-06-21",
						"",
						"## Executive Summary",
						"BGE-M3 is the pragmatic self-hosted default, while NVIDIA NV-Embed leads pure benchmark accuracy.",
						"",
						"![Decorative embedding image](https://example.com/embedding.png)",
						"",
						"## Report",
						"The key tradeoff is peak retrieval quality versus operational simplicity.",
						"",
						"## Stage: Integrate",
						"The optimal choice depends on accuracy targets and hardware budget.",
						"",
						"## Key finding: No single best model",
						"Larger models can improve retrieval accuracy but increase latency.",
						"",
						"## Date: 2026-06-21",
						"Self-hosting removes per-token API costs but requires GPU operations.",
						"",
						"## Profile: Overview",
						"Hybrid retrieval is now a default production pattern.",
						"",
						"## Status: Final, evidence-based",
						"| Model | Tradeoff |",
						"",
						"## Evidence basis:",
						"|-------|----------|",
						"",
						"## Best Self-Hosted Embedding Models in 2026 (mixpeek.com)",
						"Best Self-Hosted Embedding Models in 2026 (mixpeek.com).",
						"",
						"## Best Embedding Models for RAG in 2026 (innovativeais.com)",
						"Best Embedding Models for RAG in 2026 (innovativeais.com).",
						"",
						"## Model Tradeoffs",
						"BGE-M3 trades some top-line benchmark performance for easier self-hosting and hybrid retrieval support.",
					].join("\n");
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: malformedAssembly,
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
								? "self-hosted embedding models 2026"
								: input.stage === "curate"
									? "Curated evidence: BGE-M3 is a pragmatic self-hosted default, NV-Embed leads accuracy, and self-hosting trades API costs for GPU operations."
									: input.stage === "synthesize"
										? [
												"Executive Summary: BGE-M3 is the pragmatic default while NV-Embed leads pure benchmark accuracy.",
												"Model Tradeoffs: BGE-M3 emphasizes hybrid retrieval and simpler operations; NV-Embed emphasizes benchmark quality.",
												"Deployment Considerations: self-hosting removes per-token API costs but requires GPU operations.",
												"Recommendation: start with BGE-M3 unless peak benchmark accuracy justifies larger infrastructure.",
												"Limitations: benchmark rankings should be validated on the team's own corpus.",
											].join("\n")
										: input.stage === "integrate"
											? [
													"Executive Summary - summarize the model choice.",
													"Model Tradeoffs - compare quality, cost, and operations.",
													"Deployment Considerations - explain GPU and hosting implications.",
													"Recommendation - give the default choice.",
													"Limitations - state evidence and benchmark limits.",
												].join("\n")
											: `${input.stage} result`,
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

		expect(assembleCalls).toBe(3);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).toContain("## Executive Summary");
		expect(auditInput?.assembledMarkdown).toContain("## Evidence Summary");
		expect(auditInput?.assembledMarkdown).toContain("## Limitations");
		expect(auditInput?.assembledMarkdown).toContain("could not synthesize");
		expect(auditInput?.assembledMarkdown).toContain(
			"BGE-M3 is a practical self-hosted option",
		);
		expect(auditInput?.assembledMarkdown).toContain(
			"NVIDIA NV-Embed-v2 leads benchmark accuracy",
		);
		expect(auditInput?.assembledMarkdown).not.toContain("## Model Tradeoffs");
		expect(auditInput?.assembledMarkdown).not.toContain(
			"## Deployment Considerations",
		);
		expect(auditInput?.assembledMarkdown).not.toContain("## Recommendation");
		expect(auditInput?.assembledMarkdown).not.toContain("## Date:");
		expect(auditInput?.assembledMarkdown).not.toContain("## Profile:");
		expect(auditInput?.assembledMarkdown).not.toContain("## Stage:");
		expect(auditInput?.assembledMarkdown).not.toContain("## Key finding:");
		expect(auditInput?.assembledMarkdown).not.toContain("## Evidence basis");
		expect(auditInput?.assembledMarkdown).not.toContain("(mixpeek.com)");
		expect(auditInput?.assembledMarkdown).not.toContain("![Decorative");
		expect(auditInput?.assemblyMetadata.sectionBriefs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sectionTitle: "Executive Summary" }),
				expect.objectContaining({ sectionTitle: "Evidence Summary" }),
				expect.objectContaining({ sectionTitle: "Limitations" }),
			]),
		);
	});

	it("passes a single scalar heading report without triggering assembly repair; sanitizes the scalar heading inline", async () => {
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

		await runAtlasPipelineWithNoopReranker({
			job: {
				id: "atlas-scalar-heading-repair",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Embedding model report",
				query:
					"Compare self-hosted embedding models for English technical-document retrieval",
				lifecycle: {
					family: {
						familyId: "atlas-scalar-heading-repair",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-scalar-heading-repair",
						currentAtlasJobId: "atlas-scalar-heading-repair",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-21T19:36:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Best Self-Hosted Embedding Models in 2026",
							url: "https://mixpeek.com/curated-lists/best-self-hosted-embedding-models",
							snippet:
								"BGE-M3 is a practical self-hosted option for multilingual and hybrid retrieval.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: [
								"# Self-hosted embedding models",
								"",
								"## Executive Summary",
								"BGE-M3 is the pragmatic self-hosted default for many English technical retrieval deployments with solid hybrid retrieval and reranking support across diverse document types.",
								"",
								"## Findings",
								"Hybrid retrieval and reranking matter more than a single public benchmark rank when selecting an embedding model for production use across diverse technical domains.",
								"",
								"## 8B params",
								"Qwen3-Embedding-8B is large enough to change latency and hardware planning for teams that need higher accuracy at the cost of more infrastructure.",
								"",
								"## Limitations",
								"Public rankings should be validated on the team's own corpus before production deployment to ensure the selected model performs well on the specific data distribution.",
							].join("\n"),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "decompose"
								? "self-hosted embedding models"
								: input.stage === "curate"
									? "Curated evidence: BGE-M3 is pragmatic, while larger embedding models may improve selected benchmark results with higher operational cost."
									: input.stage === "synthesize"
										? "Executive Summary: BGE-M3 is the pragmatic default.\nFindings: model size, latency, and corpus fit matter.\nLimitations: validate on your own corpus."
										: "Executive Summary - summarize the model choice.\nFindings - compare model size and latency.\nDeployment Considerations - explain hardware implications.\nLimitations - state benchmark limits.",
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(assembleCalls).toBe(1);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).not.toContain("## 8B params");
	});

	it("promotes heading-like paragraphs to H3 when they are short, have no sentence-ending punctuation, and are followed by a longer paragraph", async () => {
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

		await runAtlasPipelineWithNoopReranker({
			job: {
				id: "atlas-heading-like-promotion",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Embedding model report",
				query:
					"Compare self-hosted embedding models for English technical-document retrieval",
				lifecycle: {
					family: {
						familyId: "atlas-heading-like-promotion",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-heading-like-promotion",
						currentAtlasJobId: "atlas-heading-like-promotion",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-21T19:36:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Best Self-Hosted Embedding Models in 2026",
							url: "https://example.com/embedding-models",
							snippet:
								"BGE-M3 is a practical self-hosted option for multilingual and hybrid retrieval.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: [
								"# Self-hosted embedding models",
								"",
								"## Executive Summary",
								"BGE-M3 is the pragmatic self-hosted default for many English technical retrieval deployments with solid hybrid retrieval and reranking support across diverse document types and deployment scenarios ranging from single-machine setups to distributed clusters.",
								"",
								"Architecture Overview",
								"The architecture of the embedding model uses a transformer-based encoder with multi-head attention that processes input tokens efficiently across diverse technical domains and document types including both structured and unstructured content with measurable throughput and latency characteristics.",
							].join("\n"),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "decompose"
								? "self-hosted embedding models"
								: input.stage === "curate"
									? "Curated evidence: BGE-M3 is pragmatic, while larger embedding models may improve selected benchmark results with higher operational cost."
									: input.stage === "synthesize"
										? "Executive Summary: BGE-M3 is the pragmatic default.\nFindings: model size, latency, and corpus fit matter.\nLimitations: validate on your own corpus."
										: "Executive Summary - summarize the model choice.\nFindings - compare model size and latency.\nDeployment Considerations - explain hardware implications.\nLimitations - state benchmark limits.",
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(assembleCalls).toBe(1);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).toContain("### Architecture Overview");
		expect(auditInput?.assembledMarkdown).not.toMatch(/^## Architecture Overview$/m);
	});

	it("guard: auto-appends Limitations and sanitizes headings instead of honest-fallback when outline has 4+ headings but no Limitations", async () => {
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

		await runAtlasPipelineWithNoopReranker({
			job: {
				id: "atlas-live-outline-collapse",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Live outline collapse",
				query:
					"Compare the best self-hosted embedding models for English technical retrieval",
				lifecycle: {
					family: {
						familyId: "atlas-live-outline-collapse",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-live-outline-collapse",
						currentAtlasJobId: "atlas-live-outline-collapse",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-21T19:05:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Open Source Embedding Models Benchmark for RAG",
							url: "https://aimultiple.com/open-source-embedding-models",
							snippet:
								"Nemotron leads accuracy on a single H100, while smaller models trade peak quality for lower hardware demand.",
						},
						{
							id: "web-2",
							title: "Best Self-Hosted Embedding Models in 2026",
							url: "https://mixpeek.com/curated-lists/best-self-hosted-embedding-models",
							snippet:
								"BGE-M3 is a practical self-hosted workhorse with dense and sparse retrieval support.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: [
								"# Self-hosted embedding models",
								"",
								"## Executive Summary",
								"No single model dominates all scenarios in the self-hosted embedding space and each deployment must weigh recall quality against hardware budget when making a selection.",
								"",
								"## Report Outline",
								"The selection process depends on recall latency hardware availability and licensing terms which vary across different model families and deployments.",
								"",
								"## Core insight",
								"Larger models generally achieve higher retrieval accuracy but require more GPU memory and inference time which may not always be practical for every deployment.",
								"",
								"## Lead candidates",
								"Nemotron leads accuracy benchmarks while BGE-M3 offers a strong balance of quality and practicality for most self-hosted English technical retrieval.",
								"",
								"## Findings",
								"Model selection should consider corpus size latency requirements hardware budget and licensing terms together rather than relying on a single benchmark ranking.",
								"",
								"## Top Models",
								"Jina v5 ranks strongly on benchmarks and offers a smaller footprint that may fit better in constrained environments without sacrificing too much quality.",
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
								? "self-hosted embedding models"
								: input.stage === "curate"
									? "Curated evidence: Nemotron leads raw retrieval accuracy, BGE-M3 supports hybrid retrieval, and Jina v5 offers a smaller high-quality option."
									: input.stage === "synthesize"
										? "Executive Summary: No single self-hosted embedding model dominates all deployment scenarios.\nFindings: Nemotron leads raw retrieval quality when H100-class hardware is available.\nTradeoffs: BGE-M3 and Jina v5 reduce hosting complexity while giving up some peak benchmark performance.\nRecommendation: Start with BGE-M3 for most self-hosted English technical retrieval unless benchmark accuracy justifies a larger model.\nLimitations: Public benchmark rankings should be validated on the team's own corpus before production selection."
										: `${input.stage} result`,
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

		expect(assembleCalls).toBe(1);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).toContain("## Executive Summary");
		expect(auditInput?.assembledMarkdown).toContain("## Limitations");
		expect(auditInput?.assembledMarkdown).not.toContain("## Report Outline");
		expect(auditInput?.assembledMarkdown).not.toContain("## Core insight");
		expect(auditInput?.assembledMarkdown).not.toContain("## Lead candidates");
		expect(auditInput?.assembledMarkdown).not.toContain("## Top Models");
		expect(auditInput?.assembledMarkdown).not.toContain("|-------|");
		expect(auditInput?.assembledMarkdown).not.toContain("| Model |");
	});

	it("guard: relaxed scalar heading threshold (>=2) lets single-scalar reports pass without repair", async () => {
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

		await runAtlasPipelineWithNoopReranker({
			job: {
				id: "atlas-guard-scalar-relaxed",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Scalar guard test",
				query: "Test query",
				lifecycle: {
					family: {
						familyId: "atlas-guard-scalar-relaxed",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-guard-scalar-relaxed",
						currentAtlasJobId: "atlas-guard-scalar-relaxed",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-22T00:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Source One",
							url: "https://example.com/one",
							snippet: "Evidence snippet one.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: [
								"# Test Report",
								"",
								"## Executive Summary",
								"A single scalar heading like 7B parameters should not trigger the assembly repair path because the new threshold requires at least two such headings before the malformed guard activates and triggers a repair pass that would waste tokens.",
								"",
								"## Findings",
								"The relaxed guard now requires at least two scalar headings before rejecting a report as malformed which means smaller model parameter mentions in headings are tolerated and do not cause unnecessary repair passes.",
								"",
								"## 7B parameters",
								"A single scalar heading like this is now tolerated by the guard and passes through without triggering any repair path or fallback.",
								"",
								"## Limitations",
								"The existing Limitations section lets the report pass cleanly through the guard without needing the auto-append behavior for the placeholder section.",
							].join("\n"),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "decompose"
								? "test query"
								: input.stage === "curate"
									? "Curated evidence."
									: input.stage === "synthesize"
										? "Executive Summary: summary.\nFindings: findings.\nLimitations: limits."
										: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(assembleCalls).toBe(1);
	});

	it("guard: relaxed source heading threshold (>=3) lets reports with 2 source headings pass", async () => {
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

		await runAtlasPipelineWithNoopReranker({
			job: {
				id: "atlas-guard-source-relaxed",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Source guard test",
				query: "Test query",
				lifecycle: {
					family: {
						familyId: "atlas-guard-source-relaxed",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-guard-source-relaxed",
						currentAtlasJobId: "atlas-guard-source-relaxed",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-22T00:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Comprehensive Analysis of RAG Systems 2026",
							url: "https://example.com/rag-2026",
							snippet: "RAG systems are evolving.",
						},
						{
							id: "web-2",
							title: "Vector Database Performance Benchmarks",
							url: "https://example.com/vector-db",
							snippet: "Vector DBs vary by use case.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: [
								"# Test Report",
								"",
								"## Executive Summary",
								"Two source matching headings should not trigger assembly repair under the relaxed guard because the source heading threshold moved from two to three which lets this report pass through without any repair.",
								"",
								"## Findings",
								"The source heading threshold now requires at least three source-like headings before the guard activates which makes two source headings a tolerated pattern that passes through to audit.",
								"",
								"## Comprehensive Analysis of RAG Systems 2026",
								"RAG systems now support hybrid search with dense and sparse retrieval methods that improve accuracy across diverse query types and document collections.",
								"",
								"## Vector Database Performance Benchmarks",
								"Vector DB benchmarks show clear tradeoffs between latency recall and operational cost across different index types and hardware configurations.",
								"",
								"## Limitations",
								"The existing Limitations section lets the report pass cleanly through the guard without needing the auto-append behavior.",
							].join("\n"),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "decompose"
								? "test query"
								: input.stage === "curate"
									? "Curated evidence."
									: input.stage === "synthesize"
										? "Executive Summary: summary.\nFindings: findings.\nLimitations: limits."
										: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(assembleCalls).toBe(1);
	});

	it("guard: source-dump with envelope headings still triggers assembly repair", async () => {
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

		await runAtlasPipelineWithNoopReranker({
			job: {
				id: "atlas-guard-source-dump",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Source dump guard test",
				query: "Test query",
				lifecycle: {
					family: {
						familyId: "atlas-guard-source-dump",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-guard-source-dump",
						currentAtlasJobId: "atlas-guard-source-dump",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-22T00:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Source One",
							url: "https://example.com/one",
							snippet: "Evidence snippet one.",
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
								assembleCalls <= 2
									? [
											"# Source Dump Report",
											"",
											"## Executive Summary",
											"Summary text.",
											"",
											"## Report",
											"Report text.",
											"",
											"## Stage: Analyze",
											"Stage text.",
											"",
											"## Key finding: Important",
											"Key finding text.",
											"",
											"## Date: 2026-06-22",
											"Date line.",
											"",
											"## Profile: Overview",
											"Profile line.",
											"",
											"## Limitations",
											"Limitations text.",
										].join("\n")
									: [
											"# Source Dump Report",
											"",
											"## Executive Summary",
											"The assembly repair successfully restructured the source-dump report into a proper executive summary with clear findings that can proceed to audit without needing a second repair pass.",
											"",
											"## Findings",
											"The repaired report now has three clean headings with enough substantive content to pass both the process-only and malformed guards allowing the pipeline to continue.",
											"",
											"## Limitations",
											"The repaired report acknowledges that some original context from the envelope headings may have been lost during restructuring.",
										].join("\n"),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "decompose"
								? "test query"
								: input.stage === "curate"
									? "Curated evidence."
									: input.stage === "synthesize"
										? "Executive Summary: summary.\nFindings: findings.\nLimitations: limits."
										: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(assembleCalls).toBeGreaterThanOrEqual(2);
	});

	it("guard: 4-heading report without Limitations gets auto-appended Limitations", async () => {
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

		await runAtlasPipelineWithNoopReranker({
			job: {
				id: "atlas-guard-auto-limitations",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Auto Limitations test",
				query: "Test query",
				lifecycle: {
					family: {
						familyId: "atlas-guard-auto-limitations",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-guard-auto-limitations",
						currentAtlasJobId: "atlas-guard-auto-limitations",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-22T00:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Source One",
							url: "https://example.com/one",
							snippet: "Evidence snippet one.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: [
								"# Test Report",
								"",
								"## Executive Summary",
								"A report with four headings and no Limitations section should pass through cleanly because the old rejection condition has been replaced with an auto-append behavior that adds a placeholder Limitations section instead of rejecting the output as malformed.",
								"",
								"## Findings",
								"This report has exactly four headings but no Limitations heading which means the ensureLimitationsSection helper will append a localized placeholder at the end before it reaches diagnostics and audit.",
								"",
								"## Analysis",
								"The old guard would have rejected this report as malformed due to the four headings without Limitations condition but the new behavior passes it through and fills in the gap automatically.",
								"",
								"## Recommendations",
								"The new behavior auto-appends a placeholder Limitations section with a localized note about evidence scope which allows valid multi-section reports to proceed without blocking.",
							].join("\n"),
							usage: stageUsage(),
						};
					}
					return {
						text:
							input.stage === "decompose"
								? "test query"
								: input.stage === "curate"
									? "Curated evidence."
									: input.stage === "synthesize"
										? "Executive Summary: summary.\nFindings: findings.\nAnalysis: analysis."
										: `${input.stage} result`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(assembleCalls).toBe(1);
		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		const auditInput = auditCalls[0]?.[0];
		expect(auditInput?.assembledMarkdown).toContain("## Limitations");
		expect(auditInput?.assembledMarkdown).toContain("## Executive Summary");
		expect(auditInput?.assembledMarkdown).toContain("## Findings");
	});

	it("lists raw evidence summaries instead of synthesized sections when assembly collapses", async () => {
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

		await runAtlasPipelineWithNoopReranker({
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
		expect(auditInput?.assembledMarkdown).toContain("## Evidence Summary");
		expect(auditInput?.assembledMarkdown).toContain("## Limitations");
		expect(auditInput?.assembledMarkdown).toContain("could not synthesize");
		expect(auditInput?.assembledMarkdown).toContain(
			"At the heart of SvelteKit is a filesystem-based router",
		);
		expect(auditInput?.assembledMarkdown).toContain(
			"A +page.svelte component defines a page of your app",
		);
		expect(auditInput?.assembledMarkdown).not.toContain("## Framework Fit");
		expect(auditInput?.assembledMarkdown).not.toContain(
			"## Operational Tradeoffs",
		);
		expect(auditInput?.assembledMarkdown).not.toContain("## Recommendation");
		expect(auditInput?.assembledMarkdown).not.toContain(
			"The accepted evidence supports a cautious, source-grounded report rather than a broad unsupported narrative.",
		);
		expect(auditInput?.assembledMarkdown).not.toContain(
			'"Routing docs" shows that',
		);
		expect(auditInput?.assemblyMetadata).toMatchObject({
			structured: true,
			sectionBriefs: expect.arrayContaining([
				expect.objectContaining({ sectionTitle: "Executive Summary" }),
				expect.objectContaining({ sectionTitle: "Evidence Summary" }),
				expect.objectContaining({ sectionTitle: "Limitations" }),
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
				"Evidence Summary",
				"Limitations",
			]),
		);
		expect(headings).not.toEqual(expect.arrayContaining(["Recommendation"]));
		expect(renderedSource?.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "paragraph",
					text: expect.stringContaining('"Routing docs" shows that'),
				}),
			]),
		);
	});

	it("publishes compact source projection while preserving raw snippets in checkpoints", async () => {
		const rawSnippet = [
			"Search result snippet: Routing docs explain filesystem route ownership.",
			"Fetched page excerpt:",
			Array.from(
				{ length: 100 },
				(_, index) =>
					`RAW_EXCERPT_SENTINEL_${index} route documentation boilerplate copied from the fetched page`,
			).join(" "),
		].join(" ");
		const checkpoints: Array<{
			curatedSourcePool: {
				web: Array<{ snippet: string | null }>;
			};
			documentSourceSummary: {
				evidenceAppendixSummary?: unknown;
			};
		}> = [];
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-compact-sources",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		const result = await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-compact-published-sources",
				profile: "overview",
				query: "Explain routing boundaries for a SvelteKit-style app",
			}),
			now: new Date("2026-06-21T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-routing",
							title: "Routing docs",
							url: "https://example.com/routing",
							snippet: rawSnippet,
						},
					],
					rejectedSources: [
						{
							id: "web-rejected-routing",
							title: "Rejected routing copy",
							url: "https://example.com/rejected-routing",
							snippet:
								"Fetched page excerpt: RAW_REJECTED_SENTINEL rejected raw source text",
							rejectionReason: "duplicate_url",
						},
					],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return { text: "routing boundaries", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: [
								"## Executive Summary",
								"Routing boundaries should stay explicit so page, layout, and endpoint responsibilities remain understandable during maintenance.",
								"",
								"## Recommendation",
								"Use the route tree as the durable framework boundary, and document where page views, layouts, and API endpoints are allowed to own behavior.",
								"",
								"## Limitations",
								"This conclusion depends on representative routing evidence and should be checked against the app's actual route conventions.",
							].join("\n"),
							usage: stageUsage(),
						};
					}
					return {
						text: `${input.stage} result`,
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
				renderOutputs,
			},
		});

		expect(result.status).toBe("succeeded");
		expect(checkpoints.at(-1)?.curatedSourcePool.web[0]?.snippet).toContain(
			"RAW_EXCERPT_SENTINEL_99",
		);
		expect(checkpoints.at(-1)?.documentSourceSummary).toMatchObject({
			evidenceAppendixSummary: {
				status: "checkpoint_only",
				acceptedWebSourceCount: 1,
				acceptedLocalSourceCount: 0,
				rejectedWebSourceCount: 1,
				rawExcerptPresent: true,
				publishedReportIncludesRawExcerpts: false,
				rejectedReasonCounts: {
					duplicate_url: 1,
				},
			},
		});
		expect(
			JSON.stringify(
				checkpoints.at(-1)?.documentSourceSummary.evidenceAppendixSummary,
			),
		).not.toMatch(
			/Fetched page excerpt|Search result snippet|RAW_EXCERPT_SENTINEL|RAW_REJECTED_SENTINEL/i,
		);

		const renderCalls = renderOutputs.mock.calls as unknown as Array<
			[GeneratedDocumentSource]
		>;
		const renderedSource = renderCalls[0]?.[0];
		const webSources = renderedSource?.blocks.find(
			(block) => block.type === "sourceChips" && block.title === "Web Sources",
		);
		if (webSources?.type !== "sourceChips") {
			throw new Error("Expected deterministic Web Sources source chips.");
		}
		const reasoning = webSources.sources[0]?.reasoning ?? "";

		expect(webSources.sources[0]).toMatchObject({
			title: "Routing docs",
			url: "https://example.com/routing",
		});
		expect(reasoning.length).toBeLessThanOrEqual(240);
		expect(reasoning).not.toMatch(
			/Fetched page excerpt|Search result snippet|RAW_EXCERPT_SENTINEL/i,
		);
	});

	it("falls back to generated search variants when decompose returns no usable search queries", async () => {
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

		await runAtlasPipelineWithNoopReranker({
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

		await runAtlasPipelineWithNoopReranker({
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

		await runAtlasPipelineWithNoopReranker({
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
		const queryCountsByProfile: Record<string, number> = {};
		const decomposeSystemsByProfile: Record<string, string> = {};
		const manyQueries = Array.from(
			{ length: 28 },
			(_value, index) => `SvelteKit routing profile query ${index + 1}`,
		).join("\n");

		for (const profile of ["overview", "in-depth", "exhaustive"] as const) {
			await runAtlasPipelineWithNoopReranker({
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
		const { AtlasPipelineQualityError } = await import("./pipeline");
		const writeCheckpoint = vi.fn(async () => {});
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await expect(
			runAtlasPipelineWithNoopReranker({
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
		const systems: Record<string, string> = {};
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipelineWithNoopReranker({
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

	it("runs a second minimal repair when the first assembly repair still produces a process-only draft", async () => {
		let assembleCalls = 0;
		const assembleTexts: string[] = [];
		const checkpoints: Array<{ checkpoint: Record<string, unknown> }> = [];
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-second-repair",
				profile: "overview",
				query: "Compare retrieval systems for regulated SaaS",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-second-repair",
							title: "Retrieval systems evidence",
							url: "https://example.com/retrieval-second-repair",
							snippet:
								"Hybrid retrieval combines lexical and semantic recall for regulated SaaS.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						const texts = [
							"I checked the sources and synthesized findings for the report.",
							"The sources were reviewed and key patterns were identified across the evidence.",
							[
								"# Retrieval Systems",
								"",
								"## Executive Summary",
								"Hybrid retrieval is the recommended path for regulated SaaS deployments. The combination of lexical and semantic search provides the best balance of recall, precision, and auditability for production environments that require traceability and governance compliance.",
								"",
								"## Findings",
								"Lexical recall preserves exact terms for compliance queries while semantic discovery catches related concepts that do not share the same wording. Reranking after the first pass ensures only the strongest accepted sources contribute to final claims in the deployed system.",
								"",
								"## Recommendation",
								"Deploy a hybrid retrieval stack with reranking for regulated compliance. This gives the team a measurable rollout path with source-level logging, benchmark validation on representative technical documents, and tunable reranking depth before scaling to production workloads.",
								"",
								"## Limitations",
								"Evidence is representative rather than exhaustive across all regulated industries. Different compliance frameworks may require different retrieval configurations based on specific document types and data classification requirements.",
							].join("\n"),
							[
								"# Retrieval Systems",
								"",
								"## Executive Summary",
								"Hybrid retrieval is the recommended path for regulated SaaS deployments. The combination of lexical and semantic search provides the best balance of recall, precision, and auditability for production environments that require traceability and governance compliance.",
								"",
								"## Findings",
								"Lexical recall preserves exact terms for compliance queries while semantic discovery catches related concepts that do not share the same wording. Reranking after the first pass ensures only the strongest accepted sources contribute to final claims in the deployed system.",
								"",
								"## Recommendation",
								"Deploy a hybrid retrieval stack with reranking for regulated compliance. This gives the team a measurable rollout path with source-level logging, benchmark validation on representative technical documents, and tunable reranking depth before scaling to production workloads.",
								"",
								"## Limitations",
								"Evidence is representative rather than exhaustive across all regulated industries. Different compliance frameworks may require different retrieval configurations based on specific document types and data classification requirements.",
							].join("\n"),
						];
						const text = texts[assembleCalls - 1] ?? texts[0];
						assembleTexts.push(text);
						return { text, usage: stageUsage() };
					}
					if (input.stage === "decompose") {
						return { text: "retrieval systems", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return {
							text: coverageReviewText([], true),
							usage: stageUsage(),
						};
					}
					return {
						text: `${input.stage} substantive output`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async (input) => {
					if (input.stage === "audit") {
						checkpoints.push({
							checkpoint: input.checkpoint as Record<string, unknown>,
						});
					}
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-second-repair",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assembleCalls).toBe(4);
		expect(assembleTexts[0]).toContain("synthesized findings");
		expect(assembleTexts[1]).toContain("key patterns were identified");
		expect(assembleTexts[2]).toContain("Executive Summary");
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining(
					"Hybrid retrieval is the recommended path",
				),
			}),
		);
		const writerCheckpoint = checkpoints.at(-1)?.checkpoint.writer as
			| Record<string, unknown>
			| undefined;
		expect(writerCheckpoint).toBeDefined();
		expect(writerCheckpoint?.assemblyDiagnostics).toBeDefined();
		const diagnostics = writerCheckpoint?.assemblyDiagnostics as
			| Record<string, unknown>
			| undefined;
		expect(diagnostics?.firstPassRepairReason).toBe("process_only");
		expect(diagnostics?.firstPassParsedAsJson).toBe(false);
		expect(typeof diagnostics?.firstPassOutputPrefix).toBe("string");
		expect(
			(diagnostics?.firstPassOutputPrefix as string).length,
		).toBeLessThanOrEqual(500);
	});

	it("populates full-cascade assembly diagnostics when all repair tiers fail", async () => {
		let assembleCalls = 0;
		const checkpoints: Array<{
			checkpoint: Record<string, unknown>;
		}> = [];
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
			basisDiagnostics: [
				{
					code: "cascade_test_diagnostic",
					severity: "info" as const,
					message: "Cascade test diagnostic",
				},
			],
		}));

		const processOnlyRepairText =
			"I checked the sources and synthesized the findings. The research process involved reviewing multiple evidence packs to compile this report.";

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-full-cascade-diagnostics",
				profile: "overview",
				query: "Compare retrieval systems for regulated SaaS",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-cascade",
							title: "Retrieval evidence",
							url: "https://example.com/cascade",
							snippet: "Evidence for cascade test.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: processOnlyRepairText,
							usage: stageUsage(100, 50),
						};
					}
					if (input.stage === "decompose") {
						return { text: "retrieval systems", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return {
							text: coverageReviewText([], true),
							usage: stageUsage(),
						};
					}
					return {
						text: `${input.stage} substantive output`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async (input) => {
					if (input.stage === "audit") {
						checkpoints.push({
							checkpoint: input.checkpoint as Record<string, unknown>,
						});
					}
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-cascade",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assembleCalls).toBe(3);
		const writerCheckpoint = checkpoints.at(-1)?.checkpoint.writer as
			| Record<string, unknown>
			| undefined;
		expect(writerCheckpoint).toBeDefined();
		expect(writerCheckpoint?.assemblyDiagnostics).toBeDefined();
		const diag = writerCheckpoint?.assemblyDiagnostics as Record<
			string,
			unknown
		>;

		expect(diag.firstPassOutputPrefix).toBeTypeOf("string");
		expect((diag.firstPassOutputPrefix as string).length).toBeLessThanOrEqual(
			500,
		);
		expect(diag.firstPassParsedAsJson).toBe(false);
		expect(diag.firstPassRepairReason).toBe("process_only");

		expect(diag.firstRepairOutputPrefix).toBeTypeOf("string");
		expect((diag.firstRepairOutputPrefix as string).length).toBeLessThanOrEqual(
			500,
		);
		expect(diag.firstRepairParsedAsJson).toBe(false);
		expect(diag.firstRepairRepairReason).toBe("process_only");

		expect(diag.secondRepairOutputPrefix).toBeTypeOf("string");
		expect(
			(diag.secondRepairOutputPrefix as string).length,
		).toBeLessThanOrEqual(500);
		expect(diag.secondRepairParsedAsJson).toBe(false);
		expect(diag.secondRepairRepairReason).toBe("process_only");

		expect(diag.finalFailureCheck).toBe("needsAssemblyRepair");
		expect(diag.finalFailureSubCondition).toBe("process_only");

		const tokensByTier = diag.outputTokensByTier as Record<string, number>;
		expect(tokensByTier).toBeDefined();
		expect(tokensByTier.firstPass).toBe(50);
		expect(tokensByTier.firstRepair).toBe(50);
		expect(tokensByTier.secondRepair).toBe(50);

		expect(diag.writerPromptTruncated).toBe(false);
		expect(typeof diag.writerPromptCharCount).toBe("number");
		expect(diag.writerPromptCharCount as number).toBeGreaterThan(0);

		const claimDiag = diag.claimBasisDiagnostics as
			| Array<Record<string, unknown>>
			| undefined;
		expect(claimDiag).toBeDefined();
		expect(claimDiag?.length).toBe(1);
		expect(claimDiag?.[0].code).toBe("cascade_test_diagnostic");
	});

	it("falls back to honest evidence summary after both assembly repairs fail", async () => {
		let assembleCalls = 0;
		const checkpoints: Array<{ checkpoint: Record<string, unknown> }> = [];
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-both-repairs-fail",
				profile: "overview",
				query: "Compare retrieval systems for regulated SaaS",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-both-fail",
							title: "Retrieval systems evidence",
							url: "https://example.com/retrieval-both-fail",
							snippet: "Hybrid retrieval evidence for regulated SaaS.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text: "I checked the sources and synthesized findings for the report. The research process involved reviewing multiple evidence packs.",
							usage: stageUsage(),
						};
					}
					if (input.stage === "decompose") {
						return { text: "retrieval systems", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return {
							text: coverageReviewText([], true),
							usage: stageUsage(),
						};
					}
					return {
						text: `${input.stage} substantive output`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async (input) => {
					if (input.stage === "audit") {
						checkpoints.push({
							checkpoint: input.checkpoint as Record<string, unknown>,
						});
					}
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-both-fail",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assembleCalls).toBe(3);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("could not synthesize"),
			}),
		);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("## Evidence Summary"),
			}),
		);
		const writerCheckpoint = checkpoints.at(-1)?.checkpoint.writer as
			| Record<string, unknown>
			| undefined;
		expect(writerCheckpoint).toBeDefined();
		expect(writerCheckpoint?.assemblyDiagnostics).toBeDefined();
	});

	it("uses prose Markdown directly as bodyMarkdown when model returns non-JSON content with headings", async () => {
		const proseMarkdown = [
			"# Retrieval Architecture Report",
			"",
			"## Executive Summary",
			"This report analyzes retrieval architectures for regulated SaaS deployments. Hybrid retrieval combining lexical and semantic search provides the best balance of recall, precision, and auditability for production environments that require traceability and governance compliance.",
			"",
			"## Key Findings",
			"Hybrid retrieval combining lexical and semantic search provides the best balance for regulated environments. Lexical matching ensures exact term recall for compliance queries, while semantic search captures related concepts that do not share the same wording. Reranking after the first pass keeps only the strongest accepted sources.",
			"",
			"## Recommendation",
			"We recommend deploying a hybrid retrieval stack with reranking for regulated SaaS. The deployment should include source-level logging, benchmark validation on representative technical documents, and tunable reranking depth before scaling.",
			"",
			"## Limitations",
			"The accepted evidence is representative rather than exhaustive across all regulated industries. Different compliance frameworks may require different retrieval configurations.",
		].join("\n");

		const checkpoints: Array<{ checkpoint: Record<string, unknown> }> = [];
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-prose-markdown",
				profile: "overview",
				query: "Compare retrieval architectures",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-prose-md",
							title: "Retrieval architecture evidence",
							url: "https://example.com/prose-md",
							snippet: "Retrieval architecture comparison for regulated SaaS.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						return { text: proseMarkdown, usage: stageUsage() };
					}
					if (input.stage === "decompose") {
						return {
							text: "retrieval architectures",
							usage: stageUsage(),
						};
					}
					if (input.stage === "coverage-review") {
						return {
							text: coverageReviewText([], true),
							usage: stageUsage(),
						};
					}
					return {
						text: `${input.stage} substantive output`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async (input) => {
					if (input.stage === "audit") {
						checkpoints.push({
							checkpoint: input.checkpoint as Record<string, unknown>,
						});
					}
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-prose-md",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining(
					"Retrieval Architecture Report",
				),
			}),
		);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining(
					"Hybrid retrieval combining lexical",
				),
			}),
		);
	});

	it("records assembly diagnostics in writer checkpoint metadata (not console)", async () => {
		let assembleCalls = 0;
		const checkpoints: Array<{ checkpoint: Record<string, unknown> }> = [];
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const firstPassText =
			"I checked the sources and synthesized findings. The research process reviewed evidence across multiple domains. Sources were consulted, and key findings were organized.";

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-assembly-diag",
				profile: "overview",
				query: "Compare retrieval systems",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-assembly-diag",
							title: "Retrieval evidence",
							url: "https://example.com/assembly-diag",
							snippet: "Retrieval evidence for comparison.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						if (assembleCalls === 1) {
							return { text: firstPassText, usage: stageUsage() };
						}
						return {
							text: [
								"# Retrieval Systems",
								"",
								"## Executive Summary",
								"Evidence supports hybrid retrieval for regulated SaaS deployments. The combination of lexical and semantic search provides the best balance for production retrieval quality and auditability.",
								"",
								"## Findings",
								"Lexical and semantic search combine well for technical document retrieval. Hybrid approaches preserve exact domain terms through lexical matching while catching related concepts through semantic search. Reranking after the first pass ensures only the strongest sources contribute to final claims.",
								"",
								"## Recommendation",
								"We recommend deploying a hybrid retrieval stack with reranking. This gives the team a measurable rollout path: benchmark the shortlist, keep source-level logging, and tune reranking depth before scaling.",
								"",
								"## Limitations",
								"The accepted evidence is representative rather than exhaustive. Different regulated SaaS deployments may require different retrieval configurations based on their specific document types.",
							].join("\n"),
							usage: stageUsage(),
						};
					}
					if (input.stage === "decompose") {
						return { text: "retrieval systems", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return {
							text: coverageReviewText([], true),
							usage: stageUsage(),
						};
					}
					return {
						text: `${input.stage} substantive output`,
						usage: stageUsage(),
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async (input) => {
					if (input.stage === "audit") {
						checkpoints.push({
							checkpoint: input.checkpoint as Record<string, unknown>,
						});
					}
				}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-assembly-diag",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(assembleCalls).toBe(2);
		const writerCheckpoint = checkpoints.at(-1)?.checkpoint.writer as
			| Record<string, unknown>
			| undefined;
		expect(writerCheckpoint).toBeDefined();
		expect(writerCheckpoint?.assemblyDiagnostics).toBeDefined();
		const diag = writerCheckpoint?.assemblyDiagnostics as Record<
			string,
			unknown
		>;
		expect(diag.firstPassOutputPrefix).toBe(firstPassText.slice(0, 500));
		expect(diag.firstPassParsedAsJson).toBe(false);
		expect(diag.firstPassRepairReason).toBe("process_only");
	});

	it("extracts writer claimBasis from assembly output and passes it to audit", async () => {
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-writer-claimbasis",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-writer-claimbasis",
				profile: "overview",
				query: "Compare retrieval architectures",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-claimbasis",
							title: "Retrieval architecture evidence",
							url: "https://example.com/claimbasis",
							snippet: "Hybrid retrieval evidence.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return { text: "retrieval architectures", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "Retrieval Architecture Report",
								bodyMarkdown: decisionQualityReport(),
								sectionBriefs: [],
								limitations: [],
								claimBasis: [
									{
										claimText:
											"Hybrid retrieval is the strongest architecture pattern",
										sectionTitle: "Recommended Architecture",
										supportLevel: "supported",
										evidenceCardIds: ["card-1"],
										rationale:
											"Evidence cards support hybrid retrieval as the default pattern.",
									},
								],
							}),
							usage: stageUsage(),
						};
					}
					return { text: `${input.stage} result`, usage: stageUsage() };
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				writerClaimBasis: [
					expect.objectContaining({
						claimText: "Hybrid retrieval is the strongest architecture pattern",
						supportLevel: "supported",
					}),
				],
			}),
		);
	});

	it("uses writer claimText as anchor when writer provides claimBasis", async () => {
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-writer-anchor",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-writer-anchor",
				profile: "overview",
				title: "Writer Anchor Report",
				query: "Compare retrieval architectures",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-anchor",
							title: "Architecture evidence",
							url: "https://example.com/anchor",
							snippet: "Evidence for architecture comparison.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return { text: "retrieval architectures", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						const bodyMarkdown = [
							"## Executive Summary",
							"Hybrid retrieval is the strongest architecture pattern for regulated SaaS deployments because it preserves exact policy language while also supporting semantic discovery. The evidence shows that combining lexical and semantic search gives the best balance of recall and auditability.",
							"",
							"## Findings",
							"The evidence supports hybrid retrieval as the most defensible default architecture pattern.",
							"",
							"## Limitations",
							"Evidence is representative rather than exhaustive.",
						].join("\n");
						return {
							text: JSON.stringify({
								generatedTitle: "Writer Anchor Report",
								bodyMarkdown,
								sectionBriefs: [],
								limitations: [],
								claimBasis: [
									{
										claimText:
											"Hybrid retrieval is the strongest architecture pattern",
										sectionTitle: "Executive Summary",
										supportLevel: "supported",
										evidenceCardIds: ["card-1"],
										rationale:
											"Evidence cards support this claim with source-grounded data.",
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
			claimBasis: [
				{
					version: "atlas.claim-basis.v1" as const,
					id: "atlas-claim-audit",
					locator: {
						sectionTitle: "Findings",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText:
							"Hybrid retrieval is the strongest architecture pattern for regulated SaaS deployments",
						quote: "Hybrid retrieval is the strongest architecture pattern",
						startOffset: 0,
						endOffset: 53,
					},
					supportLevel: "supported" as const,
					evidencePackIds: ["pack-web-anchor"],
					sourceRefs: [],
					supportRationale:
						"Accepted evidence supports hybrid retrieval as a strong pattern.",
					auditConcernCode: null,
				},
			],
			basisLimitations: [],
			basisDiagnostics: [],
			claimBasisCoverageBySection: [],
			claimBasisStatus: "succeeded" as const,
			claimBasisFailureReason: null,
		})),
		writeCheckpoint: vi.fn(async () => {}),
		renderOutputs,
			},
		});

		const renderedSource = renderOutputs.mock.calls[0]?.[0];
		expect(renderedSource.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "paragraph",
					basisMarkers: expect.arrayContaining([
						expect.objectContaining({
							id: "atlas-claim-audit",
							support: "supported",
							anchorText: expect.stringMatching(/hybrid retrieval/i),
						}),
					]),
				}),
			]),
		);
	});

	it("falls back to audit-only path when writer omits claimBasis", async () => {
		const renderOutputs = vi.fn(async (_source: GeneratedDocumentSource) => ({
			fileProductionJobId: "fp-job-no-writer-claimbasis",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-no-writer-claimbasis",
				profile: "overview",
				title: "No Writer Claim Basis",
				query: "Compare retrieval architectures",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-no-writer",
							title: "Architecture evidence",
							url: "https://example.com/no-writer",
							snippet: "Architecture comparison evidence.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return { text: "retrieval architectures", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						return {
							text: JSON.stringify({
								generatedTitle: "No Writer Claim Basis",
								bodyMarkdown: decisionQualityReport(),
								sectionBriefs: [],
								limitations: [],
							}),
							usage: stageUsage(),
						};
					}
					return { text: `${input.stage} result`, usage: stageUsage() };
				}),
				auditBasis: vi.fn(async (input) => {
					expect(input.writerClaimBasis).toBeNull();
					return {
						passed: true,
						honestyMarkers: [],
						retryRequested: false,
						claimBasis: [],
						basisLimitations: [],
						basisDiagnostics: [],
						claimBasisCoverageBySection: [],
						claimBasisStatus: "succeeded" as const,
						claimBasisFailureReason: null,
					};
				}),
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});
	});

	it("preserves writer-only claims when merged with audit claim basis", async () => {
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
			claimBasis: [
				{
					version: "atlas.claim-basis.v1" as const,
					id: "atlas-claim-audit-only",
					locator: {
						sectionTitle: "Executive Summary",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "Audit-generated claim about hybrid retrieval",
						quote: "Audit-generated quote",
						startOffset: 0,
						endOffset: 20,
					},
					supportLevel: "supported" as const,
					evidencePackIds: ["pack-audit"],
					sourceRefs: [],
					supportRationale: "Audit rationale.",
					auditConcernCode: null,
				},
			],
			basisLimitations: [],
			basisDiagnostics: [],
			claimBasisCoverageBySection: [],
			claimBasisStatus: "succeeded" as const,
			claimBasisFailureReason: null,
		}));

		await runAtlasPipelineWithNoopReranker({
			job: atlasJob({
				id: "atlas-writer-only-claims",
				profile: "overview",
				title: "Writer-Only Claims",
				query: "Compare retrieval architectures",
			}),
			now: new Date("2026-06-22T10:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-writer-only",
							title: "Architecture evidence",
							url: "https://example.com/writer-only",
							snippet: "Evidence for architecture comparison.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "decompose") {
						return { text: "retrieval architectures", usage: stageUsage() };
					}
					if (input.stage === "coverage-review") {
						return { text: coverageReviewText([], true), usage: stageUsage() };
					}
					if (input.stage === "assemble") {
						const bodyMarkdown = [
							"## Executive Summary",
							"Audit-generated claim about hybrid retrieval is supported by accepted evidence. Writer-specific deployment claim about latency tradeoffs also appears in the report body.",
							"",
							"## Limitations",
							"Evidence is representative rather than exhaustive.",
						].join("\n");
						return {
							text: JSON.stringify({
								generatedTitle: "Writer-Only Claims Report",
								bodyMarkdown,
								sectionBriefs: [],
								limitations: [],
								claimBasis: [
									{
										claimText:
											"Writer-specific deployment claim about latency tradeoffs",
										sectionTitle: "Executive Summary",
										supportLevel: "supported",
										evidenceCardIds: ["card-writer"],
										rationale:
											"Writer evidence on deployment latency tradeoffs.",
									},
								],
							}),
							usage: stageUsage(),
						};
					}
					return { text: `${input.stage} result`, usage: stageUsage() };
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-writer-only",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		const auditCalls = auditBasis.mock.calls as unknown as Array<
			[Parameters<RunAtlasPipelineInput["dependencies"]["auditBasis"]>[0]]
		>;
		expect(auditCalls[0]?.[0].writerClaimBasis).toEqual([
			expect.objectContaining({
				claimText: "Writer-specific deployment claim about latency tradeoffs",
			}),
		]);
	});
});

describe("Atlas guard functions", () => {
	function goodReportBody(words = 80): string {
		const paragraphs = Array.from(
			{ length: Math.ceil(words / 12) },
			() =>
				"The analysis reveals several important architectural trade-offs that affect regulated SaaS deployments because hybrid retrieval combines the strengths of lexical and semantic approaches. ",
		);
		return paragraphs.join("\n").split(/\s+/).slice(0, words).join(" ");
	}

	function reportWithHeading(heading: string, bodyWords = 80): string {
		const body = goodReportBody(bodyWords);
		return `# ${heading}\n\n${body}`;
	}

	describe("looksLikeProcessOnlyReport", () => {
		it("returns true for an empty string", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			expect(looksLikeProcessOnlyReport("")).toBe(true);
		});

		it("returns true for whitespace-only string", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			expect(looksLikeProcessOnlyReport("   \n\t  ")).toBe(true);
		});

		it("returns true when body words before sources are under 60 even with a substantive heading", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const short =
				"## Executive Summary\n\nShort body with very few words here.";
			expect(looksLikeProcessOnlyReport(short)).toBe(true);
		});

		it("returns true when there are no substantive report section headings", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const noHeading = goodReportBody(100);
			expect(looksLikeProcessOnlyReport(noHeading)).toBe(true);
		});

		it("returns true when there are no substantive headings even with many words", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const markdown = `# Random Title\n\n${goodReportBody(200)}`;
			expect(looksLikeProcessOnlyReport(markdown)).toBe(true);
		});

		it("returns true when process phrases >= 2 exist regardless of word count or signals", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const markdown = reportWithHeading("Executive Summary", 80).replace(
				"reveals",
				"I examined sources and reviewed the findings and synthesized the findings because the evidence shows hybrid retrieval works",
			);
			expect(looksLikeProcessOnlyReport(markdown)).toBe(true);
		});

		it("returns true when process phrases === 1 and words < 180", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const markdown =
				"## Executive Summary\n\nI examined the evidence and found that hybrid retrieval is a strong approach. " +
				goodReportBody(70);
			expect(looksLikeProcessOnlyReport(markdown)).toBe(true);
		});

		it("returns true when process phrases === 1, words >= 180, but no substantive signals", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const bodyText = Array.from(
				{ length: 200 },
				() => "data point entry record metric value sample observation result",
			).join(" ");
			const markdown =
				"## Executive Summary\n\nI examined the data and the results are acceptable. " +
				bodyText;
			expect(looksLikeProcessOnlyReport(markdown)).toBe(true);
		});

		it("returns false when process phrases === 1, words >= 180, and substantive signals are present", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const markdown =
				"## Executive Summary\n\nI examined the sources and found that hybrid retrieval is a strong approach. The evidence shows that combining lexical and semantic search improves recall. However, there are trade-offs in latency and cost. " +
				goodReportBody(200);
			expect(looksLikeProcessOnlyReport(markdown)).toBe(false);
		});

		it("returns false for a good report with zero process phrases", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(300)}\n\n## Findings\n\n${goodReportBody(100)}\n\n## Recommendations\n\n${goodReportBody(100)}`;
			expect(looksLikeProcessOnlyReport(markdown)).toBe(false);
		});

		it("returns true for a Hungarian process-only report with process phrases", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const markdown =
				"## Vezetői összefoglaló\n\nA források ellenőrzése után megállapítottuk hogy a hibrid visszakeresés hatékony. Kockázat: a magas késleltetés problémát jelenthet. ";
			expect(looksLikeProcessOnlyReport(markdown)).toBe(true);
		});

		it("returns true for a Hungarian report without English substantive headings (accented headings do not match \\b)", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const markdown = `## Vezetői összefoglaló\n\n${goodReportBody(250)}`;
			expect(looksLikeProcessOnlyReport(markdown)).toBe(true);
		});

		it("excludes words after a '## Sources' heading from body word count", async () => {
			const { looksLikeProcessOnlyReport } = await import("./pipeline");
			const shortBeforeSources = "## Executive Summary\n\nBrief note only. \n";
			const manyAfterSources = `## Sources\n\n${goodReportBody(300)}`;
			const markdown = shortBeforeSources + manyAfterSources;
			expect(looksLikeProcessOnlyReport(markdown)).toBe(true);
		});
	});

	describe("looksLikeMalformedAssembledReport", () => {
		it("returns false for a well-formed report with 4 substantive headings including Limitations", async () => {
			const { looksLikeMalformedAssembledReport } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Findings\n\n${goodReportBody(60)}\n\n## Limitations\n\n${goodReportBody(60)}`;
			expect(
				looksLikeMalformedAssembledReport({
					markdown,
					acceptedSourceTitles: ["Source A", "Source B"],
				}),
			).toBe(false);
		});

		it("returns false for a single scalar heading (below threshold of 2)", async () => {
			const { looksLikeMalformedAssembledReport } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## 8B parameters\n\n${goodReportBody(60)}`;
			expect(
				looksLikeMalformedAssembledReport({
					markdown,
					acceptedSourceTitles: [],
				}),
			).toBe(false);
		});

		it("returns true when scalar heading count >= 2", async () => {
			const { looksLikeMalformedAssembledReport } = await import("./pipeline");
			const markdown = `## Executive Summary\n\ntext\n\n## 8 GB\n\ntext\n\n## 16 GB\n\ntext`;
			const result = looksLikeMalformedAssembledReport({
				markdown,
				acceptedSourceTitles: [],
			});
			expect(result).toBe(true);
		});

		it("returns true when envelope heading count >= 2", async () => {
			const { looksLikeMalformedAssembledReport } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Date 2026-06-21\n\n${goodReportBody(40)}\n\n## Profile overview\n\n${goodReportBody(40)}`;
			expect(
				looksLikeMalformedAssembledReport({
					markdown,
					acceptedSourceTitles: [],
				}),
			).toBe(true);
		});

		it("returns false when source-title-matching heading count is 2 (below threshold of 3)", async () => {
			const { looksLikeMalformedAssembledReport } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Hybrid retrieval enterprise SaaS\n\n${goodReportBody(40)}\n\n## Evidence from performance benchmarks\n\n${goodReportBody(40)}`;
			expect(
				looksLikeMalformedAssembledReport({
					markdown,
					acceptedSourceTitles: [
						"Hybrid retrieval architectures for enterprise SaaS",
						"Evidence from performance benchmarks and latency analysis",
					],
				}),
			).toBe(false);
		});

		it("returns true when source-title-matching heading count >= 3", async () => {
			const { looksLikeMalformedAssembledReport } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Hybrid retrieval enterprise SaaS\n\n${goodReportBody(40)}\n\n## Performance benchmarks latency\n\n${goodReportBody(40)}\n\n## Scalability analysis cloud deployment\n\n${goodReportBody(40)}`;
			expect(
				looksLikeMalformedAssembledReport({
					markdown,
					acceptedSourceTitles: [
						"Hybrid retrieval architectures for enterprise SaaS",
						"Performance benchmarks and latency analysis of RAG systems",
						"Scalability analysis for cloud deployment patterns",
					],
				}),
			).toBe(true);
		});

		it("returns true when envelope heading + envelope scalar lines >= 3", async () => {
			const { looksLikeMalformedAssembledReport } = await import("./pipeline");
			const markdown = `## Profile overview\n\n${goodReportBody(40)}\n\n**Date:** 2026-06-21\n\n${goodReportBody(40)}\n\n**Status:** final\n\n${goodReportBody(40)}`;
			expect(
				looksLikeMalformedAssembledReport({
					markdown,
					acceptedSourceTitles: [],
				}),
			).toBe(true);
		});

		it("returns false for a good report with 5 substantive headings including Limitations", async () => {
			const { looksLikeMalformedAssembledReport } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Key Findings\n\n${goodReportBody(60)}\n\n## Limitations\n\n${goodReportBody(50)}\n\n## Recommendations\n\n${goodReportBody(60)}`;
			expect(
				looksLikeMalformedAssembledReport({
					markdown,
					acceptedSourceTitles: ["Some research paper about RAG"],
				}),
			).toBe(false);
		});
	});

	describe("needsAssemblyRepair", () => {
		it("returns false for a report passing both guards", async () => {
			const { needsAssemblyRepair } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(300)}\n\n## Analysis\n\n${goodReportBody(100)}\n\n## Findings\n\n${goodReportBody(100)}\n\n## Limitations\n\n${goodReportBody(80)}\n\n## Recommendations\n\n${goodReportBody(100)}`;
			expect(
				needsAssemblyRepair({
					markdown,
					acceptedSourceTitles: [],
				}),
			).toBe(false);
		});

		it("returns true when failing process-only guard", async () => {
			const { needsAssemblyRepair } = await import("./pipeline");
			expect(
				needsAssemblyRepair({
					markdown: "",
					acceptedSourceTitles: [],
				}),
			).toBe(true);
		});

		it("returns true when failing malformed-assembled guard", async () => {
			const { needsAssemblyRepair } = await import("./pipeline");
			const markdown = `## Executive Summary\n\ntext\n\n## 8 GB\n\ntext\n\n## 16 MB\n\ntext`;
			expect(
				needsAssemblyRepair({
					markdown,
					acceptedSourceTitles: [],
				}),
			).toBe(true);
		});

		it("returns true when both guards fail", async () => {
			const { needsAssemblyRepair } = await import("./pipeline");
			expect(
				needsAssemblyRepair({
					markdown: "   \n  ",
					acceptedSourceTitles: [],
				}),
			).toBe(true);
		});
	});

	describe("isLikelySentenceClaimHeading", () => {
		it("returns false for a topical heading with trailing period but no claim verb", async () => {
			const { isLikelySentenceClaimHeading } = await import("./pipeline");
			expect(isLikelySentenceClaimHeading("Top Self-Hosted Models.")).toBe(
				false,
			);
		});

		it("returns true for a sentence heading with trailing period and claim verb", async () => {
			const { isLikelySentenceClaimHeading } = await import("./pipeline");
			expect(
				isLikelySentenceClaimHeading("This model outperforms competitors."),
			).toBe(true);
		});

		it("returns false for a short heading without trailing period", async () => {
			const { isLikelySentenceClaimHeading } = await import("./pipeline");
			expect(isLikelySentenceClaimHeading("Key Findings")).toBe(false);
		});

		it("returns false for a Hungarian topical heading with period but no claim verb", async () => {
			const { isLikelySentenceClaimHeading } = await import("./pipeline");
			expect(isLikelySentenceClaimHeading("Legjobb modellek.")).toBe(false);
		});

		it("returns true for a Hungarian sentence heading with period and claim verb", async () => {
			const { isLikelySentenceClaimHeading } = await import("./pipeline");
			expect(
				isLikelySentenceClaimHeading("A modell támogatja a gyors keresést."),
			).toBe(true);
		});
	});

	describe("ensureLimitationsSection", () => {
		it("returns unchanged when report has fewer than 4 headings", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}`;
			const result = ensureLimitationsSection(markdown, "en");
			expect(result).toBe(markdown);
		});

		it("returns unchanged when report already has a Limitations heading", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Findings\n\n${goodReportBody(60)}\n\n## Limitations\n\n${goodReportBody(50)}`;
			const result = ensureLimitationsSection(markdown, "en");
			expect(result).toBe(markdown);
		});

		it("appends Limitations section when report has 4+ headings and no Limitations heading", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Findings\n\n${goodReportBody(60)}\n\n## Recommendations\n\n${goodReportBody(60)}`;
			const result = ensureLimitationsSection(markdown, "en");
			expect(result).toContain("## Limitations");
			expect(result).not.toBe(markdown);
		});

		it("appends Hungarian Limitations section when language is 'hu'", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Vezetői összefoglaló\n\n${goodReportBody(60)}\n\n## Elemzés\n\n${goodReportBody(60)}\n\n## Megállapítások\n\n${goodReportBody(60)}\n\n## Ajánlások\n\n${goodReportBody(60)}`;
			const result = ensureLimitationsSection(markdown, "hu");
			expect(result).toContain("## Korlátok");
			expect(result).not.toBe(markdown);
		});

		it("recognizes 'Constraints' as an existing limitations heading", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Executive Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Constraints\n\n${goodReportBody(60)}\n\n## Recommendations\n\n${goodReportBody(60)}`;
			const result = ensureLimitationsSection(markdown, "en");
			expect(result).toBe(markdown);
		});
	});

	describe("stripModelBoilerplate", () => {
		it("strips 'Report generated at the ... stage' boilerplate", async () => {
			const { stripModelBoilerplate } = await import("./pipeline");
			const input = `## Summary\n\nSome content.\n\nReport generated at the assembly stage\n\n## Analysis\n\nMore content.`;
			const result = stripModelBoilerplate(input);
			expect(result).not.toContain("Report generated at the assembly stage");
			expect(result).toContain("## Summary");
			expect(result).toContain("## Analysis");
		});

		it("strips 'Generated by the Atlas assemble stage' boilerplate", async () => {
			const { stripModelBoilerplate } = await import("./pipeline");
			const input = `## Summary\n\nContent.\n\nGenerated by the Atlas assemble stage\n\n## Analysis`;
			const result = stripModelBoilerplate(input);
			expect(result).not.toContain("Generated by the Atlas assemble stage");
		});

		it("strips 'Generated during the synthesize stage' boilerplate", async () => {
			const { stripModelBoilerplate } = await import("./pipeline");
			const input = `## Summary\n\nContent.\n\nGenerated during the synthesize stage\n\n## Analysis`;
			const result = stripModelBoilerplate(input);
			expect(result).not.toContain("Generated during the synthesize stage");
		});

		it("strips 'This report was compiled by Atlas' boilerplate", async () => {
			const { stripModelBoilerplate } = await import("./pipeline");
			const input = `## Summary\n\nContent.\n\nThis report was compiled by Atlas\n\n## Analysis`;
			const result = stripModelBoilerplate(input);
			expect(result).not.toContain("This report was compiled by Atlas");
		});

		it("strips 'Use this as a starting point' boilerplate", async () => {
			const { stripModelBoilerplate } = await import("./pipeline");
			const input = `## Summary\n\nContent.\n\nUse this as a starting point for further investigation\n\n## Analysis`;
			const result = stripModelBoilerplate(input);
			expect(result).not.toContain(
				"Use this as a starting point for further investigation",
			);
		});

		it("does NOT strip legitimate content that mentions a stage name without generation verb", async () => {
			const { stripModelBoilerplate } = await import("./pipeline");
			const input = `## Assembly Process\n\nThe assembly stage involves processing the evidence packs to produce a coherent report.`;
			const result = stripModelBoilerplate(input);
			expect(result).toBe(input);
		});

		it("cleans up excess newlines after boilerplate removal", async () => {
			const { stripModelBoilerplate } = await import("./pipeline");
			const input = `## Summary\n\nContent.\n\nReport generated at the assembly stage\n\n## Analysis\n\nMore.`;
			const result = stripModelBoilerplate(input);
			expect(result).not.toMatch(/\n{4,}/);
		});
	});

	describe("deduplicateHeadings", () => {
		it("removes duplicate ## Limitations headings keeping first occurrence", async () => {
			const { deduplicateHeadings } = await import("./pipeline");
			const input = `## Summary\n\nBody.\n\n## Limitations\n\nFirst limitations.\n\n## Analysis\n\nBody.\n\n## Limitations\n\nSecond limitations.`;
			const result = deduplicateHeadings(input);
			// Only the heading line is removed; content under duplicate headings is preserved
			expect(result).toContain("First limitations");
			expect(result).toContain("Second limitations");
			expect((result.match(/^## Limitations\b/gm) || []).length).toBe(1);
		});

		it("preserves unique headings unchanged", async () => {
			const { deduplicateHeadings } = await import("./pipeline");
			const input = `## Summary\n\nBody.\n\n## Analysis\n\nBody.\n\n## Findings\n\nBody.`;
			const result = deduplicateHeadings(input);
			expect(result).toBe(input);
		});

		it("handles case-insensitive deduplication of headings", async () => {
			const { deduplicateHeadings } = await import("./pipeline");
			const input = `## Limitations\n\nFirst.\n\n## LIMITATIONS\n\nSecond.`;
			const result = deduplicateHeadings(input);
			expect((result.match(/^## Limitations\b/gm) || []).length).toBe(1);
			expect((result.match(/^## LIMITATIONS\b/gm) || []).length).toBe(0);
			expect(result).toContain("First");
		});

		it("handles accent-insensitive deduplication of Hungarian headings", async () => {
			const { deduplicateHeadings } = await import("./pipeline");
			const input = `## Korlátok\n\nElső.\n\n## Korlatok\n\nMásodik.`;
			const result = deduplicateHeadings(input);
			const korlatokCount =
				(result.match(/## Korlátok/g) || []).length +
				(result.match(/## Korlatok/g) || []).length;
			expect(korlatokCount).toBe(1);
		});
	});

	describe("hasLimitationsHeading extended detection", () => {
		it("detects '## Limitations and Caveats' as a limitations heading", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Findings\n\n${goodReportBody(60)}\n\n## Limitations and Caveats\n\n${goodReportBody(50)}`;
			const result = ensureLimitationsSection(markdown, "en");
			expect(result).toBe(markdown);
		});

		it("detects '## Limitations & Gaps' as a limitations heading", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Findings\n\n${goodReportBody(60)}\n\n## Limitations & Gaps\n\n${goodReportBody(50)}`;
			const result = ensureLimitationsSection(markdown, "en");
			expect(result).toBe(markdown);
		});

		it("detects '## Report Limitations' as a limitations heading", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Findings\n\n${goodReportBody(60)}\n\n## Report Limitations\n\n${goodReportBody(50)}`;
			const result = ensureLimitationsSection(markdown, "en");
			expect(result).toBe(markdown);
		});

		it("detects '## Korlátok' (Hungarian with accent) as a limitations heading", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Vezetői összefoglaló\n\n${goodReportBody(60)}\n\n## Elemzés\n\n${goodReportBody(60)}\n\n## Megállapítások\n\n${goodReportBody(60)}\n\n## Korlátok\n\n${goodReportBody(50)}`;
			const result = ensureLimitationsSection(markdown, "hu");
			expect(result).toBe(markdown);
		});

		it("detects '## Limitations and Constraints' as a limitations heading", async () => {
			const { ensureLimitationsSection } = await import("./pipeline");
			const markdown = `## Summary\n\n${goodReportBody(60)}\n\n## Analysis\n\n${goodReportBody(60)}\n\n## Findings\n\n${goodReportBody(60)}\n\n## Limitations and Constraints\n\n${goodReportBody(50)}`;
			const result = ensureLimitationsSection(markdown, "en");
			expect(result).toBe(markdown);
		});
	});
});
