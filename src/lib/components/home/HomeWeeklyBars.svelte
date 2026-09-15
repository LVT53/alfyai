<script lang="ts">
/**
 * The twelve weekly bars that ride on the greeting's line (HomeV4A "Compact").
 *
 * Twelve 2px bars on a 3px gap, at most 14px tall, scaled against the tallest
 * week in the window — 57px of ink, which is why this survives at 390px where
 * a real chart cannot. A week with no messages is drawn as a 1px tick at 34%
 * rather than as a gap: an absent bar would read as a missing week instead of
 * a quiet one.
 */
import { t } from "$lib/i18n";
import type { HomeWeeklyBucket } from "$lib/client/api/home";

let {
	weeks = [],
	total = 0,
	max = 20,
}: {
	weeks?: HomeWeeklyBucket[];
	total?: number;
	max?: number;
} = $props();

const peak = $derived(
	weeks.reduce((highest, week) => Math.max(highest, week.count), 0),
);

function heightFor(count: number): number {
	if (count === 0 || peak === 0) return 2;
	// Linear against the busiest week, with a 4px floor so a one-message
	// week is still visibly a bar and not the same tick as an empty one.
	return Math.max(4, Math.round((count / peak) * max));
}
</script>

{#if weeks.length > 0}
	<span class="home-mark" data-testid="home-weekly-mark">
		<span
			class="home-spark"
			style={`height:${max}px`}
			role="img"
			aria-label={$t('home.weeklyBarsLabel')}
			data-testid="home-weekly-bars"
		>
			{#each weeks as week, index (week.isoWeek)}
				<i
					class:zero={week.count === 0}
					class:current={index === weeks.length - 1}
					style={`height:${heightFor(week.count)}px`}
					title={$t('home.weeklyBarTooltip', { week: week.isoWeek, count: week.count })}
					data-testid="home-weekly-bar"
					data-count={week.count}
				></i>
			{/each}
		</span>
		<span class="home-mark-count" data-testid="home-weekly-count">
			{$t('home.weeklyCount', { count: total })}
		</span>
	</span>
{/if}

<style>
	.home-mark {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		padding-bottom: 6px;
	}

	/* Twelve 4px bars on a 4px gap, 20px tall: 92px of ink, which still fits
	   the greeting line at 390px and is wide enough that a week of 5 and a
	   week of 20 read as different heights. Past weeks are the accent at
	   half strength; the current week — the one the count beside it names —
	   is the accent in full. */
	.home-spark {
		display: inline-flex;
		align-items: flex-end;
		gap: 4px;
		flex-shrink: 0;
	}

	.home-spark i {
		display: block;
		width: 4px;
		border-radius: 2px;
		background: var(--accent);
		opacity: 0.5;
		transition:
			height var(--duration-standard) var(--ease-out),
			opacity var(--duration-standard) var(--ease-out);
	}

	.home-spark i.current {
		opacity: 1;
	}

	.home-spark:hover i:not(:hover) {
		opacity: 0.32;
	}

	.home-spark i:hover {
		opacity: 1;
	}

	/* A week with no messages is a 2px tick, not a gap: an absent bar would
	   read as a missing week instead of a quiet one. */
	.home-spark i.zero {
		opacity: 0.28;
	}

	.home-mark-count {
		font-size: 0.72rem;
		color: var(--text-muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 767px) {
		.home-mark-count {
			font-size: 0.7rem;
		}
	}
</style>
