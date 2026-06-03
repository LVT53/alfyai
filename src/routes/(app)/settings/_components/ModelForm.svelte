<script lang="ts">
import { untrack } from "svelte";
import { get } from "svelte/store";
import { t } from "$lib/i18n";
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
}: {
	providerId: string;
	model?: ProviderModel | null;
	saving?: boolean;
	error?: string;
	onSave?: (data: ProviderModelUpdate) => void | Promise<void>;
	onClose?: () => void;
} = $props();

const isCreate = model === null;

let formName = $state(untrack(() => (isCreate ? "" : (model?.name ?? ""))));
let formDisplayName = $state(untrack(() => model?.displayName ?? ""));
let formMaxModelContext = $state(
	untrack(() => numToString(model?.maxModelContext)),
);
let formCompactionUiThreshold = $state(
	untrack(() => numToString(model?.compactionUiThreshold)),
);
let formTargetConstructedContext = $state(
	untrack(() => numToString(model?.targetConstructedContext)),
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
let formInputUsdMicrosPer1m = $state(
	untrack(() => numToString(model?.inputUsdMicrosPer1m ?? 0)),
);
let formCachedInputUsdMicrosPer1m = $state(
	untrack(() => numToString(model?.cachedInputUsdMicrosPer1m ?? 0)),
);
let formCacheHitUsdMicrosPer1m = $state(
	untrack(() => numToString(model?.cacheHitUsdMicrosPer1m ?? 0)),
);
let formCacheMissUsdMicrosPer1m = $state(
	untrack(() => numToString(model?.cacheMissUsdMicrosPer1m ?? 0)),
);
let formOutputUsdMicrosPer1m = $state(
	untrack(() => numToString(model?.outputUsdMicrosPer1m ?? 0)),
);
let formEnabled = $state(untrack(() => model?.enabled ?? true));
let localError = $state("");

let visibleError = $derived(error || localError);

function numToString(value: number | null | undefined): string {
	if (value === null || value === undefined) return "";
	return String(value);
}

function stringToNum(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const num = Number(trimmed);
	if (Number.isNaN(num)) return null;
	return num;
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

	const data: ProviderModelUpdate = {
		displayName: formDisplayName.trim(),
		maxModelContext: stringToNum(formMaxModelContext),
		compactionUiThreshold: stringToNum(formCompactionUiThreshold),
		targetConstructedContext: stringToNum(formTargetConstructedContext),
		maxMessageLength: stringToNum(formMaxMessageLength),
		maxTokens: stringToNum(formMaxTokens),
		reasoningEffort: formReasoningEffort || null,
		thinkingType: formThinkingType || null,
		capabilitiesJson: formCapabilitiesJson || null,
		inputUsdMicrosPer1m: stringToNum(formInputUsdMicrosPer1m) ?? 0,
		cachedInputUsdMicrosPer1m: stringToNum(formCachedInputUsdMicrosPer1m) ?? 0,
		cacheHitUsdMicrosPer1m: stringToNum(formCacheHitUsdMicrosPer1m) ?? 0,
		cacheMissUsdMicrosPer1m: stringToNum(formCacheMissUsdMicrosPer1m) ?? 0,
		outputUsdMicrosPer1m: stringToNum(formOutputUsdMicrosPer1m) ?? 0,
		enabled: formEnabled,
	};

	if (isCreate) {
		(data as Record<string, unknown>).name = formName.trim();
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
								type="number"
								class="settings-input"
								bind:value={formCompactionUiThreshold}
								placeholder=""
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-target">{$t('admin.targetConstructedContext')}</label>
							<input
								id="model-form-target"
								type="number"
								class="settings-input"
								bind:value={formTargetConstructedContext}
								placeholder=""
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

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.pricing')}</h3>
					<p class="text-xs text-text-muted">{$t('admin.pricingMicroDollars')}</p>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-input-price">{$t('admin.inputPrice')}</label>
							<input
								id="model-form-input-price"
								type="number"
								class="settings-input"
								bind:value={formInputUsdMicrosPer1m}
								placeholder="0"
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-cached-input">{$t('admin.cachedInputPrice')}</label>
							<input
								id="model-form-cached-input"
								type="number"
								class="settings-input"
								bind:value={formCachedInputUsdMicrosPer1m}
								placeholder="0"
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-cache-hit">{$t('admin.cacheHitPrice')}</label>
							<input
								id="model-form-cache-hit"
								type="number"
								class="settings-input"
								bind:value={formCacheHitUsdMicrosPer1m}
								placeholder="0"
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-cache-miss">{$t('admin.cacheMissPrice')}</label>
							<input
								id="model-form-cache-miss"
								type="number"
								class="settings-input"
								bind:value={formCacheMissUsdMicrosPer1m}
								placeholder="0"
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-output-price">{$t('admin.outputPrice')}</label>
							<input
								id="model-form-output-price"
								type="number"
								class="settings-input"
								bind:value={formOutputUsdMicrosPer1m}
								placeholder="0"
								min="0"
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
