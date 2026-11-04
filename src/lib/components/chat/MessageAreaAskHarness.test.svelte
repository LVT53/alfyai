<script lang="ts">
// Test-only: the chat page's side of the cards, where MessageArea hands them their state.
// It holds `askActionState` the way the page will and takes an answer by raising the
// question's `busy` INSIDE `onAnswerQuestion`, with no flush in between: the card reads
// `busy` live through MessageArea and MessageBubble, so the very next press finds it off.
// The testing library's `rerender` flushes inside its own call, so it could not show that.
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { AskAnswer, AskQuestionDto } from "$lib/shared/ask-user";
import MessageArea from "./MessageArea.svelte";

let {
	messages,
	questions,
	onAnswer = () => {},
}: {
	messages: ChatMessage[];
	questions: AskQuestionDto[];
	onAnswer?: (questionId: string, answer: AskAnswer) => void;
} = $props();

let askActionState = $state<
	Record<string, { busy?: boolean; failed?: boolean }>
>({});
</script>

<MessageArea
	{messages}
	{questions}
	conversationId="conv-1"
	{askActionState}
	onAnswerQuestion={(questionId, answer) => {
		askActionState[questionId] = { busy: true };
		onAnswer(questionId, answer);
	}}
/>
