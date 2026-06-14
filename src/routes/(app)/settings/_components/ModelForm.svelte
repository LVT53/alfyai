<script lang="ts">
import { untrack } from "svelte";
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import { deriveModelContextLimits } from "$lib/model-context-defaults";
import type { ProviderModel, ProviderModelUpdate } from "$lib/client/api/admin";

const tVal = get(t);

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		onClose?.();
	}
}

let {
	providerId,
	model = null,
	saving = false,
	error = "",
	onSave,
	onClose,
	onIconFile,
}: {
	providerId: string;
	model?: ProviderModel | null;
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
let formMaxModelContext = $state(
	untrack(() => numToString(model?.maxModelContext)),
);

let formContextPreview = $derived(
	(() => {
		const maxModelContext = stringToNum(formMaxModelContext);
		return maxModelContext != null && maxModelContext > 0
			? deriveModelContextLimits({ maxModelContext })
			: null;
	})(),
);
let formCompactionPreview = $derived(
	formContextPreview != null
		? String(formContextPreview.compactionUiThreshold)
		: "",
);
let formTargetPreview = $derived(
	formContextPreview != null
		? String(formContextPreview.targetConstructedContext)
		: "",
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
let formCacheHitUsdPer1m = $state(
	untrack(() => microsToDollars(model?.cacheHitUsdMicrosPer1m)),
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
		maxModelContext: maxContext,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: stringToNum(formMaxMessageLength),
		maxTokens: stringToNum(formMaxTokens),
		reasoningEffort: formReasoningEffort || null,
		thinkingType: formThinkingType || null,
		capabilitiesJson: formCapabilitiesJson || null,
		inputUsdMicrosPer1m: dollarsToMicros(formInputUsdPer1m),
		cachedInputUsdMicrosPer1m: dollarsToMicros(formCachedInputUsdPer1m),
		cacheHitUsdMicrosPer1m: dollarsToMicros(formCacheHitUsdPer1m),
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
					<label class="settings-label" for="model-form-display-name">{$t('admin.displayName')}</label>
					<input
						id="model-form-display-name"
						type="text"
						class="settings-input"
						bind:value={formDisplayName}
						placeholder={$t('admin.displayNamePlaceholder')}
					/>
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
							<label class="settings-label" for="model-form-compaction">{$t('admin.compactionUiThreshold')}</label>
							<input
								id="model-form-compaction"
								type="text"
								class="settings-input text-text-muted"
								value={formCompactionPreview}
								disabled
								readonly
							/>
							<p class="mt-1 text-xs text-text-muted">{@html $t('admin.autoCalculatedFromMaxContext')}</p>
						</div>
						<div>
							<label class="settings-label" for="model-form-target">{$t('admin.targetConstructedContext')}</label>
							<input
								id="model-form-target"
								type="text"
								class="settings-input text-text-muted"
								value={formTargetPreview}
								disabled
								readonly
							/>
							<p class="mt-1 text-xs text-text-muted">{@html $t('admin.autoCalculatedFromMaxContext')}</p>
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
							<label class="settings-label" for="model-form-cache-hit">{$t('admin.cacheHitPrice')}</label>
							<input
								id="model-form-cache-hit"
								type="number"
								class="settings-input"
								bind:value={formCacheHitUsdPer1m}
								placeholder="0"
								min="0"
								step="0.000001"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-cache-miss">{$t('admin.cacheMissPrice')}</label>
							<input
								id="model-form-cache-miss"
								type="number"
								class="settings-input"
								bind:value={formCacheMissUsdPer1m}
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
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<div class="flex items-center gap-2">
						<input id="model-form-enabled" type="checkbox" bind:checked={formEnabled} />
						<label class="settings-label mb-0" for="model-form-enabled">{$t('admin.enabled')}</label>
					</div>
				</div>
			</div>

			{#if visibleError}
				<p class="mt-4 text-sm text-danger">{visibleError}</p>
			{/if}

			<div class="mt-4 flex flex-wrap gap-2">
				<button class="btn-primary flex-1" onclick={handleSave} disabled={saving}>
					{saving ? $t('common.saving') : $t('admin.saveChanges')}
				</button>
				<button class="btn-secondary" onclick={onClose}>{$t('common.cancel')}</button>
			</div>
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
		overflow-y: auto;
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
	}
</style>
