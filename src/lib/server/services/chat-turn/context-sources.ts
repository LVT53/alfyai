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
	LinkedContextSource,
} from "$lib/types";
import type {
	ProjectFolderReferenceContext,
	ProjectReferenceContext,
} from "$lib/server/services/task-state/continuity";

export type BuildContextSourcesStateInput = {
	userId: string;
	conversationId: string;
	contextStatus?: ConversationContextStatus | null;
	contextDebug?: ContextDebugState | null;
	attachedArtifacts?: ArtifactSummary[];
	linkedSources?: LinkedContextSource[];
	activeWorkingSet?: ArtifactSummary[];
	projectReference?: ProjectReferenceContext | null;
	projectFolderReference?: ProjectFolderReferenceContext | null;
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
		buildLinkedSourceGroup(input.linkedSources ?? []),
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
		buildForkHistoryGroup(input.contextDebug),
		buildProjectReferenceGroup(
			input.projectReference ??
				(input.projectFolderReference
					? { ...input.projectFolderReference, source: "project_folder" }
					: null),
		),
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

function buildForkHistoryGroup(
	contextDebug: ContextDebugState | null | undefined,
): ContextSourceGroup | null {
	const provenance = contextDebug?.forkProvenance;
	if (!provenance || provenance.inheritedMessageCount === 0) return null;
	return {
		kind: "conversation",
		state: "inferred",
		totalCount: 1,
		items: [
			{
				id: "conversation:fork-inherited-history",
				title: "Inherited fork history",
				state: "inferred",
				sourceType: "conversation",
				reason: "fork_inherited_history",
				metadata: {
					inheritedMessageCount: provenance.inheritedMessageCount,
					inheritedTurnCount: provenance.inheritedTurnCount,
					forkLocalMessageCount: provenance.forkLocalMessageCount,
					sourceConversationCount: provenance.sourceConversationIds.length,
					sourceMessageCount: provenance.sourceMessageIds.length,
					copiedForkPointMessageId:
						provenance.copiedForkPointMessageId ?? null,
				},
			},
		],
	};
}

function buildLinkedSourceGroup(
	linkedSources: LinkedContextSource[],
): ContextSourceGroup | null {
	if (linkedSources.length === 0) return null;
	const items = linkedSources.map((source) => ({
		id: `linked_source:${source.displayArtifactId}`,
		artifactId: source.displayArtifactId,
		title: source.name,
		state: "active" as const,
		sourceType: "document" as const,
		artifactType: "document" as const,
		reason: "linked_context_source",
		metadata: {
			promptArtifactId: source.promptArtifactId ?? null,
			documentOrigin: source.documentOrigin ?? null,
		},
	}));
	return {
		kind: "linked_source",
		state: "active",
		totalCount: items.length,
		items,
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

function buildProjectReferenceGroup(
	projectFolderReference: ProjectReferenceContext | null | undefined,
): ContextSourceGroup | null {
	if (!projectFolderReference || projectFolderReference.entries.length === 0) {
		return null;
	}

	const isFolder = projectFolderReference.source === "project_folder";
	const kind: Extract<ContextSourceGroupKind, "project_folder" | "project_continuity"> =
		isFolder ? "project_folder" : "project_continuity";
	const includedSiblingCount = projectFolderReference.entries.length;
	const siblingCount =
		includedSiblingCount + projectFolderReference.omittedSiblingCount;
	const siblingSummary = projectFolderReference.entries
		.map((entry) =>
			entry.summary
				? `${entry.title}: ${entry.summary}`
				: entry.objective
					? `${entry.title}: ${entry.objective}`
					: entry.title,
		)
		.join(" ");
	const reason =
		projectFolderReference.omittedSiblingCount > 0
			? `${includedSiblingCount} ${isFolder ? "sibling" : "linked"} conversations summarized, ${projectFolderReference.omittedSiblingCount} more omitted`
			: `${includedSiblingCount} ${isFolder ? "sibling" : "linked"} conversation${includedSiblingCount === 1 ? "" : "s"} summarized`;

	return {
		kind,
		state: "inferred",
		totalCount: siblingCount,
		items: [
			{
				id: `${kind}:${projectFolderReference.projectId}`,
				title: projectFolderReference.projectName,
				state: "inferred",
				sourceType: "conversation",
				reason,
				metadata: {
					projectId: projectFolderReference.projectId,
					projectName: projectFolderReference.projectName,
					siblingCount,
					includedSiblingCount,
					omittedSiblingCount: projectFolderReference.omittedSiblingCount,
					siblingSummary,
					...(isFolder ? {} : { authority: projectFolderReference.source }),
				},
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
