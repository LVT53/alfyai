import type { ChatMessage } from "$lib/server/services/messages-types";
import {
	type NormalChatCompletion,
	type NormalChatFinalizationFailure,
	parseNormalChatFinalization,
	projectNormalChatFinalization,
} from "$lib/shared/normal-chat-completion";
import {
	type NormalChatOutputEvent,
	type NormalChatOutputProjection,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";

export type NormalChatOutputView = NormalChatOutputProjection & {
	modelCompletion?: NormalChatCompletion;
	normalChatFinalization?: NormalChatFinalizationFailure;
};

/** Live derived view only; persisted canonical answer remains message.content. */
export type NormalChatOutputMessage = ChatMessage & {
	normalChatOutputView?: NormalChatOutputView;
};
const savedViews = new WeakMap<
	NormalChatOutputEvent[],
	NormalChatOutputProjection
>();
export function normalChatOutputView(
	message: NormalChatOutputMessage,
): NormalChatOutputView | undefined {
	let view = message.normalChatOutputView;
	const saved = message.normalChatOutput;
	if (!view && saved?.version === 1) {
		view = savedViews.get(saved.events);
		if (!view) {
			view = projectNormalChatOutput(saved.events);
			savedViews.set(saved.events, view);
		}
	}
	// Cache raw model projection only. A durable fact can arrive with the same
	// events array or an existing live view after model settlement.
	const marker = parseNormalChatFinalization(
		message.normalChatFinalization ?? view?.normalChatFinalization,
	);
	if (!marker) return view;
	const modelCompletion = view?.modelCompletion ?? view?.completion;
	return {
		...(view ?? { answer: message.content, activity: [], blocks: [] }),
		modelCompletion,
		completion: projectNormalChatFinalization(modelCompletion, marker),
		normalChatFinalization: marker,
	};
}

export function applyNormalChatOutputView(
	messages: ChatMessage[],
	placeholderId: string,
	view: NormalChatOutputView,
): ChatMessage[] {
	return messages.map(
		(message): NormalChatOutputMessage =>
			message.id === placeholderId
				? {
						...message,
						content: view.answer,
						normalChatOutputView: view,
						normalChatFinalization:
							view.normalChatFinalization ?? message.normalChatFinalization,
					}
				: message,
	);
}
