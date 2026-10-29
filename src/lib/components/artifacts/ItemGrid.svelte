<script lang="ts" module>
import type { Component } from "svelte";

/** One tile of the gallery, already in the reader's words. */
export type ItemGridTile = {
	id: string;
	title: string;
	/** The second line: the kind or the file's type. */
	meta: string;
	/** The item's type icon, for a tile with no picture. */
	icon: Component;
	/** A picture item's thumbnail (`PictureThumb`), filling the tile's square. */
	thumbnail?: {
		fileId: string;
		hasAlpha: boolean;
		conversationId: string | null;
	} | null;
	disabled?: boolean;
	/** Being made: the icon turns (still under reduced motion). */
	busy?: boolean;
	/** The item open in the panel. */
	current?: boolean;
};
</script>

<script lang="ts">
// The one gallery of items (plan 2b Task 22 / 22b: "an alternative view that
// shows the images as a gallery grid"), drawn by the Knowledge Base's library
// and the chat panel's "What this chat made". A reserved square per item, its
// picture's thumbnail or its type's icon, the title and type under it; a press
// opens the item the way a row does. Columns come from the grid's OWN width (a
// container query, never the viewport), so it fits the docked panel, the
// expanded panel, the phone sheet and the library alike: as many as fit, two at
// the narrowest. Every square is there before any picture arrives (no layout
// shift); hover changes colours at once and nothing else moves.
import { LoaderCircle } from "@lucide/svelte";
import PictureThumb from "./image/PictureThumb.svelte";

let {
	tiles,
	testId,
	onOpen,
	onPreviewIntent = undefined,
}: {
	tiles: ItemGridTile[];
	/** On the list; each tile is `<testId>-tile`. */
	testId: string;
	onOpen: (id: string) => void;
	onPreviewIntent?: (id: string) => void;
} = $props();
</script>

<div class="item-grid-frame">
	<ul class="item-grid" data-testid={testId}>
		{#each tiles as tile (tile.id)}
			{@const Icon = tile.icon}
			<li class="item-grid-item">
				<button
					type="button"
					class="item-grid-tile"
					class:is-current={tile.current}
					data-testid="{testId}-tile"
					disabled={tile.disabled}
					aria-current={tile.current ? 'true' : undefined}
					aria-busy={tile.busy ? 'true' : undefined}
					onclick={() => onOpen(tile.id)}
					onpointerenter={() => onPreviewIntent?.(tile.id)}
					onfocus={() => onPreviewIntent?.(tile.id)}
				>
					<span class="item-grid-picture">
						{#if tile.thumbnail}
							<PictureThumb {...tile.thumbnail} fill testId="item-grid-thumb" />
						{:else if tile.busy}
							<LoaderCircle class="item-grid-spinner" size={26} strokeWidth={1.5} aria-hidden="true" />
						{:else}
							<Icon size={28} strokeWidth={1.5} aria-hidden="true" />
						{/if}
					</span>
					<span class="item-grid-title">{tile.title}</span>
					<span class="item-grid-meta">{tile.meta}</span>
				</button>
			</li>
		{/each}
	</ul>
</div>

<style>
	/* The grid measures itself: its columns follow the room it is given. */
	.item-grid-frame {
		container-type: inline-size;
	}

	.item-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: var(--space-md);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	@container (max-width: 30rem) {
		.item-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: var(--space-sm);
		}
	}

	.item-grid-item {
		min-width: 0;
	}

	.item-grid-tile {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		width: 100%;
		padding: var(--space-xs);
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		text-align: left;
		cursor: pointer;
	}

	.item-grid-tile:hover {
		border-color: var(--border-default);
		background: color-mix(in srgb, var(--accent) 4%, transparent 96%);
	}

	.item-grid-tile.is-current {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	.item-grid-tile:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.item-grid-tile:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.item-grid-tile[aria-busy='true']:disabled {
		cursor: progress;
		opacity: 1;
	}

	/* The reserved square: the picture fills it, an icon sits in its middle. */
	.item-grid-picture {
		display: grid;
		place-items: center;
		width: 100%;
		aspect-ratio: 1 / 1;
		overflow: hidden;
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		box-shadow: 0 0 0 1px var(--border-subtle);
		color: var(--icon-muted);
	}

	.item-grid-picture :global(.item-grid-spinner) {
		animation: item-grid-spin 1s linear infinite;
	}

	@keyframes item-grid-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.item-grid-picture :global(.item-grid-spinner) {
			animation: none;
		}
	}

	.item-grid-title {
		display: -webkit-box;
		overflow: hidden;
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.item-grid-meta {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
</style>
