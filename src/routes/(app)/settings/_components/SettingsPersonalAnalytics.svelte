<script lang="ts">
import type { Chart as ChartInstance, TooltipItem } from "chart.js";
import { onDestroy, tick } from "svelte";
import { get } from "svelte/store";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import { chartAnimation } from "./chart-reduced-motion";

// ADR-0043 slice 18c: the personal Block A analytics (the user's own usage)
// extracted from the former standalone SettingsAnalyticsTab. This is the
// "Your Activity" content rendered as the 5th Profile section. PERSONAL ONLY —
// no system/per-user/excluded content lives here (that is admin-gated and
// rendered under Administration via SettingsSystemAnalytics).
let {
	analyticsData = null,
	analyticsLoading = false,
	analyticsError = "",
	modelNames,
	modelIcons = {},
	onRetry,
	selectedMonth = null,
	onMonthChange = undefined,
	onTimelineChange = undefined,
}: {
	analyticsData?: AnalyticsResponse | null;
	analyticsLoading?: boolean;
	analyticsError?: string;
	modelNames: Record<string, string>;
	modelIcons?: Record<string, string | null | undefined>;
	onRetry: () => void | Promise<void>;
	selectedMonth?: string | null;
	onMonthChange?: ((month: string | null) => void) | undefined;
	onTimelineChange?: ((granularity: string) => void) | undefined;
} = $props();

let modelChart = $state<ChartInstance | null>(null);
let modelChartCanvas = $state<HTMLCanvasElement | null>(null);
let timelineChart = $state<ChartInstance | null>(null);
let timelineChartCanvas = $state<HTMLCanvasElement | null>(null);
let timelineGranularity = $state<"weekly" | "monthly" | "yearly">("weekly");
const timelineRows = $derived(analyticsData?.timeline ?? []);

const CHART_COLORS = [
	"rgba(193, 95, 60, 0.88)",
	"rgba(100, 143, 175, 0.88)",
	"rgba(21, 128, 61, 0.88)",
	"rgba(165, 95, 95, 0.88)",
	"rgba(115, 100, 160, 0.88)",
	"rgba(185, 140, 65, 0.88)",
];

function destroyCharts() {
	modelChart?.destroy();
	modelChart = null;
	timelineChart?.destroy();
	timelineChart = null;
}

function modelDisplayName(key: string): string {
	return modelNames[key] ?? key;
}

function modelIconUrl(key: string | null | undefined): string | null {
	return key ? (modelIcons[key] ?? null) : null;
}

function formatMs(ms: number): string {
	if (!ms) return "—";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatNum(value: number): string {
	if (!value) return "0";
	return value.toLocaleString();
}

function formatUsd(value: number): string {
	return `$${Number(value ?? 0).toFixed(4)}`;
}

function formatMonth(ym: string): string {
	const [y, m] = ym.split("-");
	const date = new Date(Number(y), Number(m) - 1, 1);
	return date.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

let availableMonths = $derived.by(() => {
	const months =
		analyticsData?.availableMonths ??
		analyticsData?.personal?.monthly?.map((m) => m.month) ??
		[];
	return [...months].sort().reverse() as string[];
});

function previousMonthFromAllTime(months: string[]): string | null {
	return months[1] ?? months[0] ?? null;
}

function prevMonth() {
	if (availableMonths.length === 0) return;
	if (!selectedMonth) {
		onMonthChange?.(previousMonthFromAllTime(availableMonths));
		return;
	}
	const idx = availableMonths.indexOf(selectedMonth);
	if (idx < availableMonths.length - 1) {
		onMonthChange?.(availableMonths[idx + 1]);
	}
}

function nextMonth() {
	if (availableMonths.length === 0) return;
	if (!selectedMonth) {
		onMonthChange?.(availableMonths[0]);
		return;
	}
	const idx = availableMonths.indexOf(selectedMonth);
	if (idx > 0) {
		onMonthChange?.(availableMonths[idx - 1]);
	}
}

function selectAllTime() {
	onMonthChange?.(null);
}

let comparisonHint = $derived.by(() => {
	if (!selectedMonth || !analyticsData?.personal?.monthly) return "";
	const months = analyticsData.personal.monthly;
	const current = months.find((m) => m.month === selectedMonth);
	if (!current) return "";
	const idx = months.findIndex((m) => m.month === selectedMonth);
	if (idx >= months.length - 1) return "";
	const prev = months[idx + 1];
	if (!prev || prev.totalCostUsd === 0) return "";
	const diff =
		((current.totalCostUsd - prev.totalCostUsd) / prev.totalCostUsd) * 100;
	const arrow = diff > 0 ? "\u2191" : "\u2193";
	return $t("analytics.comparisonVsMonth", {
		direction: arrow,
		percent: Math.abs(diff).toFixed(0),
		month: formatMonth(prev.month),
	});
});

async function initCharts(
	translateFn: (
		key: I18nKey,
		params?: Record<string, string | number>,
	) => string,
) {
	if (!analyticsData) return;
	await tick();
	destroyCharts();

	const { Chart } = await import("chart.js/auto");

	if (modelChartCanvas) Chart.getChart(modelChartCanvas)?.destroy();

	if (modelChartCanvas && analyticsData.personal.byModel.length > 0) {
		const byModel = analyticsData.personal.byModel;
		modelChart = new Chart(modelChartCanvas, {
			type: "bar",
			data: {
				labels: byModel.map(
					(row) => row.displayName ?? modelDisplayName(row.model),
				),
				datasets: [
					{
						label: translateFn("analytics.chartCostUsd"),
						data: byModel.map((row) => Number(row.totalCostUsd)),
						backgroundColor: CHART_COLORS.slice(0, byModel.length),
						borderWidth: 0,
						borderRadius: 4,
					},
				],
			},
			options: {
				indexAxis: "y",
				maintainAspectRatio: false,
				animation: chartAnimation({ duration: 700, easing: "easeInOutQuart" }),
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: {
							label: (ctx: TooltipItem<"bar">) =>
								` ${ctx.label}: ${formatUsd(Number(ctx.raw))}`,
						},
					},
				},
				scales: {
					x: {
						grid: { color: "rgba(128,128,128,0.1)" },
						ticks: {
							color: "rgba(128,128,128,0.8)",
							font: { size: 11 },
							callback: (value: string | number) => formatUsd(Number(value)),
						},
					},
					y: {
						grid: { display: false },
						ticks: { color: "rgba(128,128,128,0.9)", font: { size: 12 } },
					},
				},
			},
		});
	}

	if (timelineChartCanvas && timelineRows.length > 0) {
		Chart.getChart(timelineChartCanvas)?.destroy();
		const data = timelineRows;
		timelineChart = new Chart(timelineChartCanvas, {
			type: "line",
			data: {
				labels: data.map((d) => d.label),
				datasets: [
					{
						label: "Tokens",
						data: data.map((d) => d.tokens),
						borderColor: "rgba(193, 95, 60, 0.88)",
						backgroundColor: "rgba(193, 95, 60, 0.08)",
						fill: true,
						tension: 0.3,
						pointRadius: 2,
						pointHoverRadius: 5,
						borderWidth: 2,
					},
				],
			},
			options: {
				maintainAspectRatio: false,
				animation: chartAnimation({ duration: 600 }),
				plugins: {
					legend: { display: false },
				},
				scales: {
					x: {
						grid: { display: false },
						ticks: {
							color: "rgba(128,128,128,0.8)",
							font: { size: 10 },
							maxRotation: 0,
						},
					},
					y: {
						grid: { color: "rgba(128,128,128,0.1)" },
						ticks: { color: "rgba(128,128,128,0.8)", font: { size: 11 } },
					},
				},
			},
		});
	}
}

$effect(() => {
	if (!analyticsData || analyticsLoading || analyticsError) {
		destroyCharts();
		return;
	}

	const translateFn = get(t);
	let cancelled = false;

	void (async () => {
		await tick();
		if (cancelled) return;
		await initCharts(translateFn);
	})();

	return () => {
		cancelled = true;
		destroyCharts();
	};
});

onDestroy(() => {
	destroyCharts();
});
</script>

{#if analyticsLoading && !analyticsData}
	<div class="flex items-center justify-center py-16 text-text-muted">{$t('analytics.loadingAnalytics')}</div>
{:else if analyticsError}
	<div class="settings-card">
		<p class="text-danger text-sm">{analyticsError}</p>
		<button class="btn-secondary mt-3" onclick={onRetry}>{$t('analytics.retry')}</button>
	</div>
{:else if analyticsData}
	<div class="flex items-center justify-between mb-3">
		<div class="flex items-center gap-1">
			<button
				class="month-nav-btn"
				onclick={prevMonth}
				disabled={availableMonths.length === 0}
				aria-label={$t('analytics.previousMonth')}
			>&larr;</button>
			<span class="month-label">
				{selectedMonth ? formatMonth(selectedMonth) : $t('analytics.allTime')}
			</span>
			<button
				class="month-nav-btn"
				onclick={nextMonth}
				disabled={availableMonths.length === 0}
				aria-label={$t('analytics.nextMonth')}
			>&rarr;</button>
			{#if selectedMonth}
				<button class="month-alltime-btn" onclick={selectAllTime}>
					{$t('analytics.allTime')}
				</button>
			{/if}
		</div>
	</div>
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
		<div class="stat-card stat-card--hero">
			<div class="stat-value-hero">{formatUsd(analyticsData.personal.totalCostUsd)}</div>
			<div class="stat-label">{$t('totalCost')}</div>
			{#if comparisonHint}
				<div class="stat-comparison">{comparisonHint}</div>
			{/if}
		</div>
		<div class="stat-card">
			<div class="stat-value">{formatNum(analyticsData.personal.totalMessages)}</div>
			<div class="stat-label">{$t('analytics.messagesSent')}</div>
		</div>
		<div class="stat-card">
			<div class="stat-value">{formatMs(analyticsData.personal.avgGenerationMs)}</div>
			<div class="stat-label">{$t('analytics.avgResponseTime')}</div>
		</div>
		<div class="stat-card">
			<div class="stat-value">{formatNum(analyticsData.personal.totalTokens)}</div>
			<div class="stat-label">{$t('analytics.tokensUsed')}</div>
		</div>
		<div class="stat-card">
			<div class="stat-value">{formatNum(analyticsData.personal.chatCount)}</div>
			<div class="stat-label">{$t('analytics.conversations')}</div>
		</div>
	</div>

	{#if analyticsData.personal.byModel?.length > 0}
		<div class="mt-5">
			<p class="settings-label mb-3">{$t('analytics.costByModel')}</p>
			<div class="mb-3 grid gap-2">
				{#each analyticsData.personal.byModel as row}
					<div class="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-surface-overlay px-3 py-2 text-sm">
						<div class="flex min-w-0 items-center gap-2">
							<ModelIcon iconUrl={modelIconUrl(row.model)} displayName={row.displayName ?? modelDisplayName(row.model)} size={22} />
							<span class="truncate text-text-primary">{row.displayName ?? modelDisplayName(row.model)}</span>
						</div>
						<span class="shrink-0 text-xs text-text-muted">{formatUsd(row.totalCostUsd)}</span>
					</div>
				{/each}
			</div>
			<div style="max-width: 480px; height: 200px; margin: 0 auto; position: relative;">
				<canvas bind:this={modelChartCanvas} style="display: block; width: 100%; height: 100%;"></canvas>
			</div>
		</div>
	{/if}

	{#if timelineRows.length > 0}
		<div class="mt-5">
			<div class="flex items-center justify-between mb-3">
				<p class="settings-label">{$t('analytics.tokenUsage')}</p>
				<div class="flex items-center gap-0 rounded-full border border-border bg-surface-overlay p-0.5">
					<button
						class="timeline-toggle-btn"
						class:timeline-toggle-btn--active={timelineGranularity === 'weekly'}
						onclick={() => { timelineGranularity = 'weekly'; onTimelineChange?.('weekly'); }}
						aria-label={$t('analytics.timelineWeekly')}
					>W</button>
					<button
						class="timeline-toggle-btn"
						class:timeline-toggle-btn--active={timelineGranularity === 'monthly'}
						onclick={() => { timelineGranularity = 'monthly'; onTimelineChange?.('monthly'); }}
						aria-label={$t('analytics.timelineMonthly')}
					>M</button>
					<button
						class="timeline-toggle-btn"
						class:timeline-toggle-btn--active={timelineGranularity === 'yearly'}
						onclick={() => { timelineGranularity = 'yearly'; onTimelineChange?.('yearly'); }}
						aria-label={$t('analytics.timelineYearly')}
					>Y</button>
				</div>
			</div>
			<div style="height: 200px; position: relative;">
				<canvas bind:this={timelineChartCanvas} style="display: block; width: 100%; height: 100%;"></canvas>
			</div>
		</div>
	{/if}
{:else}
	<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
{/if}
