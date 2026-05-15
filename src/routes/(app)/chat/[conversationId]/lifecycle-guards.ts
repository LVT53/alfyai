import type { ChatMessage } from '$lib/types';

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
