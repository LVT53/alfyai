import type { ChatMessage } from "$lib/server/services/messages-types";
import {
	type NormalChatOutputEvent,
	type NormalChatOutputProjection,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";

/** Live derived view only; persisted canonical answer remains message.content. */
export type NormalChatOutputMessage = ChatMessage & {
	normalChatOutputView?: NormalChatOutputProjection;
};
const savedViews = new WeakMap<
	NormalChatOutputEvent[],
	NormalChatOutputProjection
>();
export function normalChatOutputView(
	message: NormalChatOutputMessage,
): NormalChatOutputProjection | undefined {
	if (message.normalChatOutputView) return message.normalChatOutputView;
	const saved = message.normalChatOutput;
	if (saved?.version !== 1) return undefined;
	let view = savedViews.get(saved.events);
	if (!view) {
		view = projectNormalChatOutput(saved.events);
		savedViews.set(saved.events, view);
	}
	return view;
}
export function applyNormalChatOutputView(
	messages: ChatMessage[],
	placeholderId: string,
	view: NormalChatOutputProjection,
): ChatMessage[] {
	return messages.map(
		(message): NormalChatOutputMessage =>
			message.id === placeholderId
				? { ...message, content: view.answer, normalChatOutputView: view }
				: message,
	);
}
