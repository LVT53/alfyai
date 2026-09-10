// Atlas v3 knobs (ADR 0063).
//
// Every number here has an env / admin-config override resolved through
// config-store, so a live deployment can retune the pipeline without a
// redeploy, and every read is wrapped so a unit-test process that never
// bootstrapped the config singleton falls back to the constant.

import type { ModelId } from "$lib/model-types";
import {
	getAtlasStaleMonths,
	getAtlasV3Knobs,
	getAtlasV3TaskModels,
} from "$lib/server/config-store";
import type { AtlasProfile } from "../atlas/types";

export const ATLAS_V3_DEFAULT_STALE_MONTHS = 18;

/**
 * Which model runs which stage. `ask`, `outline`, `critic` and `verifier` are
 * control-shaped (small, structured, deterministic); `researcher` and `writer`
 * are synthesis-shaped. The fallback column says which of the two existing
 * Atlas model keys a task inherits when its own key is unset.
 */
export const ATLAS_V3_MODEL_TASKS = [
	"ask",
	"researcher",
	"outline",
	"writer",
	"critic",
	"verifier",
] as const;
export type AtlasV3ModelTask = (typeof ATLAS_V3_MODEL_TASKS)[number];

const ATLAS_V3_TASK_FALLBACK: Record<AtlasV3ModelTask, "synthesis" | "audit"> =
	{
		ask: "audit",
		researcher: "synthesis",
		outline: "audit",
		writer: "synthesis",
		critic: "audit",
		verifier: "audit",
	};

export interface AtlasV3ModelSelection {
	task: AtlasV3ModelTask;
	model: ModelId;
	/** True when the task's own key was set rather than inherited. */
	explicit: boolean;
}

/**
 * The model for one stage: the task's own key when set, else the synthesis or
 * audit model the task's shape inherits. Resolution goes through the SAME
 * `runAtlasModelStage` boundary v2 uses (see worker-bindings.ts), so pricing,
 * usage normalisation and provider failover are identical for both pipelines.
 */
export function resolveAtlasV3TaskModel(input: {
	task: AtlasV3ModelTask;
	synthesisModel: ModelId;
	auditModel: ModelId;
	/** Test seam; production reads config-store. */
	taskModels?: Partial<Record<AtlasV3ModelTask, ModelId | null>>;
}): AtlasV3ModelSelection {
	const configured =
		input.taskModels?.[input.task] ?? safeTaskModels()?.[input.task] ?? null;
	if (configured) {
		return { task: input.task, model: configured, explicit: true };
	}
	const fallback =
		ATLAS_V3_TASK_FALLBACK[input.task] === "synthesis"
			? input.synthesisModel
			: input.auditModel;
	return { task: input.task, model: fallback, explicit: false };
}

function safeTaskModels(): Partial<
	Record<AtlasV3ModelTask, ModelId | null>
> | null {
	try {
		return getAtlasV3TaskModels();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Output caps
// ---------------------------------------------------------------------------

/**
 * Per-stage output caps, in tokens. Same discipline as v2: every v3 stage asks
 * for a small flat JSON answer, so a call that ends at its cap is a runaway and
 * is treated as one (salvage, then a tighter retry, then a plain-text floor).
 */
export const ATLAS_V3_MAX_OUTPUT_TOKENS = {
	ask: 900,
	researchNote: 2200,
	memo: 1600,
	outline: 1600,
	answerTable: 2000,
	verdict: 1200,
	critic: 1800,
	entailment: 800,
	trialWrite: 700,
} as const;

/** Tokens per word of prose in the writer's sentence-level JSON envelope. */
export const ATLAS_V3_SECTION_TOKENS_PER_WORD = 4;
export const ATLAS_V3_SECTION_MIN_OUTPUT_TOKENS = 1500;
export const ATLAS_V3_SECTION_MAX_OUTPUT_TOKENS = 6000;

export function atlasV3SectionMaxOutputTokens(targetWords: number): number {
	return clamp(
		Math.round(Math.max(0, targetWords) * ATLAS_V3_SECTION_TOKENS_PER_WORD),
		ATLAS_V3_SECTION_MIN_OUTPUT_TOKENS,
		ATLAS_V3_SECTION_MAX_OUTPUT_TOKENS,
	);
}

/** The cap the ONE runaway retry uses: 30% below the cap that ran away. */
export function atlasV3RunawayRetryMaxOutputTokens(
	maxOutputTokens: number,
): number {
	return Math.max(
		ATLAS_V3_SECTION_MIN_OUTPUT_TOKENS,
		Math.round(maxOutputTokens * 0.7),
	);
}

// ---------------------------------------------------------------------------
// Profile configuration
// ---------------------------------------------------------------------------

export interface AtlasV3ProfileConfig {
	/** Research rounds the profile budgets for; the GOAL TEST stops earlier. */
	rounds: number;
	/** Sub-questions fanned out per round. */
	subQuestionsPerRound: number;
	/** Pages read per sub-question, spent top-tier first. */
	pagesPerQuestion: number;
	/** Searches one researcher step issues at once (3-5). */
	searchesPerStep: number;
	/** Independent research passes merged at memo level (exhaustive: 3). */
	researchPasses: number;
	minSections: number;
	maxSections: number;
	minWords: number;
	maxWords: number;
	/** Words held back for the verdict and Limitations. */
	chromeReserveWords: number;
	maxSentencesPerSection: number;
	maxParagraphsPerSection: number;
	/** Quote ids handed to one writer call. */
	maxEvidencePerSection: number;
	/** Bound quote ids below which an outline node counts as thin. */
	minEvidencePerNode: number;
	/** Sources the bank may carry into the write phase. */
	maxSources: number;
}

const ATLAS_V3_PROFILE_BASE: Record<AtlasProfile, AtlasV3ProfileConfig> = {
	overview: {
		rounds: 1,
		subQuestionsPerRound: 4,
		pagesPerQuestion: 2,
		searchesPerStep: 3,
		researchPasses: 1,
		minSections: 4,
		maxSections: 6,
		minWords: 700,
		maxWords: 1100,
		chromeReserveWords: 150,
		maxSentencesPerSection: 14,
		maxParagraphsPerSection: 4,
		maxEvidencePerSection: 12,
		minEvidencePerNode: 2,
		maxSources: 20,
	},
	"in-depth": {
		rounds: 3,
		subQuestionsPerRound: 5,
		pagesPerQuestion: 3,
		searchesPerStep: 4,
		researchPasses: 1,
		minSections: 5,
		maxSections: 8,
		minWords: 1800,
		maxWords: 2800,
		chromeReserveWords: 200,
		maxSentencesPerSection: 24,
		maxParagraphsPerSection: 5,
		maxEvidencePerSection: 16,
		minEvidencePerNode: 3,
		maxSources: 40,
	},
	exhaustive: {
		rounds: 3,
		subQuestionsPerRound: 6,
		pagesPerQuestion: 4,
		searchesPerStep: 5,
		researchPasses: 3,
		minSections: 6,
		maxSections: 10,
		minWords: 3500,
		maxWords: 5500,
		chromeReserveWords: 260,
		maxSentencesPerSection: 36,
		maxParagraphsPerSection: 6,
		maxEvidencePerSection: 20,
		minEvidencePerNode: 3,
		maxSources: 80,
	},
};

export const ATLAS_V3_DEFAULT_CRITIC_ROUNDS = 2;
export const ATLAS_V3_MAX_CRITIC_ROUNDS = 3;
export const ATLAS_V3_DEFAULT_RESEARCHER_CONCURRENCY = 3;
/** Sentences a section may cite the same evidence set for; see critic.ts. */
export const ATLAS_V3_MAX_EVIDENCE_PER_SENTENCE = 3;
/** Words the verdict must state the answer inside of. */
export const ATLAS_V3_VERDICT_WINDOW_WORDS = 150;
/** Independent publishers a core figure needs before the goal test passes. */
export const ATLAS_V3_INDEPENDENT_PUBLISHERS = 2;

export function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function getAtlasV3ProfileConfig(
	profile: AtlasProfile,
	overrides?: Partial<AtlasV3ProfileConfig>,
): AtlasV3ProfileConfig {
	const base = ATLAS_V3_PROFILE_BASE[profile];
	const knobs = safeKnobs();
	const pagesPerQuestion =
		profile === "overview"
			? knobs?.pagesPerQuestion.overview
			: profile === "in-depth"
				? knobs?.pagesPerQuestion.inDepth
				: knobs?.pagesPerQuestion.exhaustive;
	const merged: AtlasV3ProfileConfig = {
		...base,
		pagesPerQuestion: pagesPerQuestion ?? base.pagesPerQuestion,
		searchesPerStep: knobs?.searchesPerStep ?? base.searchesPerStep,
		...overrides,
	};
	return {
		...merged,
		rounds: clamp(merged.rounds, 1, 4),
		subQuestionsPerRound: clamp(merged.subQuestionsPerRound, 1, 10),
		pagesPerQuestion: clamp(merged.pagesPerQuestion, 0, 6),
		// The adapter's own excerpt budget makes fewer than three searches per
		// step wasteful and more than five noisy; the direction fixes the band.
		searchesPerStep: clamp(merged.searchesPerStep, 3, 5),
		researchPasses: clamp(merged.researchPasses, 1, 3),
		minSections: clamp(merged.minSections, 2, 10),
		maxSections: clamp(merged.maxSections, merged.minSections, 12),
		minEvidencePerNode: clamp(merged.minEvidencePerNode, 1, 8),
	};
}

/** Critic rounds, bounded to three whatever the config says. */
export function getAtlasV3CriticRounds(): number {
	return clamp(
		safeKnobs()?.criticRounds ?? ATLAS_V3_DEFAULT_CRITIC_ROUNDS,
		0,
		ATLAS_V3_MAX_CRITIC_ROUNDS,
	);
}

/** Isolated researcher calls in flight at once. */
export function getAtlasV3ResearcherConcurrency(): number {
	return clamp(
		safeKnobs()?.researcherConcurrency ??
			ATLAS_V3_DEFAULT_RESEARCHER_CONCURRENCY,
		1,
		8,
	);
}

/** Whether the Hungarian language standard is applied. */
export function getAtlasV3HungarianStandardEnabled(): boolean {
	return safeKnobs()?.languageStandardHu ?? true;
}

export function getAtlasV3StaleMonths(): number {
	try {
		return getAtlasStaleMonths();
	} catch {
		return ATLAS_V3_DEFAULT_STALE_MONTHS;
	}
}

function safeKnobs(): ReturnType<typeof getAtlasV3Knobs> | null {
	try {
		return getAtlasV3Knobs();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Word budgets
// ---------------------------------------------------------------------------

/** Words the section bodies may use once the chrome reserve is subtracted. */
export function atlasV3BodyWordBudget(config: AtlasV3ProfileConfig): number {
	return Math.max(200, config.maxWords - config.chromeReserveWords);
}

/** What the bodies AIM at: the band's midpoint, less the chrome reserve. */
export function atlasV3BodyWordTarget(config: AtlasV3ProfileConfig): number {
	const midpoint = Math.round((config.minWords + config.maxWords) / 2);
	return Math.max(200, midpoint - config.chromeReserveWords);
}

export const ATLAS_V3_AVERAGE_SENTENCE_WORDS = 20;

export interface AtlasV3SectionBudget {
	targetWords: number;
	minSentences: number;
	maxSentences: number;
	maxParagraphs: number;
}

/** The budget handed to ONE writer call, derived from the sections planned. */
export function atlasV3SectionBudget(input: {
	config: AtlasV3ProfileConfig;
	sectionCount: number;
}): AtlasV3SectionBudget {
	const sections = Math.max(1, input.sectionCount);
	const share = Math.max(
		60,
		Math.round(atlasV3BodyWordTarget(input.config) / sections),
	);
	const shareSentences = Math.max(
		3,
		Math.round(share / ATLAS_V3_AVERAGE_SENTENCE_WORDS),
	);
	const maxSentences = Math.max(
		4,
		Math.min(
			input.config.maxSentencesPerSection,
			Math.ceil(shareSentences * 1.3),
		),
	);
	const targetWords = Math.min(
		share,
		maxSentences * ATLAS_V3_AVERAGE_SENTENCE_WORDS,
	);
	return {
		targetWords,
		minSentences: Math.max(
			3,
			Math.min(
				maxSentences,
				Math.round(targetWords / ATLAS_V3_AVERAGE_SENTENCE_WORDS) - 2,
			),
		),
		maxSentences,
		maxParagraphs: input.config.maxParagraphsPerSection,
	};
}
