<script lang="ts">
import type { Chart as ChartInstance, TooltipItem } from "chart.js";
import { onDestroy, tick } from "svelte";
import { get } from "svelte/store";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import { chartAnimation } from "./chart-reduced-motion";

// ADR-0043 slice 18c: the system Blocks B/C/D analytics (admin-only) extracted
// from the former standalone SettingsAnalyticsTab. Rendered as a sub-pane under
// the Administration tab. This component is ADMIN-GATED by its host
// (SettingsAdministrationTab only renders under the admin-only Administration
// tab) and contains NO personal content.
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

let userChart = $state<ChartInstance | null>(null);
let userChartCanvas = $state<HTMLCanvasElement | null>(null);
let excludedUsersSaveState = $state<"idle" | "saving" | "saved" | "error">(
	"idle",
);
let excludedUsersSaveTimer: ReturnType<typeof setTimeout> | null = null;
const perUserRows = $derived(analyticsData?.perUser ?? []);
const hasPerUser = $derived(perUserRows.length > 0);

function destroyCharts() {
	userChart?.destroy();
	userChart = null;
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

let systemAvailableMonths = $derived.by(() => {
	const months =
		analyticsData?.systemAvailableMonths ??
		analyticsData?.system?.monthly?.map((m) => m.month) ??
		[];
	return [...months].sort().reverse() as string[];
});

function previousMonthFromAllTime(months: string[]): string | null {
	return months[1] ?? months[0] ?? null;
}

function prevSystemMonth() {
	if (systemAvailableMonths.length === 0) return;
	if (!selectedSystemMonth) {
		onSystemMonthChange?.(previousMonthFromAllTime(systemAvailableMonths));
		return;
	}
	const idx = systemAvailableMonths.indexOf(selectedSystemMonth);
	if (idx < systemAvailableMonths.length - 1) {
		onSystemMonthChange?.(systemAvailableMonths[idx + 1]);
	}
}

function nextSystemMonth() {
	if (systemAvailableMonths.length === 0) return;
	if (!selectedSystemMonth) {
		onSystemMonthChange?.(systemAvailableMonths[0]);
		return;
	}
	const idx = systemAvailableMonths.indexOf(selectedSystemMonth);
	if (idx > 0) {
		onSystemMonthChange?.(systemAvailableMonths[idx - 1]);
	}
}

function selectAllSystemTime() {
	onSystemMonthChange?.(null);
}

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

	if (userChartCanvas) Chart.getChart(userChartCanvas)?.destroy();

	if (userChartCanvas && perUserRows.length > 0) {
		const top10 = [...perUserRows]
			.sort((left, right) => right.messageCount - left.messageCount)
			.slice(0, 10);
		userChart = new Chart(userChartCanvas, {
			type: "bar",
			data: {
				labels: top10.map((row) => row.displayName || row.email),
				datasets: [
					{
						label: translateFn("analytics.chartMessages"),
						data: top10.map((row) => row.messageCount),
						backgroundColor: "rgba(193, 95, 60, 0.8)",
						borderRadius: 4,
					},
					{
						label: translateFn("analytics.chartConversations"),
						data: top10.map((row) => row.conversationCount),
						backgroundColor: "rgba(100, 143, 175, 0.75)",
						borderRadius: 4,
					},
				],
			},
			options: {
				indexAxis: "y",
				maintainAspectRatio: false,
				animation: chartAnimation({ duration: 500 }),
				plugins: {
					legend: {
						position: "top",
						labels: {
							font: { size: 12 },
							color: "rgba(128,128,128,0.9)",
							padding: 16,
						},
					},
				},
				scales: {
					x: {
						grid: { color: "rgba(128,128,128,0.1)" },
						ticks: { color: "rgba(128,128,128,0.8)", font: { size: 11 } },
					},
					y: {
						grid: { display: false },
						ticks: { color: "rgba(128,128,128,0.9)", font: { size: 12 } },
					},
				},
			},
		});
	}
}

$effect(() => {
	if (!analyticsData || analyticsLoading || analyticsError || !hasPerUser) {
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
{:else if analyticsData && analyticsData.system}
	<section class="settings-card mb-4">
		<div class="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<h2 class="settings-section-title mb-0">{$t('analytics.systemOverview')}</h2>
			<div class="flex items-center gap-1">
				<button
					class="month-nav-btn"
					onclick={prevSystemMonth}
					disabled={systemAvailableMonths.length === 0}
					aria-label={$t('analytics.previousSystemMonth')}
				>&larr;</button>
				<span class="month-label">
					{selectedSystemMonth ? formatMonth(selectedSystemMonth) : $t('analytics.allTime')}
				</span>
				<button
					class="month-nav-btn"
					onclick={nextSystemMonth}
					disabled={systemAvailableMonths.length === 0}
					aria-label={$t('analytics.nextSystemMonth')}
				>&rarr;</button>
				{#if selectedSystemMonth}
					<button class="month-alltime-btn" onclick={selectAllSystemTime}>
						{$t('analytics.allTime')}
					</button>
				{/if}
			</div>
		</div>
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
			<div class="stat-card">
				<div class="stat-value">{formatNum(analyticsData.system.totalMessages)}</div>
				<div class="stat-label">{$t('analytics.totalMessages')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatNum(analyticsData.system.totalUsers)}</div>
				<div class="stat-label">{$t('analytics.totalUsers')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatMs(analyticsData.system.avgGenerationMs)}</div>
				<div class="stat-label">{$t('analytics.avgResponseTime')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatNum(analyticsData.system.totalTokens)}</div>
				<div class="stat-label">{$t('analytics.totalTokens')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatUsd(analyticsData.system.totalCostUsd)}</div>
				<div class="stat-label">{$t('totalCost')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatNum(analyticsData.system.promptTokens)}</div>
				<div class="stat-label">{$t('promptTokens')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatNum(analyticsData.system.cachedInputTokens)}</div>
				<div class="stat-label">{$t('cachedInput')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatNum(analyticsData.system.reasoningTokens)}</div>
				<div class="stat-label">{$t('analytics.reasoningTokens')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatNum(analyticsData.system.totalConversations ?? 0)}</div>
				<div class="stat-label">{$t('analytics.totalConversations')}</div>
			</div>
		</div>
		{#if analyticsData.system.byModel?.length > 0}
			<div class="mt-5">
				<p class="settings-label mb-3">{$t('analytics.costByModel')}</p>
				<div class="grid gap-2 sm:grid-cols-2">
					{#each analyticsData.system.byModel as row}
						<div class="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-surface-overlay px-3 py-2 text-sm">
							<div class="flex min-w-0 items-center gap-2">
								<ModelIcon iconUrl={modelIconUrl(row.model)} displayName={row.displayName ?? modelDisplayName(row.model)} size={22} />
								<span class="truncate text-text-primary">{row.displayName ?? modelDisplayName(row.model)}</span>
							</div>
							<span class="shrink-0 text-xs text-text-muted">{formatUsd(row.totalCostUsd)}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</section>

	{#if hasPerUser}
		<section class="settings-card mb-4">
			<div class="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<h2 class="settings-section-title mb-0">{$t('analytics.perUserBreakdown')}</h2>
				<div class="flex items-center gap-1">
					<button
						class="month-nav-btn"
						onclick={prevSystemMonth}
						disabled={systemAvailableMonths.length === 0}
						aria-label={$t('analytics.previousPerUserMonth')}
					>&larr;</button>
					<span class="month-label">
						{selectedSystemMonth ? formatMonth(selectedSystemMonth) : $t('analytics.allTime')}
					</span>
					<button
						class="month-nav-btn"
						onclick={nextSystemMonth}
						disabled={systemAvailableMonths.length === 0}
						aria-label={$t('analytics.nextPerUserMonth')}
					>&rarr;</button>
					{#if selectedSystemMonth}
						<button class="month-alltime-btn" onclick={selectAllSystemTime}>
							{$t('analytics.allTime')}
						</button>
					{/if}
				</div>
			</div>
			<div style={`height: ${Math.min(perUserRows.slice(0, 10).length * 36 + 60, 420)}px; position: relative;`}>
				<canvas bind:this={userChartCanvas}></canvas>
			</div>
			<div class="mt-5 overflow-x-auto">
				<table class="analytics-table w-full text-sm">
					<thead>
						<tr class="border-b border-border text-left text-xs text-text-muted">
							<th class="pb-2 pr-3 font-medium">{$t('analytics.user')}</th>
							<th class="pb-2 pr-3 font-medium">{$t('analytics.msgs')}</th>
							<th class="pb-2 pr-3 font-medium">{$t('analytics.avgTime')}</th>
							<th class="pb-2 pr-3 font-medium">{$t('promptTokens')}</th>
							<th class="pb-2 pr-3 font-medium">{$t('outputTokens')}</th>
							<th class="pb-2 pr-3 font-medium">{$t('analytics.reasoning')}</th>
							<th class="pb-2 pr-3 font-medium">{$t('analytics.totalTokens')}</th>
							<th class="pb-2 pr-3 font-medium">{$t('analytics.cost')}</th>
							<th class="pb-2 pr-3 font-medium">{$t('analytics.model')}</th>
							<th class="pb-2 font-medium">{$t('analytics.chats')}</th>
						</tr>
					</thead>
					<tbody>
						{#each perUserRows as row}
							<tr class="border-b border-border last:border-0">
								<td class="py-2 pr-3">
									<div class="font-medium text-text-primary">{row.displayName}</div>
									<div class="text-xs text-text-muted">{row.email}</div>
								</td>
								<td class="py-2 pr-3 text-text-secondary">{formatNum(row.messageCount)}</td>
								<td class="py-2 pr-3 text-text-secondary">{formatMs(row.avgGenerationMs)}</td>
								<td class="py-2 pr-3 text-text-secondary">{formatNum(row.promptTokens)}</td>
								<td class="py-2 pr-3 text-text-secondary">{formatNum(row.outputTokens)}</td>
								<td class="py-2 pr-3 text-text-secondary">{formatNum(row.reasoningTokens)}</td>
								<td class="py-2 pr-3 text-text-secondary">{formatNum(row.totalTokens)}</td>
								<td class="py-2 pr-3 text-text-secondary">{formatUsd(row.totalCostUsd)}</td>
								<td class="py-2 pr-3 text-text-secondary">
									{#if row.favoriteModel}
										<span class="inline-flex min-w-0 items-center gap-2">
											<ModelIcon iconUrl={modelIconUrl(row.favoriteModel)} displayName={modelDisplayName(row.favoriteModel)} size={20} />
											<span>{modelDisplayName(row.favoriteModel)}</span>
										</span>
									{:else}
										—
									{/if}
								</td>
								<td class="py-2 text-text-secondary">{formatNum(row.conversationCount)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	{#if allUsers.length > 0}
		<section class="settings-card mb-4">
			<div class="flex items-center justify-between mb-3">
				<h2 class="settings-section-title mb-0">{$t('analytics.excludedUsers')}</h2>
				{#if excludedUsersSaveState !== "idle"}
					<span
						class="text-xs font-medium transition-opacity duration-200"
						class:text-success={excludedUsersSaveState === "saved"}
						class:text-danger={excludedUsersSaveState === "error"}
						class:text-text-muted={excludedUsersSaveState === "saving"}
					>
						{#if excludedUsersSaveState === "saving"}
							{$t('analytics.saving')}
						{:else if excludedUsersSaveState === "saved"}
							{$t('analytics.saved')}
						{:else if excludedUsersSaveState === "error"}
							{$t('analytics.saveFailed')}
						{/if}
					</span>
				{/if}
			</div>
			<p class="text-xs text-text-muted mb-3">{$t('analytics.excludedUsersDescription')}</p>
			<div class="grid grid-cols-1 gap-1 sm:grid-cols-2">
				{#each allUsers as user}
					{@const excluded = excludedUserIds.includes(user.id)}
					<label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-page cursor-pointer">
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
		</section>
	{/if}
{:else}
	<div class="settings-card py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
{/if}
