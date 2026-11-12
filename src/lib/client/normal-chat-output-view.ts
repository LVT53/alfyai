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

/**
 * Whether the answer area draws the provisional preview: the text of the step
 * being written, which its first tool call withdraws. Only a reply that is
 * being read live shows it: not in its finalizing tail, not once it has a
 * completion, and not while the browser only polls (`polling`: a pending
 * observation after the connection dropped and the turn could not be replayed).
 * A browser that only polls reads no frames, so the step it last saw may have
 * called a tool since, which would have withdrawn its text; that preview must
 * not stand in for the answer. When frames resume the phase is `generating`
 * again and the preview is drawn again. The preview is a display only: text
 * already committed as the answer (`message.content`) is not a preview and is
 * drawn either way, and the reply stays live (`isStreaming`) while it is polled.
 */
export function showsProvisionalPreview(
	message: NormalChatOutputMessage,
	view: NormalChatOutputView | undefined = normalChatOutputView(message),
): boolean {
	if (!message.isStreaming && !message.isThinkingStreaming) return false;
	if (
		message.runtimePhase === "finalizing" ||
		message.runtimePhase === "polling"
	)
		return false;
	return !view?.completion;
}
