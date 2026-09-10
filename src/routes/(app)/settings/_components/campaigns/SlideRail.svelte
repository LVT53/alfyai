<script module lang="ts">
export type SlideRailItem = {
	localId: string;
	title: string;
	thumbnailUrl: string | null;
	failing: boolean;
	isSetup: boolean;
};
</script>

<script lang="ts">
import { Image as ImageIcon, Plus, TriangleAlert } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	slides,
	activeIndex = 0,
	editable = true,
	onSelect,
	onAdd,
}: {
	slides: SlideRailItem[];
	activeIndex?: number;
	editable?: boolean;
	onSelect: (index: number) => void;
	onAdd: () => void;
} = $props();
</script>

<div class="slide-rail">
	<p class="eyebrow">{$t('admin.campaigns.slides')}</p>

	<div class="rail-list">
		{#each slides as slide, index (slide.localId)}
			<button
				type="button"
				class="slide-item"
				class:slide-item-active={index === activeIndex}
				aria-pressed={index === activeIndex}
				data-testid="admin-campaign-slide-thumb"
				onclick={() => onSelect(index)}
			>
				<span class="thumb">
					{#if slide.thumbnailUrl}
						<img src={slide.thumbnailUrl} alt="" loading="lazy" />
					{:else}
						<span class="thumb-empty"><ImageIcon size={16} strokeWidth={1.8} aria-hidden="true" /></span>
					{/if}
				</span>
				<span class="slide-item-row">
					<span class="slide-index">{index + 1}</span>
					<span class="slide-title">{slide.title}</span>
					{#if slide.isSetup}
						<span class="setup-tag">{$t('admin.campaigns.slideKind.setup')}</span>
					{/if}
					{#if slide.failing}
						<span class="slide-warning" title={$t('admin.campaigns.checklist.slideHasIssues')}>
							<TriangleAlert size={11} strokeWidth={2.2} aria-hidden="true" />
						</span>
					{/if}
				</span>
			</button>
		{/each}

		{#if slides.length === 0}
			<p class="rail-note">{$t('admin.campaigns.noSlides')}</p>
		{/if}
	</div>

	{#if editable}
		<button type="button" class="add-slide" onclick={onAdd}>
			<Plus size={12} strokeWidth={2} aria-hidden="true" />
			{$t('admin.campaigns.addSlide')}
		</button>
	{/if}
</div>

<style>
	.slide-rail {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.eyebrow {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.rail-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		max-height: min(60vh, 34rem);
		overflow-y: auto;
	}

	.rail-note {
		padding: 0.5rem 0.25rem;
		font-size: var(--text-2xs);
		color: var(--text-muted);
		line-height: 1.5;
	}

	.slide-item {
		display: flex;
		flex-direction: column;
		gap: 5px;
		width: 100%;
		padding: 0.5rem;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		text-align: left;
		cursor: pointer;
		transition:
			background var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.slide-item:hover {
		background: var(--surface-elevated);
	}

	.slide-item-active {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, transparent);
	}

	.slide-item:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.thumb {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 10;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.thumb-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		color: var(--text-muted);
		opacity: 0.7;
	}

	.slide-item-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		min-width: 0;
	}

	.slide-index {
		font-size: 0.66rem;
		color: var(--text-muted);
		opacity: 0.75;
	}

	.slide-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-2xs);
		font-weight: 500;
		color: var(--text-primary);
	}

	.setup-tag {
		flex-shrink: 0;
		font-size: 0.58rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		padding: 0 3px;
	}

	.slide-warning {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--danger);
	}

	.add-slide {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		width: 100%;
		height: 28px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		color: var(--text-secondary);
		font-size: var(--text-2xs);
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.add-slide:hover {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent);
	}

	.add-slide:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* Stacked layout: the rail becomes a filmstrip instead of a column of
	   full-width thumbnails. */
	@media (max-width: 1023px) {
		.rail-list {
			flex-direction: row;
			max-height: none;
			overflow-x: auto;
			padding-bottom: 0.25rem;
		}

		.slide-item {
			/* `min-width: 0` as well as the basis: a flex item's automatic minimum
			   size is its min-content width, which the slide title pushes past
			   140px — leaving every frame a different width and, through the
			   16:10 thumbnail, a different height. */
			flex: 0 0 140px;
			min-width: 0;
		}

		.add-slide {
			width: auto;
			align-self: flex-start;
			padding: 0 0.75rem;
		}
	}
</style>
