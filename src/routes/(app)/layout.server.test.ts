import { describe, expect, it, vi } from "vitest";
import type { AppShellData } from "$lib/server/services/app-shell";

vi.mock("@sveltejs/kit", () => ({
	redirect: vi.fn((status: number, location: string) => ({ status, location })),
}));

vi.mock("$lib/server/services/conversations", () => ({
	listConversations: vi.fn(() => Promise.resolve([])),
}));

vi.mock("$lib/server/services/projects", () => ({
	listProjects: vi.fn(() => Promise.resolve([])),
}));

vi.mock("$lib/server/services/app-version", () => ({
	getAppVersionMetadata: vi.fn(() =>
		Promise.resolve({
			compact: "v1.0.1",
			full: "1.0.1",
		}),
	),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		maxMessageLength: 12000,
		composerCommandRegistryEnabled: true,
		atlasWorkerEnabled: true,
		searxngBaseUrl: "http://searxng.local",
		defaultNewUserModel: "model2",
		model1: { displayName: "Model 1" },
		model2: { displayName: "Model 2" },
		model2Enabled: true,
	})),
	normalizeModelSelection: vi.fn((model: string) => model),
	normalizeModelSelectionWithProviders: vi.fn(async (model: string) => model),
	getAvailableModelsWithProviders: vi.fn(() =>
		Promise.resolve([{ id: "model1", displayName: "Model 1" }]),
	),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() =>
					Promise.resolve([
						{
							preferredModel: "model2",
							theme: "system",
							titleLanguage: "auto",
							uiLanguage: "en",
							preferredPersonalityId: null,
							avatarId: null,
						},
					]),
				),
			})),
		})),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	users: {
		id: "id",
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn(),
}));

const { load } = await import("./+layout.server");
const { listConversations } = await import(
	"$lib/server/services/conversations"
);
const { getAppVersionMetadata } = await import(
	"$lib/server/services/app-version"
);

function createAuthenticatedLoadEvent() {
	return {
		locals: {
			user: {
				id: "user-1",
				email: "user@example.com",
				displayName: "User",
			},
		},
		depends: vi.fn(),
	} as unknown as Parameters<typeof load>[0];
}

type LoadResult = AppShellData;

describe("(app) layout load", () => {
	it("streams sidebar conversations without blocking the critical app shell payload", async () => {
		let resolveConversations:
			| ((
					value: Array<{ id: string; title: string; updatedAt: number }>,
			  ) => void)
			| undefined;
		const conversationsPromise = new Promise<
			Array<{ id: string; title: string; updatedAt: number }>
		>((resolve) => {
			resolveConversations = resolve;
		});
		vi.mocked(listConversations).mockReturnValueOnce(
			conversationsPromise as ReturnType<typeof listConversations>,
		);

		const loadPromise: Promise<LoadResult> = Promise.resolve(
			load(createAuthenticatedLoadEvent()),
		) as Promise<LoadResult>;
		const earlyResult = (await Promise.race([
			loadPromise.then((result) => ({ status: "resolved" as const, result })),
			new Promise<{ status: "pending" }>((resolve) =>
				setTimeout(() => resolve({ status: "pending" }), 0),
			),
		])) as { status: "resolved"; result: LoadResult } | { status: "pending" };

		expect(earlyResult.status).toBe("resolved");
		if (earlyResult.status !== "resolved") {
			throw new Error(
				"Expected app shell load to resolve before conversations",
			);
		}
		expect(earlyResult.result).toEqual(
			expect.objectContaining({
				maxMessageLength: 12000,
				userModel: "model2",
			}),
		);

		if (resolveConversations) {
			resolveConversations([
				{ id: "conv-1", title: "Sidebar chat", updatedAt: 1 },
			]);
		}
		await expect(
			Promise.resolve(earlyResult.result.conversations),
		).resolves.toEqual([{ id: "conv-1", title: "Sidebar chat", updatedAt: 1 }]);
	});

	it("marks manually streamed app shell promises as handled before returning load data", async () => {
		const conversationsCatch = vi.fn();
		const conversationsPromise = {
			catch: conversationsCatch,
		} as unknown as Promise<
			Array<{ id: string; title: string; updatedAt: number }>
		>;
		const projectsCatch = vi.fn();
		const projectsPromise = {
			catch: projectsCatch,
		} as unknown as Promise<Array<{ id: string; name: string }>>;
		const appVersionCatch = vi.fn();
		const appVersionPromise = {
			catch: appVersionCatch,
		} as unknown as Promise<{ compact: string; full: string }>;
		vi.mocked(listConversations).mockReturnValueOnce(
			conversationsPromise as ReturnType<typeof listConversations>,
		);
		const { listProjects } = await import("$lib/server/services/projects");
		vi.mocked(listProjects).mockReturnValueOnce(
			projectsPromise as ReturnType<typeof listProjects>,
		);
		vi.mocked(getAppVersionMetadata).mockReturnValueOnce(
			appVersionPromise as ReturnType<typeof getAppVersionMetadata>,
		);

		const result = (await load(createAuthenticatedLoadEvent())) as LoadResult;

		expect(result.conversations).toBe(conversationsPromise);
		expect(result.projects).toBe(projectsPromise);
		expect(result.appVersion).toBe(appVersionPromise);
		expect(conversationsCatch).toHaveBeenCalledWith(expect.any(Function));
		expect(projectsCatch).toHaveBeenCalledWith(expect.any(Function));
		expect(appVersionCatch).toHaveBeenCalledWith(expect.any(Function));
	});

	it("registers app shell dependencies for targeted reloads", async () => {
		const event = createAuthenticatedLoadEvent();

		await load(event);

		expect(event.depends).toHaveBeenCalledWith("app:shell");
		expect(event.depends).toHaveBeenCalledWith("app:shell:conversations");
	});

	it("exposes the Composer Command Registry feature flag to app pages", async () => {
		const result = (await load(createAuthenticatedLoadEvent())) as LoadResult;

		expect(result).toEqual(
			expect.objectContaining({
				composerCommandRegistryEnabled: true,
			}),
		);
	});

	it("exposes Atlas availability to app page composers", async () => {
		const result = (await load(createAuthenticatedLoadEvent())) as LoadResult;

		expect(result).toEqual(
			expect.objectContaining({
				atlasAvailability: {
					enabled: true,
					configured: true,
					reasonCode: null,
					reason: null,
				},
			}),
		);
	});

	it("exposes inherited and effective model preferences to the app shell", async () => {
		const result = (await load(createAuthenticatedLoadEvent())) as LoadResult;

		expect(result).toEqual(
			expect.objectContaining({
				userModelPreference: null,
				userModel: "model2",
				systemDefaultModel: "model2",
			}),
		);
	});

	it("exposes resolved app version metadata to the sidebar", async () => {
		const result = (await load(createAuthenticatedLoadEvent())) as LoadResult;

		await expect(result.appVersion).resolves.toEqual({
			compact: "v1.0.1",
			full: "1.0.1",
		});
	});
});
