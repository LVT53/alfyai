// The Atlas v2 content pipeline (ADR 0062).
//
// Six stages, each a durable checkpoint, each cancellable through the existing
// heartbeat (the worker's heartbeat throws when the job is no longer running).
// The job infrastructure below this module — ledger, claiming, heartbeats,
// checkpoints, cancel, idempotent kickoff, lifecycle, analytics, file
// production — is v1's, unchanged.

import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import {
	detectLanguage,
	type SupportedLanguage,
} from "$lib/server/services/language";
import type { AtlasOutputIds } from "../atlas/renderer-output";
import type { AtlasPipelineJobContext } from "../atlas/types";
import {
	atlasV2SectionWriterBudget,
	bodyWordBudget,
	capAtlasV2SectionsToWordBudget,
	citedNumbersInSections,
	countWords,
} from "./budget";
import {
	ATLAS_V2_COVERAGE_SUFFICIENT_SOURCES,
	getAtlasV2EntailmentBatchSize,
	getAtlasV2ProfileConfig,
	getAtlasV2StaleMonths,
	getAtlasV2WriterConcurrency,
} from "./config";
import {
	buildAtlasV2EvidenceIndex,
	capAtlasV2EvidenceIndex,
	mergeAtlasV2EvidenceIndexes,
} from "./evidence-index";
import {
	buildAtlasV2CompressedFindings,
	buildAtlasV2CuratedSourcePool,
	extractAtlasV2LifecycleSeed,
} from "./lifecycle-seed";
import { dropRepeatedAtlasV2Sentences } from "./novelty";
import {
	ATLAS_V2_PLAN_SYSTEM,
	buildAtlasV2PlanPrompt,
	coreQuestionFromQuery,
	deterministicAtlasV2Title,
	fallbackAtlasV2Plan,
	parseAtlasV2Plan,
} from "./plan";
import {
	ATLAS_V2_PHASE_PROGRESS,
	buildAtlasV2ProgressDetails,
	buildAtlasV2ProgressEvidence,
} from "./progress";
import {
	buildAtlasV2DocumentSource,
	buildAtlasV2ExecutiveSummaryMarkdown,
	publishSentenceCitations,
	renumberAtlasV2ForPublication,
} from "./render";
import {
	ATLAS_V2_COVERAGE_SYSTEM,
	buildAtlasV2CoveragePrompt,
	deterministicallyThinQuestionIds,
	mapWithConcurrency,
	parseAtlasV2CoverageReview,
	runAtlasV2ResearchRound,
} from "./research";
import type { AtlasV2ResearchWebRunner } from "./research-web-adapter";
import type { AtlasV2Phase, AtlasV2Usage } from "./types";
import {
	ATLAS_V2_CHECKPOINT_SCHEMA_VERSION,
	type AtlasV2EvidenceIndex,
	type AtlasV2IndexedSource,
	AtlasV2PipelineError,
	type AtlasV2PipelineResult,
	type AtlasV2Plan,
	type AtlasV2ProgressEvidence,
	type AtlasV2QuestionConfidence,
	type AtlasV2RawSource,
	type AtlasV2VerificationResult,
	type AtlasV2VerifiedSection,
	type AtlasV2WrittenSection,
} from "./types";
import {
	ATLAS_V2_ENTAILMENT_BATCH_SYSTEM,
	ATLAS_V2_ENTAILMENT_SYSTEM,
	type AtlasV2EntailmentRequest,
	buildAtlasV2EntailmentBatchPrompt,
	buildAtlasV2EntailmentPrompt,
	checkAtlasV2CoreAnswer,
	parseAtlasV2EntailmentAnswer,
	parseAtlasV2EntailmentBatchAnswer,
	verifyAtlasV2Report,
} from "./verify";
import {
	ATLAS_V2_REWRITE_SYSTEM,
	ATLAS_V2_SECTION_LEAD_SYSTEM,
	ATLAS_V2_SUMMARY_SYSTEM,
	ATLAS_V2_WRITER_SYSTEM,
	buildAtlasV2RewritePrompt,
	buildAtlasV2SectionLeadPrompt,
	buildAtlasV2SectionPrompt,
	buildAtlasV2SummaryPrompt,
	buildWriterEvidenceEntries,
	parseAtlasV2SectionLead,
	parseAtlasV2WrittenSection,
} from "./writer";

/** Checkpoint `roundNumber` per phase, so a resume can find the latest. */
const CHECKPOINT_ROUND: Record<Exclude<AtlasV2Phase, "research">, number> = {
	plan: 1,
	index: 10,
	write: 11,
	verify: 12,
	render: 13,
};
const RESEARCH_CHECKPOINT_BASE = 1;

/** Bounded parallelism for the per-section writer calls. */
const DEFAULT_WRITER_CONCURRENCY = 5;
/** Section sentences the executive-summary prompt carries, per section. */
const SUMMARY_SENTENCES_PER_SECTION = 16;

export type AtlasV2ModelCall = (input: {
	stage: string;
	system: string;
	prompt: string;
}) => Promise<{
	text: string;
	finishReason?: string | null;
	usage: AtlasV2Usage;
}>;

export interface RunAtlasV2PipelineInput {
	job: AtlasPipelineJobContext;
	now?: Date;
	dependencies: {
		/** The harness's research_web path; see research-web-adapter.ts. */
		researchWeb: AtlasV2ResearchWebRunner;
		/** Plan and coverage: the control model. */
		runControlModel: AtlasV2ModelCall;
		/** Sections, executive summary and rewrites: the synthesis model. */
		runWriterModel: AtlasV2ModelCall;
		/**
		 * Entailment checks: the audit model, batched at
		 * `ATLAS_V2_ENTAILMENT_BATCH` claims per call with a one-claim fallback.
		 */
		runAuditModel?: AtlasV2ModelCall;
		/** Arithmetic, through the same sandbox run_python uses. */
		runPython?: (input: {
			expression: string;
		}) => Promise<{ ok: boolean; value: string | null }>;
		heartbeat?: (input: {
			stage: string;
			progressPercent: number;
			progressDetails?: unknown;
		}) => Promise<void>;
		writeCheckpoint: (input: {
			jobId: string;
			roundNumber: number;
			stage: string;
			checkpoint: unknown;
			curatedSourcePool: unknown;
			compressedFindings: unknown;
			usage: AtlasV2Usage;
			qualityDiagnostics: unknown;
			documentSourceSummary: unknown;
		}) => Promise<void>;
		/** Present when the job is resuming after a worker restart. */
		loadCheckpoints?: (
			jobId: string,
		) => Promise<Array<{ roundNumber: number; checkpoint: unknown }>>;
		applyGeneratedTitle?: (input: {
			jobId: string;
			title: string;
		}) => Promise<void>;
		renderOutputs: (source: GeneratedDocumentSource) => Promise<AtlasOutputIds>;
		/** Sets the linked assistant message's content to the summary. */
		setAssistantMessageContent?: (input: {
			messageId: string;
			content: string;
		}) => Promise<void>;
		searchConcurrency?: number;
		writerConcurrency?: number;
		/** Test/eval overrides for the per-profile question and round counts. */
		profileOverrides?: { questions?: number; rounds?: number };
	};
}

const ZERO_USAGE: AtlasV2Usage = {
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	costUsdMicros: 0,
};

function addUsage(total: AtlasV2Usage, next: AtlasV2Usage): AtlasV2Usage {
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		totalTokens: total.totalTokens + next.totalTokens,
		costUsdMicros: total.costUsdMicros + next.costUsdMicros,
	};
}

function isoDate(now: Date): string {
	return now.toISOString().slice(0, 10);
}

// Both knobs read the env config, which is not initialised in every unit-test
// process; the constants are the honest fallback.
function safeWriterConcurrency(): number {
	try {
		return getAtlasV2WriterConcurrency();
	} catch {
		return DEFAULT_WRITER_CONCURRENCY;
	}
}

function safeEntailmentBatchSize(): number {
	try {
		return getAtlasV2EntailmentBatchSize();
	} catch {
		return 10;
	}
}

interface ResumeState {
	plan?: AtlasV2Plan;
	rawSources?: AtlasV2RawSource[];
	completedRounds?: number;
	index?: AtlasV2EvidenceIndex;
	sections?: AtlasV2WrittenSection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Rebuilds what earlier phases produced from the durable checkpoints. Anything
 * that does not parse is simply not resumed — the phase runs again, which is
 * always correct and only ever costs time.
 */
export function readAtlasV2ResumeState(
	checkpoints: Array<{ roundNumber: number; checkpoint: unknown }>,
): ResumeState {
	const state: ResumeState = {};
	for (const entry of [...checkpoints].sort(
		(left, right) => left.roundNumber - right.roundNumber,
	)) {
		if (!isRecord(entry.checkpoint)) continue;
		if (entry.checkpoint.schema !== ATLAS_V2_CHECKPOINT_SCHEMA_VERSION)
			continue;
		const data = isRecord(entry.checkpoint.data) ? entry.checkpoint.data : {};
		switch (entry.checkpoint.phase) {
			case "plan":
				if (isRecord(data.plan))
					state.plan = data.plan as unknown as AtlasV2Plan;
				break;
			case "research":
				if (Array.isArray(data.rawSources)) {
					state.rawSources = data.rawSources as AtlasV2RawSource[];
				}
				if (typeof data.round === "number") state.completedRounds = data.round;
				break;
			case "index":
				if (isRecord(data.index)) {
					state.index = data.index as unknown as AtlasV2EvidenceIndex;
				}
				break;
			case "write":
				if (Array.isArray(data.sections)) {
					state.sections = data.sections as AtlasV2WrittenSection[];
				}
				break;
			default:
				break;
		}
	}
	return state;
}

/**
 * Per-question confidence for the progress card: derived from the confidences
 * of the kept sentences that cite that question's sources.
 */
export function questionConfidences(input: {
	index: AtlasV2EvidenceIndex;
	verification: AtlasV2VerificationResult;
}): Record<string, AtlasV2QuestionConfidence> {
	const confidences: Record<string, AtlasV2QuestionConfidence> = {};
	const sentences = input.verification.sections.flatMap((section) =>
		section.paragraphs.flat(),
	);
	for (const [questionId, sourceNumbers] of Object.entries(
		input.index.byQuestion,
	)) {
		if (sourceNumbers.length === 0) {
			confidences[questionId] = "thin";
			continue;
		}
		const relevant = sentences.filter((sentence) =>
			sentence.citations.some((citation) => sourceNumbers.includes(citation)),
		);
		if (relevant.length === 0) {
			confidences[questionId] = "thin";
			continue;
		}
		const levels = new Set(relevant.map((sentence) => sentence.confidence));
		confidences[questionId] =
			levels.size === 1 && levels.has("corroborated")
				? "corroborated"
				: levels.size === 1 && levels.has("single")
					? "single"
					: "mixed";
	}
	return confidences;
}

export async function runAtlasV2Pipeline(
	input: RunAtlasV2PipelineInput,
): Promise<AtlasV2PipelineResult> {
	const now = input.now ?? new Date();
	const { job, dependencies: deps } = input;
	const language = detectLanguage(job.query);
	const profileConfig = getAtlasV2ProfileConfig(
		job.profile,
		deps.profileOverrides,
	);
	const staleMonths = getAtlasV2StaleMonths();
	const searchConcurrency = Math.max(1, deps.searchConcurrency ?? 3);
	const writerConcurrency = Math.max(
		1,
		deps.writerConcurrency ?? safeWriterConcurrency(),
	);
	const entailmentBatchSize = safeEntailmentBatchSize();
	const budget = profileConfig.budget;
	const coreQuestion = coreQuestionFromQuery(job.query, language);
	const seed = extractAtlasV2LifecycleSeed(job.lifecycle);
	const resume = deps.loadCheckpoints
		? readAtlasV2ResumeState(await deps.loadCheckpoints(job.id))
		: {};

	let usage = ZERO_USAGE;
	const totalRounds = profileConfig.rounds;
	let sourcesRead = 0;
	// Per-phase wall time, so a slow run can be attributed rather than guessed
	// at. Reported in progress details and in the render checkpoint.
	const phaseDurationsMs: Record<string, number> = {};
	const timePhase = async <T>(
		name: string,
		run: () => Promise<T>,
	): Promise<T> => {
		const startedAt = Date.now();
		try {
			return await run();
		} finally {
			phaseDurationsMs[name] =
				(phaseDurationsMs[name] ?? 0) + (Date.now() - startedAt);
		}
	};

	const heartbeat = async (
		phase: AtlasV2Phase,
		details: {
			plan: AtlasV2Plan | null;
			round?: { current: number; total: number };
			sourceCountByQuestion?: Record<string, number>;
			runningQuestionIds?: readonly string[];
			doneQuestionIds?: readonly string[];
			confidenceByQuestion?: Record<string, AtlasV2QuestionConfidence>;
			evidence?: AtlasV2ProgressEvidence;
		},
	): Promise<void> => {
		await deps.heartbeat?.({
			stage: phase,
			progressPercent: ATLAS_V2_PHASE_PROGRESS[phase],
			progressDetails: buildAtlasV2ProgressDetails({
				phase,
				language,
				plan: details.plan,
				round: details.round ?? { current: 1, total: totalRounds },
				sourcesRead,
				sourceCountByQuestion: details.sourceCountByQuestion,
				runningQuestionIds: details.runningQuestionIds,
				doneQuestionIds: details.doneQuestionIds,
				confidenceByQuestion: details.confidenceByQuestion,
				evidence: details.evidence,
				phaseDurationsMs,
			}),
		});
	};

	const checkpoint = async (
		phase: AtlasV2Phase,
		roundNumber: number,
		data: unknown,
		extras?: {
			curatedSourcePool?: unknown;
			compressedFindings?: unknown;
			documentSourceSummary?: unknown;
			qualityDiagnostics?: unknown;
		},
	): Promise<void> => {
		await deps.writeCheckpoint({
			jobId: job.id,
			roundNumber,
			stage: phase,
			checkpoint: {
				schema: ATLAS_V2_CHECKPOINT_SCHEMA_VERSION,
				phase,
				data,
			},
			curatedSourcePool: extras?.curatedSourcePool ?? [],
			compressedFindings: extras?.compressedFindings ?? {},
			usage,
			qualityDiagnostics: extras?.qualityDiagnostics ?? {},
			documentSourceSummary: extras?.documentSourceSummary ?? {},
		});
	};

	// -- 1. Plan ------------------------------------------------------------
	await heartbeat("plan", { plan: null });
	let plan = resume.plan ?? null;
	if (!plan) {
		const planCall = await timePhase("plan", () =>
			deps.runControlModel({
				stage: "plan",
				system: ATLAS_V2_PLAN_SYSTEM[language],
				prompt: buildAtlasV2PlanPrompt({
					query: job.query,
					profile: job.profile,
					questionCount: profileConfig.questions,
					minSections: budget.minSections,
					maxSections: budget.maxSections,
					language,
					currentDate: isoDate(now),
					seedQuestions: seed?.questions,
					seedSections: seed?.sections,
					reviseInstruction: job.action === "revise" ? job.query : null,
				}),
			}),
		);
		usage = addUsage(usage, planCall.usage);
		plan =
			parseAtlasV2Plan(planCall.text, {
				questionCount: profileConfig.questions,
				coreQuestion,
				minSections: budget.minSections,
				maxSections: budget.maxSections,
			}) ??
			fallbackAtlasV2Plan({
				query: job.query,
				questionCount: profileConfig.questions,
				language,
			});
		await checkpoint("plan", CHECKPOINT_ROUND.plan, { plan });
	}
	const resolvedPlan: AtlasV2Plan = plan;

	// -- 2. Research --------------------------------------------------------
	let rawSources: AtlasV2RawSource[] = resume.rawSources ?? [];
	let followUpQueries: Record<string, string[]> = {};
	const doneQuestionIds = new Set<string>();
	const startRound = (resume.completedRounds ?? 0) + 1;
	for (let round = startRound; round <= totalRounds; round += 1) {
		const questionsForRound =
			round === 1
				? resolvedPlan.questions
				: resolvedPlan.questions.filter((question) =>
						Object.hasOwn(followUpQueries, question.id),
					);
		if (questionsForRound.length === 0) break;

		await heartbeat("research", {
			plan: resolvedPlan,
			round: { current: round, total: totalRounds },
			runningQuestionIds: questionsForRound.map((question) => question.id),
			doneQuestionIds: [...doneQuestionIds],
			sourceCountByQuestion: countByQuestion(rawSources),
		});

		const roundResult = await timePhase("research", () =>
			runAtlasV2ResearchRound({
				round,
				questions: questionsForRound,
				researchWeb: deps.researchWeb,
				readPages: profileConfig.readPages,
				queriesPerQuestion: profileConfig.queriesPerQuestion,
				concurrency: searchConcurrency,
				language,
				followUpQueries,
				huntContradictions:
					profileConfig.contradictionHuntOnLastRound && round === totalRounds,
				onQuestionDone: async ({ questionId, rawSourceCount }) => {
					doneQuestionIds.add(questionId);
					sourcesRead += rawSourceCount;
				},
			}),
		);
		rawSources = [...rawSources, ...roundResult.rawSources];
		await checkpoint("research", RESEARCH_CHECKPOINT_BASE + round, {
			round,
			rawSources,
			outcomes: roundResult.outcomes,
		});

		if (round >= totalRounds) break;

		// Coverage check between rounds: one control-model call names the thin
		// questions and proposes targeted follow-ups.
		const interimIndex = buildAtlasV2EvidenceIndex(rawSources);
		const deterministicThin = deterministicallyThinQuestionIds(
			interimIndex.byQuestion,
			resolvedPlan.questions,
		);
		const coverageCall = await timePhase("coverage", () =>
			deps.runControlModel({
				stage: "coverage",
				system: ATLAS_V2_COVERAGE_SYSTEM[language],
				prompt: buildAtlasV2CoveragePrompt({
					plan: resolvedPlan,
					round,
					roundsRemaining: totalRounds - round,
					language,
					evidenceByQuestion: resolvedPlan.questions.map((question) => {
						const numbers = interimIndex.byQuestion[question.id] ?? [];
						return {
							id: question.id,
							question: question.question,
							sourceCount: numbers.length,
							excerpts: numbers
								.slice(0, 3)
								.map(
									(n) =>
										interimIndex.sources.find((source) => source.n === n)
											?.snippets[0] ?? "",
								)
								.filter(Boolean),
						};
					}),
				}),
			}),
		);
		usage = addUsage(usage, coverageCall.usage);
		const review = parseAtlasV2CoverageReview(
			coverageCall.text,
			resolvedPlan.questions.map((question) => question.id),
		);
		followUpQueries = {};
		for (const entry of review.followUpQueries) {
			followUpQueries[entry.questionId] = entry.queries;
		}
		// A question with no evidence is re-researched whatever the model said.
		for (const questionId of deterministicThin) {
			followUpQueries[questionId] ??= [
				resolvedPlan.questions.find((question) => question.id === questionId)
					?.question ?? "",
			].filter(Boolean);
		}
		// ...and a question that already has enough evidence is NOT re-researched,
		// whatever the model said. Re-researching answered questions is what made
		// the first live evaluation read 189 sources for one report.
		for (const questionId of Object.keys(followUpQueries)) {
			const found = interimIndex.byQuestion[questionId]?.length ?? 0;
			if (found >= ATLAS_V2_COVERAGE_SUFFICIENT_SOURCES) {
				delete followUpQueries[questionId];
			}
		}
		if (Object.keys(followUpQueries).length === 0) break;
	}

	// -- 3. Evidence index (deterministic) ----------------------------------
	await heartbeat("index", {
		plan: resolvedPlan,
		round: { current: totalRounds, total: totalRounds },
		doneQuestionIds: resolvedPlan.questions.map((question) => question.id),
	});
	// Deterministic, but not instant on a few hundred raw sources — and timed, so
	// a slow run can be attributed rather than guessed at.
	const mergedIndex = await timePhase("index", async () =>
		resume.index
			? resume.index
			: mergeAtlasV2EvidenceIndexes(
					seed?.evidenceIndex ?? null,
					buildAtlasV2EvidenceIndex(rawSources),
				),
	);
	// The source budget is applied HERE, before anything is written, so no
	// citation is ever minted against a source the report cannot afford to
	// carry. A resumed index is already capped and renumbered.
	const capped = resume.index
		? { index: mergedIndex, droppedForBudget: 0 }
		: capAtlasV2EvidenceIndex({
				index: mergedIndex,
				maxSources: profileConfig.maxIndexedSources,
				questionOrder: resolvedPlan.questions.map((question) => question.id),
			});
	const index = capped.index;
	if (capped.droppedForBudget > 0) {
		console.info("[ATLAS v2] Capped the evidence index to the source budget", {
			jobId: job.id,
			profile: job.profile,
			kept: index.sources.length,
			dropped: capped.droppedForBudget,
		});
	}
	if (index.sources.length === 0) {
		throw new AtlasV2PipelineError(
			"atlas_v2_no_sources",
			"Atlas found no usable sources: every web result was a redirect stub, a social profile, a duplicate, or navigation chrome.",
		);
	}
	if (!resume.index) {
		await checkpoint("index", CHECKPOINT_ROUND.index, { index });
	}

	// -- 4. Write sections --------------------------------------------------
	await heartbeat("write", {
		plan: resolvedPlan,
		round: { current: totalRounds, total: totalRounds },
		doneQuestionIds: resolvedPlan.questions.map((question) => question.id),
		sourceCountByQuestion: sourceCountsFromIndex(index),
	});
	const outline = resolvedPlan.sections.map((section) => ({
		title: section.title,
		brief: section.brief,
	}));
	const maxSourceNumber = index.sources.reduce(
		(largest, source) => Math.max(largest, source.n),
		0,
	);
	// The per-section budget is derived from the band's MIDPOINT and from how
	// many sections the plan actually produced, so a 3-section overview is
	// written to a 3-section budget rather than to a 6-section one and then
	// reported as short. `targetWords` is what the writer aims at; the sentence
	// counts follow from it.
	const sectionBudget = atlasV2SectionWriterBudget({
		budget,
		sectionCount: resolvedPlan.sections.length,
	});
	const evidenceBySection = new Map(
		resolvedPlan.sections.map((section) => [
			section.id,
			buildWriterEvidenceEntries(
				sourcesForSection(index, section.questionIds),
				profileConfig.maxSourcesPerSection,
			),
		]),
	);
	// Pass one: one line per section naming the figures it will use. Every body
	// call then sees every other section's line, so no two sections state the
	// same fact — and the bodies still run in one concurrent wave.
	//
	// Skipped for a one-section plan: there is no other section to inform, and the
	// call would be pure latency.
	const sectionGists =
		resume.sections || resolvedPlan.sections.length < 2
			? []
			: (
					await mapWithConcurrency(
						resolvedPlan.sections,
						writerConcurrency,
						async (section) => {
							const evidence = evidenceBySection.get(section.id) ?? [];
							if (evidence.length === 0) return null;
							const call = await timePhase("lead", () =>
								deps.runWriterModel({
									stage: `lead:${section.id}`,
									system: ATLAS_V2_SECTION_LEAD_SYSTEM[language],
									prompt: buildAtlasV2SectionLeadPrompt({
										query: job.query,
										language,
										section,
										evidence,
									}),
								}),
							);
							usage = addUsage(usage, call.usage);
							const gist = parseAtlasV2SectionLead(call.text);
							return gist
								? { id: section.id, title: section.title, gist }
								: null;
						},
					)
				).filter(
					(entry): entry is { id: string; title: string; gist: string } =>
						entry !== null,
				);
	const writtenSections =
		resume.sections ??
		(
			await mapWithConcurrency(
				resolvedPlan.sections,
				writerConcurrency,
				async (section) => {
					const evidence = evidenceBySection.get(section.id) ?? [];
					if (evidence.length === 0) return null;
					const call = await timePhase("write", () =>
						deps.runWriterModel({
							stage: `write:${section.id}`,
							system: ATLAS_V2_WRITER_SYSTEM[language],
							prompt: buildAtlasV2SectionPrompt({
								query: job.query,
								profile: job.profile,
								language,
								currentDate: isoDate(now),
								section,
								questions: resolvedPlan.questions.filter((question) =>
									section.questionIds.includes(question.id),
								),
								outline,
								evidence,
								sectionsAlreadyWritten: sectionGists
									.filter((entry) => entry.id !== section.id)
									.map((entry) => ({ title: entry.title, gist: entry.gist })),
								targetWords: sectionBudget.targetWords,
								minSentences: sectionBudget.minSentences,
								maxSentences: sectionBudget.maxSentences,
								maxParagraphs: budget.maxParagraphsPerSection,
							}),
						}),
					);
					usage = addUsage(usage, call.usage);
					return parseAtlasV2WrittenSection(call.text, {
						sectionId: section.id,
						title: section.title,
						maxSourceNumber,
						maxSentences: sectionBudget.maxSentences,
						maxParagraphs: budget.maxParagraphsPerSection,
					});
				},
			)
		).filter((section): section is AtlasV2WrittenSection => section !== null);

	if (writtenSections.length === 0) {
		throw new AtlasV2PipelineError(
			"atlas_v2_no_sections",
			"Atlas could not write any section from the evidence it collected.",
		);
	}
	if (!resume.sections) {
		await checkpoint("write", CHECKPOINT_ROUND.write, {
			sections: writtenSections,
		});
	}

	// -- 5. Verify ----------------------------------------------------------
	await heartbeat("verify", {
		plan: resolvedPlan,
		round: { current: totalRounds, total: totalRounds },
		doneQuestionIds: resolvedPlan.questions.map((question) => question.id),
		sourceCountByQuestion: sourceCountsFromIndex(index),
	});
	const checkEntailment = deps.runAuditModel
		? async ({
				claim,
				sourceNumber,
				sourceTitle,
				sourceText,
			}: AtlasV2EntailmentRequest) => {
				const call = await deps.runAuditModel?.({
					stage: `entail:${sourceNumber}`,
					system: ATLAS_V2_ENTAILMENT_SYSTEM,
					prompt: buildAtlasV2EntailmentPrompt({
						claim,
						sourceTitle,
						sourceText,
					}),
				});
				if (!call) return null;
				usage = addUsage(usage, call.usage);
				return parseAtlasV2EntailmentAnswer(call.text);
			}
		: undefined;
	// Batched: up to `entailmentBatchSize` claims per call, with the one-claim
	// path above as the fallback whenever the array answer does not parse.
	const checkEntailmentBatch = deps.runAuditModel
		? async (items: AtlasV2EntailmentRequest[]) => {
				const call = await deps.runAuditModel?.({
					stage: `entail:batch:${items.length}`,
					system: ATLAS_V2_ENTAILMENT_BATCH_SYSTEM,
					prompt: buildAtlasV2EntailmentBatchPrompt({ items }),
				});
				if (!call) return null;
				usage = addUsage(usage, call.usage);
				const answers = parseAtlasV2EntailmentBatchAnswer(
					call.text,
					items.length,
				);
				console.info("[ATLAS v2] Batched entailment check", {
					jobId: job.id,
					claims: items.length,
					parsed: answers !== null,
				});
				return answers;
			}
		: undefined;

	const verification = await timePhase("verify", () =>
		verifyAtlasV2Report({
			sections: writtenSections,
			index,
			staleMonths,
			now,
			checkEntailment,
			checkEntailmentBatch,
			entailmentBatchSize,
			runCalculation: deps.runPython
				? async ({ expression }) => {
						const result = await deps.runPython?.({ expression });
						return result ?? { ok: false, value: null };
					}
				: undefined,
			rewriteSection: async ({ section, failed }) => {
				const call = await deps.runWriterModel({
					stage: `rewrite:${section.sectionId}`,
					system: ATLAS_V2_REWRITE_SYSTEM[language],
					prompt: buildAtlasV2RewritePrompt({
						language,
						section: { id: section.sectionId, title: section.title },
						evidence: buildWriterEvidenceEntries(
							citedSources(index, section),
							profileConfig.maxSourcesPerSection,
						),
						failed,
					}),
				});
				usage = addUsage(usage, call.usage);
				return parseAtlasV2WrittenSection(call.text, {
					sectionId: section.sectionId,
					title: section.title,
					maxSourceNumber,
					maxSentences: sectionBudget.maxSentences,
					maxParagraphs: budget.maxParagraphsPerSection,
				});
			},
			rewriteConcurrency: writerConcurrency,
		}),
	);

	// A fact an earlier section already stated is dropped rather than counted
	// toward the budget: three sections stating one figure is what made the
	// second evaluation's reports repetitive AND short.
	const novelty = dropRepeatedAtlasV2Sentences({
		sections: verification.sections,
	});
	if (novelty.droppedSentenceCount > 0) {
		console.info("[ATLAS v2] Dropped sentences repeating an earlier section", {
			jobId: job.id,
			profile: job.profile,
			dropped: novelty.droppedSentenceCount,
		});
	}

	// The length budget is applied to the VERIFIED sections, before the summary
	// is written, so the summary never summarises prose the reader will not see.
	// It only ever TRIMS: a body under the bound is passed through untouched.
	const bodyCap = capAtlasV2SectionsToWordBudget({
		sections: novelty.sections,
		maxWords: bodyWordBudget(budget),
	});
	const cappedVerification: AtlasV2VerificationResult = {
		...verification,
		sections: bodyCap.sections,
		citedSourceNumbers: citedNumbersInSections(bodyCap.sections),
	};
	if (bodyCap.droppedSentenceCount > 0) {
		console.info("[ATLAS v2] Trimmed the report to its word budget", {
			jobId: job.id,
			profile: job.profile,
			maxWords: bodyWordBudget(budget),
			words: bodyCap.wordCount,
			droppedSentences: bodyCap.droppedSentenceCount,
		});
	}

	// The executive summary is written LAST, from the finished sections, then
	// verified the same way so it cannot smuggle in an unsupported figure.
	//
	// It must ANSWER THE QUESTION. `coreSourceNumbers` are the sources indexed
	// against plan question 1 — the request itself — so a summary citing none of
	// them is answering something else, and is rewritten once with that said.
	const coreQuestionId = resolvedPlan.questions[0]?.id ?? "";
	const coreSourceNumbers = index.byQuestion[coreQuestionId] ?? [];
	const runSummary = async (
		insistOnCoreAnswer: boolean,
	): Promise<{
		source: AtlasV2WrittenSection | null;
		verification: AtlasV2VerificationResult | null;
		section: AtlasV2VerifiedSection | null;
	}> => {
		const source = await timePhase("summary", () =>
			writeExecutiveSummary({
				query: job.query,
				coreQuestion,
				coreCitations: coreSourceNumbers,
				insistOnCoreAnswer,
				language,
				verification: cappedVerification,
				runWriterModel: deps.runWriterModel,
				onUsage: (next) => {
					usage = addUsage(usage, next);
				},
				maxSourceNumber,
			}),
		);
		// Timed as part of `verify`: it was outside every phase timer before, which
		// is one of the places the second evaluation's unattributed wall time went.
		const verified = source
			? await timePhase("verify", () =>
					verifyAtlasV2Report({
						sections: [source],
						index,
						staleMonths,
						now,
					}),
				)
			: null;
		return {
			source,
			verification: verified,
			section: verified?.sections[0] ?? null,
		};
	};

	let summary = await runSummary(false);
	let coreAnswer = checkAtlasV2CoreAnswer({
		summary: summary.section,
		coreSourceNumbers,
	});
	if (!coreAnswer.present) {
		console.info("[ATLAS v2] Executive summary missed the core question", {
			jobId: job.id,
			coreQuestionId,
			coreSourceNumbers,
		});
		const retry = await runSummary(true);
		const retryAnswer = checkAtlasV2CoreAnswer({
			summary: retry.section,
			coreSourceNumbers,
		});
		// Only take the retry when it is actually better; a retry that lost the
		// summary entirely must not replace a usable one.
		if (retryAnswer.present || (!summary.section && retry.section)) {
			summary = retry;
			coreAnswer = retryAnswer;
		}
	}
	const summaryVerification = summary.verification;
	const summarySection: AtlasV2VerifiedSection | null = summary.section;

	const combinedVerification: AtlasV2VerificationResult = {
		...cappedVerification,
		totals: {
			corroborated:
				cappedVerification.totals.corroborated +
				(summaryVerification?.totals.corroborated ?? 0),
			single:
				cappedVerification.totals.single +
				(summaryVerification?.totals.single ?? 0),
			inferred:
				cappedVerification.totals.inferred +
				(summaryVerification?.totals.inferred ?? 0),
			cut:
				cappedVerification.totals.cut + (summaryVerification?.totals.cut ?? 0),
		},
		citedSourceNumbers: [
			...new Set([
				...cappedVerification.citedSourceNumbers,
				...(summaryVerification?.citedSourceNumbers ?? []),
			]),
		].sort((a, b) => a - b),
		staleCitations: [
			...new Set([
				...cappedVerification.staleCitations,
				...(summaryVerification?.staleCitations ?? []),
			]),
		].sort((a, b) => a - b),
	};

	const publication = renumberAtlasV2ForPublication({
		index,
		verification: combinedVerification,
	});
	const publishedSummary = summarySection
		? {
				...summarySection,
				paragraphs: summarySection.paragraphs.map((paragraph) =>
					paragraph.map((sentence) => ({
						...sentence,
						// Same publication rule as the section bodies: remapped, then
						// deduplicated and capped, so two indexed sources that collapse
						// into one published source yield ONE citation.
						citations: publishSentenceCitations({
							citations: sentence.citations,
							renumberMap: publication.renumberMap,
						}),
					})),
				),
			}
		: null;

	const evidence = buildAtlasV2ProgressEvidence({
		index,
		totals: combinedVerification.totals,
		// In the PUBLISHED numbering. A source only a Limitations contradiction
		// names is published but not cited, so this is not simply every source.
		citedSourceNumbers: combinedVerification.citedSourceNumbers
			.map((citation) => publication.renumberMap.get(citation))
			.filter((citation): citation is number => citation !== undefined),
		publishedSources: publication.sources,
	});
	await heartbeat("verify", {
		plan: resolvedPlan,
		round: { current: totalRounds, total: totalRounds },
		doneQuestionIds: resolvedPlan.questions.map((question) => question.id),
		sourceCountByQuestion: sourceCountsFromIndex(index),
		confidenceByQuestion: questionConfidences({
			index,
			verification: combinedVerification,
		}),
		evidence,
	});
	await checkpoint("verify", CHECKPOINT_ROUND.verify, {
		totals: combinedVerification.totals,
		contradictions: combinedVerification.contradictions,
		staleCitations: combinedVerification.staleCitations,
		entailmentCallCount: combinedVerification.entailmentCallCount,
	});

	// -- 6. Render ----------------------------------------------------------
	await heartbeat("render", {
		plan: resolvedPlan,
		round: { current: totalRounds, total: totalRounds },
		doneQuestionIds: resolvedPlan.questions.map((question) => question.id),
		sourceCountByQuestion: sourceCountsFromIndex(index),
		confidenceByQuestion: questionConfidences({
			index,
			verification: combinedVerification,
		}),
		evidence,
	});

	const thinQuestions = resolvedPlan.questions
		.filter((question) => (index.byQuestion[question.id]?.length ?? 0) === 0)
		.map((question) => question.question);
	// The report title, in order of preference: what the plan stage proposed,
	// then a deterministic truncation of the request at a word boundary. The job
	// row's own title is the request cut at 80 characters, which is what produced
	// the "...and how does that" titles in the first live evaluation.
	const title =
		resolvedPlan.title?.trim() || deterministicAtlasV2Title(job.query);
	if (title && title !== job.title) {
		await deps
			.applyGeneratedTitle?.({ jobId: job.id, title })
			.catch((error) => {
				// A report with a readable title beats a job row with a matching one.
				console.warn("[ATLAS v2] Failed to apply the generated title", {
					jobId: job.id,
					error,
				});
			});
	}
	const documentSource = buildAtlasV2DocumentSource({
		title,
		language,
		date: isoDate(now),
		publication,
		summary: publishedSummary,
		thinQuestions,
		cutSentenceCount: combinedVerification.totals.cut,
		staleMonths,
	});
	// File production (HTML, PDF, DOCX, Markdown) is not free and was not timed
	// before; on the second evaluation it sat inside the unattributed gap between
	// the phase timers and the job's wall time.
	const outputs = await timePhase("render", () =>
		deps.renderOutputs(documentSource),
	);

	const executiveSummaryMarkdown = buildAtlasV2ExecutiveSummaryMarkdown({
		title,
		summary: publishedSummary,
		publication,
		language,
	});
	if (executiveSummaryMarkdown && job.assistantMessageId) {
		await deps
			.setAssistantMessageContent?.({
				messageId: job.assistantMessageId,
				content: executiveSummaryMarkdown,
			})
			.catch((error) => {
				// The report itself is produced; a failed message update must not
				// throw the job away.
				console.warn("[ATLAS v2] Failed to set assistant message content", {
					jobId: job.id,
					error,
				});
			});
	}

	await checkpoint(
		"render",
		CHECKPOINT_ROUND.render,
		{ outputs },
		{
			compressedFindings: buildAtlasV2CompressedFindings({
				plan: resolvedPlan,
				query: job.query,
			}),
			curatedSourcePool: buildAtlasV2CuratedSourcePool(index),
			documentSourceSummary: {
				atlasFamily: job.lifecycle.family,
				pipelineVersion: 2,
				title,
				sourceCount: publication.sources.length,
			},
			qualityDiagnostics: {
				totals: combinedVerification.totals,
				filteredCount: index.filteredCount,
				contradictionCount: combinedVerification.contradictions.length,
				staleCitationCount: combinedVerification.staleCitations.length,
				entailmentCallCount: combinedVerification.entailmentCallCount,
				entailmentBatchCount: combinedVerification.entailmentBatchCount,
				phaseDurationsMs: { ...phaseDurationsMs },
				wordCount: reportWordCount(combinedVerification, summarySection),
				wordBudget: budget.maxWords,
				wordTargetPerSection: sectionBudget.targetWords,
				sourcesDroppedForBudget: capped.droppedForBudget,
				sentencesDroppedForBudget: bodyCap.droppedSentenceCount,
				sentencesDroppedAsRepeats: novelty.droppedSentenceCount,
				coreAnswerPresent: coreAnswer.present,
				coreAnswerCitesFigure: coreAnswer.citedFigure,
			},
		},
	);

	return {
		status: "succeeded",
		stage: "render",
		pipelineVersion: 2,
		title,
		executiveSummaryMarkdown,
		outputs,
		usage,
		sourceCounts: {
			local: 0,
			web: index.sources.length,
			accepted: publication.sources.length,
			rejected: index.filteredCount,
		},
		verification: {
			...combinedVerification.totals,
			filteredCount: index.filteredCount,
			contradictionCount: combinedVerification.contradictions.length,
			staleCitationCount: combinedVerification.staleCitations.length,
		},
	};
}

async function writeExecutiveSummary(input: {
	query: string;
	/** The request as one question; the first sentence must answer it. */
	coreQuestion?: string;
	coreCitations?: number[];
	insistOnCoreAnswer?: boolean;
	language: SupportedLanguage;
	verification: AtlasV2VerificationResult;
	runWriterModel: AtlasV2ModelCall;
	onUsage: (usage: AtlasV2Usage) => void;
	maxSourceNumber: number;
}): Promise<AtlasV2WrittenSection | null> {
	const sections = input.verification.sections
		.filter((section) => section.paragraphs.length > 0)
		.map((section) => ({
			title: section.title,
			// Bounded per section: the summary is written from the report's claims,
			// and handing the model every sentence of a long report buys nothing but
			// prompt and latency.
			sentences: section.paragraphs
				.flat()
				.slice(0, SUMMARY_SENTENCES_PER_SECTION)
				.map((sentence) => ({
					text: sentence.text,
					citations: sentence.citations,
				})),
		}));
	if (sections.length === 0) return null;
	const call = await input.runWriterModel({
		stage: input.insistOnCoreAnswer ? "summary:retry" : "summary",
		system: ATLAS_V2_SUMMARY_SYSTEM[input.language],
		prompt: buildAtlasV2SummaryPrompt({
			query: input.query,
			coreQuestion: input.coreQuestion,
			coreCitations: input.coreCitations,
			insistOnCoreAnswer: input.insistOnCoreAnswer,
			language: input.language,
			sections,
		}),
	});
	input.onUsage(call.usage);
	return parseAtlasV2WrittenSection(call.text, {
		sectionId: "summary",
		title: "summary",
		maxSourceNumber: input.maxSourceNumber,
	});
}

/** Words in the published body plus the executive summary. */
function reportWordCount(
	verification: AtlasV2VerificationResult,
	summary: AtlasV2VerifiedSection | null,
): number {
	const sentences = [
		...verification.sections.flatMap((section) => section.paragraphs.flat()),
		...(summary?.paragraphs.flat() ?? []),
	];
	return sentences.reduce(
		(total, sentence) => total + countWords(sentence.text),
		0,
	);
}

function countByQuestion(
	rawSources: AtlasV2RawSource[],
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const source of rawSources) {
		counts[source.questionId] = (counts[source.questionId] ?? 0) + 1;
	}
	return counts;
}

function sourceCountsFromIndex(
	index: AtlasV2EvidenceIndex,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const [questionId, numbers] of Object.entries(index.byQuestion)) {
		counts[questionId] = numbers.length;
	}
	return counts;
}

function sourcesForSection(
	index: AtlasV2EvidenceIndex,
	questionIds: readonly string[],
): AtlasV2IndexedSource[] {
	const wanted = new Set(
		questionIds.flatMap((questionId) => index.byQuestion[questionId] ?? []),
	);
	return index.sources.filter((source) => wanted.has(source.n));
}

function citedSources(
	index: AtlasV2EvidenceIndex,
	section: AtlasV2WrittenSection,
): AtlasV2IndexedSource[] {
	const wanted = new Set(
		section.paragraphs.flatMap((paragraph) =>
			paragraph.sentences.flatMap((sentence) => sentence.citations),
		),
	);
	const cited = index.sources.filter((source) => wanted.has(source.n));
	return cited.length > 0 ? cited : index.sources;
}
