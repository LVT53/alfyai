<script lang="ts">
/**
 * The strip of tabs under a page's title, as `PageSwitcher.svelte` draws it
 * for Knowledge and for Settings: one tab is the page you are on, and a tab
 * can carry the dot of its count (the Memory Profile's Needs Review).
 */
import { type I18nKey, t } from "$lib/i18n";

let {
	items,
	active = 0,
}: {
	/** The tabs, left to right, each with its dictionary key. */
	items: readonly { word: I18nKey; badge?: boolean }[];
	/** The index of the tab that is open. */
	active?: number;
} = $props();
</script>

<div class="drawn-switcher">
	{#each items as item, index (item.word)}
		<span class="item" class:active={index === active}>
			<span class="label">{$t(item.word)}</span>
			{#if item.badge}
				<span class="badge"></span>
			{/if}
		</span>
	{/each}
</div>

<style>
	.drawn-switcher {
		display: flex;
		gap: calc(var(--u) * 1);
		padding: calc(var(--u) * 2);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 5);
		background: var(--surface-overlay);
	}

	.item {
		display: inline-flex;
		flex: 1 1 auto;
		align-items: center;
		justify-content: center;
		gap: calc(var(--u) * 3);
		height: calc(var(--u) * 12);
		padding: 0 calc(var(--u) * 4);
		border-radius: calc(var(--u) * 3.5);
		color: var(--text-secondary);
		font-size: calc(var(--u) * 7.5);
		font-weight: 500;
		white-space: nowrap;
	}

	/* The tab that is open: the page's own colour, a little lifted. */
	.item.active {
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-weight: 600;
	}

	.badge {
		flex: none;
		width: calc(var(--u) * 7);
		height: calc(var(--u) * 7);
		border-radius: 50%;
		background: var(--accent);
	}
</style>
