import type { ChatMessage } from '$lib/types';
import type { I18nKey } from '$lib/i18n';

export const FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE =
	'forked_source_history_confirmation_required';

const forkCreationErrorKeys: Record<string, I18nKey> = {
	source_conversation_not_found: 'fork.errors.sourceConversationNotFound',
	invalid_source_message: 'fork.errors.invalidSourceMessage',
	empty_source_message: 'fork.errors.emptySourceMessage',
	stopped_source_message: 'fork.errors.stoppedSourceMessage',
	required_artifact_unavailable: 'fork.errors.requiredArtifactUnavailable',
	required_artifact_unauthorized: 'fork.errors.requiredArtifactUnauthorized',
	required_generated_work_unavailable:
		'fork.errors.requiredGeneratedWorkUnavailable',
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
				message.role === 'assistant' && (message.sourceForks?.count ?? 0) > 0,
		);
}

export function getForkCreationErrorKey(code: unknown): I18nKey | null {
	return typeof code === 'string' ? (forkCreationErrorKeys[code] ?? null) : null;
}

export function isForkedSourceHistoryConfirmationRequired(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code ===
			FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE
	);
}
