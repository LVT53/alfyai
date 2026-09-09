// The Atlas v2 content pipeline (ADR 0062).
//
// Six stages, each a durable checkpoint, each cancellable through the existing
// heartbeat (the worker's heartbeat throws when the job is no longer running).
// The job infrastructure below this module — ledger, claiming, heartbeats,
// checkpoints, cancel, idempotent kickoff, lifecycle, analytics, file
// production — is v1's, unchanged.

import type { ThinkingMode } from "$lib/reasoning-depth-types";
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
	ATLAS_V2_MAX_OUTPUT_TOKENS,
	atlasV2RunawayRetryMaxOutputTokens,
	atlasV2SectionMaxOutputTokens,
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
	type AtlasV2PlanSection,
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
	ATLAS_V2_PLAIN_TEXT_WRITER_SYSTEM,
	ATLAS_V2_REWRITE_SYSTEM,
	ATLAS_V2_STRICT_JSON_PREFACE,
	ATLAS_V2_SUMMARY_SYSTEM,
	ATLAS_V2_WRITER_SYSTEM,
	buildAtlasV2PlainTextSectionPrompt,
	buildAtlasV2RewritePrompt,
	buildAtlasV2SectionPrompt,
	buildAtlasV2SummaryPrompt,
	buildWriterEvidenceEntries,
	countAtlasV2SectionSentences,
	parseAtlasV2PlainTextSection,
	parseAtlasV2WrittenSection,
	salvageAtlasV2WrittenSection,
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
/**
 * A section whose own questions found fewer than this many sources is topped up
 * from the rest of the index. Two sources cannot corroborate anything and leave
 * the writer nothing to write from but its own knowledge.
 */
const MIN_SOURCES_PER_SECTION = 3;
/** Salvaged sentences below which the repair bought nothing worth publishing. */
const MIN_SALVAGED_SENTENCES = 2;

export type AtlasV2ModelCall = (input: {
	stage: string;
	system: string;
	prompt: string;
	/**
	 * Provider reasoning switch. Every v2 stage asks for structured JSON, so
	 * every v2 stage passes `"off"`: reasoning ahead of the object is output
	 * budget spent on text the parser throws away.
	 */
	thinkingMode?: ThinkingMode;
	/** Output cap for this call, sized to the stage. See config.ts. */
	maxOutputTokens?: number;
}) => Promise<{
	text: string;
	finishReason?: string | null;
	usage: AtlasV2Usage;
}>;

/** What one writer call did, for the diagnostics and the harness. */
export interface AtlasV2WriterRunawayCounters {
	/** Writer calls that ended at the output cap. */
	length: number;
	/** Runaways whose truncated JSON was repaired into a usable section. */
	salvaged: number;
	/** Sections retried at a tighter bound after a runaway. */
	retried: number;
	/** Sections written through the plain-text fallback. */
	fallback: number;
}

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
	// Sections written against sections planned, set once the writer has run and
	// carried by every heartbeat after it: a report short of its outline has to
	// say so where the evaluation can see it, not only in the server log.
	let sectionCounts: { written: number; planned: number } | null = null;
	// Writer calls that ran to their output cap, carried by every heartbeat from
	// the write phase on. A runaway is invisible in the wall time alone.
	let writerRunawayCounts: AtlasV2WriterRunawayCounters | null = null;
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
				...(sectionCounts ? { sections: sectionCounts } : {}),
				...(writerRunawayCounts ? { writerRunaways: writerRunawayCounts } : {}),
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
				thinkingMode: "off",
				maxOutputTokens: ATLAS_V2_MAX_OUTPUT_TOKENS.plan,
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
				thinkingMode: "off",
				maxOutputTokens: ATLAS_V2_MAX_OUTPUT_TOKENS.coverage,
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
	// The output cap for one section body, from what that section is asked to
	// write. Sized here so the runaway retry can step down from a known number.
	const sectionMaxOutputTokens = atlasV2SectionMaxOutputTokens(
		sectionBudget.targetWords,
	);
	const evidenceBySection = new Map(
		resolvedPlan.sections.map((section) => [
			section.id,
			buildWriterEvidenceEntries(
				sourcesForSectionWithFallback({
					index,
					questionIds: section.questionIds,
					minSources: MIN_SOURCES_PER_SECTION,
					maxSources: profileConfig.maxSourcesPerSection,
				}),
				profileConfig.maxSourcesPerSection,
			),
		]),
	);
	// Every planned section is written in ONE concurrent wave, and a section is
	// never lost to a single bad model answer: a call that throws, or an answer
	// that parses to no paragraphs, is retried once before the section is given
	// up on. Whatever is given up on is RECORDED with its reason rather than
	// filtered away in silence — a silently dropped section is how the third
	// evaluation shipped a six-section plan as a one-section report.
	const sectionWriteFailures: Array<{ sectionId: string; reason: string }> = [];
	const writerRunaways: AtlasV2WriterRunawayCounters = {
		length: 0,
		salvaged: 0,
		retried: 0,
		fallback: 0,
	};
	const sectionQuestions = (section: AtlasV2PlanSection) =>
		resolvedPlan.questions.filter((question) =>
			section.questionIds.includes(question.id),
		);
	/**
	 * One JSON writer call. `bound` is how tight the sentence budget and the
	 * output cap are; the retry after a runaway halves the first and cuts the
	 * second by 30%, and prefaces the system prompt with "the object only".
	 */
	const writeSectionOnce = async (
		section: AtlasV2PlanSection,
		evidence: ReturnType<typeof buildWriterEvidenceEntries>,
		bound: { maxSentences: number; maxOutputTokens: number; strict: boolean },
	): Promise<{
		section: AtlasV2WrittenSection | null;
		finishReason: string | null;
		outputTokens: number;
		salvaged: boolean;
	}> => {
		const call = await timePhase("write", () =>
			deps.runWriterModel({
				stage: `write:${section.id}`,
				thinkingMode: "off",
				maxOutputTokens: bound.maxOutputTokens,
				system: bound.strict
					? `${ATLAS_V2_STRICT_JSON_PREFACE[language]}\n${ATLAS_V2_WRITER_SYSTEM[language]}`
					: ATLAS_V2_WRITER_SYSTEM[language],
				prompt: buildAtlasV2SectionPrompt({
					query: job.query,
					profile: job.profile,
					language,
					currentDate: isoDate(now),
					section,
					questions: sectionQuestions(section),
					outline,
					evidence,
					targetWords: sectionBudget.targetWords,
					minSentences: Math.min(
						sectionBudget.minSentences,
						bound.maxSentences,
					),
					maxSentences: bound.maxSentences,
					maxParagraphs: budget.maxParagraphsPerSection,
				}),
			}),
		);
		usage = addUsage(usage, call.usage);
		const finishReason = call.finishReason ?? null;
		const parseOptions = {
			sectionId: section.id,
			title: section.title,
			maxSourceNumber,
			maxSentences: bound.maxSentences,
			maxParagraphs: budget.maxParagraphsPerSection,
		};
		const parsed = parseAtlasV2WrittenSection(call.text, parseOptions);
		if (parsed) {
			return {
				section: parsed,
				finishReason,
				outputTokens: call.usage.outputTokens,
				salvaged: false,
			};
		}
		// A body cut off at the cap is valid JSON up to the cut. Repairing the
		// prefix is free and usually gives back most of the section; a repair
		// worth fewer than two sentences is not worth publishing.
		if (finishReason === "length") {
			const salvaged = salvageAtlasV2WrittenSection(call.text, parseOptions);
			if (
				countAtlasV2SectionSentences(salvaged) >= MIN_SALVAGED_SENTENCES &&
				salvaged
			) {
				return {
					section: salvaged,
					finishReason,
					outputTokens: call.usage.outputTokens,
					salvaged: true,
				};
			}
		}
		return {
			section: null,
			finishReason,
			outputTokens: call.usage.outputTokens,
			salvaged: false,
		};
	};
	/**
	 * The floor under `unparsable_body`: plain text, one sentence per line, each
	 * line ending in its `[n]` citations, parsed deterministically. A truncated
	 * answer still yields a section — the cut line is dropped — so a section with
	 * evidence is never lost to a JSON writer that will not close its braces.
	 */
	const writeSectionAsPlainText = async (
		section: AtlasV2PlanSection,
		evidence: ReturnType<typeof buildWriterEvidenceEntries>,
		maxOutputTokens: number,
	): Promise<AtlasV2WrittenSection | null> => {
		const call = await timePhase("write", () =>
			deps.runWriterModel({
				stage: `write:plain:${section.id}`,
				thinkingMode: "off",
				maxOutputTokens,
				system: ATLAS_V2_PLAIN_TEXT_WRITER_SYSTEM[language],
				prompt: buildAtlasV2PlainTextSectionPrompt({
					query: job.query,
					profile: job.profile,
					language,
					currentDate: isoDate(now),
					section,
					questions: sectionQuestions(section),
					outline,
					evidence,
					targetWords: sectionBudget.targetWords,
					maxSentences: sectionBudget.maxSentences,
				}),
			}),
		);
		usage = addUsage(usage, call.usage);
		return parseAtlasV2PlainTextSection(call.text, {
			sectionId: section.id,
			title: section.title,
			maxSourceNumber,
			maxSentences: sectionBudget.maxSentences,
			truncated: call.finishReason === "length",
		});
	};
	const writtenSections =
		resume.sections ??
		(
			await mapWithConcurrency(
				resolvedPlan.sections,
				writerConcurrency,
				async (section) => {
					const evidence = evidenceBySection.get(section.id) ?? [];
					if (evidence.length === 0) {
						sectionWriteFailures.push({
							sectionId: section.id,
							reason: "no_evidence",
						});
						return null;
					}
					const retryMaxOutputTokens = atlasV2RunawayRetryMaxOutputTokens(
						sectionMaxOutputTokens,
					);
					let lastReason = "unparsable_body";
					let ranAway = false;
					// One retry: a writer answer is a single sample, and the same
					// prompt often parses on the second draw. After a RUNAWAY the
					// retry is tighter rather than identical — a second call at the
					// same bound only truncates at the same place.
					for (let attempt = 0; attempt < 2; attempt += 1) {
						try {
							const result = await writeSectionOnce(section, evidence, {
								maxSentences:
									attempt === 0 || !ranAway
										? sectionBudget.maxSentences
										: Math.max(3, Math.floor(sectionBudget.maxSentences / 2)),
								maxOutputTokens:
									attempt === 0 || !ranAway
										? sectionMaxOutputTokens
										: retryMaxOutputTokens,
								strict: attempt > 0 && ranAway,
							});
							if (result.finishReason === "length") {
								writerRunaways.length += 1;
								ranAway = true;
								console.warn("[ATLAS v2] Writer call hit its output cap", {
									jobId: job.id,
									sectionId: section.id,
									attempt,
									outputTokens: result.outputTokens,
									salvaged: result.salvaged,
								});
							}
							if (result.section) {
								if (result.salvaged) writerRunaways.salvaged += 1;
								return result.section;
							}
							lastReason =
								result.finishReason === "length"
									? "writer_runaway"
									: "unparsable_body";
						} catch (error) {
							lastReason = `writer_call_failed: ${
								error instanceof Error ? error.message : String(error)
							}`;
						}
						if (attempt === 0) {
							writerRunaways.retried += 1;
							console.warn("[ATLAS v2] Retrying a section the writer lost", {
								jobId: job.id,
								sectionId: section.id,
								reason: lastReason,
							});
						}
					}
					// Both JSON attempts failed. The evidence is here, so the section
					// is written from it in a shape no output cap can break.
					try {
						const plain = await writeSectionAsPlainText(
							section,
							evidence,
							retryMaxOutputTokens,
						);
						if (plain) {
							writerRunaways.fallback += 1;
							console.warn("[ATLAS v2] Wrote a section as plain text", {
								jobId: job.id,
								sectionId: section.id,
								reason: lastReason,
							});
							return plain;
						}
						lastReason = `${lastReason}, fallback_empty`;
					} catch (error) {
						lastReason = `${lastReason}, fallback_failed: ${
							error instanceof Error ? error.message : String(error)
						}`;
					}
					sectionWriteFailures.push({
						sectionId: section.id,
						reason: lastReason,
					});
					return null;
				},
			)
		).filter((section): section is AtlasV2WrittenSection => section !== null);

	// The plan promised an outline; anything short of it is a defect, so it is
	// logged with the reason rather than discovered later in a short report.
	sectionCounts = {
		written: writtenSections.length,
		planned: resolvedPlan.sections.length,
	};
	writerRunawayCounts = { ...writerRunaways };
	// Plan order, not the order the concurrent wave happened to finish in, so
	// two runs that lose the same sections report the same list.
	const planOrder = new Map(
		resolvedPlan.sections.map((section, position) => [section.id, position]),
	);
	sectionWriteFailures.sort(
		(left, right) =>
			(planOrder.get(left.sectionId) ?? 0) -
			(planOrder.get(right.sectionId) ?? 0),
	);
	if (
		!resume.sections &&
		writtenSections.length !== resolvedPlan.sections.length
	) {
		console.error("[ATLAS v2] Wrote fewer sections than the plan promised", {
			jobId: job.id,
			profile: job.profile,
			planned: resolvedPlan.sections.length,
			written: writtenSections.length,
			dropped: sectionWriteFailures,
		});
	}

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
					thinkingMode: "off",
					maxOutputTokens: ATLAS_V2_MAX_OUTPUT_TOKENS.entailment,
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
					thinkingMode: "off",
					// One verdict per claim, so the cap scales with the batch — with
					// the same floor a single check gets.
					maxOutputTokens: Math.max(
						ATLAS_V2_MAX_OUTPUT_TOKENS.entailment,
						items.length * 80,
					),
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
					thinkingMode: "off",
					// A rewrite returns only the failed sentences, so it never needs
					// the whole section's budget.
					maxOutputTokens: atlasV2RunawayRetryMaxOutputTokens(
						sectionMaxOutputTokens,
					),
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

	// The length budget is applied to the VERIFIED sections, before the summary
	// is written, so the summary never summarises prose the reader will not see.
	// It only ever TRIMS: a body under the bound is passed through untouched.
	const bodyCap = capAtlasV2SectionsToWordBudget({
		sections: verification.sections,
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
	// A second render heartbeat, AFTER the files exist: the one above is emitted
	// before `renderOutputs` runs, so without this the `render` duration never
	// reached a reader of the progress card at all.
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
				sectionsPlanned: resolvedPlan.sections.length,
				sectionsWritten: writtenSections.length,
				// Empty on a healthy run; one entry per section the writer lost,
				// with why, so a short report names its own cause.
				sectionsDropped: sectionWriteFailures,
				// Zeroes on a healthy run. A non-zero `length` is the writer
				// running to its output cap — the defect that cost the energy
				// report three of its four sections and 1,001s of write time.
				writerRunaways: { ...writerRunaways },
				sourcesDroppedForBudget: capped.droppedForBudget,
				sentencesDroppedForBudget: bodyCap.droppedSentenceCount,
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
		thinkingMode: "off",
		maxOutputTokens: ATLAS_V2_MAX_OUTPUT_TOKENS.summary,
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
	const parseOptions = {
		sectionId: "summary",
		title: "summary",
		maxSourceNumber: input.maxSourceNumber,
	};
	const parsed = parseAtlasV2WrittenSection(call.text, parseOptions);
	if (parsed) return parsed;
	// Same repair the sections get: a summary cut off at the cap is still a
	// summary up to the cut, and losing it costs the report its opening.
	return call.finishReason === "length"
		? salvageAtlasV2WrittenSection(call.text, parseOptions)
		: null;
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

/**
 * A section's own evidence, topped up from the top of the whole index when its
 * questions found too little to write from.
 *
 * A section handed two sources cannot corroborate anything, and the writer,
 * asked for a section's worth of prose from them, either pads or writes from
 * its own knowledge — which the verifier then cuts. The index is ordered
 * best-first, so the top-up is the report's strongest evidence, and the
 * section's own sources always come first so the writer sees them first.
 */
export function sourcesForSectionWithFallback(input: {
	index: AtlasV2EvidenceIndex;
	questionIds: readonly string[];
	minSources: number;
	maxSources: number;
}): AtlasV2IndexedSource[] {
	const own = sourcesForSection(input.index, input.questionIds);
	if (own.length >= input.minSources || own.length >= input.maxSources) {
		return own;
	}
	const taken = new Set(own.map((source) => source.n));
	const topped = [...own];
	for (const source of input.index.sources) {
		if (topped.length >= input.maxSources) break;
		if (taken.has(source.n)) continue;
		taken.add(source.n);
		topped.push(source);
	}
	return topped;
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
