<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import { t } from "$lib/i18n";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import {
	fetchAvailableModels,
	type ModelProvider,
	type ProviderModel,
} from "$lib/client/api/models";
import {
	selectedModel,
	setSelectedModel,
	type ModelId,
} from "$lib/stores/settings";

let {
	onSelect,
	open = undefined,
	onOpenChange = undefined,
}: {
	onSelect?: (payload: { modelId: ModelId }) => void;
	open?: boolean | undefined;
	onOpenChange?: ((open: boolean) => void) | undefined;
} = $props();

let providers = $state<ModelProvider[]>([]);
let internalOpen = $state(false);
let isLoading = $state(true);
let error = $state<string | null>(null);
let dropdownRef = $state<HTMLDivElement | undefined>(undefined);
let expandedProviders = $state<Set<string>>(new Set());
let focusedModelId = $state<string | null>(null);
let isMobile = $state(false);
let isOpen = $derived(open ?? internalOpen);

function setOpen(nextOpen: boolean) {
	if (open === undefined) {
		internalOpen = nextOpen;
	}
	onOpenChange?.(nextOpen);
	if (!nextOpen) {
		focusedModelId = null;
	}
}

function checkMobile() {
	isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
}

onMount(async () => {
	checkMobile();
	window.addEventListener("resize", checkMobile);

	try {
		const response = await fetchAvailableModels();
		providers = response.providers;

		const currentModelId = $selectedModel;
		const modelExists = providers.some((p) =>
			p.models.some((m) => m.id === currentModelId),
		);
		if (!modelExists && providers.length > 0) {
			const firstProvider = providers[0];
			const firstModel = firstProvider.models[0];
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

	const handleClickOutside = (event: MouseEvent) => {
		if (!dropdownRef || dropdownRef.contains(event.target as Node)) return;
		untrack(() => { if (isOpen) setOpen(false); });
	};

	document.addEventListener("click", handleClickOutside);
	return () => {
		document.removeEventListener("click", handleClickOutside);
		window.removeEventListener("resize", checkMobile);
	};
});

const activeProvider = $derived(() => {
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
	const element = dropdownRef?.querySelector(
		`[data-model-id="${focusedModelId}"]`,
	);
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
	<button
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
		{:else if activeProvider()}
			{@const active = activeProvider()}
			<ModelIcon
				iconUrl={active.model.iconUrl ?? active.provider.iconUrl ?? null}
				displayName={active.model.displayName}
				size={22}
			/>
			<span class="model-selector__text">{active.model.displayName}</span>
		{:else}
			<span class="model-selector__text">Select model</span>
		{/if}
		<svg
			class="model-selector__chevron"
			class:model-selector__chevron--open={isOpen}
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	</button>

	{#if isOpen && providers.length > 0}
		<div
			class="model-selector__dropdown"
			class:model-selector__dropdown--mobile={isMobile}
			role="listbox"
			aria-label={$t('modelSelector.availableModels')}
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
							<span class="model-selector__provider-count">{provider.models.length}</span>
							<svg
								class="model-selector__expand-icon"
								class:model-selector__expand-icon--open={expanded}
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<polyline points="6 9 12 15 18 9" />
							</svg>
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
												<svg
													class="model-selector__check"
													xmlns="http://www.w3.org/2000/svg"
													width="14"
													height="14"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="3"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<polyline points="20 6 9 17 4 12" />
												</svg>
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
</div>

<style>
	.model-selector {
		position: relative;
		display: inline-block;
	}

	.model-selector__trigger {
		display: flex;
		align-items: center;
		gap: var(--space-xs, 4px);
		min-width: 0;
		padding: var(--space-sm, 8px) 10px;
		background: transparent;
		border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
		border-radius: var(--radius-md, 8px);
		color: var(--text-primary, #1a1a1a);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 14px;
		font-weight: 400;
		cursor: pointer;
		transition: all 150ms ease-out;
		min-height: 36px;
	}

	.model-selector__trigger:hover:not(:disabled) {
		background: var(--bg-hover, #eeedea);
		border-color: var(--border, rgba(0, 0, 0, 0.08));
	}

	.model-selector__trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--border-focus, #c15f3c);
	}

	.model-selector__trigger:disabled {
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
		color: var(--text-secondary, #6b6b6b);
		margin-left: 4px;
	}

	.model-selector__chevron--open {
		transform: rotate(180deg);
	}

	.model-selector__dropdown {
		position: absolute;
		top: 0;
		left: 100%;
		margin-left: var(--space-xs, 4px);
		background: var(--bg-primary, #ffffff);
		border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
		border-radius: var(--radius-md, 8px);
		box-shadow: var(--shadow-lg, 0 4px 16px rgba(0, 0, 0, 0.08));
		min-width: 280px;
		max-width: 320px;
		max-height: 400px;
		z-index: 100;
		animation: dropdownFadeIn 150ms ease-out;
		display: flex;
		flex-direction: column;
		overflow: hidden;
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
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 14px;
		color: var(--text-primary, #1a1a1a);
		transition: background-color 150ms ease-out;
		background: transparent;
		border: none;
		text-align: left;
	}

	.model-selector__provider-header:hover,
	.model-selector__provider-header:focus {
		background: var(--bg-hover, #eeedea);
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
		font-size: 12px;
		color: var(--text-secondary, #6b6b6b);
		background: var(--bg-secondary, #f5f5f5);
		padding: 2px 6px;
		border-radius: var(--radius-sm, 4px);
		flex-shrink: 0;
	}

	.model-selector__expand-icon {
		flex-shrink: 0;
		transition: transform 200ms ease-out;
		color: var(--text-secondary, #6b6b6b);
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
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 14px;
		color: var(--text-primary, #1a1a1a);
		transition: background-color 150ms ease-out;
		background: transparent;
		border: none;
		text-align: left;
	}

	.model-selector__option:hover,
	.model-selector__option:focus {
		background: var(--bg-hover, #eeedea);
		outline: none;
	}

	.model-selector__option--selected {
		background: var(--bg-hover, #eeedea);
		font-weight: 500;
	}

	.model-selector__option--focused {
		box-shadow: inset 0 0 0 2px var(--border-focus, #c15f3c);
	}

	.model-selector__option-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}

	.model-selector__check {
		flex-shrink: 0;
		color: var(--border-focus, #c15f3c);
	}

	@keyframes dropdownFadeIn {
		from {
			opacity: 0;
			transform: translateX(-4px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
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
		color: var(--text-primary, #ececec);
		border-color: var(--border, rgba(255, 255, 255, 0.08));
	}

	:global(.dark) .model-selector__trigger:hover:not(:disabled) {
		background: var(--bg-hover, #333333);
	}

	:global(.dark) .model-selector__dropdown {
		background: var(--bg-primary, #1a1a1a);
		border-color: var(--border, rgba(255, 255, 255, 0.08));
	}

	:global(.dark) .model-selector__provider-header {
		color: var(--text-primary, #ececec);
	}

	:global(.dark) .model-selector__provider-header:hover,
	:global(.dark) .model-selector__provider-header:focus {
		background: var(--bg-hover, #333333);
	}

	:global(.dark) .model-selector__provider-count {
		background: var(--bg-hover, #333333);
		color: var(--text-secondary, #888888);
	}

	:global(.dark) .model-selector__option {
		color: var(--text-primary, #ececec);
	}

	:global(.dark) .model-selector__option:hover,
	:global(.dark) .model-selector__option:focus {
		background: var(--bg-hover, #333333);
	}

	:global(.dark) .model-selector__option--selected {
		background: var(--bg-hover, #333333);
	}

	/* Mobile adjustments */
	@media (max-width: 768px) {
		.model-selector__trigger {
			min-height: 44px;
			padding: var(--space-sm, 8px) var(--space-md, 12px);
		}

		.model-selector__text {
			max-width: 100px;
		}
	}

</style>
