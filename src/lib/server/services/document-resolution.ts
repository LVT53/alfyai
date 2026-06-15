import {
	parseWorkingDocumentMetadata,
	selectLatestGeneratedDocumentCandidatesByFamily,
} from "$lib/server/services/knowledge/store";
import type { Artifact, WorkingSetReasonCode } from "$lib/types";
import { scoreMatch } from "./working-set";

export interface GeneratedDocumentResolution {
	artifact: Artifact;
	familyId: string | null;
	score: number;
	reasonCodes: string[];
}

export interface CurrentGeneratedDocumentSelection {
	primaryArtifactId: string | null;
	latestArtifactIds: string[];
	latestArtifacts: Artifact[];
	primaryReasonCodes: WorkingSetReasonCode[];
}

export interface RelevantGeneratedDocumentSelection {
	orderedArtifacts: Artifact[];
	primaryArtifactId: string | null;
	primaryReasonCodes: string[];
	resolutions: GeneratedDocumentResolution[];
}

type GeneratedArtifactMatchParams = {
	artifacts: Artifact[];
	query: string;
	currentConversationId?: string | null;
	behaviorScoresByKey?: Map<string, number>;
	reopenScoresByKey?: Map<string, number>;
	semanticScoresByArtifactId?: Map<string, number>;
	rerankScoresByArtifactId?: Map<string, number>;
};

const GENERATED_QUERY_MATCH_REASONS = new Set([
	"matched_query",
	"matched_document_label",
	"matched_artifact_name",
	"matched_generated_filename",
	"matched_document_role",
]);

function isGeneratedDocumentSourceReady(artifact: Artifact): boolean {
	if (artifact.type !== "generated_output") {
		return true;
	}

	const metadata = artifact.metadata ?? {};
	const status = metadata.generatedDocumentSourceStatus;
	if (typeof status === "string") {
		return status === "succeeded";
	}

	return !(
		metadata.generatedDocumentSourceVersion !== undefined &&
		typeof metadata.sourceChatFileId !== "string"
	);
}

function includesNormalized(haystack: string, needle: string): boolean {
	const normalizedHaystack = haystack.trim().toLowerCase();
	const normalizedNeedle = needle.trim().toLowerCase();
	if (!normalizedHaystack || !normalizedNeedle) return false;
	return normalizedHaystack.includes(normalizedNeedle);
}

export function getDocumentBehaviorKey(
	artifact: Pick<Artifact, "id" | "metadata">,
): string {
	const metadata = parseWorkingDocumentMetadata(artifact.metadata);
	return metadata.documentFamilyId ?? artifact.id;
}

export const getGeneratedDocumentBehaviorKey = getDocumentBehaviorKey;

function scoreGeneratedDocumentArtifact(params: {
	artifact: Artifact;
	query: string;
	currentConversationId?: string | null;
	behaviorScoresByKey?: Map<string, number>;
	reopenScoresByKey?: Map<string, number>;
	semanticScoresByArtifactId?: Map<string, number>;
	rerankScoresByArtifactId?: Map<string, number>;
}): GeneratedDocumentResolution {
	const metadata = parseWorkingDocumentMetadata(params.artifact.metadata);
	const behaviorKey = getDocumentBehaviorKey(params.artifact);
	const label = metadata.documentLabel ?? params.artifact.name;
	const role = metadata.documentRole ?? "";
	const generatedFilename =
		typeof params.artifact.metadata?.generatedFilename === "string"
			? params.artifact.metadata.generatedFilename
			: "";
	const haystack = [
		label,
		params.artifact.name,
		generatedFilename,
		role,
		params.artifact.summary ?? "",
		params.artifact.contentText ?? "",
	].join("\n");

	let score = scoreMatch(params.query, haystack) * 10;
	const reasonCodes: string[] = [];
	const behaviorScore = params.behaviorScoresByKey?.get(behaviorKey) ?? 0;
	const reopenScore = params.reopenScoresByKey?.get(behaviorKey) ?? 0;
	const semanticScore =
		params.semanticScoresByArtifactId?.get(params.artifact.id) ?? 0;
	const rerankScore =
		params.rerankScoresByArtifactId?.get(params.artifact.id) ?? 0;

	if (score > 0) {
		reasonCodes.push("matched_query");
	}

	if (includesNormalized(params.query, label)) {
		score += 24;
		reasonCodes.push("matched_document_label");
	}

	if (includesNormalized(params.query, params.artifact.name)) {
		score += 20;
		reasonCodes.push("matched_artifact_name");
	}

	if (
		generatedFilename &&
		includesNormalized(params.query, generatedFilename)
	) {
		score += 18;
		reasonCodes.push("matched_generated_filename");
	}

	if (role && includesNormalized(params.query, role)) {
		score += 10;
		reasonCodes.push("matched_document_role");
	}

	if (
		params.currentConversationId &&
		params.artifact.conversationId === params.currentConversationId
	) {
		score += 8;
		reasonCodes.push("same_conversation");
	}

	if (behaviorScore > 0) {
		score += Math.min(16, behaviorScore * 4);
		reasonCodes.push("recent_refinement_behavior");
	}

	if (reopenScore > 0) {
		score += Math.min(8, reopenScore * 2);
		reasonCodes.push("recent_document_open");
	}

	if (semanticScore > 0) {
		score += Math.min(18, semanticScore * 18);
		reasonCodes.push("semantic_document_match");
	}

	if (rerankScore > 0) {
		score += Math.min(24, rerankScore * 24);
		reasonCodes.push("reranked_document_match");
	}

	return {
		artifact: params.artifact,
		familyId: metadata.documentFamilyId ?? null,
		score,
		reasonCodes,
	};
}

function getLatestGeneratedArtifacts(artifacts: Artifact[]): Artifact[] {
	return selectLatestGeneratedDocumentCandidatesByFamily(
		artifacts.map((artifact) => ({
			artifactId: artifact.id,
			artifactName: artifact.name,
			updatedAt: artifact.updatedAt,
			metadata: artifact.metadata,
			artifact,
		})),
	).map((candidate) => candidate.artifact);
}

function getLatestArtifactForGeneratedFamily(
	artifacts: Artifact[],
	familyId: string,
): Artifact | null {
	return (
		getLatestGeneratedArtifacts(
			artifacts.filter((artifact) => {
				const metadata = parseWorkingDocumentMetadata(artifact.metadata);
				return metadata.documentFamilyId === familyId;
			}),
		)[0] ?? null
	);
}

type GeneratedArtifactSelectionContext = {
	query: string;
	limit: number;
	currentConversationId?: string | null;
	behaviorScoresByKey?: Map<string, number>;
	reopenScoresByKey?: Map<string, number>;
	semanticScoresByArtifactId?: Map<string, number>;
	rerankScoresByArtifactId?: Map<string, number>;
};

function rankLatestGeneratedDocumentArtifacts(
	params: GeneratedArtifactMatchParams,
): GeneratedDocumentResolution[] {
	return getLatestGeneratedArtifacts(
		params.artifacts.filter(isGeneratedDocumentSourceReady),
	)
		.map((artifact) =>
			scoreGeneratedDocumentArtifact({
				artifact,
				query: params.query,
				currentConversationId: params.currentConversationId,
				behaviorScoresByKey: params.behaviorScoresByKey,
				reopenScoresByKey: params.reopenScoresByKey,
				semanticScoresByArtifactId: params.semanticScoresByArtifactId,
				rerankScoresByArtifactId: params.rerankScoresByArtifactId,
			}),
		)
		.filter((entry) => entry.score > 0)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			return right.artifact.updatedAt - left.artifact.updatedAt;
		});
}

function getQueryBoundResolvedArtifacts(
	params: GeneratedArtifactSelectionContext,
	generatedArtifacts: Artifact[],
): GeneratedDocumentResolution[] {
	return resolveRelevantGeneratedDocumentArtifacts({
		artifacts: generatedArtifacts,
		query: params.query,
		limit: Math.max(params.limit, 1),
		currentConversationId: params.currentConversationId,
		behaviorScoresByKey: params.behaviorScoresByKey,
		reopenScoresByKey: params.reopenScoresByKey,
		semanticScoresByArtifactId: params.semanticScoresByArtifactId,
		rerankScoresByArtifactId: params.rerankScoresByArtifactId,
	});
}

function choosePrimaryArtifactFromPreference(
	params: {
		preferredArtifact: Artifact | null;
		preferredFamilyArtifact: Artifact | null;
		suppressCarryoverWhenUnfocused?: boolean;
		primaryResolution: GeneratedDocumentResolution | null;
	},
	orderedArtifacts: Artifact[],
	seenArtifactIds: Set<string>,
): Artifact | null {
	if (params.preferredArtifact) {
		orderedArtifacts.push(params.preferredArtifact);
		seenArtifactIds.add(params.preferredArtifact.id);
		return params.preferredArtifact;
	}

	if (params.preferredFamilyArtifact) {
		orderedArtifacts.push(params.preferredFamilyArtifact);
		seenArtifactIds.add(params.preferredFamilyArtifact.id);
		return params.preferredFamilyArtifact;
	}

	if (!params.suppressCarryoverWhenUnfocused) {
		const primaryArtifact = params.primaryResolution?.artifact ?? null;
		if (primaryArtifact) {
			orderedArtifacts.push(primaryArtifact);
			seenArtifactIds.add(primaryArtifact.id);
			return primaryArtifact;
		}
	}

	return null;
}

function fillCarryoverArtifactsForRelevantSelection(params: {
	limit: number;
	suppressCarryoverWhenUnfocused?: boolean;
	preferredFamilyId: string | null;
	resolutions: GeneratedDocumentResolution[];
	orderedArtifacts: Artifact[];
	seenArtifactIds: Set<string>;
}) {
	if (params.suppressCarryoverWhenUnfocused) return;

	for (const resolution of params.resolutions) {
		if (params.seenArtifactIds.has(resolution.artifact.id)) continue;
		if (
			params.preferredFamilyId &&
			resolution.familyId === params.preferredFamilyId
		) {
			continue;
		}
		params.orderedArtifacts.push(resolution.artifact);
		params.seenArtifactIds.add(resolution.artifact.id);
		if (params.orderedArtifacts.length >= params.limit) break;
	}
}

function getPrimaryReasonCodesForRelevantSelection(params: {
	preferredArtifact: Artifact | null;
	preferredFamilyArtifact: Artifact | null;
	primaryResolution: GeneratedDocumentResolution | null;
	orderedArtifacts: Artifact[];
}): string[] {
	if (params.preferredArtifact) return ["preferred_artifact"];
	if (params.preferredFamilyArtifact)
		return ["recently_refined_document_family"];
	return params.orderedArtifacts.length > 0
		? (params.primaryResolution?.reasonCodes ?? [])
		: [];
}

function hasExplicitGeneratedDocumentQueryMatch(
	resolution: GeneratedDocumentResolution | null | undefined,
): boolean {
	if (!resolution) return false;
	return resolution.reasonCodes.some((code) =>
		GENERATED_QUERY_MATCH_REASONS.has(code),
	);
}

export function isGeneratedDocumentPromptEligible(params: {
	artifact: Artifact;
	conversationId: string;
	reasonCodes: WorkingSetReasonCode[];
	messageMatchScore: number;
	explicitlyRequested: boolean;
}): boolean {
	if (params.artifact.type !== "generated_output") {
		return true;
	}

	if (!isGeneratedDocumentSourceReady(params.artifact)) {
		return false;
	}

	if (params.artifact.retrievalClass === "durable") {
		return true;
	}

	if (
		params.artifact.conversationId &&
		params.artifact.conversationId === params.conversationId
	) {
		const hasRecentActivity =
			params.reasonCodes.includes("attached_this_turn") ||
			params.reasonCodes.includes("active_document_focus") ||
			params.reasonCodes.includes("recent_user_correction") ||
			params.reasonCodes.includes("recently_refined_document_family") ||
			params.reasonCodes.includes("current_generated_document") ||
			params.reasonCodes.includes("recently_used_in_output");
		return (
			hasRecentActivity ||
			params.messageMatchScore >= 3 ||
			params.explicitlyRequested
		);
	}

	return params.messageMatchScore >= 3 || params.explicitlyRequested;
}

export function resolveRelevantGeneratedDocumentArtifacts(params: {
	artifacts: Artifact[];
	query: string;
	limit: number;
	currentConversationId?: string | null;
	behaviorScoresByKey?: Map<string, number>;
	reopenScoresByKey?: Map<string, number>;
	semanticScoresByArtifactId?: Map<string, number>;
	rerankScoresByArtifactId?: Map<string, number>;
}): GeneratedDocumentResolution[] {
	return rankLatestGeneratedDocumentArtifacts({
		artifacts: params.artifacts,
		query: params.query,
		currentConversationId: params.currentConversationId,
		behaviorScoresByKey: params.behaviorScoresByKey,
		reopenScoresByKey: params.reopenScoresByKey,
		semanticScoresByArtifactId: params.semanticScoresByArtifactId,
		rerankScoresByArtifactId: params.rerankScoresByArtifactId,
	}).slice(0, params.limit);
}

export function resolveRelevantGeneratedDocumentSelection(params: {
	artifacts: Artifact[];
	query: string;
	limit: number;
	preferredArtifactId?: string | null;
	preferredFamilyId?: string | null;
	currentConversationId?: string | null;
	suppressCarryoverWhenUnfocused?: boolean;
	behaviorScoresByKey?: Map<string, number>;
	reopenScoresByKey?: Map<string, number>;
	semanticScoresByArtifactId?: Map<string, number>;
	rerankScoresByArtifactId?: Map<string, number>;
}): RelevantGeneratedDocumentSelection {
	const generatedArtifacts = params.artifacts.filter(
		(artifact) =>
			artifact.type === "generated_output" &&
			isGeneratedDocumentSourceReady(artifact),
	);
	const preferredArtifact = params.preferredArtifactId
		? (generatedArtifacts.find(
				(artifact) => artifact.id === params.preferredArtifactId,
			) ?? null)
		: null;
	const preferredFamilyId = preferredArtifact
		? (parseWorkingDocumentMetadata(preferredArtifact.metadata)
				.documentFamilyId ?? null)
		: (params.preferredFamilyId ?? null);
	const preferredFamilyArtifact =
		!preferredArtifact && preferredFamilyId
			? getLatestArtifactForGeneratedFamily(
					generatedArtifacts,
					preferredFamilyId,
				)
			: null;
	const resolutions = getQueryBoundResolvedArtifacts(
		{
			query: params.query,
			limit: params.limit,
			currentConversationId: params.currentConversationId,
			behaviorScoresByKey: params.behaviorScoresByKey,
			reopenScoresByKey: params.reopenScoresByKey,
			semanticScoresByArtifactId: params.semanticScoresByArtifactId,
			rerankScoresByArtifactId: params.rerankScoresByArtifactId,
		},
		generatedArtifacts,
	);
	const orderedArtifacts: Artifact[] = [];
	const seenArtifactIds = new Set<string>();
	const primaryResolution = resolutions[0] ?? null;

	choosePrimaryArtifactFromPreference(
		{
			preferredArtifact,
			preferredFamilyArtifact,
			suppressCarryoverWhenUnfocused: params.suppressCarryoverWhenUnfocused,
			primaryResolution,
		},
		orderedArtifacts,
		seenArtifactIds,
	);
	fillCarryoverArtifactsForRelevantSelection({
		limit: params.limit,
		suppressCarryoverWhenUnfocused: params.suppressCarryoverWhenUnfocused,
		preferredFamilyId,
		resolutions,
		orderedArtifacts,
		seenArtifactIds,
	});

	const primaryReasonCodes = getPrimaryReasonCodesForRelevantSelection({
		preferredArtifact,
		preferredFamilyArtifact,
		primaryResolution,
		orderedArtifacts,
	});

	return {
		orderedArtifacts,
		primaryArtifactId: orderedArtifacts[0]?.id ?? null,
		primaryReasonCodes,
		resolutions,
	};
}

export function resolveCurrentGeneratedDocumentSelection(params: {
	artifacts: Artifact[];
	preferredArtifactId?: string | null;
	preferredFamilyId?: string | null;
	query?: string;
	currentConversationId?: string | null;
	allowFallbackToLatest?: boolean;
}): CurrentGeneratedDocumentSelection {
	const generatedArtifacts = params.artifacts.filter(
		(artifact) =>
			artifact.type === "generated_output" &&
			isGeneratedDocumentSourceReady(artifact),
	);
	const latestArtifacts = getLatestGeneratedArtifacts(generatedArtifacts);

	const latestArtifactIds = latestArtifacts.map((artifact) => artifact.id);
	const preferredArtifact = params.preferredArtifactId
		? (generatedArtifacts.find(
				(artifact) => artifact.id === params.preferredArtifactId,
			) ?? null)
		: null;

	if (preferredArtifact) {
		return {
			primaryArtifactId: preferredArtifact.id,
			latestArtifactIds,
			latestArtifacts,
			primaryReasonCodes: ["preferred_artifact"],
		};
	}

	const normalizedQuery = params.query?.trim() ?? "";
	if (normalizedQuery) {
		const rankedArtifacts = rankLatestGeneratedDocumentArtifacts({
			artifacts: generatedArtifacts,
			query: normalizedQuery,
			currentConversationId: params.currentConversationId,
		});
		const primaryMatch = rankedArtifacts[0] ?? null;

		if (hasExplicitGeneratedDocumentQueryMatch(primaryMatch)) {
			return {
				primaryArtifactId: primaryMatch.artifact.id,
				latestArtifactIds,
				latestArtifacts,
				primaryReasonCodes: primaryMatch.reasonCodes as WorkingSetReasonCode[],
			};
		}
	}

	if (params.preferredFamilyId) {
		const preferredFamilyArtifact = getLatestArtifactForGeneratedFamily(
			generatedArtifacts,
			params.preferredFamilyId,
		);
		if (preferredFamilyArtifact) {
			return {
				primaryArtifactId: preferredFamilyArtifact.id,
				latestArtifactIds,
				latestArtifacts,
				primaryReasonCodes: ["recently_refined_document_family"],
			};
		}
	}

	if (params.allowFallbackToLatest === false) {
		return {
			primaryArtifactId: null,
			latestArtifactIds,
			latestArtifacts,
			primaryReasonCodes: [],
		};
	}

	return {
		primaryArtifactId:
			latestArtifactIds.length > 0 ? latestArtifactIds[0] : null,
		latestArtifactIds,
		latestArtifacts,
		primaryReasonCodes:
			latestArtifactIds.length > 0 ? ["current_generated_document"] : [],
	};
}
