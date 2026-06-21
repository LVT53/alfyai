import { describe, expect, it } from "vitest";
import {
	buildAtlasClaimBasisPrompt,
	parseAtlasClaimBasisModelResult,
} from "./claim-basis";
import type { AtlasEvidencePack, AtlasSectionBrief } from "./types";

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

	it("downgrades stale, thin, contested, and ambiguous evidence to partial support", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: JSON.stringify({
				claimBasis: [
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 0,
							claimIndex: 0,
							claimText: "The deployment evidence is current.",
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-stale"],
						supportRationale:
							"The cited parent source is useful but stale for a current deployment claim.",
						auditConcernCode: "stale_evidence",
					},
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 0,
							claimIndex: 1,
							claimText: "The adoption pattern is broadly proven.",
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-hybrid"],
						supportRationale:
							"One accepted source suggests the pattern, but the evidence is thin.",
						auditConcernCode: "thin_evidence",
					},
					{
						locator: {
							sectionTitle: "Findings",
							paragraphIndex: 0,
							claimIndex: 2,
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
							claimIndex: 3,
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
			"partial",
			"partial",
		]);
		expect(result.limitations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "stale_evidence" }),
				expect.objectContaining({ code: "thin_evidence" }),
				expect.objectContaining({ code: "contested_evidence" }),
				expect.objectContaining({ code: "ambiguous_evidence" }),
			]),
		);
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

	it("does not fabricate claim basis data when parsing fails", () => {
		const result = parseAtlasClaimBasisModelResult({
			modelText: "not json",
			evidencePacks: [evidencePack],
			sectionBriefs,
		});

		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("parseable strict JSON");
		expect(result.claimBasis).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "atlas_claim_basis_invalid_json" }),
		);
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
			sectionBriefs: unknown[];
			instructions: string[];
		};

		expect(prompt.expectedJsonShape.supportLevel).toBe(
			"supported | partial | unsupported",
		);
		expect(prompt.evidencePacks).toHaveLength(1);
		expect(prompt.sectionBriefs).toEqual(sectionBriefs);
		expect(prompt.instructions.join(" ")).toContain(
			"Do not include hidden chain-of-thought",
		);
		expect(prompt.instructions.join(" ")).toContain(
			"Hallucinated facts or invented logical links must be unsupported",
		);
	});
});
