// Atlas v2 knobs (ADR 0062). Per-profile question counts, research rounds and
// page-read depth are constants here; each has an env / admin-config override
// resolved through config-store so a live deployment can retune the pipeline
// without a redeploy.

import {
	getAtlasStaleMonths,
	getAtlasV2ProfileKnobs,
} from "$lib/server/config-store";
import { MAX_RESEARCH_WEB_READ_PAGES } from "$lib/server/services/normal-chat-tools/research-web";
import type { AtlasProfile } from "../atlas/types";
import type { AtlasPipelineVersion } from "./types";

export const ATLAS_V2_DEFAULT_STALE_MONTHS = 18;

/**
 * Hard bounds on the plan stage. The plan prompt asks for a per-profile
 * count; a model that ignores it is clamped into this band rather than
 * allowed to produce a 40-question research run.
 */
export const ATLAS_V2_MIN_QUESTIONS = 4;
export const ATLAS_V2_MAX_QUESTIONS = 20;
export const ATLAS_V2_MIN_SECTIONS = 2;
export const ATLAS_V2_MAX_SECTIONS = 10;

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
	Omit<AtlasV2ProfileConfig, "questions" | "rounds">
> = {
	overview: {
		readPages: 1,
		queriesPerQuestion: 2,
		maxSourcesPerSection: 12,
		allowImages: false,
		contradictionHuntOnLastRound: false,
	},
	"in-depth": {
		readPages: 2,
		queriesPerQuestion: 3,
		maxSourcesPerSection: 16,
		allowImages: false,
		contradictionHuntOnLastRound: false,
	},
	exhaustive: {
		readPages: MAX_RESEARCH_WEB_READ_PAGES,
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
	return {
		...ATLAS_V2_PROFILE_BASE[profile],
		questions: clamp(questions, ATLAS_V2_MIN_QUESTIONS, ATLAS_V2_MAX_QUESTIONS),
		rounds: clamp(rounds, 1, 4),
	};
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
