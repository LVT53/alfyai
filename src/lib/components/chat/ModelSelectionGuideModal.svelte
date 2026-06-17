<script lang="ts">
import { onMount } from "svelte";
import { ExternalLink, X } from "@lucide/svelte";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import type { ModelProvider, ProviderModel } from "$lib/client/api/models";
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

let backdropRef = $state<HTMLDivElement | undefined>(undefined);

onMount(() => {
	if (backdropRef && backdropRef.parentNode !== document.body) {
		document.body.appendChild(backdropRef);
	}

	return () => {
		backdropRef?.remove();
	};
});

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") onClose?.();
}

function handleBackdropPointer(event: MouseEvent | TouchEvent) {
	event.stopPropagation();
	if (event.target !== event.currentTarget) return;
	onClose?.();
}

function handleModalPointer(event: MouseEvent | TouchEvent) {
	event.stopPropagation();
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
	if (model.guideNoCost) {
		return $t("modelSelector.costExact", {
			input: dollars(0),
			output: dollars(0),
		});
	}
	if (model.inputUsdMicrosPer1m + model.outputUsdMicrosPer1m <= 0) {
		return $t("modelSelector.costUnknownExact");
	}
	return $t("modelSelector.costExact", {
		input: dollars(model.inputUsdMicrosPer1m),
		output: dollars(model.outputUsdMicrosPer1m),
	});
}

function costIndicator(model: ProviderModel): string {
	if (model.guideNoCost) return $t("modelSelector.costNoCost");
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
	if (model.guideBadge === "simple") {
		return $t("modelSelector.badge.simple");
	}
	return "";
}

function estimatedSpeed(model: ProviderModel): number | null {
	const speed = model.estimatedTokensPerSecond ?? 0;
	return speed > 0 ? speed : null;
}

function speedIndicator(model: ProviderModel): string {
	const speed = estimatedSpeed(model);
	if (!speed) return "";
	if (speed >= 500) return $t("modelSelector.speed.ludicrous");
	if (speed >= 100) return $t("modelSelector.speed.fast");
	return $t("modelSelector.speed.normal");
}

function exactSpeedLabel(model: ProviderModel): string {
	const speed = estimatedSpeed(model);
	if (!speed) return "";
	return $t("modelSelector.speedExact", {
		speed: new Intl.NumberFormat($uiLanguage).format(speed),
	});
}

function contextIndicator(model: ProviderModel): string {
	const context = model.maxModelContext ?? 0;
	if (context >= 1_000_000) return $t("modelSelector.massiveContext");
	if (context >= 128_000) return $t("modelSelector.largeContext");
	return "";
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

<div
	bind:this={backdropRef}
	class="model-guide-backdrop"
	role="presentation"
	onclick={handleBackdropPointer}
	onmousedown={handleBackdropPointer}
	ontouchstart={handleBackdropPointer}
>
	<div
		class="model-guide-modal"
		role="dialog"
		aria-modal="true"
		aria-labelledby="model-guide-title"
		tabindex="-1"
		onmousedown={handleModalPointer}
		ontouchstart={handleModalPointer}
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
										data-tooltip={regionTitle(provider)}
									>
										{regionCodeToFlag(provider.processingRegionCode)}
									</span>
								{/if}
							</div>
							{#if provider.privacyPolicyUrl}
								<a
									class="model-guide-icon-button model-guide-policy"
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
												{#if speedIndicator(model)}
													<span
														class="model-guide-pill model-guide-speed"
														data-tooltip={exactSpeedLabel(model)}
														aria-label={exactSpeedLabel(model)}
													>
														{speedIndicator(model)}
													</span>
												{/if}
												<span
													class={`model-guide-pill model-guide-cost${model.guideNoCost ? ' model-guide-cost--no-cost' : ''}`}
													data-tooltip={exactCostLabel(model)}
													aria-label={exactCostLabel(model)}
												>
													{costIndicator(model)}
												</span>
												{#if contextIndicator(model)}
													<span
														class="model-guide-pill model-guide-context"
														data-tooltip={$t('modelSelector.contextExact', {
															context: formatContext(model.maxModelContext),
														})}
														aria-label={$t('modelSelector.contextExact', {
															context: formatContext(model.maxModelContext),
														})}
													>
														{contextIndicator(model)}
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
		width: min(980px, 100%);
		max-height: min(780px, calc(100vh - 48px));
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md, 8px);
		background: var(--surface-page);
		box-shadow: var(--shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.18));
		color: var(--text-primary);
	}

	.model-guide-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		border-bottom: 1px solid var(--border-default);
		padding: 18px 20px 14px;
	}

	.model-guide-header h2 {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 650;
	}

	.model-guide-header p {
		margin: 4px 0 0;
		max-width: 56ch;
		color: var(--text-muted);
		font-size: var(--text-sm);
		line-height: 1.4;
	}

	.model-guide-close,
	.model-guide-icon-button {
		display: inline-flex;
		position: relative;
		min-height: 32px;
		min-width: 32px;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm, 4px);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		text-decoration: none;
		transition:
			border-color 140ms ease,
			background-color 140ms ease,
			color 140ms ease,
			transform 140ms ease,
			box-shadow 140ms ease;
	}

	.model-guide-close:hover,
	.model-guide-close:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 42%, transparent);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent);
		transform: translateY(-1px);
	}

	.model-guide-icon-button:visited {
		color: var(--text-muted);
	}

	.model-guide-icon-button:hover,
	.model-guide-icon-button:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 36%, transparent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: var(--accent);
		transform: translateY(-1px);
	}

	.model-guide-close:focus-visible,
	.model-guide-icon-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--accent);
	}

	.model-guide-content {
		overflow-y: auto;
		padding: 14px;
	}

	.model-guide-provider {
		border-bottom: 1px solid var(--border-default);
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
		font-size: var(--text-sm);
		font-weight: 650;
	}

	.model-guide-region {
		display: inline-flex;
		position: relative;
		align-items: center;
		font-size: var(--text-base);
		line-height: 1;
	}

	.model-guide-rows {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 8px;
	}

	.model-guide-row {
		position: relative;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm, 4px);
		background: var(--surface-page);
		padding: 10px;
		overflow: visible;
	}

	.model-guide-row-main {
		align-items: flex-start;
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
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.model-guide-badge,
	.model-guide-pill {
		display: inline-flex;
		position: relative;
		align-items: center;
		border-radius: var(--radius-sm, 4px);
		padding: 2px 6px;
		font-size: var(--text-2xs);
		font-weight: 600;
		line-height: 1.3;
	}

	.model-guide-badge {
		background: rgba(193, 95, 60, 0.12);
		color: var(--accent);
	}

	.model-guide-pill {
		background: var(--surface-overlay);
		color: var(--text-muted);
	}

	.model-guide-cost--no-cost {
		border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
		background: color-mix(in srgb, var(--success) 14%, var(--surface-page));
		color: var(--success);
	}

	.model-guide-speed {
		border: 1px solid color-mix(in srgb, var(--info) 24%, transparent);
		background: color-mix(in srgb, var(--info) 10%, var(--surface-page));
		color: var(--info);
	}

	.model-guide-pill[data-tooltip]::after,
	.model-guide-region[data-tooltip]::after {
		position: absolute;
		z-index: 4;
		bottom: calc(100% + 6px);
		left: 50%;
		width: max-content;
		max-width: min(280px, 72vw);
		padding: 6px 8px;
		border-radius: var(--radius-sm, 4px);
		background: var(--text-primary);
		color: var(--surface-page);
		box-shadow: var(--shadow-md, 0 6px 18px rgba(0, 0, 0, 0.18));
		content: attr(data-tooltip);
		font-size: var(--text-2xs);
		font-weight: 500;
		line-height: 1.35;
		opacity: 0;
		pointer-events: none;
		text-align: center;
		transform: translate(-50%, 4px);
		transition:
			opacity 120ms ease-out,
			transform 120ms ease-out;
		white-space: normal;
	}

	.model-guide-region[data-tooltip]::after {
		max-width: 220px;
		white-space: nowrap;
	}

	.model-guide-pill[data-tooltip]:hover::after,
	.model-guide-region[data-tooltip]:hover::after {
		opacity: 1;
		transform: translate(-50%, 0);
	}

	.model-guide-note {
		display: -webkit-box;
		margin: 5px 0 0;
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--text-2xs);
		line-height: 1.35;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.model-guide-empty {
		margin: 0;
		padding: 20px;
		color: var(--text-muted);
		font-size: var(--text-sm);
		text-align: center;
	}

	:global(.dark) .model-guide-modal {
		border-color: var(--border-default);
		background: var(--surface-page);
		color: var(--text-primary);
	}

	:global(.dark) .model-guide-row {
		background: var(--surface-page, #202020);
	}

	:global(.dark) .model-guide-pill {
		background: var(--surface-elevated);
	}

	:global(.dark) .model-guide-speed {
		border-color: color-mix(in srgb, var(--info) 28%, transparent);
		background: color-mix(in srgb, var(--info) 14%, var(--surface-page));
		color: var(--info);
	}

	:global(.dark) .model-guide-cost--no-cost {
		border-color: color-mix(in srgb, var(--success) 34%, transparent);
		background: color-mix(in srgb, var(--success) 16%, var(--surface-page));
		color: var(--success);
	}

	:global(.dark) .model-guide-pill[data-tooltip]::after,
	:global(.dark) .model-guide-region[data-tooltip]::after {
		background: var(--surface-page);
		color: var(--text-primary);
		border: 1px solid var(--border-default);
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

		.model-guide-rows {
			grid-template-columns: 1fr;
		}

		.model-guide-model-name {
			max-width: 100%;
		}
	}
</style>
