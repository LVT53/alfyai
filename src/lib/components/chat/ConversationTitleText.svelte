<script lang="ts">
import TypewriterText from "$lib/components/ui/TypewriterText.svelte";
import { t } from "$lib/i18n";
import {
	conversationDisplayTitle,
	isUntitledConversationTitle,
} from "$lib/shared/conversation-title";

let {
	title,
	onAnimationComplete,
}: {
	title: string;
	onAnimationComplete?: () => void;
} = $props();

// What a conversation is called until something names it is stored as one
// English sentence; a reader sees it in their own language (F5).
const untitled = $derived(isUntitledConversationTitle(title));
const displayTitle = $derived(
	conversationDisplayTitle(title, $t("chat.untitledConversation")),
);

let previous: { title: string; untitled: boolean } | null = null;
let isGeneratedTitle = $state(false);

// A generated title types itself in only when it replaces the untitled
// state. Compared on the STORED title, never on what is printed, so changing
// the interface language while a conversation is untitled is not a "new title".
$effect(() => {
	const current = { title: title.trim(), untitled };
	if (!previous) {
		previous = current;
		return;
	}
	if (current.title !== previous.title) {
		isGeneratedTitle = previous.untitled && !current.untitled;
		previous = current;
	}
});

function handleAnimationComplete() {
	isGeneratedTitle = false;
	onAnimationComplete?.();
}
</script>

{#if isGeneratedTitle}
	<TypewriterText text={displayTitle} onComplete={handleAnimationComplete} />
{:else}
	{displayTitle}
{/if}
