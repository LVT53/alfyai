<script lang="ts">
// The hero: the number both audiences came for, the comparison that says
// whether it moved, and a bar that shows what it is the sum of. The legend
// names each half with its amount, so the hero explains itself instead of
// needing a second card.
import { buildCostSplit, type CostSegmentInput } from "./chassis-math";

let {
	value,
	label,
	comparison = "",
	segments = [],
}: {
	/** Already formatted — the chassis does not guess at units. */
	value: string;
	label: string;
	comparison?: string;
	segments?: readonly CostSegmentInput[];
} = $props();

const split = $derived(buildCostSplit(segments));
</script>

<div class="analytics-hero" data-testid="analytics-hero">
	<div class="analytics-hero-line">
		<span class="analytics-hero-value">{value}</span>
		{#if comparison}
			<span class="analytics-hero-comparison">{comparison}</span>
		{/if}
	</div>
	<div class="analytics-hero-label">{label}</div>

	{#if split.segments.length > 0}
		<!-- Keyed by position, not by label: two providers may carry the same
		     display name, and a duplicate key is a render-time crash. -->
		<div class="analytics-split" data-testid="analytics-split" aria-hidden="true">
			{#each split.segments as segment, index (index)}
				<span
					style={`flex: ${segment.percent}; background: ${segment.color};`}
				></span>
			{/each}
		</div>
		<div class="analytics-legend">
			{#each split.segments as segment, index (index)}
				<span class="analytics-legend-entry">
					<span
						class="analytics-legend-swatch"
						style={`background: ${segment.color};`}
						aria-hidden="true"
					></span>
					{segment.legend}
				</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.analytics-hero {
		border: 1px solid
			color-mix(in srgb, var(--accent) 35%, var(--border-default) 65%);
		border-radius: var(--radius-lg, 0.75rem);
		background: color-mix(in srgb, var(--accent) 4%, var(--surface-page) 96%);
		padding: 0.85rem 1rem;
	}

	:global(.dark) .analytics-hero {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page) 92%);
	}

	.analytics-hero-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.6rem;
	}

	.analytics-hero-value {
		color: var(--accent);
		font-family: var(--font-sans);
		font-size: 1.5rem;
		font-weight: 600;
		line-height: 1.1;
		font-variant-numeric: tabular-nums;
	}

	.analytics-hero-comparison {
		font-family: var(--font-sans);
		font-size: 0.72rem;
		color: var(--text-muted);
	}

	.analytics-hero-label {
		margin-top: 0.15rem;
		font-family: var(--font-sans);
		font-size: 0.74rem;
		color: var(--text-muted);
	}

	.analytics-split {
		display: flex;
		height: 0.5rem;
		margin-top: 0.7rem;
		border-radius: 9999px;
		overflow: hidden;
		background: color-mix(in srgb, var(--border-default) 60%, transparent 40%);
	}

	.analytics-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.85rem;
		margin-top: 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	.analytics-legend-entry {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.analytics-legend-swatch {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 0.15rem;
	}
</style>
