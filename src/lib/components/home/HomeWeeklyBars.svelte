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
	max = 14,
}: {
	weeks?: HomeWeeklyBucket[];
	total?: number;
	max?: number;
} = $props();

const peak = $derived(
	weeks.reduce((highest, week) => Math.max(highest, week.count), 0),
);

function heightFor(count: number): number {
	if (count === 0 || peak === 0) return 1;
	return Math.max(2, Math.round((count / peak) * max));
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
			{#each weeks as week (week.isoWeek)}
				<i
					class:zero={week.count === 0}
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

	.home-spark {
		display: inline-flex;
		align-items: flex-end;
		gap: 3px;
		flex-shrink: 0;
	}

	.home-spark i {
		display: block;
		width: 2px;
		border-radius: 1px;
		background: var(--accent);
	}

	/* The week you were away. At 2px on a dark ground this tick is the thing
	   most at risk of vanishing; if it does, this opacity is the fix, not a
	   second palette. */
	.home-spark i.zero {
		opacity: 0.34;
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
