<script lang="ts">
// One chart chassis for both audiences: columns on gridlines every quarter,
// the scale marked at the top right, and the final column drawn solid because
// it is the period still running — the one reading guaranteed to be incomplete
// and the one users read as a crash.
import type { Snippet } from "svelte";
import { t } from "$lib/i18n";
import { buildColumnChart, type ChartPoint } from "./chassis-math";

let {
	points,
	unit,
	labelEvery = 1,
	currentIndex = undefined,
	note = "",
	formatValue = (value: number) => value.toLocaleString("en-US"),
	controls = undefined,
}: {
	points: readonly ChartPoint[];
	/** What the numbers are, e.g. "Token usage per week, thousands". */
	unit: string;
	labelEvery?: number;
	currentIndex?: number | undefined;
	note?: string;
	formatValue?: (value: number) => string;
	/** Granularity pills and the like, drawn beside the unit. */
	controls?: Snippet;
} = $props();

const chart = $derived(buildColumnChart(points, { labelEvery, currentIndex }));
</script>

<div class="chart-block">
	<div class="chart-head">
		<span class="chart-unit">{unit}</span>
		{#if controls}
			{@render controls()}
		{/if}
	</div>

	{#if chart.empty}
		<p class="chart-empty">{$t("analytics.noChartData")}</p>
	{:else}
		<div class="chart" data-testid="analytics-column-chart">
			<span class="chart-peak" aria-label={$t("analytics.chartScaleLabel")}>
				{formatValue(chart.peak)}
			</span>
			<!-- Gridlines and bars share one box. Hung off `.chart` instead, a
			     gridline's `bottom: %` would resolve against the padding box the
			     scale label sits in while a bar measures the content box below
			     it, so the tallest bar would stop short of the 100% line and
			     every reading taken off the grid would be wrong. -->
			<div class="chart-plot">
				{#each chart.gridlines as line (line)}
					<div class="chart-gridline" style={`bottom: ${line}%;`}></div>
				{/each}
				<div class="chart-bars">
					{#each chart.columns as column, index (`${column.label}-${index}`)}
						<span
							class="chart-bar"
							class:current={column.current}
							style={`height: ${column.heightPct}%;`}
							title={`${column.label || ""} ${formatValue(column.value)}`.trim()}
						></span>
					{/each}
				</div>
			</div>
		</div>
		<div class="chart-axis">
			{#each chart.columns as column, index (`${column.label}-axis-${index}`)}
				<span class="chart-axis-label">
					{column.labelled ? column.label : ""}
				</span>
			{/each}
		</div>
		{#if note}
			<p class="chart-note">{note}</p>
		{/if}
	{/if}
</div>

<style>
	.chart-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		margin-bottom: 0.5rem;
	}

	.chart-unit {
		font-family: var(--font-sans);
		font-size: 0.74rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.chart {
		position: relative;
		height: 150px;
		padding-top: 1.15rem;
	}

	/* The plot: the one box both the gridlines and the bars are measured in. */
	.chart-plot {
		position: relative;
		height: 100%;
	}

	.chart-gridline {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1px solid
			color-mix(in srgb, var(--border-default) 55%, transparent 45%);
	}

	.chart-peak {
		position: absolute;
		top: 0;
		right: 0;
		font-family: var(--font-sans);
		font-size: 0.66rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.chart-bars {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 0.3rem;
		height: 100%;
	}

	.chart-bar {
		flex: 1 1 0;
		min-width: 0;
		border-radius: 0.2rem 0.2rem 0 0;
		background: color-mix(in srgb, var(--accent) 35%, transparent 65%);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.chart-bar:hover {
		background: color-mix(in srgb, var(--accent) 55%, transparent 45%);
	}

	/* The period still running, drawn solid. */
	.chart-bar.current {
		background: var(--accent);
	}

	.chart-axis {
		display: flex;
		gap: 0.3rem;
		margin-top: 0.3rem;
	}

	.chart-axis-label {
		flex: 1 1 0;
		min-width: 0;
		font-family: var(--font-sans);
		font-size: 0.62rem;
		color: var(--text-muted);
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chart-axis-label:first-child {
		text-align: left;
	}

	.chart-axis-label:last-child {
		text-align: right;
	}

	.chart-note,
	.chart-empty {
		margin: 0.5rem 0 0;
		font-family: var(--font-sans);
		font-size: 0.7rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.chart-bar {
			transition: none !important;
		}
	}
</style>
