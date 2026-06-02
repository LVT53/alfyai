<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { get } from 'svelte/store';
	import ModelIcon from '$lib/components/ui/ModelIcon.svelte';
	import { t, type I18nKey } from '$lib/i18n';

	let {
		analyticsData = null,
		analyticsLoading = false,
		analyticsError = '',
		isAdmin = false,
		modelNames,
		modelIcons = {},
		onRetry,
		selectedMonth = null,
		onMonthChange = undefined,
		onTimelineChange = undefined,
	}: {
		analyticsData?: any;
		analyticsLoading?: boolean;
		analyticsError?: string;
		isAdmin?: boolean;
		modelNames: Record<string, string>;
		modelIcons?: Record<string, string | null | undefined>;
		onRetry: () => void | Promise<void>;
		selectedMonth?: string | null;
		onMonthChange?: ((month: string | null) => void) | undefined;
		onTimelineChange?: ((granularity: string) => void) | undefined;
	} = $props();

	let modelChart = $state<any>(null);
	let userChart = $state<any>(null);
	let timelineChart = $state<any>(null);
	let modelChartCanvas = $state<HTMLCanvasElement | null>(null);
	let userChartCanvas = $state<HTMLCanvasElement | null>(null);
	let timelineChartCanvas = $state<HTMLCanvasElement | null>(null);
	let timelineGranularity = $state<'weekly' | 'monthly' | 'yearly'>('weekly');

	// Palette aligned with app accent (#C15F3C), success (#15803D), and complementary tones
	const CHART_COLORS = [
		'rgba(193, 95, 60, 0.88)',     // accent terracotta
		'rgba(100, 143, 175, 0.88)',   // muted blue
		'rgba(21, 128, 61, 0.88)',     // success green
		'rgba(165, 95, 95, 0.88)',     // muted rose
		'rgba(115, 100, 160, 0.88)',   // muted violet
		'rgba(185, 140, 65, 0.88)',    // warm amber
	];

	function destroyCharts() {
		modelChart?.destroy();
		modelChart = null;
		userChart?.destroy();
		userChart = null;
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
		if (!ms) return '—';
		return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	function formatNum(value: number): string {
		if (!value) return '0';
		return value.toLocaleString();
	}

	function formatUsd(value: number): string {
		return `$${Number(value ?? 0).toFixed(4)}`;
	}

	function formatMonth(ym: string): string {
		const [y, m] = ym.split('-');
		const date = new Date(Number(y), Number(m) - 1, 1);
		return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
	}

	let availableMonths = $derived.by(() => {
		const months = analyticsData?.availableMonths ??
			analyticsData?.personal?.monthly?.map((m: any) => m.month) ??
			[];
		return [...months].sort().reverse() as string[];
	});

	function prevMonth() {
		if (availableMonths.length === 0) return;
		if (!selectedMonth) {
			onMonthChange?.(availableMonths[availableMonths.length - 1]);
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
		if (!selectedMonth || !analyticsData?.personal?.monthly) return '';
		const months = analyticsData.personal.monthly;
		const current = months.find((m: any) => m.month === selectedMonth);
		if (!current) return '';
		const idx = months.findIndex((m: any) => m.month === selectedMonth);
		if (idx >= months.length - 1) return '';
		const prev = months[idx + 1];
		if (!prev || prev.totalCostUsd === 0) return '';
		const diff = ((current.totalCostUsd - prev.totalCostUsd) / prev.totalCostUsd) * 100;
		const arrow = diff > 0 ? '\u2191' : '\u2193';
		return $t('analytics.comparisonVsMonth', {
			direction: arrow,
			percent: Math.abs(diff).toFixed(0),
			month: formatMonth(prev.month),
		});
	});

	async function initCharts(translateFn: (key: I18nKey, params?: Record<string, string | number>) => string) {
		if (!analyticsData) return;
		await tick();
		destroyCharts();

		const { Chart } = await import('chart.js/auto');

		if (modelChartCanvas) Chart.getChart(modelChartCanvas)?.destroy();
		if (userChartCanvas) Chart.getChart(userChartCanvas)?.destroy();

		if (modelChartCanvas && analyticsData.personal.byModel?.length > 0) {
			const byModel = analyticsData.personal.byModel;
			modelChart = new Chart(modelChartCanvas, {
				type: 'bar',
				data: {
					labels: byModel.map((row: any) => row.displayName ?? modelDisplayName(row.model)),
					datasets: [{
						label: translateFn('analytics.chartCostUsd'),
						data: byModel.map((row: any) => Number(row.totalCostUsd)),
						backgroundColor: CHART_COLORS.slice(0, byModel.length),
						borderWidth: 0,
						borderRadius: 4,
					}],
				},
				options: {
					indexAxis: 'y',
					maintainAspectRatio: false,
					animation: { duration: 700, easing: 'easeInOutQuart' },
					plugins: {
						legend: { display: false },
						tooltip: {
							callbacks: {
								label: (ctx: any) =>
									` ${ctx.label}: ${formatUsd(ctx.raw)}`,
							},
						},
					},
					scales: {
						x: {
							grid: { color: 'rgba(128,128,128,0.1)' },
							ticks: {
								color: 'rgba(128,128,128,0.8)',
								font: { size: 11 },
								callback: (value: any) => formatUsd(value),
							},
						},
						y: {
							grid: { display: false },
							ticks: { color: 'rgba(128,128,128,0.9)', font: { size: 12 } },
						},
					},
				},
			});
		}

		if (timelineChartCanvas && analyticsData.timeline?.length > 0) {
			Chart.getChart(timelineChartCanvas)?.destroy();
			const data = analyticsData.timeline;
			timelineChart = new Chart(timelineChartCanvas, {
				type: 'line',
				data: {
					labels: data.map((d: any) => d.label),
					datasets: [{
						label: 'Tokens',
						data: data.map((d: any) => d.tokens),
						borderColor: 'rgba(193, 95, 60, 0.88)',
						backgroundColor: 'rgba(193, 95, 60, 0.08)',
						fill: true,
						tension: 0.3,
						pointRadius: 2,
						pointHoverRadius: 5,
						borderWidth: 2,
					}],
				},
				options: {
					maintainAspectRatio: false,
					animation: { duration: 600 },
					plugins: {
						legend: { display: false },
					},
					scales: {
						x: {
							grid: { display: false },
							ticks: { color: 'rgba(128,128,128,0.8)', font: { size: 10 }, maxRotation: 0 },
						},
						y: {
							grid: { color: 'rgba(128,128,128,0.1)' },
							ticks: { color: 'rgba(128,128,128,0.8)', font: { size: 11 } },
						},
					},
				},
			});
		}

		if (isAdmin && userChartCanvas && analyticsData.perUser?.length > 0) {
			const top10 = [...analyticsData.perUser]
				.sort((left: any, right: any) => right.messageCount - left.messageCount)
				.slice(0, 10);
			userChart = new Chart(userChartCanvas, {
				type: 'bar',
				data: {
					labels: top10.map((row: any) => row.displayName || row.email),
					datasets: [
						{
							label: translateFn('analytics.chartMessages'),
							data: top10.map((row: any) => row.messageCount),
							backgroundColor: 'rgba(193, 95, 60, 0.8)',
							borderRadius: 4,
						},
						{
							label: translateFn('analytics.chartConversations'),
							data: top10.map((row: any) => row.conversationCount),
							backgroundColor: 'rgba(100, 143, 175, 0.75)',
							borderRadius: 4,
						},
					],
				},
				options: {
					indexAxis: 'y',
					maintainAspectRatio: false,
					animation: { duration: 500 },
					plugins: {
						legend: {
							position: 'top',
							labels: { font: { size: 12 }, color: 'rgba(128,128,128,0.9)', padding: 16 },
						},
					},
					scales: {
						x: {
							grid: { color: 'rgba(128,128,128,0.1)' },
							ticks: { color: 'rgba(128,128,128,0.8)', font: { size: 11 } },
						},
						y: {
							grid: { display: false },
							ticks: { color: 'rgba(128,128,128,0.9)', font: { size: 12 } },
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

{#if analyticsLoading}
	<div class="flex items-center justify-center py-16 text-text-muted">{$t('analytics.loadingAnalytics')}</div>
{:else if analyticsError}
	<div class="settings-card">
		<p class="text-danger text-sm">{analyticsError}</p>
		<button class="btn-secondary mt-3" onclick={onRetry}>{$t('analytics.retry')}</button>
	</div>
{:else if analyticsData}
	<section class="settings-card mb-4">
		<div class="flex items-center justify-between mb-3">
			<h2 class="settings-section-title">{$t('analytics.yourActivity')}</h2>
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

		{#if analyticsData.timeline?.length > 0}
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
	</section>

	{#if isAdmin && analyticsData.system}
		<section class="settings-card mb-4">
			<h2 class="settings-section-title">{$t('analytics.systemOverview')}</h2>
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

		{#if analyticsData.perUser?.length > 0}
			<section class="settings-card mb-4">
				<h2 class="settings-section-title">{$t('analytics.userActivity')}</h2>
				<div style={`height: ${Math.min(analyticsData.perUser.slice(0, 10).length * 36 + 60, 420)}px; position: relative;`}>
					<canvas bind:this={userChartCanvas}></canvas>
				</div>
			</section>
		{/if}

		{#if analyticsData.perUser?.length > 0}
			<section class="settings-card mb-4 overflow-x-auto">
				<h2 class="settings-section-title">{$t('analytics.perUserBreakdown')}</h2>
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
						{#each analyticsData.perUser as row}
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
			</section>
		{/if}
	{/if}
{:else}
	<div class="settings-card py-8 text-center text-sm text-text-muted">{$t('analytics.noData')}</div>
{/if}
