import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	clearConversationStore,
	conversations,
	createNewConversation,
	deleteConversationById,
	loadConversations,
	moveConversationToProject,
	reconcileConversationSnapshot,
	renameConversation,
	upsertConversationLocal,
} from './conversations';
import { WORKSPACE_CONVERSATION_DELETED_EVENT } from '$lib/client/document-workspace-state';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'Content-Type': 'application/json' },
		...init,
	});
}

describe('conversations store', () => {
	beforeEach(() => {
		clearConversationStore();
		vi.restoreAllMocks();
		vi.stubGlobal('fetch', vi.fn());
		vi.stubGlobal('window', {
			sessionStorage: {
				getItem: vi.fn(() => null),
				setItem: vi.fn(),
				removeItem: vi.fn(),
			},
			dispatchEvent: vi.fn(() => true),
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('loads conversations from the API', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				conversations: [{ id: 'conv-1', title: 'One', updatedAt: 123, projectId: null }],
			})
		);

		await loadConversations();

		expect(get(conversations)).toEqual([
			{ id: 'conv-1', title: 'One', updatedAt: 123, projectId: null },
		]);
	});

	it('preserves optimistic local conversations when a stale snapshot arrives', () => {
		upsertConversationLocal('conv-local', 'Draft', 500);

		reconcileConversationSnapshot([
			{ id: 'conv-remote', title: 'Remote', updatedAt: 100, projectId: null },
		]);

		expect(get(conversations)).toEqual([
			{ id: 'conv-local', title: 'Draft', updatedAt: 500 },
			{ id: 'conv-remote', title: 'Remote', updatedAt: 100, projectId: null },
		]);
	});

	it('can place an optimistic local conversation inside a project', () => {
		upsertConversationLocal('conv-local', 'Draft', 500, 'proj-1');

		expect(get(conversations)).toEqual([
			{ id: 'conv-local', title: 'Draft', updatedAt: 500, projectId: 'proj-1' },
		]);
	});

	it('drops locally preserved conversations when the snapshot owner changes', () => {
		reconcileConversationSnapshot(
			[{ id: 'user-1-conv', title: 'User 1 chat', updatedAt: 2 }],
			{ resetLocalState: true, userId: 'user-1' }
		);
		upsertConversationLocal('user-1-optimistic', 'User 1 draft', 3);

		reconcileConversationSnapshot(
			[{ id: 'user-2-conv', title: 'User 2 chat', updatedAt: 4 }],
			{ userId: 'user-2' }
		);

		expect(get(conversations).map((conversation) => conversation.id)).toEqual(['user-2-conv']);
	});

	it('clears stored conversations and local preservation state', () => {
		reconcileConversationSnapshot(
			[{ id: 'user-1-conv', title: 'User 1 chat', updatedAt: 2 }],
			{ resetLocalState: true, userId: 'user-1' }
		);
		upsertConversationLocal('user-1-optimistic', 'User 1 draft', 3);

		clearConversationStore();
		reconcileConversationSnapshot(
			[{ id: 'user-2-conv', title: 'User 2 chat', updatedAt: 4 }],
			{ userId: 'user-2' }
		);

		expect(get(conversations).map((conversation) => conversation.id)).toEqual(['user-2-conv']);
	});

	it('does not reintroduce deleted conversations from a stale snapshot', async () => {
		conversations.set([{ id: 'conv-1', title: 'Chat', updatedAt: 123, projectId: null }]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));

		await deleteConversationById('conv-1');
		reconcileConversationSnapshot([
			{ id: 'conv-1', title: 'Chat', updatedAt: 124, projectId: null },
		]);

		expect(get(conversations)).toEqual([]);
	});

	it('creates a conversation through the API', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{ id: 'conv-1', title: 'New Conversation', updatedAt: 123, projectId: null },
				{ status: 201 }
			)
		);

		await expect(createNewConversation()).resolves.toBe('conv-1');
		expect(fetch).toHaveBeenCalledWith(
			'/api/conversations',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('creates a conversation inside a project through the API', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{ id: 'conv-1', title: 'New Conversation', updatedAt: 123, projectId: 'proj-1' },
				{ status: 201 }
			)
		);

		await expect(createNewConversation({ projectId: 'proj-1' })).resolves.toBe('conv-1');
		expect(fetch).toHaveBeenCalledWith(
			'/api/conversations',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ projectId: 'proj-1' }),
			})
		);
	});

	it('renames a conversation and updates the store locally', async () => {
		conversations.set([{ id: 'conv-1', title: 'Old', updatedAt: 123, projectId: null }]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({ id: 'conv-1', title: 'New', updatedAt: 123, projectId: null })
		);

		await renameConversation('conv-1', 'New');

		expect(get(conversations)).toEqual([
			{ id: 'conv-1', title: 'New', updatedAt: 123, projectId: null },
		]);
	});

	it('moves a conversation to a project and updates the store locally', async () => {
		conversations.set([{ id: 'conv-1', title: 'Chat', updatedAt: 123, projectId: null }]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({ id: 'conv-1', title: 'Chat', updatedAt: 123, projectId: 'proj-1' })
		);

		await moveConversationToProject('conv-1', 'proj-1');

		expect(get(conversations)).toEqual([
			{ id: 'conv-1', title: 'Chat', updatedAt: 123, projectId: 'proj-1' },
		]);
	});

	it('deletes a conversation and removes it from the store', async () => {
		conversations.set([{ id: 'conv-1', title: 'Chat', updatedAt: 123, projectId: null }]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));

		await deleteConversationById('conv-1');

		expect(get(conversations)).toEqual([]);
		expect(vi.mocked(window.dispatchEvent)).toHaveBeenCalledWith(
			expect.objectContaining({
				type: WORKSPACE_CONVERSATION_DELETED_EVENT,
				detail: { conversationId: 'conv-1' },
			})
		);
	});
});
