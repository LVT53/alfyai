import type { ArtifactType } from "$lib/server/services/knowledge/types";
import { clamp } from "$lib/utils/math";
import { computeDecayScore } from "../utils/artifact-decay";

export const WORKING_SET_ACTIVE_LIMIT = 64;
const WORKING_SET_DOCUMENT_LIMIT = 48;
const WORKING_SET_OUTPUT_LIMIT = 16;
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

/** The words of a query that `scoreMatch` looks for: three letters or more, a repeated word as often as it is written. */
function matchTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((term) => term.trim())
		.filter((term) => term.length > 2);
}

/** How many of a query's words are found in `haystack`, each at most once. */
export function scoreMatch(query: string, haystack: string): number {
	const terms = matchTerms(query);
	if (terms.length === 0) return 0;
	const target = haystack.toLowerCase();
	return terms.reduce(
		(score, term) => score + (target.includes(term) ? 1 : 0),
		0,
	);
}

/** The most `scoreMatch` can return for `query`: what a score is a share of. */
export function countMatchTerms(query: string): number {
	return matchTerms(query).length;
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
		reasonCodes.push("matched_current_turn");
	}

	// The signals above are the turn's own verdict on the document. When the file
	// was last written says nothing about whether the person is still working with
	// it, so they are not weighed by age. They were: this whole sum went through
	// `computeDecayScore` with the age in SECONDS (exp(-0.011 * age): 0.001 after
	// ten minutes), so a document written more than about two minutes before the
	// refresh fell under the cut of 20 whatever the turn had said about it, and was
	// not carried to the next turn.
	//
	// A match with the message is still weighed by age, exactly as before. It is
	// the weakest reason there is (three-letter pieces of the message found
	// anywhere in the text, so nearly every reply of a chat matches the next
	// question), and with nothing to age it a long chat's own old replies all stay
	// in the working set and the prompt (measured: 16 active, 18 of 20 replies in
	// the prompt after 20 turns).
	const ageSeconds = Math.max(0, (Date.now() - candidate.updatedAt) / 1000);
	score += computeDecayScore({
		importance: matchBoost,
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
	// Equal scores: the document written last first, then by id so the order is
	// the same on every run. Which of a tied crowd the limits below keep is this.
	const ranked = candidates
		.map((candidate) => ({
			item: scoreCandidate(candidate),
			updatedAt: candidate.updatedAt,
		}))
		.sort((a, b) => {
			if (b.item.score !== a.item.score) return b.item.score - a.item.score;
			if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
			return a.item.artifactId.localeCompare(b.item.artifactId);
		})
		.map(({ item }) => item);

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

// Relocated out of the former src/lib/types.ts god-module
// (architecture-deepening T1); these types carry no behavior change, only
// a new home next to the working-set service that owns them.

export type WorkingSetState = "active" | "cooling";

export type WorkingSetReasonCode =
	| "attached_this_turn"
	| "active_document_focus"
	| "recent_user_correction"
	| "recently_refined_document_family"
	| "recent_refinement_behavior"
	| "recent_document_open"
	| "current_generated_document"
	| "recently_used_in_output"
	| "latest_generated_output"
	| "matched_current_turn"
	| "persisted_from_previous_turn"
	| "preferred_artifact";

export interface ConversationWorkingSetItem {
	id: string;
	userId: string;
	conversationId: string;
	artifactId: string;
	artifactType: Exclude<ArtifactType, "work_capsule">;
	score: number;
	state: WorkingSetState;
	reasonCodes: WorkingSetReasonCode[];
	lastActivatedAt: number | null;
	lastUsedAt: number | null;
	createdAt: number;
	updatedAt: number;
}
