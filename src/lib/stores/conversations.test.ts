import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	savePinnedConversationSidebarOrder,
	setConversationSidebarPinned,
} from "$lib/client/api/conversations";
import { WORKSPACE_CONVERSATION_DELETED_EVENT } from "$lib/client/document-workspace-state";
import type { Conversation, ConversationListItem } from "$lib/types";
import {
	clearConversationStore,
	conversations,
	createNewConversation,
	deleteConversationById,
	loadConversations,
	markConversationAtlasBadgeSeen,
	moveConversationToProject,
	reconcileConversationSnapshot,
	renameConversation,
	savePinnedConversationOrder,
	toggleConversationSidebarPin,
	upsertConversationLocal,
} from "./conversations";

vi.mock("$lib/client/api/conversations", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/conversations")>();
	return {
		...actual,
		setConversationSidebarPinned: vi.fn(),
		savePinnedConversationSidebarOrder: vi.fn(),
	};
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

function conversationItem(
	id: string,
	title: string,
	updatedAt: number,
	overrides: Partial<ConversationListItem> = {},
): ConversationListItem {
	return {
		id,
		title,
		updatedAt,
		projectId: null,
		sidebarPinned: false,
		sidebarSortOrder: null,
		...overrides,
	};
}

describe("conversations store", () => {
	beforeEach(() => {
		clearConversationStore();
		vi.restoreAllMocks();
		vi.mocked(setConversationSidebarPinned).mockReset();
		vi.mocked(savePinnedConversationSidebarOrder).mockReset();
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
				conversations: [conversationItem("conv-1", "One", 123)],
			}),
		);

		const result = await loadConversations();

		expect(result).toEqual({ refreshed: true });
		expect(get(conversations)).toEqual([
			conversationItem("conv-1", "One", 123),
		]);
	});

	it("uses a fresh reconciled snapshot instead of immediately re-fetching conversations", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		reconcileConversationSnapshot([conversationItem("conv-1", "One", 123)]);
		vi.setSystemTime(1_500);

		const result = await loadConversations({ minIntervalMs: 1_000 });

		expect(fetch).not.toHaveBeenCalled();
		expect(result).toEqual({ refreshed: false });
		expect(get(conversations)).toEqual([
			conversationItem("conv-1", "One", 123),
		]);
	});

	it("fetches conversations by default even when a snapshot is fresh", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		reconcileConversationSnapshot([
			conversationItem("conv-stale", "Stale", 123),
		]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				conversations: [conversationItem("conv-fresh", "Fresh", 456)],
			}),
		);

		await loadConversations();

		expect(fetch).toHaveBeenCalledWith("/api/conversations");
		expect(get(conversations)).toEqual([
			conversationItem("conv-fresh", "Fresh", 456),
		]);
	});

	it("can force a conversation refresh through the freshness guard", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		reconcileConversationSnapshot([
			conversationItem("conv-stale", "Stale", 123),
		]);
		vi.setSystemTime(1_500);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				conversations: [conversationItem("conv-fresh", "Fresh", 456)],
			}),
		);

		await loadConversations({ force: true, minIntervalMs: 1_000 });

		expect(fetch).toHaveBeenCalledWith("/api/conversations");
		expect(get(conversations)).toEqual([
			conversationItem("conv-fresh", "Fresh", 456),
		]);
	});

	it("preserves stale conversations without console noise when a refresh times out", async () => {
		const errorSpy = vi.mocked(console.error);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		conversations.set([conversationItem("conv-stale", "Stale", 123)]);
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		const result = await loadConversations();

		expect(get(conversations)).toEqual([
			conversationItem("conv-stale", "Stale", 123),
		]);
		expect(result).toEqual({ refreshed: false });
		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("preserves optimistic local conversations when a stale snapshot arrives", () => {
		upsertConversationLocal("conv-local", "Draft", 500);

		reconcileConversationSnapshot([
			conversationItem("conv-remote", "Remote", 100),
		]);

		expect(get(conversations)).toEqual([
			conversationItem("conv-local", "Draft", 500),
			conversationItem("conv-remote", "Remote", 100),
		]);
	});

	it("can place an optimistic local conversation inside a project", () => {
		upsertConversationLocal("conv-local", "Draft", 500, "proj-1");

		expect(get(conversations)).toEqual([
			conversationItem("conv-local", "Draft", 500, { projectId: "proj-1" }),
		]);
	});

	it("drops locally preserved conversations when the snapshot owner changes", () => {
		reconcileConversationSnapshot(
			[conversationItem("user-1-conv", "User 1 chat", 2)],
			{ resetLocalState: true, userId: "user-1" },
		);
		upsertConversationLocal("user-1-optimistic", "User 1 draft", 3);

		reconcileConversationSnapshot(
			[conversationItem("user-2-conv", "User 2 chat", 4)],
			{ userId: "user-2" },
		);

		expect(get(conversations).map((conversation) => conversation.id)).toEqual([
			"user-2-conv",
		]);
	});

	it("keeps a seen Atlas completion hidden across refreshed snapshots but allows a newer completion", () => {
		const firstBadge = {
			jobId: "atlas-job-1",
			status: "succeeded" as const,
			label: "Atlas report",
			completedAt: 1_789_000,
			updatedAt: 1_789_000,
		};
		const secondBadge = {
			...firstBadge,
			jobId: "atlas-job-2",
			completedAt: 1_790_000,
			updatedAt: 1_790_000,
		};

		reconcileConversationSnapshot([
			conversationItem("conv-atlas", "Atlas chat", 100, {
				atlasBadge: firstBadge,
			}),
		]);
		expect(get(conversations)[0]?.atlasBadge).toEqual(firstBadge);

		markConversationAtlasBadgeSeen("conv-atlas");
		expect(get(conversations)[0]?.atlasBadge).toBeUndefined();

		reconcileConversationSnapshot([
			conversationItem("conv-atlas", "Atlas chat", 101, {
				atlasBadge: firstBadge,
			}),
		]);
		expect(get(conversations)[0]?.atlasBadge).toBeUndefined();

		reconcileConversationSnapshot([
			conversationItem("conv-atlas", "Atlas chat", 102, {
				atlasBadge: secondBadge,
			}),
		]);
		expect(get(conversations)[0]?.atlasBadge).toEqual(secondBadge);
	});

	it("clears stored conversations and local preservation state", () => {
		reconcileConversationSnapshot(
			[conversationItem("user-1-conv", "User 1 chat", 2)],
			{ resetLocalState: true, userId: "user-1" },
		);
		upsertConversationLocal("user-1-optimistic", "User 1 draft", 3);

		clearConversationStore();
		reconcileConversationSnapshot(
			[conversationItem("user-2-conv", "User 2 chat", 4)],
			{ userId: "user-2" },
		);

		expect(get(conversations).map((conversation) => conversation.id)).toEqual([
			"user-2-conv",
		]);
	});

	it("does not reintroduce deleted conversations from a stale snapshot", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));

		await deleteConversationById("conv-1");
		reconcileConversationSnapshot([conversationItem("conv-1", "Chat", 124)]);

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
		conversations.set([conversationItem("conv-1", "Old", 123)]);
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
			conversationItem("conv-1", "New", 123),
		]);
	});

	it("moves a conversation to a project and updates the store locally", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
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
			conversationItem("conv-1", "Chat", 123, { projectId: "proj-1" }),
		]);
	});

	it("pins a conversation optimistically at the top of the sidebar", async () => {
		conversations.set([
			conversationItem("conv-recent", "Recent", 300),
			conversationItem("conv-older", "Older", 100),
		]);
		let resolvePin:
			| ((conversation: Conversation | PromiseLike<Conversation>) => void)
			| undefined;
		vi.mocked(setConversationSidebarPinned).mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePin = resolve;
			}),
		);

		const pin = toggleConversationSidebarPin("conv-older", true);

		expect(vi.mocked(setConversationSidebarPinned)).toHaveBeenCalledWith(
			"conv-older",
			true,
		);
		expect(get(conversations).map((conversation) => conversation.id)).toEqual([
			"conv-older",
			"conv-recent",
		]);
		expect(get(conversations)[0]).toEqual(
			expect.objectContaining({
				id: "conv-older",
				sidebarPinned: true,
				sidebarSortOrder: -1,
			}),
		);

		expect(resolvePin).toBeDefined();
		if (!resolvePin) throw new Error("Expected pin request resolver");
		resolvePin({
			id: "conv-older",
			title: "Older",
			updatedAt: 100,
			projectId: null,
			sidebarPinned: true,
			sidebarSortOrder: 0,
			createdAt: 100,
		});
		await pin;
	});

	it("keeps a pending conversation pin when a stale snapshot arrives", async () => {
		conversations.set([
			conversationItem("conv-recent", "Recent", 300),
			conversationItem("conv-older", "Older", 100),
		]);
		let resolvePin:
			| ((conversation: Conversation | PromiseLike<Conversation>) => void)
			| undefined;
		vi.mocked(setConversationSidebarPinned).mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePin = resolve;
			}),
		);

		const pin = toggleConversationSidebarPin("conv-older", true);
		reconcileConversationSnapshot([
			{
				id: "conv-recent",
				title: "Recent",
				updatedAt: 300,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
			{
				id: "conv-older",
				title: "Older",
				updatedAt: 120,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);

		expect(get(conversations)[0]).toEqual(
			expect.objectContaining({
				id: "conv-older",
				updatedAt: 120,
				sidebarPinned: true,
				sidebarSortOrder: -1,
			}),
		);

		expect(resolvePin).toBeDefined();
		if (!resolvePin) throw new Error("Expected pin request resolver");
		resolvePin({
			id: "conv-older",
			title: "Older",
			updatedAt: 120,
			projectId: null,
			sidebarPinned: true,
			sidebarSortOrder: 0,
			createdAt: 120,
		});
		await pin;
	});

	it("rolls back a conversation pin when persistence fails", async () => {
		conversations.set([
			{
				id: "conv-recent",
				title: "Recent",
				updatedAt: 300,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
			{
				id: "conv-older",
				title: "Older",
				updatedAt: 100,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);
		vi.mocked(setConversationSidebarPinned).mockRejectedValueOnce(
			new Error("pin failed"),
		);

		const pin = toggleConversationSidebarPin("conv-older", true);

		expect(get(conversations).map((conversation) => conversation.id)).toEqual([
			"conv-older",
			"conv-recent",
		]);
		await expect(pin).rejects.toThrow("pin failed");
		expect(get(conversations)).toEqual([
			{
				id: "conv-recent",
				title: "Recent",
				updatedAt: 300,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
			{
				id: "conv-older",
				title: "Older",
				updatedAt: 100,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);
	});

	it("keeps pinned conversation order when activity timestamps change", () => {
		reconcileConversationSnapshot([
			{
				id: "conv-first",
				title: "First",
				updatedAt: 100,
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 0,
			},
			{
				id: "conv-second",
				title: "Second",
				updatedAt: 200,
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 1,
			},
			{
				id: "conv-unpinned",
				title: "Unpinned",
				updatedAt: 300,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);

		reconcileConversationSnapshot([
			{
				id: "conv-second",
				title: "Second",
				updatedAt: 900,
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 1,
			},
			{
				id: "conv-first",
				title: "First",
				updatedAt: 100,
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 0,
			},
			{
				id: "conv-unpinned",
				title: "Unpinned",
				updatedAt: 300,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);

		expect(get(conversations).map((conversation) => conversation.id)).toEqual([
			"conv-first",
			"conv-second",
			"conv-unpinned",
		]);
	});

	it("rolls back pinned conversation reorder when persistence fails", async () => {
		conversations.set([
			{
				id: "conv-a",
				title: "A",
				updatedAt: 100,
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 0,
			},
			{
				id: "conv-b",
				title: "B",
				updatedAt: 200,
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 1,
			},
			{
				id: "conv-c",
				title: "C",
				updatedAt: 300,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);
		vi.mocked(savePinnedConversationSidebarOrder).mockRejectedValueOnce(
			new Error("save failed"),
		);

		const save = savePinnedConversationOrder(["conv-b", "conv-a"]);

		expect(vi.mocked(savePinnedConversationSidebarOrder)).toHaveBeenCalledWith([
			"conv-b",
			"conv-a",
		]);
		expect(get(conversations).map((conversation) => conversation.id)).toEqual([
			"conv-b",
			"conv-a",
			"conv-c",
		]);
		await expect(save).rejects.toThrow("save failed");
		expect(get(conversations)).toEqual([
			{
				id: "conv-a",
				title: "A",
				updatedAt: 100,
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 0,
			},
			{
				id: "conv-b",
				title: "B",
				updatedAt: 200,
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 1,
			},
			{
				id: "conv-c",
				title: "C",
				updatedAt: 300,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);
	});

	it("moves a conversation locally before the project move request finishes", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
		let resolveMove: ((response: Response) => void) | undefined;
		vi.mocked(fetch).mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				resolveMove = resolve;
			}),
		);

		const move = moveConversationToProject("conv-1", "proj-1");

		expect(get(conversations)).toEqual([
			conversationItem("conv-1", "Chat", 123, { projectId: "proj-1" }),
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
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		await expect(moveConversationToProject("conv-1", "proj-1")).rejects.toThrow(
			"Failed to fetch",
		);

		expect(get(conversations)).toEqual([
			conversationItem("conv-1", "Chat", 123),
		]);
	});

	it("does not preserve a failed project move for a conversation missing from the visible store", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		await expect(
			moveConversationToProject("conv-missing", "proj-1"),
		).rejects.toThrow("Failed to fetch");
		reconcileConversationSnapshot([
			conversationItem("conv-missing", "Hidden chat", 124),
		]);

		expect(get(conversations)).toEqual([
			conversationItem("conv-missing", "Hidden chat", 124),
		]);
	});

	it("preserves a local project move when a stale snapshot arrives", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				id: "conv-1",
				title: "Chat",
				updatedAt: 123,
				projectId: "proj-1",
			}),
		);

		await moveConversationToProject("conv-1", "proj-1");
		reconcileConversationSnapshot([conversationItem("conv-1", "Chat", 124)]);

		expect(get(conversations)).toEqual([
			conversationItem("conv-1", "Chat", 124, { projectId: "proj-1" }),
		]);
	});

	it("deletes a conversation and removes it from the store", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
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
