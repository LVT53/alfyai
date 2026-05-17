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
		defaultNewUserModel: "model2",
		model1: { displayName: "Model 1" },
		model2: { displayName: "Model 2" },
		model2Enabled: true,
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

	it("exposes inherited and effective model preferences to the app shell", async () => {
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
				userModelPreference: null,
				userModel: "model2",
				systemDefaultModel: "model2",
			}),
		);
	});

	it("exposes package version metadata to the sidebar", async () => {
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
				appVersion: {
					compact: "v0.1",
					full: "0.1.0",
				},
			}),
		);
	});
});
