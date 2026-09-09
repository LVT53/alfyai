// Atlas v2 knobs (ADR 0062). Per-profile question counts, research rounds and
// page-read depth are constants here; each has an env / admin-config override
// resolved through config-store so a live deployment can retune the pipeline
// without a redeploy.

import {
	getAtlasStaleMonths,
	getAtlasV2ProfileKnobs,
} from "$lib/server/config-store";
import { config as envConfig } from "$lib/server/env";
import type { AtlasProfile } from "../atlas/types";
import { ATLAS_V2_BUDGETS, type AtlasV2Budget } from "./budget";
import type { AtlasPipelineVersion } from "./types";

export const ATLAS_V2_DEFAULT_STALE_MONTHS = 18;

/** Claims per batched entailment call, and the writer's section concurrency. */
export const ATLAS_V2_DEFAULT_ENTAILMENT_BATCH = 10;
/**
 * Sections written at once. Five, so a five-section in-depth plan is written in
 * ONE wave: the second evaluation spent 631s of summed writer time per report
 * at three, which is two waves and roughly twice the wall time of one.
 *
 * NOTE: `ATLAS_V2_WRITER_CONCURRENCY` in env.ts still defaults to 3 and wins
 * over this constant, so a deployment wanting the one-wave behaviour must set
 * that env var (or the admin-config knob) to 5.
 */
export const ATLAS_V2_DEFAULT_WRITER_CONCURRENCY = 5;
/**
 * A question with this many indexed sources is never re-researched, whatever
 * the coverage model says: the third round on an already-answered question was
 * the largest single cost in the first live evaluation.
 */
export const ATLAS_V2_COVERAGE_SUFFICIENT_SOURCES = 3;
/** Limitations lines the disagreement list may occupy. */
export const ATLAS_V2_MAX_CONTRADICTION_LINES = 3;
/**
 * A sentence may cite at most this many sources. Denser citation was the
 * report's worst readability defect: 12-18 markers per 100 words, several of
 * them redundant. Enforced in the verifier (`trimSentenceCitations`) and again
 * at publication (`publishSentenceCitations`), because renumbering can turn two
 * citations into one.
 */
export const ATLAS_V2_MAX_CITATIONS_PER_SENTENCE = 2;

/**
 * Hard bounds on the plan stage. The plan prompt asks for a per-profile
 * count; a model that ignores it is clamped into this band rather than
 * allowed to produce a 40-question research run.
 */
export const ATLAS_V2_MIN_QUESTIONS = 4;
export const ATLAS_V2_MAX_QUESTIONS = 20;
export const ATLAS_V2_MIN_SECTIONS = 2;
export const ATLAS_V2_MAX_SECTIONS = 10;

/**
 * Per-stage output caps, in tokens.
 *
 * Every v2 stage asks for a small, structured JSON answer, so none of them has
 * any business producing thousands of tokens. Without a cap the section writer
 * on the local model ran to the provider's own 16,000-token ceiling, finished
 * with `length`, and left a body of JSON that could not be closed — which is
 * how a four-section report shipped with one section and a 1,001-second write
 * phase. The caps below are sized to the task; a call that hits one is a
 * runaway, and the writer treats it as one (salvage, then retry, then a
 * plain-text fallback) rather than discarding the section.
 */
export const ATLAS_V2_MAX_OUTPUT_TOKENS = {
	plan: 1500,
	coverage: 800,
	summary: 2500,
	entailment: 800,
} as const;

/**
 * Tokens per word of target prose, for the section writer's cap. The writer's
 * answer is a sentence-level JSON envelope — `text`, `citations`, `inferred`,
 * `calcId` per sentence — which costs roughly four tokens per word of prose
 * once the keys, braces and quoting are counted.
 */
export const ATLAS_V2_SECTION_TOKENS_PER_WORD = 4;
export const ATLAS_V2_SECTION_MIN_OUTPUT_TOKENS = 1500;
export const ATLAS_V2_SECTION_MAX_OUTPUT_TOKENS = 6000;

/** The output cap for one section body, derived from its word target. */
export function atlasV2SectionMaxOutputTokens(targetWords: number): number {
	const derived = Math.round(
		Math.max(0, targetWords) * ATLAS_V2_SECTION_TOKENS_PER_WORD,
	);
	return clamp(
		derived,
		ATLAS_V2_SECTION_MIN_OUTPUT_TOKENS,
		ATLAS_V2_SECTION_MAX_OUTPUT_TOKENS,
	);
}

/**
 * The cap the ONE runaway retry uses: 30% below the cap that ran away, but
 * never below the floor. A second call at the same cap only buys a second
 * truncation at the same place.
 */
export function atlasV2RunawayRetryMaxOutputTokens(
	maxOutputTokens: number,
): number {
	return Math.max(
		ATLAS_V2_SECTION_MIN_OUTPUT_TOKENS,
		Math.round(maxOutputTokens * 0.7),
	);
}

export interface AtlasV2ProfileConfig {
	/** Research questions the plan stage should produce. */
	questions: number;
	/** Bounded research rounds (round 1 is the initial sweep). */
	rounds: number;
	/** `readPages` passed to the research_web path per question. */
	readPages: number;
	/** Keyword search queries sent per question per round. */
	queriesPerQuestion: number;
	/** Cap on indexed sources handed to one section's writer call. */
	maxSourcesPerSection: number;
	/** Cap on indexed sources carried into the write phase at all. */
	maxIndexedSources: number;
	/** Length and section budget for this profile (see budget.ts). */
	budget: AtlasV2Budget;
	/** v2 never renders images; the stock-image defect is fixed by omission. */
	allowImages: false;
	/**
	 * The exhaustive profile's last round hunts for figures that disagree with
	 * what earlier rounds found, so the verifier has something to compare.
	 */
	contradictionHuntOnLastRound: boolean;
}

const ATLAS_V2_PROFILE_BASE: Record<
	AtlasProfile,
	Omit<
		AtlasV2ProfileConfig,
		"questions" | "rounds" | "maxIndexedSources" | "budget"
	>
> = {
	overview: {
		readPages: ATLAS_V2_BUDGETS.overview.readPages,
		queriesPerQuestion: 2,
		maxSourcesPerSection: 12,
		allowImages: false,
		contradictionHuntOnLastRound: false,
	},
	"in-depth": {
		readPages: ATLAS_V2_BUDGETS["in-depth"].readPages,
		queriesPerQuestion: 3,
		maxSourcesPerSection: 16,
		allowImages: false,
		contradictionHuntOnLastRound: false,
	},
	exhaustive: {
		readPages: ATLAS_V2_BUDGETS.exhaustive.readPages,
		queriesPerQuestion: 3,
		maxSourcesPerSection: 20,
		allowImages: false,
		contradictionHuntOnLastRound: true,
	},
};

/** Defaults before env/admin overrides; exported for tests and docs. */
export const ATLAS_V2_DEFAULT_QUESTIONS: Record<AtlasProfile, number> = {
	overview: 6,
	"in-depth": 10,
	exhaustive: 16,
};

export const ATLAS_V2_DEFAULT_ROUNDS: Record<AtlasProfile, number> = {
	overview: 1,
	"in-depth": 2,
	exhaustive: 3,
};

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function getAtlasV2ProfileConfig(
	profile: AtlasProfile,
	overrides?: {
		questions?: number;
		rounds?: number;
	},
): AtlasV2ProfileConfig {
	const knobs = overrides ? null : safeProfileKnobs();
	const questions =
		overrides?.questions ??
		(profile === "overview"
			? knobs?.questions.overview
			: profile === "in-depth"
				? knobs?.questions.inDepth
				: knobs?.questions.exhaustive) ??
		ATLAS_V2_DEFAULT_QUESTIONS[profile];
	const rounds =
		overrides?.rounds ??
		(profile === "overview"
			? knobs?.rounds.overview
			: profile === "in-depth"
				? knobs?.rounds.inDepth
				: knobs?.rounds.exhaustive) ??
		ATLAS_V2_DEFAULT_ROUNDS[profile];
	const budget = resolveAtlasV2Budget(profile);
	return {
		...ATLAS_V2_PROFILE_BASE[profile],
		questions: clamp(questions, ATLAS_V2_MIN_QUESTIONS, ATLAS_V2_MAX_QUESTIONS),
		rounds: clamp(rounds, 1, 4),
		maxIndexedSources: budget.maxIndexedSources,
		budget,
	};
}

function safeEnvNumber(read: () => number | undefined): number | undefined {
	try {
		const value = read();
		return typeof value === "number" && Number.isFinite(value) && value > 0
			? Math.trunc(value)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * The per-profile budget, with the two operationally interesting numbers —
 * the word ceiling and the indexed-source cap — overridable from the
 * environment so a live deployment can retune length without a redeploy.
 */
export function resolveAtlasV2Budget(profile: AtlasProfile): AtlasV2Budget {
	const base = ATLAS_V2_BUDGETS[profile];
	const maxWords = safeEnvNumber(() =>
		profile === "overview"
			? envConfig.atlasV2MaxWordsOverview
			: profile === "in-depth"
				? envConfig.atlasV2MaxWordsInDepth
				: envConfig.atlasV2MaxWordsExhaustive,
	);
	const maxSources = safeEnvNumber(() =>
		profile === "overview"
			? envConfig.atlasV2MaxSourcesOverview
			: profile === "in-depth"
				? envConfig.atlasV2MaxSourcesInDepth
				: envConfig.atlasV2MaxSourcesExhaustive,
	);
	return {
		...base,
		maxWords: maxWords ?? base.maxWords,
		minWords: Math.min(base.minWords, maxWords ?? base.maxWords),
		maxIndexedSources: maxSources ?? base.maxIndexedSources,
	};
}

/** Claims per batched entailment call. */
export function getAtlasV2EntailmentBatchSize(): number {
	return clamp(
		safeEnvNumber(() => envConfig.atlasV2EntailmentBatch) ??
			ATLAS_V2_DEFAULT_ENTAILMENT_BATCH,
		1,
		25,
	);
}

/** Sections written in parallel. */
export function getAtlasV2WriterConcurrency(): number {
	return clamp(
		safeEnvNumber(() => envConfig.atlasV2WriterConcurrency) ??
			ATLAS_V2_DEFAULT_WRITER_CONCURRENCY,
		1,
		8,
	);
}

// The knob reader touches the runtime config singleton, which is not
// initialised in every unit-test process. Falling back to the constants keeps
// pure evidence/verifier tests independent of config-store bootstrapping.
function safeProfileKnobs(): ReturnType<typeof getAtlasV2ProfileKnobs> | null {
	try {
		return getAtlasV2ProfileKnobs();
	} catch {
		return null;
	}
}

/** Months after which a statistic is reported as stale in Limitations. */
export function getAtlasV2StaleMonths(): number {
	try {
		return getAtlasStaleMonths();
	} catch {
		return ATLAS_V2_DEFAULT_STALE_MONTHS;
	}
}

/**
 * Resolves the pipeline a job runs on. The stamped `pipeline_version` on the
 * row wins over the current flag, so flipping ATLAS_PIPELINE never re-routes a
 * queued job or splits a lifecycle family across pipelines.
 */
export function resolveAtlasPipelineVersion(input: {
	stampedPipelineVersion?: number | null;
	flag?: "v1" | "v2";
}): AtlasPipelineVersion {
	if (input.stampedPipelineVersion === 2) return 2;
	if (input.stampedPipelineVersion === 1) return 1;
	return input.flag === "v2" ? 2 : 1;
}

/** The `pipeline_version` a NEW job row is stamped with. */
export function atlasPipelineVersionForNewJob(input: {
	flag?: "v1" | "v2";
	/** A lifecycle child stays on its parent's pipeline. */
	parentPipelineVersion?: number | null;
}): AtlasPipelineVersion {
	if (input.parentPipelineVersion === 2) return 2;
	if (input.parentPipelineVersion === 1) return 1;
	return input.flag === "v2" ? 2 : 1;
}
