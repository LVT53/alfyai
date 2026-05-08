import type {
	ArtifactSummary,
	ContextDebugEvidenceItem,
	ContextDebugState,
	ContextSourceGroup,
	ContextSourceGroupKind,
	ContextSourceItemState,
	ContextSourcesState,
	ConversationContextStatus,
	EvidenceSourceType,
} from "$lib/types";

export type BuildContextSourcesStateInput = {
	userId: string;
	conversationId: string;
	contextStatus?: ConversationContextStatus | null;
	contextDebug?: ContextDebugState | null;
	attachedArtifacts?: ArtifactSummary[];
	activeWorkingSet?: ArtifactSummary[];
	now?: Date;
};

export function buildContextSourcesState(
	input: BuildContextSourcesStateInput,
): ContextSourcesState {
	const groups = [
		buildArtifactGroup({
			kind: "attachments",
			state: "active",
			artifacts: input.attachedArtifacts ?? [],
			reason: "attached_to_conversation",
		}),
		buildArtifactGroup({
			kind: "working_set",
			state: "active",
			artifacts: input.activeWorkingSet ?? [],
			reason: "active_working_set",
		}),
		buildEvidenceGroup({
			kind: "task_evidence",
			state: "inferred",
			evidence: input.contextDebug?.selectedEvidence ?? [],
		}),
		buildEvidenceGroup({
			kind: "pinned",
			state: "pinned",
			evidence: input.contextDebug?.pinnedEvidence ?? [],
		}),
		buildEvidenceGroup({
			kind: "excluded",
			state: "excluded",
			evidence: input.contextDebug?.excludedEvidence ?? [],
		}),
		buildMemoryGroup(input.contextDebug),
	].filter((group): group is ContextSourceGroup => Boolean(group));

	const selectedCount =
		input.contextDebug?.selectedEvidence.length ??
		input.contextStatus?.promptArtifactCount ??
		0;
	const pinnedCount = input.contextDebug?.pinnedEvidence.length ?? 0;
	const excludedCount = input.contextDebug?.excludedEvidence.length ?? 0;
	const compacted = Boolean(
		input.contextStatus?.compactionApplied ||
			(input.contextStatus && input.contextStatus.compactionMode !== "none"),
	);
	const reduced = compacted;

	return {
		conversationId: input.conversationId,
		userId: input.userId,
		activeCount: countUniqueItems(
			groups.filter(
				(group) => group.state === "active" || group.state === "pinned",
			),
		),
		inferredCount: countUniqueItems(
			groups.filter((group) => group.state === "inferred"),
		),
		selectedCount,
		pinnedCount,
		excludedCount,
		reduced,
		compacted,
		groups: groups.map((group) => ({
			...group,
			items: group.items.map((item) => ({
				...item,
				reduced,
				compacted,
			})),
		})),
		updatedAt: input.now?.getTime() ?? Date.now(),
	};
}

function buildArtifactGroup(input: {
	kind: ContextSourceGroupKind;
	state: ContextSourceItemState;
	artifacts: ArtifactSummary[];
	reason: string;
}): ContextSourceGroup | null {
	if (input.artifacts.length === 0) return null;
	const items = input.artifacts.map((artifact) => ({
		id: `${input.kind}:${artifact.id}`,
		artifactId: artifact.id,
		title: artifact.name,
		state: input.state,
		sourceType: toSourceType(artifact.type),
		artifactType: artifact.type,
		reason: input.reason,
	}));
	return {
		kind: input.kind,
		state: input.state,
		totalCount: items.length,
		items,
	};
}

function buildEvidenceGroup(input: {
	kind: ContextSourceGroupKind;
	state: ContextSourceItemState;
	evidence: ContextDebugEvidenceItem[];
}): ContextSourceGroup | null {
	if (input.evidence.length === 0) return null;
	const items = input.evidence.map((item) => ({
		id: `${input.kind}:${item.artifactId}`,
		artifactId: item.artifactId,
		title: item.name,
		state: input.state,
		sourceType: item.sourceType,
		artifactType: item.artifactType,
		reason: item.reason,
	}));
	return {
		kind: input.kind,
		state: input.state,
		totalCount: items.length,
		items,
	};
}

function buildMemoryGroup(
	contextDebug: ContextDebugState | null | undefined,
): ContextSourceGroup | null {
	if (!contextDebug?.honcho) return null;
	return {
		kind: "memory",
		state: "inferred",
		totalCount: 1,
		items: [
			{
				id: "memory:honcho",
				title: "Session memory",
				state: "inferred",
				sourceType: "memory",
				reason: contextDebug.honcho.source,
			},
		],
	};
}

function countUniqueItems(groups: ContextSourceGroup[]): number {
	const ids = new Set<string>();
	for (const group of groups) {
		for (const item of group.items) {
			ids.add(item.artifactId ?? item.id);
		}
	}
	return ids.size;
}

function toSourceType(artifactType: ArtifactSummary["type"]): EvidenceSourceType {
	if (artifactType === "conversation_summary" || artifactType === "work_capsule") {
		return "memory";
	}
	return "document";
}
