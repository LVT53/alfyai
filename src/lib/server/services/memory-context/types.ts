import type { ToolEvidenceCandidate } from "$lib/types";
import type { ProjectContextResult } from "./project";

export type MemoryContextMode = "project" | "persona" | "history";

export type GetMemoryContextParams = {
	userId: string;
	conversationId: string;
	mode?: string | null;
	query?: string | null;
	userDisplayName?: string | null;
	maxSiblings?: number | null;
	siblingConversationId?: string | null;
	maxMessages?: number | null;
	maxHistoryConversations?: number | null;
	historyConversationId?: string | null;
	selectedConversationId?: string | null;
	includeEvidenceCandidates?: boolean;
	includeAttachments?: boolean;
};

export type ProjectMemoryContextResult = Omit<ProjectContextResult, "mode"> & {
	mode: "project";
	projectMode: ProjectContextResult["mode"];
};

export type PersonaMemoryContextResult = {
	success: true;
	mode: "persona";
	status: "available" | "empty" | "error";
	source: "active_memory_profile";
	content: string | null;
	error?: string;
	evidenceCandidates: ToolEvidenceCandidate[];
	audit: {
		conversationId: string;
		query: string;
	};
};

export type HistoryMemoryContextMessage = {
	role: "user" | "assistant";
	content: string;
	createdAt: number;
	attachments?: Array<{ name: string; content: string }>;
};

export type HistoryMemoryContextConversation = {
	conversationId: string;
	title: string;
	summary: string | null;
	updatedAt: number;
	messageSnippets: HistoryMemoryContextMessage[];
};

export type HistoryMemoryContextSelectedConversation =
	HistoryMemoryContextConversation & {
		messages: HistoryMemoryContextMessage[];
		omittedMessageCount: number;
	};

export type HistoryMemoryContextResult = {
	success: true;
	mode: "history";
	status: "available" | "empty";
	source: "conversation_summaries";
	query: string;
	conversations: HistoryMemoryContextConversation[];
	omittedConversationCount: number;
	selectedConversation: HistoryMemoryContextSelectedConversation | null;
	evidenceCandidates: ToolEvidenceCandidate[];
	audit: {
		conversationId: string;
		query: string;
		requestedMaxHistoryConversations: number | null;
		appliedMaxHistoryConversations: number;
		historyConversationId: string | null;
		requestedMaxMessages: number | null;
		appliedMaxMessages: number;
	};
};

export type MemoryContextResult =
	| ProjectMemoryContextResult
	| PersonaMemoryContextResult
	| HistoryMemoryContextResult;
