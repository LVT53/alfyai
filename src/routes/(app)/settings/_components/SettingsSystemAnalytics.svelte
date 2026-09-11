<script lang="ts">
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
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
import AnalyticsChassis from "./analytics/AnalyticsChassis.svelte";
import AnalyticsColumnChart from "./analytics/AnalyticsColumnChart.svelte";
import AnalyticsHero from "./analytics/AnalyticsHero.svelte";
import {
	buildComparisonDelta,
	type CostSegmentInput,
	formatCurrencyUsd,
} from "./analytics/chassis-math";
import { t } from "$lib/i18n";
import {
	type AnalyticsResponse,
	fetchAnalytics,
} from "$lib/client/api/settings";
import "$lib/components/analytics/analytics.css";

// Everyday-screens redesign: the system view sits on the same chassis as the
// personal one (hero number, split bar, tiles, gridded column chart, model
// table with a pinned Total), and gains the two Overview tiles it was missing —
// active users against configured, and the first-token median with its p90 —
// rather than making an admin open a second tab to learn whether the server is
// slow. ADMIN-GATED by its host (rendered only under the admin-only
// Administration tab) — contains NO personal content. Every tab, filter and
// metric is kept, and the prop interface is unchanged so the parent wiring
// (month change reloads via onSystemMonthChange; excluded-users persists via
// onExcludedUsersChange) keeps working.
let {
	analyticsData = null,
	analyticsLoading = false,
	analyticsError = "",
	modelNames,
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

type SystemTab =
	| "overview"
	| "byModel"
	| "toolsLatency"
	| "parallel"
	| "byUser";
let activeTab = $state<SystemTab>("overview");

let excludedUsersSaveState = $state<"idle" | "saving" | "saved" | "error">(
	"idle",
);
let excludedUsersSaveTimer: ReturnType<typeof setTimeout> | null = null;

const system = $derived(analyticsData?.system);
const parallel = $derived(system?.parallel);
const perUserRows = $derived(analyticsData?.perUser ?? []);

const onMonth = $derived(onSystemMonthChange ?? (() => {}));

// Owner-approved mockup — "Usage by model" and "Tools & latency" gain three
// admin-only select filters (User/Provider/Model) that call GET /api/analytics
// with userId/modelId/providerId query params. "" means "all" (a native
// <select> value is always a string). Kept local to this component — the
// month stays parent-owned (selectedSystemMonth/onSystemMonthChange), but a
// filtered fetch below always includes the current month so the two never
// drift apart.
let filterUserId = $state("");
let filterModelId = $state("");
let filterProviderId = $state("");
let showRetired = $state(false);
const hasActiveFilters = $derived(
	Boolean(filterUserId || filterModelId || filterProviderId),
);

let filteredData = $state<AnalyticsResponse | null>(null);
let filteredLoading = $state(false);
// A failed filtered fetch used to be swallowed, leaving the previous (wrongly
// labelled) numbers on screen under the new filter. It now feeds the page's
// existing error state, together with the parent-owned analyticsError.
let filteredError = $state("");
let filterFetchToken = 0;

function runFilteredFetch(
	userId: string,
	modelId: string,
	providerId: string,
	month: string | null,
) {
	const token = ++filterFetchToken;
	filteredLoading = true;
	fetchAnalytics(false, undefined, undefined, month ?? undefined, {
		userId: userId || null,
		modelId: modelId || null,
		providerId: providerId || null,
	})
		.then((data) => {
			if (token !== filterFetchToken) return;
			filteredData = data;
			filteredError = "";
		})
		.catch((error: unknown) => {
			if (token !== filterFetchToken) return;
			// Drop the stale rows too: leaving them up under the new filter
			// labels somebody else's numbers as the filtered result.
			filteredData = null;
			filteredError = error instanceof Error ? error.message : String(error);
		})
		.finally(() => {
			if (token === filterFetchToken) filteredLoading = false;
		});
}

$effect(() => {
	const userId = filterUserId;
	const modelId = filterModelId;
	const providerId = filterProviderId;
	const month = selectedSystemMonth;
	if (!userId && !modelId && !providerId) {
		filterFetchToken += 1;
		filteredData = null;
		filteredLoading = false;
		filteredError = "";
		return;
	}
	runFilteredFetch(userId, modelId, providerId, month);
});

// Either source of failure renders in the one error card below.
const displayError = $derived(analyticsError || filteredError);

function retry() {
	filteredError = "";
	if (hasActiveFilters) {
		runFilteredFetch(
			filterUserId,
			filterModelId,
			filterProviderId,
			selectedSystemMonth,
		);
	}
	void onRetry();
}

// The prop data (unfiltered by userId/modelId/providerId) once filters are
// cleared; the locally fetched filtered read model while any are active.
const effectiveData = $derived(
	hasActiveFilters ? (filteredData ?? analyticsData) : analyticsData,
);
const effectiveSystem = $derived(effectiveData?.system);

// A stable Provider select option list: refreshed from every unfiltered (by
// provider) response so picking a provider doesn't collapse the dropdown to
// just that one entry on the next render.
let providerOptions = $state<Array<{ id: string; name: string }>>([]);
$effect(() => {
	if (filterProviderId) return;
	const rows = effectiveSystem?.byProvider ?? [];
	providerOptions = rows
		.filter((row): row is typeof row & { providerId: string } =>
			Boolean(row.providerId),
		)
		.map((row) => ({ id: row.providerId, name: row.displayName }))
		.sort((a, b) => a.name.localeCompare(b.name));
});

// The Model select uses the full, unfiltered model universe (the modelNames
// prop) rather than the current byModel breakdown, so it never shrinks when
// another filter narrows the visible rows.
const modelOptions = $derived(
	Object.entries(modelNames)
		.map(([id, name]) => ({ id, name }))
		.sort((a, b) => a.name.localeCompare(b.name)),
);

// MonthNav expects chronologically ascending "YYYY-MM" keys.
const months = $derived(
	[
		...(analyticsData?.systemAvailableMonths ??
			system?.monthly?.map((m) => m.month) ??
			[]),
	].sort(),
);

const tabItems = $derived([
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
	{
		id: "toolsLatency",
		label: $t("analytics.toolsAndLatency"),
		tabId: "system-analytics-toolslatency-tab",
		panelId: "system-analytics-toolslatency-panel",
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

function modelIconUrl(key: string | null | undefined): string | null {
	return key ? (modelIcons[key] ?? null) : null;
}

// Money, everywhere, to two places: `$0.0042` reads as a bug.
const formatUsd = formatCurrencyUsd;

const numberFmt = new Intl.NumberFormat("en-US");

function formatNum(value: number): string {
	if (!value) return "0";
	return numberFmt.format(value);
}

function formatMonthShort(ym: string): string {
	const [y, m] = ym.split("-");
	const date = new Date(Number(y), Number(m) - 1, 1);
	return date.toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

function formatMonthLong(ym: string): string {
	const [y, m] = ym.split("-");
	const date = new Date(Number(y), Number(m) - 1, 1);
	return date.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

// ---- Overview ----------------------------------------------------------
const parallelCostUsd = $derived(parallel?.totalCostUsd ?? 0);
const llmCostUsd = $derived((system?.totalCostUsd ?? 0) - parallelCostUsd);
const webCalls = $derived(
	(parallel?.totalTurboCalls ?? 0) + (parallel?.totalExtractCalls ?? 0),
);
// The hero is the sum of LLM spend and Parallel spend; the bar shows the
// proportion and the legend names both halves with their amounts, so the hero
// explains itself instead of needing a second card.
const TEAL = "#0d9488";
const costSegments = $derived<CostSegmentInput[]>(
	parallel
		? [
				{
					label: $t("analytics.llmCost"),
					value: llmCostUsd,
					color: "var(--accent)",
				},
				{
					label: $t("analytics.parallelCostLabel"),
					value: parallelCostUsd,
					color: TEAL,
				},
			]
		: [],
);

// The comparison line the personal view has always had, now on both sides.
const systemComparison = $derived.by(() => {
	const monthly = system?.monthly ?? [];
	if (!selectedSystemMonth || monthly.length === 0) return "";
	const index = monthly.findIndex((m) => m.month === selectedSystemMonth);
	if (index < 0 || index >= monthly.length - 1) return "";
	const previous = monthly[index + 1];
	const current = monthly[index];
	const delta = buildComparisonDelta(
		current.totalCostUsd,
		previous.totalCostUsd,
	);
	if (!delta) return "";
	return $t("analytics.comparisonVsMonth", {
		direction:
			delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "→",
		percent: delta.percent,
		month: formatMonthLong(previous.month),
	});
});

const heroLabel = $derived(
	selectedSystemMonth === null
		? $t("analytics.estimatedCostAllTime")
		: $t("analytics.estimatedCostThisMonth"),
);

// Monthly cost, on the shared chart chassis: same grid, same emphasised
// endpoint, different series.
const monthlyCostPoints = $derived(
	(system?.monthly ?? []).map((m) => ({
		label: formatMonthShort(m.month),
		value: m.totalCostUsd,
	})),
);
const monthlyCostLabelEvery = $derived(
	Math.max(1, Math.ceil(monthlyCostPoints.length / 4)),
);

// ---- Usage by model ----------------------------------------------------
const providerPresent = $derived(
	(effectiveSystem?.byModel ?? []).some((row) => row.providerDisplayName),
);

const overviewModelColumns = $derived<TableColumn[]>([
	{ key: "model", label: $t("analytics.model"), type: "text" },
	{ key: "calls", label: $t("analytics.calls"), type: "number" },
	{ key: "tokens", label: $t("analytics.totalTokens"), type: "tokens" },
	{ key: "cost", label: $t("analytics.cost"), type: "usd" },
]);

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
	{ key: "status", label: $t("analytics.status"), type: "text" },
	{ key: "calls", label: $t("analytics.calls"), type: "number" },
	{ key: "tokens", label: $t("analytics.totalTokens"), type: "tokens" },
	{ key: "cost", label: $t("analytics.cost"), type: "usd" },
	{
		key: "firstTokenP50",
		label: $t("analytics.firstTokenP50"),
		type: "number",
	},
	{
		key: "firstTokenP90",
		label: $t("analytics.firstTokenP90"),
		type: "number",
	},
	{
		key: "generationP50",
		label: $t("analytics.generationP50"),
		type: "number",
	},
	{
		key: "reasoningTokens",
		label: $t("analytics.reasoningTokens"),
		type: "number",
	},
]);

function statusLabel(status: unknown): string {
	if (status === "disabled") return $t("analytics.statusDisabled");
	if (status === "removed") return $t("analytics.statusRemoved");
	return $t("analytics.statusActive");
}

function statusPillClass(status: unknown): string {
	if (status === "disabled") return "status-pill status-pill--disabled";
	if (status === "removed") return "status-pill status-pill--removed";
	return "status-pill status-pill--active";
}

// Every byModel row (Analytics overhaul, frontend half) — availability,
// avgReasoningTokens and the first-token/generation percentiles are
// undefined for a row predating those message_analytics marks; blank in the
// table rather than a misleading 0.
const allModelRows = $derived<TableRow[]>(
	(effectiveSystem?.byModel ?? []).map((row) => ({
		model: row.displayName ?? modelDisplayName(row.model),
		iconUrl: modelIconUrl(row.model),
		provider: row.providerDisplayName ?? "",
		status: row.availability ?? "active",
		calls: row.msgCount,
		tokens: row.totalTokens ?? 0,
		cost: row.totalCostUsd,
		firstTokenP50: row.firstTokenP50Ms ?? null,
		firstTokenP90: row.firstTokenP90Ms ?? null,
		generationP50: row.generationP50Ms ?? null,
		reasoningTokens: row.avgReasoningTokens ?? null,
	})),
);

// A model is "removed" once neither it nor its provider is offered anymore
// (see ModelAvailability) — grouped separately at the bottom, behind the
// "Show retired" toggle, rather than mixed into the main breakdown.
const activeModelRows = $derived(
	allModelRows.filter((row) => row.status !== "removed"),
);
const retiredModelRows = $derived(
	allModelRows.filter((row) => row.status === "removed"),
);

// Totalled over EVERY model in scope, retired ones included, so the pinned
// Total row and the stat row above it describe the same set — a retired
// model's spend must not silently disappear from the card's arithmetic just
// because its rows moved into the collapsed group below.
const modelTotalRow = $derived<TableRow>({
	model: $t("analytics.total"),
	provider: "",
	status: "",
	calls: allModelRows.reduce((sum, row) => sum + (row.calls as number), 0),
	tokens: allModelRows.reduce((sum, row) => sum + (row.tokens as number), 0),
	cost: allModelRows.reduce((sum, row) => sum + (row.cost as number), 0),
});

function formatMs(value: number | null | undefined): string {
	return value == null ? "—" : `${formatNum(Math.round(value))} ms`;
}

// A simple calls-weighted mean across models in scope — a fair single figure
// for the stat row above the table, not a re-derivation of any single
// model's own percentile.
function weightedMeanMs(
	rows: readonly TableRow[],
	key: "firstTokenP50" | "firstTokenP90",
): number | null {
	let weightedSum = 0;
	let totalWeight = 0;
	for (const row of rows) {
		const value = row[key];
		const weight = row.calls as number;
		if (typeof value === "number" && weight > 0) {
			weightedSum += value * weight;
			totalWeight += weight;
		}
	}
	return totalWeight > 0 ? weightedSum / totalWeight : null;
}

const modelCallsTotal = $derived(effectiveSystem?.totalMessages ?? 0);
const modelTokensTotal = $derived(effectiveSystem?.totalTokens ?? 0);
const modelCostTotal = $derived(effectiveSystem?.totalCostUsd ?? 0);
const modelFirstTokenP50Agg = $derived(
	weightedMeanMs(allModelRows, "firstTokenP50"),
);
const modelFirstTokenP90Agg = $derived(
	weightedMeanMs(allModelRows, "firstTokenP90"),
);
const activeModelsCount = $derived(
	allModelRows.filter((row) => row.status === "active").length,
);
const configuredModelsCount = $derived(
	allModelRows.filter((row) => row.status !== "removed").length,
);

// ---- Tools & latency (Analytics overhaul, frontend half) ---------------
// Three admin-only cards honouring the same User/Provider/Model filters as
// the Usage by model tab — see `effectiveData` above.
const TOP_N = 10;

function showAllFooterLabel(shownCount: number, totalCount: number): string {
	return `${$t("analytics.showingOfTotal", { shown: shownCount, total: totalCount })} · ${$t(
		"analytics.viewAllCount",
		{ total: totalCount },
	)}`;
}

// $derived, like modelColumns above: a plain const would freeze the labels
// at mount and leave them in the previous language after an in-app switch.
const toolsColumns = $derived<TableColumn[]>([
	{ key: "tool", label: $t("analytics.tool"), type: "text" },
	{ key: "calls", label: $t("analytics.calls"), type: "number" },
	{ key: "failedPct", label: $t("analytics.failedPercent"), type: "number" },
	{ key: "cachedPct", label: $t("analytics.cachedPercent"), type: "number" },
	{ key: "p50", label: $t("analytics.durationP50"), type: "number" },
]);

function percentOf(part: number, total: number): number {
	return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

const toolsRows = $derived<TableRow[]>(
	(effectiveData?.tools ?? []).map((tool) => ({
		tool: tool.name,
		calls: tool.calls,
		failedPct: percentOf(tool.failed, tool.calls),
		cachedPct: percentOf(tool.cached, tool.calls),
		p50: tool.p50DurationMs,
	})),
);
const toolsShowAllLabel = $derived(
	showAllFooterLabel(Math.min(TOP_N, toolsRows.length), toolsRows.length),
);

function kindLabel(kind: unknown): string {
	if (kind === "composer_command") return $t("analytics.kindCommand");
	if (kind === "skill_use") return $t("analytics.kindSkill");
	return $t("analytics.kindClick");
}

const commandsColumns = $derived<TableColumn[]>([
	{ key: "name", label: $t("analytics.name"), type: "text" },
	{ key: "kind", label: $t("analytics.kind"), type: "text" },
	{ key: "uses", label: $t("analytics.uses"), type: "number" },
]);

const commandsRows = $derived<TableRow[]>(
	(effectiveData?.commandsAndSkills ?? []).map((entry) => ({
		name: entry.name,
		kind: entry.kind,
		uses: entry.count,
	})),
);
const commandsShowAllLabel = $derived(
	showAllFooterLabel(Math.min(TOP_N, commandsRows.length), commandsRows.length),
);

const latencyColumns = $derived<TableColumn[]>([
	{ key: "bucket", label: $t("analytics.promptBucket"), type: "text" },
	{ key: "turns", label: $t("analytics.turns"), type: "number" },
	{ key: "p50", label: $t("analytics.firstTokenP50"), type: "number" },
	{ key: "p90", label: $t("analytics.firstTokenP90"), type: "number" },
	{
		key: "reasoningMedian",
		label: $t("analytics.reasoningTokensMedian"),
		type: "number",
	},
	{ key: "bar", label: "", type: "number" },
]);

const latencyRows = $derived.by(() => {
	const rows = effectiveData?.latencyByPromptBucket ?? [];
	const maxP90 = Math.max(1, ...rows.map((row) => row.firstTokenP90Ms ?? 0));
	return rows.map((row) => ({
		bucket: row.bucket,
		turns: row.n,
		p50: row.firstTokenP50Ms,
		p90: row.firstTokenP90Ms,
		reasoningMedian: row.reasoningTokensMedian,
		bar: row.firstTokenP90Ms ?? 0,
		barPct:
			row.firstTokenP90Ms != null
				? Math.round((row.firstTokenP90Ms / maxP90) * 100)
				: 0,
	}));
});

// Every bucket is always present in the read model (n: 0 when empty), so
// "has data" means a turn landed in some bucket — a non-empty row list is
// always true here and would render five rows of em-dashes in place of the
// empty state.
const hasLatencyData = $derived(latencyRows.some((row) => row.turns > 0));

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
{:else if displayError}
	<div class="settings-card">
		<p class="text-danger text-sm">{displayError}</p>
		<button class="btn-secondary mt-3" onclick={retry}>{$t('analytics.retry')}</button>
	</div>
{:else if analyticsData && system}
	<AnalyticsChassis
		title={$t('analytics.systemOverview')}
		description={$t('analytics.systemAnalyticsDescription')}
	>
		{#snippet controls()}
			<MonthNav months={months} selected={selectedSystemMonth} onChange={onMonth} />
		{/snippet}

		{#snippet filters()}
			<select
				class="system-analytics-filter"
				aria-label={$t('analytics.user')}
				bind:value={filterUserId}
			>
				<option value="">{$t('analytics.allUsers')}</option>
				{#each allUsers as user (user.id)}
					<option value={user.id}>{user.name || user.email}</option>
				{/each}
			</select>
			<select
				class="system-analytics-filter"
				aria-label={$t('analytics.provider')}
				bind:value={filterProviderId}
			>
				<option value="">{$t('analytics.allProviders')}</option>
				{#each providerOptions as provider (provider.id)}
					<option value={provider.id}>{provider.name}</option>
				{/each}
			</select>
			<select
				class="system-analytics-filter"
				aria-label={$t('analytics.model')}
				bind:value={filterModelId}
			>
				<option value="">{$t('analytics.allModels')}</option>
				{#each modelOptions as model (model.id)}
					<option value={model.id}>{model.name}</option>
				{/each}
			</select>
			<label class="flex items-center gap-1.5 text-xs text-text-muted">
				<input type="checkbox" bind:checked={showRetired} class="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent" />
				{$t('analytics.showRetired')}
			</label>
			{#if filteredLoading}
				<span class="text-xs text-text-muted" role="status" aria-live="polite">{$t('analytics.loadingAnalytics')}</span>
			{/if}
		{/snippet}

		{#snippet tabs()}
			<PageSwitcher
				items={tabItems}
				activeId={activeTab}
				ariaLabel={$t('analytics.systemOverview')}
				onChange={(id) => (activeTab = id as SystemTab)}
			/>
		{/snippet}

	{#if activeTab === 'overview'}
		<div role="tabpanel" id="system-analytics-overview-panel" aria-labelledby="system-analytics-overview-tab">
			<AnalyticsHero
				value={formatUsd(system.totalCostUsd)}
				label={heroLabel}
				comparison={systemComparison}
				segments={costSegments}
			/>
			<div class="mt-3">
				<StatGrid>
					<StatCard value={formatNum(system.totalMessages)} label={$t('analytics.totalMessages')} />
					<StatCard value={formatNum(system.totalTokens)} label={$t('analytics.totalTokens')} />
					<StatCard
						value={formatNum(webCalls)}
						label={$t('analytics.webCalls')}
						comparison={parallel
							? `${formatNum(parallel.totalTurboCalls)} ${$t('analytics.turbo')} · ${formatNum(parallel.totalExtractCalls)} ${$t('analytics.extract')}`
							: undefined}
					/>
					<StatCard value={formatNum(system.totalConversations ?? 0)} label={$t('analytics.totalConversations')} />
					<!-- Two tiles the Overview was missing: an admin should not have to
					     open a second tab to learn whether the server is slow. -->
					<StatCard
						value={`${formatNum(system.totalUsers)} / ${formatNum(allUsers.length || system.totalUsers)}`}
						label={$t('analytics.activeUsersThisMonth')}
					/>
					<StatCard
						value={formatMs(modelFirstTokenP50Agg)}
						label={$t('analytics.firstTokenMedian')}
						comparison={`${$t('analytics.firstTokenP90')} ${formatMs(modelFirstTokenP90Agg)}`}
					/>
				</StatGrid>
			</div>
			{#if monthlyCostPoints.length > 0}
				<div class="hr"></div>
				<AnalyticsColumnChart
					points={monthlyCostPoints}
					unit={$t('analytics.monthlyCost')}
					labelEvery={monthlyCostLabelEvery}
					formatValue={(value) => formatUsd(value)}
					note={$t('analytics.currentPeriodSolid')}
				/>
			{/if}
			{#if activeModelRows.length > 0}
				<div class="hr"></div>
				<p class="settings-label mb-2">
					{$t('analytics.usageByModelPeriod', {
						period: selectedSystemMonth
							? formatMonthShort(selectedSystemMonth)
							: $t('analytics.allTime'),
					})}
				</p>
				{#snippet overviewModelCell(row: TableRow)}
					<span class="inline-flex min-w-0 items-center gap-2">
						<ModelIcon iconUrl={row.iconUrl as string | null} displayName={String(row.model ?? '')} size={20} />
						<span class="truncate text-text-primary">{row.model}</span>
					</span>
				{/snippet}
				<SortableTable
					columns={overviewModelColumns}
					rows={activeModelRows}
					initialSort={{ key: 'cost', dir: 'desc' }}
					totalRow={modelTotalRow}
					cells={{ model: overviewModelCell }}
				/>
			{/if}
		</div>
	{:else if activeTab === 'byModel'}
		<div role="tabpanel" id="system-analytics-bymodel-panel" aria-labelledby="system-analytics-bymodel-tab">
			<AnalyticsCard title={$t('analytics.usageByModel')}>
				<StatGrid>
					<StatCard hero value={formatUsd(modelCostTotal)} label={$t('totalCost')} />
					<StatCard value={formatNum(modelCallsTotal)} label={$t('analytics.modelCalls')} />
					<StatCard value={formatNum(modelTokensTotal)} label={$t('analytics.totalTokens')} />
					<StatCard value={formatMs(modelFirstTokenP50Agg)} label={$t('analytics.firstTokenMedian')} />
					<StatCard value={formatMs(modelFirstTokenP90Agg)} label={$t('analytics.firstTokenP90')} />
					<StatCard value={`${activeModelsCount} / ${configuredModelsCount}`} label={$t('analytics.modelsActiveConfigured')} />
				</StatGrid>
				<div class="mt-5">
					{#if activeModelRows.length > 0}
						{#snippet modelCell(row: TableRow)}
							<span class="inline-flex min-w-0 items-center gap-2">
								<ModelIcon iconUrl={row.iconUrl as string | null} displayName={String(row.model ?? '')} size={20} />
								<span class="truncate text-text-primary">{row.model}</span>
							</span>
						{/snippet}
						{#snippet statusCell(row: TableRow)}
							{#if row.status}
								<span class={statusPillClass(row.status)}>{statusLabel(row.status)}</span>
							{/if}
						{/snippet}
						{#snippet msCell(_row: TableRow, value: unknown)}
							{value == null ? '—' : formatMs(value as number)}
						{/snippet}
						{#snippet mutedMsCell(_row: TableRow, value: unknown)}
							<span class="text-text-muted">{value == null ? '—' : formatMs(value as number)}</span>
						{/snippet}
						{#snippet mutedNumberCell(_row: TableRow, value: unknown)}
							<span class="text-text-muted">{value == null ? '—' : formatNum(value as number)}</span>
						{/snippet}
						<SortableTable
							columns={modelColumns}
							rows={activeModelRows}
							initialSort={{ key: 'cost', dir: 'desc' }}
							filterable
							filterKeys={['model', 'provider']}
							filterPlaceholder={$t('analytics.filterModels')}
							totalRow={modelTotalRow}
							cells={{
								model: modelCell,
								status: statusCell,
								firstTokenP50: msCell,
								firstTokenP90: mutedMsCell,
								generationP50: msCell,
								reasoningTokens: mutedNumberCell,
							}}
						/>
					{:else}
						<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
					{/if}
				</div>
				{#if showRetired && retiredModelRows.length > 0}
					<div class="mt-6">
						<p class="retired-group-label mb-3">{$t('analytics.retiredGroupLabel')}</p>
						{#snippet retiredModelCell(row: TableRow)}
							<span class="inline-flex min-w-0 items-center gap-2">
								<ModelIcon iconUrl={row.iconUrl as string | null} displayName={String(row.model ?? '')} size={20} />
								<span class="truncate text-text-primary">{row.model}</span>
							</span>
						{/snippet}
						{#snippet retiredStatusCell(row: TableRow)}
							{#if row.status}
								<span class={statusPillClass(row.status)}>{statusLabel(row.status)}</span>
							{/if}
						{/snippet}
						{#snippet retiredMsCell(_row: TableRow, value: unknown)}
							{value == null ? '—' : formatMs(value as number)}
						{/snippet}
						{#snippet retiredMutedMsCell(_row: TableRow, value: unknown)}
							<span class="text-text-muted">{value == null ? '—' : formatMs(value as number)}</span>
						{/snippet}
						{#snippet retiredMutedNumberCell(_row: TableRow, value: unknown)}
							<span class="text-text-muted">{value == null ? '—' : formatNum(value as number)}</span>
						{/snippet}
						<SortableTable
							columns={modelColumns}
							rows={retiredModelRows}
							initialSort={{ key: 'cost', dir: 'desc' }}
							cells={{
								model: retiredModelCell,
								status: retiredStatusCell,
								firstTokenP50: retiredMsCell,
								firstTokenP90: retiredMutedMsCell,
								generationP50: retiredMsCell,
								reasoningTokens: retiredMutedNumberCell,
							}}
						/>
					</div>
				{/if}
			</AnalyticsCard>
		</div>
	{:else if activeTab === 'toolsLatency'}
		<div role="tabpanel" id="system-analytics-toolslatency-panel" aria-labelledby="system-analytics-toolslatency-tab">
			<AnalyticsCard title={$t('analytics.tools')}>
				{#if toolsRows.length > 0}
					{#snippet toolCell(_row: TableRow, value: unknown)}
						<span class="font-mono text-xs text-text-primary">{value}</span>
					{/snippet}
					{#snippet percentCell(_row: TableRow, value: unknown)}
						<span>{value}%</span>
					{/snippet}
					<SortableTable
						columns={toolsColumns}
						rows={toolsRows}
						initialSort={{ key: 'calls', dir: 'desc' }}
						maxRows={TOP_N}
						showAllLabel={toolsShowAllLabel}
						showFewerLabel={$t('analytics.showFewer')}
						cells={{ tool: toolCell, failedPct: percentCell, cachedPct: percentCell }}
					/>
				{:else}
					<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
				{/if}
			</AnalyticsCard>

			<div class="mt-4">
				<AnalyticsCard title={$t('analytics.commandsSkillsActions')}>
					{#if commandsRows.length > 0}
						{#snippet kindCell(row: TableRow)}
							<span class="kind-pill">{kindLabel(row.kind)}</span>
						{/snippet}
						<SortableTable
							columns={commandsColumns}
							rows={commandsRows}
							initialSort={{ key: 'uses', dir: 'desc' }}
							maxRows={TOP_N}
							showAllLabel={commandsShowAllLabel}
							showFewerLabel={$t('analytics.showFewer')}
							cells={{ kind: kindCell }}
						/>
					{:else}
						<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
					{/if}
				</AnalyticsCard>
			</div>

			<div class="mt-4">
				<AnalyticsCard title={$t('analytics.latencyByPromptSize')}>
					{#if hasLatencyData}
						{#snippet p90Cell(_row: TableRow, value: unknown)}
							<span class="text-text-muted">{value == null ? '—' : `${formatNum(value as number)} ms`}</span>
						{/snippet}
						{#snippet barCell(row: TableRow)}
							<div class="latency-bar-track">
								<div class="latency-bar-fill" style={`width: ${row.barPct}%;`}></div>
							</div>
						{/snippet}
						<SortableTable
							columns={latencyColumns}
							rows={latencyRows}
							initialSort={{ key: 'bucket', dir: 'asc' }}
							cells={{ p90: p90Cell, bar: barCell }}
						/>
					{:else}
						<div class="py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
					{/if}
				</AnalyticsCard>
			</div>
		</div>
	{:else if activeTab === 'parallel' && parallel}
		<div role="tabpanel" id="system-analytics-parallel-panel" aria-labelledby="system-analytics-parallel-tab">
			<AnalyticsCard title={$t('analytics.parallelApi')}>
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
	</AnalyticsChassis>
{:else}
	<div class="settings-card py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
{/if}

<style>
	.system-analytics-filter {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-primary);
		font-size: 0.8rem;
		padding: 0.35rem 0.6rem;
	}

	.system-analytics-filter:focus {
		outline: none;
		border-color: var(--accent);
	}
</style>
