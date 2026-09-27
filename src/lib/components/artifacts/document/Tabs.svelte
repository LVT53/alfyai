<script lang="ts">
/**
 * The Document's tab strip (Feature 2 · Artifacts, Slice 1, T9; redesign
 * §5.2/§9.2, Wave 2.5 Step 5): a plan, its budget and its packing list stay
 * one document Alfy can read at once, split into named sections. A
 * single-tab document hides the strip entirely (T9.3) — the strip is for
 * navigating BETWEEN sections, and one section has nothing to navigate
 * between.
 *
 * This component owns the tab LIST's own CRUD (add/rename/delete) and hands
 * the new list back through `onChange` for the caller to persist (through
 * the same `saveDocumentBody` path as any other edit — Contracts: the tab
 * strip lives in `metadata_json.tabs`, alongside the body, not a second
 * store). It never touches the editor itself: switching the active tab is
 * `onActivate(tabId)`, a plain notification, so a tab switch can never
 * accidentally remount or reload the document (T9.1) — `DocumentBody.svelte`
 * is what turns that into the tab-range visibility decoration (§5.2 "Tabs
 * switch sections").
 *
 * Redesign changes from the old strip (§5.1 problem 5): a sliding underline
 * instead of an instant highlight, an amber badge per tab for its own open
 * comments, a `⋯` menu (Rename/Delete) on the ACTIVE tab only instead of a
 * pencil and a cross on every tab (double-click still renames), and
 * roving-tabindex arrow-key navigation per the WAI-ARIA tabs pattern
 * (automatic activation — matching the approved mockup's own handler).
 *
 * No `@tiptap/*` import — stays outside the lazy editor boundary (T7.8).
 */
import { Ellipsis, Plus } from "@lucide/svelte";
import { onMount, tick } from "svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import { t } from "$lib/i18n";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";

let {
	tabs,
	activeTabId,
	onActivate,
	onChange,
	badgeCounts = {},
}: {
	tabs: DocumentTab[];
	activeTabId: string;
	onActivate: (tabId: string) => void;
	onChange: (tabs: DocumentTab[]) => void;
	/** How many of THIS tab's own comments are still open, keyed by tab id. Missing/0 renders no badge. Fed by a caller that can resolve comment anchors to tab ranges (DocumentBody.svelte); absent until then. */
	badgeCounts?: Record<string, number>;
} = $props();

let deleteTarget = $state<DocumentTab | null>(null);
let menuOpenForTabId = $state<string | null>(null);
let tabListEl = $state<HTMLElement | null>(null);
let inkEl = $state<HTMLElement | null>(null);
let tabButtons = new Map<string, HTMLButtonElement>();

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
	menuOpenForTabId = null;
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
	menuOpenForTabId = null;
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

function toggleMenu(tabId: string, event: MouseEvent): void {
	// The menu's own open toggle must not immediately re-close itself through
	// the window-level click-outside handler below.
	event.stopPropagation();
	menuOpenForTabId = menuOpenForTabId === tabId ? null : tabId;
}

function closeMenu(): void {
	menuOpenForTabId = null;
}

/** Automatic activation, wrapping (WAI-ARIA tabs pattern) — mirrors the approved mockup's own `#tabs` keydown handler exactly. */
function handleTablistKeydown(event: KeyboardEvent): void {
	if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
	if (tabs.length === 0) return;
	event.preventDefault();
	const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
	const step = event.key === "ArrowRight" ? 1 : -1;
	const nextIndex = (currentIndex + step + tabs.length) % tabs.length;
	const next = tabs[nextIndex];
	if (!next) return;
	onActivate(next.id);
	tabButtons.get(next.id)?.focus();
}

function registerTabButton(node: HTMLButtonElement, tabId: string) {
	tabButtons.set(tabId, node);
	return {
		destroy() {
			if (tabButtons.get(tabId) === node) tabButtons.delete(tabId);
		},
	};
}

/** Positions the sliding underline under the active tab (§7.2 #6: "underline slides to the new tab"). No-op with nothing to measure (SSR, or a tab id the DOM hasn't caught up with yet). */
async function positionInk(): Promise<void> {
	await tick();
	const activeButton = tabButtons.get(activeTabId);
	if (!activeButton || !inkEl || !tabListEl) return;
	inkEl.style.left = `${activeButton.offsetLeft}px`;
	inkEl.style.width = `${activeButton.offsetWidth}px`;
}

onMount(() => {
	void positionInk();
});

$effect(() => {
	// Re-measure whenever the active tab (or the tab list itself) changes —
	// reading `activeTabId`/`tabs` here is what makes this effect re-run.
	activeTabId;
	tabs;
	void positionInk();
});
</script>

{#if tabs.length > 1}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="document-tabs"
		role="tablist"
		aria-label={$t('artifacts.type.document')}
		data-testid="document-tabs"
		bind:this={tabListEl}
		tabindex="-1"
		onkeydown={handleTablistKeydown}
	>
		{#each tabs as tab (tab.id)}
			{@const isActive = tab.id === activeTabId}
			{@const badgeCount = badgeCounts[tab.id] ?? 0}
			<div class="document-tab-item" class:document-tab-active={isActive}>
				<button
					type="button"
					role="tab"
					id={`document-tab-${tab.id}`}
					aria-selected={isActive}
					aria-controls={`document-tabpanel-${tab.id}`}
					tabindex={isActive ? 0 : -1}
					class="document-tab-button"
					use:registerTabButton={tab.id}
					onclick={() => onActivate(tab.id)}
					ondblclick={() => renameTab(tab)}
				>
					<span>{tab.title}</span>
					{#if badgeCount > 0}
						<span class="document-tab-badge">{badgeCount}</span>
					{/if}
				</button>
				{#if isActive}
					<div class="document-tab-menu-anchor">
						<button
							type="button"
							class="document-tab-icon-button"
							aria-label={$t('artifacts.document.tab.menu')}
							title={$t('artifacts.document.tab.menu')}
							aria-haspopup="menu"
							aria-expanded={menuOpenForTabId === tab.id}
							onclick={(event) => toggleMenu(tab.id, event)}
						>
							<Ellipsis size={13} strokeWidth={2} aria-hidden="true" />
						</button>
						{#if menuOpenForTabId === tab.id}
							<div class="document-tab-menu" role="menu">
								<button
									type="button"
									role="menuitem"
									class="document-tab-menu-item"
									onclick={() => renameTab(tab)}
								>
									{$t('artifacts.document.tab.rename')}
								</button>
								<button
									type="button"
									role="menuitem"
									class="document-tab-menu-item document-tab-menu-item-danger"
									onclick={() => requestDelete(tab)}
								>
									{$t('artifacts.document.tab.delete')}
								</button>
							</div>
						{/if}
					</div>
				{/if}
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
		<span class="document-tabs-ink" bind:this={inkEl} aria-hidden="true"></span>
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

<svelte:window onclick={() => closeMenu()} />

<style>
	.document-tabs {
		position: relative;
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
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.125rem;
		border-radius: var(--radius-md);
		padding: 0.125rem 0.125rem 0.125rem 0.5rem;
	}

	.document-tab-button {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border: none;
		background: none;
		padding: 0.25rem 0;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		white-space: nowrap;
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.document-tab-active .document-tab-button {
		color: var(--text-primary);
		font-weight: 700;
	}

	.document-tab-badge {
		display: inline-grid;
		place-items: center;
		min-width: 1.05rem;
		height: 1.05rem;
		padding: 0 0.3rem;
		border-radius: var(--radius-full);
		background: var(--comment-mark);
		color: var(--text-primary);
		font-size: 0.63rem;
		font-weight: 700;
		letter-spacing: 0;
	}

	.document-tabs-ink {
		position: absolute;
		bottom: -1px;
		left: 0;
		height: 2px;
		width: 0;
		border-radius: 2px;
		background: var(--accent);
		transition:
			left var(--duration-emphasis) var(--ease-emphasis),
			width var(--duration-emphasis) var(--ease-emphasis);
	}

	.document-tab-menu-anchor {
		position: relative;
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

	.document-tab-menu {
		position: absolute;
		top: calc(100% + 0.3rem);
		left: 0;
		z-index: 5;
		display: grid;
		min-width: 8rem;
		gap: 0.1rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 84%, transparent);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		padding: 0.3rem;
		box-shadow: var(--shadow-md, 0 0.8rem 2rem rgb(0 0 0 / 16%));
	}

	.document-tab-menu-item {
		border: none;
		border-radius: calc(var(--radius-sm) - 2px);
		background: none;
		padding: 0.4rem 0.55rem;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		text-align: left;
		cursor: pointer;
	}

	.document-tab-menu-item:hover {
		background: var(--surface-page);
	}

	.document-tab-menu-item-danger {
		color: var(--danger-text, #b3261e);
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
	.document-tab-menu-item:focus-visible,
	.document-tab-add:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}
</style>
