<script lang="ts">
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import { AlertTriangle, Pencil, Trash2 } from "@lucide/svelte";
import {
	createProviderModel,
	updateProviderModel,
	deleteProviderModel,
	type Provider,
	type ProviderModel,
	type ProviderModelUpdate,
} from "$lib/client/api/admin";
import { getProviderModelFallbackOptions } from "./model-fallback";
import ModelForm from "./ModelForm.svelte";

const tVal = get(t);

let {
	providerId,
	models = [],
	allModels = [],
	allProviders = [],
	onClose,
	onIconFile,
	onRefresh,
	modelIconAssetSaved = null,
}: {
	providerId: string;
	models?: ProviderModel[];
	allModels?: ProviderModel[];
	allProviders?: Provider[];
	onClose?: () => void;
	onIconFile?: (event: Event, modelId: string) => void;
	onRefresh?: () => void | Promise<void>;
	modelIconAssetSaved?: { modelId: string; assetId: string } | null;
} = $props();

let error = $state("");
let message = $state("");
let showForm = $state(false);
let formModel = $state<ProviderModel | null>(null);
let formModelId = $derived(formModel?.id ?? null);
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
		await onRefresh?.();
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
		await onRefresh?.();
		showMessage($t("admin.providerDeleted"));
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

function hasFallbackWarning(model: ProviderModel): boolean {
	return (
		model.enabled &&
		!getProviderModelFallbackOptions(model, allModels).some(
			(option) => option.compatible,
		)
	);
}

$effect(() => {
	if (
		modelIconAssetSaved &&
		formModel &&
		formModel.id === modelIconAssetSaved.modelId &&
		formModel.iconAssetId !== modelIconAssetSaved.assetId
	) {
		formModel = { ...formModel, iconAssetId: modelIconAssetSaved.assetId };
	}
});
</script>

<div class="flex flex-col gap-3">
	<div class="flex items-center justify-between">
		<h3 class="text-sm font-medium text-text-primary">{$t('admin.models')}</h3>
		<div class="flex items-center gap-2">
			<button class="btn-sm" onclick={openAddForm}>{$t('admin.addModel')}</button>
			{#if onClose}
				<button class="btn-sm" onclick={onClose}>{$t('common.close')}</button>
			{/if}
		</div>
	</div>

	{#if error}
		<p class="text-sm text-danger">{error}</p>
	{:else if models.filter((model) => model.providerId === providerId).length === 0}
		<div class="rounded-md border border-border bg-surface-page px-4 py-6 text-center">
			<p class="text-sm text-text-muted">{$t('admin.noModelsYet')}</p>
			<button class="btn-secondary mt-3" onclick={openAddForm}>{$t('admin.addModel')}</button>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each models.filter((model) => model.providerId === providerId) as model (model.id)}
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
							<span class="flex min-w-0 items-center gap-2">
								<span class="truncate text-sm font-medium text-text-primary">
									{model.displayName || model.name}
								</span>
								{#if hasFallbackWarning(model)}
									<span
										class="inline-flex shrink-0 text-danger"
										title={$t('admin.modelFallbackModelWarning')}
										aria-label={$t('admin.modelFallbackModelWarning')}
										role="img"
									>
										<AlertTriangle class="h-4 w-4" size={16} strokeWidth={2} aria-hidden="true" />
									</span>
								{/if}
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
						<button class="btn-sm whitespace-nowrap" onclick={() => openEditForm(model)} title="Edit">
							<Pencil class="h-4 w-4" size={16} strokeWidth={2} aria-hidden="true" />
						</button>
						<button
							class="btn-sm whitespace-nowrap text-danger"
							disabled={deletingId === model.id}
							onclick={() => handleDelete(model)}
							title="Delete"
						>
							{#if deletingId === model.id}
								…
							{:else}
								<Trash2 class="h-4 w-4" size={16} strokeWidth={2} aria-hidden="true" />
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
	allModels={allModels}
	allProviders={allProviders}
	saving={formSaving}
	error={formError}
	onSave={handleSave}
	onClose={closeForm}
	onIconFile={onIconFile && formModelId ? (e: Event) => onIconFile(e, formModelId) : undefined}
	/>
{/if}
