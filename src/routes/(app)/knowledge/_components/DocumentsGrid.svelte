<script lang="ts">
// The Documents tab's gallery (plan 2b Task 22: "an alternative view that shows
// the images as a gallery grid"): a reserved square per item, its picture's
// thumbnail (or its type's icon), the title and type under it; a press opens the
// item the way a row does. As many columns as fit the card (sidebar open or
// not), two on a phone. Every tile's box is there before any picture arrives,
// so a page of tiles never moves; hover changes colours at once (no transition).
// `DocumentsList` owns which documents show, the icons and the type words.
import type { Component } from "svelte";
import PictureThumb from "$lib/components/artifacts/image/PictureThumb.svelte";
import {
	documentThumbnail,
	type KnowledgeDocumentItem,
} from "./documents-table";

let {
	documents,
	iconFor,
	typeLabel,
	canOpen,
	onOpen,
	onPreviewIntent,
}: {
	documents: KnowledgeDocumentItem[];
	/** The item's icon, for a tile with no picture. */
	iconFor: (document: KnowledgeDocumentItem) => Component;
	/** The tile's second line: the kind or the file's type, in words. */
	typeLabel: (document: KnowledgeDocumentItem) => string;
	canOpen: (document: KnowledgeDocumentItem) => boolean;
	onOpen: (document: KnowledgeDocumentItem) => void;
	onPreviewIntent: (document: KnowledgeDocumentItem) => void;
} = $props();
</script>

<ul class="documents-grid" data-testid="documents-grid">
	{#each documents as document (document.id)}
		{@const thumb = documentThumbnail(document)}
		{@const Icon = iconFor(document)}
		<li class="documents-grid-item">
			<button
				type="button"
				class="documents-grid-tile"
				data-testid="documents-grid-tile"
				disabled={!canOpen(document)}
				onclick={() => onOpen(document)}
				onpointerenter={() => onPreviewIntent(document)}
				onfocus={() => onPreviewIntent(document)}
			>
				<span class="documents-grid-picture">
					{#if thumb}
						<PictureThumb {...thumb} fill testId="document-thumb" />
					{:else}
						<Icon size={28} strokeWidth={1.5} aria-hidden="true" />
					{/if}
				</span>
				<span class="documents-grid-title">{document.name}</span>
				<span class="documents-grid-meta">{typeLabel(document)}</span>
			</button>
		</li>
	{/each}
</ul>

<style>
	.documents-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: var(--space-md);
		margin: 0;
		padding: var(--space-md) 0;
		list-style: none;
	}

	.documents-grid-item {
		min-width: 0;
	}

	.documents-grid-tile {
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

	.documents-grid-tile:hover {
		border-color: var(--border-default);
		background: color-mix(in srgb, var(--accent) 4%, transparent 96%);
	}

	.documents-grid-tile:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.documents-grid-tile:disabled {
		cursor: default;
		opacity: 0.6;
	}

	/* The reserved square: the picture fills it, an icon sits in its middle. */
	.documents-grid-picture {
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

	.documents-grid-title {
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

	.documents-grid-meta {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	@media (max-width: 480px) {
		.documents-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: var(--space-sm);
		}
	}
</style>
