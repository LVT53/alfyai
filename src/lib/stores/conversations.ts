import { get, writable } from "svelte/store";
import {
	conversationExists,
	createConversation,
	deleteConversation,
	fetchConversations,
	moveConversationToProject as moveConversationRequest,
	renameConversation as renameConversationRequest,
	runConversationBatch,
	savePinnedConversationSidebarOrder,
	setConversationSidebarPinned,
} from "$lib/client/api/conversations";
import { ApiError } from "$lib/client/api/http";
import {
	dispatchWorkspaceConversationDeleted,
	removeConversationFromPersistedWorkspaceDocumentState,
} from "$lib/client/document-workspace-state";
import type {
	Conversation,
	ConversationListItem,
} from "$lib/server/services/conversations";
import { DEFAULT_CONVERSATION_TITLE } from "$lib/shared/conversation-title";

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
// Incognito flipped from the composer, by conversation id. Held so a row the
// sidebar has not listed yet (the landing page's prepared conversation) can
// carry the mask the moment it is upserted, rather than after the next
// server snapshot. Dropped once a snapshot lists the conversation: the
// composer persists before it reports, so the server's value is the truth.
const localConversationMemoryIncognito = new Map<string, boolean>();
const seenAtlasBadgeKeys = new Set<string>();
const SEEN_ATLAS_BADGE_STORAGE_PREFIX = "alfyai:seen-atlas-badges:v1";
const MAX_PERSISTED_SEEN_ATLAS_BADGE_KEYS = 500;
let conversationSnapshotUserId: string | null = null;
let seenAtlasBadgeKeysLoadedForUserId: string | null | undefined;
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

function seenAtlasBadgeStorageKey(userId: string | null): string {
	return `${SEEN_ATLAS_BADGE_STORAGE_PREFIX}:${userId ?? "anonymous"}`;
}

function getBrowserLocalStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage ?? null;
	} catch {
		return null;
	}
}

function readSeenAtlasBadgeStorage(userId: string | null): Set<string> {
	const storage = getBrowserLocalStorage();
	if (!storage) return new Set();
	try {
		const raw = storage.getItem(seenAtlasBadgeStorageKey(userId));
		if (!raw) return new Set();
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(
			parsed
				.filter(
					(key): key is string => typeof key === "string" && key.length > 0,
				)
				.slice(-MAX_PERSISTED_SEEN_ATLAS_BADGE_KEYS),
		);
	} catch {
		return new Set();
	}
}

function persistSeenAtlasBadgeStorage(userId: string | null): void {
	const storage = getBrowserLocalStorage();
	if (!storage) return;
	try {
		const keys = Array.from(seenAtlasBadgeKeys).slice(
			-MAX_PERSISTED_SEEN_ATLAS_BADGE_KEYS,
		);
		storage.setItem(seenAtlasBadgeStorageKey(userId), JSON.stringify(keys));
	} catch {
		// Best-effort only; the in-memory state still hides the badge this session.
	}
}

function hydrateSeenAtlasBadgeKeys(userId: string | null): void {
	if (seenAtlasBadgeKeysLoadedForUserId === userId) {
		return;
	}
	seenAtlasBadgeKeys.clear();
	for (const key of readSeenAtlasBadgeStorage(userId)) {
		seenAtlasBadgeKeys.add(key);
	}
	seenAtlasBadgeKeysLoadedForUserId = userId;
}

function suppressSeenAtlasBadge(
	item: ConversationListItem,
): ConversationListItem {
	hydrateSeenAtlasBadgeKeys(conversationSnapshotUserId);
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
			localConversationMemoryIncognito.clear();
			conversationSnapshotUserId = options.userId ?? null;
			hydrateSeenAtlasBadgeKeys(conversationSnapshotUserId);
			return sortConversationsForSidebar(
				incoming.map(normalizeConversationListItem).map(suppressSeenAtlasBadge),
			);
		}

		if (options.userId !== undefined) {
			conversationSnapshotUserId = options.userId;
			hydrateSeenAtlasBadgeKeys(conversationSnapshotUserId);
		}

		const mergedIncoming = incoming.map((item) => {
			let nextItem = item;
			localConversationMemoryIncognito.delete(item.id);
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
	localConversationMemoryIncognito.clear();
	// Preserve seenAtlasBadgeKeys and seenAtlasBadgeKeysLoadedForUserId across
	// logout/login so the accent circle does not reappear after re-login.
	// hydrateSeenAtlasBadgeKeys already handles user changes by comparing
	// seenAtlasBadgeKeysLoadedForUserId with the new userId and reloading from
	// localStorage when they differ.  conversationSnapshotUserId is kept so the
	// next reconcile can detect an actual owner change via ownerChanged.
	lastSuccessfulConversationSnapshotAt = 0;
	conversations.set([]);
}

export function markConversationAtlasBadgeSeen(id: string): void {
	hydrateSeenAtlasBadgeKeys(conversationSnapshotUserId);
	conversations.update((items) => {
		let changed = false;
		const nextItems = items.map((item) => {
			if (item.id !== id) return item;
			const seenKey = atlasBadgeSeenKey(item);
			if (!seenKey) return item;
			seenAtlasBadgeKeys.add(seenKey);
			persistSeenAtlasBadgeStorage(conversationSnapshotUserId);
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
	options: {
		projectId?: string | null;
		/** Incognito, one-way — armed atomically at creation. See conversations.ts client API. */
		memoryIncognito?: boolean;
	} = {},
): Promise<string> {
	if (isCreating) {
		throw new Error("Please wait, a conversation is already being created.");
	}

	isCreating = true;
	try {
		const conversation = await createConversation(undefined, options);
		if (options.memoryIncognito) {
			updateConversationMemoryIncognitoLocal(conversation.id, true);
		}
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
	title = DEFAULT_CONVERSATION_TITLE,
	updatedAt = Date.now() / 1000,
	projectId?: string | null,
	/**
	 * Incognito, one-way. Optional and one-way itself: pass `true` when the
	 * CALLER has authoritative, freshly-loaded server data (a conversation
	 * detail load, a fork response) saying this conversation is incognito;
	 * omit it otherwise and the existing local-map lookup below still
	 * applies. This exists because the landing page's own creation flow
	 * (`createNewConversation` → `updateConversationMemoryIncognitoLocal`)
	 * ends in a HARD navigation (`window.location.assign`, not a SvelteKit
	 * transition) once a conversation exists — a full page load that wipes
	 * every in-memory client map, including the one this function otherwise
	 * reads. The freshly-loaded chat page's own `data.conversation` is
	 * unaffected by that reset, so it is the one place that can still say
	 * the truth for this row's first paint on the new page.
	 */
	memoryIncognito?: boolean,
): void {
	optimisticConversationIds.add(id);
	deletedConversationIds.delete(id);
	if (projectId !== undefined) {
		localConversationProjectIds.set(id, projectId);
	}
	if (memoryIncognito) {
		localConversationMemoryIncognito.set(id, true);
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
					...(localConversationMemoryIncognito.has(id)
						? { memoryIncognito: localConversationMemoryIncognito.get(id) }
						: {}),
				},
				...items,
			];
		}

		const nextItems = [...items];
		nextItems[existingIndex] = {
			...nextItems[existingIndex],
			updatedAt,
			...(projectId !== undefined ? { projectId } : {}),
			...(memoryIncognito ? { memoryIncognito: true } : {}),
		};
		return nextItems;
	});
}

export function removeConversationLocal(id: string): void {
	optimisticConversationIds.delete(id);
	deletedConversationIds.add(id);
	localConversationProjectIds.delete(id);
	localConversationSidebarStates.delete(id);
	localConversationMemoryIncognito.delete(id);
	conversations.update((items) =>
		items.filter((conversation) => conversation.id !== id),
	);
}

// What a deleted conversation leaves behind in this browser: its row, and what
// the document workspace remembers about it. Shared by the single and the bulk
// delete, so both clean up the same way.
function forgetDeletedConversationLocally(id: string): void {
	// The server row is gone; the sidebar must follow before anything else
	// can throw. Workspace cleanup below is best effort.
	removeConversationLocal(id);

	if (typeof window !== "undefined") {
		try {
			removeConversationFromPersistedWorkspaceDocumentState(
				window.sessionStorage,
				id,
			);
		} catch (error) {
			console.warn("Workspace cleanup after conversation delete failed", error);
		}
		dispatchWorkspaceConversationDeleted(id);
	}
}

export async function deleteConversationById(id: string): Promise<void> {
	try {
		await deleteConversation(id);
	} catch (error) {
		// A failed request does not prove the conversation survived: the
		// connection can drop after the server finished the delete, and a
		// repeated tap answers 404 for a row the first one already removed.
		// Ask the server before reporting failure, so the sidebar never keeps
		// a conversation that is gone until the next full page load.
		if (!(await wasConversationDeleted(id, error))) throw error;
	}

	forgetDeletedConversationLocally(id);
}

async function wasConversationDeleted(
	id: string,
	error: unknown,
): Promise<boolean> {
	if (error instanceof ApiError) {
		if (error.status === 404) return true;
		if (error.status === 401) return false;
	}
	return (await conversationExists(id)) === false;
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

/**
 * The composer just flipped incognito for a conversation and the server has
 * it. Mirrors it onto the sidebar row so the mask changes with the switch,
 * the way a generated title lands without waiting for the next snapshot.
 */
export function updateConversationMemoryIncognitoLocal(
	id: string,
	memoryIncognito: boolean,
): void {
	localConversationMemoryIncognito.set(id, memoryIncognito);
	conversations.update((items) =>
		items.map((conversation) =>
			conversation.id === id
				? { ...conversation, memoryIncognito }
				: conversation,
		),
	);
}

type SidebarState = {
	sidebarPinned: boolean;
	sidebarSortOrder: number | null;
};

// One chat's optimistic pin or unpin, with what it takes to undo it. The
// single pin and the bulk pin both build, settle and undo these, so the
// optimistic machinery (the local sidebar-state map, the row state, the
// sidebar sort) exists once.
type LocalSidebarPin = {
	id: string;
	/** The row as it was before the change; the undo puts it back whole. */
	previousConversation: ConversationListItem;
	hadPreviousSidebarState: boolean;
	previousSidebarState: SidebarState | undefined;
	/**
	 * The state the change put in the local map. The undo only touches the map
	 * while it still holds exactly this: anything else is a newer decision.
	 */
	optimisticSidebarState: SidebarState;
};

// The optimistic half of a pin or unpin for one listed chat: remembers what
// to put back, keeps the new state in the local map (so a snapshot taken
// before the server answers cannot undo it) and returns the row as it shows
// from now on. Runs inside a `conversations.update`.
function startLocalSidebarPin(
	conversation: ConversationListItem,
	nextSidebarState: SidebarState,
	pins: LocalSidebarPin[],
): ConversationListItem {
	pins.push({
		id: conversation.id,
		previousConversation: conversation,
		hadPreviousSidebarState: localConversationSidebarStates.has(
			conversation.id,
		),
		previousSidebarState: localConversationSidebarStates.get(conversation.id),
		optimisticSidebarState: nextSidebarState,
	});
	localConversationSidebarStates.set(conversation.id, nextSidebarState);
	return applyConversationSidebarState(conversation, nextSidebarState);
}

// The server answered: its state is final, so it replaces the optimistic one
// in the local map and on the row.
function settleLocalSidebarPins(
	answers: Array<{ id: string; conversation: Conversation }>,
): void {
	if (answers.length === 0) return;
	for (const { id, conversation } of answers) {
		localConversationSidebarStates.set(
			id,
			getConversationSidebarState(conversation),
		);
	}
	const answerById = new Map(
		answers.map(({ id, conversation }) => [id, conversation]),
	);
	conversations.update((items) =>
		sortConversationsForSidebar(
			items.map((conversation) => {
				const answer = answerById.get(conversation.id);
				return answer ? { ...conversation, ...answer } : conversation;
			}),
		),
	);
}

// The pins did not happen: the rows and the local map go back to what they
// were before `startLocalSidebarPin`.
function undoLocalSidebarPins(pins: LocalSidebarPin[]): void {
	if (pins.length === 0) return;
	for (const pin of pins) {
		if (
			localConversationSidebarStates.get(pin.id) !== pin.optimisticSidebarState
		)
			continue;
		if (pin.hadPreviousSidebarState && pin.previousSidebarState) {
			localConversationSidebarStates.set(pin.id, pin.previousSidebarState);
		} else {
			localConversationSidebarStates.delete(pin.id);
		}
	}
	const previousById = new Map(
		pins.map((pin) => [pin.id, pin.previousConversation]),
	);
	conversations.update((items) =>
		sortConversationsForSidebar(
			items.map(
				(conversation) => previousById.get(conversation.id) ?? conversation,
			),
		),
	);
}

// The optimistic half of pinning or unpinning several chats at once.
// `nextTopPinnedConversationOrder` reads one snapshot, so asking it per chat
// would hand every chat the same order: it is read once, and the k-th of n
// chats takes `base - (n - 1 - k)`. The first chat of the selection ends on
// top of Pinned and the rest follow in the order given, which is the order the
// server gives them too.
function startLocalSidebarPins(
	ids: string[],
	sidebarPinned: boolean,
): LocalSidebarPin[] {
	const pins: LocalSidebarPin[] = [];
	const positions = new Map(ids.map((id, index) => [id, index]));
	conversations.update((items) => {
		const base = nextTopPinnedConversationOrder(items);
		return sortConversationsForSidebar(
			items.map((conversation) => {
				const position = positions.get(conversation.id);
				if (position === undefined) return conversation;
				return startLocalSidebarPin(
					conversation,
					{
						sidebarPinned,
						sidebarSortOrder: sidebarPinned
							? base - (ids.length - 1 - position)
							: null,
					},
					pins,
				);
			}),
		);
	});
	return pins;
}

export async function toggleConversationSidebarPin(
	id: string,
	sidebarPinned?: boolean,
): Promise<void> {
	const pins: LocalSidebarPin[] = [];
	let nextPinned = Boolean(sidebarPinned);

	conversations.update((items) => {
		const current = items.find((conversation) => conversation.id === id);
		if (!current) return items;
		nextPinned = sidebarPinned ?? !getSidebarPinned(current);
		const nextSidebarState = {
			sidebarPinned: nextPinned,
			sidebarSortOrder: nextPinned
				? nextTopPinnedConversationOrder(items)
				: null,
		};
		return sortConversationsForSidebar(
			items.map((conversation) =>
				conversation.id === id
					? startLocalSidebarPin(conversation, nextSidebarState, pins)
					: conversation,
			),
		);
	});

	try {
		const updatedConversation = await setConversationSidebarPinned(
			id,
			nextPinned,
		);
		settleLocalSidebarPins([{ id, conversation: updatedConversation }]);
	} catch (error) {
		undoLocalSidebarPins(pins);
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

// One chat's optimistic move into (or out of) a project, with what it takes to
// undo it. The single move and the bulk move both start and undo these.
type LocalProjectMove = {
	id: string;
	/** The project the move targets; null is out of any project. */
	projectId: string | null;
	hadPreviousLocalProjectId: boolean;
	previousLocalProjectId: string | null;
	/** The listed row's project before the move; only read when `found`. */
	previousProjectId: string | null;
	/** Whether the chat was listed, so there is a row to put back. */
	found: boolean;
};

// The optimistic half of a project move for each of `ids`: every listed row
// shows the new project at once, and the local map keeps the move so a
// snapshot taken before the server answers cannot undo it.
function startLocalProjectMoves(
	ids: string[],
	projectId: string | null,
): LocalProjectMove[] {
	const moves = new Map<string, LocalProjectMove>();
	for (const id of ids) {
		if (moves.has(id)) continue;
		moves.set(id, {
			id,
			projectId,
			hadPreviousLocalProjectId: localConversationProjectIds.has(id),
			previousLocalProjectId: localConversationProjectIds.get(id) ?? null,
			previousProjectId: null,
			found: false,
		});
		localConversationProjectIds.set(id, projectId);
	}
	conversations.update((items) =>
		items.map((conversation) => {
			const move = moves.get(conversation.id);
			if (!move) return conversation;
			move.previousProjectId = conversation.projectId ?? null;
			move.found = true;
			return { ...conversation, projectId };
		}),
	);
	return [...moves.values()];
}

// The moves did not happen: the local map and the rows go back to what they
// were before `startLocalProjectMoves`. A row is only put back while it still
// shows the move's own project, so a newer change to it is left alone.
function undoLocalProjectMoves(moves: LocalProjectMove[]): void {
	const listed = new Map<string, LocalProjectMove>();
	for (const move of moves) {
		if (localConversationProjectIds.get(move.id) === move.projectId) {
			if (move.hadPreviousLocalProjectId) {
				localConversationProjectIds.set(move.id, move.previousLocalProjectId);
			} else {
				localConversationProjectIds.delete(move.id);
			}
		}
		if (move.found) listed.set(move.id, move);
	}
	if (listed.size === 0) return;
	conversations.update((items) =>
		items.map((conversation) => {
			const move = listed.get(conversation.id);
			if (!move || (conversation.projectId ?? null) !== move.projectId) {
				return conversation;
			}
			return { ...conversation, projectId: move.previousProjectId };
		}),
	);
}

export async function moveConversationToProject(
	id: string,
	projectId: string | null,
): Promise<void> {
	const moves = startLocalProjectMoves([id], projectId);
	try {
		await moveConversationRequest(id, projectId);
	} catch (error) {
		undoLocalProjectMoves(moves);
		throw error;
	}
}

// What a bulk action reports: the chats it could not do, in the order they
// were given. A chat the server no longer has is not one of them: it is gone
// either way.
type BulkConversationOutcome = { failedIds: string[] };

// A chunk that failed, or an id its answer left out, says nothing about what
// the server did. So the server is asked: the list is loaded again and the
// rows it holds are the truth. A reload that fails leaves the rows as they
// were, which reads as "not done".
async function reloadListedConversations(): Promise<
	Map<string, ConversationListItem>
> {
	await loadConversations({ force: true });
	return new Map(get(conversations).map((item) => [item.id, item]));
}

/**
 * Deletes several conversations in one action. Nothing is removed from the
 * list before the server answers; then every chat the server deleted, and
 * every one it no longer had, leaves the list the way `deleteConversationById`
 * removes one. `failedIds` holds the chats the server could not delete.
 */
export async function deleteConversationsByIds(
	ids: string[],
): Promise<BulkConversationOutcome> {
	if (ids.length === 0) return { failedIds: [] };

	const results = await runConversationBatch({ action: "delete", ids });
	const failed = new Set<string>();
	const unknown: string[] = [];
	for (const result of results) {
		if (result.ok || result.error === "not_found") {
			forgetDeletedConversationLocally(result.id);
		} else if (result.error === "failed") {
			failed.add(result.id);
		} else {
			unknown.push(result.id);
		}
	}

	if (unknown.length > 0) {
		const listed = await reloadListedConversations();
		for (const id of unknown) {
			if (listed.has(id)) {
				failed.add(id);
			} else {
				forgetDeletedConversationLocally(id);
			}
		}
	}

	return { failedIds: ids.filter((id) => failed.has(id)) };
}

/**
 * Moves several conversations into a project (or out of any, with a null
 * `projectId`) in one action. Every listed row shows the move before the
 * server answers; a chat that failed goes back to its previous project, one
 * the server no longer has leaves the list, and the rest stay moved.
 */
export async function moveConversationsToProject(
	ids: string[],
	projectId: string | null,
): Promise<BulkConversationOutcome> {
	if (ids.length === 0) return { failedIds: [] };

	const moves = startLocalProjectMoves(ids, projectId);
	const results = await runConversationBatch({
		action: "move",
		ids,
		projectId,
	});
	const failed = new Set<string>();
	const unknown: string[] = [];
	const takenBack = new Set<string>();
	for (const result of results) {
		if (result.ok) continue;
		if (result.error === "not_found") {
			removeConversationLocal(result.id);
			continue;
		}
		takenBack.add(result.id);
		if (result.error === "failed") {
			failed.add(result.id);
		} else {
			unknown.push(result.id);
		}
	}
	// An unknown chat is taken back too: its optimistic state must not
	// override the snapshot that is about to decide it.
	undoLocalProjectMoves(moves.filter((move) => takenBack.has(move.id)));

	if (unknown.length > 0) {
		const listed = await reloadListedConversations();
		for (const id of unknown) {
			const row = listed.get(id);
			// A chat the reloaded list no longer holds is gone, not failed.
			if (row && (row.projectId ?? null) !== projectId) failed.add(id);
		}
	}

	return { failedIds: ids.filter((id) => failed.has(id)) };
}

/**
 * Pins or unpins several conversations in one action. Pinned chats go on top
 * of Pinned in the order given, and unpinned ones lose their manual order,
 * both before the server answers. A chat that failed goes back to its previous
 * pin state, and one the server no longer has leaves the list.
 */
export async function setConversationsSidebarPinned(
	ids: string[],
	sidebarPinned: boolean,
): Promise<BulkConversationOutcome> {
	if (ids.length === 0) return { failedIds: [] };

	const pins = startLocalSidebarPins(ids, sidebarPinned);
	const results = await runConversationBatch({
		action: "pin",
		ids,
		pinned: sidebarPinned,
	});
	const failed = new Set<string>();
	const unknown: string[] = [];
	const takenBack = new Set<string>();
	const answers: Array<{ id: string; conversation: Conversation }> = [];
	for (const result of results) {
		if (result.ok) {
			if (result.conversation) {
				answers.push({ id: result.id, conversation: result.conversation });
			}
			continue;
		}
		if (result.error === "not_found") {
			removeConversationLocal(result.id);
			continue;
		}
		takenBack.add(result.id);
		if (result.error === "failed") {
			failed.add(result.id);
		} else {
			unknown.push(result.id);
		}
	}
	// An unknown chat is taken back too: its optimistic state must not
	// override the snapshot that is about to decide it.
	undoLocalSidebarPins(pins.filter((pin) => takenBack.has(pin.id)));
	settleLocalSidebarPins(answers);

	if (unknown.length > 0) {
		const listed = await reloadListedConversations();
		for (const id of unknown) {
			const row = listed.get(id);
			// A chat the reloaded list no longer holds is gone, not failed.
			if (row && getSidebarPinned(row) !== sidebarPinned) failed.add(id);
		}
	}

	return { failedIds: ids.filter((id) => failed.has(id)) };
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
