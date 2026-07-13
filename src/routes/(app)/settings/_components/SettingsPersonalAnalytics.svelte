<script lang="ts">
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import PageSwitcher from "$lib/components/ui/PageSwitcher.svelte";
import {
	AnalyticsChart,
	getAccent,
	MonthNav,
	SortableTable,
	StatCard,
	StatGrid,
	type TableColumn,
	type TableRow,
} from "$lib/components/analytics";
import { t } from "$lib/i18n";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import "$lib/components/analytics/analytics.css";

// Phase B, wave B3: personal Block A analytics (the user's own usage) rebuilt
// on the shared analytics components. PERSONAL ONLY — no system/per-user data,
// no Parallel canvas (that is admin-gated under Administration via
// SettingsSystemAnalytics). Prop interface preserved so the parent wiring
// (month change reloads via onMonthChange) keeps working unchanged.
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

type PersonalTab = "overview" | "byModel";
let activeTab = $state<PersonalTab>("overview");
let timelineGranularity = $state<"weekly" | "monthly" | "yearly">("weekly");

const tabs = $derived([
	{
		id: "overview",
		label: $t("analytics.overview"),
		tabId: "personal-analytics-overview-tab",
		panelId: "personal-analytics-overview-panel",
	},
	{
		id: "byModel",
		label: $t("analytics.usageByModel"),
		tabId: "personal-analytics-bymodel-tab",
		panelId: "personal-analytics-bymodel-panel",
	},
]);

function modelDisplayName(key: string): string {
	return modelNames[key] ?? key;
}

function modelIconUrl(key: string | null | undefined): string | null {
	return key ? (modelIcons[key] ?? null) : null;
}

function formatUsd(value: number): string {
	return `$${Number(value ?? 0).toFixed(4)}`;
}

function formatNum(value: number): string {
	if (!value) return "0";
	return value.toLocaleString();
}

function formatMonth(ym: string): string {
	const [y, m] = ym.split("-");
	const date = new Date(Number(y), Number(m) - 1, 1);
	return date.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

// MonthNav expects chronologically ascending "YYYY-MM" keys.
const months = $derived(
	[
		...(analyticsData?.availableMonths ??
			analyticsData?.personal?.monthly?.map((m) => m.month) ??
			[]),
	].sort(),
);

const comparisonHint = $derived.by(() => {
	if (!selectedMonth || !analyticsData?.personal?.monthly) return "";
	const monthly = analyticsData.personal.monthly;
	const idx = monthly.findIndex((m) => m.month === selectedMonth);
	const current = idx >= 0 ? monthly[idx] : undefined;
	if (!current || idx >= monthly.length - 1) return "";
	const prev = monthly[idx + 1];
	if (!prev || prev.totalCostUsd === 0) return "";
	const diff =
		((current.totalCostUsd - prev.totalCostUsd) / prev.totalCostUsd) * 100;
	const arrow = diff > 0 ? "↑" : "↓";
	return $t("analytics.comparisonVsMonth", {
		direction: arrow,
		percent: Math.abs(diff).toFixed(0),
		month: formatMonth(prev.month),
	});
});

const favoriteModelLabel = $derived(
	analyticsData?.personal?.favoriteModel
		? modelDisplayName(analyticsData.personal.favoriteModel)
		: "—",
);

const modelColumns: TableColumn[] = [
	{ key: "model", label: $t("analytics.model"), type: "text" },
	{ key: "calls", label: $t("analytics.calls"), type: "number" },
	{ key: "tokens", label: $t("analytics.totalTokens"), type: "tokens" },
	{ key: "cost", label: $t("analytics.cost"), type: "usd" },
];

const modelRows = $derived<TableRow[]>(
	(analyticsData?.personal?.byModel ?? []).map((row) => ({
		model: row.displayName ?? modelDisplayName(row.model),
		iconUrl: modelIconUrl(row.model),
		calls: row.msgCount,
		tokens: row.totalTokens ?? 0,
		cost: row.totalCostUsd,
	})),
);

const modelTotalRow = $derived<TableRow>({
	model: $t("analytics.total"),
	calls: (analyticsData?.personal?.byModel ?? []).reduce(
		(sum, row) => sum + row.msgCount,
		0,
	),
	tokens: (analyticsData?.personal?.byModel ?? []).reduce(
		(sum, row) => sum + (row.totalTokens ?? 0),
		0,
	),
	cost: (analyticsData?.personal?.byModel ?? []).reduce(
		(sum, row) => sum + row.totalCostUsd,
		0,
	),
});

const timelineRows = $derived(analyticsData?.timeline ?? []);

const timelineChartData = $derived({
	labels: timelineRows.map((d) => d.label),
	datasets: [
		{
			label: $t("analytics.tokenUsage"),
			data: timelineRows.map((d) => d.tokens),
			borderColor: getAccent(),
			backgroundColor: "rgba(193, 95, 60, 0.08)",
			fill: true,
			tension: 0.3,
			pointRadius: 2,
			pointHoverRadius: 5,
			borderWidth: 2,
		},
	],
});

const timelineChartOptions = {
	plugins: { legend: { display: false } },
} as const;

function setGranularity(next: "weekly" | "monthly" | "yearly") {
	timelineGranularity = next;
	onTimelineChange?.(next);
}
</script>

{#if analyticsLoading && !analyticsData}
	<div class="flex items-center justify-center py-16 text-text-muted">{$t('analytics.loadingAnalytics')}</div>
{:else if analyticsError}
	<div class="settings-card">
		<p class="text-danger text-sm">{analyticsError}</p>
		<button class="btn-secondary mt-3" onclick={onRetry}>{$t('analytics.retry')}</button>
	</div>
{:else if analyticsData}
	<div class="mb-4">
		<PageSwitcher
			items={tabs}
			activeId={activeTab}
			ariaLabel={$t('analytics.yourActivity')}
			onChange={(id) => (activeTab = id as PersonalTab)}
		/>
	</div>

	{#if activeTab === 'overview'}
		<div role="tabpanel" id="personal-analytics-overview-panel" aria-labelledby="personal-analytics-overview-tab">
			<div class="mb-4">
				<MonthNav months={months} selected={selectedMonth} onChange={onMonthChange ?? (() => {})} />
			</div>
			<StatGrid>
				<StatCard
					hero
					value={formatUsd(analyticsData.personal.totalCostUsd)}
					label={$t('totalCost')}
					comparison={comparisonHint || undefined}
				/>
				<StatCard value={formatNum(analyticsData.personal.totalMessages)} label={$t('analytics.messagesSent')} />
				<StatCard value={formatNum(analyticsData.personal.totalTokens)} label={$t('analytics.tokensUsed')} />
				<StatCard value={favoriteModelLabel} label={$t('analytics.favoriteModel')} />
				<StatCard value={formatNum(analyticsData.personal.chatCount)} label={$t('analytics.conversations')} />
			</StatGrid>

			{#if timelineRows.length > 0}
				<div class="mt-5">
					<div class="mb-3 flex items-center justify-between">
						<p class="settings-label">{$t('analytics.tokenUsage')}</p>
						<div class="flex items-center gap-0 rounded-full border border-border bg-surface-overlay p-0.5">
							<button
								class="timeline-toggle-btn"
								class:timeline-toggle-btn--active={timelineGranularity === 'weekly'}
								onclick={() => setGranularity('weekly')}
								aria-label={$t('analytics.timelineWeekly')}
							>W</button>
							<button
								class="timeline-toggle-btn"
								class:timeline-toggle-btn--active={timelineGranularity === 'monthly'}
								onclick={() => setGranularity('monthly')}
								aria-label={$t('analytics.timelineMonthly')}
							>M</button>
							<button
								class="timeline-toggle-btn"
								class:timeline-toggle-btn--active={timelineGranularity === 'yearly'}
								onclick={() => setGranularity('yearly')}
								aria-label={$t('analytics.timelineYearly')}
							>Y</button>
						</div>
					</div>
					<AnalyticsChart type="line" data={timelineChartData} options={timelineChartOptions} height="200px" />
				</div>
			{/if}
		</div>
	{:else if activeTab === 'byModel'}
		<div role="tabpanel" id="personal-analytics-bymodel-panel" aria-labelledby="personal-analytics-bymodel-tab">
			<div class="mb-4">
				<MonthNav months={months} selected={selectedMonth} onChange={onMonthChange ?? (() => {})} />
			</div>
			{#if modelRows.length > 0}
				{#snippet modelCell(row: TableRow)}
					<span class="inline-flex min-w-0 items-center gap-2">
						<ModelIcon iconUrl={row.iconUrl as string | null} displayName={String(row.model ?? '')} size={20} />
						<span class="truncate text-text-primary">{row.model}</span>
					</span>
				{/snippet}
				<SortableTable
					columns={modelColumns}
					rows={modelRows}
					initialSort={{ key: 'cost', dir: 'desc' }}
					filterable
					filterKeys={['model']}
					filterPlaceholder={$t('analytics.filterModels')}
					totalRow={modelTotalRow}
					cells={{ model: modelCell }}
				/>
			{:else}
				<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
			{/if}
		</div>
	{/if}
{:else}
	<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
{/if}
