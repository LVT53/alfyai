<script lang="ts">
/**
 * A Settings card (`.settings-card`): a bordered surface with its title, and
 * the rows under it. A drawing may show only the rows it is about, so the title
 * is optional.
 */
import type { Snippet } from "svelte";
import { type I18nKey, t } from "$lib/i18n";

let {
	title = undefined,
	children = undefined,
}: {
	/** The card's heading, as its dictionary key. */
	title?: I18nKey | undefined;
	children?: Snippet | undefined;
} = $props();
</script>

<div class="drawn-settings-card">
	{#if title}
		<p class="title">{$t(title)}</p>
	{/if}
	{@render children?.()}
</div>

<style>
	.drawn-settings-card {
		padding: calc(var(--u) * 5) calc(var(--u) * 7);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 5);
		background: var(--surface-overlay);
	}

	.title {
		margin: 0 0 calc(var(--u) * 2);
		color: var(--text-primary);
		font-size: calc(var(--u) * 9);
		font-weight: 600;
		line-height: 1.25;
	}
</style>
