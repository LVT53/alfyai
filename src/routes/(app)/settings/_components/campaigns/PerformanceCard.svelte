<script lang="ts">
import { t } from "$lib/i18n";
import type { CampaignAnalyticsSummary } from "$lib/client/api/campaigns";

let {
	summary,
	slideCount,
	createdAt = null,
	updatedAt = null,
	publishedAt = null,
}: {
	summary: CampaignAnalyticsSummary | null | undefined;
	slideCount: number;
	createdAt?: string | number | Date | null;
	updatedAt?: string | number | Date | null;
	publishedAt?: string | number | Date | null;
} = $props();

let autoShown = $derived(summary?.autoShown ?? 0);
let completed = $derived(summary?.completed ?? 0);
let skipped = $derived(summary?.skipped ?? 0);
let replayOpened = $derived(summary?.replayOpened ?? 0);
let completionRate = $derived(
	summary?.completionRate ?? (autoShown > 0 ? completed / autoShown : 0),
);

function formatDate(value: string | number | Date | null | undefined): string {
	if (!value) return $t("admin.campaigns.dateMissing");
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		date,
	);
}
</script>

<section class="perf-card" data-testid="campaign-performance">
	<p class="eyebrow">{$t('admin.campaigns.howItPerformed')}</p>

	<div class="perf-grid">
		<div class="stat-card--hero">
			<div class="stat-value-hero">{Math.round(completionRate * 100)}%</div>
			<div class="stat-label">
				{$t('admin.campaigns.finishedAllSlides', { count: slideCount })}
			</div>
		</div>
		<div class="stat-card">
			<div class="stat-value">{autoShown.toLocaleString()}</div>
			<div class="stat-label">{$t('admin.campaigns.analyticsShown')}</div>
		</div>
		<div class="stat-card">
			<div class="stat-value">{completed.toLocaleString()}</div>
			<div class="stat-label">{$t('admin.campaigns.analyticsCompletedLabel')}</div>
		</div>
		<div class="stat-card">
			<div class="stat-value">{skipped.toLocaleString()}</div>
			<div class="stat-label">{$t('admin.campaigns.analyticsSkipped')}</div>
		</div>
		<div class="stat-card">
			<div class="stat-value">{replayOpened.toLocaleString()}</div>
			<div class="stat-label">{$t('admin.campaigns.analyticsReplayed')}</div>
		</div>
	</div>

	<dl class="history">
		<div><dt>{$t('admin.campaigns.createdAt')}</dt><dd>{formatDate(createdAt)}</dd></div>
		<div><dt>{$t('admin.campaigns.updatedAt')}</dt><dd>{formatDate(updatedAt)}</dd></div>
		<div><dt>{$t('admin.campaigns.publishedAt')}</dt><dd>{formatDate(publishedAt)}</dd></div>
	</dl>
</section>

<style>
	.perf-card {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-overlay);
		padding: 0.875rem 1rem;
	}

	.eyebrow {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		margin-bottom: 0.75rem;
	}

	.perf-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.625rem;
	}

	.history {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.875rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border-subtle);
	}

	.history > div {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-2xs);
	}

	.history dt {
		flex: 1 1 auto;
		color: var(--text-muted);
	}

	.history dd {
		color: var(--text-primary);
	}
</style>
