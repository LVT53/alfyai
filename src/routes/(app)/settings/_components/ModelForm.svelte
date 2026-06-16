<script lang="ts">
import { untrack } from "svelte";
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import type {
	Provider,
	ProviderModel,
	ProviderModelUpdate,
} from "$lib/client/api/admin";
import {
	getProviderModelFallbackOptions,
	type FallbackCompatibilityReason,
} from "./model-fallback";

const tVal = get(t);

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		onClose?.();
	}
}

let {
	providerId,
	model = null,
	allModels = [],
	allProviders = [],
	saving = false,
	error = "",
	onSave,
	onClose,
	onIconFile,
}: {
	providerId: string;
	model?: ProviderModel | null;
	allModels?: ProviderModel[];
	allProviders?: Provider[];
	saving?: boolean;
	error?: string;
	onSave?: (data: ProviderModelUpdate) => void | Promise<void>;
	onClose?: () => void;
	onIconFile?: (event: Event) => void;
} = $props();

let isCreate = $derived(model === null);

let formName = $state(untrack(() => (isCreate ? "" : (model?.name ?? ""))));
let formDisplayName = $state(untrack(() => model?.displayName ?? ""));
let formIconAssetId = $state(untrack(() => model?.iconAssetId ?? null));
$effect(() => {
	formIconAssetId = model?.iconAssetId ?? null;
});
let formGuideNoteEn = $state(untrack(() => model?.guideNoteEn ?? ""));
$effect(() => {
	formGuideNoteEn = model?.guideNoteEn ?? "";
});
let formGuideNoteHu = $state(untrack(() => model?.guideNoteHu ?? ""));
$effect(() => {
	formGuideNoteHu = model?.guideNoteHu ?? "";
});
let formGuideBadge = $state(untrack(() => model?.guideBadge ?? ""));
$effect(() => {
	formGuideBadge = model?.guideBadge ?? "";
});
let formGuideNoCost = $state(untrack(() => model?.guideNoCost ?? false));
$effect(() => {
	formGuideNoCost = model?.guideNoCost ?? false;
});
let formEstimatedTokensPerSecond = $state(
	untrack(() => numToString(model?.estimatedTokensPerSecond)),
);
$effect(() => {
	formEstimatedTokensPerSecond = numToString(model?.estimatedTokensPerSecond);
});
let formFallbackProviderModelId = $state(
	untrack(() => model?.fallbackProviderModelId ?? ""),
);
$effect(() => {
	formFallbackProviderModelId = model?.fallbackProviderModelId ?? "";
});
let formMaxModelContext = $state(
	untrack(() => numToString(model?.maxModelContext)),
);
let formMaxMessageLength = $state(
	untrack(() => numToString(model?.maxMessageLength)),
);
let formMaxTokens = $state(untrack(() => numToString(model?.maxTokens)));
let formReasoningEffort = $state(untrack(() => model?.reasoningEffort ?? ""));
let formThinkingType = $state(untrack(() => model?.thinkingType ?? ""));
let formCapabilitiesJson = $state(
	untrack(() => model?.capabilitiesJson ?? "{}"),
);
let formInputUsdPer1m = $state(
	untrack(() => microsToDollars(model?.inputUsdMicrosPer1m)),
);
let formCachedInputUsdPer1m = $state(
	untrack(() => microsToDollars(model?.cachedInputUsdMicrosPer1m)),
);
let formCacheMissUsdPer1m = $state(
	untrack(() => microsToDollars(model?.cacheMissUsdMicrosPer1m)),
);
let formOutputUsdPer1m = $state(
	untrack(() => microsToDollars(model?.outputUsdMicrosPer1m)),
);
let formEnabled = $state(untrack(() => model?.enabled ?? true));
let localError = $state("");

let visibleError = $derived(error || localError);

function numToString(value: number | null | undefined): string {
	if (value === null || value === undefined) return "";
	return String(value);
}

function stringToNum(value: string | number | null | undefined): number | null {
	if (value == null) return null;
	if (typeof value === "number") return Number.isNaN(value) ? null : value;
	const trimmed = String(value).trim();
	if (trimmed === "") return null;
	const num = Number(trimmed);
	if (Number.isNaN(num)) return null;
	return num;
}

function microsToDollars(micros: number | null | undefined): string {
	if (micros == null) return "";
	return (micros / 1_000_000).toString();
}

function dollarsToMicros(dollars: string | number | null | undefined): number {
	const num = stringToNum(dollars);
	if (num == null) return 0;
	return Math.round(num * 1_000_000);
}

function fallbackReasonLabel(reason: FallbackCompatibilityReason): string {
	if (reason.kind === "disabled-target") {
		return $t("admin.modelFallbackReasonDisabledTarget");
	}

	if (reason.kind === "capability") {
		const key =
			reason.role === "source"
				? "admin.modelFallbackReasonCapabilitySource"
				: "admin.modelFallbackReasonCapabilityFallback";
		return $t(key, {
			capability: $t(`admin.capability.${reason.capability}`),
		});
	}

	if (reason.kind === "unknown-source-capability") {
		return $t("admin.modelFallbackReasonUnknownSourceCapability", {
			capability: $t(`admin.capability.${reason.capability}`),
		});
	}

	return $t("admin.modelFallbackReasonGeneric");
}

function fallbackOptions() {
	if (isCreate || !model) return [];
	return getProviderModelFallbackOptions(model, allModels);
}

function providerDisplayName(providerModel: ProviderModel): string {
	return (
		allProviders.find((provider) => provider.id === providerModel.providerId)
			?.displayName ?? providerModel.providerId
	);
}

function fallbackOptionLabel(providerModel: ProviderModel): string {
	return `${providerDisplayName(providerModel)} - ${providerModel.displayName || providerModel.name}`;
}

function hasCompatibleFallbackOption(): boolean {
	return fallbackOptions().some((option) => option.compatible);
}

function handleSave() {
	localError = "";

	if (isCreate && !formName.trim()) {
		localError = $t("admin.fillRequiredFields");
		return;
	}

	if (!formDisplayName.trim()) {
		localError = $t("admin.fillRequiredBuiltIn");
		return;
	}

	const maxContext = stringToNum(formMaxModelContext);

	const data: ProviderModelUpdate & { name?: string } = {
		displayName: formDisplayName.trim(),
		iconAssetId: formIconAssetId || null,
		guideNoteEn: formGuideNoteEn.trim() || null,
		guideNoteHu: formGuideNoteHu.trim() || null,
		guideBadge:
			formGuideBadge === "intelligent" || formGuideBadge === "simple"
				? formGuideBadge
				: null,
		guideNoCost: formGuideNoCost,
		estimatedTokensPerSecond: stringToNum(formEstimatedTokensPerSecond),
		maxModelContext: maxContext,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: stringToNum(formMaxMessageLength),
		maxTokens: stringToNum(formMaxTokens),
		reasoningEffort: formReasoningEffort || null,
		thinkingType: formThinkingType || null,
		fallbackProviderModelId:
			isCreate || !model ? undefined : formFallbackProviderModelId || null,
		capabilitiesJson: formCapabilitiesJson || null,
		inputUsdMicrosPer1m: dollarsToMicros(formInputUsdPer1m),
		cachedInputUsdMicrosPer1m: dollarsToMicros(formCachedInputUsdPer1m),
		cacheHitUsdMicrosPer1m: dollarsToMicros(formCachedInputUsdPer1m),
		cacheMissUsdMicrosPer1m: dollarsToMicros(formCacheMissUsdPer1m),
		outputUsdMicrosPer1m: dollarsToMicros(formOutputUsdPer1m),
		enabled: formEnabled,
	};

	if (isCreate) {
		data.name = formName.trim();
	}

	onSave?.(data);
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-overlay" role="dialog" aria-modal="true" aria-label={isCreate ? $t('admin.addModel') : $t('admin.editModel')}>
	<div class="modal-card">
		<div class="modal-header">
			<h2 class="modal-title">{isCreate ? $t('admin.addModel') : $t('admin.editModel')}</h2>
			<button class="modal-close" onclick={onClose} aria-label={$t('common.close')}>&times;</button>
		</div>
		<div class="modal-body">
			<div class="flex flex-col gap-3">
				<div>
					<label class="settings-label" for="model-form-name">{$t('admin.modelName')}</label>
					<input
						id="model-form-name"
						type="text"
						class="settings-input"
						bind:value={formName}
						placeholder={$t('admin.modelNamePlaceholderProvider')}
						disabled={!isCreate}
					/>
					{#if isCreate}
						<p class="mt-1 text-xs text-text-muted">{$t('admin.nameIdDescription')}</p>
					{/if}
				</div>

				<div>
					<div class="flex items-end gap-3">
						<div class="min-w-0 flex-1">
							<label class="settings-label" for="model-form-display-name">{$t('admin.displayName')}</label>
							<input
								id="model-form-display-name"
								type="text"
								class="settings-input"
								bind:value={formDisplayName}
								placeholder={$t('admin.displayNamePlaceholder')}
							/>
						</div>
						<label
							class="relative mb-2 inline-flex cursor-pointer items-center"
							title={formEnabled ? $t('admin.enabled') : $t('admin.disabled')}
							aria-label={formEnabled ? $t('admin.enabled') : $t('admin.disabled')}
						>
							<input
								id="model-form-enabled"
								type="checkbox"
								class="peer sr-only"
								bind:checked={formEnabled}
							/>
							<div
								class="peer h-5 w-9 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"
							></div>
						</label>
					</div>
				</div>

				<div>
					<label class="settings-label" for="model-form-icon">{$t('admin.modelIcon')}</label>
					<div class="flex items-center gap-3">
						{#if formIconAssetId}
							<img
								src={`/api/campaign-assets/${encodeURIComponent(formIconAssetId)}/content`}
								alt=""
								class="h-10 w-10 rounded object-cover"
							/>
						{/if}
						{#if onIconFile}
							<input
								id="model-form-icon"
								type="file"
								accept="image/*"
								class="settings-input"
								onchange={onIconFile}
							/>
						{/if}
					</div>
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.modelGuide')}</h3>
					<p class="text-xs text-text-muted">{$t('admin.modelGuideDescription')}</p>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-guide-badge">{$t('admin.modelGuideBadge')}</label>
							<select
								id="model-form-guide-badge"
								class="settings-input"
								bind:value={formGuideBadge}
							>
								<option value="">{$t('admin.none')}</option>
								<option value="intelligent">{$t('modelSelector.badge.intelligent')}</option>
								<option value="simple">{$t('modelSelector.badge.simple')}</option>
							</select>
						</div>
						<div>
							<label class="settings-label" for="model-form-estimated-speed">{$t('admin.modelEstimatedSpeed')}</label>
							<input
								id="model-form-estimated-speed"
								type="number"
								class="settings-input"
								bind:value={formEstimatedTokensPerSecond}
								placeholder={$t('admin.modelEstimatedSpeedPlaceholder')}
								min="0"
								step="1"
							/>
							<p class="mt-1 text-xs text-text-muted">{$t('admin.modelEstimatedSpeedDescription')}</p>
						</div>
						<label class="flex items-center gap-3 rounded border border-border px-3 py-2 text-sm text-text-primary">
							<input
								id="model-form-guide-no-cost"
								type="checkbox"
								bind:checked={formGuideNoCost}
							/>
							<span>
								<span class="block font-medium">{$t('admin.modelGuideNoCost')}</span>
								<span class="block text-xs text-text-muted">{$t('admin.modelGuideNoCostDescription')}</span>
							</span>
						</label>
						<div>
							<label class="settings-label" for="model-form-guide-note-en">{$t('admin.modelGuideNoteEn')}</label>
							<textarea
								id="model-form-guide-note-en"
								class="settings-input min-h-20"
								bind:value={formGuideNoteEn}
								maxlength="180"
								placeholder={$t('admin.modelGuideNotePlaceholder')}
							></textarea>
						</div>
						<div class="md:col-span-2">
							<label class="settings-label" for="model-form-guide-note-hu">{$t('admin.modelGuideNoteHu')}</label>
							<textarea
								id="model-form-guide-note-hu"
								class="settings-input min-h-20"
								bind:value={formGuideNoteHu}
								maxlength="180"
								placeholder={$t('admin.modelGuideNotePlaceholder')}
							></textarea>
						</div>
					</div>
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.contextLimits')}</h3>
					<p class="text-xs text-text-muted">{$t('admin.contextLimitsDescription')}</p>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-max-context">{$t('admin.maxModelContextLabel')}</label>
							<input
								id="model-form-max-context"
								type="number"
								class="settings-input"
								bind:value={formMaxModelContext}
								placeholder={$t('admin.maxModelContextRequired')}
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-max-msg">{$t('admin.maxMessageLengthLabel')}</label>
							<input
								id="model-form-max-msg"
								type="number"
								class="settings-input"
								bind:value={formMaxMessageLength}
								placeholder=""
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-max-tokens">{$t('admin.maxTokens')}</label>
							<input
								id="model-form-max-tokens"
								type="number"
								class="settings-input"
								bind:value={formMaxTokens}
								placeholder={$t('admin.maxTokensPlaceholder')}
								min="0"
							/>
						</div>
					</div>
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.reasoningEffort')}</h3>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-reasoning">{$t('admin.reasoningEffort')}</label>
							<select
								id="model-form-reasoning"
								class="settings-input"
								bind:value={formReasoningEffort}
							>
								<option value="">{$t('admin.none')}</option>
								<option value="low">{$t('admin.low')}</option>
								<option value="medium">{$t('admin.medium')}</option>
								<option value="high">{$t('admin.high')}</option>
								<option value="max">{$t('admin.max')}</option>
								<option value="xhigh">{$t('admin.xHigh')}</option>
							</select>
						</div>
						<div>
							<label class="settings-label" for="model-form-thinking">{$t('admin.thinkingType')}</label>
							<select
								id="model-form-thinking"
								class="settings-input"
								bind:value={formThinkingType}
							>
								<option value="">{$t('admin.none')}</option>
								<option value="enabled">{$t('admin.enabled')}</option>
								<option value="disabled">{$t('admin.disabled')}</option>
							</select>
						</div>
					</div>
				</div>

				{#if !isCreate}
					<div class="mt-2 border-t border-border pt-3">
						<label class="settings-label" for="model-form-fallback">{$t('admin.modelFallbackLabel')}</label>
						<select
							id="model-form-fallback"
							class="settings-input"
							bind:value={formFallbackProviderModelId}
						>
							<option value="">{ $t('admin.modelFallbackNone') }</option>
							{#each fallbackOptions() as fallbackOption (fallbackOption.model.id)}
								<option
									value={fallbackOption.model.id}
									disabled={!fallbackOption.compatible}
								>
									{fallbackOptionLabel(fallbackOption.model)}
									{#if !fallbackOption.compatible}
										{" — "}
										{fallbackReasonLabel(
											fallbackOption.reason ?? {
												kind: "unparsed",
												message: $t("admin.modelFallbackReasonGeneric"),
											},
										)}
									{/if}
								</option>
							{/each}
						</select>
						{#if !hasCompatibleFallbackOption()}
							<p class="mt-1 text-xs text-danger">
								{$t('admin.modelFallbackNoCompatibleOptions')}
							</p>
						{/if}
					</div>
				{/if}

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.pricing')}</h3>
					<p class="text-xs text-text-muted">{$t('admin.pricingPer1m')}</p>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-input-price">{$t('admin.inputPrice')}</label>
							<input
								id="model-form-input-price"
								type="number"
								class="settings-input"
								bind:value={formInputUsdPer1m}
								placeholder="0"
								min="0"
								step="0.000001"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-cached-input">{$t('admin.cachedInputPrice')}</label>
							<input
								id="model-form-cached-input"
								type="number"
								class="settings-input"
								bind:value={formCachedInputUsdPer1m}
								placeholder="0"
								min="0"
								step="0.000001"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-output-price">{$t('admin.outputPrice')}</label>
							<input
								id="model-form-output-price"
								type="number"
								class="settings-input"
								bind:value={formOutputUsdPer1m}
								placeholder="0"
								min="0"
								step="0.000001"
							/>
						</div>
					</div>
					<details class="mt-3 rounded-md border border-border bg-surface-page px-3 py-2">
						<summary class="cursor-pointer text-xs font-medium text-text-secondary">
							{$t('admin.advancedCachePricing')}
						</summary>
						<p class="mt-2 text-xs text-text-muted">
							{$t('admin.advancedCachePricingDescription')}
						</p>
						<div class="mt-3">
							<label class="settings-label" for="model-form-cache-miss">{$t('admin.cacheWriteMissPrice')}</label>
							<input
								id="model-form-cache-miss"
								type="number"
								class="settings-input"
								bind:value={formCacheMissUsdPer1m}
								placeholder={$t('admin.cacheWriteMissPlaceholder')}
								min="0"
								step="0.000001"
							/>
						</div>
					</details>
				</div>

			</div>
		</div>
		<div class="modal-footer">
			{#if visibleError}
				<p class="text-sm text-danger">{visibleError}</p>
			{/if}
			<button class="btn-primary flex-1" onclick={handleSave} disabled={saving}>
				{saving ? $t('common.saving') : $t('admin.saveChanges')}
			</button>
			<button class="btn-secondary" onclick={onClose}>{$t('common.cancel')}</button>
		</div>
	</div>
</div>

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.45);
		backdrop-filter: blur(4px);
	}
	.modal-card {
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		width: min(36rem, calc(100vw - 2rem));
		max-height: calc(100vh - 4rem);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border-default);
	}
	.modal-title {
		font-size: 1.1rem;
		font-weight: 600;
	}
	.modal-close {
		font-size: 1.5rem;
		line-height: 1;
		padding: 0.25rem;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-muted);
	}
	.modal-body {
		padding: 1.25rem;
		overflow-y: auto;
	}
	.modal-footer {
		position: sticky;
		bottom: 0;
		z-index: 1;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		flex-shrink: 0;
		align-items: center;
		padding: 1rem 1.25rem;
		border-top: 1px solid var(--border-default);
		background: var(--surface-overlay);
	}
</style>
