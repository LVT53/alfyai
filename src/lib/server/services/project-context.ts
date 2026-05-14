import {
	getProjectReferenceContext,
	type ProjectReferenceContext,
} from "$lib/server/services/task-state";
import type { ToolEvidenceCandidate } from "$lib/types";

const DEFAULT_MAX_SIBLINGS = 5;
const HARD_MAX_SIBLINGS = 5;

export type ProjectContextMode = "summary";

export type ProjectContextSiblingSummary = {
	conversationId: string;
	title: string;
	objective: string | null;
	summary: string | null;
};

export type ProjectContextResult = {
	success: true;
	mode: ProjectContextMode;
	hasProjectContext: boolean;
	source: ProjectReferenceContext["source"] | "none";
	project: {
		id: string;
		name: string;
		authority: ProjectReferenceContext["source"];
	} | null;
	siblings: ProjectContextSiblingSummary[];
	omittedSiblingCount: number;
	evidenceCandidates: ToolEvidenceCandidate[];
	audit: {
		conversationId: string;
		scope: "conversation";
		requestedMaxSiblings: number | null;
		appliedMaxSiblings: number;
		includeEvidenceCandidates: boolean;
		noProjectReason?: "no_project_context";
	};
};

export type GetProjectContextParams = {
	userId: string;
	conversationId: string;
	mode?: string | null;
	query?: string | null;
	maxSiblings?: number | null;
	includeEvidenceCandidates?: boolean;
};

function normalizeMaxSiblings(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_MAX_SIBLINGS;
	}
	return Math.max(1, Math.min(HARD_MAX_SIBLINGS, Math.floor(value)));
}

function buildEvidenceCandidates(
	siblings: ProjectContextSiblingSummary[],
): ToolEvidenceCandidate[] {
	return siblings
		.filter((sibling) => sibling.summary?.trim())
		.map((sibling) => ({
			id: `conversation-summary:${sibling.conversationId}`,
			title: sibling.title,
			snippet: sibling.summary,
			sourceType: "memory",
		}));
}

export async function getProjectContext(
	params: GetProjectContextParams,
): Promise<ProjectContextResult> {
	const mode = params.mode?.trim() || "summary";
	if (mode !== "summary") {
		throw new Error("Only summary mode is supported for project_context");
	}

	const requestedMaxSiblings =
		typeof params.maxSiblings === "number" && Number.isFinite(params.maxSiblings)
			? params.maxSiblings
			: null;
	const maxSiblings = normalizeMaxSiblings(params.maxSiblings);
	const includeEvidenceCandidates =
		params.includeEvidenceCandidates !== false;

	const reference = await getProjectReferenceContext({
		userId: params.userId,
		conversationId: params.conversationId,
	});

	if (!reference) {
		return {
			success: true,
			mode: "summary",
			hasProjectContext: false,
			source: "none",
			project: null,
			siblings: [],
			omittedSiblingCount: 0,
			evidenceCandidates: [],
			audit: {
				conversationId: params.conversationId,
				scope: "conversation",
				requestedMaxSiblings,
				appliedMaxSiblings: maxSiblings,
				includeEvidenceCandidates,
				noProjectReason: "no_project_context",
			},
		};
	}

	const siblings = reference.entries.slice(0, maxSiblings).map((entry) => ({
		conversationId: entry.conversationId,
		title: entry.title,
		objective: entry.objective,
		summary: entry.summary,
	}));
	const omittedByRequest = Math.max(0, reference.entries.length - siblings.length);
	const omittedSiblingCount = reference.omittedSiblingCount + omittedByRequest;

	return {
		success: true,
		mode: "summary",
		hasProjectContext: true,
		source: reference.source,
		project: {
			id: reference.projectId,
			name: reference.projectName,
			authority: reference.source,
		},
		siblings,
		omittedSiblingCount,
		evidenceCandidates: includeEvidenceCandidates
			? buildEvidenceCandidates(siblings)
			: [],
		audit: {
			conversationId: params.conversationId,
			scope: "conversation",
			requestedMaxSiblings,
			appliedMaxSiblings: maxSiblings,
			includeEvidenceCandidates,
		},
	};
}
