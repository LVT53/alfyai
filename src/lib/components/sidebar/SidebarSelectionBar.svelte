<script lang="ts">
import { onMount, tick } from "svelte";
import {
	Folder,
	FolderInput,
	ListChecks,
	Pin,
	PinOff,
	Trash2,
	X,
} from "@lucide/svelte";
import type { Project } from "$lib/server/services/projects";
import { t } from "$lib/i18n";
import {
	portal,
	setMenuBaseBackground,
	setupMenuSync,
} from "$lib/utils/popup-menu";
import "./conversation-menu.css";

// The bar of a sidebar selection: what is selected, and what to do with it.
// An event emitter, like the rows: `ConversationList` owns the selection and
// the bulk calls, and tells the bar what to show (`busy` while a call runs).
let {
	count,
	canSelectAll,
	pinAction,
	projects,
	canRemoveFromProject,
	busy = false,
	onClose,
	onSelectAll,
	onPin,
	onMove,
	onDelete,
}: {
	count: number;
	canSelectAll: boolean;
	pinAction: "pin" | "unpin";
	projects: Project[];
	canRemoveFromProject: boolean;
	busy?: boolean;
	onClose?: () => void;
	onSelectAll?: () => void;
	onPin?: () => void;
	onMove?: (payload: { projectId: string | null }) => void;
	onDelete?: () => void;
} = $props();

// 28px boxes (the app's 44px touch size takes over below 768px through
// `.btn-icon-bare`), shrink-proof so the count is what gives way in a narrow
// sidebar, and dimmed while a bulk action runs.
const buttonClass =
	"btn-icon-bare flex min-h-[28px] min-w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-md text-icon-muted transition-colors duration-150 enabled:hover:bg-surface-page enabled:hover:text-icon-primary enabled:hover:opacity-100 focus-visible:bg-surface-page focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

// Wide enough for the longest Hungarian option ("Eltávolítás a projektből")
// on one line.
const MOVE_MENU_WIDTH = 200;
const MOVE_MENU_GAP = 6;
const MOVE_MENU_VIEWPORT_PADDING = 12;
const MOVE_MENU_MIN_HEIGHT = 96;

let moveOpen = $state(false);
let moveButtonRef = $state<HTMLButtonElement | undefined>(undefined);
let moveMenuRef = $state<HTMLDivElement | undefined>(undefined);
let moveMenuStyle = $state("");
let moveMenuBackground = $state("var(--surface-elevated)");

const canMove = $derived(projects.length > 0 || canRemoveFromProject);
const pinLabel = $derived(
	pinAction === "unpin"
		? $t("sidebar.unpinFromSidebar")
		: $t("sidebar.pinToSidebar"),
);

// The menu can be open only while the button is there and no bulk action runs.
$effect(() => {
	if (!canMove || busy) moveOpen = false;
});

// Above the Move button, never below: the bar sits at the bottom of the
// sidebar. Anchored by its bottom edge, so a short list hugs the button and a
// long one grows upwards and scrolls inside the room that is there.
function updateMoveMenuPosition() {
	if (!moveButtonRef) return;
	moveMenuBackground = setMenuBaseBackground() || "var(--surface-elevated)";
	const rect = moveButtonRef.getBoundingClientRect();
	const width = Math.min(
		MOVE_MENU_WIDTH,
		window.innerWidth - 2 * MOVE_MENU_VIEWPORT_PADDING,
	);
	const left = Math.min(
		window.innerWidth - width - MOVE_MENU_VIEWPORT_PADDING,
		Math.max(MOVE_MENU_VIEWPORT_PADDING, rect.right - width),
	);
	const bottom = window.innerHeight - rect.top + MOVE_MENU_GAP;
	const maxHeight = Math.max(
		MOVE_MENU_MIN_HEIGHT,
		rect.top - MOVE_MENU_GAP - MOVE_MENU_VIEWPORT_PADDING,
	);
	moveMenuStyle = `position: fixed; bottom: ${bottom}px; left: ${left}px; width: ${width}px; max-height: ${maxHeight}px;`;
}

function moveMenuItems(): HTMLElement[] {
	return moveMenuRef
		? Array.from(moveMenuRef.querySelectorAll<HTMLElement>('[role="menuitem"]'))
		: [];
}

async function toggleMoveMenu() {
	if (moveOpen) {
		moveOpen = false;
		return;
	}
	updateMoveMenuPosition();
	moveOpen = true;
	// The menu is drawn into <body>, after the rest of the page: keyboard focus
	// has to be moved into it to be able to reach it.
	await tick();
	moveMenuItems()[0]?.focus();
}

function closeMoveMenu({ restoreFocus = false } = {}) {
	moveOpen = false;
	if (restoreFocus) moveButtonRef?.focus();
}

function chooseProject(projectId: string | null) {
	moveOpen = false;
	onMove?.({ projectId });
}

// In the capture phase, before the page's own listeners: a click that lands
// anywhere else closes the menu, whether or not what it lands on stops the
// click from going further.
function handleOutsideClick(event: MouseEvent) {
	if (!moveOpen) return;
	const target = event.target as Node | null;
	if (moveMenuRef?.contains(target) || moveButtonRef?.contains(target)) return;
	moveOpen = false;
}

// Also in the capture phase, so that an Escape that closes the menu does not
// go on to end the selection: the list ends it on Escape through a listener of
// its own, and it must not see this press.
function handleKeydown(event: KeyboardEvent) {
	if (!moveOpen) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		closeMoveMenu({ restoreFocus: true });
		return;
	}
	if (event.key === "Tab") {
		// Focus goes back to the button and Tab goes on from there; the menu is
		// at the far end of the page, so leaving it by Tab would skip the bar.
		closeMoveMenu({ restoreFocus: true });
		return;
	}
	const items = moveMenuItems();
	if (items.length === 0) return;
	const current = items.indexOf(document.activeElement as HTMLElement);
	let next: number;
	if (event.key === "ArrowDown") next = (current + 1) % items.length;
	else if (event.key === "ArrowUp")
		next = current <= 0 ? items.length - 1 : current - 1;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = items.length - 1;
	else return;
	event.preventDefault();
	items[next].focus();
}

onMount(() => setupMenuSync(() => moveOpen, updateMoveMenuPosition));
</script>

<svelte:window
	onclickcapture={handleOutsideClick}
	onkeydowncapture={handleKeydown}
/>

<div
	data-testid="sidebar-selection-bar"
	role="toolbar"
	aria-label={$t('sidebar.selectionToolbar')}
	class="sticky -bottom-sm -mb-sm mt-auto flex items-center gap-px border-t border-border bg-surface-overlay py-1"
>
	<button
		type="button"
		data-testid="selection-close"
		class={buttonClass}
		title={$t('sidebar.selectionClose')}
		aria-label={$t('sidebar.selectionClose')}
		disabled={busy}
		onclick={() => onClose?.()}
	>
		<X size={16} strokeWidth={2} aria-hidden="true" />
	</button>

	<span
		data-testid="selection-count"
		aria-live="polite"
		aria-atomic="true"
		class="min-w-0 flex-1 truncate font-sans text-[12px] text-text-primary"
	>{$t('sidebar.selectionCount', { count })}</span>

	<button
		type="button"
		data-testid="selection-select-all"
		class={buttonClass}
		title={$t('sidebar.selectAll')}
		aria-label={$t('sidebar.selectAll')}
		disabled={busy || !canSelectAll}
		onclick={() => onSelectAll?.()}
	>
		<ListChecks size={16} strokeWidth={2} aria-hidden="true" />
	</button>

	<button
		type="button"
		data-testid="selection-pin"
		class={buttonClass}
		title={pinLabel}
		aria-label={pinLabel}
		disabled={busy}
		onclick={() => onPin?.()}
	>
		{#if pinAction === 'unpin'}
			<PinOff size={16} strokeWidth={2} aria-hidden="true" />
		{:else}
			<Pin size={16} strokeWidth={2} aria-hidden="true" />
		{/if}
	</button>

	{#if canMove}
		<button
			bind:this={moveButtonRef}
			type="button"
			data-testid="selection-move"
			class="{buttonClass} aria-expanded:bg-surface-page aria-expanded:text-icon-primary"
			title={$t('sidebar.moveToProject')}
			aria-label={$t('sidebar.moveToProject')}
			aria-haspopup="menu"
			aria-expanded={moveOpen}
			disabled={busy}
			onclick={toggleMoveMenu}
		>
			<FolderInput size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	{/if}

	<button
		type="button"
		data-testid="selection-delete"
		class={buttonClass}
		title={$t('sidebar.delete')}
		aria-label={$t('sidebar.delete')}
		disabled={busy}
		onclick={() => onDelete?.()}
	>
		<Trash2 size={16} strokeWidth={2} aria-hidden="true" />
	</button>
</div>

{#if moveOpen}
	<div
		bind:this={moveMenuRef}
		use:portal
		role="menu"
		aria-label={$t('sidebar.moveToProject')}
		class="conversation-menu z-[9999] overflow-y-auto overscroll-contain rounded-lg border p-1"
		style={`${moveMenuStyle} --conversation-menu-bg: ${moveMenuBackground};`}
	>
		{#each projects as project (project.id)}
			<button
				type="button"
				role="menuitem"
				data-testid="selection-move-option"
				data-project-id={project.id}
				class="conversation-option flex min-h-[30px] max-md:min-h-[44px] w-full cursor-pointer items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none"
				onclick={() => chooseProject(project.id)}
			>
				<span class="conversation-option-icon">
					<Folder size={15} strokeWidth={2} aria-hidden="true" />
				</span>
				<span class="truncate">{project.name}</span>
			</button>
		{/each}
		{#if canRemoveFromProject}
			{#if projects.length > 0}
				<div class="mx-1 my-[3px] border-t border-border-subtle"></div>
			{/if}
			<button
				type="button"
				role="menuitem"
				data-testid="selection-remove-from-project"
				class="conversation-option flex min-h-[30px] max-md:min-h-[44px] w-full cursor-pointer items-center text-left font-sans text-[12px] text-text-muted transition-colors duration-150 focus-visible:outline-none"
				onclick={() => chooseProject(null)}
			>
				<span class="conversation-option-icon opacity-60">
					<X size={15} strokeWidth={2} aria-hidden="true" />
				</span>
				<span>{$t('sidebar.removeFromProject')}</span>
			</button>
		{/if}
	</div>
{/if}
