import { writable } from 'svelte/store';
import type { ConversationListItem } from '$lib/types';
import {
	createConversation,
	deleteConversation,
	fetchConversations,
	moveConversationToProject as moveConversationRequest,
	renameConversation as renameConversationRequest,
} from '$lib/client/api/conversations';
import {
	dispatchWorkspaceConversationDeleted,
	removeConversationFromPersistedWorkspaceDocumentState,
} from '$lib/client/document-workspace-state';

export const conversations = writable<ConversationListItem[]>([]);

const optimisticConversationIds = new Set<string>();
const deletedConversationIds = new Set<string>();
const localConversationProjectIds = new Map<string, string | null>();
let conversationSnapshotUserId: string | null = null;

export function reconcileConversationSnapshot(
	items: ConversationListItem[],
	options: { resetLocalState?: boolean; userId?: string | null } = {}
): void {
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
			conversationSnapshotUserId = options.userId ?? null;
			return incoming;
		}

		if (options.userId !== undefined) {
			conversationSnapshotUserId = options.userId;
		}

		const mergedIncoming = incoming.map((item) => {
			if (!localConversationProjectIds.has(item.id)) return item;
			const localProjectId = localConversationProjectIds.get(item.id) ?? null;
			if ((item.projectId ?? null) === localProjectId) {
				localConversationProjectIds.delete(item.id);
				return item;
			}
			return { ...item, projectId: localProjectId };
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

		return Array.from(next.values()).sort((left, right) => right.updatedAt - left.updatedAt);
	});
}

export function clearConversationStore(): void {
	optimisticConversationIds.clear();
	deletedConversationIds.clear();
	localConversationProjectIds.clear();
	conversationSnapshotUserId = null;
	conversations.set([]);
}

export async function loadConversations(): Promise<void> {
	try {
		reconcileConversationSnapshot(await fetchConversations());
	} catch (error) {
		console.error('Error loading conversations:', error);
	}
}

let isCreating = false;

export async function createNewConversation(options: { projectId?: string | null } = {}): Promise<string> {
	if (isCreating) {
		throw new Error('Please wait, a conversation is already being created.');
	}

	isCreating = true;
	try {
		const conversation = await createConversation(undefined, options);
		return conversation.id;
	} catch (error) {
		console.error('Error in createNewConversation:', error);
		if (error instanceof Error) {
			throw error;
		}
		throw new Error('An unexpected error occurred while creating a conversation. Please try again.');
	} finally {
		isCreating = false;
	}
}

export function upsertConversationLocal(
	id: string,
	title = 'New Conversation',
	updatedAt = Date.now() / 1000,
	projectId?: string | null
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
					...(projectId !== undefined ? { projectId } : {}),
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
	conversations.update((items) => items.filter((conversation) => conversation.id !== id));
}

export async function deleteConversationById(id: string): Promise<void> {
	await deleteConversation(id);
	if (typeof window !== 'undefined') {
		removeConversationFromPersistedWorkspaceDocumentState(window.sessionStorage, id);
		dispatchWorkspaceConversationDeleted(id);
	}
	optimisticConversationIds.delete(id);
	deletedConversationIds.add(id);
	localConversationProjectIds.delete(id);
	conversations.update((items) => items.filter((conversation) => conversation.id !== id));
}

export async function renameConversation(id: string, title: string): Promise<void> {
	await renameConversationRequest(id, title);
	conversations.update((items) =>
		items.map((conversation) => (conversation.id === id ? { ...conversation, title } : conversation))
	);
}

export function updateConversationTitleLocal(id: string, title: string): void {
	conversations.update((items) =>
		items.map((conversation) =>
			conversation.id === id ? { ...conversation, title } : conversation
		)
	);
}

export async function moveConversationToProject(id: string, projectId: string | null): Promise<void> {
	await moveConversationRequest(id, projectId);
	localConversationProjectIds.set(id, projectId);
	conversations.update((items) =>
		items.map((conversation) =>
			conversation.id === id ? { ...conversation, projectId } : conversation
		)
	);
}

export function clearProjectFromConversations(projectId: string): void {
	conversations.update((items) =>
		items.map((conversation) => {
			if (conversation.projectId !== projectId) return conversation;
			localConversationProjectIds.set(conversation.id, null);
			return { ...conversation, projectId: null };
		})
	);
}
