<script lang="ts">
// The models of one provider, rendered inside that provider's drawer instead
// of the old raw `fixed inset-0` overlay (which had no focus trap and dropped
// unsaved model edits on a click outside).
import { AlertTriangle, Pencil, Plus, Tags, Trash2 } from "@lucide/svelte";
import {
	createProviderModel,
	deleteProviderModel,
	updateProviderModel,
	type Provider,
	type ProviderModel,
	type ProviderModelUpdate,
} from "$lib/client/api/admin";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import { t } from "$lib/i18n";
import ModelForm from "./ModelForm.svelte";
import { getProviderModelFallbackOptions } from "./model-fallback";
import "./system/system.css";

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
let formFocusPriceWindows = $state(false);
let deletingId = $state<string | null>(null);
let pendingDelete = $state<ProviderModel | null>(null);

let messageTimer: ReturnType<typeof setTimeout> | undefined;

const providerModels = $derived(
	models.filter((model) => model.providerId === providerId),
);

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
	formFocusPriceWindows = false;
	showForm = true;
}

function openEditForm(model: ProviderModel, focusPriceWindows = false) {
	formModel = { ...model };
	formError = "";
	formSaving = false;
	formFocusPriceWindows = focusPriceWindows;
	showForm = true;
}

function closeForm() {
	showForm = false;
	formModel = null;
	formError = "";
	formFocusPriceWindows = false;
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

async function confirmDelete() {
	const model = pendingDelete;
	pendingDelete = null;
	if (!model) return;
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

<div class="sys-stack" style="gap: var(--space-sm)" data-testid="model-list">
	{#if error}
		<p class="sys-error" role="alert">{error}</p>
	{/if}

	{#if providerModels.length === 0}
		<div class="sys-empty">
			<p style="margin: 0 0 10px">{$t('admin.noModelsYet')}</p>
			<button type="button" class="btn-secondary btn-sm" onclick={openAddForm}>
				{$t('admin.addModel')}
			</button>
		</div>
	{:else}
		<div class="sys-list">
			{#each providerModels as model (model.id)}
				<div class="sys-list-row" data-testid={`model-row-${model.id}`}>
					<span
						class="sys-dot"
						class:sys-dot-on={model.enabled}
						class:sys-dot-off={!model.enabled}
					></span>
					{#if model.iconAssetId}
						<span class="sys-avatar" aria-hidden="true">
							<img
								src={`/api/campaign-assets/${encodeURIComponent(model.iconAssetId)}/content`}
								alt=""
							/>
						</span>
					{/if}
					<span class="sys-grow" style="min-width: 0">
						<span class="sys-label">
							<span class="sys-truncate">{model.displayName || model.name}</span>
							{#if !model.enabled}
								<span class="sys-pill sys-pill-muted">{$t('admin.disabled')}</span>
							{/if}
							{#if hasFallbackWarning(model)}
								<span
									style="color: var(--danger); display: inline-flex"
									title={$t('admin.modelFallbackModelWarning')}
									aria-label={$t('admin.modelFallbackModelWarning')}
									role="img"
								>
									<AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
								</span>
							{/if}
						</span>
						<span class="sys-key">
							{model.name} · {formatPricing(
								model.inputUsdMicrosPer1m,
								model.outputUsdMicrosPer1m,
							)}
						</span>
					</span>

					<button
						type="button"
						class="sys-mini"
						aria-label={$t('skills.editA11y', { name: model.displayName || model.name })}
						onclick={() => openEditForm(model)}
					>
						<Pencil size={12} strokeWidth={2} aria-hidden="true" />
						{$t('common.edit')}
					</button>
					<button
						type="button"
						class="sys-mini"
						onclick={() => openEditForm(model, true)}
					>
						<Tags size={12} strokeWidth={2} aria-hidden="true" />
						{$t('admin.system.priceWindows')}
					</button>
					<button
						type="button"
						class="sys-mini sys-mini-danger"
						disabled={deletingId === model.id}
						aria-label={$t('admin.system.deleteModel.title', {
							name: model.displayName || model.name,
						})}
						onclick={() => (pendingDelete = model)}
					>
						<Trash2 size={12} strokeWidth={2} aria-hidden="true" />
					</button>
				</div>
			{/each}
		</div>
	{/if}

	<div class="sys-row-control">
		<button type="button" class="sys-mini" onclick={openAddForm}>
			<Plus size={12} strokeWidth={2} aria-hidden="true" />
			{$t('admin.addModel')}
		</button>
		{#if onClose}
			<button type="button" class="sys-mini" onclick={onClose}>
				{$t('common.close')}
			</button>
		{/if}
		{#if message}
			<span class="sys-xs" style="color: var(--success)" role="status">{message}</span>
		{/if}
	</div>
</div>

{#if showForm}
	<ModelForm
		{providerId}
		model={formModel}
		allModels={allModels}
		allProviders={allProviders}
		saving={formSaving}
		error={formError}
		focusPriceWindows={formFocusPriceWindows}
		onSave={handleSave}
		onClose={closeForm}
		onIconFile={onIconFile && formModelId
			? (e: Event) => onIconFile(e, formModelId)
			: undefined}
	/>
{/if}

{#if pendingDelete}
	<ConfirmDialog
		title={$t('admin.system.deleteModel.title', {
			name: pendingDelete.displayName || pendingDelete.name,
		})}
		message={$t('admin.system.deleteModel.message')}
		confirmText={$t('common.delete')}
		confirmVariant="danger"
		onConfirm={confirmDelete}
		onCancel={() => (pendingDelete = null)}
	/>
{/if}
