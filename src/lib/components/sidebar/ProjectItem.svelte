<script lang="ts">
import { onMount } from "svelte";
import type { Project } from "$lib/types";
import { t } from "$lib/i18n";
import {
	portal,
	setMenuBaseBackground,
	setupMenuSync,
} from "$lib/utils/popup-menu";
import ConfirmDialog from "../ui/ConfirmDialog.svelte";

type SidebarProject = Project & {
	sidebarPinned?: boolean;
	sidebarSortOrder?: number | null;
};

let {
	project,
	expanded = true,
	menuOpen = false,
	dropActive = false,
	creatingConversation = false,
	onToggle,
	onCreateConversation,
	onRename,
	onDelete,
	onTogglePin,
	onMenuToggle,
	onMenuClose,
}: {
	project: SidebarProject;
	expanded?: boolean;
	menuOpen?: boolean;
	dropActive?: boolean;
	creatingConversation?: boolean;
	onToggle?: (payload: { id: string; expanded: boolean }) => void;
	onCreateConversation?: (payload: { id: string }) => void;
	onRename?: (payload: { id: string; name: string }) => void;
	onDelete?: (payload: { id: string }) => void;
	onTogglePin?: (payload: { id: string; pinned: boolean }) => void;
	onMenuToggle?: (payload: { id: string; open: boolean }) => void;
	onMenuClose?: (payload: { id: string }) => void;
} = $props();

let isEditing = $state(false);
let editName = $state("");
let inputRef = $state<HTMLInputElement | undefined>(undefined);
let menuRef = $state<HTMLDivElement | undefined>(undefined);
let triggerRef = $state<HTMLButtonElement | undefined>(undefined);
let showDeleteConfirm = $state(false);
let menuPositionStyle = $state("");
let menuBaseBackground = $state("var(--surface-elevated)");
let menuAnchor = $state<
	{ kind: "trigger" } | { kind: "pointer"; x: number; y: number }
>({
	kind: "trigger",
});

function doUpdatePosition() {
	menuBaseBackground = setMenuBaseBackground() || "var(--surface-elevated)";
	if (menuAnchor.kind === "pointer") {
		updateMenuPositionFromPoint(menuAnchor.x, menuAnchor.y, 164);
		return;
	}
	if (!triggerRef) return;
	updateMenuPositionBesideTrigger(triggerRef, 164);
}

function updateMenuPositionBesideTrigger(
	trigger: HTMLElement,
	menuWidth: number,
) {
	const rect = trigger.getBoundingClientRect();
	const viewportPadding = 12;
	let left = rect.right + 6;
	if (left + menuWidth > window.innerWidth - viewportPadding) {
		left = rect.left - menuWidth - 6;
	}
	left = Math.min(
		window.innerWidth - menuWidth - viewportPadding,
		Math.max(viewportPadding, left),
	);
	const top = Math.min(
		window.innerHeight - viewportPadding,
		Math.max(viewportPadding, rect.top),
	);
	menuPositionStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${menuWidth}px;`;
}

function updateMenuPositionFromPoint(x: number, y: number, menuWidth: number) {
	const viewportPadding = 12;
	const left = Math.min(
		window.innerWidth - menuWidth - viewportPadding,
		Math.max(viewportPadding, x),
	);
	const top = Math.min(
		window.innerHeight - viewportPadding,
		Math.max(viewportPadding, y),
	);
	menuPositionStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${menuWidth}px;`;
}

function toggleMenu(e: MouseEvent) {
	e.stopPropagation();
	menuAnchor = { kind: "trigger" };
	if (!menuOpen) doUpdatePosition();
	onMenuToggle?.({ id: project.id, open: !menuOpen });
}

function openContextMenu(e: MouseEvent) {
	if (isEditing) return;
	e.preventDefault();
	e.stopPropagation();
	menuAnchor = { kind: "pointer", x: e.clientX, y: e.clientY };
	doUpdatePosition();
	onMenuToggle?.({ id: project.id, open: true });
}

function handleOutsideClick(e: MouseEvent) {
	const target = e.target as Node;
	if (
		menuOpen &&
		menuRef &&
		triggerRef &&
		!menuRef.contains(target) &&
		!triggerRef.contains(target)
	) {
		e.preventDefault();
		e.stopPropagation();
		onMenuClose?.({ id: project.id });
	}
}

function startRename(e: MouseEvent) {
	e.stopPropagation();
	isEditing = true;
	editName = project.name;
	onMenuClose?.({ id: project.id });
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
		const trimmed = editName.trim();
		if (trimmed && trimmed !== project.name) {
			onRename?.({ id: project.id, name: trimmed });
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
	onMenuClose?.({ id: project.id });
	showDeleteConfirm = true;
}

function handleTogglePin(e: MouseEvent) {
	e.stopPropagation();
	onMenuClose?.({ id: project.id });
	onTogglePin?.({ id: project.id, pinned: !project.sidebarPinned });
}

function confirmDelete() {
	showDeleteConfirm = false;
	onDelete?.({ id: project.id });
}

onMount(() => {
	return setupMenuSync(() => menuOpen, doUpdatePosition);
});

function createConversation(e: MouseEvent) {
	e.stopPropagation();
	if (creatingConversation) return;
	onMenuClose?.({ id: project.id });
	onCreateConversation?.({ id: project.id });
}
</script>

<svelte:window onclick={handleOutsideClick} />

<!-- Project folder row -->
<div
	data-testid="project-drop-target"
	data-project-id={project.id}
	class="group flex min-h-[34px] cursor-pointer select-none items-center rounded-lg border border-transparent pr-0.5 pl-1 transition-colors duration-150 hover:border-border-subtle hover:bg-surface-elevated"
	class:project-row-drop-active={dropActive}
	onclick={() => onToggle?.({ id: project.id, expanded: !expanded })}
	oncontextmenu={openContextMenu}
	onkeydown={(event) => event.key === 'Enter' && onToggle?.({ id: project.id, expanded: !expanded })}
	role="button"
	tabindex="0"
>
	<!-- Expand chevron -->
	<span
		class="mr-1 flex h-4 w-4 shrink-0 items-center justify-center text-icon-muted transition-transform duration-150"
		class:rotate-90={expanded}
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="9 18 15 12 9 6" />
		</svg>
	</span>

	<!-- Folder icon -->
	<span class="mr-1.5 flex shrink-0 items-center" class:text-accent={expanded} class:text-icon-muted={!expanded}>
		{#if expanded}
			<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M6 14a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v2"/>
				<path d="M22 18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v7z"/>
			</svg>
		{:else}
			<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
			</svg>
		{/if}
	</span>

	<!-- Project name / edit input -->
	<div class="min-w-0 flex-1 overflow-hidden">
		{#if isEditing}
			<input
				bind:this={inputRef}
				bind:value={editName}
				onblur={saveRename}
				onkeydown={handleKeydown}
				onclick={(event) => event.stopPropagation()}
				class="w-full rounded-sm border border-border bg-surface-page px-1.5 py-0.5 text-[13px] font-sans text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
			/>
		{:else}
			<span class="truncate text-[13px] font-medium font-sans text-text-primary">{project.name}</span>
		{/if}
	</div>

	{#if project.sidebarPinned}
		<span
			class="project-pin-indicator mr-1 flex shrink-0 items-center justify-center text-icon-muted"
			aria-label={$t('sidebar.pinned')}
			title={$t('sidebar.pinned')}
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M12 17v5"/>
				<path d="M7 7l10 10"/>
				<path d="M8 4h8l-1 6 3 3v2H6v-2l3-3z"/>
			</svg>
		</span>
	{/if}

	<div class="project-row-actions flex shrink-0 items-center justify-end gap-px">
		<button
			class="project-row-action-button project-inline-action btn-icon-bare flex shrink-0 cursor-pointer items-center justify-center rounded-md text-icon-muted opacity-100 transition-colors duration-150 hover:bg-surface-page hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:opacity-0 md:group-hover:opacity-100"
			class:md:opacity-100={menuOpen || creatingConversation}
			onclick={createConversation}
			disabled={creatingConversation}
			aria-busy={creatingConversation}
			aria-label={$t('sidebar.createChatInProject', { name: project.name })}
			title={$t('sidebar.newChatInProject')}
		>
			{#if creatingConversation}
				<svg class="project-action-spinner" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
					<path d="M21 12a9 9 0 0 1-9 9"/>
					<path d="M3 12a9 9 0 0 1 9-9"/>
				</svg>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8z"/>
					<path d="M12 8v6"/><path d="M9 11h6"/>
				</svg>
			{/if}
		</button>

		<!-- Context menu trigger -->
		<button
			bind:this={triggerRef}
			class="project-row-action-button btn-icon-bare flex shrink-0 cursor-pointer items-center justify-center rounded-md text-icon-muted opacity-100 transition-colors duration-150 hover:bg-surface-page hover:text-icon-primary focus-visible:outline-none md:opacity-0 md:group-hover:opacity-100"
			class:md:opacity-100={menuOpen}
			onclick={toggleMenu}
			aria-label={$t('sidebar.projectOptions')}
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />
			</svg>
		</button>
	</div>

	{#if menuOpen}
		<div
			bind:this={menuRef}
			use:portal
			role="menu"
			class="project-menu z-[9999] overflow-hidden rounded-lg border p-1"
			style={`${menuPositionStyle} --project-menu-bg: ${menuBaseBackground};`}
		>
			<button
				role="menuitem"
				class="project-option flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
				onclick={handleTogglePin}
			>
				<svg class="project-option-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 17v5"/>
					<path d="M7 7l10 10"/>
					<path d="M8 4h8l-1 6 3 3v2H6v-2l3-3z"/>
				</svg>
				<span>{project.sidebarPinned ? $t('sidebar.unpinFromSidebar') : $t('sidebar.pinToSidebar')}</span>
			</button>
			<button
				role="menuitem"
				class="project-option flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
				aria-label={$t('sidebar.createChatInProject', { name: project.name })}
				onclick={createConversation}
				disabled={creatingConversation}
				aria-busy={creatingConversation}
			>
				{#if creatingConversation}
					<svg class="project-option-icon project-action-spinner" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
						<path d="M21 12a9 9 0 0 1-9 9"/>
						<path d="M3 12a9 9 0 0 1 9-9"/>
					</svg>
				{:else}
					<svg class="project-option-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8z"/>
						<path d="M12 8v6"/><path d="M9 11h6"/>
					</svg>
				{/if}
				<span>{$t('sidebar.newChatInProject')}</span>
			</button>
			<button
				role="menuitem"
				class="project-option flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
				onclick={startRename}
			>
				<svg class="project-option-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/>
				</svg>
				<span>{$t('sidebar.rename')}</span>
			</button>
			<button
				role="menuitem"
				class="project-option project-option-danger flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
				onclick={handleDelete}
			>
				<svg class="project-option-icon project-option-icon-danger" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
				</svg>
				<span>{$t('sidebar.delete')}</span>
			</button>
		</div>
	{/if}
</div>

{#if showDeleteConfirm}
	<ConfirmDialog
		title={$t('sidebar.deleteProjectTitle')}
		message={$t('sidebar.deleteProjectMessage')}
		confirmText={$t('common.delete')}
		cancelText={$t('common.cancel')}
		confirmVariant="danger"
		onConfirm={confirmDelete}
		onCancel={() => (showDeleteConfirm = false)}
	/>
{/if}

<style>
	.project-row-actions {
		height: 28px;
	}

	.project-row-action-button {
		height: 28px;
		min-height: 28px;
		width: 28px;
		min-width: 28px;
		padding: 0;
	}

	.project-pin-indicator {
		opacity: 0.76;
	}

	.project-row-drop-active,
	.project-row-drop-active:hover {
		background: transparent;
		border-color: transparent;
	}

	.project-row-drop-active .project-inline-action:hover,
	.project-row-drop-active .project-inline-action:focus-visible {
		background: color-mix(in srgb, var(--accent) 18%, transparent 82%);
	}

	.project-inline-action:disabled,
	.project-option:disabled {
		cursor: wait;
		opacity: 0.82;
	}

	.project-action-spinner {
		animation: project-action-spin 0.8s linear infinite;
	}

	@keyframes project-action-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.project-menu {
		background: var(--project-menu-bg, var(--surface-elevated));
		border-color: color-mix(in srgb, var(--border-default) 76%, var(--surface-page) 24%);
		isolation: isolate;
		pointer-events: auto;
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	:global(.dark) .project-menu {
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
		box-shadow:
			0 16px 32px rgba(0, 0, 0, 0.4),
			0 0 0 1px color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	.project-option {
		border: 0;
		border-radius: 0.5rem;
		background: var(--project-menu-bg);
		padding: 0.35rem 0.55rem;
		gap: 0.45rem;
		line-height: 1.15;
	}

	.project-option:hover,
	.project-option:focus-visible {
		background: rgba(194, 166, 106, 0.24) !important;
	}

	.project-option-danger:hover,
	.project-option-danger:focus-visible {
		background: rgba(186, 77, 77, 0.14) !important;
	}

	.project-option-icon {
		color: color-mix(in srgb, var(--surface-overlay) 45%, var(--text-primary) 55%);
		flex-shrink: 0;
	}

	.project-option-icon-danger {
		color: color-mix(in srgb, var(--surface-overlay) 45%, var(--text-primary) 55%);
	}

	:global(.dark) .project-option:hover,
	:global(.dark) .project-option:focus-visible {
		background: rgba(194, 166, 106, 0.3) !important;
	}

	:global(.dark) .project-option-danger:hover,
	:global(.dark) .project-option-danger:focus-visible {
		background: rgba(186, 77, 77, 0.22) !important;
	}

	:global(.dark) .project-option-icon,
	:global(.dark) .project-option-icon-danger {
		color: color-mix(in srgb, var(--surface-overlay) 62%, var(--text-primary) 38%);
	}
</style>
