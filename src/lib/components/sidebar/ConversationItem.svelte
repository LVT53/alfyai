<script lang="ts">
import { onMount } from "svelte";
import {
	Check,
	ChevronRight,
	EllipsisVertical,
	Folder,
	GitBranch,
	Pencil,
	Pin,
	Trash2,
	X,
} from "@lucide/svelte";
import type { ConversationListItem, Project } from "$lib/types";
import { t } from "$lib/i18n";
import {
	portal,
	setMenuBaseBackground,
	setupMenuSync,
} from "$lib/utils/popup-menu";
import ConfirmDialog from "../ui/ConfirmDialog.svelte";
import ConversationTitleText from "$lib/components/chat/ConversationTitleText.svelte";

type SidebarConversation = ConversationListItem & {
	sidebarPinned?: boolean;
	sidebarSortOrder?: number | null;
};

let {
	conversation,
	active = false,
	menuOpen = false,
	projects = [],
	projectLabel = null,
	dragEnabled = false,
	isDragging = false,
	onSelect,
	onRename,
	onDelete,
	onTogglePin,
	onMoveToProject,
	onDragStart,
	onDragEnd,
	onMenuToggle,
	onMenuClose,
}: {
	conversation: SidebarConversation;
	active?: boolean;
	menuOpen?: boolean;
	projects?: Project[];
	projectLabel?: string | null;
	dragEnabled?: boolean;
	isDragging?: boolean;
	onSelect?: (payload: { id: string }) => void;
	onRename?: (payload: { id: string; title: string }) => void;
	onDelete?: (payload: { id: string }) => void;
	onTogglePin?: (payload: { id: string; pinned: boolean }) => void;
	onMoveToProject?: (payload: { id: string; projectId: string | null }) => void;
	onDragStart?: (payload: { id: string }) => void;
	onDragEnd?: (payload: { id: string }) => void;
	onMenuToggle?: (payload: { id: string; open: boolean }) => void;
	onMenuClose?: (payload: { id: string }) => void;
} = $props();

let isEditing = $state(false);
let editTitle = $state("");
let inputRef = $state<HTMLInputElement | undefined>(undefined);
let menuRef = $state<HTMLDivElement | undefined>(undefined);
let triggerRef = $state<HTMLButtonElement | undefined>(undefined);
let showDeleteConfirm = $state(false);
let menuPositionStyle = $state("");
let menuBaseBackground = $state("var(--surface-elevated)");
let showProjectSubmenu = $state(false);
let submenuRef = $state<HTMLDivElement | undefined>(undefined);
let submenuPositionStyle = $state("");
let menuAnchor = $state<
	{ kind: "trigger" } | { kind: "pointer"; x: number; y: number }
>({
	kind: "trigger",
});
const CONVERSATION_MENU_WIDTH = 178;
const CONVERSATION_MENU_ESTIMATED_HEIGHT = 150;
const PROJECT_SUBMENU_WIDTH = 184;
const PROJECT_SUBMENU_ESTIMATED_HEIGHT = 220;
const MENU_VIEWPORT_PADDING = 12;
const MENU_VERTICAL_OFFSET = 6;

function handleSelect() {
	if (!isEditing && !menuOpen) {
		onSelect?.({ id: conversation.id });
	}
}

function startRename(e: MouseEvent) {
	e.stopPropagation();
	isEditing = true;
	editTitle = conversation.title;
	showProjectSubmenu = false;
	onMenuClose?.({ id: conversation.id });
	setTimeout(() => {
		if (inputRef) {
			inputRef.focus();
			inputRef.select();
		}
	}, 0);
}

function saveRename() {
	if (isEditing) {
		isEditing = false;
		const trimmedTitle = editTitle.trim();
		if (trimmedTitle && trimmedTitle !== conversation.title) {
			onRename?.({ id: conversation.id, title: trimmedTitle });
		}
	}
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter") {
		e.preventDefault();
		saveRename();
	} else if (e.key === "Escape") {
		isEditing = false;
	}
}

function handleDelete(e: MouseEvent) {
	e.stopPropagation();
	showProjectSubmenu = false;
	onMenuClose?.({ id: conversation.id });
	showDeleteConfirm = true;
}

function handleTogglePin(e: MouseEvent) {
	e.stopPropagation();
	showProjectSubmenu = false;
	onMenuClose?.({ id: conversation.id });
	onTogglePin?.({ id: conversation.id, pinned: !conversation.sidebarPinned });
}

function confirmDelete() {
	showDeleteConfirm = false;
	onDelete?.({ id: conversation.id });
}

function cancelDelete() {
	showDeleteConfirm = false;
}

function doUpdatePosition() {
	menuBaseBackground = setMenuBaseBackground() || "var(--surface-elevated)";
	if (menuAnchor.kind === "pointer") {
		updateMenuPositionFromPoint(
			menuAnchor.x,
			menuAnchor.y,
			CONVERSATION_MENU_WIDTH,
			menuRef?.offsetHeight || CONVERSATION_MENU_ESTIMATED_HEIGHT,
		);
		return;
	}
	if (!triggerRef) return;
	updateMenuPositionFromTrigger(
		triggerRef,
		CONVERSATION_MENU_WIDTH,
		menuRef?.offsetHeight || CONVERSATION_MENU_ESTIMATED_HEIGHT,
	);
}

function clampMenuLeft(left: number, menuWidth: number): number {
	return Math.min(
		window.innerWidth - menuWidth - MENU_VIEWPORT_PADDING,
		Math.max(MENU_VIEWPORT_PADDING, left),
	);
}

function clampMenuTop(top: number, menuHeight: number): number {
	const maxTop = Math.max(
		MENU_VIEWPORT_PADDING,
		window.innerHeight - menuHeight - MENU_VIEWPORT_PADDING,
	);
	return Math.min(maxTop, Math.max(MENU_VIEWPORT_PADDING, top));
}

function getTriggerMenuTop(rect: DOMRect, menuHeight: number): number {
	const belowTop = rect.bottom + MENU_VERTICAL_OFFSET;
	if (belowTop + menuHeight <= window.innerHeight - MENU_VIEWPORT_PADDING) {
		return belowTop;
	}
	const aboveTop = rect.top - menuHeight - MENU_VERTICAL_OFFSET;
	if (aboveTop >= MENU_VIEWPORT_PADDING) return aboveTop;
	return clampMenuTop(belowTop, menuHeight);
}

function updateMenuPositionFromTrigger(
	trigger: HTMLElement,
	menuWidth: number,
	menuHeight: number,
) {
	const rect = trigger.getBoundingClientRect();
	const left = Math.min(
		window.innerWidth - menuWidth - MENU_VIEWPORT_PADDING,
		Math.max(MENU_VIEWPORT_PADDING, rect.right - menuWidth),
	);
	const top = getTriggerMenuTop(rect, menuHeight);
	menuPositionStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${menuWidth}px;`;
}

function updateMenuPositionFromPoint(
	x: number,
	y: number,
	menuWidth: number,
	menuHeight: number,
) {
	const left = clampMenuLeft(x, menuWidth);
	const top = clampMenuTop(y, menuHeight);
	menuPositionStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${menuWidth}px;`;
}

function scheduleMenuPositionUpdate() {
	const updateAfterLayout = () => {
		if (!menuOpen) return;
		doUpdatePosition();
		if (showProjectSubmenu) updateSubmenuPosition();
	};
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(updateAfterLayout);
		return;
	}
	setTimeout(updateAfterLayout, 0);
}

function toggleMenu(e: MouseEvent) {
	e.stopPropagation();
	showProjectSubmenu = false;
	menuAnchor = { kind: "trigger" };
	if (!menuOpen) doUpdatePosition();
	onMenuToggle?.({ id: conversation.id, open: !menuOpen });
}

function openContextMenu(e: MouseEvent) {
	if (isEditing) return;
	e.preventDefault();
	e.stopPropagation();
	showProjectSubmenu = false;
	menuAnchor = { kind: "pointer", x: e.clientX, y: e.clientY };
	doUpdatePosition();
	onMenuToggle?.({ id: conversation.id, open: true });
}

function handleOutsideClick(e: MouseEvent) {
	const target = e.target as Node;
	if (
		menuOpen &&
		menuRef &&
		triggerRef &&
		!menuRef.contains(target) &&
		!triggerRef.contains(target) &&
		!submenuRef?.contains(target)
	) {
		e.preventDefault();
		e.stopPropagation();
		showProjectSubmenu = false;
		onMenuClose?.({ id: conversation.id });
	}
}

function toggleProjectSubmenu(e: MouseEvent) {
	e.stopPropagation();
	showProjectSubmenu = !showProjectSubmenu;
	if (showProjectSubmenu) {
		updateSubmenuPosition();
	}
}

function updateSubmenuPosition() {
	if (!menuRef) return;
	const rect = menuRef.getBoundingClientRect();
	// Try right side first, fall back to left
	let left = rect.right + 4;
	if (
		left + PROJECT_SUBMENU_WIDTH >
		window.innerWidth - MENU_VIEWPORT_PADDING
	) {
		left = rect.left - PROJECT_SUBMENU_WIDTH - 4;
	}
	left = clampMenuLeft(left, PROJECT_SUBMENU_WIDTH);
	const top = clampMenuTop(
		rect.top,
		submenuRef?.offsetHeight || PROJECT_SUBMENU_ESTIMATED_HEIGHT,
	);
	submenuPositionStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${PROJECT_SUBMENU_WIDTH}px;`;
}

function handleMoveToProject(e: MouseEvent, projectId: string | null) {
	e.stopPropagation();
	showProjectSubmenu = false;
	onMenuClose?.({ id: conversation.id });
	onMoveToProject?.({ id: conversation.id, projectId });
}

function handleDragStart(event: DragEvent) {
	if (!dragEnabled || isEditing) {
		event.preventDefault();
		return;
	}

	event.stopPropagation();
	showProjectSubmenu = false;
	onMenuClose?.({ id: conversation.id });
	event.dataTransfer?.setData(
		"application/x-alfyai-conversation",
		conversation.id,
	);
	event.dataTransfer?.setData("text/plain", conversation.id);
	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = "move";
	}
	onDragStart?.({ id: conversation.id });
}

function handleDragEnd(event: DragEvent) {
	if (dragEnabled) {
		event.stopPropagation();
	}
	onDragEnd?.({ id: conversation.id });
}

function forkIndicatorLabel() {
	const summary = conversation.forkSummary;
	if (!summary) return "";
	return $t("sidebar.forkIndicatorTooltip", {
		title: summary.sourceTitle,
		sequence: summary.forkSequence,
	});
}

let atlasBadgeLabel = $derived(
	conversation.atlasBadge?.label || $t("atlas.sidebarCompletedBadge"),
);
let showAtlasCompletedBadge = $derived(
	!active && conversation.atlasBadge?.status === "succeeded",
);

$effect(() => {
	if (!menuOpen) return;
	scheduleMenuPositionUpdate();
});

onMount(() => {
	return setupMenuSync(() => menuOpen, doUpdatePosition);
});
</script>

<svelte:window onclick={handleOutsideClick} />

<div
  data-testid="conversation-item"
	data-conversation-id={conversation.id}
  class="group relative flex min-h-[32px] cursor-pointer items-center justify-between rounded-lg border border-transparent transition-colors duration-150 hover:border-border-subtle hover:bg-surface-elevated focus-visible:bg-surface-elevated focus-visible:outline-none"
	style="padding: 0 0 0 6px; pointer-events: auto;"
  class:bg-surface-elevated={active}
  class:border-accent={active}
  class:shadow-sm={active}
	class:conversation-item-dragging={isDragging}
	draggable={dragEnabled && !isEditing}
  onclick={handleSelect}
	oncontextmenu={openContextMenu}
	ondragstart={handleDragStart}
	ondragend={handleDragEnd}
  onkeydown={(event) => event.key === 'Enter' && handleSelect()}
  role="button"
  tabindex="0"
>
	<div class="flex min-w-0 flex-1 overflow-hidden pr-1">
		{#if isEditing}
			<input
				data-testid="title-input"
				bind:this={inputRef}
				bind:value={editTitle}
				onblur={saveRename}
				onkeydown={handleKeydown}
				onclick={(event) => event.stopPropagation()}
				class="min-h-[44px] w-full rounded-sm border border-border bg-surface-page px-2 py-1 text-sm font-sans text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
			/>
		{:else}
			<div class="flex min-w-0 items-center gap-1.5 px-1.5">
				{#if conversation.forkSummary}
					{@const indicatorLabel = forkIndicatorLabel()}
					<span
						class="fork-indicator"
						role="img"
						aria-label={indicatorLabel}
						title={indicatorLabel}
					>
					<GitBranch size={13} strokeWidth={2.2} aria-hidden="true" />
						<span class="fork-indicator-tooltip" aria-hidden="true">{indicatorLabel}</span>
					</span>
				{/if}
				{#if showAtlasCompletedBadge}
					<span
						class="atlas-completed-badge"
						role="img"
						aria-label={atlasBadgeLabel}
						title={atlasBadgeLabel}
					></span>
				{/if}
			<div class="min-w-0 flex-1">
				<div class="truncate text-[13px] font-sans text-text-primary">
					<ConversationTitleText title={conversation.title} />
				</div>
				{#if projectLabel}
					<div class="truncate text-[10px] leading-3 text-text-muted">{projectLabel}</div>
				{/if}
			</div>
			</div>
		{/if}
	</div>

	<div class="relative flex min-h-[32px] min-w-[28px] flex-shrink-0 items-center justify-center">
		<button
			bind:this={triggerRef}
			class="btn-icon-bare flex min-h-[28px] min-w-[28px] flex-shrink-0 items-center justify-center rounded-md text-icon-muted opacity-100 transition-colors duration-150 hover:bg-surface-page hover:text-icon-primary hover:opacity-100 focus-visible:bg-surface-page focus-visible:opacity-100 focus-visible:outline-none md:opacity-0 md:group-hover:opacity-100 cursor-pointer"
			class:opacity-100={menuOpen || active}
			class:md:opacity-100={menuOpen || active}
			onclick={toggleMenu}
			aria-label={$t('sidebar.conversationOptions')}
		>
		<EllipsisVertical size={16} strokeWidth={2} aria-hidden="true" />
		</button>

		{#if menuOpen}
			<div
				bind:this={menuRef}
				use:portal
				role="menu"
				class="conversation-menu z-[9999] overflow-hidden rounded-lg border p-1"
				style={`${menuPositionStyle} --conversation-menu-bg: ${menuBaseBackground};`}
			>
				<button
					role="menuitem"
					data-testid="pin-option"
					class="conversation-option flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
					onclick={handleTogglePin}
				>
				<span class="conversation-option-icon">
					<Pin size={15} strokeWidth={2} aria-hidden="true" />
				</span>
					<span>{conversation.sidebarPinned ? $t('sidebar.unpinFromSidebar') : $t('sidebar.pinToSidebar')}</span>
				</button>
				<button
					role="menuitem"
					data-testid="rename-option"
					class="conversation-option flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
					onclick={startRename}
				>
				<span class="conversation-option-icon">
					<Pencil size={15} strokeWidth={2} aria-hidden="true" />
				</span>
					<span>{$t('sidebar.rename')}</span>
				</button>

				{#if projects.length > 0 || conversation.projectId}
					<button
						role="menuitem"
						class="conversation-option flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						class:conversation-option-active={showProjectSubmenu}
						onclick={toggleProjectSubmenu}
					>
						<span class="conversation-option-icon">
							<Folder size={15} strokeWidth={2} aria-hidden="true" />
						</span>
					<span class="flex-1">{$t('sidebar.moveToProject')}</span>
					<ChevronRight class="shrink-0 text-icon-muted mr-1" size={13} strokeWidth={2.5} aria-hidden="true" />
					</button>
				{/if}

				<button
					role="menuitem"
					data-testid="delete-option"
					class="conversation-option conversation-option-danger flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
					onclick={handleDelete}
				>
				<span class="conversation-option-icon conversation-option-icon-danger">
					<Trash2 size={15} strokeWidth={2} aria-hidden="true" />
				</span>
					<span>{$t('sidebar.delete')}</span>
				</button>
			</div>
		{/if}

		<!-- Project submenu flyout -->
		{#if menuOpen && showProjectSubmenu}
			<div
				bind:this={submenuRef}
				use:portal
				class="conversation-menu z-[10000] overflow-hidden rounded-lg border p-1"
				style={`${submenuPositionStyle} --conversation-menu-bg: ${menuBaseBackground};`}
			>
				{#each projects as proj (proj.id)}
					<button
						class="conversation-option flex min-h-[30px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						class:conversation-option-current={conversation.projectId === proj.id}
						onclick={(event) => handleMoveToProject(event, proj.id)}
					>
						<span class="conversation-option-icon">
							<Folder size={15} strokeWidth={2} aria-hidden="true" />
						</span>
					<span class="truncate">{proj.name}</span>
					{#if conversation.projectId === proj.id}
						<Check class="ml-auto shrink-0 text-accent" size={14} strokeWidth={2.5} aria-hidden="true" />
						{/if}
					</button>
				{/each}
				{#if conversation.projectId}
					<div class="my-[3px] border-t border-border-subtle mx-1"></div>
					<button
						class="conversation-option flex min-h-[30px] w-full items-center text-left font-sans text-[12px] text-text-muted transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						onclick={(event) => handleMoveToProject(event, null)}
					>
				<span class="conversation-option-icon opacity-60">
					<X size={15} strokeWidth={2} aria-hidden="true" />
				</span>
						<span>{$t('sidebar.removeFromProject')}</span>
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

{#if showDeleteConfirm}
	<ConfirmDialog
		title={$t('sidebar.deleteConversationTitle')}
		message={$t('sidebar.deleteConversationMessage')}
		confirmText={$t('common.delete')}
		cancelText={$t('common.cancel')}
		confirmVariant="danger"
		onConfirm={confirmDelete}
		onCancel={cancelDelete}
	/>
{/if}

<style>
	.conversation-menu {
		background: var(--conversation-menu-bg, var(--surface-elevated));
		border-color: color-mix(in srgb, var(--border-default) 76%, var(--surface-page) 24%);
		isolation: isolate;
		pointer-events: auto;
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	:global(.dark) .conversation-menu {
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
		box-shadow:
			0 16px 32px rgba(0, 0, 0, 0.4),
			0 0 0 1px color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	.conversation-option {
		border: 0;
		border-radius: 0.5rem;
		background: var(--conversation-menu-bg);
		padding: 0.35rem 0.55rem;
		gap: 0.45rem;
		line-height: 1.15;
	}

	.conversation-option:hover,
	.conversation-option:focus-visible {
		background: rgba(194, 166, 106, 0.24) !important;
	}

	.conversation-option-active {
		background: rgba(194, 166, 106, 0.18) !important;
	}

	.conversation-option-current {
		background: rgba(194, 166, 106, 0.15) !important;
	}

	.atlas-completed-badge {
		width: 0.55rem;
		height: 0.55rem;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.conversation-option-danger:hover,
	.conversation-option-danger:focus-visible {
		background: rgba(186, 77, 77, 0.14) !important;
	}

	.conversation-option-icon {
		color: color-mix(in srgb, var(--surface-overlay) 45%, var(--text-primary) 55%);
		flex-shrink: 0;
	}

	.conversation-option-icon-danger {
		color: color-mix(in srgb, var(--surface-overlay) 45%, var(--text-primary) 55%);
	}

	:global(.dark) .conversation-option:hover,
	:global(.dark) .conversation-option:focus-visible {
		background: rgba(194, 166, 106, 0.3) !important;
	}

	:global(.dark) .conversation-option-active {
		background: rgba(194, 166, 106, 0.25) !important;
	}

	:global(.dark) .conversation-option-danger:hover,
	:global(.dark) .conversation-option-danger:focus-visible {
		background: rgba(186, 77, 77, 0.22) !important;
	}

	:global(.dark) .conversation-option-icon,
	:global(.dark) .conversation-option-icon-danger {
		color: color-mix(in srgb, var(--surface-overlay) 62%, var(--text-primary) 38%);
	}

	.conversation-item-dragging {
		opacity: 0.58;
	}

	.fork-indicator {
		position: relative;
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		cursor: help;
		padding: 0;
	}

	.fork-indicator-tooltip {
		position: absolute;
		left: 0;
		bottom: calc(100% + 6px);
		z-index: 30;
		max-width: 14rem;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.72rem;
		line-height: 1.25;
		opacity: 0;
		padding: 0.35rem 0.5rem;
		pointer-events: none;
		text-overflow: ellipsis;
		transform: translateY(2px);
		transition:
			opacity var(--duration-micro) var(--ease-out),
			transform var(--duration-micro) var(--ease-out);
		visibility: hidden;
		white-space: nowrap;
	}

	.fork-indicator:hover .fork-indicator-tooltip,
	.group:focus-visible .fork-indicator-tooltip {
		opacity: 1;
		transform: translateY(0);
		visibility: visible;
	}
</style>
