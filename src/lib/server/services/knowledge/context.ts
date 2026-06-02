import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	artifacts,
	conversationContextStatus,
	conversationWorkingSetItems,
} from '$lib/server/db/schema';
import { DAY_MS } from '$lib/server/utils/constants';
import {
	applyConversationBoundaryPenalty,
	isCrossConversationArtifactEligible,
} from '$lib/server/utils/conversation-boundary-filter';
import { parseJsonStringArray } from '$lib/server/utils/json';
import type {
	Artifact,
	ArtifactSummary,
	CompactionMode,
	ConversationContextStatus,
	ConversationWorkingSetItem,
	MemoryLayer,
	WorkingSetReasonCode,
} from '$lib/types';
import {
	getGeneratedDocumentBehaviorKey,
	isGeneratedDocumentPromptEligible,
	resolveRelevantGeneratedDocumentSelection,
} from '../document-resolution';
import { countRecentMemoryEventsBySubject } from '../memory-events';
import {
	resolveWorkingDocumentSelection,
	type WorkingDocumentSelection,
} from '../working-document-selection';
import {
	rankWorkingSetCandidates,
	scoreMatch,
	WORKING_SET_ACTIVE_LIMIT,
	WORKING_SET_PROMPT_LIMIT,
	type WorkingSetCandidate,
} from '../working-set';
import {
	findRelevantArtifactsByTypesDetailed,
	getArtifactOwnershipScope,
	getArtifactsForUser,
	getCompactionUiThreshold,
	getMaxModelContext,
	getTargetConstructedContext,
	isArtifactCanonicallyOwned,
	listConversationSourceArtifactIds,
	mapArtifact,
	mapArtifactSummary,
} from './store';

function mapContextStatus(row: typeof conversationContextStatus.$inferSelect): ConversationContextStatus {
	return {
		conversationId: row.conversationId,
		userId: row.userId,
		estimatedTokens: row.estimatedTokens,
		maxContextTokens: row.maxContextTokens,
		thresholdTokens: row.thresholdTokens,
		targetTokens: row.targetTokens,
		compactionApplied: row.compactionApplied === 1,
		compactionMode: (row.compactionMode ?? 'none') as CompactionMode,
		routingStage: (row.routingStage ?? 'deterministic') as ConversationContextStatus['routingStage'],
		routingConfidence: row.routingConfidence ?? 0,
		verificationStatus: (row.verificationStatus ?? 'skipped') as ConversationContextStatus['verificationStatus'],
		layersUsed: parseJsonStringArray(row.layersUsedJson) as MemoryLayer[],
		workingSetCount: row.workingSetCount ?? 0,
		workingSetArtifactIds: parseJsonStringArray(row.workingSetArtifactIdsJson),
		workingSetApplied: row.workingSetApplied === 1,
		taskStateApplied: row.taskStateApplied === 1,
		promptArtifactCount: row.promptArtifactCount ?? 0,
		recentTurnCount: row.recentTurnCount ?? 0,
		summary: row.summary ?? null,
		updatedAt: row.updatedAt.getTime(),
	};
}

function mapConversationWorkingSetItem(
	row: typeof conversationWorkingSetItems.$inferSelect
): ConversationWorkingSetItem {
	return {
		id: row.id,
		userId: row.userId,
		conversationId: row.conversationId,
		artifactId: row.artifactId,
		artifactType: row.artifactType as ConversationWorkingSetItem['artifactType'],
		score: row.score,
		state: row.state as ConversationWorkingSetItem['state'],
		reasonCodes: parseJsonStringArray(row.reasonCodesJson) as WorkingSetReasonCode[],
		lastActivatedAt: row.lastActivatedAt ? row.lastActivatedAt.getTime() : null,
		lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

function logWorkingDocumentSelection(params: {
	phase: 'prompt' | 'working_set';
	conversationId: string;
	activeDocumentArtifactId?: string;
	selection: WorkingDocumentSelection;
	selectedArtifacts: Array<{
		artifactId: string;
		score?: number;
		reasonCodes?: WorkingSetReasonCode[];
	}>;
}): void {
	const {
		activeDocumentArtifactId,
		conversationId,
		phase,
		selection,
		selectedArtifacts,
	} = params;
	const shouldLog =
		Boolean(activeDocumentArtifactId) ||
		Boolean(selection.currentDocument) ||
		selection.latestGeneratedDocumentIds.length > 0 ||
		selection.activeFocus.artifactIds.length > 0 ||
		selection.correction.hasSignal ||
		Boolean(selection.recentRefinement.familyId) ||
		selection.reset.hasSignal;

	if (!shouldLog) {
		return;
	}

	console.info('[CONTEXT] Working document selection', {
		conversationId,
		phase,
		requestedActiveDocumentArtifactId: activeDocumentArtifactId ?? null,
		documentFocused: selection.documentFocused,
		currentDocument: selection.currentDocument,
		latestGeneratedDocumentIds: selection.latestGeneratedDocumentIds,
		activeFocusArtifactIds: selection.activeFocus.artifactIds,
		correctionTargetArtifactIds: selection.correction.targetArtifactIds,
		recentlyRefinedFamilyId: selection.recentRefinement.familyId,
		recentlyRefinedArtifactIds: selection.recentRefinement.artifactIds,
		suppressGeneratedCarryover: selection.retrieval.suppressGeneratedCarryover,
		hasRecentUserCorrection: selection.correction.hasSignal,
		hasContextResetSignal: selection.reset.hasSignal,
		selectedArtifacts: selectedArtifacts.slice(0, 4),
	});
}

async function listConversationWorkingSetItems(
	userId: string,
	conversationId: string
): Promise<ConversationWorkingSetItem[]> {
	const rows = await db
		.select()
		.from(conversationWorkingSetItems)
		.where(
			and(
				eq(conversationWorkingSetItems.userId, userId),
				eq(conversationWorkingSetItems.conversationId, conversationId)
			)
		)
		.orderBy(desc(conversationWorkingSetItems.score), desc(conversationWorkingSetItems.updatedAt));
	return rows.map(mapConversationWorkingSetItem);
}

export async function getConversationWorkingSet(
	userId: string,
	conversationId: string
): Promise<ArtifactSummary[]> {
	const ownershipScope = await getArtifactOwnershipScope(userId);
	const rows = await db
		.select({
			item: conversationWorkingSetItems,
			artifact: artifacts,
		})
		.from(conversationWorkingSetItems)
		.innerJoin(artifacts, eq(conversationWorkingSetItems.artifactId, artifacts.id))
		.where(
			and(
				eq(conversationWorkingSetItems.userId, userId),
				eq(conversationWorkingSetItems.conversationId, conversationId),
				eq(conversationWorkingSetItems.state, 'active')
			)
		)
		.orderBy(desc(conversationWorkingSetItems.score), desc(conversationWorkingSetItems.updatedAt));

	return rows
		.filter((row) =>
			isArtifactCanonicallyOwned({
				userId,
				ownershipScope,
				artifact: row.artifact,
			})
		)
		.map((row) => mapArtifactSummary(row.artifact));
}

export async function selectWorkingSetArtifactsForPrompt(
	userId: string,
	conversationId: string,
	message: string,
	excludeArtifactIds: string[] = [],
	activeDocumentArtifactId?: string
): Promise<Artifact[]> {
	const exclude = new Set(excludeArtifactIds);
	const ownershipScope = await getArtifactOwnershipScope(userId);
	const rows = await db
		.select({
			item: conversationWorkingSetItems,
			artifact: artifacts,
		})
		.from(conversationWorkingSetItems)
		.innerJoin(artifacts, eq(conversationWorkingSetItems.artifactId, artifacts.id))
		.where(
			and(
				eq(conversationWorkingSetItems.userId, userId),
				eq(conversationWorkingSetItems.conversationId, conversationId),
				eq(conversationWorkingSetItems.state, 'active')
			)
		);

	const mappedRows = rows
		.filter((row) =>
			isArtifactCanonicallyOwned({
				userId,
				ownershipScope,
				artifact: row.artifact,
			})
		)
		.map((row) => ({
			item: row.item,
			artifact: mapArtifact(row.artifact),
		}));
	const reasonCodesByArtifactId = new Map(
		mappedRows.map((row) => [
			row.artifact.id,
			parseJsonStringArray(row.item.reasonCodesJson) as WorkingSetReasonCode[],
		])
	);
	const selection = resolveWorkingDocumentSelection({
		artifacts: mappedRows.map((row) => row.artifact),
		message,
		attachmentIds: excludeArtifactIds,
		activeDocumentArtifactId,
		currentConversationId: conversationId,
		reasonCodesByArtifactId,
	});
	const promptProtectedArtifactIds = new Set(
		selection.taskEvidence.workingDocumentProtectedArtifactIds
	);

	const selectedArtifacts = mappedRows
		.map((row) => {
			const artifact = row.artifact;
			const messageMatchScore = scoreMatch(
				message,
				`${artifact.name}\n${artifact.summary ?? ''}\n${artifact.contentText ?? ''}`
			);
			const reasonCodes =
				selection.prompt.reasonCodesByArtifactId.get(artifact.id) ?? [];
			const explicitlyRequested =
				scoreMatch(message, artifact.name) > 0 ||
				scoreMatch(message, artifact.summary ?? '') > 1;
			const promptEligible = isGeneratedDocumentPromptEligible({
				artifact,
				conversationId,
				reasonCodes,
				messageMatchScore,
				explicitlyRequested,
			});
			const suppressStaleGeneratedCarryover =
				artifact.type === 'generated_output' &&
				selection.retrieval.suppressGeneratedCarryover &&
				!promptProtectedArtifactIds.has(artifact.id);

			return {
				artifact,
				reasonCodes,
				promptEligible: promptEligible && !suppressStaleGeneratedCarryover,
				score: row.item.score + messageMatchScore * 14 + (explicitlyRequested ? 14 : 0),
			};
		})
		.filter((entry) => !exclude.has(entry.artifact.id))
		.filter((entry) => entry.promptEligible)
		.sort((left, right) => right.score - left.score)
		.slice(0, WORKING_SET_PROMPT_LIMIT);

	logWorkingDocumentSelection({
		phase: 'prompt',
		conversationId,
		activeDocumentArtifactId,
		selection,
		selectedArtifacts: selectedArtifacts.map((entry) => ({
			artifactId: entry.artifact.id,
			score: entry.score,
			reasonCodes: entry.reasonCodes,
		})),
	});

	return selectedArtifacts.map((entry) => entry.artifact);
}

export async function refreshConversationWorkingSet(params: {
	userId: string;
	conversationId: string;
	message?: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	selectedGeneratedArtifactId?: string | null;
}): Promise<ArtifactSummary[]> {
	const attachmentIds = params.attachmentIds ?? [];
	const existingItems = await listConversationWorkingSetItems(params.userId, params.conversationId);
	const sourceArtifactIds = await listConversationSourceArtifactIds(params.userId, params.conversationId);
	const outputArtifacts = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				eq(artifacts.conversationId, params.conversationId),
				eq(artifacts.type, 'generated_output')
			)
		)
		.orderBy(desc(artifacts.updatedAt))
		.limit(8);
	const outputArtifactModels = outputArtifacts.map((artifact) => mapArtifact(artifact));
	const selection = resolveWorkingDocumentSelection({
		artifacts: outputArtifactModels,
		message: params.message ?? '',
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		preferredGeneratedArtifactId: params.selectedGeneratedArtifactId,
		currentConversationId: params.conversationId,
	});
	const latestGeneratedArtifactIds = selection.latestGeneratedDocumentIds;

	const candidateIds = new Set<string>([
		...existingItems.map((item) => item.artifactId),
		...attachmentIds,
		...sourceArtifactIds,
		...latestGeneratedArtifactIds,
		...selection.workingSet.candidateArtifactIds,
	]);

	if (candidateIds.size === 0) {
		return [];
	}

	const artifactRows = await getArtifactsForUser(params.userId, Array.from(candidateIds));
	const existingByArtifactId = new Map(existingItems.map((item) => [item.artifactId, item]));
	const message = params.message?.trim() ?? '';
	const linkedSourceArtifactIds = new Set(sourceArtifactIds);
	const attachedArtifactIds = new Set(attachmentIds);
	const protectedArtifactIds = new Set(selection.taskEvidence.protectedArtifactIds);

	const candidates: WorkingSetCandidate[] = artifactRows
		.filter((artifact) => artifact.type !== 'work_capsule')
		.filter(
			(artifact) =>
				artifact.conversationId === params.conversationId ||
				linkedSourceArtifactIds.has(artifact.id) ||
				attachedArtifactIds.has(artifact.id)
		)
		.map((artifact) => {
			const candidateSignals =
				selection.workingSet.candidateSignalsByArtifactId.get(artifact.id);
			const suppressStaleGeneratedCarryover =
				artifact.type === 'generated_output' &&
				selection.retrieval.suppressGeneratedCarryover &&
				!protectedArtifactIds.has(artifact.id);
			const applyWorkingDocumentSignals = !suppressStaleGeneratedCarryover;
			return {
				artifactId: artifact.id,
				artifactType: artifact.type as WorkingSetCandidate['artifactType'],
				name: artifact.name,
				summary: artifact.summary,
				contentText: artifact.contentText,
				updatedAt: artifact.updatedAt,
				isAttachedThisTurn:
					applyWorkingDocumentSignals &&
					(candidateSignals?.isAttachedThisTurn ?? false),
				isActiveDocumentFocus:
					applyWorkingDocumentSignals &&
					(candidateSignals?.isActiveDocumentFocus ?? false),
				isRecentUserCorrection:
					applyWorkingDocumentSignals &&
					(candidateSignals?.isRecentUserCorrection ?? false),
				isRecentlyRefinedDocumentFamily:
					applyWorkingDocumentSignals &&
					(candidateSignals?.isRecentlyRefinedDocumentFamily ?? false),
				isCurrentGeneratedDocument:
					applyWorkingDocumentSignals &&
					(candidateSignals?.isCurrentGeneratedDocument ?? false),
				messageMatchScore:
					message && applyWorkingDocumentSignals
						? scoreMatch(
								message,
								`${artifact.name}\n${artifact.summary ?? ''}\n${artifact.contentText ?? ''}`
							)
						: 0,
			};
		});

	const ranked = rankWorkingSetCandidates(candidates);
	const now = new Date();
	const activeIds = new Set(ranked.filter((item) => item.selected).map((item) => item.artifactId));

	for (const candidate of ranked) {
		const existing = existingByArtifactId.get(candidate.artifactId);
		const shouldTouchUsage =
			candidate.reasonCodes.includes('attached_this_turn') ||
			candidate.reasonCodes.includes('active_document_focus') ||
			candidate.reasonCodes.includes('recently_refined_document_family') ||
			candidate.reasonCodes.includes('matched_current_turn') ||
			candidate.reasonCodes.includes('recent_user_correction');

		if (existing) {
			await db
				.update(conversationWorkingSetItems)
				.set({
					artifactType: candidate.artifactType,
					score: candidate.score,
					state: candidate.state,
					reasonCodesJson: JSON.stringify(candidate.reasonCodes),
					lastActivatedAt: candidate.selected
						? now
						: existing.lastActivatedAt
							? new Date(existing.lastActivatedAt)
							: null,
					lastUsedAt: shouldTouchUsage
						? now
						: existing.lastUsedAt
							? new Date(existing.lastUsedAt)
							: null,
					updatedAt: now,
				})
				.where(eq(conversationWorkingSetItems.id, existing.id));
			continue;
		}

		if (candidate.score <= 0) {
			continue;
		}

		await db.insert(conversationWorkingSetItems).values({
			id: randomUUID(),
			userId: params.userId,
			conversationId: params.conversationId,
			artifactId: candidate.artifactId,
			artifactType: candidate.artifactType,
			score: candidate.score,
			state: candidate.state,
			reasonCodesJson: JSON.stringify(candidate.reasonCodes),
			lastActivatedAt: candidate.selected ? now : null,
			lastUsedAt: shouldTouchUsage ? now : null,
			updatedAt: now,
		});
	}

	const refreshed = await getConversationWorkingSet(params.userId, params.conversationId);
	logWorkingDocumentSelection({
		phase: 'working_set',
		conversationId: params.conversationId,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		selection,
		selectedArtifacts: ranked
			.filter((candidate) => candidate.selected)
			.map((candidate) => ({
				artifactId: candidate.artifactId,
				score: candidate.score,
				reasonCodes: candidate.reasonCodes,
			})),
	});
	return refreshed
		.filter((artifact) => activeIds.has(artifact.id))
		.slice(0, WORKING_SET_ACTIVE_LIMIT);
}

export async function updateConversationContextStatus(params: {
	conversationId: string;
	userId: string;
	estimatedTokens: number;
	compactionApplied: boolean;
	compactionMode?: CompactionMode;
	routingStage?: ConversationContextStatus['routingStage'];
	routingConfidence?: number;
	verificationStatus?: ConversationContextStatus['verificationStatus'];
	layersUsed: MemoryLayer[];
	workingSetCount?: number;
	workingSetArtifactIds?: string[];
	workingSetApplied?: boolean;
	taskStateApplied?: boolean;
	promptArtifactCount?: number;
	recentTurnCount?: number;
	summary?: string | null;
	contextLimits?: {
		maxModelContext: number;
		compactionUiThreshold: number;
		targetConstructedContext: number;
	};
}): Promise<ConversationContextStatus> {
	const maxContextTokens = params.contextLimits?.maxModelContext ?? getMaxModelContext();
	const thresholdTokens =
		params.contextLimits?.compactionUiThreshold ?? getCompactionUiThreshold();
	const targetTokens =
		params.contextLimits?.targetConstructedContext ?? getTargetConstructedContext();
	const [row] = await db
		.insert(conversationContextStatus)
		.values({
			conversationId: params.conversationId,
			userId: params.userId,
			estimatedTokens: params.estimatedTokens,
			maxContextTokens,
			thresholdTokens,
			targetTokens,
			compactionApplied: params.compactionApplied ? 1 : 0,
			compactionMode: params.compactionMode ?? 'none',
			routingStage: params.routingStage ?? 'deterministic',
			routingConfidence: Math.round(params.routingConfidence ?? 0),
			verificationStatus: params.verificationStatus ?? 'skipped',
			layersUsedJson: JSON.stringify(params.layersUsed),
			workingSetCount: params.workingSetCount ?? 0,
			workingSetArtifactIdsJson: JSON.stringify(params.workingSetArtifactIds ?? []),
			workingSetApplied: params.workingSetApplied ? 1 : 0,
			taskStateApplied: params.taskStateApplied ? 1 : 0,
			promptArtifactCount: params.promptArtifactCount ?? 0,
			recentTurnCount: params.recentTurnCount ?? 0,
			summary: params.summary ?? null,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: conversationContextStatus.conversationId,
			set: {
				userId: params.userId,
				estimatedTokens: params.estimatedTokens,
				maxContextTokens,
				thresholdTokens,
				targetTokens,
				compactionApplied: params.compactionApplied ? 1 : 0,
				compactionMode: params.compactionMode ?? 'none',
				routingStage: params.routingStage ?? 'deterministic',
				routingConfidence: Math.round(params.routingConfidence ?? 0),
				verificationStatus: params.verificationStatus ?? 'skipped',
				layersUsedJson: JSON.stringify(params.layersUsed),
				workingSetCount: params.workingSetCount ?? 0,
				workingSetArtifactIdsJson: JSON.stringify(params.workingSetArtifactIds ?? []),
				workingSetApplied: params.workingSetApplied ? 1 : 0,
				taskStateApplied: params.taskStateApplied ? 1 : 0,
				promptArtifactCount: params.promptArtifactCount ?? 0,
				recentTurnCount: params.recentTurnCount ?? 0,
				summary: params.summary ?? null,
				updatedAt: new Date(),
			},
		})
		.returning();

	return mapContextStatus(row);
}

export async function getConversationContextStatus(
	userId: string,
	conversationId: string
): Promise<ConversationContextStatus | null> {
	const [row] = await db
		.select()
		.from(conversationContextStatus)
		.where(
			and(
				eq(conversationContextStatus.userId, userId),
				eq(conversationContextStatus.conversationId, conversationId)
			)
		);
	return row ? mapContextStatus(row) : null;
}

export async function findRelevantKnowledgeArtifacts(params: {
	userId: string;
	query: string;
	excludeConversationId?: string;
	currentConversationId?: string;
	limit?: number;
	preferredArtifactId?: string;
	preferredGeneratedFamilyId?: string | null;
	suppressGeneratedCarryover?: boolean;
}): Promise<Artifact[]> {
	const limit = params.limit ?? 6;
	const recentBehaviorWindowStart = Date.now() - 14 * DAY_MS;
	const currentConversationId = params.currentConversationId ?? '';

	const [documentMatchesRaw, generatedOutputMatchesRaw, preferredArtifacts] = await Promise.all([
		findRelevantArtifactsByTypesDetailed({
			userId: params.userId,
			query: params.query,
			types: ['normalized_document'],
			limit: limit * 3,
			excludeConversationId: params.excludeConversationId,
		}),
		findRelevantArtifactsByTypesDetailed({
			userId: params.userId,
			query: params.query,
			types: ['generated_output'],
			limit: Math.max(limit * 5, 20),
			excludeConversationId: params.excludeConversationId,
		}),
		params.preferredArtifactId
			? getArtifactsForUser(params.userId, [params.preferredArtifactId])
			: Promise.resolve([]),
	]);

	const processMatches = (matches: typeof documentMatchesRaw, minMatchScore: number) => {
		return matches
			.map((entry) => {
				const isSameConversation = entry.artifact.conversationId === currentConversationId;
				const isCrossConversation = entry.artifact.conversationId !== null && !isSameConversation;

				const explicitlyRequested =
					scoreMatch(params.query, entry.artifact.name) > 0 ||
					scoreMatch(params.query, entry.artifact.summary ?? '') > 1;

				if (isCrossConversation) {
					const eligible = isCrossConversationArtifactEligible({
						artifactConversationId: entry.artifact.conversationId,
						currentConversationId,
						matchScore: entry.lexicalScore,
						semanticScore: entry.semanticScore,
						rerankScore: entry.rerankScore,
						explicitlyRequested,
						minMatchScore,
					});
					if (!eligible) return null;
				}

				const daysSinceLastAccess = Math.max(0, (Date.now() - entry.artifact.updatedAt) / DAY_MS);

				return {
					...entry,
					finalScore: applyConversationBoundaryPenalty({
						score: entry.finalScore,
						isSameConversation,
						daysSinceLastAccess,
					}),
					semanticScore: applyConversationBoundaryPenalty({
						score: entry.semanticScore,
						isSameConversation,
						daysSinceLastAccess,
					}),
					rerankScore: applyConversationBoundaryPenalty({
						score: entry.rerankScore,
						isSameConversation,
						daysSinceLastAccess,
					}),
				};
			})
			.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
			.sort((left, right) => {
				if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore;
				return right.artifact.updatedAt - left.artifact.updatedAt;
			});
	};

	const documentMatches = processMatches(documentMatchesRaw, 2).slice(0, limit);
	const generatedOutputMatches = processMatches(generatedOutputMatchesRaw, 3).slice(0, Math.max(limit * 3, 12));

	const documents = documentMatches.map((entry) => entry.artifact);
	const generatedOutputs = generatedOutputMatches.map((entry) => entry.artifact);
	const generatedSemanticScoresByArtifactId = new Map(
		generatedOutputMatches.map((entry) => [entry.artifact.id, entry.semanticScore])
	);
	const generatedRerankScoresByArtifactId = new Map(
		generatedOutputMatches.map((entry) => [entry.artifact.id, entry.rerankScore])
	);

	const preferredRelevantArtifacts = preferredArtifacts.filter(
		(artifact) => artifact.type !== 'generated_output'
	);
	const generatedBehaviorKeys = Array.from(
		new Set(
			[...generatedOutputs, ...preferredArtifacts]
				.filter((artifact) => artifact.type === 'generated_output')
				.map((artifact) => getGeneratedDocumentBehaviorKey(artifact))
		)
	);
	const [behaviorScoresByKey, reopenScoresByKey] =
		generatedBehaviorKeys.length > 0
			? await Promise.all([
					countRecentMemoryEventsBySubject({
						userId: params.userId,
						domain: 'document',
						eventTypes: ['document_refined'],
						subjectIds: generatedBehaviorKeys,
						since: recentBehaviorWindowStart,
					}).catch(() => new Map<string, number>()),
					countRecentMemoryEventsBySubject({
						userId: params.userId,
						domain: 'document',
						eventTypes: ['document_opened'],
						subjectIds: generatedBehaviorKeys,
						since: recentBehaviorWindowStart,
					}).catch(() => new Map<string, number>()),
				])
			: [new Map<string, number>(), new Map<string, number>()];
	const generatedSelection = resolveRelevantGeneratedDocumentSelection({
		artifacts: [...generatedOutputs, ...preferredArtifacts],
		query: params.query,
		limit,
		preferredArtifactId: params.preferredArtifactId,
		preferredFamilyId: params.preferredGeneratedFamilyId ?? null,
		currentConversationId: params.currentConversationId,
		suppressCarryoverWhenUnfocused: params.suppressGeneratedCarryover ?? false,
		behaviorScoresByKey,
		reopenScoresByKey,
		semanticScoresByArtifactId: generatedSemanticScoresByArtifactId,
		rerankScoresByArtifactId: generatedRerankScoresByArtifactId,
	});

	const seen = new Set<string>();
	const ordered = [
		...preferredRelevantArtifacts,
		...documents,
		...generatedSelection.orderedArtifacts,
	].filter((artifact) => {
		if (seen.has(artifact.id)) return false;
		seen.add(artifact.id);
		return true;
	});

	return ordered.slice(0, limit);
}
