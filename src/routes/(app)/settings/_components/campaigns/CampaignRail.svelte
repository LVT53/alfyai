<script lang="ts">
import { Plus } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { Campaign, CampaignStatus } from "$lib/client/api/campaigns";

let {
	campaigns,
	selectedCampaignId = null,
	loading = false,
	busy = false,
	onSelect,
	onCreate,
}: {
	campaigns: Campaign[];
	selectedCampaignId?: string | null;
	loading?: boolean;
	busy?: boolean;
	onSelect: (campaignId: string) => void;
	onCreate: () => void;
} = $props();

function campaignName(campaign: Campaign): string {
	return (
		campaign.name?.trim() ||
		$t("admin.campaigns.untitledCampaign", {
			version: String(campaign.version ?? 1),
		})
	);
}

function statusLabel(status: CampaignStatus): string {
	if (status === "draft") return $t("admin.campaigns.status.draft");
	if (status === "published") return $t("admin.campaigns.status.published");
	if (status === "archived") return $t("admin.campaigns.status.archived");
	return String(status);
}

function metaLine(campaign: Campaign): string {
	const slideCount = campaign.slideCount ?? campaign.slides?.length ?? 0;
	const lead =
		campaign.type === "first_run_onboarding"
			? $t("admin.campaigns.type.firstRun")
			: (campaign.releaseVersion?.trim() ??
				$t("admin.campaigns.versionShort", { version: campaign.version ?? 1 }));
	return `${lead} · ${$t("admin.campaigns.slideCount", { count: slideCount })}`;
}
</script>

<div class="campaign-rail">
	<p class="eyebrow">{$t('admin.campaigns.title')}</p>
	<button type="button" class="btn-primary w-full justify-center gap-1.5" disabled={busy} onclick={onCreate}>
		<Plus size={14} strokeWidth={2} aria-hidden="true" />
		{$t('admin.campaigns.newCampaign')}
	</button>

	<div class="rail-list" role="list">
		{#if loading && campaigns.length === 0}
			<p class="rail-note">{$t('admin.campaigns.loading')}</p>
		{:else if campaigns.length === 0}
			<p class="rail-note">{$t('admin.campaigns.empty')}</p>
		{:else}
			{#each campaigns as campaign (campaign.id)}
				<button
					type="button"
					class="rail-item"
					class:rail-item-active={selectedCampaignId === campaign.id}
					aria-pressed={selectedCampaignId === campaign.id}
					data-testid="admin-campaign-row"
					onclick={() => onSelect(campaign.id)}
				>
					<span class="rail-item-top">
						<span class="rail-item-name">{campaignName(campaign)}</span>
						<span
							class="pill"
							class:pill-accent={campaign.status === 'draft'}
							class:pill-success={campaign.status === 'published'}
							class:pill-muted={campaign.status === 'archived'}
						>
							{statusLabel(campaign.status)}
						</span>
					</span>
					<span class="rail-item-meta">{metaLine(campaign)}</span>
				</button>
			{/each}
		{/if}
	</div>
</div>

<style>
	.campaign-rail {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.eyebrow {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.rail-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		max-height: min(60vh, 34rem);
		overflow-y: auto;
	}

	.rail-note {
		padding: 0.5rem 0.25rem;
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.rail-item {
		display: flex;
		flex-direction: column;
		gap: 3px;
		width: 100%;
		padding: 0.5rem;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		text-align: left;
		cursor: pointer;
		transition:
			background var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.rail-item:hover {
		background: var(--surface-elevated);
	}

	.rail-item-active {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, transparent);
	}

	.rail-item:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.rail-item-top {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.rail-item-name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-2xs);
		font-weight: 500;
		color: var(--text-primary);
	}

	.rail-item-meta {
		font-size: 0.66rem;
		color: var(--text-muted);
	}

	.pill {
		display: inline-flex;
		align-items: center;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		font-size: 0.6rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.pill-accent {
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	.pill-success {
		color: var(--success);
		background: color-mix(in srgb, var(--success) 16%, transparent);
	}

	.pill-muted {
		color: var(--text-muted);
		background: color-mix(in srgb, var(--text-muted) 16%, transparent);
	}
</style>
