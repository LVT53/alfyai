<script lang="ts">
// The provider dialog on the app's own DialogShell chassis (focus trap,
// Escape, backdrop) instead of its private modal CSS. Thirteen stacked fields
// become two readable columns plus one grouped sub-card, and the rate-limit
// fallback keeps every control it had — including the free-text escape hatch.
import { untrack } from "svelte";
import { Eye, EyeOff, TestTube } from "@lucide/svelte";
import { fetchProviderModels } from "$lib/client/api/admin";
import type { Provider, ProviderModel } from "$lib/client/api/admin";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import {
	regionCodeToFlag,
	regionDisplayName,
} from "$lib/services/processing-region";
import SecretField from "./system/SecretField.svelte";
import SystemToggle from "./system/SystemToggle.svelte";
import "./system/system.css";

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
// Creating a provider means typing a key that is not stored anywhere yet, so
// the field keeps the old dialog's Show/Hide. On edit, SecretField owns it.
let revealNewApiKey = $state(false);
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
let fallbackFreeText = $state(false);
let localError = $state("");

let visibleError = $derived(error || localError);
const regionName = $derived(regionDisplayName(formProcessingRegionCode));

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

<DialogShell
	title={isCreate ? $t('admin.addProvider') : $t('admin.editProvider')}
	description={$t('admin.system.dialog.savedHere')}
	maxWidthClass="max-w-[840px]"
	zIndexClass="z-[100]"
	{onClose}
>
	<div class="sys-grid2">
		<div>
			<label class="sys-label" for="provider-form-display-name">
				{$t('admin.displayName')}
			</label>
			<input
				id="provider-form-display-name"
				type="text"
				class="sys-input sys-input-wide"
				bind:value={formDisplayName}
				placeholder={$t('admin.displayNamePlaceholder')}
			/>
		</div>

		<div>
			<label class="sys-label" for="provider-form-processing-region">
				{$t('admin.providerProcessingRegion')}
			</label>
			<span class="sys-field">
				<input
					id="provider-form-processing-region"
					type="text"
					class="sys-input sys-input-sm"
					style="text-transform: uppercase"
					bind:value={formProcessingRegionCode}
					placeholder={$t('admin.providerProcessingRegionPlaceholder')}
					maxlength="2"
				/>
				{#if regionName}
					<span class="sys-xs sys-muted">
						{regionCodeToFlag(formProcessingRegionCode)} {regionName}
					</span>
				{/if}
			</span>
			<p class="sys-help">{$t('admin.providerProcessingRegionDescription')}</p>
		</div>

		<div>
			<label class="sys-label" for="provider-form-name">{$t('admin.nameId')}</label>
			<input
				id="provider-form-name"
				type="text"
				class="sys-input sys-input-wide"
				bind:value={formName}
				placeholder={$t('admin.nameIdPlaceholder')}
				disabled={!isCreate}
			/>
			<p class="sys-help">
				{isCreate
					? $t('admin.nameIdDescription')
					: $t('admin.system.dialog.providerIdFixed')}
			</p>
		</div>

		<div>
			<label class="sys-label" for="provider-form-privacy-policy">
				{$t('admin.providerPrivacyPolicy')}
			</label>
			<input
				id="provider-form-privacy-policy"
				type="url"
				class="sys-input sys-input-wide"
				bind:value={formPrivacyPolicyUrl}
				placeholder={$t('admin.providerPrivacyPolicyPlaceholder')}
			/>
			<p class="sys-help">{$t('admin.providerPrivacyPolicyDescription')}</p>
		</div>

		<div>
			<label class="sys-label" for="provider-form-base-url">{$t('admin.baseUrl')}</label>
			<input
				id="provider-form-base-url"
				type="url"
				class="sys-input sys-input-wide sys-input-mono"
				bind:value={formBaseUrl}
				placeholder={$t('admin.baseUrlPlaceholder')}
			/>
		</div>

		<div>
			<span class="sys-label">{$t('admin.system.dialog.icon')}</span>
			<div class="sys-row-control">
				<span class="sys-avatar">
					{#if formIconAssetId}
						<img
							src={`/api/campaign-assets/${encodeURIComponent(formIconAssetId)}/content`}
							alt=""
						/>
					{:else}
						{formDisplayName.slice(0, 2).toUpperCase()}
					{/if}
				</span>
				{#if onIconFile}
					<label class="sys-mini" for="provider-form-icon">
						{formIconAssetId
							? $t('admin.system.dialog.iconReplace')
							: $t('admin.modelIcon')}
					</label>
					<input
						id="provider-form-icon"
						type="file"
						accept="image/*"
						class="sr-only"
						onchange={onIconFile}
					/>
				{/if}
				{#if formIconAssetId}
					<button
						type="button"
						class="sys-mini sys-mini-danger"
						onclick={() => (formIconAssetId = '')}
					>
						{$t('admin.system.dialog.iconRemove')}
					</button>
				{/if}
			</div>
		</div>

		<div>
			<span class="sys-label" id="provider-form-api-key-label">{$t('admin.apiKey')}</span>
			<div class="sys-row-control">
				{#if isCreate}
					<span class="sys-field">
						<input
							id="provider-form-api-key"
							type={revealNewApiKey ? 'text' : 'password'}
							class="sys-input sys-input-md"
							aria-labelledby="provider-form-api-key-label"
							autocomplete="off"
							bind:value={formApiKey}
							placeholder={$t('admin.apiKeyPlaceholder')}
						/>
						<button
							type="button"
							class="sys-mini"
							aria-label={revealNewApiKey ? $t('admin.hide') : $t('admin.show')}
							onclick={() => (revealNewApiKey = !revealNewApiKey)}
						>
							{#if revealNewApiKey}
								<EyeOff size={12} strokeWidth={2} aria-hidden="true" />
							{:else}
								<Eye size={12} strokeWidth={2} aria-hidden="true" />
							{/if}
						</button>
					</span>
				{:else}
					<SecretField
						inputId="provider-form-api-key"
						label={$t('admin.apiKey')}
						value={provider ? 'set' : ''}
						onchange={(next) => (formApiKey = next)}
						onCancelReplace={() => (formApiKey = '')}
					/>
				{/if}
			</div>
		</div>

		<div>
			<span class="sys-label">{$t('admin.system.dialog.availability')}</span>
			<div class="sys-row-control">
				<SystemToggle
					id="provider-form-enabled"
					label={$t('admin.system.dialog.enabledForEveryone')}
					checked={formEnabled}
					onchange={(next) => (formEnabled = next)}
				/>
				<span class="sys-xs sys-muted">{$t('admin.system.dialog.enabledForEveryone')}</span>
			</div>
		</div>
	</div>

	<section class="sys-card" style="margin-top: var(--space-md)">
		<div class="sys-card-head" style="margin-bottom: 10px">
			<span class="sys-grow">
				<h3 class="sys-card-title">{$t('admin.rateLimitFallback')}</h3>
				<p class="sys-card-desc">{$t('admin.system.dialog.fallbackDescription')}</p>
			</span>
			<span class="sys-card-actions">
				<SystemToggle
					id="provider-form-fallback-enabled"
					label={$t('admin.rateLimitFallbackEnabled')}
					checked={formRateLimitFallbackEnabled}
					onchange={(next) => (formRateLimitFallbackEnabled = next)}
				/>
			</span>
		</div>

		{#if formRateLimitFallbackEnabled}
			<div class="sys-grid3">
				<div>
					<label class="sys-label" for="provider-form-fallback-provider">
						{$t('admin.rateLimitFallbackProvider')}
					</label>
					<select
						id="provider-form-fallback-provider"
						class="sys-input sys-input-wide"
						bind:value={formRateLimitFallbackBaseUrl}
						onchange={(event) => {
							const selectedId = event.currentTarget.value;
							const picked = allProviders.find((p) => p.baseUrl === selectedId);
							if (picked) {
								formRateLimitFallbackBaseUrl = picked.baseUrl;
								formRateLimitFallbackApiKey = '';
								formRateLimitFallbackModelName = '';
								fallbackProviderModels = [];
								fallbackFreeText = false;
								fetchProviderModels(picked.id)
									.then((models) => {
										fallbackProviderModels = models;
									})
									.catch(() => {});
							}
						}}
					>
						<option value="">{$t('admin.selectProvider')}</option>
						{#each allProviders.filter((p) => !provider || p.id !== provider.id) as p (p.id)}
							<option value={p.baseUrl}>{p.displayName}</option>
						{/each}
					</select>
					<p class="sys-help">{$t('admin.rateLimitFallbackProviderDesc')}</p>
				</div>

				<div>
					<label class="sys-label" for="provider-form-fallback-model">
						{$t('admin.rateLimitFallbackModelName')}
					</label>
					{#if fallbackProviderModels.length > 0 && !fallbackFreeText}
						<select
							id="provider-form-fallback-model"
							class="sys-input sys-input-wide"
							value={formRateLimitFallbackModelName}
							onchange={(event) => {
								formRateLimitFallbackModelName = event.currentTarget.value;
							}}
						>
							<option value="">{$t('admin.selectModel')}</option>
							{#each fallbackProviderModels as m (m.id)}
								<option value={m.name}>{m.displayName || m.name}</option>
							{/each}
						</select>
						<button
							type="button"
							class="sys-mini"
							style="margin-top: 6px"
							onclick={() => (fallbackFreeText = true)}
						>
							{$t('admin.system.dialog.useFreeText')}
						</button>
					{:else}
						<input
							id="provider-form-fallback-model"
							type="text"
							class="sys-input sys-input-wide"
							bind:value={formRateLimitFallbackModelName}
							placeholder={$t('admin.modelNamePlaceholderProvider')}
						/>
						{#if fallbackProviderModels.length > 0}
							<button
								type="button"
								class="sys-mini"
								style="margin-top: 6px"
								onclick={() => (fallbackFreeText = false)}
							>
								{$t('admin.system.dialog.usePicker')}
							</button>
						{/if}
					{/if}
				</div>

				<div>
					<label class="sys-label" for="provider-form-fallback-timeout">
						{$t('admin.system.dialog.fallbackWait')}
					</label>
					<span class="sys-field">
						<input
							id="provider-form-fallback-timeout"
							type="number"
							class="sys-input sys-input-sm"
							bind:value={formRateLimitFallbackTimeoutMs}
							placeholder="30000"
							min="1000"
						/>
						<span class="sys-unit">{$t('admin.system.unit.ms')}</span>
					</span>
				</div>
			</div>
		{/if}
	</section>

	{#if visibleError}
		<p class="sys-error" style="margin-top: var(--space-md)" role="alert">{visibleError}</p>
	{/if}

	<div
		class="sys-row-control"
		style="margin-top: var(--space-lg); padding-top: var(--space-md); border-top: 1px solid var(--border-subtle)"
	>
		<button
			type="button"
			class="btn-secondary btn-sm"
			onclick={handleTest}
			disabled={testing || !formBaseUrl || isCreate}
		>
			<TestTube size={13} strokeWidth={2} aria-hidden="true" />
			{testing ? $t('common.loading') : $t('admin.system.providers.test')}
		</button>
		{#if testMessage}
			<span class="sys-xs" style="color: var(--success)" role="status">{testMessage}</span>
		{/if}
		{#if testError}
			<span class="sys-xs" style="color: var(--danger)" role="alert">{testError}</span>
		{/if}

		<span class="sys-grow"></span>
		<button type="button" class="btn-secondary btn-sm" onclick={onClose}>
			{$t('common.cancel')}
		</button>
		<button type="button" class="btn-primary btn-sm" onclick={handleSave} disabled={saving}>
			{saving ? $t('common.saving') : $t('admin.system.dialog.saveProvider')}
		</button>
	</div>
</DialogShell>
