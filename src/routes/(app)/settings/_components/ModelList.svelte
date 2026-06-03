<script lang="ts">
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import {
	fetchProviderModels,
	createProviderModel,
	updateProviderModel,
	deleteProviderModel,
	type ProviderModel,
	type ProviderModelUpdate,
} from "$lib/client/api/admin";
import ModelForm from "./ModelForm.svelte";

const tVal = get(t);

let {
	providerId,
	onClose,
	onIconFile,
	modelIconAssetSaved = null,
}: {
	providerId: string;
	onClose?: () => void;
	onIconFile?: (event: Event, modelId: string) => void;
	modelIconAssetSaved?: { modelId: string; assetId: string } | null;
} = $props();

let models = $state<ProviderModel[]>([]);
let loading = $state(false);
let error = $state("");
let message = $state("");
let showForm = $state(false);
let formModel = $state<ProviderModel | null>(null);
let formSaving = $state(false);
let formError = $state("");
let deletingId = $state<string | null>(null);

let messageTimer: ReturnType<typeof setTimeout> | undefined;

function showMessage(text: string) {
	clearTimeout(messageTimer);
	message = text;
	messageTimer = setTimeout(() => {
		message = "";
	}, 4000);
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

async function loadModels() {
	loading = true;
	error = "";
	try {
		models = await fetchProviderModels(providerId);
	} catch (err: unknown) {
		error = errorMessage(err, $t("admin.loadingModels"));
	} finally {
		loading = false;
	}
}

function openAddForm() {
	formModel = null;
	formError = "";
	formSaving = false;
	showForm = true;
}

function openEditForm(model: ProviderModel) {
	formModel = { ...model };
	formError = "";
	formSaving = false;
	showForm = true;
}

function closeForm() {
	showForm = false;
	formModel = null;
	formError = "";
}

async function handleSave(data: ProviderModelUpdate) {
	formSaving = true;
	formError = "";
	try {
		if (formModel) {
			await updateProviderModel(providerId, formModel.id, data);
			showMessage($t("admin.providerUpdated"));
		} else {
			await createProviderModel(
				providerId,
				data as Parameters<typeof createProviderModel>[1],
			);
			showMessage($t("admin.providerAdded"));
		}
		closeForm();
		await loadModels();
	} catch (err: unknown) {
		formError = errorMessage(err, $t("admin.failedSave"));
	} finally {
		formSaving = false;
	}
}

async function handleDelete(model: ProviderModel) {
	if (!confirm($t("admin.deleteProviderConfirm", { name: model.displayName })))
		return;
	deletingId = model.id;
	try {
		await deleteProviderModel(providerId, model.id);
		showMessage($t("admin.providerDeleted"));
		await loadModels();
	} catch (err: unknown) {
		error = errorMessage(err, $t("admin.failedDeleteProvider"));
	} finally {
		deletingId = null;
	}
}

function formatPricing(input: number, output: number): string {
	const fmt = (n: number) => (n / 1_000_000).toFixed(6);
	return `$${fmt(input)} / $${fmt(output)}`;
}

$effect(() => {
	void loadModels();
});

$effect(() => {
	if (modelIconAssetSaved && formModel && formModel.id === modelIconAssetSaved.modelId && formModel.iconAssetId !== modelIconAssetSaved.assetId) {
		formModel = { ...formModel, iconAssetId: modelIconAssetSaved.assetId };
	}
});
</script>

<div class="flex flex-col gap-3">
	<div class="flex items-center justify-between">
		<h3 class="text-sm font-medium text-text-primary">{$t('admin.models')}</h3>
		<div class="flex items-center gap-2">
			<button class="btn-small" onclick={openAddForm}>{$t('admin.addModel')}</button>
			{#if onClose}
				<button class="btn-small" onclick={onClose}>{$t('common.close')}</button>
			{/if}
		</div>
	</div>

	{#if loading}
		<p class="text-sm text-text-secondary">{$t('common.loading')}</p>
	{:else if error}
		<p class="text-sm text-danger">{error}</p>
	{:else if models.length === 0}
		<div class="rounded-md border border-border bg-surface-page px-4 py-6 text-center">
			<p class="text-sm text-text-muted">{$t('admin.noModelsYet')}</p>
			<button class="btn-secondary mt-3" onclick={openAddForm}>{$t('admin.addModel')}</button>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each models as model (model.id)}
				<div
					class="flex flex-col gap-2 rounded-md border border-border bg-surface-page px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="flex min-w-0 items-center gap-3">
						<span
							class="inline-block h-2 w-2 shrink-0 rounded-full"
							class:bg-success={model.enabled}
							class:bg-text-muted={!model.enabled}
						></span>
						{#if model.iconAssetId}
							<img src={`/api/campaign-assets/${encodeURIComponent(model.iconAssetId)}/content`} alt="" class="h-6 w-6 rounded object-cover shrink-0" />
						{/if}
						<div class="flex min-w-0 flex-col">
							<span class="truncate text-sm font-medium text-text-primary">
								{model.displayName || model.name}
							</span>
							<span class="truncate text-xs text-text-muted">
								{model.name}
								&bull;
								{formatPricing(model.inputUsdMicrosPer1m, model.outputUsdMicrosPer1m)}
							</span>
						</div>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-xs text-text-muted">
							{model.enabled ? $t('admin.enabled') : $t('admin.disabled')}
						</span>
						<button class="btn-small whitespace-nowrap" onclick={() => openEditForm(model)} title="Edit">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
						</button>
						<button
							class="btn-small whitespace-nowrap text-danger"
							disabled={deletingId === model.id}
							onclick={() => handleDelete(model)}
							title="Delete"
						>
							{#if deletingId === model.id}
								…
							{:else}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
							{/if}
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if message}
		<p class="text-sm text-success">{message}</p>
	{/if}
</div>

{#if showForm}
	<ModelForm
		{providerId}
		model={formModel}
		saving={formSaving}
		error={formError}
		onSave={handleSave}
		onClose={closeForm}
		onIconFile={onIconFile ? (e: Event) => { if (formModel?.id) onIconFile(e, formModel.id); } : undefined}
	/>
{/if}
