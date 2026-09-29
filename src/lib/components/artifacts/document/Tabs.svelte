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
import { getFocusableElements } from "$lib/utils/focus-trap";
import { portalToBody } from "$lib/utils/portal";

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

let activeTab = $derived(tabs.find((tab) => tab.id === activeTabId) ?? null);
let deleteTarget = $state<DocumentTab | null>(null);
let menuOpenForTabId = $state<string | null>(null);
// The strip is the scroller (`overflow-x: auto`) and the positioning parent of
// the ink and the ⋯ button; the `role="tablist"` element inside it owns the
// tabs and nothing else (the ⋯ and + buttons sit beside it, not in it).
let tabStripEl = $state<HTMLElement | null>(null);
let tabListEl = $state<HTMLElement | null>(null);
let inkEl = $state<HTMLElement | null>(null);
let optionsButtonEl = $state<HTMLButtonElement | null>(null);
let tabButtons = new Map<string, HTMLButtonElement>();
// Review 2.5 (rd/review-2-5.md:183-190): the ⋯ menu used to render inline,
// `position: absolute` against its own `.document-tab-menu-anchor` — a
// descendant of `.document-tabs`, whose `overflow-x: auto` (needed so a long
// tab strip scrolls sideways instead of wrapping) clipped the menu's own
// box the moment it dropped below the strip's bottom edge. Portalled to
// `document.body` and positioned from the trigger's own rect instead (the
// same shape `VersionsSheet.svelte`/`DownloadSheet.svelte` already use),
// this can never be clipped by an ancestor's overflow again.
let menuTriggerEl = $state<HTMLButtonElement | undefined>();
let menuEl = $state<HTMLDivElement | undefined>();
let menuStyle = $state<string | undefined>(undefined);
const MENU_WIDTH = 128; // matches `.document-tab-menu`'s own `min-width: 8rem`
/** The gap between the active tab's label and its ⋯ button (the active tab's own right margin reserves the room). */
const OPTIONS_GAP_PX = 2;
const VIEWPORT_MARGIN = 8;

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
	const opening = menuOpenForTabId !== tabId;
	menuOpenForTabId = opening ? tabId : null;
	if (opening) menuTriggerEl = event.currentTarget as HTMLButtonElement;
}

/** `refocusTrigger`: true for Escape (redesign's own convention: the innermost layer's Escape returns focus to what opened it), false for an outside click (focus is already wherever the user clicked). */
function closeMenu(refocusTrigger = false): void {
	menuOpenForTabId = null;
	if (refocusTrigger) menuTriggerEl?.focus();
}

function measureMenu(): void {
	if (typeof window === "undefined" || !menuTriggerEl) return;
	const rect = menuTriggerEl.getBoundingClientRect();
	const width = Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
	const maxLeft = Math.max(
		VIEWPORT_MARGIN,
		window.innerWidth - width - VIEWPORT_MARGIN,
	);
	const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft);
	menuStyle = `top: ${rect.bottom + 5}px; left: ${left}px;`;
}

$effect(() => {
	if (!menuOpenForTabId) return;
	measureMenu();
	// Review 2.5 (rd/review-2-5.md:183-190): "focus the first item on open" —
	// keyboard focus stayed on ⋯ before this fix, so ArrowDown/Enter had
	// nothing to act on.
	void tick().then(() => {
		getFocusableElements(menuEl)[0]?.focus();
	});
	const handleReflow = () => measureMenu();
	window.addEventListener("resize", handleReflow);
	window.addEventListener("scroll", handleReflow, true);
	return () => {
		window.removeEventListener("resize", handleReflow);
		window.removeEventListener("scroll", handleReflow, true);
	};
});

/** WAI-ARIA menu pattern (redesign §5.2, rd/review-2-5.md:183-190): Up/Down cycles the two items with wraparound, Escape closes and returns focus to ⋯. */
function handleMenuKeydown(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		closeMenu(true);
		return;
	}
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	event.preventDefault();
	const items = getFocusableElements(menuEl);
	if (items.length === 0) return;
	const currentIndex = items.indexOf(document.activeElement as HTMLElement);
	const step = event.key === "ArrowDown" ? 1 : -1;
	const nextIndex = (currentIndex + step + items.length) % items.length;
	items[nextIndex]?.focus();
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

/**
 * Places the two things that follow the active tab but are not tabs: the
 * sliding underline (§7.2 #6: "underline slides to the new tab") and the ⋯
 * button, which sits right after the tab's label. Both are absolutely
 * positioned in the strip (they scroll with it) from the active tab button's
 * rect — the ⋯ button used to live inside the tab's own wrapper, which put a
 * button in the tablist. No-op with nothing to measure (SSR, or a tab id the
 * DOM hasn't caught up with yet).
 */
async function positionInk(): Promise<void> {
	await tick();
	const activeButton = tabButtons.get(activeTabId);
	if (!activeButton || !tabStripEl) return;
	const stripRect = tabStripEl.getBoundingClientRect();
	const buttonRect = activeButton.getBoundingClientRect();
	const left = buttonRect.left - stripRect.left + tabStripEl.scrollLeft;
	if (inkEl) {
		inkEl.style.left = `${left}px`;
		inkEl.style.width = `${buttonRect.width}px`;
	}
	if (optionsButtonEl) {
		optionsButtonEl.style.left = `${left + buttonRect.width + OPTIONS_GAP_PX}px`;
	}
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

// A rename, a badge appearing, a font arriving or a resized panel changes a
// tab's width without touching `activeTabId`/`tabs`. Guarded: jsdom has no
// ResizeObserver, and the strip must render correctly without one.
$effect(() => {
	const el = tabListEl;
	if (!el || typeof ResizeObserver === "undefined") return;
	const observer = new ResizeObserver(() => void positionInk());
	observer.observe(el);
	return () => observer.disconnect();
});
</script>

{#if tabs.length > 1}
	<div class="document-tabs" data-testid="document-tabs" bind:this={tabStripEl}>
		<!-- A tablist owns only tabs: ⋯ and + are siblings of it, not children
		     (WAI-ARIA tabs pattern; rd/review-2-5.md:223-228). -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="document-tablist"
			role="tablist"
			aria-label={$t('artifacts.type.document')}
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
							<span class="document-tab-badge" aria-hidden="true">{badgeCount}</span>
							<span class="sr-only">
								{$t('artifacts.document.tab.openCommentsA11y', { count: badgeCount })}
							</span>
						{/if}
					</button>
				</div>
			{/each}
		</div>
		<!-- The options of the ACTIVE tab (redesign §5.2): one button that follows
		     the selection, placed right after that tab's label by `positionInk`. -->
		<button
			type="button"
			class="document-tab-icon-button"
			bind:this={optionsButtonEl}
			aria-label={$t('artifacts.document.tab.menu')}
			title={$t('artifacts.document.tab.menu')}
			aria-haspopup="menu"
			aria-expanded={menuOpenForTabId === activeTabId}
			onclick={(event) => toggleMenu(activeTabId, event)}
		>
			<Ellipsis size={13} strokeWidth={2} aria-hidden="true" />
		</button>
		{#if menuOpenForTabId === activeTabId && activeTab}
			<div
				class="document-tab-menu"
				role="menu"
				tabindex="-1"
				bind:this={menuEl}
				use:portalToBody
				style={menuStyle}
				onkeydown={handleMenuKeydown}
			>
				<button
					type="button"
					role="menuitem"
					class="document-tab-menu-item"
					onclick={() => renameTab(activeTab)}
				>
					{$t('artifacts.document.tab.rename')}
				</button>
				<button
					type="button"
					role="menuitem"
					class="document-tab-menu-item document-tab-menu-item-danger"
					onclick={() => requestDelete(activeTab)}
				>
					{$t('artifacts.document.tab.delete')}
				</button>
			</div>
		{/if}
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

	.document-tablist {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.125rem;
	}

	/* A presentational wrapper: it carries the spacing the tab button does not
	   (the rhythm between labels) and, for the active tab, the room its ⋯ button
	   takes right after the label (that button is not in the tablist, it is
	   positioned there by `positionInk`: 1.25rem wide + the 2px gap). */
	.document-tab-item {
		display: flex;
		align-items: center;
		border-radius: var(--radius-md);
		padding: 0.125rem 0.125rem 0.125rem 0.5rem;
	}

	.document-tab-active {
		margin-right: 1.375rem;
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

	.document-tab-icon-button {
		position: absolute;
		top: 50%;
		left: 0;
		transform: translateY(-50%);
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

	/* Review 2.5 (rd/review-2-5.md:183-190): `position: fixed` (not the old
	   `absolute` against `.document-tab-menu-anchor`) plus `use:portalToBody`
	   on this element (see the markup) — `top`/`left` come from `menuStyle`,
	   measured from the ⋯ trigger's own rect in script, exactly like
	   `VersionsSheet.svelte`/`DownloadSheet.svelte`'s popovers. z-index 130
	   matches those same popovers' own fix (clears
	   `DocumentWorkspace.svelte`'s `.workspace-shell-expanded`, 115 — this
	   strip renders inside the expanded panel too). */
	.document-tab-menu {
		position: fixed;
		z-index: 130;
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

	/* Phones: the tabs, the ⋯ and the + are real 44px boxes (WCAG 2.5.8;
	   review 233-238). The strip is a scroller, so a hit area grown with
	   `::after` would be clipped at its edge — the strip gives up its own
	   padding instead and the buttons carry the height. */
	@media (max-width: 767px) {
		.document-tabs {
			padding-block: 0;
		}

		.document-tabs-single {
			padding-block: 0;
		}

		/* The label's breathing room moves from the wrapper into the button, so a
		   short tab ("Plan") is still 44px wide to a finger. */
		.document-tab-item {
			padding: 0;
		}

		.document-tab-button {
			justify-content: center;
			min-width: 44px;
			min-height: 44px;
			padding-inline: 0.5rem;
		}

		.document-tab-active {
			margin-right: 2.875rem;
		}

		.document-tab-icon-button,
		.document-tab-add {
			width: 44px;
			height: 44px;
		}
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
