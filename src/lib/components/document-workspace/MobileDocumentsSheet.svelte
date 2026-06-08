<script lang="ts">
import type { DocumentWorkspaceItem } from "$lib/types";
import { t } from "$lib/i18n";
import { X } from "@lucide/svelte";

let {
	documents,
	activeDocumentId,
	open = false,
	onOpenChange,
	onSelectDocument,
	onCloseDocument,
}: {
	documents: DocumentWorkspaceItem[];
	activeDocumentId: string | null;
	open?: boolean;
	onOpenChange: (open: boolean) => void;
	onSelectDocument: (documentId: string) => void;
	onCloseDocument: (documentId: string) => void;
} = $props();

function getDocumentTitle(document: DocumentWorkspaceItem): string {
	return document.documentLabel ?? document.title ?? document.filename;
}

function getDocumentVersionLabel(
	document: DocumentWorkspaceItem,
): string | null {
	return document.versionNumber && document.versionNumber > 0
		? `v${document.versionNumber}`
		: null;
}

function selectDocument(documentId: string) {
	onSelectDocument(documentId);
	onOpenChange(false);
}
</script>

{#if open}
	<div class="mobile-documents-sheet" data-testid="mobile-documents-sheet">
		<div class="mobile-documents-sheet-header">
			<div>{$t('documentWorkspace.openDocuments')}</div>
			<button type="button" class="mobile-documents-sheet-close" onclick={() => onOpenChange(false)} aria-label={$t('documentWorkspace.closeDocumentsList')}>
				<X size={15} strokeWidth={2.1} aria-hidden="true" />
			</button>
		</div>
		<div class="mobile-documents-list">
			{#each documents as document (document.id)}
				<div class="mobile-documents-row" class:mobile-documents-row-active={document.id === activeDocumentId}>
					<button type="button" class="mobile-documents-select" onclick={() => selectDocument(document.id)}>
						<span class="mobile-documents-title">{getDocumentTitle(document)}</span>
						{#if getDocumentVersionLabel(document)}
							<span class="mobile-documents-meta">{getDocumentVersionLabel(document)}</span>
						{/if}
					</button>
					<button
						type="button"
						class="mobile-documents-close-document"
						onclick={() => onCloseDocument(document.id)}
						aria-label={$t('documentWorkspace.closeDocumentLabel', { title: getDocumentTitle(document) })}
					>
						<X size={13} strokeWidth={2.1} aria-hidden="true" />
					</button>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.mobile-documents-sheet {
		margin: 0.55rem 1rem 0;
		border: 1px solid var(--border-default);
		border-radius: 0.65rem;
		background: var(--surface-elevated);
		box-shadow: var(--shadow-md);
		overflow: hidden;
	}

	.mobile-documents-sheet-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border-bottom: 1px solid var(--border-default);
		padding: 0.65rem 0.75rem;
		font-size: 0.74rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.mobile-documents-sheet-close,
	.mobile-documents-close-document {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--icon-muted);
	}

	.mobile-documents-list {
		display: flex;
		max-height: 42vh;
		flex-direction: column;
		overflow-y: auto;
		padding: 0.35rem;
	}

	.mobile-documents-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		border-radius: 0.45rem;
	}

	.mobile-documents-row-active {
		background: color-mix(in srgb, var(--surface-page) 86%, transparent 14%);
	}

	.mobile-documents-select {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.12rem;
		border: none;
		background: transparent;
		padding: 0.55rem 0.65rem;
		text-align: left;
		color: var(--text-primary);
	}

	.mobile-documents-title,
	.mobile-documents-meta {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mobile-documents-title {
		font-size: 0.84rem;
	}

	.mobile-documents-meta {
		font-size: 0.68rem;
		color: var(--text-muted);
	}

	@media (min-width: 768px) {
		.mobile-documents-sheet {
			display: none;
		}
	}
</style>
