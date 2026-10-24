<script lang="ts">
import { onMount, untrack } from "svelte";
import { t } from "$lib/i18n";
import { Check, ChevronDown, CircleHelp } from "@lucide/svelte";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import ComposerSubmenu from "./ComposerSubmenu.svelte";
import ComposerSubmenuOption from "./ComposerSubmenuOption.svelte";
import ModelSelectionGuideModal from "./ModelSelectionGuideModal.svelte";
import {
	fetchAvailableModels,
	type ModelProvider,
} from "$lib/client/api/models";
import {
	regionCodeToFlag,
	regionDisplayName,
} from "$lib/services/processing-region";
import {
	selectedModel,
	setSelectedModel,
	type ModelId,
} from "$lib/stores/settings";
import {
	initViewportTracking,
	viewportStore,
} from "$lib/utils/viewport.svelte";
import { fade } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";
import { portalToBody } from "$lib/utils/portal";

// The scrim fades out as well as in, through reducedMotionAware, which the
// app-wide CSS reduced-motion override cannot reach for a Svelte transition.
// The picker itself is ComposerSubmenu, which moves on its own.
const scrimFade = reducedMotionAware(fade);

let {
	onSelect,
	open = undefined,
	onOpenChange = undefined,
	// Handed the trigger element once it exists. The composer's "+" menu is a
	// real menu for the keyboard — one array of rows the arrow keys walk —
	// and the Model row's focusable element lives in here, so the menu has to
	// be able to reach it. Nothing else uses this; the default is a no-op.
	onTriggerRef = undefined,
	// Whether this picker paints the dimmed page behind its phone sheet.
	//
	// One scrim per screen, not one per sheet. `--scrim` is a single value
	// precisely so two surfaces cannot disagree about how dark "dimmed" is —
	// and two of them laid over each other disagree with BOTH of them: 0.32
	// over 0.32 reads as 0.54, and the sheet the picker was opened FROM goes
	// dark behind it, which is the one thing the board says must not happen
	// ("the thing they were anchored to stays visible above the scrim").
	//
	// So a surface that already owns a scrim — the "+" menu's sheet, which is
	// the only place this component is rendered — says so, and the picker
	// stacks above that scrim instead of adding a second one. Default true so
	// the component is still self-sufficient anywhere else.
	ownsScrim = true,
	// The surface the desktop picker opens BESIDE: inside the composer's "+"
	// menu, the menu panel. "Above the trigger" meant on top of the menu's
	// own rows — the Model row is near the bottom of the menu, so the list it
	// opened covered the rows above it. Beside the menu nothing is covered.
	// Without one the picker hangs beside its own trigger.
	flyoutAnchor = null,
	// The trigger's leading text, when the caller wants the control to name
	// itself rather than sit behind a separate label.
	//
	// The composer's "+" menu passes "Model": there the trigger IS the row,
	// full width, so the row's name has to live inside the button — a label
	// outside it would be a piece of the row that does not open the picker.
	// Left null everywhere else, where the trigger shows only the value.
	leadingLabel = null,
}: {
	onSelect?: (payload: { modelId: ModelId }) => void;
	open?: boolean | undefined;
	onOpenChange?: ((open: boolean) => void) | undefined;
	onTriggerRef?: ((element: HTMLButtonElement | null) => void) | undefined;
	ownsScrim?: boolean;
	flyoutAnchor?: HTMLElement | null;
	leadingLabel?: string | null;
} = $props();

let providers: ModelProvider[] = $state([]);
let internalOpen = $state(false);
let isLoading = $state(true);
let error: string | null = $state(null);
let dropdownRef: HTMLDivElement | null = $state(null);
let triggerRef: HTMLButtonElement | null = $state(null);
let menuRef: HTMLElement | null = $state(null);
let expandedProviders: Set<string> = $state(new Set());
// NOTE(ADR 0043 slice 0): the legacy rule was `window.innerWidth <= 768`. We
// now map this onto the shared viewport tier's "phone" bucket (< 640). This
// is the closest single bucket; widths in the 640–768 range therefore shift
// from the old "mobile" sheet layout to the desktop dropdown. Accepted as
// part of consolidating detection into one helper; later slices may refine.
let isMobile = $derived(viewportStore.tier === "phone");
let guideOpen = $state(false);
let isOpen = $derived(open ?? internalOpen);
// The phone sheet's armed-but-not-applied choice. Null on a desktop, where
// clicking a row applies it outright.
let pendingModelId = $state<ModelId | null>(null);
let sheetChoiceId = $derived(pendingModelId ?? $selectedModel);
let sheetChoiceName = $derived(
	providers
		.flatMap((provider) => provider.models)
		.find((model) => model.id === sheetChoiceId)?.displayName ?? null,
);

$effect(() => {
	onTriggerRef?.(triggerRef);
});

function setOpen(nextOpen: boolean) {
	if (open === undefined) {
		internalOpen = nextOpen;
	}
	onOpenChange?.(nextOpen);
}

function isModelGuideTarget(target: EventTarget | null): boolean {
	const element =
		target instanceof Element
			? target
			: target instanceof Node
				? target.parentElement
				: null;
	return Boolean(element?.closest(".model-guide-backdrop"));
}

onMount(() => {
	initViewportTracking();

	const handleClickOutside = (event: MouseEvent) => {
		const target = event.target as Node;
		if (isModelGuideTarget(event.target)) return;
		if (
			!dropdownRef ||
			dropdownRef.contains(target) ||
			menuRef?.contains(target)
		) {
			return;
		}
		untrack(() => {
			if (isOpen) setOpen(false);
		});
	};

	document.addEventListener("click", handleClickOutside);
	void (async () => {
		try {
			const response = await fetchAvailableModels();
			providers = response.providers;

			const currentModelId = $selectedModel;
			const modelExists = providers.some((p) =>
				p.models.some((m) => m.id === currentModelId),
			);
			if (!modelExists && providers.length > 0) {
				const firstProvider = providers[0];
				const firstModel = firstProvider?.models[0];
				if (firstModel) {
					setSelectedModel(firstModel.id as ModelId);
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to load models";
			providers = [];
		} finally {
			isLoading = false;
		}
	})();
	return () => {
		document.removeEventListener("click", handleClickOutside);
	};
});

const activeProvider = $derived.by(() => {
	const currentModelId = $selectedModel;
	for (const provider of providers) {
		const model = provider.models.find((m) => m.id === currentModelId);
		if (model) return { provider, model };
	}
	return null;
});

function toggleProvider(providerId: string) {
	const next = new Set(expandedProviders);
	if (next.has(providerId)) {
		next.delete(providerId);
	} else {
		next.add(providerId);
	}
	expandedProviders = next;
}

function handleSelect(modelId: ModelId) {
	// Everyday redesign — on a phone the list is a picker, not a menu: a row
	// arms the choice and the footer's positive button applies it. "A picker
	// is a sheet with a footer" is the rule the MobileSheets board sets, and
	// it is what stops a mis-tap on a 44px row from silently changing the
	// model for the conversation. On a desktop the dropdown behaves exactly
	// as it always did — one click, applied, closed.
	if (isMobile) {
		pendingModelId = modelId;
		return;
	}
	applyModel(modelId);
}

function applyModel(modelId: ModelId) {
	setSelectedModel(modelId);
	setOpen(false);
	onSelect?.({ modelId });
}

function confirmPendingModel() {
	const modelId = (pendingModelId ?? $selectedModel) as ModelId | null;
	if (!modelId) {
		setOpen(false);
		return;
	}
	applyModel(modelId);
}

function cancelSheet() {
	pendingModelId = null;
	setOpen(false);
}

// Escape or the grabber: out of the picker and back to the row it was opened
// from, with nothing applied.
function dismissPicker() {
	cancelSheet();
	triggerRef?.focus();
}

function toggleDropdown() {
	const opening = !isOpen;
	setOpen(!isOpen);
	if (opening) {
		pendingModelId = null;
		autoExpandProviders();
	}
}

function openGuide() {
	guideOpen = true;
}

function providerRegionTitle(provider: ModelProvider): string {
	const region = regionDisplayName(provider.processingRegionCode);
	return region ? $t("modelSelector.processingRegion", { region }) : "";
}

// Escape with focus still on the trigger. Inside the open picker the shell
// takes the key itself.
function handleKeydown(event: KeyboardEvent) {
	if (event.key !== "Escape") return;
	// Only while there is a picker to back out of. Swallowed unconditionally
	// — which is what this did — Escape on the trigger was eaten by a closed
	// dropdown, so the "+" menu the trigger sits in could never be dismissed
	// from its own Model row.
	if (!isOpen) return;
	event.preventDefault();
	event.stopPropagation();
	cancelSheet();
}

function isProviderExpanded(providerId: string): boolean {
	return expandedProviders.has(providerId);
}

function autoExpandProviders() {
	const next = new Set(expandedProviders);
	const currentModelId = $selectedModel;
	for (const provider of providers) {
		if (provider.models.some((m) => m.id === currentModelId)) {
			next.add(provider.id);
		}
	}
	expandedProviders = next;
}
</script>

{#snippet guideAction()}
	<!-- The guide is a 44px button here, not a 14px icon: the cloud flag it
	     explains is something you have to know how to read before you press
	     send, not after. -->
	<button
		type="button"
		class="model-selector__sheet-guide"
		onclick={openGuide}
		data-testid="model-sheet-guide"
	>
		<CircleHelp size={15} strokeWidth={2} aria-hidden="true" />
		{$t('modelSelector.openGuide')}
	</button>
{/snippet}

{#snippet sheetFooter()}
	<!-- A picker ends in Cancel and a positive button that names what it is
	     about to do, because you are choosing and then confirming. Negative
	     left, positive right. -->
	<button
		type="button"
		class="dialog-btn"
		data-testid="model-sheet-cancel"
		onclick={cancelSheet}
	>
		{$t('common.cancel')}
	</button>
	<button
		type="button"
		class="dialog-btn dialog-btn--positive"
		data-testid="model-sheet-confirm"
		onclick={confirmPendingModel}
	>
		<Check size={13} strokeWidth={2.2} aria-hidden="true" />
		{sheetChoiceName
			? $t('modelPicker.use', { model: sheetChoiceName })
			: $t('modelPicker.useNone')}
	</button>
{/snippet}

<div class="model-selector" bind:this={dropdownRef} onkeydown={handleKeydown} role="presentation">
	<div class="model-selector__controls">
		<button
			bind:this={triggerRef}
			type="button"
			class="model-selector__trigger"
			onclick={toggleDropdown}
			aria-haspopup="listbox"
			aria-expanded={isOpen}
			aria-label={$t('modelSelector.selectModel')}
			disabled={isLoading}
			data-testid="model-selector-trigger"
		>
			{#if leadingLabel}
				<span class="model-selector__lead">{leadingLabel}</span>
			{/if}
			{#if isLoading}
				<span class="model-selector__text">{$t('modelSelector.loading')}</span>
			{:else if activeProvider}
				{@const active = activeProvider}
				<ModelIcon
					iconUrl={active.model.iconUrl ?? active.provider.iconUrl ?? null}
					displayName={active.model.displayName}
					size={22}
				/>
				<span class="model-selector__text">{active.model.displayName}</span>
			{:else}
				<span class="model-selector__text">{$t('modelSelector.selectModel')}</span>
			{/if}
			<span class={`model-selector__chevron${isOpen ? ' model-selector__chevron--open' : ''}`}>
				<ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
			</span>
		</button>
		<button
			type="button"
			class="model-selector__guide-trigger"
			onclick={openGuide}
			aria-label={$t('modelSelector.openGuide')}
			title={$t('modelSelector.openGuide')}
			disabled={isLoading}
		>
			<CircleHelp size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>

	{#if isOpen && providers.length > 0 && isMobile && ownsScrim}
		<!-- The sheet's second dismissal: a tap on the dimmed page. Drawn only
		     when nothing else already dimmed it — see `ownsScrim`. -->
		<button
			type="button"
			class="model-selector__scrim"
			aria-label={$t('common.close')}
			use:portalToBody
			transition:scrimFade={{ duration: 200 }}
			onclick={cancelSheet}
		></button>
	{/if}

	{#if isOpen && providers.length > 0}
		<ComposerSubmenu
			bind:panel={menuRef}
			title={$t('modelPicker.title')}
			subtitle={$t('modelPicker.subtitle')}
			listLabel={$t('modelSelector.availableModels')}
			sheet={isMobile}
			rowElement={triggerRef}
			surfaceElement={flyoutAnchor}
			onDismiss={dismissPicker}
			testId="composer-submenu-model"
			headerAction={isMobile ? guideAction : undefined}
			footer={isMobile ? sheetFooter : undefined}
		>
			{#each providers as provider (provider.id)}
				{@const expanded = isProviderExpanded(provider.id)}
				<div class="model-selector__group" role="group" aria-label={provider.displayName}>
					<button
						type="button"
						class="composer-submenu__group"
						aria-expanded={expanded}
						onclick={() => toggleProvider(provider.id)}
					>
						<span class="model-selector__group-name">{provider.displayName}</span>
						{#if provider.processingRegionCode}
							<span
								class="model-selector__group-region"
								title={providerRegionTitle(provider)}
								aria-label={providerRegionTitle(provider)}
							>
								{regionCodeToFlag(provider.processingRegionCode)}
							</span>
						{/if}
						<span class="model-selector__group-count">{provider.models.length}</span>
						<span
							class="model-selector__group-chevron"
							class:model-selector__group-chevron--open={expanded}
							aria-hidden="true"
						>
							<ChevronDown size={13} strokeWidth={2} />
						</span>
					</button>
					{#if expanded}
						{#each provider.models as model (model.id)}
							<ComposerSubmenuOption
								label={model.displayName}
								selected={sheetChoiceId === model.id}
								onSelect={() => handleSelect(model.id as ModelId)}
								testId={`model-option-${model.id}`}
								optionId={model.id}
							>
								{#snippet leading()}
									<ModelIcon
										iconUrl={model.iconUrl ?? null}
										displayName={model.displayName}
										size={18}
									/>
								{/snippet}
							</ComposerSubmenuOption>
						{/each}
					{/if}
				</div>
			{/each}
		</ComposerSubmenu>
	{/if}

	{#if guideOpen}
		<ModelSelectionGuideModal {providers} onClose={() => (guideOpen = false)} />
	{/if}
</div>

<style>
	.model-selector {
		position: relative;
		display: inline-block;
	}

	.model-selector__controls {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.model-selector__trigger {
		display: flex;
		align-items: center;
		gap: var(--space-xs, 4px);
		min-width: 0;
		padding: var(--space-sm, 8px) 10px;
		background: transparent;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md, 8px);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 400;
		cursor: pointer;
		transition: all 150ms ease-out;
		min-height: 36px;
	}

	.model-selector__trigger:hover:not(:disabled) {
		background: var(--surface-elevated);
		border-color: var(--border-default);
	}

	.model-selector__trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--accent);
	}

	.model-selector__trigger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.model-selector__guide-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		min-width: 34px;
		height: 36px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md, 8px);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition: all 150ms ease-out;
	}

	.model-selector__guide-trigger:hover:not(:disabled) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.model-selector__guide-trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--accent);
	}

	.model-selector__guide-trigger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Pushes the value and its chevron to the trigger's far edge, so a
	   full-width trigger reads as "Model ............ Flash-Next ⌄". */
	.model-selector__lead {
		flex: 0 0 auto;
		margin-right: auto;
		padding-right: 0.5rem;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.model-selector__text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 120px;
	}
	.model-selector__chevron {
		flex-shrink: 0;
		transition: transform 200ms ease-out;
		color: var(--text-muted);
		margin-left: 4px;
	}

	.model-selector__chevron--open {
		transform: rotate(180deg);
	}

	/* The dimmed page behind the sheet, and the second of its three
	   dismissals. Under the sheet (ComposerSubmenu, z 70). */
	.model-selector__scrim {
		position: fixed;
		inset: 0;
		z-index: 69;
		border: 0;
		background: var(--scrim);
		cursor: pointer;
	}

	.model-selector__sheet-guide {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		flex: 0 0 auto;
		min-height: 44px;
		border: 1px solid var(--border-default);
		border-radius: 6px;
		background: var(--surface-page);
		padding: 0 0.65rem;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 600;
		cursor: pointer;
	}

	.model-selector__sheet-guide:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.model-selector__group {
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
	}

	.model-selector__group-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-selector__group-region {
		flex-shrink: 0;
		font-size: var(--text-xs);
		letter-spacing: 0;
		line-height: 1;
	}

	.model-selector__group-count {
		flex-shrink: 0;
		margin-right: auto;
		font-weight: 400;
		letter-spacing: 0;
	}

	.model-selector__group-chevron {
		display: inline-flex;
		flex-shrink: 0;
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.model-selector__group-chevron--open {
		transform: rotate(180deg);
	}

	/* Dark mode support */
	:global(.dark) .model-selector__trigger {
		color: var(--text-primary);
		border-color: var(--border-default);
	}

	:global(.dark) .model-selector__guide-trigger {
		color: var(--text-muted);
		border-color: var(--border-default);
	}

	:global(.dark) .model-selector__trigger:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	:global(.dark) .model-selector__guide-trigger:hover:not(:disabled) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	/* Mobile adjustments */
	@media (max-width: 768px) {
		.model-selector__trigger {
			min-height: 44px;
			padding: var(--space-sm, 8px) var(--space-md, 12px);
		}

		.model-selector__guide-trigger {
			width: 44px;
			min-width: 44px;
			height: 44px;
		}

		.model-selector__text {
			max-width: 100px;
		}
	}

</style>
