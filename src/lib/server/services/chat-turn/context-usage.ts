// Post-turn prompt usage for the chat header context usage ring.
//
// The pre-request context-status write (context-selection.ts) only knows the
// user-message packet estimate. Once a turn completes we know either the
// provider's reported input tokens (the real prompt size) or, failing that, a
// full-prompt estimate (system prompt + final packet + tool schemas) computed
// by the model-run wrappers. This module folds that figure back into
// conversation_context_status so the ring reports promptTokens against the
// model's real context window, and returns the refreshed status for the
// terminal stream metadata / send response.

import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import { recordConversationPromptUsage } from "$lib/server/services/knowledge";
import type {
	ContextPromptTokensSource,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";

export type CompletedTurnPromptUsage = {
	promptTokens: number;
	promptTokensSource: ContextPromptTokensSource;
};

function toPositiveCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.round(value)
		: null;
}

/**
 * Picks the best-known prompt size for a completed turn.
 *
 * Provider-reported input tokens win. `lastStepPromptTokens` (the final
 * step's own input count) is preferred over `promptTokens`, which sums every
 * step of a multi-step tool loop and therefore overstates the prompt the
 * model actually saw last. Without provider usage the
 * wrapper's full-prompt estimate is used, and as a last resort the
 * pre-request packet estimate already on the status row.
 */
export function resolveCompletedTurnPromptUsage(params: {
	providerUsage: ProviderUsageSnapshot | null | undefined;
	estimatedPromptTokens?: number | null;
	contextStatus?: ConversationContextStatus | null;
}): CompletedTurnPromptUsage | null {
	const reported =
		toPositiveCount(params.providerUsage?.lastStepPromptTokens) ??
		toPositiveCount(params.providerUsage?.promptTokens);
	if (reported !== null) {
		return { promptTokens: reported, promptTokensSource: "provider" };
	}
	const estimated =
		toPositiveCount(params.estimatedPromptTokens) ??
		toPositiveCount(params.contextStatus?.estimatedTokens);
	if (estimated !== null) {
		return { promptTokens: estimated, promptTokensSource: "estimated" };
	}
	return null;
}

/**
 * Persists the completed turn's prompt usage and returns the refreshed
 * context status. Never throws: a failed write logs and falls back to an
 * in-memory copy of the incoming status carrying the new figures, so the
 * client still sees the updated ring for this turn. Returns the incoming
 * status untouched when there is nothing to record.
 */
export async function recordCompletedTurnContextUsage(params: {
	userId: string;
	conversationId: string;
	contextStatus: ConversationContextStatus | null | undefined;
	providerUsage: ProviderUsageSnapshot | null | undefined;
	estimatedPromptTokens?: number | null;
	logPrefix?: string;
}): Promise<ConversationContextStatus | null | undefined> {
	const usage = resolveCompletedTurnPromptUsage({
		providerUsage: params.providerUsage,
		estimatedPromptTokens: params.estimatedPromptTokens,
		contextStatus: params.contextStatus,
	});
	if (!usage) return params.contextStatus;

	try {
		const updated = await recordConversationPromptUsage({
			userId: params.userId,
			conversationId: params.conversationId,
			promptTokens: usage.promptTokens,
			promptTokensSource: usage.promptTokensSource,
		});
		if (updated) return updated;
	} catch (error) {
		console.warn(
			`${params.logPrefix ?? "[CHAT_TURN]"} Failed to record prompt usage`,
			{
				conversationId: params.conversationId,
				promptTokensSource: usage.promptTokensSource,
				error,
			},
		);
	}

	return params.contextStatus
		? {
				...params.contextStatus,
				promptTokens: usage.promptTokens,
				promptTokensSource: usage.promptTokensSource,
			}
		: params.contextStatus;
}
