import { getConfig } from "../config-store";

export type TeiWinningMode =
	| "deterministic"
	| "lexical"
	| "semantic"
	| "rerank"
	| "none";

export type SemanticShortlistDiagnostics = {
	queryLength: number;
	inputCount: number;
	storedEmbeddingCount: number;
	matchCount: number;
	latencyMs: number;
	fallbackReason: string | null;
};

export type TeiRerankDiagnostics = {
	queryLength: number;
	inputCount: number;
	limitedCount: number;
	outputCount: number;
	latencyMs: number;
	fallbackReason: string | null;
	confidence: number | null;
};

export function determineTeiWinningMode(params: {
	lexicalScore?: number;
	semanticScore?: number;
	rerankScore?: number;
	deterministic?: boolean;
}): TeiWinningMode {
	if (params.deterministic) return "deterministic";
	if ((params.rerankScore ?? 0) > 0) return "rerank";
	if ((params.semanticScore ?? 0) > 0) return "semantic";
	if ((params.lexicalScore ?? 0) > 0) return "lexical";
	return "none";
}

export function logTeiRetrievalSummary(params: {
	scope: "documents" | "persona_prompt" | "task_routing";
	userId?: string;
	conversationId?: string;
	queryLength: number;
	candidateCount: number;
	semantic: SemanticShortlistDiagnostics | null;
	rerank: TeiRerankDiagnostics | null;
	winningMode: TeiWinningMode;
	winnerId?: string | null;
	extra?: Record<string, unknown>;
}): void {
	if (!getConfig().contextDiagnosticsDebug) {
		return;
	}

	if (params.queryLength <= 0 || params.candidateCount <= 0) {
		return;
	}

	const semanticUsed = Boolean(
		params.semantic && params.semantic.matchCount > 0,
	);
	const rerankUsed = Boolean(params.rerank && params.rerank.outputCount > 0);
	const fellBack = Boolean(
		params.semantic?.fallbackReason || params.rerank?.fallbackReason,
	);
	if (!semanticUsed && !rerankUsed && !fellBack) {
		return;
	}

	console.info("[TEI] Retrieval summary", {
		scope: params.scope,
		userId: params.userId ?? null,
		conversationId: params.conversationId ?? null,
		queryLength: params.queryLength,
		candidateCount: params.candidateCount,
		winningMode: params.winningMode,
		winnerId: params.winnerId ?? null,
		semantic: params.semantic,
		rerank: params.rerank,
		...params.extra,
	});
}
