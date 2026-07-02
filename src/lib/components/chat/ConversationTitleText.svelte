<script lang="ts">
import TypewriterText from "$lib/components/ui/TypewriterText.svelte";

let {
	title,
	defaultTitle = "New Conversation",
	onAnimationComplete,
}: {
	title: string;
	defaultTitle?: string;
	onAnimationComplete?: () => void;
} = $props();

let previousTitle = "";
let isGeneratedTitle = $state(false);
const displayTitle = $derived(title.trim() || defaultTitle);

$effect(() => {
	if (!previousTitle) {
		previousTitle = displayTitle;
		return;
	}

	if (displayTitle !== previousTitle) {
		isGeneratedTitle =
			previousTitle === defaultTitle && displayTitle !== defaultTitle;
		previousTitle = displayTitle;
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
