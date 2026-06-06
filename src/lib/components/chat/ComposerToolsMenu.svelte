<script lang="ts">
	import { onMount } from 'svelte';
	import ModelSelector from './ModelSelector.svelte';
	import { t } from '$lib/i18n';
	import {
		getPersonalityProfileDisplayDescription,
		getPersonalityProfileDisplayName,
	} from '$lib/utils/personality-profile-labels';
	import type { ModelId, ReasoningDepth } from '$lib/types';

	let {
		canAttach = false,
		attachmentsEnabled = false,
		onClose,
		onAttach,
		personalityProfiles = [],
		selectedPersonalityId = null,
		onPersonalityChange = undefined,
		onModelChange = undefined,
		reasoningDepth = 'auto',
		onReasoningDepthChange = undefined,
		initialOpen = null,
		forceWebSearch = false,
		onForceWebSearchChange = undefined,
	}: {
		canAttach?: boolean;
		attachmentsEnabled?: boolean;
		onClose?: () => void;
		onAttach?: () => void;
		personalityProfiles?: Array<{ id: string; name: string; description: string }>;
		selectedPersonalityId?: string | null;
		onPersonalityChange?: ((id: string | null) => void) | undefined;
		onModelChange?: ((modelId: ModelId) => void) | undefined;
		reasoningDepth?: ReasoningDepth;
		onReasoningDepthChange?: ((depth: ReasoningDepth) => void) | undefined;
		initialOpen?: 'model' | 'style' | 'depth' | null;
		forceWebSearch?: boolean;
		onForceWebSearchChange?: ((enabled: boolean) => void) | undefined;
	} = $props();

	let root = $state<HTMLDivElement | undefined>(undefined);
	let activeDropdown = $state<'model' | 'style' | 'depth' | null>(null);
	let appliedInitialOpen = $state<'model' | 'style' | 'depth' | null>(null);
	let styleOpen = $derived(activeDropdown === 'style');
	let depthOpen = $derived(activeDropdown === 'depth');

	let selectedProfile = $derived(
		personalityProfiles.find((p) => p.id === selectedPersonalityId) ?? null,
	);
	let selectedReasoningDepthLabel = $derived(
		reasoningDepth === 'max'
			? $t('composerTools.reasoningDepthMax')
			: reasoningDepth === 'off'
				? $t('composerTools.reasoningDepthOff')
				: $t('composerTools.reasoningDepthAuto'),
	);

	$effect(() => {
		if (initialOpen === appliedInitialOpen) return;
		activeDropdown = initialOpen;
		appliedInitialOpen = initialOpen;
	});

	function closeMenu() {
		activeDropdown = null;
		onClose?.();
	}

	function selectModel(payload: { modelId: ModelId }) {
		onModelChange?.(payload.modelId);
		closeMenu();
	}

	function handleAttach() {
		onAttach?.();
		onClose?.();
	}

	function selectReasoningDepth(depth: ReasoningDepth) {
		onReasoningDepthChange?.(depth);
		closeMenu();
	}

	function toggleWebSearch() {
		onForceWebSearchChange?.(!forceWebSearch);
		onClose?.();
	}

	onMount(() => {
		const handlePointerDown = (event: MouseEvent | TouchEvent) => {
			if (root && !root.contains(event.target as Node)) {
				activeDropdown = null;
				onClose?.();
			}
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				onClose?.();
			}
		};

		document.addEventListener('mousedown', handlePointerDown);
		document.addEventListener('touchstart', handlePointerDown, { passive: true });
		window.addEventListener('keydown', handleKeyDown);

		return () => {
			document.removeEventListener('mousedown', handlePointerDown);
			document.removeEventListener('touchstart', handlePointerDown);
			window.removeEventListener('keydown', handleKeyDown);
		};
	});
</script>

<div bind:this={root} class="tools-menu" role="menu" aria-label={$t('composerTools.menu')}>
	<div class="menu-row menu-row--static">
		<div class="menu-label">{$t('composerTools.model')}</div>
		<ModelSelector
			open={activeDropdown === 'model'}
			onOpenChange={(open) => activeDropdown = open ? 'model' : null}
			onSelect={selectModel}
		/>
	</div>

	{#if personalityProfiles.length > 0}
		<div class="menu-row menu-row--static">
			<div class="menu-label">{$t('composerTools.style')}</div>
			<div class="model-selector">
				<button
					type="button"
					class="model-selector__trigger"
					onclick={() => activeDropdown = styleOpen ? null : 'style'}
					aria-haspopup="listbox"
					aria-expanded={styleOpen}
				>
					<span class="model-selector__text">
						{selectedProfile
							? getPersonalityProfileDisplayName(selectedProfile, $t)
							: $t('composerTools.defaultStyle')}
					</span>
					<svg
						class="model-selector__chevron"
						class:model-selector__chevron--open={styleOpen}
						xmlns="http://www.w3.org/2000/svg"
						width="16" height="16" viewBox="0 0 24 24"
						fill="none" stroke="currentColor"
						stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
					>
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</button>
				{#if styleOpen}
					<ul class="model-selector__dropdown" role="listbox">
						<li
							role="option"
							aria-selected={!selectedPersonalityId}
							class="model-selector__option"
							class:model-selector__option--selected={!selectedPersonalityId}
							onclick={() => { onPersonalityChange?.(null); closeMenu(); }}
						onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (onPersonalityChange?.(null), closeMenu())}
						tabindex="0"
					>{$t('composerTools.defaultStyle')}</li>
					{#each personalityProfiles as profile}
						<li
							role="option"
							aria-selected={selectedPersonalityId === profile.id}
							class="model-selector__option"
							class:model-selector__option--selected={selectedPersonalityId === profile.id}
							title={getPersonalityProfileDisplayDescription(profile, $t)}
							onclick={() => { onPersonalityChange?.(profile.id); closeMenu(); }}
							onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (onPersonalityChange?.(profile.id), closeMenu())}
							tabindex="0"
						>{getPersonalityProfileDisplayName(profile, $t)}</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{/if}

	<div class="menu-row menu-row--static">
		<div class="menu-label">{$t('composerTools.reasoningDepth')}</div>
		<div class="model-selector">
			<button
				type="button"
				class="model-selector__trigger"
				onclick={() => activeDropdown = depthOpen ? null : 'depth'}
				aria-haspopup="listbox"
				aria-expanded={depthOpen}
			>
				<span class="model-selector__text">{selectedReasoningDepthLabel}</span>
				<svg
					class="model-selector__chevron"
					class:model-selector__chevron--open={depthOpen}
					xmlns="http://www.w3.org/2000/svg"
					width="16" height="16" viewBox="0 0 24 24"
					fill="none" stroke="currentColor"
					stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>
			{#if depthOpen}
				<ul class="model-selector__dropdown" role="listbox" aria-label={$t('composerTools.reasoningDepth')}>
					<li
						role="option"
						aria-selected={reasoningDepth === 'off'}
						class="model-selector__option"
						class:model-selector__option--selected={reasoningDepth === 'off'}
						onclick={() => selectReasoningDepth('off')}
						onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectReasoningDepth('off')}
						tabindex="0"
					>{$t('composerTools.reasoningDepthOff')}</li>
					<li
						role="option"
						aria-selected={reasoningDepth === 'auto'}
						class="model-selector__option"
						class:model-selector__option--selected={reasoningDepth === 'auto'}
						onclick={() => selectReasoningDepth('auto')}
						onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectReasoningDepth('auto')}
						tabindex="0"
					>{$t('composerTools.reasoningDepthAuto')}</li>
					<li
						role="option"
						aria-selected={reasoningDepth === 'max'}
						class="model-selector__option"
						class:model-selector__option--selected={reasoningDepth === 'max'}
						onclick={() => selectReasoningDepth('max')}
						onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectReasoningDepth('max')}
						tabindex="0"
					>{$t('composerTools.reasoningDepthMax')}</li>
				</ul>
			{/if}
		</div>
	</div>

	<div class="menu-row">
		<button
			type="button"
			class="menu-row menu-row--button"
			class:menu-row--selected={forceWebSearch}
			onclick={toggleWebSearch}
			aria-label={$t('composerTools.webSearch')}
			aria-checked={forceWebSearch}
			role="menuitemcheckbox"
		>
			<span class="menu-label">{$t('composerTools.webSearch')}</span>
			<span class="menu-icon" aria-hidden="true">
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10" />
					<path d="M2 12h20" />
					<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
				</svg>
			</span>
		</button>
	</div>

	<div class="menu-row">
		<button
			type="button"
			class="menu-row menu-row--button"
			onclick={handleAttach}
			disabled={!canAttach}
			title={attachmentsEnabled ? $t('composerTools.attachFileMaxSize') : $t('composerTools.uploadsUnavailable')}
			aria-label={$t('composerTools.attachFile')}
			role="menuitem"
		>
			<span class="menu-label">{$t('composerTools.attachFile')}</span>
			<span class="menu-icon" aria-hidden="true">
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
				</svg>
			</span>
		</button>
	</div>
</div>

<style>
	.tools-menu {
		--tools-menu-row-height: 2.75rem;

		position: absolute;
		left: 0;
		bottom: calc(100% + 8px);
		z-index: 40;
		width: min(15.75rem, calc(100vw - 2rem));
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, var(--surface-page) 24%);
		border-radius: 0.72rem;
		background: color-mix(in srgb, var(--surface-overlay) 88%, var(--surface-page) 12%);
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
		padding: 0.32rem;
		backdrop-filter: blur(14px);
		animation: menuFadeIn 140ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	:global(.dark) .tools-menu {
		background: color-mix(in srgb, var(--surface-overlay) 78%, #050505 22%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
		box-shadow:
			0 16px 32px rgba(0, 0, 0, 0.4),
			0 0 0 1px color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	.menu-row {
		display: flex;
		min-height: var(--tools-menu-row-height);
		align-items: center;
		justify-content: space-between;
		gap: 0.42rem;
		border-radius: 0.5rem;
		padding: 0.04rem;
	}

	.menu-row + .menu-row {
		margin-top: 0.06rem;
	}

	.menu-row--static {
		padding: 0.38rem 0.5rem;
	}

	.menu-row--button {
		display: flex;
		width: 100%;
		min-height: calc(var(--tools-menu-row-height) - 0.08rem);
		align-items: center;
		justify-content: space-between;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		padding: 0.38rem 0.5rem;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
	}

	.menu-row--button:hover:not(:disabled),
	.menu-row--button:focus-visible,
	.menu-row--selected {
		background: rgba(194, 166, 106, 0.24);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 34%, transparent 66%);
		transform: translateY(-1px);
		outline: none;
	}

	:global(.dark) .menu-row--button:hover:not(:disabled),
	:global(.dark) .menu-row--button:focus-visible,
	:global(.dark) .menu-row--selected {
		background: rgba(194, 166, 106, 0.3);
	}

	.menu-row--button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.menu-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.78rem;
		line-height: 1.15;
		color: var(--text-primary);
	}

	.model-selector {
		position: relative;
		display: inline-block;
	}

	.model-selector__trigger {
		display: flex;
		align-items: center;
		gap: var(--space-xs, 4px);
		padding: 0.3rem 0.48rem;
		background: transparent;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 0.5rem;
		color: var(--text-primary, #1a1a1a);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.78rem;
		font-weight: 400;
		cursor: pointer;
		transition: all 150ms ease-out;
		min-height: 30px;
	}

	.model-selector__trigger:hover:not(:disabled) {
		background: rgba(194, 166, 106, 0.18);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
	}

	.model-selector__trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 34%, transparent 66%);
	}

	.model-selector__text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 108px;
	}

	.model-selector__chevron {
		flex-shrink: 0;
		transition: transform 200ms ease-out;
		color: var(--text-secondary, #6b6b6b);
		margin-left: 2px;
	}

	.model-selector__chevron--open {
		transform: rotate(180deg);
	}

	.model-selector__dropdown {
		position: absolute;
		bottom: 100%;
		left: 0;
		margin: 0 0 0.25rem;
		padding: 0.24rem;
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 0.55rem;
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
		list-style: none;
		min-width: 100%;
		z-index: 100;
		animation: dropdownFadeIn 150ms ease-out;
	}

	.model-selector__option {
		padding: 0.38rem 0.5rem;
		border-radius: 0.42rem;
		cursor: pointer;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.78rem;
		line-height: 1.15;
		color: var(--text-primary, #1a1a1a);
		transition: background-color 150ms ease-out;
		white-space: nowrap;
	}

	.model-selector__option:hover,
	.model-selector__option:focus {
		background: rgba(194, 166, 106, 0.24);
		outline: none;
	}

	.model-selector__option--selected {
		background: rgba(194, 166, 106, 0.18);
		font-weight: 500;
	}

	.menu-row :global(.model-selector__trigger) {
		min-height: 30px;
		padding: 0.3rem 0.48rem;
		gap: var(--space-xs, 4px);
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 0.5rem;
		background: transparent;
		font-size: 0.78rem;
		line-height: 1.15;
	}

	.menu-row :global(.model-selector__trigger:hover:not(:disabled)) {
		background: rgba(194, 166, 106, 0.18);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
	}

	.menu-row :global(.model-selector__trigger:focus-visible) {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 34%, transparent 66%);
	}

	.menu-row :global(.model-selector__text) {
		max-width: 108px;
	}

	.menu-row :global(.model-selector__chevron) {
		width: 16px;
		height: 16px;
		margin-left: 2px;
	}

	.menu-row :global(.model-selector__dropdown) {
		margin: 0 0 0.25rem;
		padding: 0.24rem;
		gap: 0.12rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 0.55rem;
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	.menu-row :global(.model-selector__option) {
		border-radius: 0.42rem;
		padding: 0.38rem 0.5rem;
		font-size: 0.78rem;
		line-height: 1.15;
	}

	.menu-row :global(.model-selector__option:hover),
	.menu-row :global(.model-selector__option:focus) {
		background: rgba(194, 166, 106, 0.24);
	}

	.menu-row :global(.model-selector__option--selected) {
		background: rgba(194, 166, 106, 0.18);
	}

	.menu-row :global(.provider-icon) {
		width: 11px;
		height: 11px;
		margin-right: 0.35rem;
	}

	.menu-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		transition:
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.menu-row--button:hover:not(:disabled) .menu-icon,
	.menu-row--button:focus-visible .menu-icon {
		color: var(--accent);
		transform: translateY(-1px);
	}

	:global(.dark) .model-selector__trigger {
		color: var(--text-primary, #ececec);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	:global(.dark) .model-selector__trigger:hover:not(:disabled) {
		background: rgba(194, 166, 106, 0.26);
	}

	:global(.dark) .menu-row :global(.model-selector__trigger) {
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	:global(.dark) .menu-row :global(.model-selector__trigger:hover:not(:disabled)) {
		background: rgba(194, 166, 106, 0.26);
	}

	:global(.dark) .model-selector__dropdown {
		background: color-mix(in srgb, var(--surface-overlay) 78%, #050505 22%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	:global(.dark) .menu-row :global(.model-selector__dropdown) {
		background: color-mix(in srgb, var(--surface-overlay) 78%, #050505 22%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	:global(.dark) .model-selector__option {
		color: var(--text-primary, #ececec);
	}

	:global(.dark) .model-selector__option:hover,
	:global(.dark) .model-selector__option:focus {
		background: rgba(194, 166, 106, 0.3);
	}

	:global(.dark) .menu-row :global(.model-selector__option:hover),
	:global(.dark) .menu-row :global(.model-selector__option:focus) {
		background: rgba(194, 166, 106, 0.3);
	}

	:global(.dark) .model-selector__option--selected {
		background: rgba(194, 166, 106, 0.24);
	}

	:global(.dark) .menu-row :global(.model-selector__option--selected) {
		background: rgba(194, 166, 106, 0.24);
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

	@keyframes menuFadeIn {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.tools-menu {
			animation: none;
		}

		.model-selector__dropdown {
			animation: none;
		}

		.menu-row--button,
		.menu-icon,
		.model-selector__trigger,
		.model-selector__chevron,
		.model-selector__option {
			transition: none;
		}
	}
</style>
