<script lang="ts">
import { untrack } from "svelte";
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import type { Provider, ProviderModel } from "$lib/client/api/admin";
import { fetchProviderModels } from "$lib/client/api/admin";

const tVal = get(t);

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		onClose?.();
	}
}

let {
	provider = null,
	isCreate = false,
	saving = false,
	testing = false,
	error = "",
	testError = "",
	testMessage = "",
	onSave,
	onClose,
	onTest,
	onIconFile,
	allProviders = [],
}: {
	provider?: Provider | null;
	isCreate?: boolean;
	saving?: boolean;
	testing?: boolean;
	error?: string;
	testError?: string;
	testMessage?: string;
	onSave?: (data: Record<string, unknown>) => void | Promise<void>;
	onClose?: () => void;
	onTest?: (data: Record<string, unknown>) => void | Promise<void>;
	onIconFile?: (event: Event) => void;
	allProviders?: Provider[];
} = $props();

let formName = $state(untrack(() => (isCreate ? "" : (provider?.name ?? ""))));
let formDisplayName = $state(untrack(() => provider?.displayName ?? ""));
let formBaseUrl = $state(
	untrack(() => provider?.baseUrl ?? "https://api.fireworks.ai/inference/v1"),
);
let formApiKey = $state("");
let formIconAssetId = $state(untrack(() => provider?.iconAssetId ?? ""));
$effect(() => {
	formIconAssetId = provider?.iconAssetId ?? "";
});
let formProcessingRegionCode = $state(
	untrack(() => provider?.processingRegionCode ?? ""),
);
$effect(() => {
	formProcessingRegionCode = provider?.processingRegionCode ?? "";
});
let formPrivacyPolicyUrl = $state(
	untrack(() => provider?.privacyPolicyUrl ?? ""),
);
$effect(() => {
	formPrivacyPolicyUrl = provider?.privacyPolicyUrl ?? "";
});
let formEnabled = $state(untrack(() => provider?.enabled ?? true));
let formRateLimitFallbackEnabled = $state(
	untrack(() => provider?.rateLimitFallbackEnabled ?? false),
);
let formRateLimitFallbackBaseUrl = $state(
	untrack(() => provider?.rateLimitFallbackBaseUrl ?? ""),
);
let formRateLimitFallbackApiKey = $state("");
let formRateLimitFallbackModelName = $state(
	untrack(() => provider?.rateLimitFallbackModelName ?? ""),
);
let formRateLimitFallbackTimeoutMs = $state(
	untrack(() =>
		provider?.rateLimitFallbackTimeoutMs
			? String(provider.rateLimitFallbackTimeoutMs)
			: "",
	),
);
let fallbackProviderModels = $state<ProviderModel[]>([]);
let showApiKey = $state(false);
let showFallbackApiKey = $state(false);
let showFallbackSection = $state(false);
let localError = $state("");

let visibleError = $derived(error || localError);

function handleSave() {
	localError = "";
	if (isCreate) {
		if (!formName || !formDisplayName || !formBaseUrl || !formApiKey) {
			localError = $t("admin.fillRequiredFields");
			return;
		}
	} else {
		if (!formDisplayName || !formBaseUrl) {
			localError = $t("admin.fillRequiredBuiltIn");
			return;
		}
	}

	const rateLimitFallbackTimeoutMs = formRateLimitFallbackTimeoutMs
		? Number(formRateLimitFallbackTimeoutMs)
		: null;

	if (formRateLimitFallbackEnabled) {
		if (
			!formRateLimitFallbackBaseUrl ||
			!formRateLimitFallbackModelName ||
			!formRateLimitFallbackTimeoutMs
		) {
			localError = $t("admin.fillRequiredRateLimitFallback");
			return;
		}
		if (
			!Number.isInteger(rateLimitFallbackTimeoutMs) ||
			(rateLimitFallbackTimeoutMs ?? 0) < 1000
		) {
			localError = $t("admin.invalidRateLimitFallbackTimeout");
			return;
		}
	}

	const data: Record<string, unknown> = {
		displayName: formDisplayName,
		baseUrl: formBaseUrl,
		iconAssetId: formIconAssetId || null,
		processingRegionCode: formProcessingRegionCode || null,
		privacyPolicyUrl: formPrivacyPolicyUrl || null,
		enabled: formEnabled,
		rateLimitFallbackEnabled: formRateLimitFallbackEnabled,
		rateLimitFallbackBaseUrl: formRateLimitFallbackBaseUrl || null,
		rateLimitFallbackModelName: formRateLimitFallbackModelName || null,
		rateLimitFallbackTimeoutMs: rateLimitFallbackTimeoutMs,
	};

	if (isCreate) {
		data.name = formName;
		data.apiKey = formApiKey;
	} else {
		if (formApiKey) data.apiKey = formApiKey;
	}

	if (formRateLimitFallbackEnabled) {
		if (formRateLimitFallbackApiKey)
			data.rateLimitFallbackApiKey = formRateLimitFallbackApiKey;
	}

	onSave?.(data);
}

function handleTest() {
	localError = "";
	const data: Record<string, unknown> = {
		baseUrl: formBaseUrl,
	};
	if (formApiKey) data.apiKey = formApiKey;
	onTest?.(data);
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-overlay" role="dialog" aria-modal="true" aria-label={isCreate ? $t('admin.addProvider') : $t('admin.editProvider')}>
	<div class="modal-card">
		<div class="modal-header">
			<h2 class="modal-title">{isCreate ? $t('admin.addProvider') : $t('admin.editProvider')}</h2>
			<button class="modal-close" onclick={onClose} aria-label={$t('common.close')}>&times;</button>
		</div>
		<div class="modal-body">
			<div class="flex flex-col gap-3">
				<div>
					<label class="settings-label" for="provider-form-name">{$t('admin.nameId')}</label>
					<input
						id="provider-form-name"
						type="text"
						class="settings-input"
						bind:value={formName}
						placeholder={$t('admin.nameIdPlaceholder')}
						disabled={!isCreate}
					/>
					{#if isCreate}
						<p class="mt-1 text-xs text-text-muted">{$t('admin.nameIdDescription')}</p>
					{/if}
				</div>

				<div>
					<label class="settings-label" for="provider-form-display-name">{$t('admin.displayName')}</label>
					<input
						id="provider-form-display-name"
						type="text"
						class="settings-input"
						bind:value={formDisplayName}
						placeholder={$t('admin.displayNamePlaceholder')}
					/>
				</div>

				<div>
					<label class="settings-label" for="provider-form-base-url">{$t('admin.baseUrl')}</label>
					<input
						id="provider-form-base-url"
						type="url"
						class="settings-input"
						bind:value={formBaseUrl}
						placeholder={$t('admin.baseUrlPlaceholder')}
					/>
				</div>

				<div>
					<label class="settings-label" for="provider-form-api-key">{$t('admin.apiKey')}</label>
					<div class="flex items-center gap-2">
						<input
							id="provider-form-api-key"
							type={showApiKey ? 'text' : 'password'}
							class="settings-input flex-1"
							bind:value={formApiKey}
							placeholder={provider && !isCreate ? $t('admin.unchanged') : $t('admin.apiKeyPlaceholder')}
						/>
						<button type="button" class="btn-secondary" onclick={() => (showApiKey = !showApiKey)}>
							{showApiKey ? $t('admin.hide') : $t('admin.show')}
						</button>
					</div>
				</div>

				<div>
					<label class="settings-label" for="provider-form-icon">{$t('admin.modelIcon')}</label>
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
								id="provider-form-icon"
								type="file"
								accept="image/*"
								class="settings-input"
								onchange={onIconFile}
							/>
						{/if}
					</div>
				</div>

				<div class="grid gap-3 md:grid-cols-2">
					<div>
						<label class="settings-label" for="provider-form-processing-region">
							{$t('admin.providerProcessingRegion')}
						</label>
						<input
							id="provider-form-processing-region"
							type="text"
							class="settings-input uppercase"
							bind:value={formProcessingRegionCode}
							placeholder={$t('admin.providerProcessingRegionPlaceholder')}
							maxlength="2"
						/>
						<p class="mt-1 text-xs text-text-muted">{$t('admin.providerProcessingRegionDescription')}</p>
					</div>

					<div>
						<label class="settings-label" for="provider-form-privacy-policy">
							{$t('admin.providerPrivacyPolicy')}
						</label>
						<input
							id="provider-form-privacy-policy"
							type="url"
							class="settings-input"
							bind:value={formPrivacyPolicyUrl}
							placeholder={$t('admin.providerPrivacyPolicyPlaceholder')}
						/>
						<p class="mt-1 text-xs text-text-muted">{$t('admin.providerPrivacyPolicyDescription')}</p>
					</div>
				</div>

				<div class="flex items-center gap-2">
					<input id="provider-form-enabled" type="checkbox" bind:checked={formEnabled} />
					<label class="settings-label mb-0" for="provider-form-enabled">{$t('admin.enabled')}</label>
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<button
						type="button"
						class="flex w-full items-center justify-between text-sm font-medium text-text-primary"
						onclick={() => (showFallbackSection = !showFallbackSection)}
					>
						<span>{$t('admin.rateLimitFallback')}</span>
						<span class="text-text-muted">{showFallbackSection ? '▾' : '▸'}</span>
					</button>

					{#if showFallbackSection}
						<div class="mt-3 flex flex-col gap-2">
							<div class="flex items-center justify-between gap-3">
								<div>
									<label class="settings-label mb-0" for="provider-form-fallback-enabled">
										{$t('admin.rateLimitFallbackEnabled')}
									</label>
									<p class="text-xs text-text-muted">{$t('admin.rateLimitFallbackDescription')}</p>
								</div>
								<input
									id="provider-form-fallback-enabled"
									type="checkbox"
									bind:checked={formRateLimitFallbackEnabled}
								/>
							</div>

							{#if formRateLimitFallbackEnabled}
								<div>
									<label class="settings-label" for="provider-form-fallback-provider">
										{$t('admin.rateLimitFallbackProvider')}
									</label>
									<select
										id="provider-form-fallback-provider"
										class="settings-input"
										bind:value={formRateLimitFallbackBaseUrl}
										onchange={(e) => {
											const selectedId = e.currentTarget.value;
											const picked = allProviders.find(p => p.baseUrl === selectedId);
											if (picked) {
												formRateLimitFallbackBaseUrl = picked.baseUrl;
												formRateLimitFallbackApiKey = "";
												formRateLimitFallbackModelName = "";
												fallbackProviderModels = [];
												fetchProviderModels(picked.id).then(models => {
													fallbackProviderModels = models;
												}).catch(() => {});
											}
										}}
									>
										<option value="">{$t('admin.selectProvider')}</option>
										{#each allProviders.filter(p => !provider || p.id !== provider.id) as p}
											<option value={p.baseUrl}>{p.displayName}</option>
										{/each}
									</select>
									<p class="mt-1 text-xs text-text-muted">{$t('admin.rateLimitFallbackProviderDesc')}</p>
								</div>

								{#if fallbackProviderModels.length > 0}
									<div>
										<label class="settings-label" for="provider-form-fallback-model">
											{$t('admin.rateLimitFallbackModelName')}
										</label>
										<select
											id="provider-form-fallback-model"
											class="settings-input"
											value={formRateLimitFallbackModelName}
											onchange={(e) => {
												formRateLimitFallbackModelName = e.currentTarget.value;
											}}
										>
											<option value="">{$t('admin.selectModel')}</option>
											{#each fallbackProviderModels as m}
												<option value={m.name}>{m.displayName || m.name}</option>
											{/each}
										</select>
									</div>
								{:else if formRateLimitFallbackBaseUrl}
									<div>
										<label class="settings-label" for="provider-form-fallback-model-name">
											{$t('admin.rateLimitFallbackModelName')}
										</label>
										<input
											id="provider-form-fallback-model-name"
											type="text"
											class="settings-input"
											bind:value={formRateLimitFallbackModelName}
											placeholder={$t('admin.modelNamePlaceholderProvider')}
										/>
									</div>
								{/if}

								<div>
									<label class="settings-label" for="provider-form-fallback-timeout">
										{$t('admin.rateLimitFallbackTimeoutMs')}
									</label>
									<input
										id="provider-form-fallback-timeout"
										type="number"
										class="settings-input"
										bind:value={formRateLimitFallbackTimeoutMs}
										placeholder="30000"
										min="1000"
									/>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			</div>

			{#if visibleError}
				<p class="mt-4 text-sm text-danger">{visibleError}</p>
			{/if}

			{#if testMessage}
				<p class="mt-4 text-sm text-success">{testMessage}</p>
			{/if}
			{#if testError}
				<p class="mt-4 text-sm text-danger">{testError}</p>
			{/if}

			<div class="mt-4 flex flex-wrap gap-2">
				<button class="btn-primary flex-1" onclick={handleSave} disabled={saving}>
					{saving ? $t('common.saving') : $t('admin.saveChanges')}
				</button>
			<button class="btn-secondary" onclick={handleTest} disabled={testing || !formBaseUrl || isCreate}>
				{testing ? $t('common.loading') : $t('common.test')}
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
		width: min(32rem, calc(100vw - 2rem));
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
