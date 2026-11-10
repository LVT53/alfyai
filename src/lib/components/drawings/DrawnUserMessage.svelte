<script lang="ts">
/** The person's message: the bubble, with its text as grey lines. */
import DrawnBar from "./DrawnBar.svelte";

let { lines = ["86%"] }: { lines?: readonly string[] } = $props();
</script>

<div class="drawn-user-message">
	{#each lines as width}
		<DrawnBar {width} tone="strong" />
	{/each}
</div>

<style>
	.drawn-user-message {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		padding: calc(var(--u) * 6) calc(var(--u) * 8);
		border-radius: calc(var(--u) * 9);
		background: var(--surface-message-user);
	}
</style>
