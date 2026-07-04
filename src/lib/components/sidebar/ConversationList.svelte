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
	markConversationAtlasBadgeSeen,
	toggleConversationSidebarPin,
	savePinnedConversationOrder,
} from "$lib/stores/conversations";
import {
	projects as projectsStore,
	createProject,
	renameProject,
	deleteProject,
	reconcileProjectSnapshot,
	saveProjectOrder,
} from "$lib/stores/projects";
import {
	clearProjectFolderExpanded,
	currentConversationId,
	projectFolderExpanded,
	setProjectFolderExpanded,
	setSidebarChatsExpandedAndSync,
	setSidebarProjectsExpandedAndSync,
	setSidebarPinnedExpandedAndSync,
	sidebarChatsExpanded,
	sidebarOpen,
	sidebarPinnedExpanded,
	sidebarProjectsExpanded,
	SIDEBAR_DESKTOP_BREAKPOINT,
} from "$lib/stores/ui";
import { t } from "$lib/i18n";
import {
	ChevronRight,
	Folder,
	FolderPlus,
	MessageSquare,
	Pin,
	Plus,
} from "@lucide/svelte";
import { countProjectConversations } from "./project-count";
import type { ConversationListItem, Project } from "$lib/types";
import ConversationItem from "./ConversationItem.svelte";
import ProjectItem from "./ProjectItem.svelte";
import SidebarReorderRow from "./SidebarReorderRow.svelte";

type SidebarConversationListItem = ConversationListItem & {
	sidebarPinned?: boolean;
	sidebarSortOrder?: number | null;
};

type SidebarProject = Project;

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
	| { kind: "project"; id: string }
	| null;
let activeSidebarReorder = $state<SidebarReorderState>(null);
type SidebarDropTarget =
	| { kind: "project"; projectId: string }
	| { kind: "unorganized" }
	| null;
let dropTarget = $state<SidebarDropTarget>(null);
type ReorderInsertPosition = "before" | "after";
let projectReorderDropTarget = $state<{
	targetId: string;
	position: ReorderInsertPosition;
} | null>(null);
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
const projectsSectionExpanded = $derived($sidebarProjectsExpanded);
const chatsSectionExpanded = $derived($sidebarChatsExpanded);
const pinnedSectionExpanded = $derived($sidebarPinnedExpanded);
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
		const order = left.sortOrder - right.sortOrder;
		return order || left.createdAt - right.createdAt;
	}),
);

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
	return moveIdToPosition(ids, sourceId, targetId, "before", {
		returnOriginalWhenUnchanged: false,
	});
}

function areIdsEqual(left: string[], right: string[]) {
	return (
		left.length === right.length &&
		left.every((id, index) => id === right[index])
	);
}

function moveIdToPosition(
	ids: string[],
	sourceId: string,
	targetId: string,
	position: ReorderInsertPosition,
	options: { returnOriginalWhenUnchanged?: boolean } = {},
) {
	if (sourceId === targetId) return ids;
	const next = ids.filter((id) => id !== sourceId);
	const targetIndex = next.indexOf(targetId);
	if (targetIndex === -1) return ids;

	next.splice(
		position === "after" ? targetIndex + 1 : targetIndex,
		0,
		sourceId,
	);
	if (options.returnOriginalWhenUnchanged === false) return next;
	return areIdsEqual(next, ids) ? ids : next;
}

function getReorderInsertPosition(event: DragEvent): ReorderInsertPosition {
	const currentTarget = event.currentTarget as HTMLElement | null;
	if (!currentTarget) return "before";
	const rect = currentTarget.getBoundingClientRect();
	return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

function isConversationMenuOpen(id: string) {
	return openSidebarMenu?.kind === "conversation" && openSidebarMenu.id === id;
}

function isProjectMenuOpen(id: string) {
	return openSidebarMenu?.kind === "project" && openSidebarMenu.id === id;
}

$effect(() => {
	const activeConversationId = $currentConversationId;
	const activeConversation = visibleConversations.find(
		(conversation) => conversation.id === activeConversationId,
	);
	if (activeConversation?.atlasBadge) {
		markConversationAtlasBadgeSeen(activeConversation.id);
	}
});

async function handleSelect(payload: { id: string }) {
	const id = payload.id;
	markConversationAtlasBadgeSeen(id);
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
	projectReorderDropTarget = null;
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

function handlePinnedConversationRegularDragOver(target: SidebarDropTarget) {
	if (activeSidebarReorder?.kind !== "pinned-conversation") return;
	dropTarget = target;
}

async function handlePinnedConversationDropToRegularArea(payload: {
	projectId: string | null;
}) {
	if (activeSidebarReorder?.kind !== "pinned-conversation") return;
	const conversationId = activeSidebarReorder.id;
	activeSidebarReorder = null;
	dropTarget = null;

	try {
		const conversation = getConversationById(conversationId);
		if (!conversation) return;
		if (conversation?.projectId !== payload.projectId) {
			await moveConversationToProject(conversationId, payload.projectId);
		}
		await toggleConversationSidebarPin(conversationId, false);
	} catch (e) {
		console.error("Pinned conversation drop failed", e);
		alert($t("sidebar.failedUpdateConversationPin"));
	}
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

function handleProjectReorderStart(payload: { id: string }) {
	const project = allProjects.find((candidate) => candidate.id === payload.id);
	if (!project) return;
	activeSidebarReorder = {
		kind: "project",
		id: payload.id,
	};
	closeAllMenus();
	clearDragState();
}

function handleProjectReorderDragOver(
	event: DragEvent,
	targetProject: SidebarProject,
) {
	if (activeSidebarReorder?.kind !== "project") return;
	event.preventDefault();
	event.stopPropagation();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "move";
	}
	projectReorderDropTarget =
		activeSidebarReorder.id === targetProject.id
			? null
			: {
					targetId: targetProject.id,
					position: getReorderInsertPosition(event),
				};
}

async function persistProjectOrder(ids: string[]) {
	try {
		await saveProjectOrder({ ids });
	} catch (e) {
		console.error("Project reorder failed", e);
		alert($t("sidebar.failedReorderSidebar"));
	}
}

async function handleProjectReorderDrop(targetProject: SidebarProject) {
	if (activeSidebarReorder?.kind !== "project") return;
	const projectIds = sortedProjects.map((project) => project.id);
	const insertPosition =
		projectReorderDropTarget?.targetId === targetProject.id
			? projectReorderDropTarget.position
			: "before";
	const nextGroupIds = moveIdToPosition(
		projectIds,
		activeSidebarReorder.id,
		targetProject.id,
		insertPosition,
	);
	activeSidebarReorder = null;
	projectReorderDropTarget = null;
	if (nextGroupIds === projectIds) return;
	await persistProjectOrder(nextGroupIds);
}

function isProjectReorderLineActive(
	projectId: string,
	previousProjectId: string | null,
) {
	if (!projectReorderDropTarget) return false;
	if (projectReorderDropTarget.position === "before") {
		return projectReorderDropTarget.targetId === projectId;
	}
	return projectReorderDropTarget.targetId === previousProjectId;
}

function isProjectReorderEndLineActive() {
	const lastProject = sortedProjects[sortedProjects.length - 1];
	return (
		projectReorderDropTarget?.position === "after" &&
		projectReorderDropTarget.targetId === lastProject?.id
	);
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

// ── Section toggle handlers ────────────────────────────────────────────────

function toggleProjectsSection() {
	const next = !projectsSectionExpanded;
	void setSidebarProjectsExpandedAndSync(next);
}

function toggleChatsSection() {
	const next = !chatsSectionExpanded;
	void setSidebarChatsExpandedAndSync(next);
}

function togglePinnedSection() {
	const next = !pinnedSectionExpanded;
	void setSidebarPinnedExpandedAndSync(next);
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
			<!-- Section header (collapsible, matches Projects/Chats headers) -->
			<div class="px-2 py-1">
				<button
					class="flex items-center gap-1 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					aria-label={pinnedSectionExpanded ? $t('sidebar.collapsePinnedSection') : $t('sidebar.expandPinnedSection')}
					onclick={togglePinnedSection}
				>
					<span class="flex h-4 w-4 shrink-0 items-center justify-center text-icon-muted transition-transform duration-150" class:rotate-90={pinnedSectionExpanded}>
						<ChevronRight size={12} strokeWidth={2.5} aria-hidden="true" />
					</span>
					<Pin size={12} strokeWidth={2.4} class="shrink-0 text-icon-muted" aria-hidden="true" />
					<span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">{$t('sidebar.pinned')}</span>
				</button>
			</div>
			{#if pinnedSectionExpanded}
				<div class="flex flex-col gap-0 px-1" transition:slide={{ duration: 200 }}>
					{#each pinnedConversations as conversation (conversation.id)}
						<SidebarReorderRow
							id={conversation.id}
							label={conversation.title}
							active={activeSidebarReorder?.kind === 'pinned-conversation' && activeSidebarReorder.id === conversation.id}
							onDragStart={handlePinnedConversationReorderStart}
							onDragEnd={handleSidebarReorderEnd}
							onDragOver={handlePinnedConversationReorderDragOver}
							onDrop={(event) => {
								event.preventDefault();
								event.stopPropagation();
								void handlePinnedConversationReorderDrop(conversation.id);
							}}
						>
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
						</SidebarReorderRow>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- ── Projects section ──────────────────────────────────────────────── -->
	{#if allProjects.length > 0 || isCreatingProject}
		<div class="mb-0.5">
			<!-- Section header -->
			<div class="group flex items-center justify-between px-2 py-1">
				<button
					class="flex items-center gap-1 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					aria-label={projectsSectionExpanded ? $t('sidebar.collapseProjectsSection') : $t('sidebar.expandProjectsSection')}
					onclick={toggleProjectsSection}
				>
					<span class="flex h-4 w-4 shrink-0 items-center justify-center text-icon-muted transition-transform duration-150" class:rotate-90={projectsSectionExpanded}>
						<ChevronRight size={12} strokeWidth={2.5} aria-hidden="true" />
					</span>
					<Folder size={12} strokeWidth={2.4} class="shrink-0 text-icon-muted" aria-hidden="true" />
					<span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">{$t('sidebar.projects')}</span>
				</button>
				<button
					class="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-icon-muted opacity-0 transition-opacity duration-100 hover:text-icon-primary group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
					title={$t('sidebar.newProject')}
					aria-label={$t('sidebar.createNewProject')}
					onclick={startCreateProject}
				>
					<Plus size={13} strokeWidth={2.5} aria-hidden="true" />
				</button>
			</div>

			<!-- Project list -->
			{#if projectsSectionExpanded}
				<div transition:slide={{ duration: 200 }}>
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
				{#each sortedProjects as project, index (project.id)}
					{@const previousProject = sortedProjects[index - 1] ?? null}
					<div
						data-testid={`project-reorder-line-${project.id}-before`}
						class="project-reorder-insert-line"
						class:project-reorder-insert-line-active={isProjectReorderLineActive(project.id, previousProject?.id ?? null)}
						aria-hidden="true"
					></div>
					<div
						data-testid="project-folder-drop-zone"
						data-project-id={project.id}
						class="project-drop-zone rounded-xl border border-transparent"
						class:project-drop-zone-active={dropTarget?.kind === 'project' && dropTarget.projectId === project.id}
						role="group"
						aria-label={$t('sidebar.projectDropArea', { name: project.name })}
						ondragover={(event) => {
							if (activeSidebarReorder?.kind === 'project') {
								handleProjectReorderDragOver(event, project);
								return;
							}
							setMoveDropEffect(event);
							if (activeSidebarReorder?.kind === 'pinned-conversation') {
								handlePinnedConversationRegularDragOver({
									kind: 'project',
									projectId: project.id
								});
								return;
							}
							handleProjectDragOver({ id: project.id });
						}}
						ondragleave={(event) => {
							if (activeSidebarReorder?.kind === 'project') {
								if (leftCurrentDropTarget(event) && projectReorderDropTarget?.targetId === project.id) {
									projectReorderDropTarget = null;
								}
								return;
							}
							if (leftCurrentDropTarget(event)) {
								handleProjectDragLeave({ id: project.id });
							}
						}}
						ondrop={(event) => {
							if (activeSidebarReorder?.kind === 'project') {
								event.preventDefault();
								event.stopPropagation();
								void handleProjectReorderDrop(project);
								return;
							}
							setMoveDropEffect(event);
							if (activeSidebarReorder?.kind === 'pinned-conversation') {
								void handlePinnedConversationDropToRegularArea({
									projectId: project.id
								});
								return;
							}
							void handleProjectDropConversation({
								projectId: project.id,
								conversationId: getDraggedConversationId(event)
							});
						}}
					>
						<SidebarReorderRow
							id={project.id}
							label={project.name}
							active={activeSidebarReorder?.kind === 'project' && activeSidebarReorder.id === project.id}
							onDragStart={handleProjectReorderStart}
							onDragEnd={handleSidebarReorderEnd}
							onDragOver={(event) => {
								handleProjectReorderDragOver(event, project);
							}}
							onDrop={(event) => {
								if (activeSidebarReorder?.kind === 'project') {
									event.preventDefault();
									event.stopPropagation();
									void handleProjectReorderDrop(project);
								}
							}}
						>
							<ProjectItem
								{project}
								expanded={expandedProjects[project.id] ?? false}
								menuOpen={isProjectMenuOpen(project.id)}
								dropActive={dropTarget?.kind === 'project' && dropTarget.projectId === project.id}
								creatingConversation={creatingProjectConversationId === project.id}
								chatCount={countProjectConversations(visibleConversations, project.id)}
								onToggle={handleProjectToggle}
								onCreateConversation={handleCreateConversationInProject}
								onRename={handleProjectRename}
								onDelete={handleProjectDelete}
								onMenuToggle={handleProjectMenuToggle}
								onMenuClose={handleProjectMenuClose}
							/>
						</SidebarReorderRow>
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
				{/each}
				<div
					data-testid="project-reorder-line-end"
					class="project-reorder-insert-line"
					class:project-reorder-insert-line-active={isProjectReorderEndLineActive()}
					aria-hidden="true"
				></div>
			</div>
			</div>
			{/if}
		</div>

		<!-- Divider between projects and unorganized chats -->
		{#if conversationsByProject.unorganized.length > 0}
			<div class="my-1 border-t border-border-subtle mx-2"></div>
		{/if}
	{:else}
		<!-- No projects yet: header + creative empty notice -->
		<div class="group flex items-center justify-between px-2 py-1">
			<button
				class="flex items-center gap-1 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				aria-label={projectsSectionExpanded ? $t('sidebar.collapseProjectsSection') : $t('sidebar.expandProjectsSection')}
				onclick={toggleProjectsSection}
			>
				<span class="flex h-4 w-4 shrink-0 items-center justify-center text-icon-muted transition-transform duration-150" class:rotate-90={projectsSectionExpanded}>
					<ChevronRight size={12} strokeWidth={2.5} aria-hidden="true" />
				</span>
				<Folder size={12} strokeWidth={2.4} class="shrink-0 text-icon-muted" aria-hidden="true" />
				<span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">{$t('sidebar.projects')}</span>
			</button>
			<button
				class="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-icon-muted opacity-0 transition-opacity duration-100 hover:text-icon-primary group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
				title={$t('sidebar.newProject')}
				aria-label={$t('sidebar.createNewProject')}
				onclick={startCreateProject}
			>
				<Plus size={13} strokeWidth={2.5} aria-hidden="true" />
			</button>
		</div>
		{#if projectsSectionExpanded}
			<div transition:slide={{ duration: 200 }}>
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
							<FolderPlus size={14} strokeWidth={2} aria-hidden="true" />
						</div>
						<div>
							<p class="text-[12px] font-medium text-text-secondary">{$t('sidebar.noProjectsYet')}</p>
							<p class="text-[11px] text-text-muted">{$t('sidebar.groupChatsCreateOne')}</p>
						</div>
					</button>
				{/if}
			</div>
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
			if (activeSidebarReorder?.kind === 'project') return;
			setMoveDropEffect(event);
			if (activeSidebarReorder?.kind === 'pinned-conversation') {
				handlePinnedConversationRegularDragOver({ kind: 'unorganized' });
				return;
			}
			handleUnorganizedDragOver();
		}}
		ondragleave={(event) => {
			if (leftCurrentDropTarget(event)) {
				handleUnorganizedDragLeave();
			}
		}}
		ondrop={(event) => {
			if (activeSidebarReorder?.kind === 'project') return;
			setMoveDropEffect(event);
			if (activeSidebarReorder?.kind === 'pinned-conversation') {
				void handlePinnedConversationDropToRegularArea({ projectId: null });
				return;
			}
			void handleUnorganizedDropConversation(getDraggedConversationId(event));
		}}
	>
		{#if allProjects.length > 0 || conversationsByProject.unorganized.length > 0 || canDropIntoUnorganized || visibleConversations.length >= 0}
				<div class="px-1 pb-1 pt-0.5">
					<div class="flex items-center justify-between gap-2">
						<button
							class="flex items-center gap-1 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
							aria-label={chatsSectionExpanded ? $t('sidebar.collapseChatsSection') : $t('sidebar.expandChatsSection')}
							onclick={toggleChatsSection}
						>
							<span class="flex h-4 w-4 shrink-0 items-center justify-center text-icon-muted transition-transform duration-150" class:rotate-90={chatsSectionExpanded}>
								<ChevronRight size={12} strokeWidth={2.5} aria-hidden="true" />
							</span>
							<MessageSquare size={12} strokeWidth={2.4} class="shrink-0 text-icon-muted" aria-hidden="true" />
							<span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">{$t('sidebar.chats')}</span>
						</button>
					</div>
				</div>
		{/if}
		{#if chatsSectionExpanded}
			<div transition:slide={{ duration: 200 }}>
				{#if visibleConversations.length === 0}
					<div class="flex h-20 items-center justify-center p-4 text-sm text-text-muted">
						{$t('sidebar.noConversationsYet')}
					</div>
				{:else if conversationsByProject.unorganized.length === 0}
					<!-- All conversations are inside projects/pinned; keep an empty-state inside Chats so the section never vanishes. -->
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

	.project-reorder-insert-line {
		height: 2px;
		margin: 0;
		border-radius: 999px;
		background: transparent;
		opacity: 0;
		pointer-events: none;
		transition:
			background-color 100ms cubic-bezier(0.4, 0, 0.2, 1),
			opacity 100ms cubic-bezier(0.4, 0, 0.2, 1);
	}

	.project-reorder-insert-line-active {
		background: var(--accent);
		opacity: 1;
	}

	.empty-projects-btn {
		border-color: color-mix(in srgb, var(--border-default) 50%, transparent 50%);
	}

	.empty-projects-btn:hover {
		background: color-mix(in srgb, var(--surface-elevated) 60%, var(--surface-overlay) 40%);
		border-color: var(--border-default);
	}
</style>
