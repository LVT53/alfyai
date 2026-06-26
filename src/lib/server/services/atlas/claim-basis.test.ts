import { describe, expect, it } from "vitest";
import {
	buildAtlasClaimBasisPrompt,
	compactCoverageReview,
	compactEvidencePacks,
	compactSectionBriefs,
	compactSources,
	parseAtlasClaimBasisModelResult,
} from "./claim-basis";
import type {
	AtlasCoverageReview,
	AtlasEvidencePack,
	AtlasSectionBrief,
} from "./types";

const evidencePack: AtlasEvidencePack = {
	version: "atlas.evidence-pack.v1",
	id: "pack-hybrid",
	sourceRefs: [
		{
			id: "web-hybrid",
			kind: "web",
			title: "Hybrid retrieval evidence",
			url: "https://example.com/hybrid",
			authority: "accepted_web",
		},
	],
	sourceKind: "web",
	authority: "accepted_web",
	supportedFacets: ["hybrid retrieval", "reranking"],
	supportedQuestions: ["Which architecture is most reliable?"],
	evidence: {
		summary:
			"Hybrid retrieval combines lexical and semantic recall, and reranking narrows noisy candidates.",
		excerpt:
			"Hybrid retrieval combines lexical and semantic recall. Reranking narrows noisy candidates before final answer generation.",
	},
	conflicts: [],
	limitations: [],
	freshness: {
		asOfDate: "2026-06-21",
		retrievedAt: "2026-06-21",
		isCurrentEvidence: true,
		parentAtlasJobId: null,
		note: null,
	},
	affectedSectionHint: "Executive Summary",
	versionNote: "test pack",
};

const stalePack: AtlasEvidencePack = {
	...evidencePack,
	id: "pack-stale",
	limitations: ["Evidence is older than the requested current window."],
	freshness: {
		asOfDate: "2024-01-01",
		retrievedAt: null,
		isCurrentEvidence: false,
		parentAtlasJobId: "atlas-parent",
		note: "Parent seed evidence can guide revision but must not be treated as fresh current evidence.",
	},
};

const sectionBriefs: AtlasSectionBrief[] = [
	{
		sectionTitle: "Executive Summary",
		brief: "Summarizes the architecture recommendation.",
		evidencePackIds: ["pack-hybrid"],
		sourceAssociations: [
			{
				sourceId: "web-hybrid",
				sourceKind: "web",
				sourceTitle: "Hybrid retrieval evidence",
				url: "https://example.com/hybrid",
				evidencePackId: "pack-hybrid",
				relevance: "Supports the hybrid retrieval recommendation.",
			},
		],
		limitations: [],
	},
];

describe("Atlas Claim Basis", () => {
	it("parses supported direct evidence with a stable id and compact rationale", () => {
		const modelText = JSON.stringify({
			claimBasis: [
				{
					locator: {
						sectionTitle: "Executive Summary",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "Hybrid retrieval improves recall before reranking.",
						quote: "Hybrid retrieval improves recall",
						startOffset: 4,
						endOffset: 36,
					},
					supportLevel: "supported",
					evidencePackIds: ["pack-hybrid"],
					supportRationale:
						"The accepted source says hybrid retrieval combines lexical and semantic recall, which directly supports the claim.",
				},
			],
		});

		const first = parseAtlasClaimBasisModelResult({
			modelText,
			evidencePacks: [evidencePack],
			sectionBriefs,
		});
		const second = parseAtlasClaimBasisModelResult({
			modelText,
			evidencePacks: [evidencePack],
			sectionBriefs,
		});

		expect(first.status).toBe("succeeded");
		expect(first.claimBasis).toHaveLength(1);
		expect(first.claimBasis[0]).toMatchObject({
			version: "atlas.claim-basis.v1",
			id: first.claimBasis[0]?.id,
			locator: {
				sectionTitle: "Executive Summary",
				quote: "Hybrid retrieval improves recall",
				startOffset: 4,
				endOffset: 36,
			},
			supportLevel: "supported",
			evidencePackIds: ["pack-hybrid"],
			sourceRefs: evidencePack.sourceRefs,
			auditConcernCode: null,
		});
		expect(first.claimBasis[0]?.id).toBe(second.claimBasis[0]?.id);
		expect(first.claimBasis[0]?.supportRationale.length).toBeLessThanOrEqual(
			280,
		);
		expect(first.coverageBySection).toContainEqual(
			expect.objectContaining({
				sectionTitle: "Executive Summary",
				basisCount: 1,
				supportedCount: 1,
			}),
		);
	});

	it("downgrades contested and ambiguous evidence to partial support", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: JSON.stringify({
				claimBasis: [
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 0,
							claimIndex: 0,
							claimText: "Benchmarks agree on the best architecture.",
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-hybrid"],
						supportRationale:
							"Accepted evidence points in different directions, so the claim is contested.",
						auditConcernCode: "contested_evidence",
					},
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 0,
							claimIndex: 1,
							claimText: "The evidence clearly identifies the buyer profile.",
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-hybrid"],
						supportRationale:
							"The source language is ambiguous about the buyer profile.",
						auditConcernCode: "ambiguous_evidence",
					},
				],
			}),
			evidencePacks: [evidencePack, stalePack],
			sectionBriefs: [],
		});

		expect(result.claimBasis.map((basis) => basis.supportLevel)).toEqual([
			"partial",
			"partial",
		]);
		expect(result.limitations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "contested_evidence" }),
				expect.objectContaining({ code: "ambiguous_evidence" }),
			]),
		);
	});

	it("keeps supported claims with limitations-only evidence packs as supported", () => {
		const limitationsOnlyPack: AtlasEvidencePack = {
			...evidencePack,
			id: "pack-limited",
			conflicts: [],
			limitations: ["The source is limited to a single region."],
			freshness: {
				asOfDate: "2026-06-22",
				retrievedAt: "2026-06-22",
				isCurrentEvidence: true,
				parentAtlasJobId: null,
				note: null,
			},
		};

		const result = parseAtlasClaimBasisModelResult({
			modelText: JSON.stringify({
				claimBasis: [
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 0,
							claimIndex: 0,
							claimText:
								"Regional deployment patterns show consistent results.",
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-limited"],
						supportRationale:
							"The source directly supports the claim despite regional limitation.",
					},
				],
			}),
			evidencePacks: [limitationsOnlyPack],
			sectionBriefs: [],
		});

		expect(result.status).toBe("succeeded");
		expect(result.claimBasis).toHaveLength(1);
		expect(result.claimBasis[0].supportLevel).toBe("supported");
		expect(result.claimBasis[0].auditConcernCode).toBeNull();
	});

	it("still downgrades supported claims with conflicting evidence packs to partial", () => {
		const conflictsOnlyPack: AtlasEvidencePack = {
			...evidencePack,
			id: "pack-conflict",
			conflicts: [
				"Another accepted source reports different benchmarks for latency.",
			],
			limitations: [],
			freshness: {
				asOfDate: "2026-06-22",
				retrievedAt: "2026-06-22",
				isCurrentEvidence: true,
				parentAtlasJobId: null,
				note: null,
			},
		};

		const result = parseAtlasClaimBasisModelResult({
			modelText: JSON.stringify({
				claimBasis: [
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 0,
							claimIndex: 0,
							claimText: "The architecture always provides sub-10ms latency.",
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-conflict"],
						supportRationale:
							"The evidence conflicts with other latency benchmarks.",
					},
				],
			}),
			evidencePacks: [conflictsOnlyPack],
			sectionBriefs: [],
		});

		expect(result.status).toBe("succeeded");
		expect(result.claimBasis).toHaveLength(1);
		expect(result.claimBasis[0].supportLevel).toBe("partial");
	});

	it("keeps supported claims with stale evidence packs as supported when no conflicts exist", () => {
		const staleOnlyPack: AtlasEvidencePack = {
			...evidencePack,
			id: "pack-stale-only",
			conflicts: [],
			limitations: [],
			freshness: {
				asOfDate: "2024-01-01",
				retrievedAt: null,
				isCurrentEvidence: false,
				parentAtlasJobId: "atlas-old",
				note: "Seed evidence from a previous Atlas job.",
			},
		};

		const result = parseAtlasClaimBasisModelResult({
			modelText: JSON.stringify({
				claimBasis: [
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 0,
							claimIndex: 0,
							claimText:
								"The 2024 benchmark showed consistent performance gains.",
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-stale-only"],
						supportRationale: "The 2024 parent evidence is no longer current.",
					},
				],
			}),
			evidencePacks: [staleOnlyPack],
			sectionBriefs: [],
		});

		expect(result.status).toBe("succeeded");
		expect(result.claimBasis).toHaveLength(1);
		expect(result.claimBasis[0].supportLevel).toBe("supported");
	});

	it("maps hallucinated facts and invented logical links to unsupported", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: JSON.stringify({
				claimBasis: [
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 1,
							claimIndex: 0,
							claimText:
								"Every regulated SaaS buyer adopted one identical RAG architecture in 2026.",
						},
						supportLevel: "partial",
						evidencePackIds: ["pack-hybrid"],
						supportRationale:
							"The accepted source does not make this universal adoption claim.",
						auditConcernCode: "hallucinated_fact",
					},
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 1,
							claimIndex: 1,
							claimText:
								"Because reranking exists, governance logs are automatically complete.",
						},
						supportLevel: "partial",
						evidencePackIds: ["pack-hybrid"],
						supportRationale:
							"The evidence does not connect reranking to complete governance logs.",
						auditConcernCode: "made_up_logical_connection",
					},
				],
			}),
			evidencePacks: [evidencePack],
			sectionBriefs: [],
		});

		expect(result.claimBasis.map((basis) => basis.supportLevel)).toEqual([
			"unsupported",
			"unsupported",
		]);
		expect(result.retryRequested).toBe(true);
	});

	it("keeps distinct factual claims in one paragraph as separate bases", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: JSON.stringify({
				claimBasis: [
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 2,
							claimIndex: 0,
							claimText: "Hybrid retrieval broadens recall.",
							quote: "Hybrid retrieval broadens recall",
							startOffset: 0,
							endOffset: 33,
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-hybrid"],
						supportRationale:
							"The source describes hybrid retrieval combining lexical and semantic recall.",
					},
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 2,
							claimIndex: 1,
							claimText: "Reranking narrows noisy candidates.",
							quote: "reranking narrows noisy candidates",
							startOffset: 45,
							endOffset: 80,
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-hybrid"],
						supportRationale:
							"The source separately states reranking narrows noisy candidates.",
					},
				],
			}),
			evidencePacks: [evidencePack],
			sectionBriefs: [],
		});

		expect(result.claimBasis).toHaveLength(2);
		expect(result.claimBasis.map((basis) => basis.locator.claimIndex)).toEqual([
			0, 1,
		]);
		expect(result.claimBasis.map((basis) => basis.locator.startOffset)).toEqual(
			[0, 45],
		);
	});

	it("extracts claim basis JSON embedded in surrounding model prose", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: [
				"Here is the strict JSON:",
				JSON.stringify({
					claimBasis: [
						{
							locator: {
								sectionTitle: "Executive Summary",
								paragraphIndex: 0,
								claimIndex: 0,
								claimText: "Hybrid retrieval improves recall before reranking.",
							},
							supportLevel: "supported",
							evidencePackIds: ["pack-hybrid"],
							supportRationale:
								"The accepted source says hybrid retrieval combines lexical and semantic recall.",
						},
					],
				}),
				"End.",
			].join("\n"),
			evidencePacks: [evidencePack],
			sectionBriefs,
		});

		expect(result.status).toBe("succeeded");
		expect(result.claimBasis).toHaveLength(1);
		expect(result.claimBasis[0]).toMatchObject({
			supportLevel: "supported",
			evidencePackIds: ["pack-hybrid"],
		});
	});

	it("falls back to partial paragraph-level basis markers when parsing fails but accepted evidence exists", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: "not json",
			evidencePacks: [evidencePack],
			sectionBriefs,
			assembledMarkdown:
				"## Executive Summary\nHybrid retrieval improves recall before reranking.",
		});

		expect(result.status).toBe("succeeded");
		expect(result.failureReason).toBeNull();
		expect(result.claimBasis).toHaveLength(1);
		expect(result.claimBasis[0]).toMatchObject({
			supportLevel: "partial",
			evidencePackIds: ["pack-hybrid"],
			auditConcernCode: "atlas_claim_basis_section_fallback",
			locator: expect.objectContaining({
				sectionTitle: "Executive Summary",
				paragraphIndex: 0,
			}),
		});
		expect(result.claimBasis[0].locator.claimText).toContain("Hybrid");
		expect(result.limitations).toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_section_fallback",
			}),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "atlas_claim_basis_invalid_json" }),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_section_fallback",
			}),
		);
	});

	it("produces per-paragraph fallback markers with non-null paragraphIndex when multiple paragraphs exist", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: "not json",
			evidencePacks: [evidencePack, stalePack],
			sectionBriefs,
			assembledMarkdown: [
				"## Executive Summary",
				"Hybrid retrieval combines lexical and semantic recall for broad candidate retrieval.",
				"",
				"Reranking improves precision by narrowing noisy candidates before final answer generation.",
				"",
				"A third paragraph discusses evaluation methodology and benchmark results.",
				"",
				"## Findings",
				"Evidence from multiple sources confirms that hybrid + rerank outperforms either approach alone.",
				"",
				"Production deployments at scale show measurable latency improvements.",
				"",
				"## Limitations",
				"Current evidence lacks long-term longitudinal studies.",
			].join("\n"),
		});

		expect(result.status).toBe("succeeded");
		expect(result.claimBasis.length).toBeGreaterThanOrEqual(6);
		expect(result.claimBasis.length).toBeLessThanOrEqual(24);

		const withParagraphIndex = result.claimBasis.filter(
			(b) => b.locator.paragraphIndex !== null,
		);
		expect(withParagraphIndex.length).toBe(result.claimBasis.length);

		const executiveMarkers = result.claimBasis.filter(
			(b) => b.locator.sectionTitle === "Executive Summary",
		);
		expect(executiveMarkers.length).toBe(3);
		expect(executiveMarkers.map((b) => b.locator.paragraphIndex)).toEqual([
			0, 1, 2,
		]);

		for (const marker of result.claimBasis) {
			expect(marker.supportLevel).toBe("partial");
			expect(marker.auditConcernCode).toBe(
				"atlas_claim_basis_section_fallback",
			);
			expect(marker.locator.claimText.length).toBeGreaterThan(0);
			expect(marker.locator.claimText.length).toBeLessThanOrEqual(160);
			expect(marker.locator.claimText).not.toContain(
				"Section-level evidence coverage",
			);
			expect(marker.locator.claimText).not.toContain(
				"paragraph-level evidence",
			);
			expect(marker.evidencePackIds.length).toBeGreaterThan(0);
		}
	});

	it("does not fabricate claim basis data when parsing fails without accepted evidence", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: "not json",
			evidencePacks: [],
			sectionBriefs,
		});

		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("parseable strict JSON");
		expect(result.claimBasis).toEqual([]);
	});

	it("builds an audit prompt from accepted Evidence Packs and section briefs", () => {
		const prompt = JSON.parse(
			buildAtlasClaimBasisPrompt({
				language: "en",
				currentDate: "2026-06-21",
				assembledMarkdown:
					"## Executive Summary\nHybrid retrieval improves recall before reranking.",
				evidencePacks: [evidencePack],
				evidencePackDiagnostics: [],
				sectionBriefs,
				sources: [
					{
						title: "Hybrid retrieval evidence",
						url: evidencePack.sourceRefs[0]?.url,
					},
				],
				limitation: null,
			}),
		) as {
			expectedJsonShape: { supportLevel: string };
			evidencePacks: unknown[];
			sectionBriefs: Array<{ sectionTitle: string }>;
			instructions: string[];
		};

		expect(prompt.expectedJsonShape.supportLevel).toBe(
			"supported | partial | unsupported",
		);
		expect(prompt.evidencePacks).toHaveLength(1);
		expect(prompt.sectionBriefs).toHaveLength(1);
		expect(prompt.sectionBriefs[0].sectionTitle).toBe(
			sectionBriefs[0]?.sectionTitle,
		);
		expect(prompt.instructions.join(" ")).toContain(
			"Do not include hidden chain-of-thought",
		);
		expect(prompt.instructions.join(" ")).toContain(
			"hallucinated facts, invented logical links",
		);
	});

	it("produces compact evidence pack projections dropping excerpt, facets, questions, and versionNote", () => {
		const packs = [
			{
				...evidencePack,
				supportedFacets: ["facet1", "facet2"],
				supportedQuestions: ["question1"],
				versionNote: "should be dropped",
			},
			{
				...evidencePack,
				id: "pack-2",
				evidence: {
					summary: "Second pack summary",
					excerpt: "Long excerpt that should be dropped".repeat(50),
				},
				supportedFacets: ["facet3"],
				supportedQuestions: ["q2", "q3"],
				versionNote: "also dropped",
				conflicts: ["conflict1", "conflict2", "conflict3"],
				limitations: ["lim1", "lim2", "lim3"],
			},
		];

		const compacted = compactEvidencePacks(packs);

		expect(compacted).toHaveLength(2);
		expect(compacted[0]).toHaveProperty("id", "pack-hybrid");
		expect(compacted[0]).toHaveProperty("evidence");
		expect(compacted[0].evidence).toHaveProperty("summary");
		expect(compacted[0].evidence).not.toHaveProperty("excerpt");
		expect(compacted[0]).not.toHaveProperty("supportedFacets");
		expect(compacted[0]).not.toHaveProperty("supportedQuestions");
		expect(compacted[0]).not.toHaveProperty("versionNote");
		expect(compacted[0]).toHaveProperty("authority", "accepted_web");
		expect(compacted[0]).toHaveProperty("freshness");
		expect(compacted[0].freshness).toEqual({ isCurrentEvidence: true });
		expect(compacted[0].sourceRefs).toEqual([
			{
				id: "web-hybrid",
				title: "Hybrid retrieval evidence",
				url: "https://example.com/hybrid",
				authority: "accepted_web",
			},
		]);
		// second pack: limitations and conflicts sliced to first 2
		expect(compacted[1].limitations).toHaveLength(2);
		expect(compacted[1].conflicts).toHaveLength(2);
	});

	it("produces compact section briefs with truncated brief text and sliced arrays", () => {
		const briefs: AtlasSectionBrief[] = [
			{
				sectionTitle: "Executive Summary",
				brief: "A".repeat(500),
				evidencePackIds: [
					"p1",
					"p2",
					"p3",
					"p4",
					"p5",
					"p6",
					"p7",
					"p8",
					"p9",
					"p10",
				],
				sourceAssociations: Array.from({ length: 8 }, (_, i) => ({
					sourceId: `src-${i}`,
					sourceKind: "web" as const,
					sourceTitle: `Source ${i}`,
					url: `https://example.com/${i}`,
					evidencePackId: `p${i}`,
					relevance: `relevant ${i}`,
				})),
				limitations: ["lim1", "lim2"],
			},
		];

		const compacted = compactSectionBriefs(briefs);

		expect(compacted).toHaveLength(1);
		expect(compacted[0].sectionTitle).toBe("Executive Summary");
		expect(compacted[0].brief.length).toBeLessThanOrEqual(203); // 200 + "..."
		expect(compacted[0].brief).toContain("A");
		expect(compacted[0].evidencePackIds).toHaveLength(8);
		expect(compacted[0].sourceAssociations).toHaveLength(5);
		expect(compacted[0].sourceAssociations[0]).toEqual({
			id: "src-0",
			title: "Source 0",
		});
		expect(compacted[0]).not.toHaveProperty("limitations");
	});

	it("produces compact coverage review with count instead of full proposals", () => {
		const review: AtlasCoverageReview = {
			version: "atlas.coverage-review.v1",
			sufficient: true,
			proposals: [
				{
					missingQuestion: "What about X?",
					whyCurrentEvidenceIsWeak: "No data",
					targetSearchQuery: "X research",
					desiredEvidenceType: "study",
					affectedSection: "Findings",
					priority: "medium",
				},
			],
			approvedGapCandidates: [
				{
					missingQuestion: "Gap A",
					whyCurrentEvidenceIsWeak: "Weak",
					targetSearchQuery: "query A",
					desiredEvidenceType: "article",
					affectedSection: "S1",
					priority: "high",
				},
				{
					missingQuestion: "Gap B",
					whyCurrentEvidenceIsWeak: "Weak",
					targetSearchQuery: "query B",
					desiredEvidenceType: "article",
					affectedSection: "S2",
					priority: "medium",
				},
			],
			diagnostics: [],
			limitations: [
				{ code: "L1", message: "Limitation 1" },
				{ code: "L2", message: "Limitation 2" },
				{ code: "L3", message: "Limitation 3" },
				{ code: "L4", message: "Limitation 4" },
			],
		};

		const compacted = compactCoverageReview(review);

		expect(compacted).toEqual({
			sufficient: true,
			approvedGapCandidateCount: 2,
			limitations: [
				{ code: "L1", message: "Limitation 1" },
				{ code: "L2", message: "Limitation 2" },
				{ code: "L3", message: "Limitation 3" },
			],
		});
		expect(compacted).not.toHaveProperty("proposals");
		expect(compacted).not.toHaveProperty("approvedGapCandidates");
		expect(compacted).not.toHaveProperty("diagnostics");
	});

	it("returns null for null coverage review", () => {
		expect(compactCoverageReview(null)).toBeNull();
	});

	it("produces compact sources with title and url only", () => {
		const sources = [
			{ title: "Source 1", url: "https://example.com/1" },
			{ title: "Source 2", url: null },
		];

		const compacted = compactSources(sources);

		expect(compacted).toEqual([
			{ title: "Source 1", url: "https://example.com/1" },
			{ title: "Source 2", url: null },
		]);
		// Verify no extra properties
		expect(Object.keys(compacted[0]).sort()).toEqual(["title", "url"]);
	});

	it("produces a simplified prompt at least 40% smaller than full-object equivalent", () => {
		// Build 16 realistic evidence packs with large excerpts
		const largePacks: AtlasEvidencePack[] = Array.from(
			{ length: 16 },
			(_, i) => ({
				version: "atlas.evidence-pack.v1",
				id: `pack-${i}`,
				sourceRefs: [
					{
						id: `src-${i}`,
						kind: "web" as const,
						title: `Source ${i}`,
						url: `https://example.com/${i}`,
						authority: "accepted_web" as const,
					},
				],
				sourceKind: "web" as const,
				authority: "accepted_web" as const,
				supportedFacets: [`facet-${i}-a`, `facet-${i}-b`],
				supportedQuestions: [`q-${i}`],
				evidence: {
					summary: `Summary ${i}`,
					excerpt: `Long excerpt ${i}: ${"X".repeat(2000)}`,
				},
				conflicts: [`conflict-${i}-a`, `conflict-${i}-b`, `conflict-${i}-c`],
				limitations: [`lim-${i}-a`, `lim-${i}-b`, `lim-${i}-c`],
				freshness: {
					asOfDate: "2026-06-22",
					retrievedAt: "2026-06-22",
					isCurrentEvidence: true,
					parentAtlasJobId: null,
					note: null,
				},
				affectedSectionHint: `Section ${i}`,
				versionNote: `version note ${i}`,
			}),
		);

		const largeBriefs: AtlasSectionBrief[] = Array.from(
			{ length: 10 },
			(_, i) => ({
				sectionTitle: `Section ${i}`,
				brief: "B".repeat(500),
				evidencePackIds: [`pack-${i}`],
				sourceAssociations: Array.from({ length: 6 }, (_, j) => ({
					sourceId: `src-${i}-${j}`,
					sourceKind: "web" as const,
					sourceTitle: `Source ${i}-${j}`,
					url: `https://example.com/${i}-${j}`,
					evidencePackId: `pack-${i}`,
					relevance: `relevant ${i}-${j}`,
				})),
				limitations: [],
			}),
		);

		const largeSources = Array.from({ length: 16 }, (_, i) => ({
			title: `Source ${i}`,
			url: `https://example.com/${i}`,
		}));

		const prompt = buildAtlasClaimBasisPrompt({
			language: "en",
			currentDate: "2026-06-22",
			assembledMarkdown: "A".repeat(10000),
			evidencePacks: largePacks,
			evidencePackDiagnostics: [],
			sectionBriefs: largeBriefs,
			sources: largeSources,
			limitation: null,
		});

		// Measure the prompt size
		const promptLength = prompt.length;

		// Build the equivalent WITHOUT compaction to estimate the old size
		const oldStylePrompt = JSON.stringify({
			task: "Generate Atlas Claim Basis audit data for factual claims in the report. Return strict JSON only.",
			expectedLanguage: "en",
			languageParityCheck:
				"Flag language drift away from English except original source titles, quoted source text, product names, or citations.",
			currentDate: "2026-06-22",
			instructions: [
				"Use only accepted Evidence Packs, source refs, section briefs, and explicit limitations as support.",
				"Support level must be exactly supported, partial, or unsupported.",
				"Thin, stale, contested, or ambiguous evidence must be partial or unsupported based on severity.",
				"Hallucinated facts or invented logical links must be unsupported, not partial.",
				"Adjacent claims may share one Claim Basis only when both evidence and rationale match.",
				"A paragraph with distinct factual claims can receive multiple Claim Basis objects.",
				"Use quote plus startOffset and endOffset when an important fact appears mid-sentence.",
				"Write one compact supportRationale suitable for user display.",
				"Do not include hidden chain-of-thought or model-certainty scores.",
				"If Claim Basis generation is not possible, return an empty claimBasis array plus diagnostics and limitations; do not invent support data.",
			],
			expectedJsonShape: {
				retryRequested: "boolean",
				supportLevel: "supported | partial | unsupported",
				claimBasis: "array",
				claim: {
					locator: {
						sectionTitle: "string | null",
						paragraphIndex: "number | null",
						claimIndex: "number | null",
						claimText: "string",
						quote: "string | null",
						startOffset: "number | null",
						endOffset: "number | null",
					},
					supportLevel: "supported | partial | unsupported",
					evidencePackIds: "string[]",
					sourceRefs:
						"accepted source refs, optional when evidencePackIds can hydrate them",
					supportRationale: "compact string",
					auditConcernCode: "string | null",
				},
				limitations: "array of { code, message, basisIds, sectionTitle }",
				diagnostics:
					"array of { code, severity, message, sectionTitle, basisId }",
			},
			report: "A".repeat(10000),
			evidencePacks: largePacks,
			evidencePackDiagnostics: [],
			sectionBriefs: largeBriefs,
			coverageReview: null,
			sources: largeSources,
			limitation: null,
		});

		expect(promptLength).toBeLessThan(oldStylePrompt.length * 0.6);
	});

	it("truncates assembled markdown to 8000 chars with a note when longer", () => {
		const longMarkdown = "X".repeat(15000);
		const prompt = JSON.parse(
			buildAtlasClaimBasisPrompt({
				language: "en",
				currentDate: "2026-06-22",
				assembledMarkdown: longMarkdown,
				evidencePacks: [evidencePack],
				evidencePackDiagnostics: [],
				sectionBriefs,
				sources: [{ title: "Example", url: "https://example.com" }],
				limitation: null,
			}),
		) as { report: string };

		expect(prompt.report.length).toBeLessThanOrEqual(8100);
		expect(prompt.report).toContain("truncated");
	});

	it("preserves full markdown when under 8000 chars", () => {
		const shortMarkdown = "## Summary\nShort report.";
		const prompt = JSON.parse(
			buildAtlasClaimBasisPrompt({
				language: "en",
				currentDate: "2026-06-22",
				assembledMarkdown: shortMarkdown,
				evidencePacks: [evidencePack],
				evidencePackDiagnostics: [],
				sectionBriefs,
				sources: [{ title: "Example", url: "https://example.com" }],
				limitation: null,
			}),
		) as { report: string };

		expect(prompt.report).toBe(shortMarkdown);
	});

	it("truncates assembled markdown to explicit maxChars value when passed", () => {
		const longMarkdown = "Y".repeat(20000);
		const prompt = JSON.parse(
			buildAtlasClaimBasisPrompt({
				language: "en",
				currentDate: "2026-06-22",
				assembledMarkdown: longMarkdown,
				evidencePacks: [evidencePack],
				evidencePackDiagnostics: [],
				sectionBriefs,
				sources: [{ title: "Example", url: "https://example.com" }],
				limitation: null,
				maxChars: 3000,
			}),
		) as { report: string };

		expect(prompt.report.length).toBeLessThanOrEqual(3100);
		expect(prompt.report).toContain("truncated");
		expect(prompt.report.length).toBeLessThan(5000);
	});

	it("preserves full markdown when under explicit maxChars", () => {
		const shortMarkdown = "## Summary\nShort report.";
		const prompt = JSON.parse(
			buildAtlasClaimBasisPrompt({
				language: "en",
				currentDate: "2026-06-22",
				assembledMarkdown: shortMarkdown,
				evidencePacks: [evidencePack],
				evidencePackDiagnostics: [],
				sectionBriefs,
				sources: [{ title: "Example", url: "https://example.com" }],
				limitation: null,
				maxChars: 6000,
			}),
		) as { report: string };

		expect(prompt.report).toBe(shortMarkdown);
	});

	it("default behavior unchanged when no maxChars passed", () => {
		const longMarkdown = "X".repeat(15000);
		const prompt = JSON.parse(
			buildAtlasClaimBasisPrompt({
				language: "en",
				currentDate: "2026-06-22",
				assembledMarkdown: longMarkdown,
				evidencePacks: [evidencePack],
				evidencePackDiagnostics: [],
				sectionBriefs,
				sources: [{ title: "Example", url: "https://example.com" }],
				limitation: null,
			}),
		) as { report: string };

		expect(prompt.report.length).toBeLessThanOrEqual(8100);
		expect(prompt.report).toContain("truncated");
		expect(prompt.report.length).toBeGreaterThan(7000);
	});

	it("preserves all instructions and Hungarian parity check in compacted prompt", () => {
		const prompt = JSON.parse(
			buildAtlasClaimBasisPrompt({
				language: "en",
				currentDate: "2026-06-22",
				assembledMarkdown: "## Summary\nTest.",
				evidencePacks: [evidencePack],
				evidencePackDiagnostics: [],
				sectionBriefs,
				sources: [{ title: "Example", url: "https://example.com" }],
				limitation: null,
			}),
		) as {
			instructions: string[];
			languageParityCheck: string;
		};

		expect(prompt.instructions).toHaveLength(14);
		expect(prompt.instructions.join(" ")).toContain("accepted Evidence Packs");
		expect(prompt.instructions.join(" ")).toContain(
			"hallucinated facts, invented logical links",
		);
		expect(prompt.languageParityCheck).toContain("language drift");
	});

	it("includes an instruction to skip Executive Summary in the audit prompt", () => {
		const prompt = JSON.parse(
			buildAtlasClaimBasisPrompt({
				language: "en",
				currentDate: "2026-06-22",
				assembledMarkdown: "## Summary\nTest.",
				evidencePacks: [evidencePack],
				evidencePackDiagnostics: [],
				sectionBriefs,
				sources: [{ title: "Example", url: "https://example.com" }],
				limitation: null,
			}),
		) as {
			instructions: string[];
		};

		expect(prompt.instructions.join(" ")).toContain(
			"Do not generate Claim Basis entries for the Executive Summary section",
		);
		expect(prompt.instructions.join(" ")).toContain(
			"it is descriptive, not a factual claim section",
		);
	});
});
