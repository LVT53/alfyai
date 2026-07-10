import { describe, expect, it, vi } from "vitest";
import type { AppShellData } from "$lib/server/services/app-shell";
import type { Conversation, ModelId } from "$lib/types";

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

type LoadedPageData = Exclude<Awaited<ReturnType<typeof load>>, void>;

function conversationFixture(
	id: string,
	overrides: Partial<Conversation> = {},
): Conversation {
	return {
		id,
		title: "Chat",
		projectId: null,
		status: "open",
		sidebarPinned: false,
		sidebarSortOrder: null,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function appShellDataFixture(
	overrides: Partial<AppShellData> = {},
): AppShellData {
	return {
		user: {
			id: "user-1",
			email: "user@example.com",
			displayName: "User",
			role: "admin",
			profilePicture: null,
			titleLanguage: "auto",
			uiLanguage: "en",
		},
		conversations: Promise.resolve([]),
		projects: Promise.resolve([]),
		maxMessageLength: 12_000,
		composerCommandRegistryEnabled: false,
		atlasAvailability: {
			enabled: true,
			configured: true,
			reasonCode: null,
			reason: null,
		},
		userTheme: "system",
		userModel: "model1",
		systemDefaultModel: "model1",
		userModelPreference: "model1",
		userTitleLanguage: "auto",
		userUiLanguage: "en",
		userPersonality: null,
		userSidebarProjectsExpanded: true,
		userSidebarChatsExpanded: true,
		modelNames: { model1: "Model 1" },
		availableModels: [
			{
				id: "model1" as ModelId,
				displayName: "Model 1",
				isThirdParty: false,
				iconAssetId: null,
				iconUrl: null,
			},
		],
		appVersion: Promise.resolve({ compact: "test", full: "test" }),
		...overrides,
	};
}

function makeLoadEvent(
	fetch: typeof globalThis.fetch,
	parent: () => Promise<AppShellData>,
	url: string,
	depends = vi.fn(),
) {
	return {
		params: { conversationId: "conv-1" },
		fetch,
		parent,
		url: new URL(url),
		depends,
		data: null,
		setHeaders: vi.fn(),
		untrack: ((callback: () => unknown) => callback()) as never,
		tracing: undefined as never,
		route: { id: "/(app)/chat/[conversationId]" } as never,
	} as Parameters<typeof load>[0];
}

describe("chat conversation page load", () => {
	it("starts first-render detail loading before waiting for parent layout data", async () => {
		let resolveParent: (
			data: AppShellData | PromiseLike<AppShellData>,
		) => void = () => {};
		const parent = vi.fn(
			() =>
				new Promise<AppShellData>((resolve) => {
					resolveParent = resolve;
				}),
		);
		const fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					conversation: conversationFixture("conv-1", {
						title: "Fast first render",
					}),
					messages: [],
				}),
				{ status: 200 },
			);
		});

		const event = makeLoadEvent(
			fetch as unknown as typeof globalThis.fetch,
			parent,
			"http://localhost/chat/conv-1",
		);
		const loadPromise = load(event);
		await Promise.resolve();

		expect(fetch).toHaveBeenCalledWith(
			"/api/conversations/conv-1?view=first-render",
		);
		expect(parent).toHaveBeenCalledOnce();

		resolveParent(appShellDataFixture());
		const data = (await loadPromise) as LoadedPageData;
		expect(data.conversation.title).toBe("Fast first render");
	});

	it("registers the conversation detail dependency for targeted reloads", async () => {
		const fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					conversation: conversationFixture("conv-1", {
						title: "Targeted invalidation",
					}),
					messages: [],
				}),
				{ status: 200 },
			);
		});
		const depends = vi.fn();

		const event = makeLoadEvent(
			fetch as unknown as typeof globalThis.fetch,
			vi.fn(async () => appShellDataFixture()),
			"http://localhost/chat/conv-1",
			depends,
		);
		await load(event);

		expect(depends).toHaveBeenCalledWith("app:conversation-detail:conv-1");
	});

	it("requests bootstrap conversation detail when the URL asks for bootstrap view", async () => {
		const fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					conversation: conversationFixture("conv-1", { title: "Bootstrap" }),
					messages: [],
					bootstrap: true,
				}),
				{ status: 200 },
			);
		});

		const event = makeLoadEvent(
			fetch as unknown as typeof globalThis.fetch,
			vi.fn(async () => appShellDataFixture()),
			"http://localhost/chat/conv-1?view=bootstrap",
		);
		const data = (await load(event)) as LoadedPageData;

		expect(fetch).toHaveBeenCalledWith(
			"/api/conversations/conv-1?view=bootstrap",
		);
		expect(data.bootstrap).toBe(true);
	});

	it("defaults optional conversation detail fields for chat hydration", async () => {
		const fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					conversation: conversationFixture("conv-1", {
						title: "Sparse detail",
					}),
					messages: [],
				}),
				{ status: 200 },
			);
		});

		const event = makeLoadEvent(
			fetch as unknown as typeof globalThis.fetch,
			vi.fn(async () => appShellDataFixture()),
			"http://localhost/chat/conv-1",
		);
		const data = (await load(event)) as LoadedPageData;

		expect(data).toMatchObject({
			attachedArtifacts: [],
			activeWorkingSet: [],
			contextStatus: null,
			contextSources: null,
			taskState: null,
			contextDebug: null,
			draft: null,
			forkOrigin: null,
			bootstrap: false,
			generatedFiles: [],
			fileProductionJobs: [],
			contextCompressionSnapshots: [],
			activeSkillSession: null,
			totalCostUsdMicros: 0,
			totalTokens: 0,
			// Issue 7.5 — defaults to [] when the endpoint has nothing to say
			// (e.g. the mocked conversation-detail response reused here has no
			// `pendingWrites` field at all).
			pendingWrites: [],
		});
	});

	it("loads pending writes in parallel with conversation detail (Issue 7.5)", async () => {
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/pending-writes")) {
				return new Response(
					JSON.stringify({
						pendingWrites: [
							{
								id: "pw-1",
								assistantMessageId: null,
								conversationId: "conv-1",
								status: "pending",
								provider: "nextcloud",
								createdAt: 1700000000000,
								preview: {
									title: "Save note.txt to /AlfyAI",
									detail: "files.put — /AlfyAI/note.txt",
									reversible: true,
									destructive: false,
									withinAllowlist: true,
									warnings: [],
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify({
					conversation: conversationFixture("conv-1", { title: "Chat" }),
					messages: [],
				}),
				{ status: 200 },
			);
		});

		const event = makeLoadEvent(
			fetch as unknown as typeof globalThis.fetch,
			vi.fn(async () => appShellDataFixture()),
			"http://localhost/chat/conv-1",
		);
		const data = (await load(event)) as LoadedPageData;

		expect(fetch).toHaveBeenCalledWith(
			"/api/conversations/conv-1/pending-writes",
		);
		expect(data.pendingWrites).toEqual([
			expect.objectContaining({ id: "pw-1", status: "pending" }),
		]);
	});

	it("degrades to an empty pendingWrites list (never redirects/errors the page) when the pending-writes fetch fails", async () => {
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/pending-writes")) {
				return new Response(null, { status: 500 });
			}
			return new Response(
				JSON.stringify({
					conversation: conversationFixture("conv-1", { title: "Chat" }),
					messages: [],
				}),
				{ status: 200 },
			);
		});

		const event = makeLoadEvent(
			fetch as unknown as typeof globalThis.fetch,
			vi.fn(async () => appShellDataFixture()),
			"http://localhost/chat/conv-1",
		);
		const data = (await load(event)) as LoadedPageData;

		expect(data.pendingWrites).toEqual([]);
		expect(data.conversation.title).toBe("Chat");
	});

	it("preserves parent layout runtime flags for the chat page", async () => {
		const fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					conversation: conversationFixture("conv-1", {
						title: "Composer commands",
					}),
					messages: [],
				}),
				{ status: 200 },
			);
		});
		const parent = vi.fn(async () =>
			appShellDataFixture({
				composerCommandRegistryEnabled: true,
				maxMessageLength: 12000,
			}),
		);

		const event = makeLoadEvent(
			fetch as unknown as typeof globalThis.fetch,
			parent,
			"http://localhost/chat/conv-1",
		);
		const data = (await load(event)) as LoadedPageData;

		expect(parent).toHaveBeenCalledOnce();
		expect(data.composerCommandRegistryEnabled).toBe(true);
		expect(data.maxMessageLength).toBe(12000);
	});
});
