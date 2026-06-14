import type {
	ArtifactType,
	WorkingSetReasonCode,
	WorkingSetState,
} from "$lib/types";
import { clamp } from "$lib/utils/math";
import { computeDecayScore } from "../utils/artifact-decay";

export const WORKING_SET_ACTIVE_LIMIT = 64;
export const WORKING_SET_DOCUMENT_LIMIT = 48;
export const WORKING_SET_OUTPUT_LIMIT = 16;
export const WORKING_SET_PROMPT_LIMIT = 64;

export interface WorkingSetCandidate {
	artifactId: string;
	artifactType: Exclude<ArtifactType, "work_capsule">;
	name: string;
	summary: string | null;
	contentText: string | null;
	updatedAt: number;
	isAttachedThisTurn?: boolean;
	isActiveDocumentFocus?: boolean;
	isRecentUserCorrection?: boolean;
	isRecentlyRefinedDocumentFamily?: boolean;
	isCurrentGeneratedDocument?: boolean;
	messageMatchScore?: number;
}

export interface RankedWorkingSetItem {
	artifactId: string;
	artifactType: Exclude<ArtifactType, "work_capsule">;
	score: number;
	state: WorkingSetState;
	reasonCodes: WorkingSetReasonCode[];
	selected: boolean;
}

export function scoreMatch(query: string, haystack: string): number {
	const terms = query
		.toLowerCase()
		.split(/\\s+/)
		.map((term) => term.trim())
		.filter((term) => term.length > 2);
	if (terms.length === 0) return 0;
	const target = haystack.toLowerCase();
	return terms.reduce(
		(score, term) => score + (target.includes(term) ? 1 : 0),
		0,
	);
}

function scoreCandidate(candidate: WorkingSetCandidate): RankedWorkingSetItem {
	const reasonCodes: WorkingSetReasonCode[] = [];
	let score = 0;

	if (candidate.isAttachedThisTurn) {
		score += 100;
		reasonCodes.push("attached_this_turn");
	}

	if (candidate.isActiveDocumentFocus) {
		score += 92;
		reasonCodes.push("active_document_focus");
	}

	if (candidate.isRecentUserCorrection) {
		score += 62;
		reasonCodes.push("recent_user_correction");
	}

	if (candidate.isRecentlyRefinedDocumentFamily) {
		score += 58;
		reasonCodes.push("recently_refined_document_family");
	}

	if (candidate.isCurrentGeneratedDocument) {
		score += 54;
		reasonCodes.push("current_generated_document");
	}

	const matchBoost = clamp((candidate.messageMatchScore ?? 0) * 15, 0, 60);
	if (matchBoost > 0) {
		score += matchBoost;
		reasonCodes.push("matched_current_turn");
	}

	const ageSeconds = Math.max(0, (Date.now() - candidate.updatedAt) / 1000);
	score = computeDecayScore({
		importance: score,
		ageSeconds,
		staleSeconds: ageSeconds,
		queryOverlap: candidate.messageMatchScore ?? 0,
		queryLength: candidate.messageMatchScore ? 1 : 0,
		decayRate: 0.001,
	});

	return {
		artifactId: candidate.artifactId,
		artifactType: candidate.artifactType,
		score,
		state: "cooling",
		reasonCodes,
		selected: false,
	};
}

export function rankWorkingSetCandidates(
	candidates: WorkingSetCandidate[],
): RankedWorkingSetItem[] {
	const ranked = candidates.map(scoreCandidate).sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.artifactId.localeCompare(b.artifactId);
	});

	const selectedIds = new Set<string>();
	let documentCount = 0;
	let outputCount = 0;

	for (const item of ranked) {
		if (selectedIds.size >= WORKING_SET_ACTIVE_LIMIT) break;
		if (item.score < 20) continue;

		if (item.artifactType === "generated_output") {
			if (outputCount >= WORKING_SET_OUTPUT_LIMIT) continue;
			outputCount += 1;
		} else {
			if (documentCount >= WORKING_SET_DOCUMENT_LIMIT) continue;
			documentCount += 1;
		}

		selectedIds.add(item.artifactId);
	}

	return ranked.map((item) => ({
		...item,
		selected: selectedIds.has(item.artifactId),
		state: selectedIds.has(item.artifactId) ? "active" : "cooling",
	}));
}
