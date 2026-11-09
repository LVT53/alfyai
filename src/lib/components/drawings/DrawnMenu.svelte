<script lang="ts">
/**
 * The composer's "+" menu: the rows of its "This message" section, drawn as
 * `ComposerToolsMenu.svelte` draws them (an icon, the word, and a chevron on a
 * row that opens a picker of its own). A drawing may show any of the rows and
 * gives each the spot id it carries there.
 *
 * `rows` defaults to the real menu's order (`buildComposerMenuRows`), which
 * `guide/drawings/drawings.test.ts` holds.
 */
import {
	ChevronRight,
	Library,
	Orbit,
	Paperclip,
	Sparkles,
} from "@lucide/svelte";
import type { Component } from "svelte";
import { type I18nKey, t } from "$lib/i18n";
import { isLit } from "./drawing-spot";

type Row = "attach" | "library" | "skills" | "atlas";

const ROWS: Record<
	Row,
	{ icon: Component; word: I18nKey; opensPicker: boolean }
> = {
	attach: {
		icon: Paperclip,
		word: "composerTools.attachFile",
		opensPicker: false,
	},
	library: {
		icon: Library,
		word: "composerTools.fromLibrary",
		opensPicker: false,
	},
	skills: { icon: Sparkles, word: "composerMenu.skills", opensPicker: true },
	atlas: { icon: Orbit, word: "composerMenu.atlasReport", opensPicker: true },
};

let {
	lit = null,
	rows = ["attach", "library", "skills", "atlas"],
	spots = {},
}: {
	lit?: string | null;
	rows?: readonly Row[];
	/** The spot id each row carries in this drawing; a row left out is no spot. */
	spots?: Partial<Record<Row, string>>;
} = $props();

let drawn = $derived(rows.map((row) => ({ row, ...ROWS[row] })));
</script>

<div class="drawn-menu">
	{#each drawn as { row, icon: Icon, word, opensPicker } (row)}
		<span
			class="row"
			data-drawing-spot={spots[row]}
			class:drawing-spot-lit={isLit(spots[row], lit)}
		>
			<span class="drawn-ic icon"><Icon size="100%" strokeWidth={2} aria-hidden="true" /></span>
			<span class="word">{$t(word)}</span>
			{#if opensPicker}
				<span class="drawn-ic chevron"><ChevronRight size="100%" strokeWidth={2} aria-hidden="true" /></span>
			{/if}
		</span>
	{/each}
</div>

<style>
	.drawn-menu {
		display: flex;
		flex-direction: column;
		padding: calc(var(--u) * 4);
		border: 1px solid var(--menu-border);
		border-radius: calc(var(--u) * 8);
		background: var(--menu-surface);
		box-shadow: var(--shadow-lg);
	}

	.row {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 6);
		padding: calc(var(--u) * 4) calc(var(--u) * 6);
		border-radius: calc(var(--u) * 6);
		color: var(--text-primary);
	}

	.icon {
		color: var(--text-secondary);
	}

	.word {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
	}

	.chevron {
		--ic: 10;
		color: var(--text-muted);
	}
</style>
