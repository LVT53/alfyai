import {
	findRelevantKnowledgeArtifacts,
	resolvePromptAttachmentArtifacts,
	selectWorkingSetArtifactsForPrompt,
} from "$lib/server/services/knowledge";
import type { Artifact } from "$lib/types";
import type { PlanningContextItem } from "./planning";

export type BuildDeepResearchPlanningContextInput = {
	userId: string;
	conversationId: string;
	userRequest: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	maxItems?: number;
	maxSummaryLength?: number;
};

type AttachmentResolution = Awaited<
	ReturnType<typeof resolvePromptAttachmentArtifacts>
>;

export type DeepResearchPlanningContextDependencies = {
	resolvePromptAttachmentArtifacts?: (
		userId: string,
		attachmentIds: string[],
	) => Promise<AttachmentResolution>;
	selectWorkingSetArtifactsForPrompt?: (
		userId: string,
		conversationId: string,
		message: string,
		excludeArtifactIds?: string[],
		activeDocumentArtifactId?: string,
	) => Promise<Artifact[]>;
	findRelevantKnowledgeArtifacts?: typeof findRelevantKnowledgeArtifacts;
};

const DEFAULT_MAX_CONTEXT_ITEMS = 8;
const DEFAULT_MAX_SUMMARY_LENGTH = 800;

export async function buildDeepResearchPlanningContext(
	input: BuildDeepResearchPlanningContextInput,
	dependencies: DeepResearchPlanningContextDependencies = {},
): Promise<PlanningContextItem[]> {
	const attachmentIds = input.attachmentIds ?? [];
	const maxItems = Math.max(0, input.maxItems ?? DEFAULT_MAX_CONTEXT_ITEMS);
	const maxSummaryLength = Math.max(
		80,
		input.maxSummaryLength ?? DEFAULT_MAX_SUMMARY_LENGTH,
	);
	const contextItems: PlanningContextItem[] = [];
	const seenArtifactIds = new Set<string>();

	if (maxItems === 0) return [];

	if (attachmentIds.length > 0) {
		const resolvedAttachments = await (
			dependencies.resolvePromptAttachmentArtifacts ??
			resolvePromptAttachmentArtifacts
		)(input.userId, attachmentIds);

		for (const item of resolvedAttachments.items) {
			if (!item.promptReady || !item.promptArtifact) continue;
			appendContextItem(
				contextItems,
				seenArtifactIds,
				artifactToPlanningContextItem(item.promptArtifact, {
					type: "attachment",
					includeAsResearchSource: true,
					maxSummaryLength,
				}),
				maxItems,
			);
		}
	}

	if (contextItems.length >= maxItems) return contextItems;

	const knowledgeArtifacts = await collectKnowledgeArtifacts(
		input,
		dependencies,
		attachmentIds,
	);
	for (const artifact of knowledgeArtifacts) {
		appendContextItem(
			contextItems,
			seenArtifactIds,
			artifactToPlanningContextItem(artifact, {
				type: "knowledge",
				includeAsResearchSource: false,
				maxSummaryLength,
			}),
			maxItems,
		);
		if (contextItems.length >= maxItems) break;
	}

	return contextItems;
}

async function collectKnowledgeArtifacts(
	input: BuildDeepResearchPlanningContextInput,
	dependencies: DeepResearchPlanningContextDependencies,
	attachmentIds: string[],
): Promise<Artifact[]> {
	const selectWorkingSet =
		dependencies.selectWorkingSetArtifactsForPrompt ??
		selectWorkingSetArtifactsForPrompt;
	const findRelevant =
		dependencies.findRelevantKnowledgeArtifacts ??
		findRelevantKnowledgeArtifacts;

	const [workingSetArtifacts, relevantArtifacts] = await Promise.all([
		selectWorkingSet(
			input.userId,
			input.conversationId,
			input.userRequest,
			attachmentIds,
			input.activeDocumentArtifactId,
		).catch(() => []),
		findRelevant({
			userId: input.userId,
			query: input.userRequest,
			excludeConversationId: input.conversationId,
			currentConversationId: input.conversationId,
			limit: input.maxItems ?? DEFAULT_MAX_CONTEXT_ITEMS,
			preferredArtifactId: input.activeDocumentArtifactId,
		}).catch(() => []),
	]);

	return [...workingSetArtifacts, ...relevantArtifacts];
}

function artifactToPlanningContextItem(
	artifact: Artifact,
	options: {
		type: PlanningContextItem["type"];
		includeAsResearchSource: boolean;
		maxSummaryLength: number;
	},
): PlanningContextItem {
	return {
		type: options.type,
		artifactId: artifact.id,
		title: artifact.name,
		summary: summarizeArtifact(artifact, options.maxSummaryLength),
		includeAsResearchSource: options.includeAsResearchSource,
	};
}

function appendContextItem(
	items: PlanningContextItem[],
	seenArtifactIds: Set<string>,
	item: PlanningContextItem,
	maxItems: number,
): void {
	if (items.length >= maxItems) return;
	if (item.artifactId) {
		if (seenArtifactIds.has(item.artifactId)) return;
		seenArtifactIds.add(item.artifactId);
	}
	items.push(item);
}

function summarizeArtifact(
	artifact: Artifact,
	maxSummaryLength: number,
): string {
	const rawSummary =
		artifact.summary?.trim() || artifact.contentText?.trim() || artifact.name;
	const collapsed = rawSummary.replace(/\s+/g, " ");
	if (collapsed.length <= maxSummaryLength) return collapsed;
	return `${collapsed.slice(0, Math.max(0, maxSummaryLength - 1)).trimEnd()}…`;
}
