import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store";
import type { Artifact, WorkingSetReasonCode } from "$lib/types";
import { resolveCurrentGeneratedDocumentSelection } from "./document-resolution";

const DOCUMENT_FOCUS_RE =
	/\b(document|doc|file|pdf|attachment|attached|resume|cv|recipe|job description|contract|report)\b/i;
const DOCUMENT_ACTION_RE =
	/\b(summarize|summarise|summary|review|analyze|analyse|rewrite|revise|refine|edit|update|fix|correct|shorten|shorter|expand|polish|translate|extract|compare|convert|format|make)\b/i;
const DOCUMENT_REFERENCE_RE =
	/\b(this|that|it|same|current|open|opened|selected|previous|earlier)\b/i;
const USER_CORRECTION_RE =
	/\b(actually|instead|rather than|use the previous|use the earlier|change it to|revise this|refine this|update this|fix this|correct this|replace that|not that one)\b/i;
const CONTEXT_RESET_RE =
	/\b(done with (?:that|this|it)|finished with (?:that|this|it)|finished (?:that|this|it)|completed (?:that|this|it)|that(?:'s| is) done|wrapped up|move on|switch topics|new topic|another topic|something else|let's talk about something else)\b/i;
const NEW_GENERATED_DOCUMENT_REQUEST_RE =
	/\b(create|generate|make|produce|export|build)\b[\s\S]{0,140}\b(pdf|docx|xlsx|pptx|csv|html|file|document|report|deck|slide deck|slides|spreadsheet|workbook)\b|\b(pdf|docx|xlsx|pptx|csv|html)\b[\s\S]{0,80}\b(called|named)\b/i;
const EXPLICIT_DOCUMENT_INPUT_REFERENCE_RE =
	/\b(this|that|same|current|open|opened|selected|attached|attachment|uploaded|source)\b|\bthe\s+(?:document|doc|file|pdf|attachment|report|source)\b|\b(from|based on|using|use|with)\s+(?:the\s+)?(?:this|that|current|open|opened|selected|attached|attachment|uploaded|document|doc|file|pdf|report|source)\b/i;

interface WorkingDocumentSignalState {
	documentFocused: boolean;
	hasRecentUserCorrection: boolean;
	hasContextResetSignal: boolean;
	activeDocumentIds: Set<string>;
	correctionTargetIds: Set<string>;
	recentlyRefinedFamilyId: string | null;
	recentlyRefinedArtifactIds: Set<string>;
	currentGeneratedArtifactId: string | null;
	latestGeneratedArtifactIds: string[];
	currentGeneratedReasonCodes: Set<WorkingSetReasonCode>;
}

const LIVE_DOCUMENT_REASON_CODES: WorkingSetReasonCode[] = [
	"attached_this_turn",
	"active_document_focus",
	"recent_user_correction",
	"recently_refined_document_family",
	"current_generated_document",
	"latest_generated_output",
	"matched_current_turn",
];

export interface WorkingDocumentIdentity {
	artifactId: string;
	familyId: string | null;
	reasonCodes: WorkingSetReasonCode[];
	source: "active_focus" | "generated_document";
}

export interface WorkingDocumentWorkingSetCandidateSignals {
	isAttachedThisTurn: boolean;
	isActiveDocumentFocus: boolean;
	isRecentUserCorrection: boolean;
	isRecentlyRefinedDocumentFamily: boolean;
	isCurrentGeneratedDocument: boolean;
	isSelectedCurrentGeneratedDocument: boolean;
}

export interface WorkingDocumentSelection {
	documentFocused: boolean;
	currentDocument: WorkingDocumentIdentity | null;
	latestGeneratedDocumentIds: string[];
	activeFocus: {
		artifactIds: string[];
	};
	correction: {
		hasSignal: boolean;
		targetArtifactIds: string[];
	};
	recentRefinement: {
		familyId: string | null;
		artifactIds: string[];
	};
	reset: {
		hasSignal: boolean;
		suppressCarryover: boolean;
	};
	currentTurnReasonCodesByArtifactId: Map<string, WorkingSetReasonCode[]>;
	prompt: {
		reasonCodesByArtifactId: Map<string, WorkingSetReasonCode[]>;
	};
	workingSet: {
		candidateArtifactIds: string[];
		candidateSignalsByArtifactId: Map<
			string,
			WorkingDocumentWorkingSetCandidateSignals
		>;
	};
	retrieval: {
		preferredArtifactId: string | null;
		preferredGeneratedFamilyId: string | null;
		suppressGeneratedCarryover: boolean;
		hasExplicitResetSignal: boolean;
	};
	taskEvidence: {
		protectedArtifactIds: string[];
		workingDocumentProtectedArtifactIds: string[];
	};
}

export interface ResolveWorkingDocumentSelectionParams {
	artifacts: Artifact[];
	message: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	preferredGeneratedArtifactId?: string | null;
	currentConversationId?: string | null;
	reasonCodesByArtifactId?:
		| ReadonlyMap<string, WorkingSetReasonCode[]>
		| Record<string, WorkingSetReasonCode[]>;
}

function orderedIds(values: Iterable<string | null | undefined>): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		ids.push(value);
	}
	return ids;
}

function isReasonCodeMap(
	source:
		| ReadonlyMap<string, WorkingSetReasonCode[]>
		| Record<string, WorkingSetReasonCode[]>,
): source is ReadonlyMap<string, WorkingSetReasonCode[]> {
	return typeof source.get === "function";
}

function getBaseReasonCodes(
	source:
		| ReadonlyMap<string, WorkingSetReasonCode[]>
		| Record<string, WorkingSetReasonCode[]>
		| undefined,
	artifactId: string,
): WorkingSetReasonCode[] {
	if (!source) return [];
	if (isReasonCodeMap(source)) return source.get(artifactId) ?? [];
	return source[artifactId] ?? [];
}

function getArtifactFamilyId(artifact: Artifact | null): string | null {
	if (!artifact) return null;
	return (
		parseWorkingDocumentMetadata(artifact.metadata).documentFamilyId ?? null
	);
}

function isDocumentFocusedTurn(
	message: string,
	attachmentIds: string[] = [],
	options: {
		hasActiveDocument?: boolean;
		hasContinuityDocument?: boolean;
	} = {},
): boolean {
	return (
		attachmentIds.length > 0 ||
		DOCUMENT_FOCUS_RE.test(message) ||
		(Boolean(options.hasActiveDocument || options.hasContinuityDocument) &&
			hasDocumentFollowUpSignal(message))
	);
}

function hasActiveDocumentFocusSignal(message: string): boolean {
	return DOCUMENT_FOCUS_RE.test(message) || hasDocumentFollowUpSignal(message);
}

function hasDocumentFollowUpSignal(message: string): boolean {
	return (
		hasUserCorrectionSignal(message) ||
		(DOCUMENT_ACTION_RE.test(message) && DOCUMENT_REFERENCE_RE.test(message))
	);
}

function hasUserCorrectionSignal(
	message: string | null | undefined,
): boolean {
	if (!message?.trim()) return false;
	return USER_CORRECTION_RE.test(message);
}

function hasActiveContextResetSignal(
	message: string | null | undefined,
): boolean {
	if (!message?.trim()) return false;
	return CONTEXT_RESET_RE.test(message);
}

function hasNewGeneratedDocumentRequestSignal(
	message: string | null | undefined,
): boolean {
	if (!message?.trim()) return false;
	return NEW_GENERATED_DOCUMENT_REQUEST_RE.test(message);
}

function hasExplicitDocumentInputReferenceSignal(
	message: string | null | undefined,
): boolean {
	if (!message?.trim()) return false;
	return EXPLICIT_DOCUMENT_INPUT_REFERENCE_RE.test(message);
}

function deriveWorkingDocumentReasonCodes(params: {
	artifactId: string;
	reasonCodes: WorkingSetReasonCode[];
	workingDocumentSignalState: WorkingDocumentSignalState;
}): WorkingSetReasonCode[] {
	const nextReasonCodes = new Set(params.reasonCodes);
	for (const code of LIVE_DOCUMENT_REASON_CODES) {
		nextReasonCodes.delete(code);
	}

	if (
		params.workingDocumentSignalState.activeDocumentIds.has(params.artifactId)
	) {
		nextReasonCodes.add("active_document_focus");
	}
	if (
		params.workingDocumentSignalState.correctionTargetIds.has(params.artifactId)
	) {
		nextReasonCodes.add("recent_user_correction");
	}
	if (
		params.workingDocumentSignalState.recentlyRefinedArtifactIds.has(
			params.artifactId,
		)
	) {
		nextReasonCodes.add("recently_refined_document_family");
	}
	if (
		params.workingDocumentSignalState.currentGeneratedArtifactId ===
		params.artifactId
	) {
		for (const code of params.workingDocumentSignalState
			.currentGeneratedReasonCodes) {
			nextReasonCodes.add(code);
		}
	}

	return Array.from(nextReasonCodes);
}

function hasGeneratedDocumentRefinementMetadata(artifact: Artifact): boolean {
	const metadata = parseWorkingDocumentMetadata(artifact.metadata);
	const recentVersionIds = Array.isArray(
		artifact.metadata?.recentGeneratedVersionIds,
	)
		? artifact.metadata.recentGeneratedVersionIds.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
		: [];

	return Boolean(
		metadata.documentFamilyId &&
			((metadata.versionNumber ?? 0) > 1 ||
				metadata.supersedesArtifactId ||
				recentVersionIds.length > 0 ||
				(typeof artifact.metadata?.previousGeneratedArtifactId === "string" &&
					artifact.metadata.previousGeneratedArtifactId.trim().length > 0)),
	);
}

function resolveRecentlyRefinedGeneratedFamily(params: {
	artifacts: Artifact[];
	preferredArtifactId?: string | null;
	currentConversationId?: string | null;
}): {
	familyId: string | null;
	latestArtifactIds: string[];
} {
	const allGeneratedArtifacts = params.artifacts
		.filter((artifact) => artifact.type === "generated_output")
		.slice()
		.sort((left, right) => right.updatedAt - left.updatedAt);
	const sameConversationArtifacts = params.currentConversationId
		? allGeneratedArtifacts.filter(
				(artifact) => artifact.conversationId === params.currentConversationId,
			)
		: [];
	const generatedArtifacts =
		sameConversationArtifacts.length > 0
			? sameConversationArtifacts
			: allGeneratedArtifacts;

	const preferredArtifact = params.preferredArtifactId
		? (generatedArtifacts.find(
				(artifact) => artifact.id === params.preferredArtifactId,
			) ?? null)
		: null;
	const preferredMetadata = preferredArtifact
		? parseWorkingDocumentMetadata(preferredArtifact.metadata)
		: null;

	if (
		preferredArtifact &&
		preferredMetadata?.documentFamilyId &&
		hasGeneratedDocumentRefinementMetadata(preferredArtifact)
	) {
		return {
			familyId: preferredMetadata.documentFamilyId,
			latestArtifactIds: [preferredArtifact.id],
		};
	}

	const recentRefinedArtifact =
		generatedArtifacts.find((artifact) =>
			hasGeneratedDocumentRefinementMetadata(artifact),
		) ?? null;
	const recentRefinedMetadata = recentRefinedArtifact
		? parseWorkingDocumentMetadata(recentRefinedArtifact.metadata)
		: null;

	if (!recentRefinedMetadata?.documentFamilyId) {
		return {
			familyId: null,
			latestArtifactIds: [],
		};
	}

	const latestArtifactForFamily =
		generatedArtifacts.find((artifact) => {
			const metadata = parseWorkingDocumentMetadata(artifact.metadata);
			return (
				metadata.documentFamilyId === recentRefinedMetadata.documentFamilyId
			);
		}) ?? null;

	return {
		familyId: recentRefinedMetadata.documentFamilyId,
		latestArtifactIds: latestArtifactForFamily
			? [latestArtifactForFamily.id]
			: [],
	};
}

function buildWorkingDocumentSignalState(params: {
	artifacts: Artifact[];
	message: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	preferredGeneratedArtifactId?: string | null;
	currentConversationId?: string | null;
}): WorkingDocumentSignalState {
	const hasContextResetSignal = hasActiveContextResetSignal(params.message);
	const hasNewGeneratedDocumentRequest =
		hasNewGeneratedDocumentRequestSignal(params.message);
	const hasExplicitDocumentInputReference =
		hasExplicitDocumentInputReferenceSignal(params.message);
	const shouldContinueDocumentState = !hasContextResetSignal;
	const hasRecentUserCorrection = hasUserCorrectionSignal(params.message);
	const hasActiveDocument =
		typeof params.activeDocumentArtifactId === "string" &&
		params.activeDocumentArtifactId.trim().length > 0;
	const activeDocumentFocused =
		shouldContinueDocumentState &&
		hasActiveDocument &&
		hasActiveDocumentFocusSignal(params.message) &&
		(!hasNewGeneratedDocumentRequest || hasExplicitDocumentInputReference);
	const shouldContinueGeneratedDocumentState =
		shouldContinueDocumentState &&
		(!hasNewGeneratedDocumentRequest || activeDocumentFocused);
	const recentRefinedState = shouldContinueGeneratedDocumentState
		? resolveRecentlyRefinedGeneratedFamily({
				artifacts: params.artifacts,
				preferredArtifactId:
					(activeDocumentFocused ? params.activeDocumentArtifactId : null) ??
					params.preferredGeneratedArtifactId ??
					null,
				currentConversationId: params.currentConversationId ?? null,
			})
		: {
				familyId: null,
				latestArtifactIds: [],
			};
	const documentFocused =
		shouldContinueDocumentState &&
		isDocumentFocusedTurn(params.message, params.attachmentIds ?? [], {
			hasActiveDocument,
			hasContinuityDocument: Boolean(recentRefinedState.familyId),
		});
	const selection = shouldContinueGeneratedDocumentState
		? resolveCurrentGeneratedDocumentSelection({
				artifacts: params.artifacts,
				preferredArtifactId:
					(activeDocumentFocused ? params.activeDocumentArtifactId : null) ??
					params.preferredGeneratedArtifactId,
				preferredFamilyId: documentFocused ? recentRefinedState.familyId : null,
				query: params.message.trim(),
				currentConversationId: params.currentConversationId ?? null,
				allowFallbackToLatest:
					documentFocused && !hasNewGeneratedDocumentRequest,
			})
		: {
				primaryArtifactId: null,
				latestArtifactIds: [],
				latestArtifacts: [],
				primaryReasonCodes: [],
			};
	const activeDocumentIds = new Set(
		activeDocumentFocused && params.activeDocumentArtifactId
			? [params.activeDocumentArtifactId]
			: [],
	);
	const correctionTargetIds = new Set<string>();
	if (shouldContinueDocumentState && hasRecentUserCorrection) {
		for (const artifactId of activeDocumentIds) {
			correctionTargetIds.add(artifactId);
		}
		if (selection.primaryArtifactId) {
			correctionTargetIds.add(selection.primaryArtifactId);
		}
	}

	return {
		documentFocused,
		hasRecentUserCorrection,
		hasContextResetSignal,
		activeDocumentIds,
		correctionTargetIds,
		recentlyRefinedFamilyId: recentRefinedState.familyId,
		recentlyRefinedArtifactIds: new Set(recentRefinedState.latestArtifactIds),
		currentGeneratedArtifactId: selection.primaryArtifactId,
		latestGeneratedArtifactIds: selection.latestArtifactIds,
		currentGeneratedReasonCodes: new Set(selection.primaryReasonCodes),
	};
}

export function resolveWorkingDocumentSelection(
	params: ResolveWorkingDocumentSelectionParams,
): WorkingDocumentSelection {
	const attachmentIds = params.attachmentIds ?? [];
	const workingDocumentSignalState = buildWorkingDocumentSignalState({
		artifacts: params.artifacts,
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		preferredGeneratedArtifactId: params.preferredGeneratedArtifactId,
		currentConversationId: params.currentConversationId,
	});

	const artifactsById = new Map(
		params.artifacts.map((artifact) => [artifact.id, artifact]),
	);
	const activeFocusArtifactIds = orderedIds(
		workingDocumentSignalState.activeDocumentIds,
	);
	const correctionTargetArtifactIds = orderedIds(
		workingDocumentSignalState.correctionTargetIds,
	);
	const recentlyRefinedArtifactIds = orderedIds(
		workingDocumentSignalState.recentlyRefinedArtifactIds,
	);
	const latestGeneratedDocumentIds = orderedIds(
		workingDocumentSignalState.latestGeneratedArtifactIds,
	);
	const currentGeneratedArtifactId =
		workingDocumentSignalState.currentGeneratedArtifactId;
	const reasonCodeArtifactIds = orderedIds([
		...params.artifacts.map((artifact) => artifact.id),
		...activeFocusArtifactIds,
		...correctionTargetArtifactIds,
		...recentlyRefinedArtifactIds,
		currentGeneratedArtifactId,
	]);
	const reasonCodesByArtifactId = new Map<string, WorkingSetReasonCode[]>();
	for (const artifactId of reasonCodeArtifactIds) {
		reasonCodesByArtifactId.set(
			artifactId,
			deriveWorkingDocumentReasonCodes({
				artifactId,
				reasonCodes: getBaseReasonCodes(
					params.reasonCodesByArtifactId,
					artifactId,
				),
				workingDocumentSignalState,
			}),
		);
	}

	const currentArtifactId =
		activeFocusArtifactIds[0] ?? currentGeneratedArtifactId ?? null;
	const currentArtifact = currentArtifactId
		? (artifactsById.get(currentArtifactId) ?? null)
		: null;
	const currentDocument =
		currentArtifactId && !workingDocumentSignalState.hasContextResetSignal
			? {
					artifactId: currentArtifactId,
					familyId: getArtifactFamilyId(currentArtifact),
					reasonCodes: reasonCodesByArtifactId.get(currentArtifactId) ?? [],
					source: activeFocusArtifactIds.includes(currentArtifactId)
						? ("active_focus" as const)
						: ("generated_document" as const),
				}
			: null;

	const candidateArtifactIds = orderedIds([
		...attachmentIds,
		...activeFocusArtifactIds,
		...correctionTargetArtifactIds,
		...recentlyRefinedArtifactIds,
		currentGeneratedArtifactId,
		...latestGeneratedDocumentIds,
	]);
	const candidateSignalsByArtifactId = new Map<
		string,
		WorkingDocumentWorkingSetCandidateSignals
	>();
	for (const artifactId of candidateArtifactIds) {
		candidateSignalsByArtifactId.set(artifactId, {
			isAttachedThisTurn: attachmentIds.includes(artifactId),
			isActiveDocumentFocus:
				workingDocumentSignalState.activeDocumentIds.has(artifactId),
			isRecentUserCorrection:
				workingDocumentSignalState.correctionTargetIds.has(artifactId),
			isRecentlyRefinedDocumentFamily:
				workingDocumentSignalState.recentlyRefinedArtifactIds.has(artifactId),
			isCurrentGeneratedDocument:
				currentGeneratedArtifactId === artifactId &&
				workingDocumentSignalState.currentGeneratedReasonCodes.has(
					"current_generated_document",
				),
			isSelectedCurrentGeneratedDocument:
				currentGeneratedArtifactId === artifactId,
		});
	}

	const workingDocumentProtectedArtifactIds = orderedIds([
		...activeFocusArtifactIds,
		...correctionTargetArtifactIds,
		...recentlyRefinedArtifactIds,
		currentGeneratedArtifactId,
	]);
	const protectedArtifactIds = orderedIds([
		...attachmentIds,
		...workingDocumentProtectedArtifactIds,
	]);

	return {
		documentFocused: workingDocumentSignalState.documentFocused,
		currentDocument,
		latestGeneratedDocumentIds,
		activeFocus: {
			artifactIds: activeFocusArtifactIds,
		},
		correction: {
			hasSignal:
				!workingDocumentSignalState.hasContextResetSignal &&
				workingDocumentSignalState.hasRecentUserCorrection,
			targetArtifactIds: correctionTargetArtifactIds,
		},
		recentRefinement: {
			familyId: workingDocumentSignalState.recentlyRefinedFamilyId,
			artifactIds: recentlyRefinedArtifactIds,
		},
		reset: {
			hasSignal: workingDocumentSignalState.hasContextResetSignal,
			suppressCarryover: workingDocumentSignalState.hasContextResetSignal,
		},
		currentTurnReasonCodesByArtifactId: reasonCodesByArtifactId,
		prompt: {
			reasonCodesByArtifactId,
		},
		workingSet: {
			candidateArtifactIds,
			candidateSignalsByArtifactId,
		},
		retrieval: {
			preferredArtifactId: currentDocument?.artifactId ?? null,
			preferredGeneratedFamilyId:
				workingDocumentSignalState.recentlyRefinedFamilyId,
			suppressGeneratedCarryover:
				workingDocumentSignalState.hasContextResetSignal ||
				hasNewGeneratedDocumentRequestSignal(params.message),
			hasExplicitResetSignal: workingDocumentSignalState.hasContextResetSignal,
		},
		taskEvidence: {
			protectedArtifactIds,
			workingDocumentProtectedArtifactIds,
		},
	};
}
