<script lang="ts">
	import { onMount } from 'svelte';
	import ModelSelector from './ModelSelector.svelte';
	import { t } from '$lib/i18n';
	import {
		getPersonalityProfileDisplayDescription,
		getPersonalityProfileDisplayName,
	} from '$lib/utils/personality-profile-labels';
	import type { ThinkingMode } from '$lib/types';

	let {
		canAttach = false,
		attachmentsEnabled = false,
		onClose,
		onAttach,
		personalityProfiles = [],
		selectedPersonalityId = null,
		onPersonalityChange = undefined,
		thinkingMode = 'auto',
		onThinkingModeChange = undefined,
		initialOpen = null,
	}: {
		canAttach?: boolean;
		attachmentsEnabled?: boolean;
		onClose?: () => void;
		onAttach?: () => void;
		personalityProfiles?: Array<{ id: string; name: string; description: string }>;
		selectedPersonalityId?: string | null;
		onPersonalityChange?: ((id: string | null) => void) | undefined;
		thinkingMode?: ThinkingMode;
		onThinkingModeChange?: ((mode: ThinkingMode) => void) | undefined;
		initialOpen?: 'model' | 'style' | 'thinking' | null;
	} = $props();

	let root = $state<HTMLDivElement | undefined>(undefined);
	let activeDropdown = $state<'model' | 'style' | 'thinking' | null>(null);
	let appliedInitialOpen = $state<'model' | 'style' | 'thinking' | null>(null);
	let styleOpen = $derived(activeDropdown === 'style');
	let thinkingOpen = $derived(activeDropdown === 'thinking');

	let selectedProfile = $derived(
		personalityProfiles.find((p) => p.id === selectedPersonalityId) ?? null,
	);
	let selectedThinkingLabel = $derived(
		thinkingMode === 'on'
			? $t('composerTools.thinkingOn')
			: thinkingMode === 'off'
				? $t('composerTools.thinkingOff')
				: $t('composerTools.thinkingAuto'),
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

	function handleAttach() {
		onAttach?.();
		onClose?.();
	}

	function selectThinkingMode(mode: ThinkingMode) {
		onThinkingModeChange?.(mode);
		closeMenu();
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
			onSelect={closeMenu}
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
							onkeydown={(e) => e.key === 'Enter' && (onPersonalityChange?.(null), closeMenu())}
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
								onkeydown={(e) => e.key === 'Enter' && (onPersonalityChange?.(profile.id), closeMenu())}
								tabindex="0"
							>{getPersonalityProfileDisplayName(profile, $t)}</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{/if}

	<div class="menu-row menu-row--static">
		<div class="menu-label">{$t('composerTools.thinking')}</div>
		<div class="model-selector">
			<button
				type="button"
				class="model-selector__trigger"
				onclick={() => activeDropdown = thinkingOpen ? null : 'thinking'}
				aria-haspopup="listbox"
				aria-expanded={thinkingOpen}
			>
				<span class="model-selector__text">{selectedThinkingLabel}</span>
				<svg
					class="model-selector__chevron"
					class:model-selector__chevron--open={thinkingOpen}
					xmlns="http://www.w3.org/2000/svg"
					width="16" height="16" viewBox="0 0 24 24"
					fill="none" stroke="currentColor"
					stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>
			{#if thinkingOpen}
				<ul class="model-selector__dropdown" role="listbox" aria-label={$t('composerTools.thinking')}>
					<li
						role="option"
						aria-selected={thinkingMode === 'auto'}
						class="model-selector__option"
						class:model-selector__option--selected={thinkingMode === 'auto'}
						onclick={() => selectThinkingMode('auto')}
						onkeydown={(e) => e.key === 'Enter' && selectThinkingMode('auto')}
						tabindex="0"
					>{$t('composerTools.thinkingAuto')}</li>
					<li
						role="option"
						aria-selected={thinkingMode === 'on'}
						class="model-selector__option"
						class:model-selector__option--selected={thinkingMode === 'on'}
						onclick={() => selectThinkingMode('on')}
						onkeydown={(e) => e.key === 'Enter' && selectThinkingMode('on')}
						tabindex="0"
					>{$t('composerTools.thinkingOn')}</li>
					<li
						role="option"
						aria-selected={thinkingMode === 'off'}
						class="model-selector__option"
						class:model-selector__option--selected={thinkingMode === 'off'}
						onclick={() => selectThinkingMode('off')}
						onkeydown={(e) => e.key === 'Enter' && selectThinkingMode('off')}
						tabindex="0"
					>{$t('composerTools.thinkingOff')}</li>
				</ul>
			{/if}
		</div>
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
				<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
				</svg>
			</span>
		</button>
	</div>
</div>

<style>
	.tools-menu {
		position: absolute;
		left: 0;
		bottom: calc(100% + 10px);
		z-index: 40;
		width: min(17rem, calc(100vw - 2rem));
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		border-radius: 0.9rem;
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		box-shadow: var(--shadow-lg);
		padding: 0.45rem;
		backdrop-filter: blur(14px);
		animation: menuFadeIn 140ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.menu-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		border-radius: 0.72rem;
		padding: 0.08rem;
	}

	.menu-row + .menu-row {
		margin-top: 0.08rem;
	}

	.menu-row--static {
		padding: 0.5rem 0.62rem;
	}

	.menu-row--button {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		padding: 0.5rem 0.62rem;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
	}

	.menu-row--button:hover:not(:disabled),
	.menu-row--button:focus-visible {
		background: color-mix(in srgb, var(--surface-page) 78%, var(--surface-elevated) 22%);
		box-shadow: 0 0 0 2px var(--focus-ring);
		outline: none;
	}

	.menu-row--button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.menu-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.88rem;
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
		bottom: 100%;
		left: 0;
		margin: 0 0 var(--space-xs, 4px);
		padding: var(--space-xs, 4px);
		background: var(--bg-primary, #ffffff);
		display: flex;
		flex-direction: column;
		gap: 4px;
		border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
		border-radius: var(--radius-md, 8px);
		box-shadow: var(--shadow-lg, 0 4px 16px rgba(0, 0, 0, 0.08));
		list-style: none;
		min-width: 100%;
		z-index: 100;
		animation: dropdownFadeIn 150ms ease-out;
	}

	.model-selector__option {
		padding: var(--space-sm, 8px) var(--space-md, 16px);
		border-radius: var(--radius-sm, 4px);
		cursor: pointer;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 14px;
		color: var(--text-primary, #1a1a1a);
		transition: background-color 150ms ease-out;
		white-space: nowrap;
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

	.menu-row :global(.model-selector__trigger) {
		min-height: 32px;
		padding: 0.35rem 0.55rem;
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
		border-color: var(--border, rgba(255, 255, 255, 0.08));
	}

	:global(.dark) .model-selector__trigger:hover:not(:disabled) {
		background: var(--bg-hover, #333333);
	}

	:global(.dark) .model-selector__dropdown {
		background: var(--bg-primary, #1a1a1a);
		border-color: var(--border, rgba(255, 255, 255, 0.08));
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
