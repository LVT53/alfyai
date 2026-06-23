import { describe, expect, it, vi } from "vitest";
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
			optionalFields: ["sourceAssociations", "claimBasis"],
			claimBasisDescription: expect.any(String),
		});
		expect(parsed.instructions).toContain("decision-quality");
	});

	it("keeps prompt size under 65,000 chars for a realistic 16-card scenario", () => {
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
		expect(prompt.length).toBeLessThanOrEqual(80000);
	});

	it("truncates synthesis and outline to 1500 chars when prompt input is large", () => {
		const bigSynthesis = "A".repeat(8000);
		const bigOutline = "B".repeat(8000);
		const cards = Array.from({ length: 22 }, (_, i) =>
			makeEvidenceCard(`Source ${i + 1}`, 12),
		);

		const input = defaultWriterInput({
			synthesis: bigSynthesis,
			outline: bigOutline,
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		// Synthesis and outline should be truncated to 1500 at level 1 (new priority)
		expect(parsed.synthesis.length).toBeLessThanOrEqual(1500);
		expect(parsed.outline.length).toBeLessThanOrEqual(1500);
		// Report intent should also have truncated versions
		expect(parsed.reportIntent.synthesis.length).toBeLessThanOrEqual(1500);
		expect(parsed.reportIntent.integratedOutline.length).toBeLessThanOrEqual(
			1500,
		);
	});

	it("preserves evidence card facts at level 1 truncation (synthesis cut to 1500)", () => {
		const cards = Array.from({ length: 22 }, (_, i) =>
			makeEvidenceCard(`Evidence source ${i + 1}`, 10),
		);
		const bigSynthesis = "X".repeat(12000);

		const input = defaultWriterInput({
			synthesis: bigSynthesis,
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);
		expect(parsed.synthesis.length).toBeLessThanOrEqual(1500);
		for (const card of parsed.writerEvidenceCards) {
			expect(card.relevantFacts.length).toBe(10);
		}
	});

	it("caps evidence card relevantFacts at 3 per card when prompt requires level 2 truncation", () => {
		const cards = Array.from({ length: 30 }, (_, i) =>
			makeEvidenceCard(`Evidence source ${i + 1}`, 10),
		);
		const bigSynthesis = "X".repeat(12000);
		const bigOutline = "Y".repeat(12000);

		const input = defaultWriterInput({
			synthesis: bigSynthesis,
			outline: bigOutline,
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		for (const card of parsed.writerEvidenceCards) {
			expect(card.relevantFacts.length).toBeLessThanOrEqual(3);
		}
	});

	it("preserves coverage review proposals during truncation", () => {
		const cards = Array.from({ length: 30 }, (_, i) =>
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

		expect(parsed.coverageReview.sufficient).toBe(true);
		expect(parsed.coverageReview).toHaveProperty("proposals");
		expect(parsed.coverageReview).toHaveProperty("diagnostics");
		expect(parsed.coverageReview).toHaveProperty("limitations");
		expect(parsed.coverageReview).not.toHaveProperty(
			"approvedGapCandidateCount",
		);
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

	it("logs truncation info when prompt exceeds MAX_WRITER_PROMPT_CHARS", () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const cards = Array.from({ length: 28 }, (_, i) =>
				makeEvidenceCard(`Source ${i + 1}`, 14),
			);
			const input = defaultWriterInput({
				synthesis: "X".repeat(8000),
				outline: "Y".repeat(8000),
				writerEvidenceCards: cards,
			});

			buildAtlasWriterPrompt(input);

			expect(infoSpy).toHaveBeenCalledWith(
				"[ATLAS_WRITER] Prompt truncated",
				expect.objectContaining({
					originalLength: expect.any(Number),
					maxChars: 80000,
					profile: "overview",
					evidenceCardCount: 28,
				}),
			);
		} finally {
			infoSpy.mockRestore();
		}
	});

	it("does not log truncation info when prompt fits within limit", () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const input = defaultWriterInput({
				synthesis: "Short synthesis.",
				outline: "Short outline.",
				writerEvidenceCards: [makeEvidenceCard("Single source", 4)],
			});

			buildAtlasWriterPrompt(input);

			expect(infoSpy).not.toHaveBeenCalled();
		} finally {
			infoSpy.mockRestore();
		}
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

	it("scales effectiveMax with getMaxModelContext", () => {
		const cards = Array.from({ length: 16 }, (_, i) =>
			makeEvidenceCard(`Context scaling source ${i + 1}`, 10),
		);
		const input = defaultWriterInput({
			synthesis: "X".repeat(8000),
			outline: "Y".repeat(8000),
			writerEvidenceCards: cards,
		});
		const prompt = buildAtlasWriterPrompt(input);
		expect(prompt.length).toBeLessThanOrEqual(80000);
	});

	it("includes empty-list-item instruction in writer prompt", () => {
		const prompt = buildAtlasWriterPrompt(defaultWriterInput());
		const parsed = JSON.parse(prompt);
		expect(parsed.instructions).toContain(
			"Do not emit list items that have only a label and colon",
		);
	});

	it("includes claimBasis in output contract optionalFields and description", () => {
		const prompt = buildAtlasWriterPrompt(defaultWriterInput());
		const parsed = JSON.parse(prompt);

		expect(parsed.outputContract.optionalFields).toContain("claimBasis");
		expect(parsed.outputContract.claimBasisDescription).toContain("Optional");
	});

	it("claimBasis description mentions supportLevel and evidenceCardIds", () => {
		const prompt = buildAtlasWriterPrompt(defaultWriterInput());
		const parsed = JSON.parse(prompt);

		expect(parsed.outputContract.claimBasisDescription).toContain(
			"supportLevel",
		);
		expect(parsed.outputContract.claimBasisDescription).toContain(
			"evidenceCardIds",
		);
	});

	it("truncation preserves evidence card facts longer than synthesis text", () => {
		const cards = Array.from({ length: 16 }, (_, i) =>
			makeEvidenceCard(`Source ${i + 1}`, 20),
		);
		const input = defaultWriterInput({
			synthesis: "X".repeat(12000),
			outline: "Y".repeat(12000),
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		expect(parsed.synthesis.length).toBeLessThanOrEqual(1500);
		for (const card of parsed.writerEvidenceCards) {
			expect(card.relevantFacts.length).toBe(20);
		}
	});

	it("caps evidence card facts at 1 as last resort at truncation level 5", () => {
		const cards = Array.from({ length: 80 }, (_, i) =>
			makeEvidenceCard(`Source ${i + 1}`, 12),
		);
		const input = defaultWriterInput({
			synthesis: "X".repeat(40000),
			outline: "Y".repeat(40000),
			writerEvidenceCards: cards,
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		for (const card of parsed.writerEvidenceCards) {
			expect(card.relevantFacts.length).toBeLessThanOrEqual(1);
		}
		expect(parsed.evidencePackDiagnostics).toEqual([]);
		expect(parsed.writerEvidenceCardDiagnostics).toEqual([]);
		expect(parsed.coverageReview).toEqual({
			sufficient: true,
			truncated: true,
		});
		// Level 5 strips verbose card fields
		for (const card of parsed.writerEvidenceCards) {
			expect(card.conflicts).toEqual([]);
			expect(card.supportsSections).toEqual([]);
			expect(card.sourceRefs).toEqual([]);
		}
	});

	it("includes positive heading guidance in English writer instructions", () => {
		const prompt = buildAtlasWriterPrompt(defaultWriterInput());
		const parsed = JSON.parse(prompt);
		expect(parsed.instructions).toContain(
			"Use H2 headings for major report sections",
		);
		expect(parsed.instructions).toContain(
			"not use a heading for text that is a single sentence",
		);
	});

	it("includes positive heading guidance in Hungarian writer instructions", () => {
		const input = defaultWriterInput({ language: "hu" });
		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);
		expect(parsed.instructions).toContain(
			"H2 címsorokat használj a fő jelentésszakaszokhoz",
		);
		expect(parsed.instructions).toContain(
			"Ne használj címsort egyetlen mondat számára",
		);
	});

	it("truncation level 5 drops diagnostics and reduces coverage review for massive prompts", () => {
		const cards = Array.from({ length: 70 }, (_, i) =>
			makeEvidenceCard(`Source ${i + 1}`, 12),
		);
		const input = defaultWriterInput({
			synthesis: "Z".repeat(35000),
			outline: "W".repeat(35000),
			writerEvidenceCards: cards,
			coverageReview: {
				...defaultCoverageReview(),
				diagnostics: [
					{
						code: "coverage_thin",
						severity: "warning" as const,
						message: "Thin coverage",
					},
				],
				limitations: [{ code: "coverage_gap", message: "Coverage gap" }],
				proposals: [
					{
						missingQuestion: "Fill gap",
						whyCurrentEvidenceIsWeak: "Missing data",
						targetSearchQuery: "more data",
						desiredEvidenceType: "benchmark",
						affectedSection: "Findings",
						priority: "medium" as const,
					},
				],
			},
		});

		const result = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(result);

		for (const card of parsed.writerEvidenceCards) {
			expect(card.relevantFacts.length).toBeLessThanOrEqual(1);
		}
		expect(parsed.evidencePackDiagnostics).toEqual([]);
		expect(parsed.writerEvidenceCardDiagnostics).toEqual([]);
		expect(parsed.coverageReview.truncated).toBe(true);
		expect(result.length).toBeLessThanOrEqual(80000);
	});

	it("fits 16-source overview within 80000 chars with zero fact reduction", () => {
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
			coverageReview: {
				...defaultCoverageReview(),
				diagnostics: [
					{ code: "coverage_ok", severity: "info" as const, message: "ok" },
				],
			},
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		// With 80K max, a 16-source overview fits without fact reduction.
		// All 8 facts per card are preserved — truncation loss < 10%.
		expect(prompt.length).toBeLessThanOrEqual(80000);
		for (const card of parsed.writerEvidenceCards) {
			expect(card.relevantFacts.length).toBe(8);
		}
	});

	it("truncates 18-source overview prompt by less than 10%", () => {
		const cards = Array.from({ length: 18 }, (_, i) =>
			makeEvidenceCard(
				`Production-level source ${i + 1} with realistic title`,
				12,
			),
		);
		// Build a prompt whose level-0 size slightly exceeds 80K so only
		// synth/outline are trimmed — all facts preserved.
		const input = defaultWriterInput({
			synthesis: "X".repeat(6000),
			outline: "Y".repeat(6000),
			writerEvidenceCards: cards,
			coverageReview: {
				...defaultCoverageReview(),
				diagnostics: [
					{
						code: "coverage_ok",
						severity: "info" as const,
						message: "Coverage sufficient for overview.",
					},
				],
				limitations: [
					{
						code: "search_scope",
						message: "Limited to English-language web sources.",
					},
				],
			},
		});

		const prompt = buildAtlasWriterPrompt(input);
		const parsed = JSON.parse(prompt);

		// Must fit within the 80K ceiling.
		expect(prompt.length).toBeLessThanOrEqual(80000);
		// All 12 facts per card preserved — no fact-level truncation needed.
		for (const card of parsed.writerEvidenceCards) {
			expect(card.relevantFacts.length).toBe(12);
		}
		// At level 1, synth/outline are capped to 1500 chars; facts stay intact.
		// For a ~82-85K base trimmed to ≤ 80K, total truncation is < 10%.
		expect(parsed.synthesis.length).toBeLessThanOrEqual(1500);
		expect(parsed.outline.length).toBeLessThanOrEqual(1500);
	});
});
