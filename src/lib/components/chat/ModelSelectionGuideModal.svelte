<script lang="ts">
import { ExternalLink, X } from "@lucide/svelte";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import type {
	ModelProvider,
	ProviderModel,
} from "$lib/client/api/models";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import {
	regionCodeToFlag,
	regionDisplayName,
} from "$lib/services/processing-region";

let {
	providers = [],
	onClose,
}: {
	providers?: ModelProvider[];
	onClose?: () => void;
} = $props();

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") onClose?.();
}

function modelGuideNote(model: ProviderModel): string {
	const primary = $uiLanguage === "hu" ? model.guideNoteHu : model.guideNoteEn;
	const fallback = $uiLanguage === "hu" ? model.guideNoteEn : model.guideNoteHu;
	return primary || fallback || "";
}

function dollars(micros: number): string {
	return `$${(micros / 1_000_000).toFixed(4)}`;
}

function exactCostLabel(model: ProviderModel): string {
	return $t("modelSelector.costExact", {
		input: dollars(model.inputUsdMicrosPer1m),
		output: dollars(model.outputUsdMicrosPer1m),
	});
}

function costIndicator(model: ProviderModel): string {
	const total = model.inputUsdMicrosPer1m + model.outputUsdMicrosPer1m;
	if (total <= 0) return $t("modelSelector.costUnknown");
	if (total <= 2_000_000) return $t("modelSelector.costLow");
	if (total <= 12_000_000) return $t("modelSelector.costStandard");
	return $t("modelSelector.costHigh");
}

function badgeLabel(model: ProviderModel): string {
	if (model.guideBadge === "intelligent") {
		return $t("modelSelector.badge.intelligent");
	}
	if (model.guideBadge === "fast") {
		return $t("modelSelector.badge.fast");
	}
	return "";
}

function hasLargeContext(model: ProviderModel): boolean {
	return (model.maxModelContext ?? 0) >= 128_000;
}

function formatContext(value: number | null): string {
	if (!value) return "";
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

function regionTitle(provider: ModelProvider): string {
	const name = regionDisplayName(provider.processingRegionCode, $uiLanguage);
	return name ? $t("modelSelector.processingRegion", { region: name }) : "";
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="model-guide-backdrop" role="presentation">
	<div
		class="model-guide-modal"
		role="dialog"
		aria-modal="true"
		aria-labelledby="model-guide-title"
	>
		<header class="model-guide-header">
			<div>
				<h2 id="model-guide-title">{$t('modelSelector.guideTitle')}</h2>
				<p>{$t('modelSelector.guideDescription')}</p>
			</div>
			<button
				type="button"
				class="model-guide-close"
				onclick={onClose}
				aria-label={$t('common.close')}
			>
				<X size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		</header>

		<div class="model-guide-content">
			{#if providers.length === 0}
				<p class="model-guide-empty">{$t('modelSelector.guideEmpty')}</p>
			{:else}
				{#each providers as provider (provider.id)}
					<section class="model-guide-provider" aria-label={provider.displayName}>
						<div class="model-guide-provider-header">
							<div class="model-guide-provider-title">
								<ModelIcon
									iconUrl={provider.iconUrl ?? null}
									displayName={provider.displayName}
									size={20}
								/>
								<span>{provider.displayName}</span>
								{#if provider.processingRegionCode}
									<span
										class="model-guide-region"
										title={regionTitle(provider)}
										aria-label={regionTitle(provider)}
									>
										{regionCodeToFlag(provider.processingRegionCode)}
									</span>
								{/if}
							</div>
							{#if provider.privacyPolicyUrl}
								<a
									class="model-guide-policy"
									href={provider.privacyPolicyUrl}
									target="_blank"
									rel="noopener noreferrer"
									title={$t('modelSelector.privacyPolicy')}
									aria-label={$t('modelSelector.privacyPolicy')}
								>
									<ExternalLink size={15} strokeWidth={2} aria-hidden="true" />
								</a>
							{/if}
						</div>

						<div class="model-guide-rows">
							{#each provider.models as model (model.id)}
								<article class="model-guide-row">
									<div class="model-guide-row-main">
										<ModelIcon
											iconUrl={model.iconUrl ?? provider.iconUrl ?? null}
											displayName={model.displayName}
											size={22}
										/>
										<div class="model-guide-row-text">
											<div class="model-guide-model-line">
												<span class="model-guide-model-name">{model.displayName}</span>
												{#if model.guideBadge}
													<span class="model-guide-badge">
														{badgeLabel(model)}
													</span>
												{/if}
												<span
													class="model-guide-cost"
													title={exactCostLabel(model)}
													aria-label={exactCostLabel(model)}
												>
													{costIndicator(model)}
												</span>
												{#if hasLargeContext(model)}
													<span
														class="model-guide-context"
														title={$t('modelSelector.contextExact', {
															context: formatContext(model.maxModelContext),
														})}
													>
														{$t('modelSelector.largeContext')}
													</span>
												{/if}
											</div>
											{#if modelGuideNote(model)}
												<p class="model-guide-note">{modelGuideNote(model)}</p>
											{/if}
										</div>
									</div>
								</article>
							{/each}
						</div>
					</section>
				{/each}
			{/if}
		</div>
	</div>
</div>

<style>
	.model-guide-backdrop {
		position: fixed;
		inset: 0;
		z-index: 250;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: rgba(0, 0, 0, 0.42);
		backdrop-filter: blur(5px);
	}

	.model-guide-modal {
		display: flex;
		width: min(760px, 100%);
		max-height: min(760px, calc(100vh - 48px));
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
		border-radius: var(--radius-md, 8px);
		background: var(--bg-primary, #fff);
		box-shadow: var(--shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.18));
		color: var(--text-primary, #1a1a1a);
	}

	.model-guide-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
		padding: 18px 20px 14px;
	}

	.model-guide-header h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 650;
	}

	.model-guide-header p {
		margin: 4px 0 0;
		max-width: 56ch;
		color: var(--text-secondary, #6b6b6b);
		font-size: 13px;
		line-height: 1.4;
	}

	.model-guide-close,
	.model-guide-policy {
		display: inline-flex;
		min-height: 32px;
		min-width: 32px;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
		border-radius: var(--radius-sm, 4px);
		background: transparent;
		color: var(--text-secondary, #6b6b6b);
		cursor: pointer;
	}

	.model-guide-close:hover,
	.model-guide-policy:hover {
		background: var(--bg-hover, #eeedea);
		color: var(--text-primary, #1a1a1a);
	}

	.model-guide-close:focus-visible,
	.model-guide-policy:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--border-focus, #c15f3c);
	}

	.model-guide-content {
		overflow-y: auto;
		padding: 14px;
	}

	.model-guide-provider {
		border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
		padding: 10px 0 14px;
	}

	.model-guide-provider:last-child {
		border-bottom: 0;
	}

	.model-guide-provider-header,
	.model-guide-provider-title,
	.model-guide-row-main,
	.model-guide-model-line {
		display: flex;
		align-items: center;
	}

	.model-guide-provider-header {
		justify-content: space-between;
		gap: 10px;
		padding: 0 4px 8px;
	}

	.model-guide-provider-title {
		min-width: 0;
		gap: 8px;
		font-size: 13px;
		font-weight: 650;
	}

	.model-guide-region {
		font-size: 15px;
		line-height: 1;
	}

	.model-guide-rows {
		display: grid;
		gap: 6px;
	}

	.model-guide-row {
		border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
		border-radius: var(--radius-sm, 4px);
		background: var(--surface-page, #fafafa);
		padding: 10px;
	}

	.model-guide-row-main {
		gap: 10px;
		min-width: 0;
	}

	.model-guide-row-text {
		min-width: 0;
		flex: 1;
	}

	.model-guide-model-line {
		flex-wrap: wrap;
		gap: 6px;
	}

	.model-guide-model-name {
		min-width: 0;
		max-width: 260px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 14px;
		font-weight: 600;
	}

	.model-guide-badge,
	.model-guide-cost,
	.model-guide-context {
		display: inline-flex;
		align-items: center;
		border-radius: var(--radius-sm, 4px);
		padding: 2px 6px;
		font-size: 11px;
		font-weight: 600;
		line-height: 1.3;
	}

	.model-guide-badge {
		background: rgba(193, 95, 60, 0.12);
		color: var(--border-focus, #c15f3c);
	}

	.model-guide-cost,
	.model-guide-context {
		background: var(--bg-secondary, #f5f5f5);
		color: var(--text-secondary, #6b6b6b);
	}

	.model-guide-note {
		display: -webkit-box;
		margin: 5px 0 0;
		overflow: hidden;
		color: var(--text-secondary, #6b6b6b);
		font-size: 12px;
		line-height: 1.35;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.model-guide-empty {
		margin: 0;
		padding: 20px;
		color: var(--text-secondary, #6b6b6b);
		font-size: 14px;
		text-align: center;
	}

	:global(.dark) .model-guide-modal {
		border-color: var(--border, rgba(255, 255, 255, 0.08));
		background: var(--bg-primary, #1a1a1a);
		color: var(--text-primary, #ececec);
	}

	:global(.dark) .model-guide-row {
		background: var(--surface-page, #202020);
	}

	:global(.dark) .model-guide-cost,
	:global(.dark) .model-guide-context {
		background: var(--bg-hover, #333);
	}

	@media (max-width: 768px) {
		.model-guide-backdrop {
			align-items: flex-end;
			padding: 0;
		}

		.model-guide-modal {
			width: 100%;
			max-height: 82vh;
			border-radius: var(--radius-md, 8px) var(--radius-md, 8px) 0 0;
		}

		.model-guide-header {
			padding: 16px;
		}

		.model-guide-content {
			padding: 10px;
		}

		.model-guide-model-name {
			max-width: 100%;
		}
	}
</style>
