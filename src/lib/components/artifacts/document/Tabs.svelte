<script lang="ts">
/**
 * The Document's tab strip (Feature 2 · Artifacts, Slice 1, T9): a plan, its
 * budget and its packing list stay one document Alfy can read at once, split
 * into named sections. A single-tab document hides the strip entirely
 * (T9.3) — the strip is for navigating BETWEEN sections, and one section has
 * nothing to navigate between.
 *
 * This component owns the tab LIST's own CRUD (add/rename/delete) and hands
 * the new list back through `onChange` for the caller to persist (through
 * the same `saveDocumentBody` path as any other edit — Contracts: the tab
 * strip lives in `metadata_json.tabs`, alongside the body, not a second
 * store). It never touches the editor itself: switching the active tab is
 * `onActivate(tabId)`, a plain notification, so a tab switch can never
 * accidentally remount or reload the document (T9.1).
 *
 * No `@tiptap/*` import — stays outside the lazy editor boundary (T7.8).
 */
import { Pencil, Plus, X } from "@lucide/svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import { t } from "$lib/i18n";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";

let {
	tabs,
	activeTabId,
	onActivate,
	onChange,
}: {
	tabs: DocumentTab[];
	activeTabId: string;
	onActivate: (tabId: string) => void;
	onChange: (tabs: DocumentTab[]) => void;
} = $props();

let deleteTarget = $state<DocumentTab | null>(null);

function addTab(): void {
	const newTab: DocumentTab = {
		id: crypto.randomUUID(),
		title: $t("artifacts.document.tab.newTabTitle"),
		startBlockId: "",
	};
	onChange([...tabs, newTab]);
	onActivate(newTab.id);
}

function renameTab(tab: DocumentTab): void {
	if (typeof window === "undefined") return;
	const next = window.prompt(
		$t("artifacts.document.tab.renamePrompt"),
		tab.title,
	);
	if (next === null) return;
	const trimmed = next.trim();
	if (trimmed.length === 0 || trimmed === tab.title) return;
	onChange(
		tabs.map((t2) => (t2.id === tab.id ? { ...t2, title: trimmed } : t2)),
	);
}

function requestDelete(tab: DocumentTab): void {
	deleteTarget = tab;
}

function confirmDelete(): void {
	if (!deleteTarget) return;
	const removedId = deleteTarget.id;
	onChange(tabs.filter((tab) => tab.id !== removedId));
	if (activeTabId === removedId) {
		const fallback = tabs.find((tab) => tab.id !== removedId);
		if (fallback) onActivate(fallback.id);
	}
	deleteTarget = null;
}

function cancelDelete(): void {
	deleteTarget = null;
}
</script>

{#if tabs.length > 1}
	<div class="document-tabs" role="tablist" data-testid="document-tabs">
		{#each tabs as tab (tab.id)}
			<div class="document-tab-item" class:document-tab-active={tab.id === activeTabId}>
				<button
					type="button"
					role="tab"
					aria-selected={tab.id === activeTabId}
					class="document-tab-button"
					onclick={() => onActivate(tab.id)}
					ondblclick={() => renameTab(tab)}
				>
					{tab.title}
				</button>
				<button
					type="button"
					class="document-tab-icon-button"
					aria-label={$t('artifacts.document.tab.rename')}
					title={$t('artifacts.document.tab.rename')}
					onclick={() => renameTab(tab)}
				>
					<Pencil size={12} strokeWidth={2} aria-hidden="true" />
				</button>
				<button
					type="button"
					class="document-tab-icon-button"
					aria-label={$t('artifacts.document.tab.delete')}
					title={$t('artifacts.document.tab.delete')}
					onclick={() => requestDelete(tab)}
				>
					<X size={12} strokeWidth={2} aria-hidden="true" />
				</button>
			</div>
		{/each}
		<button
			type="button"
			class="document-tab-add"
			aria-label={$t('artifacts.document.tab.add')}
			title={$t('artifacts.document.tab.add')}
			onclick={addTab}
		>
			<Plus size={14} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
{:else}
	<!-- A single-tab document has nothing to switch between (T9.3) — but
	     "Add a tab" must stay reachable, so a plan can still grow a second
	     section from its first. -->
	<div class="document-tabs document-tabs-single" data-testid="document-tabs-single">
		<button
			type="button"
			class="document-tab-add"
			aria-label={$t('artifacts.document.tab.add')}
			title={$t('artifacts.document.tab.add')}
			onclick={addTab}
		>
			<Plus size={14} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
{/if}

{#if deleteTarget}
	<ConfirmDialog
		title={$t('artifacts.document.tab.delete')}
		message={$t('artifacts.document.tab.deleteConfirm', { name: deleteTarget.title })}
		confirmVariant="danger"
		onConfirm={confirmDelete}
		onCancel={cancelDelete}
	/>
{/if}

<style>
	.document-tabs {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.25rem 0.5rem;
		border-bottom: 1px solid var(--border-subtle);
		background-color: var(--surface-page);
		overflow-x: auto;
	}

	.document-tabs-single {
		justify-content: flex-end;
		border-bottom: none;
		padding: 0.125rem 0.5rem;
	}

	.document-tab-item {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		border-radius: var(--radius-md);
		padding: 0.125rem 0.125rem 0.125rem 0.5rem;
	}

	.document-tab-active {
		background-color: var(--surface-elevated);
	}

	.document-tab-button {
		border: none;
		background: none;
		padding: 0.25rem 0;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		white-space: nowrap;
		cursor: pointer;
	}

	.document-tab-active .document-tab-button {
		color: var(--text-primary);
		font-weight: 600;
	}

	.document-tab-icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border: none;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}

	.document-tab-icon-button:hover {
		color: var(--text-primary);
	}

	.document-tab-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}

	.document-tab-add:hover {
		background-color: var(--surface-elevated);
		color: var(--text-primary);
	}

	.document-tab-button:focus-visible,
	.document-tab-icon-button:focus-visible,
	.document-tab-add:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}
</style>
