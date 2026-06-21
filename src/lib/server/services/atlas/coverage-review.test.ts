import { describe, expect, it } from "vitest";
import { getAtlasProfileRuntimeConfig } from "./config";
import {
	buildAtlasCoverageReviewPrompt,
	parseAndApproveAtlasCoverageReview,
} from "./coverage-review";
import type { AtlasEvidencePack } from "./types";

const evidencePacks: AtlasEvidencePack[] = [
	{
		version: "atlas.evidence-pack.v1",
		id: "pack-current-ai-governance",
		sourceRefs: [
			{
				id: "web-1",
				kind: "web",
				title: "Current AI governance report",
				url: "https://example.com/current-ai-governance",
				authority: "accepted_web",
			},
		],
		sourceKind: "web",
		authority: "accepted_web",
		supportedFacets: ["AI governance", "risk controls"],
		supportedQuestions: [
			"How should the report cover current AI governance controls?",
		],
		evidence: {
			summary:
				"The accepted source discusses AI governance controls but does not compare 2026 regulatory enforcement updates.",
			excerpt:
				"AI governance controls should be mapped to policy ownership, evaluation, and monitoring.",
		},
		conflicts: [],
		limitations: ["No accepted evidence compares 2026 enforcement updates."],
		freshness: {
			asOfDate: "2026-01-15",
			retrievedAt: "2026-06-21",
			isCurrentEvidence: true,
			parentAtlasJobId: null,
			note: null,
		},
		affectedSectionHint: "Governance controls",
		versionNote: "test fixture",
	},
];

function reviewText(proposals: unknown[], sufficient = false): string {
	return JSON.stringify({ sufficient, proposals });
}

describe("Atlas coverage review", () => {
	it("approves a high-priority concrete proposal while keeping approval server-owned", () => {
		const result = parseAndApproveAtlasCoverageReview({
			modelText: reviewText([
				{
					missingQuestion:
						"Which 2026 regulatory enforcement updates affect the governance-controls section?",
					whyCurrentEvidenceIsWeak:
						"Current Evidence Packs cover general governance controls, but no accepted source answers the governance-controls section with current 2026 enforcement evidence.",
					targetSearchQuery:
						"2026 AI governance regulatory enforcement updates governance controls official guidance",
					desiredEvidenceType: "official current web source",
					affectedSection: "Governance controls",
					priority: "high",
				},
			]),
			profileConfig: getAtlasProfileRuntimeConfig("in-depth"),
			completedGapFillRounds: 0,
		});

		expect(result.sufficient).toBe(false);
		expect(result.proposals).toHaveLength(1);
		expect(result.approvedGapCandidates).toEqual([
			expect.objectContaining({
				priority: "high",
				targetSearchQuery:
					"2026 AI governance regulatory enforcement updates governance controls official guidance",
			}),
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("rejects broad proposals that do not provide an actionable search target", () => {
		const result = parseAndApproveAtlasCoverageReview({
			modelText: reviewText([
				{
					missingQuestion: "Which competitors matter?",
					whyCurrentEvidenceIsWeak: "Need more evidence.",
					targetSearchQuery: "research more competitors",
					desiredEvidenceType: "more evidence",
					affectedSection: "Competition",
					priority: "critical",
				},
			]),
			profileConfig: getAtlasProfileRuntimeConfig("exhaustive"),
			completedGapFillRounds: 0,
		});

		expect(result.approvedGapCandidates).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "atlas_gap_proposal_not_actionable",
				severity: "warning",
			}),
		]);
	});

	it("skips low-priority proposals even when they are concrete", () => {
		const result = parseAndApproveAtlasCoverageReview({
			modelText: reviewText([
				{
					missingQuestion:
						"Which optional vendor case study could add color to the operations section?",
					whyCurrentEvidenceIsWeak:
						"Current Evidence Packs answer the operations section, but a case study could add nonessential color.",
					targetSearchQuery:
						"enterprise search operations case study vector reranking 2026",
					desiredEvidenceType: "case study",
					affectedSection: "Operations",
					priority: "low",
				},
			]),
			profileConfig: getAtlasProfileRuntimeConfig("exhaustive"),
			completedGapFillRounds: 0,
		});

		expect(result.approvedGapCandidates).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "atlas_gap_proposal_priority_too_low",
			}),
		]);
	});

	it("skips otherwise valid proposals when the profile cap is exhausted", () => {
		const result = parseAndApproveAtlasCoverageReview({
			modelText: reviewText([
				{
					missingQuestion:
						"Which 2026 benchmark evidence affects the evaluation section?",
					whyCurrentEvidenceIsWeak:
						"Current Evidence Packs do not answer the evaluation section with 2026 benchmark evidence.",
					targetSearchQuery:
						"2026 enterprise retrieval benchmark hybrid search reranking evaluation",
					desiredEvidenceType: "benchmark",
					affectedSection: "Evaluation",
					priority: "critical",
				},
			]),
			profileConfig: getAtlasProfileRuntimeConfig("in-depth"),
			completedGapFillRounds: 1,
		});

		expect(result.approvedGapCandidates).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "atlas_gap_fill_cap_exhausted",
			}),
		]);
	});

	it("early-stops when the coverage review says current Evidence Packs are sufficient", () => {
		const result = parseAndApproveAtlasCoverageReview({
			modelText: reviewText([], true),
			profileConfig: getAtlasProfileRuntimeConfig("exhaustive"),
			completedGapFillRounds: 0,
		});

		expect(result.sufficient).toBe(true);
		expect(result.approvedGapCandidates).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "atlas_coverage_review_sufficient",
				severity: "info",
			}),
		]);
	});

	it("records a diagnostic and approves no gaps for malformed review JSON", () => {
		const result = parseAndApproveAtlasCoverageReview({
			modelText: "The current evidence looks weak; keep researching.",
			profileConfig: getAtlasProfileRuntimeConfig("exhaustive"),
			completedGapFillRounds: 0,
		});

		expect(result.sufficient).toBe(false);
		expect(result.proposals).toEqual([]);
		expect(result.approvedGapCandidates).toEqual([]);
		expect(result.limitations).toEqual([
			expect.objectContaining({
				code: "atlas_coverage_review_invalid_json",
			}),
		]);
	});

	it("builds a prompt that compares intended questions and outline against Evidence Packs", () => {
		const prompt = JSON.parse(
			buildAtlasCoverageReviewPrompt({
				language: "en",
				query: "Create an Atlas report about AI governance controls.",
				currentDate: "2026-06-21",
				intendedQuestions: [
					"How should the report cover current AI governance controls?",
				],
				outline: "Executive Summary; Governance controls; Limitations",
				evidencePacks,
				evidencePackDiagnostics: [],
			}),
		);

		expect(prompt).toMatchObject({
			query: "Create an Atlas report about AI governance controls.",
			intendedQuestions: [
				"How should the report cover current AI governance controls?",
			],
			outline: "Executive Summary; Governance controls; Limitations",
			evidencePacks,
		});
		expect(prompt.instructions).toContain(
			"Compare intendedQuestions and outline against evidencePacks.",
		);
		expect(Object.keys(prompt.expectedJsonShape.proposal)).toEqual([
			"missingQuestion",
			"whyCurrentEvidenceIsWeak",
			"targetSearchQuery",
			"desiredEvidenceType",
			"affectedSection",
			"priority",
		]);
	});
});
