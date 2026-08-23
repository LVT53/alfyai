import type { I18nKey } from "$lib/i18n";
import type { ChatMessage } from "$lib/server/services/messages-types";

export const FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE =
	"forked_source_history_confirmation_required";

const forkCreationErrorKeys: Record<string, I18nKey> = {
	source_conversation_not_found: "fork.errors.sourceConversationNotFound",
	invalid_source_message: "fork.errors.invalidSourceMessage",
	empty_source_message: "fork.errors.emptySourceMessage",
	stopped_source_message: "fork.errors.stoppedSourceMessage",
	required_artifact_unavailable: "fork.errors.requiredArtifactUnavailable",
	required_artifact_unauthorized: "fork.errors.requiredArtifactUnauthorized",
	required_generated_work_unavailable:
		"fork.errors.requiredGeneratedWorkUnavailable",
	fork_sequence_conflict: "fork.errors.sequenceConflict",
};

export function hasForkedAssistantInRange(
	messages: ChatMessage[],
	startIndex: number,
): boolean {
	if (startIndex < 0 || startIndex >= messages.length) return false;
	return messages
		.slice(startIndex)
		.some(
			(message) =>
				message.role === "assistant" && (message.sourceForks?.count ?? 0) > 0,
		);
}

/**
 * Number of messages that follow `assistantIdx` in `messages` — i.e. how
 * many later turns a destructive regenerate at that index would discard.
 * Returns 0 when `assistantIdx` is the last message (or out of range).
 */
export function laterTurnCount(
	messages: ChatMessage[],
	assistantIdx: number,
): number {
	if (assistantIdx < 0 || assistantIdx >= messages.length) return 0;
	return messages.length - 1 - assistantIdx;
}

/**
 * Whether regenerating the assistant message at `assistantIdx` would drop
 * later turns from the conversation (B1). Deliberately fork-agnostic: when
 * `hasForkedAssistantInRange` is also true for the same range, callers
 * should show only the fork warning and skip prompting via this helper —
 * a fork in range implies later turns exist, so one confirmation suffices.
 */
export function regenerateDropsLaterTurns(
	messages: ChatMessage[],
	assistantIdx: number,
): boolean {
	return laterTurnCount(messages, assistantIdx) > 0;
}

export function getForkCreationErrorKey(code: unknown): I18nKey | null {
	return typeof code === "string"
		? (forkCreationErrorKeys[code] ?? null)
		: null;
}

export function isForkedSourceHistoryConfirmationRequired(
	error: unknown,
): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code ===
			FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE
	);
}
