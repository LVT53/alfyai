<script lang="ts">
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import PageSwitcher from "$lib/components/ui/PageSwitcher.svelte";
import {
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
import AnalyticsChassis from "./analytics/AnalyticsChassis.svelte";
import AnalyticsColumnChart from "./analytics/AnalyticsColumnChart.svelte";
import AnalyticsHero from "./analytics/AnalyticsHero.svelte";
import {
	buildComparisonDelta,
	type CostSegmentInput,
	formatCompactNumber,
	formatCurrencyUsd,
} from "./analytics/chassis-math";

// Everyday-screens redesign: the personal view now sits on the shared
// analytics chassis (hero number, split bar, tiles, gridded column chart,
// model table with a pinned Total). PERSONAL ONLY — no system/per-user data,
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

const tabItems = $derived([
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

function formatNum(value: number): string {
	if (!value) return "0";
	return value.toLocaleString("en-US");
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
	if (!prev) return "";
	const delta = buildComparisonDelta(current.totalCostUsd, prev.totalCostUsd);
	if (!delta) return "";
	return $t("analytics.comparisonVsMonth", {
		direction:
			delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "→",
		percent: delta.percent,
		month: formatMonth(prev.month),
	});
});

const favoriteModelLabel = $derived(
	analyticsData?.personal?.favoriteModel
		? modelDisplayName(analyticsData.personal.favoriteModel)
		: "—",
);

// The hero is the sum of something, and the split bar says of what. The
// analytics read model carries no chat/Atlas attribution, so the honest split
// available here is per provider — it adds up to the hero exactly, and each
// legend entry names a real amount rather than an invented category.
const ACCENT = "var(--accent)";
const ACCENT_SOFT = "color-mix(in srgb, var(--accent) 40%, transparent)";
const ACCENT_FAINT = "color-mix(in srgb, var(--accent) 18%, transparent)";
const ACCENT_REST = "color-mix(in srgb, var(--accent) 10%, transparent)";
const SPLIT_COLORS = [ACCENT, ACCENT_SOFT, ACCENT_FAINT];

/** How many providers the legend names before it starts folding. */
const NAMED_PROVIDERS = 3;

// Three named segments is as many as the legend can carry, but dropping the
// fourth provider would leave a bar that fills and a legend that does not add
// up to the hero above it. Everything past third place folds into one "Other
// providers" segment instead, so the split stays an account of the whole
// number rather than a sample of it.
const costSegments = $derived.by<CostSegmentInput[]>(() => {
	const ranked = [...(analyticsData?.personal?.byProvider ?? [])].sort(
		(left, right) => right.totalCostUsd - left.totalCostUsd,
	);
	const named = ranked.slice(0, NAMED_PROVIDERS).map((provider, index) => ({
		label: provider.displayName,
		value: provider.totalCostUsd,
		color: SPLIT_COLORS[index] ?? ACCENT_FAINT,
	}));
	const restTotal = ranked
		.slice(NAMED_PROVIDERS)
		.reduce((sum, provider) => sum + provider.totalCostUsd, 0);
	if (restTotal <= 0) return named;
	return [
		...named,
		{
			label: $t("analytics.otherProviders"),
			value: restTotal,
			color: ACCENT_REST,
		},
	];
});

const heroLabel = $derived(
	selectedMonth === null
		? $t("analytics.estimatedCostAllTime")
		: $t("analytics.estimatedCostThisMonth"),
);

const modelColumns = $derived<TableColumn[]>([
	{ key: "model", label: $t("analytics.model"), type: "text" },
	{ key: "calls", label: $t("analytics.calls"), type: "number" },
	{ key: "tokens", label: $t("analytics.totalTokens"), type: "tokens" },
	{ key: "cost", label: $t("analytics.cost"), type: "usd" },
]);

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
const timelinePoints = $derived(
	timelineRows.map((row) => ({ label: row.label, value: row.tokens })),
);

// Enough labels to orient without printing fifty-two overlapping ticks.
const timelineLabelEvery = $derived(
	Math.max(1, Math.ceil(timelinePoints.length / 4)),
);

const timelineUnit = $derived(
	timelineGranularity === "weekly"
		? $t("analytics.tokenUsagePerWeek")
		: timelineGranularity === "monthly"
			? $t("analytics.tokenUsagePerMonth")
			: $t("analytics.tokenUsagePerYear"),
);

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
	<AnalyticsChassis
		title={$t('analytics.yourActivity')}
		description={$t('analytics.yourActivityDescription')}
	>
		{#snippet controls()}
			<MonthNav months={months} selected={selectedMonth} onChange={onMonthChange ?? (() => {})} />
		{/snippet}

		{#snippet tabs()}
			<PageSwitcher
				items={tabItems}
				activeId={activeTab}
				ariaLabel={$t('analytics.yourActivity')}
				onChange={(id) => (activeTab = id as PersonalTab)}
			/>
		{/snippet}

		{#if activeTab === 'overview'}
			<div role="tabpanel" id="personal-analytics-overview-panel" aria-labelledby="personal-analytics-overview-tab">
				<AnalyticsHero
					value={formatCurrencyUsd(analyticsData.personal.totalCostUsd)}
					label={heroLabel}
					comparison={comparisonHint}
					segments={costSegments}
				/>

				<div class="mt-3">
					<StatGrid>
						<StatCard value={formatNum(analyticsData.personal.totalMessages)} label={$t('analytics.messagesSent')} />
						<StatCard
							value={formatCompactNumber(analyticsData.personal.totalTokens)}
							label={$t('analytics.tokensUsed')}
							comparison={`${formatCompactNumber(analyticsData.personal.outputTokens)} ${$t('outputTokens')} · ${formatCompactNumber(analyticsData.personal.reasoningTokens)} ${$t('analytics.reasoningTokens')}`}
						/>
						<StatCard value={formatNum(analyticsData.personal.chatCount)} label={$t('analytics.conversations')} />
						<StatCard value={favoriteModelLabel} label={$t('analytics.favoriteModel')} />
					</StatGrid>
				</div>

				{#if timelinePoints.length > 0}
					<div class="hr"></div>
					<AnalyticsColumnChart
						points={timelinePoints}
						unit={timelineUnit}
						labelEvery={timelineLabelEvery}
						note={$t('analytics.currentPeriodSolid')}
					>
						{#snippet controls()}
							<div
								class="flex items-center gap-0 rounded-full border border-border bg-surface-overlay p-0.5"
								role="group"
								aria-label={$t('analytics.timelineGranularity')}
							>
								<button
									class="timeline-toggle-btn"
									class:timeline-toggle-btn--active={timelineGranularity === 'weekly'}
									onclick={() => setGranularity('weekly')}
									aria-pressed={timelineGranularity === 'weekly'}
									aria-label={$t('analytics.timelineWeekly')}
								>W</button>
								<button
									class="timeline-toggle-btn"
									class:timeline-toggle-btn--active={timelineGranularity === 'monthly'}
									onclick={() => setGranularity('monthly')}
									aria-pressed={timelineGranularity === 'monthly'}
									aria-label={$t('analytics.timelineMonthly')}
								>M</button>
								<button
									class="timeline-toggle-btn"
									class:timeline-toggle-btn--active={timelineGranularity === 'yearly'}
									onclick={() => setGranularity('yearly')}
									aria-pressed={timelineGranularity === 'yearly'}
									aria-label={$t('analytics.timelineYearly')}
								>Y</button>
							</div>
						{/snippet}
					</AnalyticsColumnChart>
				{/if}

				{#if modelRows.length > 0}
					<div class="hr"></div>
					<p class="settings-label mb-2">
						{$t('analytics.usageByModelPeriod', {
							period: selectedMonth ? formatMonth(selectedMonth) : $t('analytics.allTime'),
						})}
					</p>
					{#snippet overviewModelCell(row: TableRow)}
						<span class="inline-flex min-w-0 items-center gap-2">
							<ModelIcon iconUrl={row.iconUrl as string | null} displayName={String(row.model ?? '')} size={20} />
							<span class="truncate text-text-primary">{row.model}</span>
						</span>
					{/snippet}
					<SortableTable
						columns={modelColumns}
						rows={modelRows}
						initialSort={{ key: 'cost', dir: 'desc' }}
						totalRow={modelTotalRow}
						cells={{ model: overviewModelCell }}
					/>
				{/if}
			</div>
		{:else if activeTab === 'byModel'}
			<div role="tabpanel" id="personal-analytics-bymodel-panel" aria-labelledby="personal-analytics-bymodel-tab">
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
	</AnalyticsChassis>
{:else}
	<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
{/if}
