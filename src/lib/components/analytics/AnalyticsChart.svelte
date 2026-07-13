<script lang="ts">
import type {
	Chart as ChartInstance,
	ChartData,
	ChartOptions,
	ChartType,
} from "chart.js";
import { onDestroy } from "svelte";
// Reduced-motion guard shared with the existing settings analytics charts.
// (Later waves may relocate this helper into analytics/.)
import { chartAnimation } from "../../../routes/(app)/settings/_components/chart-reduced-motion";
import { GRID_COLOR, TICK_COLOR } from "./chart-palette";

interface AnalyticsChartProps {
	type: ChartType;
	data: ChartData;
	options?: ChartOptions;
	/** CSS height for the canvas wrapper (default "240px"). */
	height?: string;
}

let { type, data, options, height = "240px" }: AnalyticsChartProps = $props();

let canvas = $state<HTMLCanvasElement | null>(null);
let chart: ChartInstance | null = null;

/** Theme-agnostic defaults merged under caller `options`. */
function baseOptions(): ChartOptions {
	return {
		maintainAspectRatio: false,
		animation: chartAnimation({ duration: 500 }),
		plugins: {
			legend: {
				labels: { color: TICK_COLOR, font: { size: 12 } },
			},
		},
		scales: {
			x: {
				grid: { color: GRID_COLOR },
				ticks: { color: TICK_COLOR, font: { size: 11 } },
			},
			y: {
				grid: { color: GRID_COLOR },
				ticks: { color: TICK_COLOR, font: { size: 11 } },
			},
		},
	};
}

async function build() {
	if (!canvas) return;
	const { Chart } = await import("chart.js/auto");
	// Defensive: tear down any chart still bound to this canvas.
	Chart.getChart(canvas)?.destroy();
	chart = new Chart(canvas, {
		type,
		data,
		options: { ...baseOptions(), ...(options ?? {}) },
	});
}

function teardown() {
	chart?.destroy();
	chart = null;
}

$effect(() => {
	// Track reactive deps so the chart rebuilds when they change.
	void type;
	void data;
	void options;
	teardown();
	build();
	return teardown;
});

onDestroy(teardown);
</script>

<div style="position: relative; height: {height};">
	<canvas bind:this={canvas}></canvas>
</div>
