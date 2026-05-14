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

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		maxMessageLength: 12000,
		deepResearchEnabled: true,
		composerCommandRegistryEnabled: true,
	})),
	normalizeModelSelectionWithProviders: vi.fn((model: string) =>
		Promise.resolve(model),
	),
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
							preferredModel: "model1",
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

describe("(app) layout load", () => {
	it("exposes the Deep Research feature flag to app pages", async () => {
		const result = await load({
			locals: {
				user: {
					id: "user-1",
					email: "user@example.com",
					displayName: "User",
				},
			},
		} as Parameters<typeof load>[0]);

		expect(result).toEqual(
			expect.objectContaining({
				deepResearchEnabled: true,
			}),
		);
	});

	it("exposes the Composer Command Registry feature flag to app pages", async () => {
		const result = await load({
			locals: {
				user: {
					id: "user-1",
					email: "user@example.com",
					displayName: "User",
				},
			},
		} as Parameters<typeof load>[0]);

		expect(result).toEqual(
			expect.objectContaining({
				composerCommandRegistryEnabled: true,
			}),
		);
	});
});
