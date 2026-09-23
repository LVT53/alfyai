// Reading Atlas v3's own checkpoints back (ADR 0063).
//
// Two readers need the same parse: a job resuming itself after a restart, and
// a lifecycle child seeding from its parent (seed.ts). Both live here so the
// pipeline and the seed agree on what a checkpoint row means, and so the seed
// does not have to import the pipeline to read one.

import {
	ATLAS_V3_CHECKPOINT_SCHEMA_VERSION,
	type AtlasV3AnswerTable,
	type AtlasV3Ask,
	type AtlasV3EvidenceBank,
	type AtlasV3Memo,
	type AtlasV3Outline,
	type AtlasV3SeedDiagnostics,
	type AtlasV3WrittenSection,
} from "./types";

/** Checkpoint `roundNumber` per phase, so a resume can find the latest. */
export const ATLAS_V3_CHECKPOINT_ROUND = {
	ask: 1,
	/** Research round r is `research + r`; round 0 (`research` itself) is the seed. */
	research: 10,
	outline: 20,
	answer: 21,
	write: 22,
	critic: 23,
	verify: 24,
	render: 25,
} as const;

/**
 * What a lifecycle child's seeding produced, kept on its round-0 research
 * checkpoint so a retry resumes it instead of rechecking the parent again.
 */
export interface AtlasV3SeedCheckpoint {
	/** The parent's outline, filtered to the evidence that survived. */
	outline: AtlasV3Outline | null;
	/** `entity metric period` hints for evidence that could not be rechecked. */
	hints: string[];
	diagnostics: AtlasV3SeedDiagnostics;
}

export interface AtlasV3ResumeState {
	ask?: AtlasV3Ask;
	bank?: AtlasV3EvidenceBank;
	memo?: AtlasV3Memo;
	completedRounds?: number;
	askedQuestions?: string[];
	outline?: AtlasV3Outline;
	answerTable?: AtlasV3AnswerTable | null;
	sections?: AtlasV3WrittenSection[];
	/** From the round-0 research checkpoint a seeded child writes. */
	seed?: AtlasV3SeedCheckpoint;
	/** The capped bank the verify checkpoint snapshots (Phase D on). */
	verifiedBank?: AtlasV3EvidenceBank;
	/** Source ids the rendered report cited (render checkpoint, Phase D on). */
	citedSourceIds?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readSeedCheckpoint(value: unknown): AtlasV3SeedCheckpoint | undefined {
	if (!isRecord(value) || !isRecord(value.diagnostics)) return undefined;
	return {
		outline: isRecord(value.outline)
			? (value.outline as unknown as AtlasV3Outline)
			: null,
		hints: Array.isArray(value.hints)
			? value.hints.filter((hint): hint is string => typeof hint === "string")
			: [],
		diagnostics: value.diagnostics as unknown as AtlasV3SeedDiagnostics,
	};
}

/**
 * Rebuilds what earlier phases produced from the durable checkpoints. Anything
 * that does not parse is simply not resumed — the phase runs again, which is
 * always correct and only ever costs time.
 */
export function readAtlasV3ResumeState(
	checkpoints: Array<{ roundNumber: number; checkpoint: unknown }>,
): AtlasV3ResumeState {
	const state: AtlasV3ResumeState = {};
	for (const entry of [...checkpoints].sort(
		(left, right) => left.roundNumber - right.roundNumber,
	)) {
		if (!isRecord(entry.checkpoint)) continue;
		if (entry.checkpoint.schema !== ATLAS_V3_CHECKPOINT_SCHEMA_VERSION)
			continue;
		const data = isRecord(entry.checkpoint.data) ? entry.checkpoint.data : {};
		switch (entry.checkpoint.phase) {
			case "ask":
				if (isRecord(data.ask)) state.ask = data.ask as unknown as AtlasV3Ask;
				break;
			case "research":
				if (isRecord(data.bank)) {
					state.bank = data.bank as unknown as AtlasV3EvidenceBank;
				}
				if (isRecord(data.memo)) {
					state.memo = data.memo as unknown as AtlasV3Memo;
				}
				if (typeof data.round === "number") state.completedRounds = data.round;
				if (Array.isArray(data.asked)) {
					state.askedQuestions = data.asked as string[];
				}
				if (data.seed !== undefined) {
					const seed = readSeedCheckpoint(data.seed);
					if (seed) state.seed = seed;
				}
				break;
			case "outline":
				if (isRecord(data.outline)) {
					state.outline = data.outline as unknown as AtlasV3Outline;
				}
				break;
			case "answer":
				state.answerTable = isRecord(data.answerTable)
					? (data.answerTable as unknown as AtlasV3AnswerTable)
					: null;
				break;
			case "write":
				if (Array.isArray(data.sections)) {
					state.sections = data.sections as AtlasV3WrittenSection[];
				}
				break;
			case "verify":
				if (isRecord(data.bank)) {
					state.verifiedBank = data.bank as unknown as AtlasV3EvidenceBank;
				}
				break;
			case "render":
				if (Array.isArray(data.citedSourceIds)) {
					state.citedSourceIds = data.citedSourceIds.filter(
						(id): id is string => typeof id === "string",
					);
				}
				break;
			default:
				break;
		}
	}
	return state;
}
