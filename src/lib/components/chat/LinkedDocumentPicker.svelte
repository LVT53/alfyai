<script lang="ts">
import { onMount, untrack } from 'svelte';
import { t } from '$lib/i18n';
import type { KnowledgeDocumentItem, LinkedContextSource } from '$lib/types';

let {
	documents,
	selectedSources = [],
	initialQuery = '',
	loading = false,
	error = '',
	onApply,
	onCancel,
}: {
	documents: KnowledgeDocumentItem[];
	selectedSources?: LinkedContextSource[];
	initialQuery?: string;
	loading?: boolean;
	error?: string;
	onApply: (sources: LinkedContextSource[]) => void;
	onCancel: () => void;
} = $props();

let searchInput = $state<HTMLInputElement | null>(null);
let dialog = $state<HTMLElement | null>(null);
let query = $state(untrack(() => initialQuery));
let selected = $state<LinkedContextSource[]>(
	untrack(() =>
		selectedSources.filter(isPromptReadySource).map((source) => ({ ...source }))
	)
);

let promptReadyDocuments = $derived(documents.filter(isPromptReadyDocument));
let filteredDocuments = $derived.by(() => {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return promptReadyDocuments;
	return promptReadyDocuments.filter((document) =>
		[document.name, document.summary ?? '', document.mimeType ?? '']
			.join(' ')
			.toLowerCase()
			.includes(normalizedQuery)
	);
});

function isPromptReadyDocument(document: KnowledgeDocumentItem): boolean {
	return (
		document.normalizedAvailable &&
		typeof document.promptArtifactId === 'string' &&
		document.promptArtifactId.length > 0
	);
}

function isPromptReadySource(source: LinkedContextSource): boolean {
	return (
		typeof source.promptArtifactId === 'string' && source.promptArtifactId.length > 0
	);
}

function toLinkedSource(document: KnowledgeDocumentItem): LinkedContextSource {
	return {
		displayArtifactId: document.displayArtifactId,
		promptArtifactId: document.promptArtifactId,
		familyArtifactIds: document.familyArtifactIds,
		name: document.name,
		type: 'document',
		mimeType: document.mimeType,
		documentOrigin: document.documentOrigin,
	};
}

function isSelected(document: KnowledgeDocumentItem): boolean {
	return selected.some((source) => source.displayArtifactId === document.displayArtifactId);
}

function toggleDocument(document: KnowledgeDocumentItem) {
	if (isSelected(document)) {
		selected = selected.filter((source) => source.displayArtifactId !== document.displayArtifactId);
		return;
	}
	selected = [...selected, toLinkedSource(document)];
}

function removeSelected(displayArtifactId: string) {
	selected = selected.filter((source) => source.displayArtifactId !== displayArtifactId);
}

function applySelection() {
	onApply(selected.map((source) => ({ ...source, familyArtifactIds: [...source.familyArtifactIds] })));
}

function handleBackdropPointerDown(event: PointerEvent) {
	if (event.target === event.currentTarget) {
		onCancel();
	}
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		onCancel();
		return;
	}
	if (event.key === 'Tab') {
		trapTabNavigation(event);
	}
}

function getFocusableElements(): HTMLElement[] {
	if (!dialog) return [];
	return Array.from(
		dialog.querySelectorAll<HTMLElement>(
			'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
		)
	);
}

function trapTabNavigation(event: KeyboardEvent) {
	const focusableElements = getFocusableElements();
	if (focusableElements.length === 0) return;
	const first = focusableElements[0];
	const last = focusableElements[focusableElements.length - 1];
	const activeElement = document.activeElement;
	if (!(activeElement instanceof Node) || !dialog?.contains(activeElement)) {
		event.preventDefault();
		first.focus();
		return;
	}
	if (event.shiftKey && activeElement === first) {
		event.preventDefault();
		last.focus();
		return;
	}
	if (!event.shiftKey && activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}

onMount(() => {
	setTimeout(() => searchInput?.focus(), 0);
});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="linked-document-backdrop" role="presentation" onpointerdown={handleBackdropPointerDown}>
	<div
		bind:this={dialog}
		class="linked-document-picker"
		role="dialog"
		aria-modal="true"
		aria-labelledby="linked-document-picker-title"
	>
		<header class="linked-document-picker__header">
			<div>
				<h2 id="linked-document-picker-title">{$t('linkedSources.picker.title')}</h2>
				<p>{$t('linkedSources.picker.description')}</p>
			</div>
			<button
				type="button"
				class="linked-document-picker__icon-button"
				aria-label={$t('linkedSources.picker.close')}
				onclick={onCancel}
			>
				<span aria-hidden="true">x</span>
			</button>
		</header>

		<label class="linked-document-picker__search">
			<span>{$t('linkedSources.picker.searchLabel')}</span>
			<input
				bind:this={searchInput}
				type="search"
				bind:value={query}
				placeholder={$t('linkedSources.picker.searchPlaceholder')}
			/>
		</label>

		{#if selected.length > 0}
			<ul class="linked-document-picker__selected" aria-label={$t('linkedSources.selectedList')}>
				{#each selected as source (source.displayArtifactId)}
					<li class="linked-document-picker__selected-chip">
						<span>{source.name}</span>
						<button
							type="button"
							class="linked-document-picker__chip-remove"
							aria-label={$t('linkedSources.removeA11y', { name: source.name })}
							onclick={() => removeSelected(source.displayArtifactId)}
						>
							<span aria-hidden="true">x</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="linked-document-picker__list" role="group" aria-label={$t('linkedSources.picker.results')}>
			{#if loading}
				<p class="linked-document-picker__state" role="status">{$t('linkedSources.picker.loading')}</p>
			{:else if error}
				<p class="linked-document-picker__state linked-document-picker__state--error" role="alert">{error}</p>
			{:else if promptReadyDocuments.length === 0}
				<p class="linked-document-picker__state">{$t('linkedSources.picker.empty')}</p>
			{:else if filteredDocuments.length === 0}
				<p class="linked-document-picker__state">{$t('linkedSources.picker.noMatches')}</p>
			{:else}
				{#each filteredDocuments as document (document.displayArtifactId)}
					<label class="linked-document-picker__row" class:selected={isSelected(document)}>
						<input
							type="checkbox"
							checked={isSelected(document)}
							aria-label={document.name}
							onchange={() => toggleDocument(document)}
						/>
						<span class="linked-document-picker__row-copy">
							<span>{document.name}</span>
							<span>
								{document.documentOrigin === 'generated'
									? $t('linkedSources.type.generated')
									: $t('linkedSources.type.uploaded')}
								{#if document.promptArtifactId}
									 · {$t('linkedSources.promptReady')}
								{/if}
							</span>
						</span>
					</label>
				{/each}
			{/if}
		</div>

		<footer class="linked-document-picker__footer">
			<button type="button" class="linked-document-picker__secondary" onclick={onCancel}>
				{$t('common.cancel')}
			</button>
			<button type="button" class="linked-document-picker__primary" onclick={applySelection}>
				{$t('linkedSources.picker.apply')}
			</button>
		</footer>
	</div>
</div>

<style>
	.linked-document-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		background: rgb(15 23 42 / 0.32);
		padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
			max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
		backdrop-filter: blur(6px);
	}

	.linked-document-picker {
		width: min(600px, 100%);
		max-height: min(680px, calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));
		display: flex;
		flex-direction: column;
		gap: 12px;
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, var(--accent) 18%);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-overlay) 94%, var(--surface-page) 6%);
		box-shadow:
			0 24px 60px rgb(15 23 42 / 0.28),
			0 1px 0 color-mix(in srgb, white 35%, transparent 65%) inset;
		padding: 16px;
		color: var(--text-primary);
		animation: pickerIn 160ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.linked-document-picker__header,
	.linked-document-picker__footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.linked-document-picker__header h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
		color: var(--text-primary);
	}

	.linked-document-picker__header p {
		margin: 3px 0 0;
		color: var(--text-muted);
		font-size: 13px;
	}

	.linked-document-picker__icon-button {
		width: 32px;
		height: 32px;
		display: inline-grid;
		place-items: center;
		flex: 0 0 auto;
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-elevated) 76%, transparent 24%);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.linked-document-picker__icon-button:hover,
	.linked-document-picker__icon-button:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 42%, var(--border-default) 58%);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--accent);
		transform: translateY(-1px);
	}

	.linked-document-picker__icon-button:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent 64%);
		outline: none;
	}

	.linked-document-picker__search {
		display: grid;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.linked-document-picker__search input {
		width: 100%;
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-page) 74%, var(--surface-elevated) 26%);
		padding: 10px 12px;
		color: var(--text-primary);
		transition:
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out);
	}

	.linked-document-picker__search input::placeholder {
		color: var(--text-muted);
	}

	.linked-document-picker__search input:focus {
		border-color: var(--accent);
		background: var(--surface-overlay);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent 82%);
		outline: none;
	}

	.linked-document-picker__selected {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.linked-document-picker__selected-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		max-width: 100%;
		border: 1px solid color-mix(in srgb, var(--accent) 36%, var(--border-default) 64%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 10%, var(--surface-elevated) 90%);
		padding: 4px 6px 4px 10px;
		font-size: 12px;
		color: var(--text-primary);
	}

	.linked-document-picker__chip-remove {
		width: 1.45rem;
		height: 1.45rem;
		display: inline-grid;
		place-items: center;
		flex-shrink: 0;
		border: 0;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-page) 68%, transparent 32%);
		color: var(--text-muted);
		cursor: pointer;
		font-size: 11px;
		font-weight: 650;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.linked-document-picker__chip-remove:hover,
	.linked-document-picker__chip-remove:focus-visible {
		background: color-mix(in srgb, var(--accent) 18%, var(--surface-page) 82%);
		color: var(--accent);
		transform: translateY(-1px);
	}

	.linked-document-picker__chip-remove:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent 64%);
		outline: none;
	}

	.linked-document-picker__selected-chip span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.linked-document-picker__list {
		min-height: 160px;
		overflow: auto;
		border: 1px solid color-mix(in srgb, var(--border-default) 72%, transparent 28%);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-page) 72%, var(--surface-elevated) 28%);
	}

	.linked-document-picker__row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent 18%);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.linked-document-picker__row:last-child {
		border-bottom: 0;
	}

	.linked-document-picker__row:hover,
	.linked-document-picker__row:focus-within {
		background: color-mix(in srgb, var(--surface-overlay) 94%, var(--accent) 6%);
	}

	.linked-document-picker__row.selected {
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
	}

	.linked-document-picker__row input {
		width: 1rem;
		height: 1rem;
		margin-top: 0.1rem;
		accent-color: var(--accent);
	}

	.linked-document-picker__row-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
		font-size: 13px;
	}

	.linked-document-picker__row-copy span:first-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
		font-weight: 550;
	}

	.linked-document-picker__row-copy span:last-child,
	.linked-document-picker__state {
		color: var(--text-muted);
		font-size: 12px;
	}

	.linked-document-picker__state {
		margin: 0;
		padding: 20px 12px;
		text-align: center;
	}

	.linked-document-picker__state--error {
		color: var(--danger);
	}

	.linked-document-picker__secondary,
	.linked-document-picker__primary {
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 9px 12px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.linked-document-picker__secondary {
		border-color: color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		background: color-mix(in srgb, var(--surface-elevated) 72%, transparent 28%);
		color: var(--text-primary);
	}

	.linked-document-picker__primary {
		border-color: var(--accent);
		background: var(--accent);
		color: #fff;
	}

	.linked-document-picker__secondary:hover,
	.linked-document-picker__secondary:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-default) 60%);
		background: color-mix(in srgb, var(--accent) 10%, var(--surface-elevated) 90%);
		color: var(--accent);
		transform: translateY(-1px);
	}

	.linked-document-picker__primary:hover,
	.linked-document-picker__primary:focus-visible {
		border-color: var(--accent-hover);
		background: var(--accent-hover);
		transform: translateY(-1px);
	}

	.linked-document-picker__secondary:focus-visible,
	.linked-document-picker__primary:focus-visible {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus-ring) 24%, transparent 76%);
		outline: none;
	}

	.linked-document-picker__secondary:active,
	.linked-document-picker__primary:active,
	.linked-document-picker__icon-button:active,
	.linked-document-picker__chip-remove:active {
		transform: translateY(0);
	}

	:global(.dark) .linked-document-backdrop {
		background: rgb(0 0 0 / 0.48);
	}

	:global(.dark) .linked-document-picker {
		background: color-mix(in srgb, var(--surface-overlay) 92%, #111 8%);
		box-shadow:
			0 24px 64px rgb(0 0 0 / 0.54),
			0 1px 0 color-mix(in srgb, white 8%, transparent 92%) inset;
	}

	:global(.dark) .linked-document-picker__list {
		background: color-mix(in srgb, var(--surface-page) 62%, var(--surface-elevated) 38%);
	}

	:global(.dark) .linked-document-picker__chip-remove {
		background: color-mix(in srgb, var(--surface-elevated) 72%, transparent 28%);
	}

	@keyframes pickerIn {
		from {
			opacity: 0;
			transform: translateY(0.5rem) scale(0.985);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@media (min-width: 768px) {
		.linked-document-backdrop {
			align-items: center;
		}
	}

	@media (max-width: 640px) {
		.linked-document-backdrop {
			background: rgb(15 23 42 / 0.34);
			padding-top: max(10px, env(safe-area-inset-top));
		}

		.linked-document-picker {
			width: 100%;
			max-height: min(76dvh, calc(100dvh - 20px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));
			border-radius: 12px 12px 10px 10px;
			padding: 12px;
		}

		.linked-document-picker__header {
			align-items: flex-start;
		}

		.linked-document-picker__header p {
			display: none;
		}

		.linked-document-picker__list {
			min-height: 0;
			max-height: 42dvh;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.linked-document-picker,
		.linked-document-picker__icon-button,
		.linked-document-picker__chip-remove,
		.linked-document-picker__secondary,
		.linked-document-picker__primary,
		.linked-document-picker__row {
			animation: none;
			transition: none;
		}
	}
</style>
