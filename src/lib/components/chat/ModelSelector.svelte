<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import { t } from "$lib/i18n";
import { Check, ChevronDown, CircleHelp } from "@lucide/svelte";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import ModelSelectionGuideModal from "./ModelSelectionGuideModal.svelte";
import {
	fetchAvailableModels,
	type ModelProvider,
	type ProviderModel,
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

let {
	onSelect,
	open = undefined,
	onOpenChange = undefined,
}: {
	onSelect?: (payload: { modelId: ModelId }) => void;
	open?: boolean | undefined;
	onOpenChange?: ((open: boolean) => void) | undefined;
} = $props();

let providers: ModelProvider[] = $state([]);
let internalOpen = $state(false);
let isLoading = $state(true);
let error: string | null = $state(null);
let dropdownRef: HTMLDivElement | null = $state(null);
let triggerRef: HTMLButtonElement | null = $state(null);
let menuRef: HTMLDivElement | null = $state(null);
let expandedProviders: Set<string> = $state(new Set());
let focusedModelId: string | null = $state(null);
// NOTE(ADR 0043 slice 0): the legacy rule was `window.innerWidth <= 768`. We
// now map this onto the shared viewport tier's "phone" bucket (< 640). This
// is the closest single bucket; widths in the 640–768 range therefore shift
// from the old "mobile" sheet layout to the desktop dropdown. Accepted as
// part of consolidating detection into one helper; later slices may refine.
let isMobile = $derived(viewportStore.tier === "phone");
let guideOpen = $state(false);
let isOpen = $derived(open ?? internalOpen);
let dropdownPosition = $state({
	top: 0,
	left: 0,
	width: 280,
	maxHeight: 400,
	placement: "top" as "top" | "bottom",
	ready: false,
});
let dropdownStyle = $derived(
	`top: ${dropdownPosition.top}px; left: ${dropdownPosition.left}px; width: ${dropdownPosition.width}px; max-height: ${dropdownPosition.maxHeight}px; visibility: ${dropdownPosition.ready ? "visible" : "hidden"};`,
);

const DESKTOP_DROPDOWN_GAP = 6;
const DESKTOP_DROPDOWN_MARGIN = 12;
const DESKTOP_DROPDOWN_MIN_WIDTH = 280;
const DESKTOP_DROPDOWN_MAX_WIDTH = 320;
const DESKTOP_DROPDOWN_MAX_HEIGHT = 400;
const DESKTOP_DROPDOWN_MIN_HEIGHT = 160;

function setOpen(nextOpen: boolean) {
	if (open === undefined) {
		internalOpen = nextOpen;
	}
	onOpenChange?.(nextOpen);
	if (!nextOpen) {
		focusedModelId = null;
	}
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
	window.addEventListener("scroll", updateDropdownPosition, true);

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
		window.removeEventListener("scroll", updateDropdownPosition, true);
	};
});

$effect(() => {
	if (!isOpen) {
		dropdownPosition = {
			top: 0,
			left: 0,
			width: DESKTOP_DROPDOWN_MIN_WIDTH,
			maxHeight: DESKTOP_DROPDOWN_MAX_HEIGHT,
			placement: "top",
			ready: false,
		};
		return;
	}

	providers.length;
	expandedProviders.size;
	isMobile;
	void tick().then(updateDropdownPosition);
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
	setSelectedModel(modelId);
	setOpen(false);
	onSelect?.({ modelId });
}

function toggleDropdown() {
	const opening = !isOpen;
	setOpen(!isOpen);
	if (opening) autoExpandProviders();
}

function openGuide() {
	guideOpen = true;
}

function providerRegionTitle(provider: ModelProvider): string {
	const region = regionDisplayName(provider.processingRegionCode);
	return region ? $t("modelSelector.processingRegion", { region }) : "";
}

async function updateDropdownPosition() {
	if (!isOpen || isMobile || !triggerRef || typeof window === "undefined")
		return;

	await tick();
	if (!isOpen || isMobile || !triggerRef) return;

	const triggerRect = triggerRef.getBoundingClientRect();
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;
	const availableWidth = Math.max(
		0,
		viewportWidth - DESKTOP_DROPDOWN_MARGIN * 2,
	);
	const width = Math.min(
		DESKTOP_DROPDOWN_MAX_WIDTH,
		Math.max(DESKTOP_DROPDOWN_MIN_WIDTH, triggerRect.width),
		availableWidth,
	);
	const left = Math.min(
		Math.max(DESKTOP_DROPDOWN_MARGIN, triggerRect.left),
		Math.max(
			DESKTOP_DROPDOWN_MARGIN,
			viewportWidth - DESKTOP_DROPDOWN_MARGIN - width,
		),
	);
	const spaceAbove = Math.max(
		0,
		triggerRect.top - DESKTOP_DROPDOWN_MARGIN - DESKTOP_DROPDOWN_GAP,
	);
	const spaceBelow = Math.max(
		0,
		viewportHeight -
			triggerRect.bottom -
			DESKTOP_DROPDOWN_MARGIN -
			DESKTOP_DROPDOWN_GAP,
	);
	const placement =
		spaceAbove >= DESKTOP_DROPDOWN_MIN_HEIGHT || spaceAbove >= spaceBelow
			? "top"
			: "bottom";
	const availableHeight = placement === "top" ? spaceAbove : spaceBelow;
	const maxHeight = Math.max(
		Math.min(DESKTOP_DROPDOWN_MIN_HEIGHT, availableHeight),
		Math.min(DESKTOP_DROPDOWN_MAX_HEIGHT, availableHeight),
	);
	const measuredHeight = Math.min(
		menuRef?.offsetHeight || DESKTOP_DROPDOWN_MAX_HEIGHT,
		maxHeight,
	);
	const top =
		placement === "top"
			? Math.max(
					DESKTOP_DROPDOWN_MARGIN,
					triggerRect.top - DESKTOP_DROPDOWN_GAP - measuredHeight,
				)
			: Math.min(
					triggerRect.bottom + DESKTOP_DROPDOWN_GAP,
					viewportHeight - DESKTOP_DROPDOWN_MARGIN - measuredHeight,
				);
	const fixedContainingBlockOffset = getFixedContainingBlockOffset();

	dropdownPosition = {
		top: top - fixedContainingBlockOffset.top,
		left: left - fixedContainingBlockOffset.left,
		width,
		maxHeight,
		placement,
		ready: true,
	};
}

function getFixedContainingBlockOffset(): { top: number; left: number } {
	let element = menuRef?.parentElement ?? null;
	while (element && element !== document.documentElement) {
		const style = getComputedStyle(element);
		const createsFixedContainingBlock =
			style.transform !== "none" ||
			style.perspective !== "none" ||
			style.filter !== "none" ||
			style.backdropFilter !== "none" ||
			style.contain.includes("layout") ||
			style.contain.includes("paint") ||
			style.willChange.includes("transform");

		if (createsFixedContainingBlock) {
			const rect = element.getBoundingClientRect();
			return { top: rect.top, left: rect.left };
		}

		element = element.parentElement;
	}

	return { top: 0, left: 0 };
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		setOpen(false);
		return;
	}

	if (!isOpen) return;

	const allVisibleModels: { providerId: string; model: ProviderModel }[] = [];
	for (const provider of providers) {
		if (expandedProviders.has(provider.id)) {
			for (const model of provider.models) {
				allVisibleModels.push({ providerId: provider.id, model });
			}
		}
	}

	if (allVisibleModels.length === 0) return;

	const currentIndex = focusedModelId
		? allVisibleModels.findIndex((item) => item.model.id === focusedModelId)
		: -1;

	if (event.key === "ArrowDown") {
		event.preventDefault();
		const nextIndex =
			currentIndex + 1 < allVisibleModels.length ? currentIndex + 1 : 0;
		focusedModelId = allVisibleModels[nextIndex].model.id;
		scrollFocusedIntoView();
	} else if (event.key === "ArrowUp") {
		event.preventDefault();
		const prevIndex =
			currentIndex > 0 ? currentIndex - 1 : allVisibleModels.length - 1;
		focusedModelId = allVisibleModels[prevIndex].model.id;
		scrollFocusedIntoView();
	} else if (event.key === "Enter" && focusedModelId) {
		event.preventDefault();
		handleSelect(focusedModelId as ModelId);
	}
}

async function scrollFocusedIntoView() {
	await tick();
	const element = menuRef?.querySelector(`[data-model-id="${focusedModelId}"]`);
	if (element) {
		element.scrollIntoView({ block: "nearest" });
	}
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
			{#if isLoading}
				<span class="model-selector__text">Loading...</span>
			{:else if activeProvider}
				{@const active = activeProvider}
				<ModelIcon
					iconUrl={active.model.iconUrl ?? active.provider.iconUrl ?? null}
					displayName={active.model.displayName}
					size={22}
				/>
				<span class="model-selector__text">{active.model.displayName}</span>
			{:else}
				<span class="model-selector__text">Select model</span>
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

	{#if isOpen && providers.length > 0}
		<div
			bind:this={menuRef}
			class="model-selector__dropdown"
			class:model-selector__dropdown--mobile={isMobile}
			class:model-selector__dropdown--below={!isMobile && dropdownPosition.placement === 'bottom'}
			style={isMobile ? undefined : dropdownStyle}
			role="listbox"
			aria-label={$t('modelSelector.availableModels')}
			tabindex="-1"
		>
			<div class="model-selector__list">
				{#each providers as provider (provider.id)}
					{@const expanded = isProviderExpanded(provider.id)}
					<div class="model-selector__provider">
						<button
							type="button"
							class="model-selector__provider-header"
							aria-expanded={expanded}
							onclick={() => toggleProvider(provider.id)}
						>
							<ModelIcon
								iconUrl={provider.iconUrl ?? null}
								displayName={provider.displayName}
								size={20}
							/>
							<span class="model-selector__provider-name">{provider.displayName}</span>
							{#if provider.processingRegionCode}
								<span
									class="model-selector__provider-region"
									title={providerRegionTitle(provider)}
									aria-label={providerRegionTitle(provider)}
								>
									{regionCodeToFlag(provider.processingRegionCode)}
								</span>
							{/if}
							<span class="model-selector__provider-count">{provider.models.length}</span>
							<span class={`model-selector__expand-icon${expanded ? ' model-selector__expand-icon--open' : ''}`}>
							<ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
						</span>
						</button>

						{#if expanded}
							<ul class="model-selector__models">
								{#each provider.models as model (model.id)}
									<li>
										<button
											type="button"
											role="option"
											aria-selected={$selectedModel === model.id}
											class="model-selector__option"
											class:model-selector__option--selected={$selectedModel === model.id}
											class:model-selector__option--focused={focusedModelId === model.id}
											onclick={() => handleSelect(model.id as ModelId)}
											data-model-id={model.id}
											data-testid="model-option-{model.id}"
										>
											<ModelIcon
												iconUrl={model.iconUrl ?? null}
												displayName={model.displayName}
												size={18}
											/>
											<span class="model-selector__option-text">{model.displayName}</span>
											{#if $selectedModel === model.id}
												<span class="model-selector__check">
												<Check size={14} strokeWidth={3} aria-hidden="true" />
											</span>
											{/if}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
		</div>
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

	.model-selector__dropdown {
		position: fixed;
		margin: 0;
		background: var(--surface-page);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md, 8px);
		box-shadow: var(--shadow-lg, 0 4px 16px rgba(0, 0, 0, 0.08));
		min-width: 280px;
		max-width: 320px;
		z-index: 100;
		animation: dropdownFadeIn 150ms ease-out;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.model-selector__dropdown--below {
		animation-name: dropdownFadeInBelow;
	}

	.model-selector__dropdown--mobile {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		margin-bottom: 0;
		border-radius: var(--radius-lg, 12px) var(--radius-lg, 12px) 0 0;
		max-width: 100%;
		max-height: 70vh;
		min-width: unset;
		animation: sheetSlideUp 200ms ease-out;
	}

	.model-selector__list {
		overflow-y: auto;
		padding: var(--space-xs, 4px);
		flex: 1;
	}

	.model-selector__provider {
		margin-bottom: 2px;
	}

	.model-selector__provider-header {
		display: flex;
		align-items: center;
		gap: var(--space-sm, 8px);
		width: 100%;
		padding: var(--space-sm, 8px) var(--space-md, 12px);
		border-radius: var(--radius-sm, 4px);
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-primary);
		transition: background-color 150ms ease-out;
		background: transparent;
		border: none;
		text-align: left;
	}

	.model-selector__provider-header:hover,
	.model-selector__provider-header:focus {
		background: var(--surface-elevated);
		outline: none;
	}

	.model-selector__provider-name {
		font-weight: 500;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}

	.model-selector__provider-count {
		font-size: var(--text-2xs);
		color: var(--text-muted);
		background: var(--surface-overlay);
		padding: 2px 6px;
		border-radius: var(--radius-sm, 4px);
		flex-shrink: 0;
	}

	.model-selector__provider-region {
		flex-shrink: 0;
		font-size: var(--text-base);
		line-height: 1;
	}

	.model-selector__expand-icon {
		flex-shrink: 0;
		transition: transform 200ms ease-out;
		color: var(--text-muted);
	}

	.model-selector__expand-icon--open {
		transform: rotate(180deg);
	}

	.model-selector__models {
		list-style: none;
		padding: 0;
		margin: 0;
		padding-left: var(--space-md, 12px);
	}

	.model-selector__option {
		display: flex;
		align-items: center;
		gap: var(--space-sm, 8px);
		width: 100%;
		padding: var(--space-sm, 8px) var(--space-md, 12px);
		border-radius: var(--radius-sm, 4px);
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-primary);
		transition: background-color 150ms ease-out;
		background: transparent;
		border: none;
		text-align: left;
	}

	.model-selector__option:hover,
	.model-selector__option:focus {
		background: var(--surface-elevated);
		outline: none;
	}

	.model-selector__option--selected {
		background: var(--surface-elevated);
		font-weight: 500;
	}

	.model-selector__option--focused {
		box-shadow: inset 0 0 0 2px var(--accent);
	}

	.model-selector__option-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}

	.model-selector__check {
		flex-shrink: 0;
		color: var(--accent);
	}

	@keyframes dropdownFadeIn {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes dropdownFadeInBelow {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes sheetSlideUp {
		from {
			transform: translateY(100%);
		}
		to {
			transform: translateY(0);
		}
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

	:global(.dark) .model-selector__dropdown {
		background: var(--surface-page);
		border-color: var(--border-default);
	}

	:global(.dark) .model-selector__provider-header {
		color: var(--text-primary);
	}

	:global(.dark) .model-selector__provider-header:hover,
	:global(.dark) .model-selector__provider-header:focus {
		background: var(--surface-elevated);
	}

	:global(.dark) .model-selector__provider-count {
		background: var(--surface-elevated);
		color: var(--text-muted);
	}

	:global(.dark) .model-selector__option {
		color: var(--text-primary);
	}

	:global(.dark) .model-selector__option:hover,
	:global(.dark) .model-selector__option:focus {
		background: var(--surface-elevated);
	}

	:global(.dark) .model-selector__option--selected {
		background: var(--surface-elevated);
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
