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
	untrack(() => selectedSources.map((source) => ({ ...source })))
);

let filteredDocuments = $derived.by(() => {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return documents;
	return documents.filter((document) =>
		[document.name, document.summary ?? '', document.mimeType ?? '']
			.join(' ')
			.toLowerCase()
			.includes(normalizedQuery)
	);
});

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
					<li>
						<span>{source.name}</span>
						<button
							type="button"
							aria-label={$t('linkedSources.removeA11y', { name: source.name })}
							onclick={() => removeSelected(source.displayArtifactId)}
						>
							{$t('linkedSources.remove')}
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
			{:else if documents.length === 0}
				<p class="linked-document-picker__state">{$t('linkedSources.picker.empty')}</p>
			{:else if filteredDocuments.length === 0}
				<p class="linked-document-picker__state">{$t('linkedSources.picker.noMatches')}</p>
			{:else}
				{#each filteredDocuments as document (document.displayArtifactId)}
					<label class="linked-document-picker__row">
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
		background: rgb(15 23 42 / 0.18);
		padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
			max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
	}

	.linked-document-picker {
		width: min(560px, 100%);
		max-height: min(680px, calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));
		display: flex;
		flex-direction: column;
		gap: 12px;
		border: 1px solid var(--color-border, #d8dee8);
		border-radius: 12px;
		background: var(--color-surface-elevated, #fff);
		box-shadow: 0 24px 60px rgb(15 23 42 / 0.24);
		padding: 16px;
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
	}

	.linked-document-picker__header p {
		margin: 3px 0 0;
		color: var(--color-text-muted, #667085);
		font-size: 13px;
	}

	.linked-document-picker__icon-button,
	.linked-document-picker__selected button {
		border: 1px solid var(--color-border, #d8dee8);
		background: transparent;
		color: var(--color-text-muted, #667085);
		border-radius: 8px;
	}

	.linked-document-picker__icon-button {
		width: 32px;
		height: 32px;
	}

	.linked-document-picker__search {
		display: grid;
		gap: 6px;
		font-size: 12px;
		color: var(--color-text-muted, #667085);
	}

	.linked-document-picker__search input {
		width: 100%;
		border: 1px solid var(--color-border, #d8dee8);
		border-radius: 8px;
		padding: 10px 12px;
		color: var(--color-text-primary, #101828);
	}

	.linked-document-picker__selected {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.linked-document-picker__selected li {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		max-width: 100%;
		border: 1px solid var(--color-border, #d8dee8);
		border-radius: 999px;
		padding: 4px 6px 4px 10px;
		font-size: 12px;
	}

	.linked-document-picker__selected button {
		flex-shrink: 0;
	}

	.linked-document-picker__selected span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.linked-document-picker__list {
		min-height: 160px;
		overflow: auto;
		border: 1px solid var(--color-border-subtle, #ebeff5);
		border-radius: 8px;
	}

	.linked-document-picker__row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--color-border-subtle, #ebeff5);
	}

	.linked-document-picker__row:last-child {
		border-bottom: 0;
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
		color: var(--color-text-primary, #101828);
		font-weight: 550;
	}

	.linked-document-picker__row-copy span:last-child,
	.linked-document-picker__state {
		color: var(--color-text-muted, #667085);
		font-size: 12px;
	}

	.linked-document-picker__state {
		margin: 0;
		padding: 20px 12px;
	}

	.linked-document-picker__state--error {
		color: var(--color-danger, #b42318);
	}

	.linked-document-picker__secondary,
	.linked-document-picker__primary {
		border-radius: 8px;
		padding: 9px 12px;
		font-size: 13px;
		font-weight: 600;
	}

	.linked-document-picker__secondary {
		border: 1px solid var(--color-border, #d8dee8);
		background: transparent;
		color: var(--color-text-primary, #101828);
	}

	.linked-document-picker__primary {
		border: 1px solid var(--color-primary, #2563eb);
		background: var(--color-primary, #2563eb);
		color: #fff;
	}

	@media (min-width: 768px) {
		.linked-document-backdrop {
			align-items: center;
		}
	}

	@media (max-width: 640px) {
		.linked-document-backdrop {
			background: rgb(15 23 42 / 0.22);
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
</style>
