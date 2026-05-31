import { afterEach, describe, expect, it, vi } from "vitest";
import {
	conversationExists,
	createConversationFork,
	deleteConversationMessages,
	fetchConversationDetail,
	savePinnedConversationSidebarOrder,
	setConversationSidebarPinned,
} from "./conversations";
import type { ApiError } from "./http";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("conversationExists", () => {
	it("returns true when the conversation detail endpoint succeeds", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

		await expect(conversationExists("conv-1", fetchMock)).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-1");
	});

	it("returns false when the conversation detail endpoint returns 404", async () => {
		const fetchMock = vi.fn(
			async () => new Response("Not found", { status: 404 }),
		);

		await expect(conversationExists("conv-1", fetchMock)).resolves.toBe(false);
	});

	it("returns null on transient failures", async () => {
		const fetchMock = vi.fn(
			async () => new Response("Server error", { status: 500 }),
		);

		await expect(conversationExists("conv-1", fetchMock)).resolves.toBeNull();
	});
});

describe("fetchConversationDetail", () => {
	it("requests the bootstrap view through the conversation detail endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						conversation: {
							id: "conv-1",
							title: "Bootstrap",
							projectId: null,
							createdAt: 1,
							updatedAt: 1,
						},
						messages: [],
						bootstrap: true,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const detail = await fetchConversationDetail("conv-1", {
			view: "bootstrap",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1?view=bootstrap",
		);
		expect(detail.bootstrap).toBe(true);
	});
});

describe("deleteConversationMessages", () => {
	it("sends explicit forked source-history confirmation when provided", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ deleted: 2 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await expect(
			deleteConversationMessages("conv-1", ["user-1", "assistant-1"], {
				confirmForkedSourceHistoryMutation: true,
				fetchImpl: fetchMock,
			}),
		).resolves.toBe(2);

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(request?.body).toBe(
			JSON.stringify({
				messageIds: ["user-1", "assistant-1"],
				confirmForkedSourceHistoryMutation: true,
			}),
		);
	});
});

describe("createConversationFork", () => {
	it("posts the selected assistant response and returns the fork payload", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						conversation: {
							id: "fork-conv",
							title: "Source title (fork 1)",
							projectId: "project-1",
							createdAt: 1,
							updatedAt: 1,
						},
						forkOrigin: {
							forkConversationId: "fork-conv",
							sourceConversationId: "source-conv",
							sourceAssistantMessageId: "assistant-1",
							sourceConversationIdAvailable: true,
							sourceAssistantMessageIdAvailable: true,
							copiedForkPointMessageId: "fork-assistant-1",
							sourceTitle: "Source title",
							forkSequence: 1,
							createdAt: 1,
						},
					}),
					{ status: 201, headers: { "content-type": "application/json" } },
				),
		);

		const result = await createConversationFork(
			"source-conv",
			{ messageId: "assistant-1" },
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/source-conv/forks",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ messageId: "assistant-1" }),
			},
		);
		expect(result.conversation.id).toBe("fork-conv");
		expect(result.forkOrigin.copiedForkPointMessageId).toBe("fork-assistant-1");
	});

	it("preserves precise server fork failure codes for localization", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error:
							"Forks can only be created from a persisted assistant response",
						code: "invalid_source_message",
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		);

		await expect(
			createConversationFork("source-conv", { messageId: "user-1" }, fetchMock),
		).rejects.toMatchObject({
			name: "ApiError",
			message: "Forks can only be created from a persisted assistant response",
			status: 400,
			code: "invalid_source_message",
		} satisfies Partial<ApiError>);
	});
});

describe("conversation sidebar API", () => {
	it("patches conversation pin state through the conversation detail endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "conv-1",
						title: "Pinned",
						projectId: null,
						sidebarPinned: true,
						sidebarSortOrder: 0,
						createdAt: 1,
						updatedAt: 1,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await setConversationSidebarPinned(
			"conv-1",
			true,
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-1", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sidebarPinned: true }),
		});
		expect(result.sidebarPinned).toBe(true);
		expect(result.sidebarSortOrder).toBe(0);
	});

	it("saves pinned conversation order through the sidebar-order endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						conversations: [
							{
								id: "conv-2",
								title: "Pinned",
								projectId: null,
								sidebarPinned: true,
								sidebarSortOrder: 0,
								createdAt: 1,
								updatedAt: 1,
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await savePinnedConversationSidebarOrder(
			["conv-2", "conv-1"],
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith("/api/conversations/sidebar-order", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ orderedIds: ["conv-2", "conv-1"] }),
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("conv-2");
	});
});
