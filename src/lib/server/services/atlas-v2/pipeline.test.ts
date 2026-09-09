import { describe, expect, it, vi } from "vitest";
import type { AtlasPipelineJobContext } from "../atlas/types";
import {
	atlasPipelineVersionForNewJob,
	getAtlasV2ProfileConfig,
	resolveAtlasPipelineVersion,
} from "./config";
import {
	buildAtlasV2CompressedFindings,
	buildAtlasV2CuratedSourcePool,
	extractAtlasV2LifecycleSeed,
} from "./lifecycle-seed";
import {
	questionConfidences,
	readAtlasV2ResumeState,
	runAtlasV2Pipeline,
} from "./pipeline";
import type { AtlasV2ResearchWebRunner } from "./research-web-adapter";
import {
	ATLAS_V2_CHECKPOINT_SCHEMA_VERSION,
	type AtlasV2EvidenceIndex,
	type AtlasV2Plan,
	type AtlasV2Usage,
} from "./types";

const NOW = new Date("2026-09-08T00:00:00.000Z");

const ZERO_USAGE: AtlasV2Usage = {
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	costUsdMicros: 0,
};

function job(
	overrides: Partial<AtlasPipelineJobContext> = {},
): AtlasPipelineJobContext {
	return {
		id: "job-1",
		userId: "user-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "overview",
		title: "EU solar capacity in 2026",
		query: "How much solar capacity did the EU add in 2026?",
		lifecycle: {
			family: {
				familyId: "job-1",
				mode: "new_family",
				action: "create",
				rootAtlasJobId: "job-1",
				currentAtlasJobId: "job-1",
				parentAtlasJobId: null,
				forkedFromAtlasJobId: null,
			},
			seed: null,
		},
		...overrides,
	};
}

const PLAN_JSON = JSON.stringify({
	questions: [
		"How much solar capacity did the EU add in 2026?",
		"What did the regulator require in 2026?",
		"Which member states led the additions?",
		"What is the grid connection queue?",
	],
	sections: [
		{ title: "Capacity added", brief: "How much", questions: [1, 3] },
		{ title: "Rules and queues", brief: "What governs it", questions: [2, 4] },
	],
});

const SECTION_JSON = JSON.stringify({
	paragraphs: [
		{
			sentences: [
				{ text: "The union added 8 GW of solar capacity.", citations: [1] },
				{
					text: "Taken together, the picture is one of steady growth.",
					citations: [],
					inferred: true,
				},
			],
		},
	],
});

const SUMMARY_JSON = JSON.stringify({
	paragraphs: [
		{
			sentences: [
				{ text: "The union added 8 GW of solar capacity.", citations: [1] },
			],
		},
	],
});

function researchWeb(): AtlasV2ResearchWebRunner {
	return vi.fn(async () => ({
		sources: [
			{
				url: "https://iea.org/reports/solar-2026",
				title: "Solar market update 2026",
				snippets: [
					"The European Union added 8,000 MW of new solar capacity in 2026 according to the tracker.",
				],
				publishedAt: "2026-06-01",
				pageExcerpt: null,
			},
			{
				url: "https://irena.org/statistics/permitting",
				title: "Permitting timelines across the union",
				snippets: [
					"Grid connection permits in the union now take eighteen months on average, the review found.",
				],
				publishedAt: "2026-05-20",
				pageExcerpt: null,
			},
			{
				url: "https://old.example/report",
				title: "301 Moved Permanently",
				snippets: ["The document has moved here."],
				publishedAt: null,
				pageExcerpt: null,
			},
		],
		pagesRead: 1,
		cached: false,
	}));
}

function modelDeps() {
	const runControlModel = vi.fn(
		async ({ stage }: { stage: string; system: string; prompt: string }) => ({
			text: stage === "plan" ? PLAN_JSON : JSON.stringify({ sufficient: true }),
			usage: {
				...ZERO_USAGE,
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
			},
		}),
	);
	const runWriterModel = vi.fn(
		async ({ stage }: { stage: string; system: string; prompt: string }) => ({
			text: stage === "summary" ? SUMMARY_JSON : SECTION_JSON,
			usage: {
				...ZERO_USAGE,
				inputTokens: 20,
				outputTokens: 8,
				totalTokens: 28,
			},
		}),
	);
	return { runControlModel, runWriterModel };
}

describe("runAtlasV2Pipeline", () => {
	it("runs the six stages, checkpoints each, and renders one document", async () => {
		const { runControlModel, runWriterModel } = modelDeps();
		const heartbeat = vi.fn(
			async (_input: {
				stage: string;
				progressPercent: number;
				progressDetails?: unknown;
			}) => {},
		);
		const writeCheckpoint = vi.fn(
			async (_input: { stage: string; checkpoint: unknown }) => {},
		);
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-1",
			htmlChatGeneratedFileId: "html-1",
			pdfChatGeneratedFileId: "pdf-1",
			markdownChatGeneratedFileId: "md-1",
		}));
		const setAssistantMessageContent = vi.fn(async () => {});

		const result = await runAtlasV2Pipeline({
			job: job(),
			now: NOW,
			dependencies: {
				researchWeb: researchWeb(),
				runControlModel,
				runWriterModel,
				heartbeat,
				writeCheckpoint,
				renderOutputs,
				setAssistantMessageContent,
				profileOverrides: { questions: 4, rounds: 1 },
			},
		});

		expect(result).toMatchObject({
			status: "succeeded",
			stage: "render",
			pipelineVersion: 2,
			outputs: {
				htmlChatGeneratedFileId: "html-1",
				pdfChatGeneratedFileId: "pdf-1",
				markdownChatGeneratedFileId: "md-1",
			},
		});
		// Two distinct articles survive; the four 301 stubs and the repeat hits
		// for the same canonical URLs are all filtered away.
		expect(result.sourceCounts.web).toBe(2);
		expect(result.verification.filteredCount).toBe(10);
		expect(renderOutputs).toHaveBeenCalledTimes(1);

		const phases = heartbeat.mock.calls.map(([call]) => call.stage);
		expect(phases).toEqual([
			"plan",
			"research",
			"index",
			"write",
			"verify",
			"verify",
			"render",
		]);
		const checkpointPhases = writeCheckpoint.mock.calls.map(
			([call]) => (call.checkpoint as { phase: string; schema: string }).phase,
		);
		expect(checkpointPhases).toEqual([
			"plan",
			"research",
			"index",
			"write",
			"verify",
			"render",
		]);
		expect(
			(writeCheckpoint.mock.calls[0][0].checkpoint as { schema: string })
				.schema,
		).toBe(ATLAS_V2_CHECKPOINT_SCHEMA_VERSION);
	});

	it("puts the executive summary on the assistant message", async () => {
		const { runControlModel, runWriterModel } = modelDeps();
		const setAssistantMessageContent = vi.fn(async () => {});
		const result = await runAtlasV2Pipeline({
			job: job(),
			now: NOW,
			dependencies: {
				researchWeb: researchWeb(),
				runControlModel,
				runWriterModel,
				writeCheckpoint: async () => {},
				renderOutputs: async () => ({
					fileProductionJobId: null,
					htmlChatGeneratedFileId: null,
					pdfChatGeneratedFileId: null,
					markdownChatGeneratedFileId: null,
				}),
				setAssistantMessageContent,
				profileOverrides: { questions: 4, rounds: 1 },
			},
		});
		expect(result.executiveSummaryMarkdown).toContain("8 GW");
		expect(result.executiveSummaryMarkdown).toContain("[1]");
		expect(setAssistantMessageContent).toHaveBeenCalledWith({
			messageId: "assistant-1",
			content: result.executiveSummaryMarkdown,
		});
	});

	it("writes one section per outline entry, in parallel", async () => {
		const { runControlModel, runWriterModel } = modelDeps();
		await runAtlasV2Pipeline({
			job: job(),
			now: NOW,
			dependencies: {
				researchWeb: researchWeb(),
				runControlModel,
				runWriterModel,
				writeCheckpoint: async () => {},
				renderOutputs: async () => ({
					fileProductionJobId: null,
					htmlChatGeneratedFileId: null,
					pdfChatGeneratedFileId: null,
					markdownChatGeneratedFileId: null,
				}),
				profileOverrides: { questions: 4, rounds: 1 },
			},
		});
		const sectionCalls = runWriterModel.mock.calls
			.map(([call]) => call.stage)
			.filter((stage) => stage.startsWith("write:"));
		expect(sectionCalls).toEqual(["write:s1", "write:s2"]);
	});

	it("runs a coverage check between rounds and researches only thin questions", async () => {
		const runControlModel = vi.fn(
			async ({ stage }: { stage: string; system: string; prompt: string }) => ({
				text:
					stage === "plan"
						? PLAN_JSON
						: JSON.stringify({
								thin: [{ id: "q2", queries: ["regulator solar rules"] }],
								sufficient: false,
							}),
				usage: ZERO_USAGE,
			}),
		);
		const runWriterModel = vi.fn(
			async ({ stage }: { stage: string; system: string; prompt: string }) => ({
				text: stage === "summary" ? SUMMARY_JSON : SECTION_JSON,
				usage: ZERO_USAGE,
			}),
		);
		const research = researchWeb();
		await runAtlasV2Pipeline({
			job: job(),
			now: NOW,
			dependencies: {
				researchWeb: research,
				runControlModel,
				runWriterModel,
				writeCheckpoint: async () => {},
				renderOutputs: async () => ({
					fileProductionJobId: null,
					htmlChatGeneratedFileId: null,
					pdfChatGeneratedFileId: null,
					markdownChatGeneratedFileId: null,
				}),
				profileOverrides: { questions: 4, rounds: 2 },
			},
		});
		expect(runControlModel.mock.calls.map(([call]) => call.stage)).toEqual([
			"plan",
			"coverage",
		]);
		// Round 1 researched all four questions; round 2 only the thin one.
		expect(research).toHaveBeenCalledTimes(5);
	});

	it("fails with a clear code when every source was junk", async () => {
		const { runControlModel, runWriterModel } = modelDeps();
		await expect(
			runAtlasV2Pipeline({
				job: job(),
				now: NOW,
				dependencies: {
					researchWeb: async () => ({
						sources: [
							{
								url: "https://www.linkedin.com/company/solar",
								title: "Solar | LinkedIn",
								snippets: ["A company page with 4,000 followers listed."],
								publishedAt: null,
								pageExcerpt: null,
							},
						],
						pagesRead: 0,
						cached: false,
					}),
					runControlModel,
					runWriterModel,
					writeCheckpoint: async () => {},
					renderOutputs: async () => ({
						fileProductionJobId: null,
						htmlChatGeneratedFileId: null,
						pdfChatGeneratedFileId: null,
						markdownChatGeneratedFileId: null,
					}),
					profileOverrides: { questions: 4, rounds: 1 },
				},
			}),
		).rejects.toThrow(/no usable sources/i);
	});

	it("resumes from the checkpoints instead of re-planning and re-searching", async () => {
		const { runControlModel, runWriterModel } = modelDeps();
		const plan: AtlasV2Plan = {
			questions: [{ id: "q1", question: "How much was added?" }],
			sections: [
				{ id: "s1", title: "Capacity", brief: "How much", questionIds: ["q1"] },
			],
		};
		const research = researchWeb();
		await runAtlasV2Pipeline({
			job: job(),
			now: NOW,
			dependencies: {
				researchWeb: research,
				runControlModel,
				runWriterModel,
				writeCheckpoint: async () => {},
				loadCheckpoints: async () => [
					{
						roundNumber: 1,
						checkpoint: {
							schema: ATLAS_V2_CHECKPOINT_SCHEMA_VERSION,
							phase: "plan",
							data: { plan },
						},
					},
					{
						roundNumber: 2,
						checkpoint: {
							schema: ATLAS_V2_CHECKPOINT_SCHEMA_VERSION,
							phase: "research",
							data: {
								round: 1,
								rawSources: [
									{
										questionId: "q1",
										round: 1,
										url: "https://iea.org/reports/solar-2026",
										title: "Solar market update 2026",
										snippets: [
											"The European Union added 8,000 MW of new solar capacity in 2026.",
										],
										publishedAt: "2026-06-01",
										pageExcerpt: null,
									},
								],
							},
						},
					},
				],
				renderOutputs: async () => ({
					fileProductionJobId: null,
					htmlChatGeneratedFileId: null,
					pdfChatGeneratedFileId: null,
					markdownChatGeneratedFileId: null,
				}),
				profileOverrides: { questions: 4, rounds: 1 },
			},
		});
		expect(research).not.toHaveBeenCalled();
		expect(runControlModel).not.toHaveBeenCalled();
		expect(runWriterModel.mock.calls.map(([call]) => call.stage)).toEqual([
			"write:s1",
			"summary",
		]);
	});
});

describe("readAtlasV2ResumeState", () => {
	it("ignores a checkpoint from another schema", () => {
		expect(
			readAtlasV2ResumeState([
				{
					roundNumber: 1,
					checkpoint: { schema: "atlas.other", phase: "plan" },
				},
				{ roundNumber: 2, checkpoint: "nonsense" },
			]),
		).toEqual({});
	});

	it("takes the latest research checkpoint's cumulative sources", () => {
		const state = readAtlasV2ResumeState([
			{
				roundNumber: 3,
				checkpoint: {
					schema: ATLAS_V2_CHECKPOINT_SCHEMA_VERSION,
					phase: "research",
					data: { round: 2, rawSources: [{ url: "b" }] },
				},
			},
			{
				roundNumber: 2,
				checkpoint: {
					schema: ATLAS_V2_CHECKPOINT_SCHEMA_VERSION,
					phase: "research",
					data: { round: 1, rawSources: [{ url: "a" }] },
				},
			},
		]);
		expect(state.completedRounds).toBe(2);
		expect(state.rawSources).toEqual([{ url: "b" }]);
	});
});

describe("pipeline selection", () => {
	it("prefers the version stamped on the row over the current flag", () => {
		expect(
			resolveAtlasPipelineVersion({ stampedPipelineVersion: 1, flag: "v2" }),
		).toBe(1);
		expect(
			resolveAtlasPipelineVersion({ stampedPipelineVersion: 2, flag: "v1" }),
		).toBe(2);
	});

	it("falls back to the flag for a row with no stamp", () => {
		expect(resolveAtlasPipelineVersion({ flag: "v2" })).toBe(2);
		expect(resolveAtlasPipelineVersion({ flag: "v1" })).toBe(1);
		expect(resolveAtlasPipelineVersion({})).toBe(1);
	});

	it("keeps a lifecycle child on its parent's pipeline", () => {
		expect(
			atlasPipelineVersionForNewJob({ flag: "v2", parentPipelineVersion: 1 }),
		).toBe(1);
		expect(
			atlasPipelineVersionForNewJob({ flag: "v1", parentPipelineVersion: 2 }),
		).toBe(2);
		expect(
			atlasPipelineVersionForNewJob({
				flag: "v2",
				parentPipelineVersion: null,
			}),
		).toBe(2);
	});
});

describe("getAtlasV2ProfileConfig", () => {
	it("gives each profile its own question count, rounds and read depth", () => {
		const overview = getAtlasV2ProfileConfig("overview", {
			questions: 6,
			rounds: 1,
		});
		const inDepth = getAtlasV2ProfileConfig("in-depth", {
			questions: 10,
			rounds: 2,
		});
		const exhaustive = getAtlasV2ProfileConfig("exhaustive", {
			questions: 16,
			rounds: 3,
		});
		expect(overview).toMatchObject({
			questions: 6,
			rounds: 1,
			readPages: 2,
			maxIndexedSources: 20,
			contradictionHuntOnLastRound: false,
		});
		expect(inDepth).toMatchObject({
			questions: 10,
			rounds: 2,
			readPages: 3,
			maxIndexedSources: 40,
		});
		expect(exhaustive).toMatchObject({
			questions: 16,
			rounds: 3,
			readPages: 4,
			maxIndexedSources: 80,
			contradictionHuntOnLastRound: true,
		});
	});

	it("never renders images on any profile", () => {
		for (const profile of ["overview", "in-depth", "exhaustive"] as const) {
			expect(getAtlasV2ProfileConfig(profile).allowImages).toBe(false);
		}
	});

	it("clamps an absurd override into the bounded band", () => {
		expect(
			getAtlasV2ProfileConfig("overview", { questions: 400, rounds: 40 }),
		).toMatchObject({ questions: 20, rounds: 4 });
		expect(
			getAtlasV2ProfileConfig("overview", { questions: 1, rounds: 0 }),
		).toMatchObject({ questions: 4, rounds: 1 });
	});
});

describe("lifecycle seeding on v2", () => {
	const plan: AtlasV2Plan = {
		questions: [{ id: "q1", question: "How much was added?" }],
		sections: [
			{ id: "s1", title: "Capacity", brief: "How much", questionIds: ["q1"] },
		],
	};
	const index: AtlasV2EvidenceIndex = {
		sources: [
			{
				n: 1,
				canonicalUrl: "https://iea.org/a",
				host: "iea.org",
				organisation: "iea",
				title: "Solar update",
				date: "2026-06-01",
				snippets: ["Capacity reached 8 GW."],
				pageExcerpt: null,
				questionIds: ["q1"],
			},
		],
		dropped: [],
		filteredCount: 2,
		byQuestion: { q1: [1] },
	};

	it("round-trips the plan and the evidence index through a checkpoint", () => {
		const seed = extractAtlasV2LifecycleSeed({
			family: {
				familyId: "root",
				mode: "same_family",
				action: "continue",
				rootAtlasJobId: "root",
				currentAtlasJobId: "child",
				parentAtlasJobId: "root",
				forkedFromAtlasJobId: null,
			},
			seed: {
				parentAtlasJobId: "root",
				compressedFindings: buildAtlasV2CompressedFindings({
					plan,
					query: "How much solar?",
				}),
				curatedSourcePool: buildAtlasV2CuratedSourcePool(index),
				checkpoint: {},
				documentSourceSummary: {},
			},
		});
		expect(seed).toMatchObject({
			parentAtlasJobId: "root",
			questions: ["How much was added?"],
			sections: ["Capacity"],
		});
		expect(seed?.evidenceIndex?.sources[0].host).toBe("iea.org");
		expect(seed?.evidenceIndex?.byQuestion).toEqual({ q1: [1] });
	});

	it("returns null for a parent that ran on v1", () => {
		expect(
			extractAtlasV2LifecycleSeed({
				family: {
					familyId: "root",
					mode: "same_family",
					action: "continue",
					rootAtlasJobId: "root",
					currentAtlasJobId: "child",
					parentAtlasJobId: "root",
					forkedFromAtlasJobId: null,
				},
				seed: {
					parentAtlasJobId: "root",
					// v1's shape: evidence packs, not a v2 plan.
					compressedFindings: { evidencePacks: [] },
					curatedSourcePool: { web: [] },
					checkpoint: {},
					documentSourceSummary: {},
				},
			}),
		).toBeNull();
	});

	it("seeds the plan prompt and merges the parent's sources on a Continue", async () => {
		const { runControlModel, runWriterModel } = modelDeps();
		const research = researchWeb();
		const result = await runAtlasV2Pipeline({
			job: job({
				action: "continue",
				parentAtlasJobId: "root",
				lifecycle: {
					family: {
						familyId: "root",
						mode: "same_family",
						action: "continue",
						rootAtlasJobId: "root",
						currentAtlasJobId: "job-1",
						parentAtlasJobId: "root",
						forkedFromAtlasJobId: null,
					},
					seed: {
						parentAtlasJobId: "root",
						compressedFindings: buildAtlasV2CompressedFindings({
							plan,
							query: "How much solar?",
						}),
						curatedSourcePool: buildAtlasV2CuratedSourcePool({
							...index,
							sources: [
								{
									...index.sources[0],
									canonicalUrl: "https://irena.org/parent-report",
									host: "irena.org",
									organisation: "irena",
									title: "Parent report on capacity",
								},
							],
						}),
						checkpoint: {},
						documentSourceSummary: {},
					},
				},
			}),
			now: NOW,
			dependencies: {
				researchWeb: research,
				runControlModel,
				runWriterModel,
				writeCheckpoint: async () => {},
				renderOutputs: async () => ({
					fileProductionJobId: null,
					htmlChatGeneratedFileId: null,
					pdfChatGeneratedFileId: null,
					markdownChatGeneratedFileId: null,
				}),
				profileOverrides: { questions: 4, rounds: 1 },
			},
		});
		const planPrompt = JSON.parse(runControlModel.mock.calls[0][0].prompt);
		expect(planPrompt.parentQuestions).toEqual(["How much was added?"]);
		expect(planPrompt.parentSections).toEqual(["Capacity"]);
		// The parent's source joins the two fresh ones in the index.
		expect(result.sourceCounts.web).toBe(3);
	});
});

describe("questionConfidences", () => {
	it("is thin with no sources, and mixed when the levels differ", () => {
		const confidences = questionConfidences({
			index: {
				sources: [],
				dropped: [],
				filteredCount: 0,
				byQuestion: { q1: [], q2: [1, 2] },
			},
			verification: {
				sections: [
					{
						sectionId: "s1",
						title: "S",
						paragraphs: [
							[
								{
									sectionId: "s1",
									text: "a",
									citations: [1],
									confidence: "corroborated",
									failures: [],
									kept: true,
									rewritten: false,
								},
								{
									sectionId: "s1",
									text: "b",
									citations: [2],
									confidence: "single",
									failures: [],
									kept: true,
									rewritten: false,
								},
							],
						],
					},
				],
				totals: { corroborated: 1, single: 1, inferred: 0, cut: 0 },
				contradictions: [],
				staleCitations: [],
				citedSourceNumbers: [1, 2],
				entailmentCallCount: 0,
			},
		});
		expect(confidences).toEqual({ q1: "thin", q2: "mixed" });
	});
});
