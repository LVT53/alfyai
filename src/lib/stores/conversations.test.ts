import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_CONVERSATION_DELETED_EVENT } from "$lib/client/document-workspace-state";
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
} from "./conversations";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("conversations store", () => {
	beforeEach(() => {
		clearConversationStore();
		vi.restoreAllMocks();
		vi.stubGlobal("fetch", vi.fn());
		vi.stubGlobal("window", {
			sessionStorage: {
				getItem: vi.fn(() => null),
				setItem: vi.fn(),
				removeItem: vi.fn(),
			},
			dispatchEvent: vi.fn(() => true),
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("loads conversations from the API", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				conversations: [
					{ id: "conv-1", title: "One", updatedAt: 123, projectId: null },
				],
			}),
		);

		const result = await loadConversations();

		expect(result).toEqual({ refreshed: true });
		expect(get(conversations)).toEqual([
			{ id: "conv-1", title: "One", updatedAt: 123, projectId: null },
		]);
	});

	it("uses a fresh reconciled snapshot instead of immediately re-fetching conversations", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		reconcileConversationSnapshot([
			{ id: "conv-1", title: "One", updatedAt: 123, projectId: null },
		]);
		vi.setSystemTime(1_500);

		const result = await loadConversations({ minIntervalMs: 1_000 });

		expect(fetch).not.toHaveBeenCalled();
		expect(result).toEqual({ refreshed: false });
		expect(get(conversations)).toEqual([
			{ id: "conv-1", title: "One", updatedAt: 123, projectId: null },
		]);
	});

	it("fetches conversations by default even when a snapshot is fresh", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		reconcileConversationSnapshot([
			{ id: "conv-stale", title: "Stale", updatedAt: 123, projectId: null },
		]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				conversations: [
					{ id: "conv-fresh", title: "Fresh", updatedAt: 456, projectId: null },
				],
			}),
		);

		await loadConversations();

		expect(fetch).toHaveBeenCalledWith("/api/conversations");
		expect(get(conversations)).toEqual([
			{ id: "conv-fresh", title: "Fresh", updatedAt: 456, projectId: null },
		]);
	});

	it("can force a conversation refresh through the freshness guard", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		reconcileConversationSnapshot([
			{ id: "conv-stale", title: "Stale", updatedAt: 123, projectId: null },
		]);
		vi.setSystemTime(1_500);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				conversations: [
					{ id: "conv-fresh", title: "Fresh", updatedAt: 456, projectId: null },
				],
			}),
		);

		await loadConversations({ force: true, minIntervalMs: 1_000 });

		expect(fetch).toHaveBeenCalledWith("/api/conversations");
		expect(get(conversations)).toEqual([
			{ id: "conv-fresh", title: "Fresh", updatedAt: 456, projectId: null },
		]);
	});

	it("preserves stale conversations without console noise when a refresh times out", async () => {
		const errorSpy = vi.mocked(console.error);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		conversations.set([
			{ id: "conv-stale", title: "Stale", updatedAt: 123, projectId: null },
		]);
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		const result = await loadConversations();

		expect(get(conversations)).toEqual([
			{ id: "conv-stale", title: "Stale", updatedAt: 123, projectId: null },
		]);
		expect(result).toEqual({ refreshed: false });
		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("preserves optimistic local conversations when a stale snapshot arrives", () => {
		upsertConversationLocal("conv-local", "Draft", 500);

		reconcileConversationSnapshot([
			{ id: "conv-remote", title: "Remote", updatedAt: 100, projectId: null },
		]);

		expect(get(conversations)).toEqual([
			{ id: "conv-local", title: "Draft", updatedAt: 500 },
			{ id: "conv-remote", title: "Remote", updatedAt: 100, projectId: null },
		]);
	});

	it("can place an optimistic local conversation inside a project", () => {
		upsertConversationLocal("conv-local", "Draft", 500, "proj-1");

		expect(get(conversations)).toEqual([
			{ id: "conv-local", title: "Draft", updatedAt: 500, projectId: "proj-1" },
		]);
	});

	it("drops locally preserved conversations when the snapshot owner changes", () => {
		reconcileConversationSnapshot(
			[{ id: "user-1-conv", title: "User 1 chat", updatedAt: 2 }],
			{ resetLocalState: true, userId: "user-1" },
		);
		upsertConversationLocal("user-1-optimistic", "User 1 draft", 3);

		reconcileConversationSnapshot(
			[{ id: "user-2-conv", title: "User 2 chat", updatedAt: 4 }],
			{ userId: "user-2" },
		);

		expect(get(conversations).map((conversation) => conversation.id)).toEqual([
			"user-2-conv",
		]);
	});

	it("clears stored conversations and local preservation state", () => {
		reconcileConversationSnapshot(
			[{ id: "user-1-conv", title: "User 1 chat", updatedAt: 2 }],
			{ resetLocalState: true, userId: "user-1" },
		);
		upsertConversationLocal("user-1-optimistic", "User 1 draft", 3);

		clearConversationStore();
		reconcileConversationSnapshot(
			[{ id: "user-2-conv", title: "User 2 chat", updatedAt: 4 }],
			{ userId: "user-2" },
		);

		expect(get(conversations).map((conversation) => conversation.id)).toEqual([
			"user-2-conv",
		]);
	});

	it("does not reintroduce deleted conversations from a stale snapshot", async () => {
		conversations.set([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: null },
		]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));

		await deleteConversationById("conv-1");
		reconcileConversationSnapshot([
			{ id: "conv-1", title: "Chat", updatedAt: 124, projectId: null },
		]);

		expect(get(conversations)).toEqual([]);
	});

	it("creates a conversation through the API", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{
					id: "conv-1",
					title: "New Conversation",
					updatedAt: 123,
					projectId: null,
				},
				{ status: 201 },
			),
		);

		await expect(createNewConversation()).resolves.toBe("conv-1");
		expect(fetch).toHaveBeenCalledWith(
			"/api/conversations",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("creates a conversation inside a project through the API", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{
					id: "conv-1",
					title: "New Conversation",
					updatedAt: 123,
					projectId: "proj-1",
				},
				{ status: 201 },
			),
		);

		await expect(createNewConversation({ projectId: "proj-1" })).resolves.toBe(
			"conv-1",
		);
		expect(fetch).toHaveBeenCalledWith(
			"/api/conversations",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ projectId: "proj-1" }),
			}),
		);
	});

	it("renames a conversation and updates the store locally", async () => {
		conversations.set([
			{ id: "conv-1", title: "Old", updatedAt: 123, projectId: null },
		]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				id: "conv-1",
				title: "New",
				updatedAt: 123,
				projectId: null,
			}),
		);

		await renameConversation("conv-1", "New");

		expect(get(conversations)).toEqual([
			{ id: "conv-1", title: "New", updatedAt: 123, projectId: null },
		]);
	});

	it("moves a conversation to a project and updates the store locally", async () => {
		conversations.set([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: null },
		]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				id: "conv-1",
				title: "Chat",
				updatedAt: 123,
				projectId: "proj-1",
			}),
		);

		await moveConversationToProject("conv-1", "proj-1");

		expect(get(conversations)).toEqual([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: "proj-1" },
		]);
	});

	it("moves a conversation locally before the project move request finishes", async () => {
		conversations.set([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: null },
		]);
		let resolveMove: ((response: Response) => void) | undefined;
		vi.mocked(fetch).mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				resolveMove = resolve;
			}),
		);

		const move = moveConversationToProject("conv-1", "proj-1");

		expect(get(conversations)).toEqual([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: "proj-1" },
		]);

		expect(resolveMove).toBeDefined();
		if (!resolveMove) throw new Error("Expected move request resolver");
		resolveMove(
			jsonResponse({
				id: "conv-1",
				title: "Chat",
				updatedAt: 123,
				projectId: "proj-1",
			}),
		);
		await move;
	});

	it("rolls back a local project move when the request fails", async () => {
		conversations.set([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: null },
		]);
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		await expect(moveConversationToProject("conv-1", "proj-1")).rejects.toThrow(
			"Failed to fetch",
		);

		expect(get(conversations)).toEqual([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: null },
		]);
	});

	it("does not preserve a failed project move for a conversation missing from the visible store", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		await expect(
			moveConversationToProject("conv-missing", "proj-1"),
		).rejects.toThrow("Failed to fetch");
		reconcileConversationSnapshot([
			{
				id: "conv-missing",
				title: "Hidden chat",
				updatedAt: 124,
				projectId: null,
			},
		]);

		expect(get(conversations)).toEqual([
			{
				id: "conv-missing",
				title: "Hidden chat",
				updatedAt: 124,
				projectId: null,
			},
		]);
	});

	it("preserves a local project move when a stale snapshot arrives", async () => {
		conversations.set([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: null },
		]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				id: "conv-1",
				title: "Chat",
				updatedAt: 123,
				projectId: "proj-1",
			}),
		);

		await moveConversationToProject("conv-1", "proj-1");
		reconcileConversationSnapshot([
			{ id: "conv-1", title: "Chat", updatedAt: 124, projectId: null },
		]);

		expect(get(conversations)).toEqual([
			{ id: "conv-1", title: "Chat", updatedAt: 124, projectId: "proj-1" },
		]);
	});

	it("deletes a conversation and removes it from the store", async () => {
		conversations.set([
			{ id: "conv-1", title: "Chat", updatedAt: 123, projectId: null },
		]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));

		await deleteConversationById("conv-1");

		expect(get(conversations)).toEqual([]);
		expect(vi.mocked(window.dispatchEvent)).toHaveBeenCalledWith(
			expect.objectContaining({
				type: WORKSPACE_CONVERSATION_DELETED_EVENT,
				detail: { conversationId: "conv-1" },
			}),
		);
	});
});
