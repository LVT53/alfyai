<script lang="ts">
import { fade, slide } from "svelte/transition";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/stores";
import {
	conversations,
	createNewConversation,
	deleteConversationById,
	renameConversation,
	moveConversationToProject,
	clearProjectFromConversations,
	upsertConversationLocal,
	toggleConversationSidebarPin,
	savePinnedConversationOrder,
} from "$lib/stores/conversations";
import {
	projects as projectsStore,
	createProject,
	renameProject,
	deleteProject,
	reconcileProjectSnapshot,
	toggleProjectSidebarPin,
	saveProjectOrder,
} from "$lib/stores/projects";
import {
	clearProjectFolderExpanded,
	currentConversationId,
	projectFolderExpanded,
	setProjectFolderExpanded,
	sidebarOpen,
	SIDEBAR_DESKTOP_BREAKPOINT,
} from "$lib/stores/ui";
import { t } from "$lib/i18n";
import type { ConversationListItem, Project } from "$lib/types";
import ConversationItem from "./ConversationItem.svelte";
import ProjectItem from "./ProjectItem.svelte";
import SidebarReorderControls from "./SidebarReorderControls.svelte";

type SidebarConversationListItem = ConversationListItem & {
	sidebarPinned?: boolean;
	sidebarSortOrder?: number | null;
};

type SidebarProject = Project & {
	sidebarPinned?: boolean;
};

type SidebarReorderMove = { id: string; direction: "up" | "down" };
type ProjectReorderGroup = "pinned" | "unpinned";

let {
	initialConversations = [],
	initialProjects = [],
}: {
	initialConversations?: SidebarConversationListItem[];
	initialProjects?: SidebarProject[];
} = $props();

let projectsStoreReady = $state(false);
let conversationsStoreReady = $state(false);
let supportsDragAndDrop = $state(true);
let draggedConversationId = $state<string | null>(null);
type SidebarReorderState =
	| { kind: "pinned-conversation"; id: string }
	| { kind: "project"; id: string; group: ProjectReorderGroup }
	| null;
let activeSidebarReorder = $state<SidebarReorderState>(null);
type SidebarDropTarget =
	| { kind: "project"; projectId: string }
	| { kind: "unorganized" }
	| null;
let dropTarget = $state<SidebarDropTarget>(null);
type OpenSidebarMenu =
	| { kind: "conversation"; id: string }
	| { kind: "project"; id: string }
	| null;
onMount(() => {
	reconcileProjectSnapshot(initialProjects);
	projectsStoreReady = true;
	conversationsStoreReady = true;
});

let openSidebarMenu = $state<OpenSidebarMenu>(null);
const expandedProjects = $derived($projectFolderExpanded);
let isCreatingProject = $state(false);
let newProjectName = $state("");
let newProjectInputRef = $state<HTMLInputElement | undefined>(undefined);
let creatingProjectConversationId = $state<string | null>(null);

const visibleConversations: SidebarConversationListItem[] = $derived(
	(conversationsStoreReady
		? $conversations
		: initialConversations) as SidebarConversationListItem[],
);

const allProjects: SidebarProject[] = $derived(
	(projectsStoreReady ? $projectsStore : initialProjects) as SidebarProject[],
);
const activeDraggedConversation = $derived.by(() =>
	draggedConversationId
		? (visibleConversations.find(
				(conversation) => conversation.id === draggedConversationId,
			) ?? null)
		: null,
);
const canDropIntoUnorganized = $derived(
	activeDraggedConversation?.projectId != null,
);
const projectsById = $derived.by(
	() => new Map(allProjects.map((project) => [project.id, project])),
);

function getProjectReorderGroup(project: SidebarProject): ProjectReorderGroup {
	return project.sidebarPinned ? "pinned" : "unpinned";
}

function compareSidebarSortOrder(
	leftOrder: number | null | undefined,
	rightOrder: number | null | undefined,
	leftFallback: number,
	rightFallback: number,
) {
	return (leftOrder ?? leftFallback) - (rightOrder ?? rightFallback);
}

const pinnedConversations = $derived.by(() =>
	visibleConversations
		.filter((conversation) => conversation.sidebarPinned)
		.sort((left, right) => {
			const order = compareSidebarSortOrder(
				left.sidebarSortOrder,
				right.sidebarSortOrder,
				Number.MAX_SAFE_INTEGER - left.updatedAt,
				Number.MAX_SAFE_INTEGER - right.updatedAt,
			);
			return order || right.updatedAt - left.updatedAt;
		}),
);

const sortedProjects = $derived.by(() =>
	[...allProjects].sort((left, right) => {
		const pinOrder =
			Number(Boolean(right.sidebarPinned)) -
			Number(Boolean(left.sidebarPinned));
		if (pinOrder) return pinOrder;
		const order = left.sortOrder - right.sortOrder;
		return order || left.createdAt - right.createdAt;
	}),
);

const projectReorderMeta = $derived.by(() => {
	const map = new Map<
		string,
		{ group: ProjectReorderGroup; index: number; total: number }
	>();
	for (const group of ["pinned", "unpinned"] as const) {
		const groupProjects = sortedProjects.filter(
			(project) => getProjectReorderGroup(project) === group,
		);
		groupProjects.forEach((project, index) => {
			map.set(project.id, { group, index, total: groupProjects.length });
		});
	}
	return map;
});

const conversationsByProject = $derived.by(() => {
	const map: Record<string, SidebarConversationListItem[]> = {};
	for (const p of allProjects) {
		map[p.id] = [];
	}
	const unorganized: SidebarConversationListItem[] = [];
	for (const conv of visibleConversations) {
		if (conv.sidebarPinned) continue;
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
	return (
		visibleConversations.find((conversation) => conversation.id === id) ?? null
	);
}

function leftCurrentDropTarget(event: DragEvent) {
	const currentTarget = event.currentTarget as HTMLElement | null;
	const nextTarget = event.relatedTarget as Node | null;
	return !(currentTarget && nextTarget && currentTarget.contains(nextTarget));
}

function getDraggedConversationId(event: DragEvent) {
	return (
		event.dataTransfer?.getData("application/x-alfyai-conversation") ||
		event.dataTransfer?.getData("text/plain") ||
		null
	);
}

function setMoveDropEffect(event: DragEvent) {
	event.preventDefault();
	event.stopPropagation();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "move";
	}
}

function moveId(ids: string[], sourceId: string, targetId: string) {
	if (sourceId === targetId) return ids;
	const next = ids.filter((id) => id !== sourceId);
	const targetIndex = next.indexOf(targetId);
	if (targetIndex === -1) return ids;
	next.splice(targetIndex, 0, sourceId);
	return next;
}

function moveIdByDirection(
	ids: string[],
	id: string,
	direction: "up" | "down",
) {
	const currentIndex = ids.indexOf(id);
	if (currentIndex === -1) return ids;
	const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
	if (nextIndex < 0 || nextIndex >= ids.length) return ids;
	const next = [...ids];
	[next[currentIndex], next[nextIndex]] = [next[nextIndex], next[currentIndex]];
	return next;
}

function isConversationMenuOpen(id: string) {
	return openSidebarMenu?.kind === "conversation" && openSidebarMenu.id === id;
}

function isProjectMenuOpen(id: string) {
	return openSidebarMenu?.kind === "project" && openSidebarMenu.id === id;
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
		console.error("Navigation failed:", err);
		currentConversationId.set(previousConversationId);
	}
}

async function handleRename(payload: { id: string; title: string }) {
	const { id, title } = payload;
	closeAllMenus();
	try {
		await renameConversation(id, title);
	} catch (e) {
		console.error("Rename failed", e);
		alert($t("sidebar.failedRenameConversation"));
	}
}

async function handleDelete(payload: { id: string }) {
	const { id } = payload;
	closeAllMenus();
	try {
		await deleteConversationById(id);
		if ($currentConversationId === id) {
			currentConversationId.set(null);
			goto("/");
		}
	} catch (e) {
		console.error("Delete failed", e);
		alert($t("sidebar.failedDeleteConversation"));
	}
}

async function handleMoveToProject(payload: {
	id: string;
	projectId: string | null;
}) {
	const { id, projectId } = payload;
	closeAllMenus();
	clearDragState();
	try {
		await moveConversationToProject(id, projectId);
	} catch (e) {
		console.error("Move to project failed", e);
		alert($t("sidebar.failedMoveConversation"));
	}
}

async function handleConversationTogglePin(payload: {
	id: string;
	pinned: boolean;
}) {
	const { id, pinned } = payload;
	closeAllMenus();
	clearDragState();
	try {
		await toggleConversationSidebarPin(id, pinned);
	} catch (e) {
		console.error("Conversation pin update failed", e);
		alert($t("sidebar.failedUpdateConversationPin"));
	}
}

function handlePinnedConversationReorderStart(payload: { id: string }) {
	activeSidebarReorder = { kind: "pinned-conversation", id: payload.id };
	closeAllMenus();
	clearDragState();
}

function handleSidebarReorderEnd() {
	activeSidebarReorder = null;
}

function handlePinnedConversationReorderDragOver(event: DragEvent) {
	if (activeSidebarReorder?.kind !== "pinned-conversation") return;
	event.preventDefault();
	event.stopPropagation();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "move";
	}
}

async function persistPinnedConversationOrder(ids: string[]) {
	try {
		await savePinnedConversationOrder(ids);
	} catch (e) {
		console.error("Pinned conversation reorder failed", e);
		alert($t("sidebar.failedReorderSidebar"));
	}
}

async function handlePinnedConversationReorderDrop(targetId: string) {
	if (activeSidebarReorder?.kind !== "pinned-conversation") return;
	const ids = pinnedConversations.map((conversation) => conversation.id);
	const nextIds = moveId(ids, activeSidebarReorder.id, targetId);
	activeSidebarReorder = null;
	if (nextIds === ids) return;
	await persistPinnedConversationOrder(nextIds);
}

async function handlePinnedConversationMove(payload: SidebarReorderMove) {
	const ids = pinnedConversations.map((conversation) => conversation.id);
	const nextIds = moveIdByDirection(ids, payload.id, payload.direction);
	if (nextIds === ids) return;
	await persistPinnedConversationOrder(nextIds);
}

function handleMenuToggle(payload: { id: string; open: boolean }) {
	const { id, open } = payload;
	openSidebarMenu = open ? { kind: "conversation", id } : null;
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
	dropTarget = { kind: "project", projectId: payload.id };
}

function handleProjectDragLeave(payload: { id: string }) {
	if (dropTarget?.kind === "project" && dropTarget.projectId === payload.id) {
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

	if (
		!draggedConversation ||
		draggedConversation.projectId === payload.projectId
	) {
		return;
	}

	try {
		await moveConversationToProject(conversationId, payload.projectId);
		setProjectFolderExpanded(payload.projectId, true);
	} catch (e) {
		console.error("Drag to project failed", e);
		alert($t("sidebar.failedMoveConversation"));
	}
}

function handleUnorganizedDragOver() {
	if (!draggedConversationId) return;
	if (
		!activeDraggedConversation ||
		activeDraggedConversation.projectId == null
	) {
		dropTarget = null;
		return;
	}
	dropTarget = { kind: "unorganized" };
}

function handleUnorganizedDragLeave() {
	if (dropTarget?.kind === "unorganized") {
		dropTarget = null;
	}
}

async function handleUnorganizedDropConversation(
	conversationId?: string | null,
) {
	const resolvedConversationId = conversationId ?? draggedConversationId;
	const draggedConversation = getConversationById(resolvedConversationId);
	clearDragState();
	if (
		!resolvedConversationId ||
		!draggedConversation ||
		draggedConversation.projectId == null
	) {
		return;
	}

	try {
		await moveConversationToProject(resolvedConversationId, null);
	} catch (e) {
		console.error("Drag to unorganized failed", e);
		alert($t("sidebar.failedMoveConversation"));
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
		console.error("Rename project failed", e);
		alert($t("sidebar.failedRenameProject"));
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
		console.error("Delete project failed", e);
		alert($t("sidebar.failedDeleteProject"));
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
		upsertConversationLocal(
			conversationId,
			"New Conversation",
			Date.now() / 1000,
			projectId,
		);
		currentConversationId.set(conversationId);
		await goto(`/chat/${conversationId}?view=bootstrap`);
	} catch (e) {
		console.error("Create project conversation failed", e);
		alert($t("sidebar.failedCreateProjectConversation"));
	} finally {
		creatingProjectConversationId = null;
	}
}

async function handleProjectTogglePin(payload: {
	id: string;
	pinned: boolean;
}) {
	const { id, pinned } = payload;
	closeAllMenus();
	clearDragState();
	try {
		await toggleProjectSidebarPin(id, pinned);
	} catch (e) {
		console.error("Project pin update failed", e);
		alert($t("sidebar.failedUpdateProjectPin"));
	}
}

function handleProjectReorderStart(payload: { id: string }) {
	const project = allProjects.find((candidate) => candidate.id === payload.id);
	if (!project) return;
	activeSidebarReorder = {
		kind: "project",
		id: payload.id,
		group: getProjectReorderGroup(project),
	};
	closeAllMenus();
	clearDragState();
}

function handleProjectReorderDragOver(
	event: DragEvent,
	targetProject: SidebarProject,
) {
	if (activeSidebarReorder?.kind !== "project") return;
	if (activeSidebarReorder.group !== getProjectReorderGroup(targetProject))
		return;
	event.preventDefault();
	event.stopPropagation();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "move";
	}
}

function buildProjectOrderWithGroup(
	group: ProjectReorderGroup,
	groupIds: string[],
) {
	const pinnedIds = sortedProjects
		.filter((project) => getProjectReorderGroup(project) === "pinned")
		.map((project) => project.id);
	const unpinnedIds = sortedProjects
		.filter((project) => getProjectReorderGroup(project) === "unpinned")
		.map((project) => project.id);
	return group === "pinned"
		? [...groupIds, ...unpinnedIds]
		: [...pinnedIds, ...groupIds];
}

async function persistProjectOrder(ids: string[]) {
	try {
		const projectById = new Map(
			allProjects.map((project) => [project.id, project]),
		);
		await saveProjectOrder({
			pinnedIds: ids.filter((id) => projectById.get(id)?.sidebarPinned),
			unpinnedIds: ids.filter((id) => !projectById.get(id)?.sidebarPinned),
		});
	} catch (e) {
		console.error("Project reorder failed", e);
		alert($t("sidebar.failedReorderSidebar"));
	}
}

async function handleProjectReorderDrop(targetProject: SidebarProject) {
	if (activeSidebarReorder?.kind !== "project") return;
	const targetGroup = getProjectReorderGroup(targetProject);
	if (activeSidebarReorder.group !== targetGroup) {
		activeSidebarReorder = null;
		return;
	}
	const groupIds = sortedProjects
		.filter((project) => getProjectReorderGroup(project) === targetGroup)
		.map((project) => project.id);
	const nextGroupIds = moveId(
		groupIds,
		activeSidebarReorder.id,
		targetProject.id,
	);
	activeSidebarReorder = null;
	if (nextGroupIds === groupIds) return;
	await persistProjectOrder(
		buildProjectOrderWithGroup(targetGroup, nextGroupIds),
	);
}

async function handleProjectMove(payload: SidebarReorderMove) {
	const project = allProjects.find((candidate) => candidate.id === payload.id);
	if (!project) return;
	const group = getProjectReorderGroup(project);
	const groupIds = sortedProjects
		.filter((candidate) => getProjectReorderGroup(candidate) === group)
		.map((candidate) => candidate.id);
	const nextGroupIds = moveIdByDirection(
		groupIds,
		payload.id,
		payload.direction,
	);
	if (nextGroupIds === groupIds) return;
	await persistProjectOrder(buildProjectOrderWithGroup(group, nextGroupIds));
}

function handleProjectMenuToggle(payload: { id: string; open: boolean }) {
	const { id, open } = payload;
	openSidebarMenu = open ? { kind: "project", id } : null;
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
	newProjectName = "";
	setTimeout(() => newProjectInputRef?.focus(), 0);
}

async function commitCreateProject() {
	const name = newProjectName.trim();
	isCreatingProject = false;
	newProjectName = "";
	if (!name) return;
	try {
		const project = await createProject(name);
		setProjectFolderExpanded(project.id, true);
	} catch (e) {
		console.error("Create project failed", e);
		alert($t("sidebar.failedCreateProject"));
	}
}

function handleNewProjectKeydown(e: KeyboardEvent) {
	if (e.key === "Enter") {
		e.preventDefault();
		commitCreateProject();
	} else if (e.key === "Escape") {
		isCreatingProject = false;
	}
}
</script>

<div class="flex h-full flex-col gap-0">
	{#if pinnedConversations.length > 0}
		<div data-testid="pinned-conversations-section" class="mb-1">
			<div class="px-2 py-1">
				<span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">{$t('sidebar.pinned')}</span>
			</div>
			<div class="flex flex-col gap-0 px-1">
				{#each pinnedConversations as conversation, i (conversation.id)}
					<div
						class="sidebar-reorder-row flex items-center gap-1 rounded-lg"
						role="group"
						aria-label={$t('sidebar.reorderItem', { label: conversation.title })}
						ondragover={handlePinnedConversationReorderDragOver}
						ondrop={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void handlePinnedConversationReorderDrop(conversation.id);
						}}
					>
						<SidebarReorderControls
							id={conversation.id}
							label={conversation.title}
							index={i}
							total={pinnedConversations.length}
							onMove={handlePinnedConversationMove}
							onDragStart={handlePinnedConversationReorderStart}
							onDragEnd={handleSidebarReorderEnd}
						/>
						<div class="min-w-0 flex-1">
							<ConversationItem
								{conversation}
								active={$currentConversationId === conversation.id}
								menuOpen={isConversationMenuOpen(conversation.id)}
								projects={allProjects}
								projectLabel={conversation.projectId ? projectsById.get(conversation.projectId)?.name ?? null : null}
								dragEnabled={false}
								isDragging={activeSidebarReorder?.kind === 'pinned-conversation' && activeSidebarReorder.id === conversation.id}
								onSelect={handleSelect}
								onRename={handleRename}
								onDelete={handleDelete}
								onTogglePin={handleConversationTogglePin}
								onMoveToProject={handleMoveToProject}
								onMenuToggle={handleMenuToggle}
								onMenuClose={handleMenuClose}
							/>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

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
				{#each sortedProjects as project (project.id)}
					{@const reorderMeta = projectReorderMeta.get(project.id)}
					<div
						class="sidebar-reorder-row flex items-start gap-1 rounded-lg"
						role="group"
						aria-label={$t('sidebar.reorderItem', { label: project.name })}
						ondragover={(event) => {
							handleProjectReorderDragOver(event, project);
						}}
						ondrop={(event) => {
							if (activeSidebarReorder?.kind === 'project') {
								event.preventDefault();
								event.stopPropagation();
								void handleProjectReorderDrop(project);
							}
						}}
					>
						<SidebarReorderControls
							id={project.id}
							label={project.name}
							index={reorderMeta?.index ?? 0}
							total={reorderMeta?.total ?? sortedProjects.length}
							onMove={handleProjectMove}
							onDragStart={handleProjectReorderStart}
							onDragEnd={handleSidebarReorderEnd}
						/>
						<div class="min-w-0 flex-1">
							<div
								class="project-drop-zone rounded-xl border border-transparent"
								class:project-drop-zone-active={dropTarget?.kind === 'project' && dropTarget.projectId === project.id}
								role="group"
								aria-label={$t('sidebar.projectDropArea', { name: project.name })}
								ondragover={(event) => {
									if (activeSidebarReorder?.kind === 'project') return;
									setMoveDropEffect(event);
									handleProjectDragOver({ id: project.id });
								}}
								ondragleave={(event) => {
									if (leftCurrentDropTarget(event)) {
										handleProjectDragLeave({ id: project.id });
									}
								}}
								ondrop={(event) => {
									if (activeSidebarReorder?.kind === 'project') return;
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
									onTogglePin={handleProjectTogglePin}
									onMenuToggle={handleProjectMenuToggle}
									onMenuClose={handleProjectMenuClose}
								/>
								<!-- Conversations inside this project -->
								{#if expandedProjects[project.id] ?? false}
									<div
										data-testid={`project-conversations-${project.id}`}
										class="overflow-hidden"
										transition:slide={{ duration: 200 }}
									>
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
												onTogglePin={handleConversationTogglePin}
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
						</div>
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
					onTogglePin={handleConversationTogglePin}
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
