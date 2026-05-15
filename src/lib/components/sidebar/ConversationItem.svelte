<script lang="ts">
	import { onMount } from 'svelte';
	import type { ConversationListItem, Project } from '$lib/types';
	import { t } from '$lib/i18n';
	import { portal, setMenuBaseBackground, updateMenuPosition, setupMenuSync } from '$lib/utils/popup-menu';
	import ConfirmDialog from '../ui/ConfirmDialog.svelte';
	import TypewriterText from '../ui/TypewriterText.svelte';

	let {
		conversation,
		active = false,
		menuOpen = false,
		projects = [],
		dragEnabled = false,
		isDragging = false,
		onSelect,
		onRename,
		onDelete,
		onMoveToProject,
		onDragStart,
		onDragEnd,
		onMenuToggle,
		onMenuClose
	}: {
		conversation: ConversationListItem;
		active?: boolean;
		menuOpen?: boolean;
		projects?: Project[];
		dragEnabled?: boolean;
		isDragging?: boolean;
		onSelect?: (payload: { id: string }) => void;
		onRename?: (payload: { id: string; title: string }) => void;
		onDelete?: (payload: { id: string }) => void;
		onMoveToProject?: (payload: { id: string; projectId: string | null }) => void;
		onDragStart?: (payload: { id: string }) => void;
		onDragEnd?: (payload: { id: string }) => void;
		onMenuToggle?: (payload: { id: string; open: boolean }) => void;
		onMenuClose?: (payload: { id: string }) => void;
	} = $props();

	let isEditing = $state(false);
	let editTitle = $state('');
	let inputRef = $state<HTMLInputElement | undefined>(undefined);
	let menuRef = $state<HTMLDivElement | undefined>(undefined);
	let triggerRef = $state<HTMLButtonElement | undefined>(undefined);
	let showDeleteConfirm = $state(false);
	let menuPositionStyle = $state('');
	let menuBaseBackground = $state('var(--surface-elevated)');
	let showProjectSubmenu = $state(false);
	let submenuRef = $state<HTMLDivElement | undefined>(undefined);
	let submenuPositionStyle = $state('');

	// Track title changes for animation
	let previousTitle = '';
	let isNewTitle = $state(false);

	$effect(() => {
		if (!previousTitle) {
			previousTitle = conversation.title;
			return;
		}

		if (conversation.title !== previousTitle) {
			isNewTitle = previousTitle === 'New Conversation' && conversation.title !== 'New Conversation';
			previousTitle = conversation.title;
		}
	});

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
		if (e.key === 'Enter') {
			e.preventDefault();
			saveRename();
		} else if (e.key === 'Escape') {
			isEditing = false;
		}
	}

	function handleDelete(e: MouseEvent) {
		e.stopPropagation();
		showProjectSubmenu = false;
		onMenuClose?.({ id: conversation.id });
		showDeleteConfirm = true;
	}

	function confirmDelete() {
		showDeleteConfirm = false;
		onDelete?.({ id: conversation.id });
	}

	function cancelDelete() {
		showDeleteConfirm = false;
	}

	function doUpdatePosition() {
		if (!triggerRef) return;
		menuBaseBackground = setMenuBaseBackground() || 'var(--surface-elevated)';
		updateMenuPosition(triggerRef, (style) => { menuPositionStyle = style; }, 178, 6);
	}

	function toggleMenu(e: MouseEvent) {
		e.stopPropagation();
		showProjectSubmenu = false;
		if (!menuOpen) doUpdatePosition();
		onMenuToggle?.({ id: conversation.id, open: !menuOpen });
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
		const submenuWidth = 184;
		const viewportPadding = 12;
		// Try right side first, fall back to left
		let left = rect.right + 4;
		if (left + submenuWidth > window.innerWidth - viewportPadding) {
			left = rect.left - submenuWidth - 4;
		}
		const top = Math.min(window.innerHeight - 12, rect.top);
		submenuPositionStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${submenuWidth}px;`;
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

		showProjectSubmenu = false;
		onMenuClose?.({ id: conversation.id });
		event.dataTransfer?.setData('application/x-alfyai-conversation', conversation.id);
		event.dataTransfer?.setData('text/plain', conversation.id);
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
		onDragStart?.({ id: conversation.id });
	}

	function handleDragEnd() {
		onDragEnd?.({ id: conversation.id });
	}

	onMount(() => {
		return setupMenuSync(() => menuOpen, doUpdatePosition);
	});
</script>

<svelte:window onclick={handleOutsideClick} />

<div
  data-testid="conversation-item"
	data-conversation-id={conversation.id}
  class="group relative flex min-h-[32px] cursor-pointer items-center justify-between rounded-lg border border-transparent transition-colors duration-150 hover:border-border-subtle hover:bg-surface-elevated focus-visible:bg-surface-elevated focus-visible:outline-none"
	style="padding: 0 2px 0 6px; pointer-events: auto;"
  class:bg-surface-elevated={active}
  class:border-accent={active}
  class:shadow-sm={active}
	class:conversation-item-dragging={isDragging}
	draggable={dragEnabled && !isEditing}
  onclick={handleSelect}
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
			<div class="truncate px-1.5 text-[13px] font-sans text-text-primary">
				{#if isNewTitle && !isEditing}
					<TypewriterText text={conversation.title} onComplete={() => isNewTitle = false} />
				{:else}
					{conversation.title}
				{/if}
			</div>
		{/if}
	</div>

	<div class="relative flex min-h-[32px] min-w-[32px] flex-shrink-0 items-center justify-center">
		<button
			bind:this={triggerRef}
			class="btn-icon-bare flex min-h-[28px] min-w-[28px] flex-shrink-0 items-center justify-center rounded-md text-icon-muted opacity-100 transition-colors duration-150 hover:bg-surface-page hover:text-icon-primary hover:opacity-100 focus-visible:bg-surface-page focus-visible:opacity-100 focus-visible:outline-none md:opacity-0 md:group-hover:opacity-100 cursor-pointer"
			class:opacity-100={menuOpen || active}
			class:md:opacity-100={menuOpen || active}
			onclick={toggleMenu}
			aria-label={$t('sidebar.conversationOptions')}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<circle cx="12" cy="12" r="1" />
				<circle cx="12" cy="5" r="1" />
				<circle cx="12" cy="19" r="1" />
			</svg>
		</button>

		{#if menuOpen}
			<div
				bind:this={menuRef}
				use:portal
				class="conversation-menu z-[9999] overflow-hidden rounded-lg border p-1"
				style={`${menuPositionStyle} --conversation-menu-bg: ${menuBaseBackground};`}
			>
				<button
					data-testid="rename-option"
					class="conversation-option flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
					onclick={startRename}
				>
					<svg class="conversation-option-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M12 20h9" />
						<path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
					</svg>
					<span>{$t('sidebar.rename')}</span>
				</button>

				{#if projects.length > 0 || conversation.projectId}
					<button
						class="conversation-option flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						class:conversation-option-active={showProjectSubmenu}
						onclick={toggleProjectSubmenu}
					>
						<svg class="conversation-option-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
						</svg>
						<span class="flex-1">{$t('sidebar.moveToProject')}</span>
						<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-icon-muted mr-1">
							<polyline points="9 18 15 12 9 6" />
						</svg>
					</button>
				{/if}

				<button
					data-testid="delete-option"
					class="conversation-option conversation-option-danger flex min-h-[32px] w-full items-center text-left font-sans text-[12px] text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
					onclick={handleDelete}
				>
					<svg class="conversation-option-icon conversation-option-icon-danger" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M3 6h18" />
						<path d="M8 6V4h8v2" />
						<path d="M19 6l-1 14H6L5 6" />
						<path d="M10 11v6" />
						<path d="M14 11v6" />
					</svg>
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
						<svg class="conversation-option-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
						</svg>
						<span class="truncate">{proj.name}</span>
						{#if conversation.projectId === proj.id}
							<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="ml-auto shrink-0 text-accent">
								<polyline points="20 6 9 17 4 12" />
							</svg>
						{/if}
					</button>
				{/each}
				{#if conversation.projectId}
					<div class="my-[3px] border-t border-border-subtle mx-1"></div>
					<button
						class="conversation-option flex min-h-[30px] w-full items-center text-left font-sans text-[12px] text-text-muted transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						onclick={(event) => handleMoveToProject(event, null)}
					>
						<svg class="conversation-option-icon opacity-60" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>
						</svg>
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
</style>
