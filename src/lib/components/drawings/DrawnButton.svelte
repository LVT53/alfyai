<script lang="ts">
/**
 * A button as the app draws one: its word and the icon it carries. `link` is
 * the quiet button of a Settings row (`.settings-row-link`), `secondary` the
 * outlined `.btn-secondary`, `dialog` a dialog's button and `positive` the one
 * of its two that answers yes (`DialogShell.svelte`).
 */
import { ChevronRight } from "@lucide/svelte";
import type { Component } from "svelte";
import { type I18nKey, t } from "$lib/i18n";

let {
	word,
	variant = "link",
	icon = undefined,
	chevron = false,
}: {
	word: I18nKey;
	variant?: "link" | "secondary" | "dialog" | "positive";
	/** The Lucide icon before the word, if the real button has one. */
	icon?: Component | undefined;
	/** The chevron after it, for a button that opens something. */
	chevron?: boolean;
} = $props();

let Icon = $derived(icon);
</script>

<span class="drawn-button {variant}">
	{#if Icon}
		<span class="drawn-ic" style:--ic="9"><Icon size="100%" strokeWidth={2} aria-hidden="true" /></span>
	{/if}
	<span class="word">{$t(word)}</span>
	{#if chevron}
		<span class="drawn-ic" style:--ic="9"><ChevronRight size="100%" strokeWidth={2} aria-hidden="true" /></span>
	{/if}
</span>

<style>
	.drawn-button {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		gap: calc(var(--u) * 3);
		height: calc(var(--u) * 13);
		padding: 0 calc(var(--u) * 7);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		font-size: calc(var(--u) * 7.5);
		font-weight: 500;
		white-space: nowrap;
	}

	.link {
		background: var(--surface-page);
		color: var(--text-secondary);
	}

	.secondary {
		border-color: color-mix(in srgb, var(--text-primary) 50%, transparent);
		color: var(--text-primary);
	}

	.dialog,
	.positive {
		background: var(--surface-page);
		color: var(--text-primary);
		font-size: calc(var(--u) * 7);
		font-weight: 600;
	}

	.positive {
		border-color: color-mix(in srgb, var(--accent) 42%, var(--border-default) 58%);
		background: color-mix(in srgb, var(--accent) 10%, var(--surface-page) 90%);
		color: var(--accent);
	}
</style>
