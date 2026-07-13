<script lang="ts">
import PageSwitcher from "$lib/components/ui/PageSwitcher.svelte";
import {
	AnalyticsCard,
	AnalyticsChart,
	MonthNav,
	SERIES,
	SortableTable,
	StatCard,
	StatGrid,
	type TableColumn,
	type TableRow,
} from "$lib/components/analytics";
import { t } from "$lib/i18n";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import "$lib/components/analytics/analytics.css";

// Phase B, wave B3: the system Blocks B/C/D analytics (admin-only) rebuilt on
// the shared analytics components. ADMIN-GATED by its host (rendered only under
// the admin-only Administration tab) — contains NO personal content. Prop
// interface preserved so the parent wiring (month change reloads via
// onSystemMonthChange; excluded-users persists via onExcludedUsersChange)
// keeps working unchanged.
let {
	analyticsData = null,
	analyticsLoading = false,
	analyticsError = "",
	modelNames,
	// biome-ignore lint/correctness/noUnusedVariables: kept for prop-interface parity with the parent wiring.
	modelIcons = {},
	onRetry,
	selectedSystemMonth = null,
	onSystemMonthChange = undefined,
	allUsers = [],
	excludedUserIds = [],
	onExcludedUsersChange = undefined,
}: {
	analyticsData?: AnalyticsResponse | null;
	analyticsLoading?: boolean;
	analyticsError?: string;
	modelNames: Record<string, string>;
	modelIcons?: Record<string, string | null | undefined>;
	onRetry: () => void | Promise<void>;
	selectedSystemMonth?: string | null;
	onSystemMonthChange?: ((month: string | null) => void) | undefined;
	allUsers?: Array<{ id: string; email: string; name: string | null }>;
	excludedUserIds?: string[];
	onExcludedUsersChange?:
		| ((userIds: string[]) => Promise<void> | void)
		| undefined;
} = $props();

type SystemTab = "overview" | "byModel" | "parallel" | "byUser";
let activeTab = $state<SystemTab>("overview");

let excludedUsersSaveState = $state<"idle" | "saving" | "saved" | "error">(
	"idle",
);
let excludedUsersSaveTimer: ReturnType<typeof setTimeout> | null = null;

const system = $derived(analyticsData?.system);
const parallel = $derived(system?.parallel);
const perUserRows = $derived(analyticsData?.perUser ?? []);

const onMonth = $derived(onSystemMonthChange ?? (() => {}));

// MonthNav expects chronologically ascending "YYYY-MM" keys.
const months = $derived(
	[
		...(analyticsData?.systemAvailableMonths ??
			system?.monthly?.map((m) => m.month) ??
			[]),
	].sort(),
);

const tabs = $derived([
	{
		id: "overview",
		label: $t("analytics.overview"),
		tabId: "system-analytics-overview-tab",
		panelId: "system-analytics-overview-panel",
	},
	{
		id: "byModel",
		label: $t("analytics.usageByModel"),
		tabId: "system-analytics-bymodel-tab",
		panelId: "system-analytics-bymodel-panel",
	},
	...(parallel
		? [
				{
					id: "parallel",
					label: $t("analytics.parallelApi"),
					tabId: "system-analytics-parallel-tab",
					panelId: "system-analytics-parallel-panel",
				},
			]
		: []),
	{
		id: "byUser",
		label: $t("analytics.byUser"),
		tabId: "system-analytics-byuser-tab",
		panelId: "system-analytics-byuser-panel",
	},
]);

function modelDisplayName(key: string): string {
	return modelNames[key] ?? key;
}

function formatUsd(value: number): string {
	return `$${Number(value ?? 0).toFixed(4)}`;
}

function formatNum(value: number): string {
	if (!value) return "0";
	return value.toLocaleString();
}

function formatMonthShort(ym: string): string {
	const [y, m] = ym.split("-");
	const date = new Date(Number(y), Number(m) - 1, 1);
	return date.toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

// ---- Overview ----------------------------------------------------------
const parallelCostUsd = $derived(parallel?.totalCostUsd ?? 0);
const llmCostUsd = $derived((system?.totalCostUsd ?? 0) - parallelCostUsd);
const webCalls = $derived(
	(parallel?.totalTurboCalls ?? 0) + (parallel?.totalExtractCalls ?? 0),
);
const costSplit = $derived(
	parallel
		? $t("analytics.llmParallelSplit", {
				llm: formatUsd(llmCostUsd),
				parallel: formatUsd(parallelCostUsd),
			})
		: undefined,
);

const monthlyCostData = $derived({
	labels: (system?.monthly ?? []).map((m) => formatMonthShort(m.month)),
	datasets: [
		{
			label: $t("analytics.monthlyCost"),
			data: (system?.monthly ?? []).map((m) => m.totalCostUsd),
			backgroundColor: SERIES.llm,
			borderRadius: 4,
		},
	],
});

const monthlyCostOptions = {
	plugins: { legend: { display: false } },
} as const;

// ---- Usage by model ----------------------------------------------------
const providerPresent = $derived(
	(system?.byModel ?? []).some((row) => row.providerDisplayName),
);

const modelColumns = $derived<TableColumn[]>([
	{ key: "model", label: $t("analytics.model"), type: "text" },
	...(providerPresent
		? [
				{
					key: "provider",
					label: $t("analytics.provider"),
					type: "text" as const,
				},
			]
		: []),
	{ key: "calls", label: $t("analytics.calls"), type: "number" },
	{ key: "tokens", label: $t("analytics.totalTokens"), type: "tokens" },
	{ key: "cost", label: $t("analytics.cost"), type: "usd" },
]);

const modelRows = $derived<TableRow[]>(
	(system?.byModel ?? []).map((row) => ({
		model: row.displayName ?? modelDisplayName(row.model),
		provider: row.providerDisplayName ?? "",
		calls: row.msgCount,
		tokens: row.totalTokens ?? 0,
		cost: row.totalCostUsd,
	})),
);

const modelTotalRow = $derived<TableRow>({
	model: $t("analytics.total"),
	provider: "",
	calls: (system?.byModel ?? []).reduce((sum, row) => sum + row.msgCount, 0),
	tokens: (system?.byModel ?? []).reduce(
		(sum, row) => sum + (row.totalTokens ?? 0),
		0,
	),
	cost: (system?.byModel ?? []).reduce((sum, row) => sum + row.totalCostUsd, 0),
});

// ---- Parallel API ------------------------------------------------------
const parallelTotalCalls = $derived(
	(parallel?.totalTurboCalls ?? 0) + (parallel?.totalExtractCalls ?? 0),
);

const parallelChartData = $derived({
	labels: (parallel?.monthly ?? []).map((m) => formatMonthShort(m.month)),
	datasets: [
		{
			label: $t("analytics.turbo"),
			data: (parallel?.monthly ?? []).map((m) => m.turboCalls),
			backgroundColor: SERIES.turbo,
			borderRadius: 4,
		},
		{
			label: $t("analytics.extract"),
			data: (parallel?.monthly ?? []).map((m) => m.extractCalls),
			backgroundColor: SERIES.extract,
			borderRadius: 4,
		},
	],
});

const parallelColumns: TableColumn[] = [
	{ key: "month", label: $t("analytics.month"), type: "text" },
	{ key: "turbo", label: $t("analytics.turbo"), type: "number" },
	{ key: "extract", label: $t("analytics.extract"), type: "number" },
	{ key: "total", label: $t("analytics.total"), type: "number" },
	{ key: "cost", label: $t("analytics.cost"), type: "usd" },
];

const parallelRows = $derived<TableRow[]>(
	(parallel?.monthly ?? []).map((m) => ({
		month: formatMonthShort(m.month),
		turbo: m.turboCalls,
		extract: m.extractCalls,
		total: m.turboCalls + m.extractCalls,
		cost: m.costUsd,
	})),
);

const parallelTotalRow = $derived<TableRow>({
	month: $t("analytics.total"),
	turbo: parallel?.totalTurboCalls ?? 0,
	extract: parallel?.totalExtractCalls ?? 0,
	total: parallelTotalCalls,
	cost: parallelCostUsd,
});

// ---- By user -----------------------------------------------------------
const userColumns: TableColumn[] = [
	{ key: "user", label: $t("analytics.user"), type: "text" },
	{ key: "messages", label: $t("analytics.messages"), type: "number" },
	{ key: "tokens", label: $t("analytics.totalTokens"), type: "tokens" },
	{ key: "cost", label: $t("analytics.cost"), type: "usd" },
];

const userRows = $derived<TableRow[]>(
	perUserRows.map((row) => ({
		user: row.displayName || row.email,
		email: row.email,
		messages: row.messageCount,
		tokens: row.totalTokens ?? 0,
		cost: row.totalCostUsd,
	})),
);

const userChartData = $derived.by(() => {
	const top10 = [...perUserRows]
		.sort((a, b) => b.messageCount - a.messageCount)
		.slice(0, 10);
	return {
		labels: top10.map((row) => row.displayName || row.email),
		datasets: [
			{
				label: $t("analytics.chartMessages"),
				data: top10.map((row) => row.messageCount),
				backgroundColor: SERIES.llm,
				borderRadius: 4,
			},
			{
				label: $t("analytics.chartConversations"),
				data: top10.map((row) => row.conversationCount),
				backgroundColor: SERIES.turbo,
				borderRadius: 4,
			},
		],
	};
});

const userChartOptions = { indexAxis: "y" } as const;

async function toggleExcludedUser(userId: string) {
	if (!onExcludedUsersChange) return;
	const next = excludedUserIds.includes(userId)
		? excludedUserIds.filter((id) => id !== userId)
		: [...excludedUserIds, userId];
	excludedUsersSaveState = "saving";
	if (excludedUsersSaveTimer) {
		clearTimeout(excludedUsersSaveTimer);
		excludedUsersSaveTimer = null;
	}
	try {
		await onExcludedUsersChange(next);
		excludedUsersSaveState = "saved";
		excludedUsersSaveTimer = setTimeout(() => {
			excludedUsersSaveState = "idle";
		}, 2000);
	} catch {
		excludedUsersSaveState = "error";
		excludedUsersSaveTimer = setTimeout(() => {
			excludedUsersSaveState = "idle";
		}, 3000);
	}
}
</script>

{#if analyticsLoading && !analyticsData}
	<div class="flex items-center justify-center py-16 text-text-muted">{$t('analytics.loadingAnalytics')}</div>
{:else if analyticsError}
	<div class="settings-card">
		<p class="text-danger text-sm">{analyticsError}</p>
		<button class="btn-secondary mt-3" onclick={onRetry}>{$t('analytics.retry')}</button>
	</div>
{:else if analyticsData && system}
	<div class="mb-4">
		<PageSwitcher
			items={tabs}
			activeId={activeTab}
			ariaLabel={$t('analytics.systemOverview')}
			onChange={(id) => (activeTab = id as SystemTab)}
		/>
	</div>

	{#if activeTab === 'overview'}
		<div role="tabpanel" id="system-analytics-overview-panel" aria-labelledby="system-analytics-overview-tab">
			<AnalyticsCard title={$t('analytics.systemOverview')}>
				{#snippet header()}
					<MonthNav months={months} selected={selectedSystemMonth} onChange={onMonth} />
				{/snippet}
				<StatGrid>
					<StatCard
						hero
						value={formatUsd(system.totalCostUsd)}
						label={$t('totalCost')}
						comparison={costSplit}
					/>
					<StatCard value={formatNum(system.totalMessages)} label={$t('analytics.totalMessages')} />
					<StatCard value={formatNum(system.totalTokens)} label={$t('analytics.totalTokens')} />
					<StatCard value={formatNum(webCalls)} label={$t('analytics.webCalls')} />
					<StatCard value={formatNum(system.totalUsers)} label={$t('analytics.activeUsers')} />
					<StatCard value={formatNum(system.totalConversations ?? 0)} label={$t('analytics.totalConversations')} />
				</StatGrid>
				{#if (system.monthly ?? []).length > 0}
					<div class="mt-5">
						<p class="settings-label mb-3">{$t('analytics.monthlyCost')}</p>
						<AnalyticsChart type="bar" data={monthlyCostData} options={monthlyCostOptions} height="220px" />
					</div>
				{/if}
			</AnalyticsCard>
		</div>
	{:else if activeTab === 'byModel'}
		<div role="tabpanel" id="system-analytics-bymodel-panel" aria-labelledby="system-analytics-bymodel-tab">
			<AnalyticsCard title={$t('analytics.usageByModel')}>
				{#snippet header()}
					<MonthNav months={months} selected={selectedSystemMonth} onChange={onMonth} />
				{/snippet}
				{#if modelRows.length > 0}
					<SortableTable
						columns={modelColumns}
						rows={modelRows}
						initialSort={{ key: 'cost', dir: 'desc' }}
						filterable
						filterKeys={['model', 'provider']}
						filterPlaceholder={$t('analytics.filterModels')}
						totalRow={modelTotalRow}
					/>
				{:else}
					<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
				{/if}
			</AnalyticsCard>
		</div>
	{:else if activeTab === 'parallel' && parallel}
		<div role="tabpanel" id="system-analytics-parallel-panel" aria-labelledby="system-analytics-parallel-tab">
			<AnalyticsCard title={$t('analytics.parallelApi')}>
				{#snippet header()}
					<MonthNav months={months} selected={selectedSystemMonth} onChange={onMonth} />
				{/snippet}
				<StatGrid>
					<StatCard value={formatNum(parallel.totalTurboCalls)} label={$t('analytics.turboSearches')} />
					<StatCard value={formatNum(parallel.totalExtractCalls)} label={$t('analytics.extractFetches')} />
					<StatCard hero value={formatUsd(parallelCostUsd)} label={$t('analytics.parallelCost')} />
					<StatCard value={formatNum(parallelTotalCalls)} label={$t('analytics.totalCalls')} />
				</StatGrid>
				{#if (parallel.monthly ?? []).length > 0}
					<div class="mt-5">
						<p class="settings-label mb-3">{$t('analytics.parallelUsage')}</p>
						<AnalyticsChart type="bar" data={parallelChartData} height="220px" />
					</div>
				{/if}
			</AnalyticsCard>

			{#if (parallel.monthly ?? []).length > 0}
				<div class="mt-4">
					<AnalyticsCard title={$t('analytics.monthlyBreakdown')}>
						<SortableTable
							columns={parallelColumns}
							rows={parallelRows}
							initialSort={{ key: 'month', dir: 'desc' }}
							totalRow={parallelTotalRow}
						/>
					</AnalyticsCard>
				</div>
			{/if}
		</div>
	{:else if activeTab === 'byUser'}
		<div role="tabpanel" id="system-analytics-byuser-panel" aria-labelledby="system-analytics-byuser-tab">
			<AnalyticsCard title={$t('analytics.perUserBreakdown')}>
				{#snippet header()}
					<MonthNav months={months} selected={selectedSystemMonth} onChange={onMonth} />
				{/snippet}
				{#if perUserRows.length > 0}
					<div class="mb-5">
						<AnalyticsChart
							type="bar"
							data={userChartData}
							options={userChartOptions}
							height={`${Math.min(perUserRows.slice(0, 10).length * 36 + 60, 420)}px`}
						/>
					</div>
					<SortableTable
						columns={userColumns}
						rows={userRows}
						initialSort={{ key: 'messages', dir: 'desc' }}
						filterable
						filterKeys={['user', 'email']}
						filterPlaceholder={$t('analytics.filterUsers')}
					/>
				{:else}
					<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
				{/if}
			</AnalyticsCard>

			{#if allUsers.length > 0}
				<div class="mt-4">
					<AnalyticsCard>
						<div class="mb-3 flex items-center justify-between">
							<h3 class="text-[0.9375rem] font-semibold text-text-primary">{$t('analytics.excludedUsers')}</h3>
							{#if excludedUsersSaveState !== 'idle'}
								<span
									class="text-xs font-medium transition-opacity duration-200"
									class:text-success={excludedUsersSaveState === 'saved'}
									class:text-danger={excludedUsersSaveState === 'error'}
									class:text-text-muted={excludedUsersSaveState === 'saving'}
								>
									{#if excludedUsersSaveState === 'saving'}
										{$t('analytics.saving')}
									{:else if excludedUsersSaveState === 'saved'}
										{$t('analytics.saved')}
									{:else if excludedUsersSaveState === 'error'}
										{$t('analytics.saveFailed')}
									{/if}
								</span>
							{/if}
						</div>
						<p class="mb-3 text-xs text-text-muted">{$t('analytics.excludedUsersDescription')}</p>
						<div class="grid grid-cols-1 gap-1 sm:grid-cols-2">
							{#each allUsers as user}
								{@const excluded = excludedUserIds.includes(user.id)}
								<label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-page">
									<input
										type="checkbox"
										checked={excluded}
										oninput={() => toggleExcludedUser(user.id)}
										class="h-4 w-4 rounded border-border text-accent focus:ring-accent"
									/>
									<span class="text-text-primary">{user.name || user.email}</span>
									<span class="text-xs text-text-muted">{user.email}</span>
								</label>
							{/each}
						</div>
					</AnalyticsCard>
				</div>
			{/if}
		</div>
	{/if}
{:else}
	<div class="settings-card py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
{/if}
