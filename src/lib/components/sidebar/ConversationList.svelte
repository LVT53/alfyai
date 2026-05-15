<script lang="ts">
	import { fade, slide } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		conversations,
		createNewConversation,
		deleteConversationById,
		renameConversation,
		moveConversationToProject,
		clearProjectFromConversations,
		upsertConversationLocal
	} from '$lib/stores/conversations';
	import {
		projects as projectsStore,
		createProject,
		renameProject,
		deleteProject,
		reconcileProjectSnapshot
	} from '$lib/stores/projects';
	import {
		clearProjectFolderExpanded,
		currentConversationId,
		projectFolderExpanded,
		setProjectFolderExpanded,
		sidebarOpen,
		SIDEBAR_DESKTOP_BREAKPOINT
	} from '$lib/stores/ui';
	import { t } from '$lib/i18n';
	import type { ConversationListItem, Project } from '$lib/types';
	import ConversationItem from './ConversationItem.svelte';
	import ProjectItem from './ProjectItem.svelte';

	let {
		initialConversations = [],
		initialProjects = []
	}: {
		initialConversations?: ConversationListItem[];
		initialProjects?: Project[];
	} = $props();

	let projectsStoreReady = $state(false);
	let conversationsStoreReady = $state(false);
	let supportsDragAndDrop = $state(true);
	let draggedConversationId = $state<string | null>(null);
	type SidebarDropTarget = { kind: 'project'; projectId: string } | { kind: 'unorganized' } | null;
	let dropTarget = $state<SidebarDropTarget>(null);
	type OpenSidebarMenu =
		| { kind: 'conversation'; id: string }
		| { kind: 'project'; id: string }
		| null;
	onMount(() => {
		reconcileProjectSnapshot(initialProjects);
		projectsStoreReady = true;
		conversationsStoreReady = true;
	});

	let openSidebarMenu = $state<OpenSidebarMenu>(null);
	const expandedProjects = $derived($projectFolderExpanded);
	let isCreatingProject = $state(false);
	let newProjectName = $state('');
	let newProjectInputRef = $state<HTMLInputElement | undefined>(undefined);
	let creatingProjectConversationId = $state<string | null>(null);

	const visibleConversations = $derived(
		conversationsStoreReady ? $conversations : initialConversations
	);

	const allProjects = $derived(projectsStoreReady ? $projectsStore : initialProjects);
	const activeDraggedConversation = $derived.by(() =>
		draggedConversationId
			? visibleConversations.find((conversation) => conversation.id === draggedConversationId) ?? null
			: null
	);
	const canDropIntoUnorganized = $derived(activeDraggedConversation?.projectId != null);

	const conversationsByProject = $derived.by(() => {
		const map: Record<string, ConversationListItem[]> = {};
		for (const p of allProjects) {
			map[p.id] = [];
		}
		const unorganized: ConversationListItem[] = [];
		for (const conv of visibleConversations) {
			if (conv.projectId && map[conv.projectId] !== undefined) {
				map[conv.projectId].push(conv);
			} else {
				unorganized.push(conv);
			}
		}
		return { byProject: map, unorganized };
	});

	// ── Conversation handlers ──────────────────────────────────────────────────

	function closeAllMenus() {
		openSidebarMenu = null;
	}

	function clearDragState() {
		draggedConversationId = null;
		dropTarget = null;
	}

	function getConversationById(id: string | null | undefined) {
		if (!id) return null;
		return visibleConversations.find((conversation) => conversation.id === id) ?? null;
	}

	function leftCurrentDropTarget(event: DragEvent) {
		const currentTarget = event.currentTarget as HTMLElement | null;
		const nextTarget = event.relatedTarget as Node | null;
		return !(currentTarget && nextTarget && currentTarget.contains(nextTarget));
	}

	function getDraggedConversationId(event: DragEvent) {
		return (
			event.dataTransfer?.getData('application/x-alfyai-conversation') ||
			event.dataTransfer?.getData('text/plain') ||
			null
		);
	}

	function setMoveDropEffect(event: DragEvent) {
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	}

	function isConversationMenuOpen(id: string) {
		return openSidebarMenu?.kind === 'conversation' && openSidebarMenu.id === id;
	}

	function isProjectMenuOpen(id: string) {
		return openSidebarMenu?.kind === 'project' && openSidebarMenu.id === id;
	}

	async function handleSelect(payload: { id: string }) {
		const id = payload.id;
		if ($page.url.pathname === `/chat/${id}`) return;
		const previousConversationId = $currentConversationId;
		closeAllMenus();
		currentConversationId.set(id);
		try {
			await goto(`/chat/${id}`, { replaceState: false });
			if (window.innerWidth < SIDEBAR_DESKTOP_BREAKPOINT) {
				sidebarOpen.set(false);
			}
		} catch (err) {
			console.error('Navigation failed:', err);
			currentConversationId.set(previousConversationId);
		}
	}

	async function handleRename(payload: { id: string; title: string }) {
		const { id, title } = payload;
		closeAllMenus();
		try {
			await renameConversation(id, title);
		} catch (e) {
			console.error('Rename failed', e);
			alert($t('sidebar.failedRenameConversation'));
		}
	}

	async function handleDelete(payload: { id: string }) {
		const { id } = payload;
		closeAllMenus();
		try {
			await deleteConversationById(id);
			if ($currentConversationId === id) {
				currentConversationId.set(null);
				goto('/');
			}
		} catch (e) {
			console.error('Delete failed', e);
			alert($t('sidebar.failedDeleteConversation'));
		}
	}

	async function handleMoveToProject(payload: { id: string; projectId: string | null }) {
		const { id, projectId } = payload;
		closeAllMenus();
		clearDragState();
		try {
			await moveConversationToProject(id, projectId);
		} catch (e) {
			console.error('Move to project failed', e);
			alert($t('sidebar.failedMoveConversation'));
		}
	}

	function handleMenuToggle(payload: { id: string; open: boolean }) {
		const { id, open } = payload;
		openSidebarMenu = open ? { kind: 'conversation', id } : null;
	}

	function handleMenuClose(payload?: { id: string }) {
		if (!payload || isConversationMenuOpen(payload.id)) {
			closeAllMenus();
		}
	}

	function handleConversationDragStart(payload: { id: string }) {
		draggedConversationId = payload.id;
		dropTarget = null;
		closeAllMenus();
	}

	function handleConversationDragEnd() {
		clearDragState();
	}

	function handleProjectDragOver(payload: { id: string }) {
		if (!draggedConversationId) return;
		const draggedConversation = getConversationById(draggedConversationId);
		if (!draggedConversation || draggedConversation.projectId === payload.id) {
			dropTarget = null;
			return;
		}
		dropTarget = { kind: 'project', projectId: payload.id };
	}

	function handleProjectDragLeave(payload: { id: string }) {
		if (dropTarget?.kind === 'project' && dropTarget.projectId === payload.id) {
			dropTarget = null;
		}
	}

	async function handleProjectDropConversation(payload: {
		projectId: string;
		conversationId?: string | null;
	}) {
		const conversationId = payload.conversationId ?? draggedConversationId;
		const draggedConversation = getConversationById(conversationId);
		clearDragState();
		if (!conversationId) return;

		if (!draggedConversation || draggedConversation.projectId === payload.projectId) {
			return;
		}

		try {
			await moveConversationToProject(conversationId, payload.projectId);
			setProjectFolderExpanded(payload.projectId, true);
		} catch (e) {
			console.error('Drag to project failed', e);
			alert($t('sidebar.failedMoveConversation'));
		}
	}

	function handleUnorganizedDragOver() {
		if (!draggedConversationId) return;
		if (!activeDraggedConversation || activeDraggedConversation.projectId == null) {
			dropTarget = null;
			return;
		}
		dropTarget = { kind: 'unorganized' };
	}

	function handleUnorganizedDragLeave() {
		if (dropTarget?.kind === 'unorganized') {
			dropTarget = null;
		}
	}

	async function handleUnorganizedDropConversation(conversationId?: string | null) {
		const resolvedConversationId = conversationId ?? draggedConversationId;
		const draggedConversation = getConversationById(resolvedConversationId);
		clearDragState();
		if (!resolvedConversationId || !draggedConversation || draggedConversation.projectId == null) {
			return;
		}

		try {
			await moveConversationToProject(resolvedConversationId, null);
		} catch (e) {
			console.error('Drag to unorganized failed', e);
			alert($t('sidebar.failedMoveConversation'));
		}
	}

	// ── Project handlers ───────────────────────────────────────────────────────

	function handleProjectToggle(payload: { id: string; expanded: boolean }) {
		const { id, expanded } = payload;
		setProjectFolderExpanded(id, expanded);
	}

	async function handleProjectRename(payload: { id: string; name: string }) {
		const { id, name } = payload;
		closeAllMenus();
		try {
			await renameProject(id, name);
		} catch (e) {
			console.error('Rename project failed', e);
			alert($t('sidebar.failedRenameProject'));
		}
	}

	async function handleProjectDelete(payload: { id: string }) {
		const { id } = payload;
		closeAllMenus();
		try {
			clearProjectFromConversations(id);
			clearProjectFolderExpanded(id);
			await deleteProject(id);
		} catch (e) {
			console.error('Delete project failed', e);
			alert($t('sidebar.failedDeleteProject'));
		}
	}

	async function handleCreateConversationInProject(payload: { id: string }) {
		const { id: projectId } = payload;
		if (creatingProjectConversationId) return;

		closeAllMenus();
		clearDragState();
		creatingProjectConversationId = projectId;
		setProjectFolderExpanded(projectId, true);
		try {
			const conversationId = await createNewConversation({ projectId });
			upsertConversationLocal(conversationId, 'New Conversation', Date.now() / 1000, projectId);
			currentConversationId.set(conversationId);
			await goto(`/chat/${conversationId}?view=bootstrap`);
		} catch (e) {
			console.error('Create project conversation failed', e);
			alert($t('sidebar.failedCreateProjectConversation'));
		} finally {
			creatingProjectConversationId = null;
		}
	}

	function handleProjectMenuToggle(payload: { id: string; open: boolean }) {
		const { id, open } = payload;
		openSidebarMenu = open ? { kind: 'project', id } : null;
	}

	function handleProjectMenuClose(payload?: { id: string }) {
		if (!payload || isProjectMenuOpen(payload.id)) {
			closeAllMenus();
		}
	}

	// ── Create project ─────────────────────────────────────────────────────────

	function startCreateProject(e: MouseEvent) {
		e.stopPropagation();
		isCreatingProject = true;
		newProjectName = '';
		setTimeout(() => newProjectInputRef?.focus(), 0);
	}

	async function commitCreateProject() {
		const name = newProjectName.trim();
		isCreatingProject = false;
		newProjectName = '';
		if (!name) return;
		try {
			const project = await createProject(name);
			setProjectFolderExpanded(project.id, true);
		} catch (e) {
			console.error('Create project failed', e);
			alert($t('sidebar.failedCreateProject'));
		}
	}

	function handleNewProjectKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') { e.preventDefault(); commitCreateProject(); }
		else if (e.key === 'Escape') { isCreatingProject = false; }
	}
</script>

<div class="flex h-full flex-col gap-0">
	<!-- ── Projects section ──────────────────────────────────────────────── -->
	{#if allProjects.length > 0 || isCreatingProject}
		<div class="mb-0.5">
			<!-- Section header -->
			<div class="group flex items-center justify-between px-2 py-1">
				<span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">{$t('sidebar.projects')}</span>
				<button
					class="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-icon-muted opacity-0 transition-opacity duration-100 hover:text-icon-primary group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
					title={$t('sidebar.newProject')}
					aria-label={$t('sidebar.createNewProject')}
					onclick={startCreateProject}
				>
					<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" x2="12" y1="5" y2="19" /><line x1="5" x2="19" y1="12" y2="12" />
					</svg>
				</button>
			</div>

			<!-- New project input -->
			{#if isCreatingProject}
				<div class="px-1 pb-1">
					<input
						bind:this={newProjectInputRef}
						bind:value={newProjectName}
						onblur={commitCreateProject}
						onkeydown={handleNewProjectKeydown}
						placeholder={$t('sidebar.projectName')}
						class="w-full rounded-md border border-border bg-surface-page px-2.5 py-1.5 text-[13px] font-sans text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent placeholder:text-text-muted"
					/>
				</div>
			{/if}

			<!-- Project list -->
			<div class="flex flex-col gap-0 px-1">
				{#each allProjects as project (project.id)}
					<div
						class="project-drop-zone rounded-xl border border-transparent"
						class:project-drop-zone-active={dropTarget?.kind === 'project' && dropTarget.projectId === project.id}
						role="group"
						aria-label={$t('sidebar.projectDropArea', { name: project.name })}
						ondragover={(event) => {
							setMoveDropEffect(event);
							handleProjectDragOver({ id: project.id });
						}}
						ondragleave={(event) => {
							if (leftCurrentDropTarget(event)) {
								handleProjectDragLeave({ id: project.id });
							}
						}}
						ondrop={(event) => {
							setMoveDropEffect(event);
							void handleProjectDropConversation({
								projectId: project.id,
								conversationId: getDraggedConversationId(event)
							});
						}}
					>
						<ProjectItem
							{project}
							expanded={expandedProjects[project.id] ?? false}
							menuOpen={isProjectMenuOpen(project.id)}
							dropActive={dropTarget?.kind === 'project' && dropTarget.projectId === project.id}
							creatingConversation={creatingProjectConversationId === project.id}
							onToggle={handleProjectToggle}
							onCreateConversation={handleCreateConversationInProject}
							onRename={handleProjectRename}
							onDelete={handleProjectDelete}
							onMenuToggle={handleProjectMenuToggle}
							onMenuClose={handleProjectMenuClose}
						/>
						<!-- Conversations inside this project -->
						{#if expandedProjects[project.id] ?? false}
							<div class="overflow-hidden" transition:slide={{ duration: 200 }}>
							{#each conversationsByProject.byProject[project.id] ?? [] as conversation, i (conversation.id)}
								<div class="pl-4" in:fade={{ duration: 150, delay: i * 35 }}>
									<ConversationItem
										{conversation}
										active={$currentConversationId === conversation.id}
										menuOpen={isConversationMenuOpen(conversation.id)}
										projects={allProjects}
										dragEnabled={supportsDragAndDrop}
										isDragging={draggedConversationId === conversation.id}
										onSelect={handleSelect}
										onRename={handleRename}
										onDelete={handleDelete}
										onMoveToProject={handleMoveToProject}
										onDragStart={handleConversationDragStart}
										onDragEnd={handleConversationDragEnd}
										onMenuToggle={handleMenuToggle}
										onMenuClose={handleMenuClose}
									/>
								</div>
							{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<!-- Divider between projects and unorganized chats -->
		{#if conversationsByProject.unorganized.length > 0}
			<div class="my-1 border-t border-border-subtle mx-2"></div>
		{/if}
	{:else}
		<!-- No projects yet: header + creative empty notice -->
		<div class="group flex items-center justify-between px-2 py-1">
			<span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">{$t('sidebar.projects')}</span>
			<button
				class="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-icon-muted opacity-0 transition-opacity duration-100 hover:text-icon-primary group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
				title={$t('sidebar.newProject')}
				aria-label={$t('sidebar.createNewProject')}
				onclick={startCreateProject}
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
					<line x1="12" x2="12" y1="5" y2="19" /><line x1="5" x2="19" y1="12" y2="12" />
				</svg>
			</button>
		</div>
		{#if isCreatingProject}
			<div class="px-1 pb-1">
				<input
					bind:this={newProjectInputRef}
					bind:value={newProjectName}
					onblur={commitCreateProject}
					onkeydown={handleNewProjectKeydown}
					placeholder={$t('sidebar.projectName')}
					class="w-full rounded-md border border-border bg-surface-page px-2.5 py-1.5 text-[13px] font-sans text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent placeholder:text-text-muted"
				/>
			</div>
		{:else}
			<!-- Creative empty state: dashed folder card -->
			<button
				class="empty-projects-btn mx-1 mb-2 flex w-[calc(100%-0.5rem)] cursor-pointer items-center gap-2.5 rounded-lg border border-dashed px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				onclick={startCreateProject}
				aria-label={$t('sidebar.createNewProject')}
			>
				<div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-elevated text-icon-muted">
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
						<line x1="12" y1="11" x2="12" y2="17"/>
						<line x1="9" y1="14" x2="15" y2="14"/>
					</svg>
				</div>
				<div>
					<p class="text-[12px] font-medium text-text-secondary">{$t('sidebar.noProjectsYet')}</p>
					<p class="text-[11px] text-text-muted">{$t('sidebar.groupChatsCreateOne')}</p>
				</div>
			</button>
		{/if}
	{/if}

	<!-- ── Unorganized conversations ─────────────────────────────────────── -->
	<div
		data-testid="unorganized-drop-target"
		class="unorganized-drop-zone flex flex-col gap-0.5 rounded-xl border border-transparent px-1 transition-colors duration-150"
		class:unorganized-drop-zone-active={dropTarget?.kind === 'unorganized'}
		role="group"
		aria-label={$t('sidebar.unorganizedDropArea')}
		ondragover={(event) => {
			setMoveDropEffect(event);
			handleUnorganizedDragOver();
		}}
		ondragleave={(event) => {
			if (leftCurrentDropTarget(event)) {
				handleUnorganizedDragLeave();
			}
		}}
		ondrop={(event) => {
			setMoveDropEffect(event);
			void handleUnorganizedDropConversation(getDraggedConversationId(event));
		}}
	>
		{#if allProjects.length > 0 || conversationsByProject.unorganized.length > 0 || canDropIntoUnorganized}
				<div class="px-1 pb-1 pt-0.5">
					<div class="flex items-center justify-between gap-2">
						<span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">{$t('sidebar.chats')}</span>
					</div>
				</div>
		{/if}
		{#if visibleConversations.length === 0}
			<div class="flex h-20 items-center justify-center p-4 text-sm text-text-muted">
				{$t('sidebar.noConversationsYet')}
			</div>
		{:else}
			{#each conversationsByProject.unorganized as conversation (conversation.id)}
				<ConversationItem
					{conversation}
					active={$currentConversationId === conversation.id}
					menuOpen={isConversationMenuOpen(conversation.id)}
					projects={allProjects}
					dragEnabled={supportsDragAndDrop}
					isDragging={draggedConversationId === conversation.id}
					onSelect={handleSelect}
					onRename={handleRename}
					onDelete={handleDelete}
					onMoveToProject={handleMoveToProject}
					onDragStart={handleConversationDragStart}
					onDragEnd={handleConversationDragEnd}
					onMenuToggle={handleMenuToggle}
					onMenuClose={handleMenuClose}
				/>
			{/each}
		{/if}
	</div>
</div>

<style>
	.project-drop-zone-active,
	.unorganized-drop-zone-active {
		border-color: color-mix(in srgb, var(--accent) 72%, transparent 28%);
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--accent) 12%, transparent 88%),
				color-mix(in srgb, var(--surface-elevated) 78%, transparent 22%)
			);
	}

	.project-drop-zone {
		transition:
			background-color 150ms cubic-bezier(0.4, 0, 0.2, 1),
			border-color 150ms cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 150ms cubic-bezier(0.4, 0, 0.2, 1);
	}

	.empty-projects-btn {
		border-color: color-mix(in srgb, var(--border-default) 50%, transparent 50%);
	}

	.empty-projects-btn:hover {
		background: color-mix(in srgb, var(--surface-elevated) 60%, var(--surface-overlay) 40%);
		border-color: var(--border-default);
	}
</style>
