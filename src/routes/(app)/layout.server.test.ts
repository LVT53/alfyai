import { describe, expect, it, vi } from "vitest";

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
		deepResearchEnabled: true,
		composerCommandRegistryEnabled: true,
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
	} as Parameters<typeof load>[0];
}

describe("(app) layout load", () => {
	it("streams sidebar conversations without blocking the critical app shell payload", async () => {
		let resolveConversations:
			| ((value: Array<{ id: string; title: string; updatedAt: number }>) => void)
			| null = null;
		const conversationsPromise = new Promise<
			Array<{ id: string; title: string; updatedAt: number }>
		>((resolve) => {
			resolveConversations = resolve;
		});
		vi.mocked(listConversations).mockReturnValueOnce(
			conversationsPromise as ReturnType<typeof listConversations>,
		);

		const loadPromise = load(createAuthenticatedLoadEvent());
		const earlyResult = await Promise.race([
			loadPromise.then((result) => ({ status: "resolved" as const, result })),
			new Promise<{ status: "pending" }>((resolve) =>
				setTimeout(() => resolve({ status: "pending" }), 0),
			),
		]);

		expect(earlyResult.status).toBe("resolved");
		if (earlyResult.status !== "resolved") {
			throw new Error("Expected app shell load to resolve before conversations");
		}
		expect(earlyResult.result).toEqual(
			expect.objectContaining({
				maxMessageLength: 12000,
				userModel: "model2",
			}),
		);

		resolveConversations?.([
			{ id: "conv-1", title: "Sidebar chat", updatedAt: 1 },
		]);
		await expect(earlyResult.result.conversations).resolves.toEqual([
			{ id: "conv-1", title: "Sidebar chat", updatedAt: 1 },
		]);
	});

	it("marks manually streamed app shell promises as handled before returning load data", async () => {
		const conversationsPromise = new Promise<
			Array<{ id: string; title: string; updatedAt: number }>
		>(() => undefined);
		const projectsPromise = new Promise<Array<{ id: string; name: string }>>(
			() => undefined,
		);
		const appVersionPromise = new Promise<{ compact: string; full: string }>(
			() => undefined,
		);
		const conversationsCatch = vi.spyOn(conversationsPromise, "catch");
		const projectsCatch = vi.spyOn(projectsPromise, "catch");
		const appVersionCatch = vi.spyOn(appVersionPromise, "catch");
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

		const result = await load(createAuthenticatedLoadEvent());

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

	it("exposes the Deep Research feature flag to app pages", async () => {
		const result = await load(createAuthenticatedLoadEvent());

		expect(result).toEqual(
			expect.objectContaining({
				deepResearchEnabled: true,
			}),
		);
	});

	it("exposes the Composer Command Registry feature flag to app pages", async () => {
		const result = await load(createAuthenticatedLoadEvent());

		expect(result).toEqual(
			expect.objectContaining({
				composerCommandRegistryEnabled: true,
			}),
		);
	});

	it("exposes inherited and effective model preferences to the app shell", async () => {
		const result = await load(createAuthenticatedLoadEvent());

		expect(result).toEqual(
			expect.objectContaining({
				userModelPreference: null,
				userModel: "model2",
				systemDefaultModel: "model2",
			}),
		);
	});

	it("exposes resolved app version metadata to the sidebar", async () => {
		const result = await load(createAuthenticatedLoadEvent());

		await expect(result.appVersion).resolves.toEqual({
			compact: "v1.0.1",
			full: "1.0.1",
		});
	});
});
