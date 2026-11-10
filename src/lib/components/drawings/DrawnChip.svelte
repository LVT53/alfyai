<script lang="ts">
/**
 * A filter chip of the Knowledge Base (`.documents-filter-chip`): a pill with
 * the kind's icon and its word. The open one has the accent for a border.
 */
import type { Component } from "svelte";
import { type I18nKey, t } from "$lib/i18n";

let {
	word,
	icon = undefined,
	active = false,
}: {
	word: I18nKey;
	/** The kind's Lucide icon; the chip for everything has none. */
	icon?: Component | undefined;
	active?: boolean;
} = $props();

let Icon = $derived(icon);
</script>

<span class="drawn-chip" class:active>
	{#if Icon}
		<span class="drawn-ic" style:--ic="8"><Icon size="100%" strokeWidth={2} aria-hidden="true" /></span>
	{/if}
	<span class="word">{$t(word)}</span>
</span>

<style>
	.drawn-chip {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: calc(var(--u) * 2.5);
		height: calc(var(--u) * 11);
		padding: 0 calc(var(--u) * 4.5);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 11);
		background: var(--surface-page);
		color: var(--text-muted);
		font-size: calc(var(--u) * 7);
		white-space: nowrap;
	}

	.drawn-chip.active {
		border-color: var(--accent);
		background: var(--surface-elevated);
		color: var(--text-primary);
		font-weight: 600;
	}
</style>
