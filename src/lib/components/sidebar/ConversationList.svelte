<script lang="ts">
import { fade, slide } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";
import { onMount, tick, untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/stores";
import {
	conversations,
	deleteConversationById,
	deleteConversationsByIds,
	renameConversation,
	moveConversationToProject,
	moveConversationsToProject,
	clearProjectFromConversations,
	markConversationAtlasBadgeSeen,
	setConversationsSidebarPinned,
	toggleConversationSidebarPin,
	savePinnedConversationOrder,
} from "$lib/stores/conversations";
import { showToast } from "$lib/stores/toast";
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
import { t, type I18nKey } from "$lib/i18n";
import { hasOpenDialog } from "$lib/components/ui/DialogShell.svelte";
import { conversationDisplayTitle } from "$lib/shared/conversation-title";
import {
	ChevronRight,
	Folder,
	FolderPlus,
	MessageSquare,
	Pin,
	Plus,
} from "@lucide/svelte";
import { countProjectConversations } from "./project-count";
import type { ConversationListItem } from "$lib/server/services/conversations";
import type { Project } from "$lib/server/services/projects";
import { markProjectComposerFocus } from "$lib/client/conversation-session";
import ConfirmDialog from "../ui/ConfirmDialog.svelte";
import ConversationItem from "./ConversationItem.svelte";
import ProjectItem from "./ProjectItem.svelte";
import SidebarReorderRow from "./SidebarReorderRow.svelte";
import SidebarSelectionBar from "./SidebarSelectionBar.svelte";
import {
	bulkPinAction,
	pruneSelected,
	selectRange,
	shownConversationOrder,
	toggleSelected,
} from "./sidebar-selection";

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

// prefers-reduced-motion: the CSS reset in app.css cannot reach these
// JS-driven transitions (see motion.ts), so wrap them explicitly.
const sectionSlide = reducedMotionAware(slide);
const rowFade = reducedMotionAware(fade);

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

// ── Selection ──────────────────────────────────────────────────────────────
//
// The list owns the selection: `ConversationItem` and `SidebarSelectionBar`
// only say what the person did. The rules (what a click adds, what a range
// covers, what is pruned) are the pure functions in `./sidebar-selection`, and
// every change replaces the set, so state sees it.

let selectedIds = $state<ReadonlySet<string>>(new Set());
// The chat last clicked into or out of the selection: where a Shift-click starts.
let selectionAnchorId = $state<string | null>(null);
// A bulk call is running: nothing changes the selection until it has answered.
let bulkBusy = $state(false);
let bulkDeleteConfirmOpen = $state(false);

const selecting = $derived(selectedIds.size > 0);

// The chats on screen, top to bottom: what a range runs over, what Select all
// takes, and the only chats a selection may hold.
const shownOrder = $derived(
	shownConversationOrder({
		pinned: {
			expanded: pinnedSectionExpanded,
			ids: pinnedConversations.map((conversation) => conversation.id),
		},
		projects: {
			expanded: projectsSectionExpanded,
			folders: sortedProjects.map((project) => ({
				expanded: expandedProjects[project.id] ?? false,
				ids: (conversationsByProject.byProject[project.id] ?? []).map(
					(conversation) => conversation.id,
				),
			})),
		},
		chats: {
			expanded: chatsSectionExpanded,
			ids: conversationsByProject.unorganized.map(
				(conversation) => conversation.id,
			),
		},
	}),
);
const shownIds = $derived(new Set(shownOrder));
const conversationsById = $derived(
	new Map(
		visibleConversations.map((conversation) => [conversation.id, conversation]),
	),
);
// The selected chats in the order shown: what Pin and Move send.
const selectedConversations = $derived(
	shownOrder.flatMap((id) => {
		const conversation = conversationsById.get(id);
		return conversation && selectedIds.has(id) ? [conversation] : [];
	}),
);
const pinAction = $derived(bulkPinAction(selectedConversations));
const canSelectAll = $derived(shownOrder.some((id) => !selectedIds.has(id)));
const canRemoveFromProject = $derived(
	selectedConversations.some((conversation) => conversation.projectId != null),
);

// The bar goes away with the selection, and a button of it that holds the focus
// takes the focus along to <body>: a keyboard user would start again from the
// top of the page. So when the bar holds the focus as the selection ends, the
// focus goes to a row, once the bar is gone: the one the selection was anchored
// on while it is still shown, otherwise the first one shown. Focus that was
// somewhere else (the composer, a row) stays where it is.
let listRoot = $state<HTMLDivElement | undefined>(undefined);
let selectionBar = $state<{ holdsFocus(): boolean } | undefined>(undefined);
// Whether the bar held the focus when Delete was pressed: the dialog has the
// focus from then on, and the bar's buttons are switched off while the delete
// runs, so by the time the selection ends the answer can no longer be read.
let deleteStartedFromBar = false;

function barHoldsFocus(): boolean {
	return selectionBar?.holdsFocus() ?? false;
}

function rowElement(id: string): HTMLElement | null {
	const rows =
		listRoot?.querySelectorAll<HTMLElement>("[data-conversation-id]") ?? [];
	return (
		Array.from(rows).find((row) => row.dataset.conversationId === id) ?? null
	);
}

async function focusRowAfterSelection(anchorId: string | null) {
	// After the DOM has caught up: the bar is gone and the rows are where they stay.
	await tick();
	const id =
		anchorId !== null && shownIds.has(anchorId) ? anchorId : shownOrder[0];
	if (id !== undefined) rowElement(id)?.focus();
}

// `refocus` is whether the bar held the focus, asked now unless the caller knows
// better (a bulk call asked when the person acted, before its buttons went off).
function endSelection({ refocus = barHoldsFocus() } = {}) {
	const anchorId = selectionAnchorId;
	if (selectedIds.size > 0) selectedIds = new Set();
	selectionAnchorId = null;
	bulkDeleteConfirmOpen = false;
	if (refocus) void focusRowAfterSelection(anchorId);
}

// A selection holds only chats on screen: one deleted elsewhere, and the chats
// of a section or folder that was collapsed, leave it. Writes only when
// something was pruned, so the effect settles after one more run. Not while a
// bulk call runs: Move and Pin show their result before the server answers, and
// a chat that is moved or pinned out of sight (into a collapsed folder or
// section) must still be in the selection if the answer is that it failed.
$effect(() => {
	if (bulkBusy || selectedIds.size === 0) return;
	const kept = pruneSelected(selectedIds, shownIds);
	if (kept.size === selectedIds.size) return;
	selectedIds = kept;
	if (kept.size === 0) endSelection();
});

// Closing the sidebar (the phone drawer) ends the selection. Collapsing it on
// a desktop unmounts the list, which ends it anyway. No focus goes to a row: the
// rows are leaving the screen with the drawer.
$effect(() => {
	if (!$sidebarOpen) untrack(() => endSelection({ refocus: false }));
});

function handleSelectionToggle(payload: { id: string; range: boolean }) {
	if (bulkBusy) return;
	const { id, range } = payload;
	if (!selecting) {
		closeAllMenus();
		clearDragState();
		activeSidebarReorder = null;
		projectReorderDropTarget = null;
	}
	if (range) {
		// The anchor is null only while nothing is selected, and then it is the open
		// chat; when that is not on screen the range is only the clicked chat.
		const anchor = selectionAnchorId ?? $currentConversationId;
		selectedIds = selectRange(selectedIds, shownOrder, anchor, id);
	} else {
		selectedIds = toggleSelected(selectedIds, id);
	}
	selectionAnchorId = id;
	if (selectedIds.size === 0) endSelection();
}

function handleSelectionClose() {
	if (bulkBusy) return;
	endSelection();
}

function handleSelectAll() {
	if (bulkBusy) return;
	selectedIds = new Set(shownOrder);
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (event.key !== "Escape" || !selecting || bulkBusy) return;
	// A press that something else handled, a dialog that owns it (whichever
	// listener runs first, the dialog stack knows), or a text field it is typed
	// into is not for the selection.
	if (event.defaultPrevented || hasOpenDialog()) return;
	if (
		event.target instanceof Element &&
		event.target.closest(
			"input, textarea, select, [contenteditable]:not([contenteditable='false'])",
		)
	) {
		return;
	}
	endSelection();
}

// One bulk call: the selection stays as it is while it runs, and afterwards
// keeps only the chats that failed and are still selected, so that the answer
// of a call never brings back a selection the person ended meanwhile. A chat
// the call could not do stays selected, and the person is told how many.
async function runBulkAction(
	ids: string[],
	run: () => Promise<{ failedIds: string[] }>,
	failureMessage: I18nKey,
	// Asked before `bulkBusy` switches the bar's buttons off: a browser drops the
	// focus of a button that is disabled, so it is gone by the time the call ends.
	refocus = barHoldsFocus(),
) {
	bulkBusy = true;
	closeAllMenus();
	clearDragState();
	let failedIds: string[];
	try {
		({ failedIds } = await run());
	} catch (error) {
		// The store reports a chat it could not do in `failedIds`; a throw is
		// something else, and the person is told that nothing is known to be done.
		console.error("Bulk conversation action failed", error);
		failedIds = ids;
	}
	bulkBusy = false;
	selectedIds = pruneSelected(selectedIds, new Set(failedIds));
	if (selectedIds.size === 0) endSelection({ refocus });
	if (failedIds.length > 0) {
		showToast({
			type: "error",
			message: $t(failureMessage, { count: failedIds.length }),
		});
	}
}

function handleBulkDeleteRequest() {
	if (bulkBusy || !selecting) return;
	deleteStartedFromBar = barHoldsFocus();
	bulkDeleteConfirmOpen = true;
}

async function confirmBulkDelete() {
	bulkDeleteConfirmOpen = false;
	if (bulkBusy) return;
	const ids = selectedConversations.map((conversation) => conversation.id);
	if (ids.length === 0) return;
	const openChatId = $currentConversationId;
	if (openChatId !== null && ids.includes(openChatId)) {
		// Home first, then the batch: the server ends a deleted chat's streaming
		// reply as a stop, so the chat on screen would show that for as long as
		// the batch, which deletes one chat after another, runs.
		currentConversationId.set(null);
		void goto("/");
	}
	await runBulkAction(
		ids,
		() => deleteConversationsByIds(ids),
		"sidebar.bulkDeleteFailed",
		deleteStartedFromBar,
	);
}

async function handleBulkPin() {
	if (bulkBusy || !selecting) return;
	const pin = pinAction === "pin";
	// Pin sends the unpinned ones only (a pinned chat stays where it is); Unpin
	// is offered only when every selected chat is pinned.
	const ids = selectedConversations
		.filter((conversation) => !pin || !conversation.sidebarPinned)
		.map((conversation) => conversation.id);
	await runBulkAction(
		ids,
		() => setConversationsSidebarPinned(ids, pin),
		"sidebar.bulkPinFailed",
	);
}

async function handleBulkMove(payload: { projectId: string | null }) {
	if (bulkBusy || !selecting) return;
	const { projectId } = payload;
	// A chat already in the project (or already out of any) has nothing to move.
	const ids = selectedConversations
		.filter((conversation) => (conversation.projectId ?? null) !== projectId)
		.map((conversation) => conversation.id);
	await runBulkAction(
		ids,
		() => moveConversationsToProject(ids, projectId),
		"sidebar.bulkMoveFailed",
	);
}

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
		// A move must never change the folder's own expanded/collapsed state
		// (owner-reported bug): a collapsed folder receiving a drop stays
		// collapsed, and an already-expanded one stays expanded. Do not
		// reintroduce a `setProjectFolderExpanded(...)` call here.
		await moveConversationToProject(conversationId, payload.projectId);
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

/**
 * Both of the project row's doors land on the project's own page, where the
 * composer already belongs to the folder — no conversation is created here
 * any more, so the first message cannot land outside it. The menu item adds
 * the composer-focus hand-off: it is the "start typing here" door, and the
 * project page consumes the marker to put the caret in the box.
 */
async function handleOpenProject(payload: {
	id: string;
	focusComposer?: boolean;
}) {
	closeAllMenus();
	clearDragState();
	setProjectFolderExpanded(payload.id, true);
	if (payload.focusComposer) {
		markProjectComposerFocus(payload.id);
	}
	await goto(`/projects/${payload.id}`);
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

<svelte:window onkeydown={handleWindowKeydown} />

<!-- min-h-full, not h-full: the selection bar is the last child and sticks to the
     bottom of the sidebar's scroll box, which needs a root as tall as its rows. -->
<div bind:this={listRoot} class="flex min-h-full flex-col gap-0">
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
				<div class="flex flex-col gap-0 px-1" transition:sectionSlide={{ duration: 200 }}>
					{#each pinnedConversations as conversation (conversation.id)}
						<SidebarReorderRow
							id={conversation.id}
							label={conversationDisplayTitle(conversation.title, $t('chat.untitledConversation'))}
							active={activeSidebarReorder?.kind === 'pinned-conversation' && activeSidebarReorder.id === conversation.id}
							disabled={selecting}
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
								{selecting}
								selected={selectedIds.has(conversation.id)}
								onSelect={handleSelect}
								onSelectionToggle={handleSelectionToggle}
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
				<div transition:sectionSlide={{ duration: 200 }}>
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
							disabled={selecting}
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
								chatCount={countProjectConversations(visibleConversations, project.id)}
								onToggle={handleProjectToggle}
								onOpenProject={handleOpenProject}
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
								transition:sectionSlide={{ duration: 200 }}
							>
								{#each conversationsByProject.byProject[project.id] ?? [] as conversation, i (conversation.id)}
									<div class="pl-4" in:rowFade={{ duration: 150, delay: i * 35 }}>
										<ConversationItem
											{conversation}
											active={$currentConversationId === conversation.id}
											menuOpen={isConversationMenuOpen(conversation.id)}
											projects={allProjects}
											dragEnabled={supportsDragAndDrop}
											isDragging={draggedConversationId === conversation.id}
											{selecting}
											selected={selectedIds.has(conversation.id)}
											onSelect={handleSelect}
											onSelectionToggle={handleSelectionToggle}
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
			<div transition:sectionSlide={{ duration: 200 }}>
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
			<div transition:sectionSlide={{ duration: 200 }}>
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
							{selecting}
							selected={selectedIds.has(conversation.id)}
							onSelect={handleSelect}
							onSelectionToggle={handleSelectionToggle}
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

	<!-- The bar of an open selection: the last child of the root, which sticks to
	     the bottom of the sidebar's scroll box (the bar carries its own offsets). -->
	{#if selecting}
		<SidebarSelectionBar
			bind:this={selectionBar}
			count={selectedIds.size}
			{canSelectAll}
			{pinAction}
			projects={sortedProjects}
			{canRemoveFromProject}
			busy={bulkBusy}
			onClose={handleSelectionClose}
			onSelectAll={handleSelectAll}
			onPin={handleBulkPin}
			onMove={handleBulkMove}
			onDelete={handleBulkDeleteRequest}
		/>
	{/if}
</div>

{#if bulkDeleteConfirmOpen}
	<ConfirmDialog
		title={$t('sidebar.deleteConversationsTitle', { count: selectedIds.size })}
		message={$t('sidebar.deleteConversationsMessage')}
		confirmText={$t('common.delete')}
		cancelText={$t('common.cancel')}
		confirmVariant="danger"
		onConfirm={confirmBulkDelete}
		onCancel={() => (bulkDeleteConfirmOpen = false)}
	/>
{/if}

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
