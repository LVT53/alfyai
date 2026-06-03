import { z } from "zod";

import type { MemoryContextResult } from "$lib/server/services/memory-context";
import type { ToolCallEntry, ToolEvidenceCandidate } from "$lib/types";

import { sanitizeMetadata, truncateText } from "./shared";

export const memoryContextInputSchema = z.object({
	mode: z
		.enum(["persona", "project", "history"])
		.optional()
		.describe(
			"Memory scope. Use project for project folders/continuity, persona for user preferences/profile, and history for older account chats outside a project.",
		),
	query: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Specific lookup question or named entity. For named project folders, include the exact folder name, e.g. 'AlmaLinux Server'. Folder-wide report/export requests return bounded report context in one call.",
		),
	maxSiblings: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Maximum project sibling conversations to return. For folder-wide reports, keep this at or below 16 and use the returned reportSiblings instead of one detail call per sibling.",
		),
	siblingConversationId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"One conversation id returned by a previous project result when requesting deeper project detail.",
		),
	maxMessages: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Maximum recent messages to return for a selected conversation, or per sibling for folder-wide report context.",
		),
	maxHistoryConversations: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Maximum older history conversations to return."),
	historyConversationId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"One conversation id returned by history mode for deeper detail.",
		),
	selectedConversationId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Alias for selecting one returned history conversation for detail.",
		),
	includeEvidenceCandidates: z
		.boolean()
		.optional()
		.describe(
			"Whether to include bounded evidence candidates for UI citations.",
		),
});

export type MemoryContextInput = z.infer<typeof memoryContextInputSchema>;

export function sanitizeMemoryContextInput(
	input: MemoryContextInput,
): MemoryContextInput {
	return {
		...(input.mode ? { mode: input.mode } : {}),
		...(input.query ? { query: input.query } : {}),
		...(input.maxSiblings ? { maxSiblings: input.maxSiblings } : {}),
		...(input.siblingConversationId
			? { siblingConversationId: input.siblingConversationId }
			: {}),
		...(input.maxMessages ? { maxMessages: input.maxMessages } : {}),
		...(input.maxHistoryConversations
			? { maxHistoryConversations: input.maxHistoryConversations }
			: {}),
		...(input.historyConversationId
			? { historyConversationId: input.historyConversationId }
			: {}),
		...(input.selectedConversationId
			? { selectedConversationId: input.selectedConversationId }
			: {}),
		...(input.includeEvidenceCandidates !== undefined
			? { includeEvidenceCandidates: input.includeEvidenceCandidates }
			: {}),
	};
}

export function memoryContextCandidateLimit(
	input: MemoryContextInput,
	result: MemoryContextResult,
): number {
	const isDetail = Boolean(
		input.siblingConversationId ||
			input.historyConversationId ||
			input.selectedConversationId,
	);
	if (result.mode === "history" && !isDetail) {
		return (
			input.maxHistoryConversations ??
			result.audit.appliedMaxHistoryConversations
		);
	}
	if (isDetail) {
		return (
			input.maxMessages ??
			("appliedMaxMessages" in result.audit
				? (result.audit.appliedMaxMessages ?? 6)
				: 6)
		);
	}
	if (result.mode === "project") {
		return input.maxSiblings ?? result.audit.appliedMaxSiblings;
	}
	return 5;
}

export function compactMemoryContextCandidates(
	result: MemoryContextResult,
	limit: number,
): ToolEvidenceCandidate[] {
	return result.evidenceCandidates.slice(0, limit).map((candidate) => ({
		id: candidate.id,
		title: truncateText(candidate.title, 180),
		...(candidate.url ? { url: candidate.url } : {}),
		...(candidate.snippet
			? { snippet: truncateText(candidate.snippet, 500) }
			: {}),
		sourceType: "memory",
		...(candidate.selected !== undefined
			? { selected: candidate.selected }
			: {}),
		...(candidate.material !== undefined
			? { material: candidate.material }
			: {}),
		...(candidate.status ? { status: candidate.status } : {}),
		...(candidate.metadata
			? { metadata: sanitizeMetadata(candidate.metadata) }
			: {}),
	}));
}

export function compactMemoryContextModelPayload(
	result: MemoryContextResult,
	evidenceCandidates: ToolEvidenceCandidate[],
) {
	return {
		success: true as const,
		name: "memory_context",
		sourceType: "memory",
		mode: result.mode,
		status: "status" in result ? result.status : undefined,
		hasProjectContext:
			"hasProjectContext" in result ? result.hasProjectContext : false,
		source: result.source,
		content: "content" in result ? result.content : undefined,
		project: "project" in result ? result.project : undefined,
		siblings: "siblings" in result ? result.siblings : [],
		reportSiblings: "reportSiblings" in result ? result.reportSiblings : [],
		selectedSibling:
			"selectedSibling" in result ? result.selectedSibling : null,
		omittedSiblingCount:
			"omittedSiblingCount" in result ? result.omittedSiblingCount : 0,
		conversations: "conversations" in result ? result.conversations : [],
		selectedConversation:
			"selectedConversation" in result ? result.selectedConversation : null,
		omittedConversationCount:
			"omittedConversationCount" in result
				? result.omittedConversationCount
				: 0,
		evidenceCandidates,
		audit: result.audit,
		instructions:
			"Use this as memory context only. Do not claim details that are not present in the returned payload.",
	};
}

export function createMemoryContextMetadata(
	result: MemoryContextResult,
): ToolCallEntry["metadata"] {
	const metadata: NonNullable<ToolCallEntry["metadata"]> = {
		ok: true,
		evidenceReady: true,
		mode: result.mode,
		status: "status" in result ? result.status : null,
		hasProjectContext:
			"hasProjectContext" in result ? result.hasProjectContext : false,
		omittedSiblingCount:
			"omittedSiblingCount" in result ? result.omittedSiblingCount : 0,
		omittedConversationCount:
			"omittedConversationCount" in result
				? result.omittedConversationCount
				: 0,
	};
	for (const key of [
		"requestedMaxSiblings",
		"appliedMaxSiblings",
		"requestedMaxHistoryConversations",
		"appliedMaxHistoryConversations",
		"requestedMaxMessages",
		"appliedMaxMessages",
	] as const) {
		if (!(key in result.audit)) continue;
		const value = result.audit[key as keyof typeof result.audit];
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null
		) {
			metadata[key] = value;
		}
	}
	const selectedConversation =
		"selectedConversation" in result ? result.selectedConversation : null;
	if (selectedConversation) {
		metadata.omittedMessageCount = selectedConversation.omittedMessageCount;
	}
	const selectedSibling =
		"selectedSibling" in result ? result.selectedSibling : null;
	if (selectedSibling) {
		metadata.omittedMessageCount = selectedSibling.omittedMessageCount;
	}
	return metadata;
}

export function summarizeMemoryContextResult(
	result: MemoryContextResult,
): string {
	if (result.mode === "persona") {
		return `Persona memory status: ${result.status}`;
	}
	if (result.mode === "history") {
		return `History memory status: ${result.status}; conversations: ${result.conversations.length}`;
	}
	if (result.hasProjectContext) {
		return `Project memory found: ${result.project?.name ?? "Project"}`;
	}
	return "No project memory found for this conversation.";
}
