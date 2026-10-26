import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	runConversationBatch,
	savePinnedConversationSidebarOrder,
	setConversationSidebarPinned,
} from "$lib/client/api/conversations";
import { WORKSPACE_CONVERSATION_DELETED_EVENT } from "$lib/client/document-workspace-state";
import type {
	Conversation,
	ConversationListItem,
} from "$lib/server/services/conversations";
import type { ConversationBatchResult } from "$lib/shared/conversation-batch";
import {
	clearConversationStore,
	conversations,
	createNewConversation,
	deleteConversationById,
	deleteConversationsByIds,
	loadConversations,
	markConversationAtlasBadgeSeen,
	moveConversationsToProject,
	moveConversationToProject,
	reconcileConversationSnapshot,
	removeConversationLocal,
	renameConversation,
	savePinnedConversationOrder,
	setConversationsSidebarPinned,
	toggleConversationSidebarPin,
	updateConversationMemoryIncognitoLocal,
	upsertConversationLocal,
} from "./conversations";

let localStorageMock: Record<string, string> = {};

vi.mock("$lib/client/api/conversations", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/conversations")>();
	return {
		...actual,
		setConversationSidebarPinned: vi.fn(),
		savePinnedConversationSidebarOrder: vi.fn(),
		runConversationBatch: vi.fn(),
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
		localStorageMock = {};
		vi.restoreAllMocks();
		vi.mocked(setConversationSidebarPinned).mockReset();
		vi.mocked(savePinnedConversationSidebarOrder).mockReset();
		vi.mocked(runConversationBatch).mockReset();
		vi.stubGlobal("fetch", vi.fn());
		vi.stubGlobal("window", {
			localStorage: {
				getItem: vi.fn((key: string) => localStorageMock[key] ?? null),
				setItem: vi.fn((key: string, value: string) => {
					localStorageMock[key] = value;
				}),
				removeItem: vi.fn((key: string) => {
					delete localStorageMock[key];
				}),
			},
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

	// Incognito redesign — the sidebar's mask follows the composer's switch
	// without waiting for the next server snapshot.
	it("mirrors an incognito flip onto the listed row", () => {
		reconcileConversationSnapshot([
			conversationItem("conv-1", "One", 100),
			conversationItem("conv-2", "Two", 50),
		]);

		updateConversationMemoryIncognitoLocal("conv-1", true);

		expect(get(conversations)).toEqual([
			conversationItem("conv-1", "One", 100, { memoryIncognito: true }),
			conversationItem("conv-2", "Two", 50),
		]);

		updateConversationMemoryIncognitoLocal("conv-1", false);
		expect(get(conversations)[0].memoryIncognito).toBe(false);
	});

	it("carries a pre-set incognito flag onto the row the landing page upserts later", () => {
		// The landing composer persists incognito on the prepared conversation
		// before the first message lists it in the sidebar.
		updateConversationMemoryIncognitoLocal("conv-prepared", true);
		expect(get(conversations)).toEqual([]);

		upsertConversationLocal("conv-prepared", "New Conversation", 500);

		expect(get(conversations)).toEqual([
			conversationItem("conv-prepared", "New Conversation", 500, {
				memoryIncognito: true,
			}),
		]);

		// The server's snapshot is the truth once it lists the conversation.
		reconcileConversationSnapshot([
			conversationItem("conv-prepared", "New Conversation", 500, {
				memoryIncognito: false,
			}),
		]);
		expect(get(conversations)[0].memoryIncognito).toBe(false);
	});

	// Regression: the landing page's own creation flow ends in a HARD
	// navigation (window.location.assign, not a SvelteKit transition) once a
	// conversation exists — a full page load that wipes every in-memory
	// client map, including the one updateConversationMemoryIncognitoLocal
	// writes to. The chat page's first paint on the new page cannot rely on
	// that map surviving, so upsertConversationLocal's own memoryIncognito
	// parameter must be able to carry the truth in directly, with an empty
	// map (simulating the post-reload state) standing in for the wipe.
	it("carries memoryIncognito through upsertConversationLocal directly, with no local map to fall back on", () => {
		expect(get(conversations)).toEqual([]);

		upsertConversationLocal(
			"conv-fresh-page",
			"New Conversation",
			500,
			undefined,
			true,
		);

		expect(get(conversations)).toEqual([
			conversationItem("conv-fresh-page", "New Conversation", 500, {
				memoryIncognito: true,
			}),
		]);
	});

	it("also carries memoryIncognito through upsertConversationLocal for a row that already exists", () => {
		reconcileConversationSnapshot([
			conversationItem("conv-existing", "Existing", 100),
		]);

		upsertConversationLocal("conv-existing", "Existing", 200, undefined, true);

		expect(get(conversations)[0].memoryIncognito).toBe(true);
	});

	it("forgets a pre-set incognito flag when the prepared conversation is removed", () => {
		// The landing page deletes a prepared conversation the user backed out
		// of; a later conversation reusing the id must not inherit the flag.
		updateConversationMemoryIncognitoLocal("conv-prepared", true);
		removeConversationLocal("conv-prepared");

		upsertConversationLocal("conv-prepared", "New Conversation", 500);
		expect(get(conversations)).toEqual([
			conversationItem("conv-prepared", "New Conversation", 500),
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

	it("keeps a seen Atlas completion hidden after a page refresh", () => {
		const badge = {
			jobId: "atlas-job-1",
			status: "succeeded" as const,
			label: "Atlas report",
			completedAt: 1_789_000,
			updatedAt: 1_789_000,
		};

		reconcileConversationSnapshot(
			[
				conversationItem("conv-atlas", "Atlas chat", 100, {
					atlasBadge: badge,
				}),
			],
			{ userId: "user-1" },
		);
		markConversationAtlasBadgeSeen("conv-atlas");
		expect(get(conversations)[0]?.atlasBadge).toBeUndefined();

		clearConversationStore();
		reconcileConversationSnapshot(
			[
				conversationItem("conv-atlas", "Atlas chat", 101, {
					atlasBadge: badge,
				}),
			],
			{ userId: "user-1" },
		);

		expect(get(conversations)[0]?.atlasBadge).toBeUndefined();
		expect(
			JSON.parse(
				localStorageMock["alfyai:seen-atlas-badges:v1:user-1"] ?? "[]",
			),
		).toContain("conv-atlas:atlas-job-1:1789000");
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

	it("creates an incognito conversation atomically and mirrors it locally", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{
					id: "conv-1",
					title: "New Conversation",
					updatedAt: 123,
					projectId: null,
					memoryIncognito: true,
				},
				{ status: 201 },
			),
		);

		await expect(
			createNewConversation({ memoryIncognito: true }),
		).resolves.toBe("conv-1");
		expect(fetch).toHaveBeenCalledWith(
			"/api/conversations",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ memoryIncognito: true }),
			}),
		);

		// The armed choice lands in the sidebar mirror right away, without
		// waiting for a snapshot refresh — upsertConversationLocal reads it
		// back out of the same local map.
		upsertConversationLocal("conv-1", "New Conversation", 123);
		expect(get(conversations)[0].memoryIncognito).toBe(true);
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

	it("removes a conversation whose delete response was lost but the server deleted it", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
		vi.mocked(fetch)
			.mockRejectedValueOnce(new TypeError("Load failed"))
			.mockResolvedValueOnce(
				jsonResponse({ error: "Conversation not found" }, { status: 404 }),
			);

		await deleteConversationById("conv-1");

		expect(fetch).toHaveBeenLastCalledWith("/api/conversations/conv-1");
		expect(get(conversations)).toEqual([]);
	});

	it("treats a 404 delete as already deleted", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({ error: "Conversation not found" }, { status: 404 }),
		);

		await deleteConversationById("conv-1");

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(get(conversations)).toEqual([]);
	});

	it("keeps a conversation and rethrows when the failed delete left it on the server", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				jsonResponse(
					{ error: "Failed to fully delete conversation" },
					{ status: 500 },
				),
			)
			.mockResolvedValueOnce(jsonResponse({ conversation: { id: "conv-1" } }));

		await expect(deleteConversationById("conv-1")).rejects.toThrow(
			"Failed to fully delete conversation",
		);
		expect(get(conversations)).toEqual([
			conversationItem("conv-1", "Chat", 123),
		]);
	});

	it("removes the conversation from the sidebar even when workspace cleanup throws", async () => {
		conversations.set([conversationItem("conv-1", "Chat", 123)]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));
		vi.mocked(window.sessionStorage.getItem).mockImplementationOnce(() => {
			throw new DOMException("denied", "SecurityError");
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await deleteConversationById("conv-1");

		expect(get(conversations)).toEqual([]);
		expect(vi.mocked(window.dispatchEvent)).toHaveBeenCalled();
	});

	describe("bulk actions", () => {
		type BatchResult = ConversationBatchResult<Conversation>;

		const ok = (id: string, conversation?: Conversation): BatchResult =>
			conversation ? { id, ok: true, conversation } : { id, ok: true };
		const notFound = (id: string): BatchResult => ({
			id,
			ok: false,
			error: "not_found",
		});
		const failed = (id: string): BatchResult => ({
			id,
			ok: false,
			error: "failed",
		});
		const unknown = (id: string): BatchResult => ({
			id,
			ok: false,
			error: "unknown",
		});

		// What the server sends back for a chat it changed.
		function serverConversation(
			id: string,
			overrides: Partial<Conversation> = {},
		): Conversation {
			return {
				id,
				title: id,
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
				createdAt: 1,
				updatedAt: 100,
				...overrides,
			};
		}

		// A batch request the test finishes by hand, so it can look at the list
		// while the request is still out.
		function pendingBatch() {
			let resolve: (results: BatchResult[]) => void = () => {};
			const promise = new Promise<BatchResult[]>((done) => {
				resolve = done;
			});
			vi.mocked(runConversationBatch).mockReturnValueOnce(promise);
			return { resolve };
		}

		function workspaceDeletedIds(): string[] {
			return vi
				.mocked(window.dispatchEvent)
				.mock.calls.map(([event]) => event as CustomEvent)
				.filter((event) => event.type === WORKSPACE_CONVERSATION_DELETED_EVENT)
				.map((event) => event.detail.conversationId);
		}

		function projectsById(): Record<string, string | null | undefined> {
			return Object.fromEntries(
				get(conversations).map((item) => [item.id, item.projectId]),
			);
		}

		describe("deleteConversationsByIds", () => {
			beforeEach(() => {
				conversations.set([
					conversationItem("conv-a", "A", 300),
					conversationItem("conv-b", "B", 200),
					conversationItem("conv-c", "C", 100),
				]);
			});

			it("not_found leaves the list and is not a failure", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok("conv-a"),
					notFound("conv-b"),
					failed("conv-c"),
				]);

				const outcome = await deleteConversationsByIds([
					"conv-a",
					"conv-b",
					"conv-c",
				]);

				expect(vi.mocked(runConversationBatch)).toHaveBeenCalledWith({
					action: "delete",
					ids: ["conv-a", "conv-b", "conv-c"],
				});
				expect(get(conversations).map((item) => item.id)).toEqual(["conv-c"]);
				expect(workspaceDeletedIds()).toEqual(["conv-a", "conv-b"]);
				expect(outcome).toEqual({ failedIds: ["conv-c"] });
				// Nothing was unknown, so there was nothing to ask the server again.
				expect(fetch).not.toHaveBeenCalled();
			});

			it("does not reintroduce a deleted conversation from a stale snapshot", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok("conv-a"),
					ok("conv-b"),
					ok("conv-c"),
				]);

				await deleteConversationsByIds(["conv-a", "conv-b", "conv-c"]);
				reconcileConversationSnapshot([conversationItem("conv-a", "A", 301)]);

				expect(get(conversations)).toEqual([]);
			});

			it("a delete with an unknown result reloads the list", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok("conv-a"),
					unknown("conv-b"),
					unknown("conv-c"),
				]);
				// The server did delete B; it still has C.
				vi.mocked(fetch).mockResolvedValueOnce(
					jsonResponse({
						conversations: [conversationItem("conv-c", "C", 100)],
					}),
				);

				const outcome = await deleteConversationsByIds([
					"conv-a",
					"conv-b",
					"conv-c",
				]);

				expect(fetch).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledWith("/api/conversations");
				expect(get(conversations).map((item) => item.id)).toEqual(["conv-c"]);
				expect(workspaceDeletedIds()).toEqual(["conv-a", "conv-b"]);
				expect(outcome).toEqual({ failedIds: ["conv-c"] });
			});

			it("reports an unknown chat failed when the reload cannot say it is gone", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok("conv-a"),
					unknown("conv-b"),
					ok("conv-c"),
				]);
				vi.mocked(fetch).mockRejectedValueOnce(
					new TypeError("Failed to fetch"),
				);

				const outcome = await deleteConversationsByIds([
					"conv-a",
					"conv-b",
					"conv-c",
				]);

				expect(get(conversations).map((item) => item.id)).toEqual(["conv-b"]);
				expect(workspaceDeletedIds()).toEqual(["conv-a", "conv-c"]);
				expect(outcome).toEqual({ failedIds: ["conv-b"] });
			});

			it("reports the failed ids in the order they were given", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					failed("conv-c"),
					ok("conv-b"),
					failed("conv-a"),
				]);

				const outcome = await deleteConversationsByIds([
					"conv-c",
					"conv-b",
					"conv-a",
				]);

				expect(outcome).toEqual({ failedIds: ["conv-c", "conv-a"] });
			});

			// The answer is meant to hold one result per id. An id it leaves out says
			// nothing about what the server did, so it is decided by the reload like
			// any other unknown id, never counted as deleted.
			it("treats an id the answer leaves out as unknown, not as deleted", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([ok("conv-a")]);
				// The server did delete B, and still has C.
				vi.mocked(fetch).mockResolvedValueOnce(
					jsonResponse({
						conversations: [conversationItem("conv-c", "C", 100)],
					}),
				);

				const outcome = await deleteConversationsByIds([
					"conv-a",
					"conv-b",
					"conv-c",
				]);

				expect(fetch).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledWith("/api/conversations");
				expect(outcome).toEqual({ failedIds: ["conv-c"] });
				expect(get(conversations).map((item) => item.id)).toEqual(["conv-c"]);
				expect(workspaceDeletedIds()).toEqual(["conv-a", "conv-b"]);
			});

			it("removes the chats from the sidebar even when workspace cleanup throws", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok("conv-a"),
					ok("conv-b"),
				]);
				vi.mocked(window.sessionStorage.getItem).mockImplementation(() => {
					throw new DOMException("denied", "SecurityError");
				});
				vi.spyOn(console, "warn").mockImplementation(() => {});

				const outcome = await deleteConversationsByIds(["conv-a", "conv-b"]);

				expect(get(conversations).map((item) => item.id)).toEqual(["conv-c"]);
				expect(workspaceDeletedIds()).toEqual(["conv-a", "conv-b"]);
				expect(outcome).toEqual({ failedIds: [] });
			});

			it("sends no request for no ids", async () => {
				const outcome = await deleteConversationsByIds([]);

				expect(outcome).toEqual({ failedIds: [] });
				expect(vi.mocked(runConversationBatch)).not.toHaveBeenCalled();
				expect(fetch).not.toHaveBeenCalled();
			});
		});

		describe("moveConversationsToProject", () => {
			beforeEach(() => {
				conversations.set([
					conversationItem("conv-a", "A", 300),
					conversationItem("conv-b", "B", 200, { projectId: "proj-0" }),
					conversationItem("conv-c", "C", 100),
				]);
			});

			it("moves every row before the response, and puts a failed chat back", async () => {
				const batch = pendingBatch();

				const move = moveConversationsToProject(
					["conv-a", "conv-b", "conv-c"],
					"proj-1",
				);

				expect(vi.mocked(runConversationBatch)).toHaveBeenCalledWith({
					action: "move",
					ids: ["conv-a", "conv-b", "conv-c"],
					projectId: "proj-1",
				});
				expect(projectsById()).toEqual({
					"conv-a": "proj-1",
					"conv-b": "proj-1",
					"conv-c": "proj-1",
				});

				batch.resolve([
					ok("conv-a", serverConversation("conv-a", { projectId: "proj-1" })),
					failed("conv-b"),
					notFound("conv-c"),
				]);
				const outcome = await move;

				// A stays moved, B goes back to where it was, C is gone.
				expect(projectsById()).toEqual({
					"conv-a": "proj-1",
					"conv-b": "proj-0",
				});
				expect(outcome).toEqual({ failedIds: ["conv-b"] });
				// C is gone the way a deleted chat is: what the workspace remembers
				// about it goes, and the workspace is told.
				expect(workspaceDeletedIds()).toEqual(["conv-c"]);
				expect(vi.mocked(window.sessionStorage.getItem)).toHaveBeenCalled();
			});

			it("a later snapshot does not undo the chats that were moved", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok("conv-a", serverConversation("conv-a", { projectId: "proj-1" })),
					failed("conv-b"),
					ok("conv-c", serverConversation("conv-c", { projectId: "proj-1" })),
				]);

				await moveConversationsToProject(
					["conv-a", "conv-b", "conv-c"],
					"proj-1",
				);
				// A snapshot that was taken before the move landed.
				reconcileConversationSnapshot([
					conversationItem("conv-a", "A", 301),
					conversationItem("conv-b", "B", 201, { projectId: "proj-0" }),
					conversationItem("conv-c", "C", 101),
				]);

				expect(projectsById()).toEqual({
					"conv-a": "proj-1",
					"conv-b": "proj-0",
					"conv-c": "proj-1",
				});
			});

			it("a failed chat does not stay moved when a later snapshot arrives", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					failed("conv-a"),
					failed("conv-b"),
					failed("conv-c"),
				]);

				const outcome = await moveConversationsToProject(
					["conv-a", "conv-b", "conv-c"],
					"proj-1",
				);
				reconcileConversationSnapshot([
					conversationItem("conv-a", "A", 301),
					conversationItem("conv-b", "B", 201, { projectId: "proj-0" }),
					conversationItem("conv-c", "C", 101),
				]);

				expect(outcome).toEqual({
					failedIds: ["conv-a", "conv-b", "conv-c"],
				});
				expect(projectsById()).toEqual({
					"conv-a": null,
					"conv-b": "proj-0",
					"conv-c": null,
				});
			});

			it("an unknown chat is decided by the reload", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					unknown("conv-a"),
					unknown("conv-b"),
					ok("conv-c", serverConversation("conv-c", { projectId: "proj-1" })),
				]);
				// The server moved A, and never got to B.
				vi.mocked(fetch).mockResolvedValueOnce(
					jsonResponse({
						conversations: [
							conversationItem("conv-a", "A", 300, { projectId: "proj-1" }),
							conversationItem("conv-b", "B", 200, { projectId: "proj-0" }),
							conversationItem("conv-c", "C", 100, { projectId: "proj-1" }),
						],
					}),
				);

				const outcome = await moveConversationsToProject(
					["conv-a", "conv-b", "conv-c"],
					"proj-1",
				);

				expect(fetch).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledWith("/api/conversations");
				expect(outcome).toEqual({ failedIds: ["conv-b"] });
				expect(projectsById()).toEqual({
					"conv-a": "proj-1",
					"conv-b": "proj-0",
					"conv-c": "proj-1",
				});
			});

			it("an unknown chat whose reload fails is reported failed and shown where it was", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					unknown("conv-a"),
					unknown("conv-b"),
					unknown("conv-c"),
				]);
				vi.mocked(fetch).mockRejectedValueOnce(
					new TypeError("Failed to fetch"),
				);

				const outcome = await moveConversationsToProject(
					["conv-a", "conv-b", "conv-c"],
					"proj-1",
				);

				expect(outcome).toEqual({
					failedIds: ["conv-a", "conv-b", "conv-c"],
				});
				expect(projectsById()).toEqual({
					"conv-a": null,
					"conv-b": "proj-0",
					"conv-c": null,
				});
			});

			it("an unknown chat the reloaded list no longer holds is gone, not failed", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					unknown("conv-a"),
					ok("conv-b", serverConversation("conv-b", { projectId: "proj-1" })),
				]);
				// A was deleted somewhere else while the request was out.
				vi.mocked(fetch).mockResolvedValueOnce(
					jsonResponse({
						conversations: [
							conversationItem("conv-b", "B", 200, { projectId: "proj-1" }),
							conversationItem("conv-c", "C", 100),
						],
					}),
				);

				const outcome = await moveConversationsToProject(
					["conv-a", "conv-b"],
					"proj-1",
				);

				expect(outcome).toEqual({ failedIds: [] });
				expect(workspaceDeletedIds()).toEqual(["conv-a"]);
				expect(projectsById()).toEqual({
					"conv-b": "proj-1",
					"conv-c": null,
				});
			});

			// The answer is meant to hold one result per id. An id it leaves out says
			// nothing about what the server did, so it is decided by the reload like
			// any other unknown id, never counted as moved.
			it("treats an id the answer leaves out as unknown, not as moved", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok("conv-a", serverConversation("conv-a", { projectId: "proj-1" })),
				]);
				// The server moved C, and never got to B.
				vi.mocked(fetch).mockResolvedValueOnce(
					jsonResponse({
						conversations: [
							conversationItem("conv-a", "A", 300, { projectId: "proj-1" }),
							conversationItem("conv-b", "B", 200, { projectId: "proj-0" }),
							conversationItem("conv-c", "C", 100, { projectId: "proj-1" }),
						],
					}),
				);

				const outcome = await moveConversationsToProject(
					["conv-a", "conv-b", "conv-c"],
					"proj-1",
				);

				expect(fetch).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledWith("/api/conversations");
				expect(outcome).toEqual({ failedIds: ["conv-b"] });
				expect(projectsById()).toEqual({
					"conv-a": "proj-1",
					"conv-b": "proj-0",
					"conv-c": "proj-1",
				});
			});

			it("takes chats out of their project with a null projectId", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok("conv-b", serverConversation("conv-b", { projectId: null })),
				]);

				const outcome = await moveConversationsToProject(["conv-b"], null);

				expect(vi.mocked(runConversationBatch)).toHaveBeenCalledWith({
					action: "move",
					ids: ["conv-b"],
					projectId: null,
				});
				expect(outcome).toEqual({ failedIds: [] });
				expect(projectsById()["conv-b"]).toBeNull();
			});

			it("sends no request for no ids", async () => {
				const outcome = await moveConversationsToProject([], "proj-1");

				expect(outcome).toEqual({ failedIds: [] });
				expect(vi.mocked(runConversationBatch)).not.toHaveBeenCalled();
			});
		});

		describe("setConversationsSidebarPinned", () => {
			// B was active after A, so putting the Pinned list in recency order
			// would show B first; the person's order is A first.
			beforeEach(() => {
				conversations.set([
					conversationItem("conv-b", "B", 300),
					conversationItem("conv-a", "A", 100),
					conversationItem("conv-p", "P", 200, {
						sidebarPinned: true,
						sidebarSortOrder: 0,
					}),
				]);
			});

			function pinState() {
				return get(conversations).map((item) => ({
					id: item.id,
					sidebarPinned: item.sidebarPinned,
					sidebarSortOrder: item.sidebarSortOrder,
				}));
			}

			it("pins on top in the order given before the response", async () => {
				const batch = pendingBatch();

				const pin = setConversationsSidebarPinned(["conv-a", "conv-b"], true);

				expect(vi.mocked(runConversationBatch)).toHaveBeenCalledWith({
					action: "pin",
					ids: ["conv-a", "conv-b"],
					pinned: true,
				});
				expect(get(conversations).map((item) => item.id)).toEqual([
					"conv-a",
					"conv-b",
					"conv-p",
				]);
				const [a, b, p] = get(conversations);
				expect(a.sidebarPinned).toBe(true);
				expect(b.sidebarPinned).toBe(true);
				expect(a.sidebarSortOrder).not.toBeNull();
				expect(b.sidebarSortOrder).not.toBeNull();
				expect(a.sidebarSortOrder as number).toBeLessThan(
					b.sidebarSortOrder as number,
				);
				expect(b.sidebarSortOrder as number).toBeLessThan(
					p.sidebarSortOrder as number,
				);

				batch.resolve([
					ok(
						"conv-a",
						serverConversation("conv-a", {
							sidebarPinned: true,
							sidebarSortOrder: -2,
						}),
					),
					ok(
						"conv-b",
						serverConversation("conv-b", {
							sidebarPinned: true,
							sidebarSortOrder: -1,
						}),
					),
				]);
				const outcome = await pin;

				expect(outcome).toEqual({ failedIds: [] });
				expect(pinState()).toEqual([
					{ id: "conv-a", sidebarPinned: true, sidebarSortOrder: -2 },
					{ id: "conv-b", sidebarPinned: true, sidebarSortOrder: -1 },
					{ id: "conv-p", sidebarPinned: true, sidebarSortOrder: 0 },
				]);
			});

			it("a later snapshot does not undo the chats that were pinned", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok(
						"conv-a",
						serverConversation("conv-a", {
							sidebarPinned: true,
							sidebarSortOrder: -2,
						}),
					),
					ok(
						"conv-b",
						serverConversation("conv-b", {
							sidebarPinned: true,
							sidebarSortOrder: -1,
						}),
					),
				]);

				await setConversationsSidebarPinned(["conv-a", "conv-b"], true);
				// A snapshot that was taken before the pins landed.
				reconcileConversationSnapshot([
					conversationItem("conv-b", "B", 301),
					conversationItem("conv-a", "A", 101),
					conversationItem("conv-p", "P", 200, {
						sidebarPinned: true,
						sidebarSortOrder: 0,
					}),
				]);

				expect(get(conversations).map((item) => item.id)).toEqual([
					"conv-a",
					"conv-b",
					"conv-p",
				]);
			});

			it("puts a chat whose pin failed back where it was", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok(
						"conv-a",
						serverConversation("conv-a", {
							sidebarPinned: true,
							sidebarSortOrder: -1,
						}),
					),
					failed("conv-b"),
				]);

				const outcome = await setConversationsSidebarPinned(
					["conv-a", "conv-b"],
					true,
				);

				expect(outcome).toEqual({ failedIds: ["conv-b"] });
				expect(pinState()).toEqual([
					{ id: "conv-a", sidebarPinned: true, sidebarSortOrder: -1 },
					{ id: "conv-p", sidebarPinned: true, sidebarSortOrder: 0 },
					{ id: "conv-b", sidebarPinned: false, sidebarSortOrder: null },
				]);
			});

			it("unpins several chats and clears their order", async () => {
				conversations.set([
					conversationItem("conv-a", "A", 100, {
						sidebarPinned: true,
						sidebarSortOrder: -2,
					}),
					conversationItem("conv-b", "B", 300, {
						sidebarPinned: true,
						sidebarSortOrder: -1,
					}),
					conversationItem("conv-p", "P", 200, {
						sidebarPinned: true,
						sidebarSortOrder: 0,
					}),
				]);
				const batch = pendingBatch();

				const unpin = setConversationsSidebarPinned(
					["conv-a", "conv-b"],
					false,
				);

				expect(vi.mocked(runConversationBatch)).toHaveBeenCalledWith({
					action: "pin",
					ids: ["conv-a", "conv-b"],
					pinned: false,
				});
				// Unpinned chats fall back to recency, below the pinned one.
				expect(pinState()).toEqual([
					{ id: "conv-p", sidebarPinned: true, sidebarSortOrder: 0 },
					{ id: "conv-b", sidebarPinned: false, sidebarSortOrder: null },
					{ id: "conv-a", sidebarPinned: false, sidebarSortOrder: null },
				]);

				batch.resolve([
					ok("conv-a", serverConversation("conv-a", { updatedAt: 100 })),
					ok("conv-b", serverConversation("conv-b", { updatedAt: 300 })),
				]);
				const outcome = await unpin;

				expect(outcome).toEqual({ failedIds: [] });
				expect(pinState()).toEqual([
					{ id: "conv-p", sidebarPinned: true, sidebarSortOrder: 0 },
					{ id: "conv-b", sidebarPinned: false, sidebarSortOrder: null },
					{ id: "conv-a", sidebarPinned: false, sidebarSortOrder: null },
				]);
			});

			it("an unknown chat is decided by the reload", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					unknown("conv-a"),
					unknown("conv-b"),
				]);
				// The server pinned A, and never got to B.
				vi.mocked(fetch).mockResolvedValueOnce(
					jsonResponse({
						conversations: [
							conversationItem("conv-a", "A", 100, {
								sidebarPinned: true,
								sidebarSortOrder: -1,
							}),
							conversationItem("conv-b", "B", 300),
							conversationItem("conv-p", "P", 200, {
								sidebarPinned: true,
								sidebarSortOrder: 0,
							}),
						],
					}),
				);

				const outcome = await setConversationsSidebarPinned(
					["conv-a", "conv-b"],
					true,
				);

				expect(fetch).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledWith("/api/conversations");
				expect(outcome).toEqual({ failedIds: ["conv-b"] });
				expect(pinState()).toEqual([
					{ id: "conv-a", sidebarPinned: true, sidebarSortOrder: -1 },
					{ id: "conv-p", sidebarPinned: true, sidebarSortOrder: 0 },
					{ id: "conv-b", sidebarPinned: false, sidebarSortOrder: null },
				]);
			});

			it("an unknown chat whose reload fails is reported failed and shown where it was", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					unknown("conv-a"),
					unknown("conv-b"),
				]);
				vi.mocked(fetch).mockRejectedValueOnce(
					new TypeError("Failed to fetch"),
				);

				const outcome = await setConversationsSidebarPinned(
					["conv-a", "conv-b"],
					true,
				);

				expect(outcome).toEqual({ failedIds: ["conv-a", "conv-b"] });
				expect(pinState()).toEqual([
					{ id: "conv-p", sidebarPinned: true, sidebarSortOrder: 0 },
					{ id: "conv-b", sidebarPinned: false, sidebarSortOrder: null },
					{ id: "conv-a", sidebarPinned: false, sidebarSortOrder: null },
				]);
			});

			it("not_found drops the chat and is not a failure", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					notFound("conv-a"),
					ok(
						"conv-b",
						serverConversation("conv-b", {
							sidebarPinned: true,
							sidebarSortOrder: -1,
						}),
					),
				]);

				const outcome = await setConversationsSidebarPinned(
					["conv-a", "conv-b"],
					true,
				);

				expect(outcome).toEqual({ failedIds: [] });
				expect(get(conversations).map((item) => item.id)).toEqual([
					"conv-b",
					"conv-p",
				]);
				// A is gone the way a deleted chat is: what the workspace remembers
				// about it goes, and the workspace is told.
				expect(workspaceDeletedIds()).toEqual(["conv-a"]);
				expect(vi.mocked(window.sessionStorage.getItem)).toHaveBeenCalled();
			});

			it("an unknown chat the reloaded list no longer holds is gone, not failed", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					unknown("conv-a"),
					ok(
						"conv-b",
						serverConversation("conv-b", {
							sidebarPinned: true,
							sidebarSortOrder: -1,
						}),
					),
				]);
				// A was deleted somewhere else while the request was out.
				vi.mocked(fetch).mockResolvedValueOnce(
					jsonResponse({
						conversations: [
							conversationItem("conv-b", "B", 300, {
								sidebarPinned: true,
								sidebarSortOrder: -1,
							}),
							conversationItem("conv-p", "P", 200, {
								sidebarPinned: true,
								sidebarSortOrder: 0,
							}),
						],
					}),
				);

				const outcome = await setConversationsSidebarPinned(
					["conv-a", "conv-b"],
					true,
				);

				expect(outcome).toEqual({ failedIds: [] });
				expect(workspaceDeletedIds()).toEqual(["conv-a"]);
				expect(pinState()).toEqual([
					{ id: "conv-b", sidebarPinned: true, sidebarSortOrder: -1 },
					{ id: "conv-p", sidebarPinned: true, sidebarSortOrder: 0 },
				]);
			});

			// The answer is meant to hold one result per id. An id it leaves out says
			// nothing about what the server did, so it is decided by the reload like
			// any other unknown id, never counted as pinned.
			it("treats an id the answer leaves out as unknown, not as pinned", async () => {
				vi.mocked(runConversationBatch).mockResolvedValueOnce([
					ok(
						"conv-a",
						serverConversation("conv-a", {
							sidebarPinned: true,
							sidebarSortOrder: -1,
						}),
					),
				]);
				// The server never got to B.
				vi.mocked(fetch).mockResolvedValueOnce(
					jsonResponse({
						conversations: [
							conversationItem("conv-a", "A", 100, {
								sidebarPinned: true,
								sidebarSortOrder: -1,
							}),
							conversationItem("conv-b", "B", 300),
							conversationItem("conv-p", "P", 200, {
								sidebarPinned: true,
								sidebarSortOrder: 0,
							}),
						],
					}),
				);

				const outcome = await setConversationsSidebarPinned(
					["conv-a", "conv-b"],
					true,
				);

				expect(fetch).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledWith("/api/conversations");
				expect(outcome).toEqual({ failedIds: ["conv-b"] });
				expect(pinState()).toEqual([
					{ id: "conv-a", sidebarPinned: true, sidebarSortOrder: -1 },
					{ id: "conv-p", sidebarPinned: true, sidebarSortOrder: 0 },
					{ id: "conv-b", sidebarPinned: false, sidebarSortOrder: null },
				]);
			});

			it("sends no request for no ids", async () => {
				const outcome = await setConversationsSidebarPinned([], true);

				expect(outcome).toEqual({ failedIds: [] });
				expect(vi.mocked(runConversationBatch)).not.toHaveBeenCalled();
			});
		});
	});
});
