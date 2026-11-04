<script lang="ts">
// Test-only: the chat page's side of the card. It holds `busy` and `failed` the way the
// page's `askActionState` will, and takes an answer by raising `busy` INSIDE `onAnswer`,
// with no flush in between: that is how the card tells a page that took its answer from
// one that refused it. The testing library's `rerender` flushes inside its own call, so
// it cannot show that the card reads `busy` as soon as `onAnswer` returns.
import type { AskAnswer, AskQuestionDto } from "$lib/shared/ask-user";
import AskQuestionCard from "./AskQuestionCard.svelte";

let {
	question,
	onAnswer = () => {},
}: {
	question: AskQuestionDto;
	onAnswer?: (questionId: string, answer: AskAnswer) => void;
} = $props();

let busy = $state(false);
let failed = $state(false);

/** What the page says once the server has answered: `busy` down, `failed` up. */
export function settle(next: { busy?: boolean; failed?: boolean }) {
	if (next.busy !== undefined) busy = next.busy;
	if (next.failed !== undefined) failed = next.failed;
}
</script>

<AskQuestionCard
	{question}
	{busy}
	{failed}
	onAnswer={(questionId, answer) => {
		busy = true;
		onAnswer(questionId, answer);
	}}
/>
