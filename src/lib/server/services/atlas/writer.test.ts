import { describe, expect, it } from "vitest";
import type { AtlasReportShapeDiagnostics } from "./report-shape-diagnostics";
import type {
	AtlasCoverageReview,
	AtlasEvidencePackDiagnostic,
	AtlasImageCandidate,
	AtlasLifecycleContext,
	AtlasProfile,
	AtlasWriterEvidenceCard,
	AtlasWriterEvidenceCardDiagnostic,
} from "./types";
import {
	type BuildAtlasWriterPromptInput,
	buildAtlasWriterImprovementPrompt,
	buildAtlasWriterPrompt,
	shouldImproveAtlasWriterDraft,
} from "./writer";

function defaultWriterInput(
	overrides: Partial<BuildAtlasWriterPromptInput> = {},
): BuildAtlasWriterPromptInput {
	return {
		language: "en",
		query: "Compare retrieval architectures for regulated SaaS",
		currentDate: "2026-06-22",
		profile: "overview" as AtlasProfile,
		profilePosture: "None",
		decomposeText: "retrieval architecture comparison",
		synthesis:
			"Synthesized findings: hybrid retrieval, semantic search, and lexical matching each have tradeoffs.",
		outline:
			"1. Executive Summary, 2. Findings, 3. Recommendation, 4. Limitations",
		sectionBriefs: [],
		imageCandidates: [] as AtlasImageCandidate[],
		writerEvidenceCardsVersion: "atlas.writer-evidence-card.v1",
		writerEvidenceCards: [] as AtlasWriterEvidenceCard[],
		writerEvidenceCardDiagnostics: [] as AtlasWriterEvidenceCardDiagnostic[],
		evidencePackDiagnostics: [] as AtlasEvidencePackDiagnostic[],
		coverageReview: defaultCoverageReview(),
		limitation: null,
		lifecycle: {
			familyId: "test-family",
			mode: "new_family" as const,
			action: "create" as const,
			rootAtlasJobId: "test-job",
			currentAtlasJobId: "test-job",
			parentAtlasJobId: null,
			forkedFromAtlasJobId: null,
		} as AtlasLifecycleContext["family"],
		...overrides,
	};
}

function defaultCoverageReview(): AtlasCoverageReview {
	return {
		version: "atlas.coverage-review.v1",
		sufficient: true,
		proposals: [],
		approvedGapCandidates: [],
		diagnostics: [],
		limitations: [],
	};
}

function makeEvidenceCard(
	sourceTitle: string,
	factCount: number,
): AtlasWriterEvidenceCard {
	const facts = Array.from(
		{ length: factCount },
		(_, i) =>
			`Evidence fact ${i + 1} from ${sourceTitle} covering retrieval quality, latency, memory residency, and production validation for regulated SaaS deployment scenarios.`,
	);
	return {
		version: "atlas.writer-evidence-card.v1",
		id: `card-${sourceTitle.replace(/\s+/g, "-").toLowerCase()}`,
		sourceTitle,
		url: `https://example.com/${sourceTitle.replace(/\s+/g, "-").toLowerCase()}`,
		authority: "official" as const,
		relevantFacts: facts,
		limitations: [
			"Evidence is limited to published benchmarks rather than identical hardware comparisons.",
			"Cost data is estimated from cloud pricing rather than self-hosted measurement.",
		],
		conflicts: [
			"Some sources disagree on optimal embedding dimension for technical documents.",
		],
		supportsSections: ["Findings", "Recommendation"],
		evidencePackIds: ["pack-1"],
		sourceRefs: [
			{
				id: `source-${sourceTitle.replace(/\s+/g, "-").toLowerCase()}`,
				kind: "web" as const,
				title: sourceTitle,
				url: `https://example.com/${sourceTitle.replace(/\s+/g, "-").toLowerCase()}`,
				authority: "accepted_web",
			},
		],
		freshnessNote: null,
	};
}

function emptyReportShapeDiagnostics(
	overrides: Partial<AtlasReportShapeDiagnostics> = {},
): AtlasReportShapeDiagnostics {
	return {
		bodyWordCount: 0,
		sourceWordCount: 0,
		totalWordCount: 0,
		sourceWordShare: 0,
		sectionCount: 0,
		substantiveSectionCount: 0,
		oneSentenceSectionCount: 0,
		claimShapedHeadingCount: 0,
		imageCount: 0,
		hasDecisionOrRecommendationSignal: false,
		warnings: [],
		...overrides,
	};
}

describe("Atlas writer prompt", () => {
	it("produces a writer prompt with the expected output contract fields", () => {
		const prompt = buildAtlasWriterPrompt(defaultWriterInput());
		const parsed = JSON.parse(prompt);

		expect(parsed.outputContract).toEqual({
			strictJson: true,
			requiredFields: [
				"generatedTitle",
				"bodyMarkdown",
				"sectionBriefs",
				"limitations",
			],
			optionalFields: ["sourceAssociations"],
		});
		expect(parsed.instructions).toContain("decision-quality");
	});

	it("keeps prompt size under 50,000 chars for a realistic 16-card scenario", () => {
		const cards = Array.from({ length: 16 }, (_, i) =>
			makeEvidenceCard(`Self-hosted embedding evidence source ${i + 1}`, 8),
		);
		const input = defaultWriterInput({
			synthesis:
				"Synthesized findings with detailed tradeoffs across retrieval quality, latency, cost, hardware fit, deployment risk, reranking support, language coverage, and maintenance boundaries for regulated SaaS deployments. ".repeat(
					20,
				),
			outline:
				"1. Executive Summary, 2. Model Shortlist, 3. Retrieval Quality, 4. Latency and Cost, 5. Deployment Implications, 6. Recommendation, 7. Limitations, 8. Evidence Gaps. ".repeat(
					20,
				),
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		expect(prompt.length).toBeLessThanOrEqual(50000);
	});

	it("truncates synthesis and outline to 2000 chars when prompt input is large", () => {
		const bigSynthesis = "A".repeat(8000);
		const bigOutline = "B".repeat(8000);
		const cards = Array.from({ length: 16 }, (_, i) =>
			makeEvidenceCard(`Source ${i + 1}`, 12),
		);

		const input = defaultWriterInput({
			synthesis: bigSynthesis,
			outline: bigOutline,
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		// Synthesis and outline should be truncated
		expect(parsed.synthesis.length).toBeLessThanOrEqual(2000);
		expect(parsed.outline.length).toBeLessThanOrEqual(2000);
		// Report intent should also have truncated versions
		expect(parsed.reportIntent.synthesis.length).toBeLessThanOrEqual(2000);
		expect(parsed.reportIntent.integratedOutline.length).toBeLessThanOrEqual(
			2000,
		);
	});

	it("caps evidence card relevantFacts at 3 per card when prompt is large", () => {
		const cards = Array.from({ length: 16 }, (_, i) =>
			makeEvidenceCard(`Evidence source ${i + 1}`, 10),
		);
		const bigSynthesis = "X".repeat(8000);

		const input = defaultWriterInput({
			synthesis: bigSynthesis,
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		for (const card of parsed.writerEvidenceCards) {
			expect(card.relevantFacts.length).toBeLessThanOrEqual(3);
		}
	});

	it("reduces coverageReview to sufficient + approvedGapCandidateCount when prompt is large", () => {
		const cards = Array.from({ length: 16 }, (_, i) =>
			makeEvidenceCard(`Evidence ${i + 1}`, 10),
		);
		const bigSynthesis = "Y".repeat(8000);
		const bigOutline = "Z".repeat(8000);

		const input = defaultWriterInput({
			synthesis: bigSynthesis,
			outline: bigOutline,
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		expect(parsed.coverageReview).toEqual({
			sufficient: true,
			approvedGapCandidateCount: 0,
		});
	});

	it("does not truncate when prompt is small enough", () => {
		const input = defaultWriterInput({
			synthesis: "Short synthesis.",
			outline: "Short outline.",
			writerEvidenceCards: [makeEvidenceCard("Single source", 4)],
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		// No truncation should happen — full values preserved
		expect(parsed.synthesis).toBe("Short synthesis.");
		expect(parsed.outline).toBe("Short outline.");
		expect(parsed.writerEvidenceCards[0].relevantFacts.length).toBe(4);
	});

	it("buildAtlasWriterImprovementPrompt includes writerImprovement fields", () => {
		const input = {
			...defaultWriterInput(),
			currentDraft: "## Draft report content",
			reportShapeDiagnostics: emptyReportShapeDiagnostics({
				warnings: [
					{
						code: "atlas_report_body_too_thin",
						message: "Report body is too thin",
					},
				],
			}),
		};

		const prompt = buildAtlasWriterImprovementPrompt(input);
		const parsed = JSON.parse(prompt);

		expect(parsed.writerImprovement).toEqual({
			pass: 1,
			maxPasses: 1,
			warningCodes: ["atlas_report_body_too_thin"],
		});
		expect(parsed.currentDraft).toBe("## Draft report content");
		expect(parsed.improvementInstructions).toContain("Do not add sources");
	});

	it("shouldImproveAtlasWriterDraft returns true for serious warning codes", () => {
		expect(
			shouldImproveAtlasWriterDraft(
				emptyReportShapeDiagnostics({
					warnings: [
						{
							code: "atlas_source_projection_dominates_report",
							message: "...",
						},
					],
				}),
			),
		).toBe(true);

		expect(
			shouldImproveAtlasWriterDraft(
				emptyReportShapeDiagnostics({
					warnings: [
						{ code: "atlas_recommendation_not_decisive", message: "..." },
					],
				}),
			),
		).toBe(true);

		expect(
			shouldImproveAtlasWriterDraft(
				emptyReportShapeDiagnostics({
					warnings: [
						{
							code: "atlas_report_underdeveloped_for_section_count",
							message: "...",
						},
					],
				}),
			),
		).toBe(true);
	});

	it("shouldImproveAtlasWriterDraft returns false for benign warnings", () => {
		expect(
			shouldImproveAtlasWriterDraft(
				emptyReportShapeDiagnostics({
					warnings: [
						{
							code: "atlas_too_many_images_for_body_size",
							message: "...",
						},
					],
				}),
			),
		).toBe(false);
	});

	it("shouldImproveAtlasWriterDraft returns true for body_too_thin with low word count and no decision signal", () => {
		expect(
			shouldImproveAtlasWriterDraft(
				emptyReportShapeDiagnostics({
					warnings: [{ code: "atlas_report_body_too_thin", message: "..." }],
					bodyWordCount: 50,
					hasDecisionOrRecommendationSignal: false,
				}),
			),
		).toBe(true);
	});

	it("shouldImproveAtlasWriterDraft returns false for body_too_thin with adequate word count", () => {
		expect(
			shouldImproveAtlasWriterDraft(
				emptyReportShapeDiagnostics({
					warnings: [{ code: "atlas_report_body_too_thin", message: "..." }],
					bodyWordCount: 100,
					hasDecisionOrRecommendationSignal: false,
				}),
			),
		).toBe(false);
	});
});
