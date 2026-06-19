import { writable } from "svelte/store";
import {
	createConversation,
	deleteConversation,
	fetchConversations,
	moveConversationToProject as moveConversationRequest,
	renameConversation as renameConversationRequest,
	savePinnedConversationSidebarOrder,
	setConversationSidebarPinned,
} from "$lib/client/api/conversations";
import {
	dispatchWorkspaceConversationDeleted,
	removeConversationFromPersistedWorkspaceDocumentState,
} from "$lib/client/document-workspace-state";
import type { ConversationListItem } from "$lib/types";

export const conversations = writable<ConversationListItem[]>([]);

type SidebarConversationFields = {
	sidebarPinned?: boolean;
	sidebarSortOrder?: number | null;
};

type SidebarConversationListItem = ConversationListItem &
	SidebarConversationFields;

const optimisticConversationIds = new Set<string>();
const deletedConversationIds = new Set<string>();
const localConversationProjectIds = new Map<string, string | null>();
const localConversationSidebarStates = new Map<
	string,
	{ sidebarPinned: boolean; sidebarSortOrder: number | null }
>();
const seenAtlasBadgeKeys = new Set<string>();
let conversationSnapshotUserId: string | null = null;
let lastSuccessfulConversationSnapshotAt = 0;

interface LoadConversationsOptions {
	force?: boolean;
	minIntervalMs?: number;
}

interface LoadConversationsResult {
	refreshed: boolean;
}

function isTransientRefreshError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return (
		error instanceof TypeError ||
		message.includes("failed to fetch") ||
		message.includes("networkerror") ||
		message.includes("network error") ||
		message.includes("timed out") ||
		message.includes("timeout")
	);
}

function getSidebarPinned(item: ConversationListItem): boolean {
	return (item as SidebarConversationListItem).sidebarPinned === true;
}

function getSidebarSortOrder(item: ConversationListItem): number | null {
	const order = (item as SidebarConversationListItem).sidebarSortOrder;
	return typeof order === "number" && Number.isFinite(order) ? order : null;
}

function sortConversationsForSidebar(
	items: ConversationListItem[],
): ConversationListItem[] {
	return items
		.map(normalizeConversationListItem)
		.map((item, index) => ({ item, index }))
		.sort((left, right) => {
			const leftPinned = getSidebarPinned(left.item);
			const rightPinned = getSidebarPinned(right.item);
			if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

			if (leftPinned) {
				const leftOrder = getSidebarSortOrder(left.item);
				const rightOrder = getSidebarSortOrder(right.item);
				if (
					leftOrder !== null &&
					rightOrder !== null &&
					leftOrder !== rightOrder
				) {
					return leftOrder - rightOrder;
				}
				if (leftOrder !== null && rightOrder === null) return -1;
				if (leftOrder === null && rightOrder !== null) return 1;
				return left.index - right.index;
			}

			return (
				right.item.updatedAt - left.item.updatedAt || left.index - right.index
			);
		})
		.map(({ item }) => item);
}

function nextTopPinnedConversationOrder(items: ConversationListItem[]): number {
	const pinnedOrders = items
		.filter(getSidebarPinned)
		.map(getSidebarSortOrder)
		.filter((order): order is number => order !== null);
	if (pinnedOrders.length === 0) return -1;
	return Math.min(...pinnedOrders) - 1;
}

function getConversationSidebarState(item: ConversationListItem): {
	sidebarPinned: boolean;
	sidebarSortOrder: number | null;
} {
	return {
		sidebarPinned: getSidebarPinned(item),
		sidebarSortOrder: getSidebarSortOrder(item),
	};
}

function normalizeConversationListItem(
	item: ConversationListItem,
): ConversationListItem {
	return {
		...item,
		projectId: item.projectId ?? null,
		sidebarPinned: getSidebarPinned(item),
		sidebarSortOrder: getSidebarSortOrder(item),
	};
}

function atlasBadgeSeenKey(item: ConversationListItem): string | null {
	const badge = item.atlasBadge;
	if (!badge?.jobId) return null;
	const completedOrUpdatedAt = badge.completedAt ?? badge.updatedAt;
	if (typeof completedOrUpdatedAt !== "number") return null;
	return `${item.id}:${badge.jobId}:${completedOrUpdatedAt}`;
}

function suppressSeenAtlasBadge(
	item: ConversationListItem,
): ConversationListItem {
	const seenKey = atlasBadgeSeenKey(item);
	if (!seenKey || !seenAtlasBadgeKeys.has(seenKey)) return item;
	return { ...item, atlasBadge: undefined };
}

function conversationSidebarStateMatches(
	item: ConversationListItem,
	state: { sidebarPinned: boolean; sidebarSortOrder: number | null },
): boolean {
	return (
		getSidebarPinned(item) === state.sidebarPinned &&
		getSidebarSortOrder(item) === state.sidebarSortOrder
	);
}

function applyConversationSidebarState(
	item: ConversationListItem,
	state: { sidebarPinned: boolean; sidebarSortOrder: number | null },
): ConversationListItem {
	return {
		...item,
		sidebarPinned: state.sidebarPinned,
		sidebarSortOrder: state.sidebarSortOrder,
	};
}

function applyConversationMutationResults(items: ConversationListItem[]): void {
	if (items.length === 0) return;
	const normalizedItems = items
		.map(normalizeConversationListItem)
		.map(suppressSeenAtlasBadge);
	const incomingById = new Map(normalizedItems.map((item) => [item.id, item]));
	conversations.update((current) => {
		const seenIds = new Set<string>();
		const merged = current.map((conversation) => {
			const incoming = incomingById.get(conversation.id);
			if (!incoming) return conversation;
			seenIds.add(conversation.id);
			return { ...conversation, ...incoming };
		});

		for (const item of normalizedItems) {
			if (!seenIds.has(item.id)) merged.push(item);
		}

		return sortConversationsForSidebar(merged);
	});
}

export function reconcileConversationSnapshot(
	items: ConversationListItem[],
	options: { resetLocalState?: boolean; userId?: string | null } = {},
): void {
	lastSuccessfulConversationSnapshotAt = Date.now();
	const ownerChanged =
		options.userId !== undefined &&
		conversationSnapshotUserId !== null &&
		conversationSnapshotUserId !== options.userId;
	const shouldReset = Boolean(options.resetLocalState || ownerChanged);
	const incoming = shouldReset
		? items
		: items.filter((item) => !deletedConversationIds.has(item.id));

	conversations.update((current) => {
		if (shouldReset) {
			optimisticConversationIds.clear();
			deletedConversationIds.clear();
			localConversationProjectIds.clear();
			localConversationSidebarStates.clear();
			seenAtlasBadgeKeys.clear();
			conversationSnapshotUserId = options.userId ?? null;
			return sortConversationsForSidebar(
				incoming
					.map(normalizeConversationListItem)
					.map(suppressSeenAtlasBadge),
			);
		}

		if (options.userId !== undefined) {
			conversationSnapshotUserId = options.userId;
		}

		const mergedIncoming = incoming.map((item) => {
			let nextItem = item;
			if (localConversationProjectIds.has(item.id)) {
				const localProjectId = localConversationProjectIds.get(item.id) ?? null;
				if ((item.projectId ?? null) === localProjectId) {
					localConversationProjectIds.delete(item.id);
				} else {
					nextItem = { ...nextItem, projectId: localProjectId };
				}
			}

			const localSidebarState = localConversationSidebarStates.get(item.id);
			if (!localSidebarState) return suppressSeenAtlasBadge(nextItem);
			if (conversationSidebarStateMatches(item, localSidebarState)) {
				localConversationSidebarStates.delete(item.id);
				return suppressSeenAtlasBadge(nextItem);
			}
			return suppressSeenAtlasBadge(
				applyConversationSidebarState(nextItem, localSidebarState),
			);
		});

		const next = new Map(mergedIncoming.map((item) => [item.id, item]));
		for (const item of current) {
			if (deletedConversationIds.has(item.id)) continue;
			if (!optimisticConversationIds.has(item.id)) continue;
			if (!next.has(item.id)) {
				next.set(item.id, item);
			}
		}

		for (const item of mergedIncoming) {
			optimisticConversationIds.delete(item.id);
		}

		return sortConversationsForSidebar(Array.from(next.values()));
	});
}

export function clearConversationStore(): void {
	optimisticConversationIds.clear();
	deletedConversationIds.clear();
	localConversationProjectIds.clear();
	localConversationSidebarStates.clear();
	seenAtlasBadgeKeys.clear();
	conversationSnapshotUserId = null;
	lastSuccessfulConversationSnapshotAt = 0;
	conversations.set([]);
}

export function markConversationAtlasBadgeSeen(id: string): void {
	conversations.update((items) => {
		let changed = false;
		const nextItems = items.map((item) => {
			if (item.id !== id) return item;
			const seenKey = atlasBadgeSeenKey(item);
			if (!seenKey) return item;
			seenAtlasBadgeKeys.add(seenKey);
			if (!item.atlasBadge) return item;
			changed = true;
			return { ...item, atlasBadge: undefined };
		});
		return changed ? nextItems : items;
	});
}

export async function loadConversations(
	options: LoadConversationsOptions = {},
): Promise<LoadConversationsResult> {
	const minIntervalMs = options.minIntervalMs ?? 0;
	if (
		!options.force &&
		minIntervalMs > 0 &&
		lastSuccessfulConversationSnapshotAt > 0 &&
		Date.now() - lastSuccessfulConversationSnapshotAt < minIntervalMs
	) {
		return { refreshed: false };
	}

	try {
		reconcileConversationSnapshot(await fetchConversations());
		return { refreshed: true };
	} catch (error) {
		if (!isTransientRefreshError(error)) {
			console.warn("Error loading conversations:", error);
		}
		return { refreshed: false };
	}
}

let isCreating = false;

export async function createNewConversation(
	options: { projectId?: string | null } = {},
): Promise<string> {
	if (isCreating) {
		throw new Error("Please wait, a conversation is already being created.");
	}

	isCreating = true;
	try {
		const conversation = await createConversation(undefined, options);
		return conversation.id;
	} catch (error) {
		console.error("Error in createNewConversation:", error);
		if (error instanceof Error) {
			throw error;
		}
		throw new Error(
			"An unexpected error occurred while creating a conversation. Please try again.",
		);
	} finally {
		isCreating = false;
	}
}

export function upsertConversationLocal(
	id: string,
	title = "New Conversation",
	updatedAt = Date.now() / 1000,
	projectId?: string | null,
): void {
	optimisticConversationIds.add(id);
	deletedConversationIds.delete(id);
	if (projectId !== undefined) {
		localConversationProjectIds.set(id, projectId);
	}
	conversations.update((items) => {
		const existingIndex = items.findIndex((item) => item.id === id);
		if (existingIndex === -1) {
			return [
				{
					id,
					title,
					updatedAt,
					projectId: projectId ?? null,
					sidebarPinned: false,
					sidebarSortOrder: null,
				},
				...items,
			];
		}

		const nextItems = [...items];
		nextItems[existingIndex] = {
			...nextItems[existingIndex],
			updatedAt,
			...(projectId !== undefined ? { projectId } : {}),
		};
		return nextItems;
	});
}

export function removeConversationLocal(id: string): void {
	optimisticConversationIds.delete(id);
	deletedConversationIds.add(id);
	localConversationProjectIds.delete(id);
	localConversationSidebarStates.delete(id);
	conversations.update((items) =>
		items.filter((conversation) => conversation.id !== id),
	);
}

export async function deleteConversationById(id: string): Promise<void> {
	await deleteConversation(id);
	if (typeof window !== "undefined") {
		removeConversationFromPersistedWorkspaceDocumentState(
			window.sessionStorage,
			id,
		);
		dispatchWorkspaceConversationDeleted(id);
	}
	optimisticConversationIds.delete(id);
	deletedConversationIds.add(id);
	localConversationProjectIds.delete(id);
	localConversationSidebarStates.delete(id);
	conversations.update((items) =>
		items.filter((conversation) => conversation.id !== id),
	);
}

export async function renameConversation(
	id: string,
	title: string,
): Promise<void> {
	await renameConversationRequest(id, title);
	conversations.update((items) =>
		items.map((conversation) =>
			conversation.id === id ? { ...conversation, title } : conversation,
		),
	);
}

export function updateConversationTitleLocal(id: string, title: string): void {
	conversations.update((items) =>
		items.map((conversation) =>
			conversation.id === id ? { ...conversation, title } : conversation,
		),
	);
}

export async function toggleConversationSidebarPin(
	id: string,
	sidebarPinned?: boolean,
): Promise<void> {
	let previousConversation: ConversationListItem | null = null;
	let previousSidebarState:
		| { sidebarPinned: boolean; sidebarSortOrder: number | null }
		| undefined;
	let hadPreviousSidebarState = false;
	let nextPinned = Boolean(sidebarPinned);
	let optimisticSidebarState:
		| { sidebarPinned: boolean; sidebarSortOrder: number | null }
		| undefined;

	conversations.update((items) => {
		const current = items.find((conversation) => conversation.id === id);
		if (!current) return items;
		previousConversation = current;
		hadPreviousSidebarState = localConversationSidebarStates.has(id);
		previousSidebarState = localConversationSidebarStates.get(id);
		nextPinned = sidebarPinned ?? !getSidebarPinned(current);
		const nextSidebarState = {
			sidebarPinned: nextPinned,
			sidebarSortOrder: nextPinned
				? nextTopPinnedConversationOrder(items)
				: null,
		};
		optimisticSidebarState = nextSidebarState;
		localConversationSidebarStates.set(id, optimisticSidebarState);
		return sortConversationsForSidebar(
			items.map((conversation) =>
				conversation.id === id
					? applyConversationSidebarState(conversation, nextSidebarState)
					: conversation,
			),
		);
	});

	try {
		const updatedConversation = await setConversationSidebarPinned(
			id,
			nextPinned,
		);
		localConversationSidebarStates.set(
			id,
			getConversationSidebarState(updatedConversation),
		);
		conversations.update((items) =>
			sortConversationsForSidebar(
				items.map((conversation) =>
					conversation.id === id
						? { ...conversation, ...updatedConversation }
						: conversation,
				),
			),
		);
	} catch (error) {
		if (
			optimisticSidebarState &&
			localConversationSidebarStates.get(id) === optimisticSidebarState
		) {
			if (hadPreviousSidebarState && previousSidebarState) {
				localConversationSidebarStates.set(id, previousSidebarState);
			} else {
				localConversationSidebarStates.delete(id);
			}
		}
		const restoredConversation = previousConversation;
		if (restoredConversation) {
			conversations.update((items) =>
				sortConversationsForSidebar(
					items.map((conversation) =>
						conversation.id === id ? restoredConversation : conversation,
					),
				),
			);
		}
		throw error;
	}
}

export async function savePinnedConversationOrder(
	orderedIds: string[],
): Promise<void> {
	const orderedIdSet = new Set(orderedIds);
	let previousItems: ConversationListItem[] = [];
	const previousSidebarStates = new Map<
		string,
		{
			hadState: boolean;
			state?: { sidebarPinned: boolean; sidebarSortOrder: number | null };
		}
	>();
	const optimisticSidebarStates = new Map<
		string,
		{ sidebarPinned: boolean; sidebarSortOrder: number | null }
	>();

	conversations.update((items) => {
		previousItems = items;
		for (const id of orderedIds) {
			previousSidebarStates.set(id, {
				hadState: localConversationSidebarStates.has(id),
				state: localConversationSidebarStates.get(id),
			});
		}

		const nextItems = items.map((conversation) => {
			if (!orderedIdSet.has(conversation.id)) return conversation;
			const nextSidebarState = {
				sidebarPinned: true,
				sidebarSortOrder: orderedIds.indexOf(conversation.id),
			};
			optimisticSidebarStates.set(conversation.id, nextSidebarState);
			localConversationSidebarStates.set(conversation.id, nextSidebarState);
			return applyConversationSidebarState(conversation, nextSidebarState);
		});

		return sortConversationsForSidebar(nextItems);
	});

	try {
		const updatedConversations =
			await savePinnedConversationSidebarOrder(orderedIds);
		if (Array.isArray(updatedConversations)) {
			applyConversationMutationResults(updatedConversations);
		}
	} catch (error) {
		for (const [id, state] of optimisticSidebarStates) {
			if (localConversationSidebarStates.get(id) !== state) continue;
			const previous = previousSidebarStates.get(id);
			if (previous?.hadState && previous.state) {
				localConversationSidebarStates.set(id, previous.state);
			} else {
				localConversationSidebarStates.delete(id);
			}
		}
		conversations.set(previousItems);
		throw error;
	}
}

export async function moveConversationToProject(
	id: string,
	projectId: string | null,
): Promise<void> {
	let previousProjectId: string | null = null;
	let foundConversation = false;
	const hadPreviousLocalProjectId = localConversationProjectIds.has(id);
	const previousLocalProjectId = localConversationProjectIds.get(id) ?? null;
	localConversationProjectIds.set(id, projectId);
	conversations.update((items) =>
		items.map((conversation) => {
			if (conversation.id !== id) return conversation;
			previousProjectId = conversation.projectId ?? null;
			foundConversation = true;
			return { ...conversation, projectId };
		}),
	);
	try {
		await moveConversationRequest(id, projectId);
	} catch (error) {
		if (localConversationProjectIds.get(id) === projectId) {
			if (hadPreviousLocalProjectId) {
				localConversationProjectIds.set(id, previousLocalProjectId);
			} else {
				localConversationProjectIds.delete(id);
			}
		}
		if (foundConversation) {
			conversations.update((items) =>
				items.map((conversation) => {
					if (
						conversation.id !== id ||
						(conversation.projectId ?? null) !== projectId
					) {
						return conversation;
					}
					return { ...conversation, projectId: previousProjectId };
				}),
			);
		}
		throw error;
	}
}

export function clearProjectFromConversations(projectId: string): void {
	conversations.update((items) =>
		items.map((conversation) => {
			if (conversation.projectId !== projectId) return conversation;
			localConversationProjectIds.set(conversation.id, null);
			return { ...conversation, projectId: null };
		}),
	);
}
