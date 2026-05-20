import { describe, expect, it, vi } from "vitest";

vi.mock("$app/environment", () => ({
	browser: false,
	building: false,
	dev: false,
	version: "test",
}));

vi.mock("$lib/client/conversation-session", () => ({
	hasPendingConversationMessage: vi.fn(() => false),
}));

import { load } from "./+page";

describe("chat conversation page load", () => {
	it("registers the conversation detail dependency for targeted reloads", async () => {
		const fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					conversation: {
						id: "conv-1",
						title: "Targeted invalidation",
						projectId: null,
						createdAt: 1,
						updatedAt: 1,
					},
					messages: [],
				}),
				{ status: 200 },
			);
		});
		const depends = vi.fn();

		const event = {
			params: { conversationId: "conv-1" },
			fetch: fetch as unknown as typeof globalThis.fetch,
			parent: vi.fn(async () => ({})),
			url: new URL("http://localhost/chat/conv-1"),
			depends,
		} as Parameters<typeof load>[0];
		await load(event);

		expect(depends).toHaveBeenCalledWith("app:conversation-detail:conv-1");
	});

	it("passes Deep Research jobs from conversation detail into page data", async () => {
		const deepResearchJobs = [
			{
				id: "research-job-1",
				conversationId: "conv-1",
				triggerMessageId: "user-1",
				depth: "standard",
				status: "awaiting_plan",
				stage: "job_shell_created",
				title: "Research battery recycling policy",
				userRequest: "Research battery recycling policy",
				createdAt: 1_777_140_002_000,
				updatedAt: 1_777_140_002_000,
				completedAt: null,
				cancelledAt: null,
			},
		];
		const fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					conversation: {
						id: "conv-1",
						title: "Research",
						projectId: null,
						createdAt: 1,
						updatedAt: 1,
					},
					messages: [],
					deepResearchJobs,
				}),
				{ status: 200 },
			);
		});

		const event = {
			params: { conversationId: "conv-1" },
			fetch: fetch as unknown as typeof globalThis.fetch,
			parent: vi.fn(async () => ({})),
			url: new URL("http://localhost/chat/conv-1"),
			depends: vi.fn(),
		} as Parameters<typeof load>[0];
		const data = await load(event);

		expect(fetch).toHaveBeenCalledWith("/api/conversations/conv-1");
		expect(data.deepResearchJobs).toEqual(deepResearchJobs);
	});

	it("preserves parent layout runtime flags for the chat page", async () => {
		const fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					conversation: {
						id: "conv-1",
						title: "Composer commands",
						projectId: null,
						createdAt: 1,
						updatedAt: 1,
					},
					messages: [],
				}),
				{ status: 200 },
			);
		});
		const parent = vi.fn(async () => ({
			composerCommandRegistryEnabled: true,
			deepResearchEnabled: true,
			maxMessageLength: 12000,
		}));

		const event = {
			params: { conversationId: "conv-1" },
			fetch: fetch as unknown as typeof globalThis.fetch,
			parent,
			url: new URL("http://localhost/chat/conv-1"),
			depends: vi.fn(),
		} as Parameters<typeof load>[0];
		const data = await load(event);

		expect(parent).toHaveBeenCalledOnce();
		expect(data.composerCommandRegistryEnabled).toBe(true);
		expect(data.deepResearchEnabled).toBe(true);
		expect(data.maxMessageLength).toBe(12000);
	});
});
