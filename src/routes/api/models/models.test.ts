import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
	getAvailableModels: vi.fn(),
	getEnabledProviders: vi.fn(),
	modelIconUrl: vi.fn((id: string | null) => (id ? `/icon/${id}` : null)),
}));

vi.mock("$lib/server/services/providers", () => ({
	listEnabledProviders: vi.fn(),
}));

vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: vi.fn(),
}));

import {
	getAvailableModels,
	getConfig,
	getEnabledProviders,
} from "$lib/server/config-store";
import { listEnabledProviderModels } from "$lib/server/services/provider-models";
import { listEnabledProviders } from "$lib/server/services/providers";
import { GET } from "./+server";

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockGetAvailableModels = getAvailableModels as ReturnType<typeof vi.fn>;
const mockGetEnabledProviders = getEnabledProviders as ReturnType<typeof vi.fn>;
const mockListEnabledProviders = listEnabledProviders as ReturnType<
	typeof vi.fn
>;
const mockListEnabledProviderModels = listEnabledProviderModels as ReturnType<
	typeof vi.fn
>;

describe("GET /api/models", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({
			model1: { displayName: "Test Model 1" },
			model2: { displayName: "Test Model 2" },
			model2Enabled: true,
		});
		mockGetAvailableModels.mockReturnValue([
			{
				id: "model1",
				displayName: "Test Model 1",
				iconAssetId: null,
				iconUrl: null,
			},
			{
				id: "model2",
				displayName: "Test Model 2",
				iconAssetId: null,
				iconUrl: null,
			},
		]);
		mockGetEnabledProviders.mockResolvedValue([]);
		mockListEnabledProviders.mockResolvedValue([]);
		mockListEnabledProviderModels.mockResolvedValue([]);
	});

	it("returns 200 with grouped providers", async () => {
		const response = await GET({} as any);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.providers).toBeDefined();
		expect(data.providers).toHaveLength(1);
	});

	it("returns built-in provider with model1 and model2", async () => {
		const response = await GET({} as any);
		const data = await response.json();

		const builtIn = data.providers[0];
		expect(builtIn.id).toBe("built-in");
		expect(builtIn.displayName).toBe("AlfyAI");
		expect(builtIn.models).toEqual([
			{ id: "model1", displayName: "Test Model 1", iconUrl: null },
			{ id: "model2", displayName: "Test Model 2", iconUrl: null },
		]);
	});

	it("hides model2 when model2 is disabled", async () => {
		mockGetConfig.mockReturnValue({
			model1: { displayName: "Test Model 1" },
			model2: { displayName: "Test Model 2" },
			model2Enabled: false,
		});
		mockGetAvailableModels.mockReturnValue([
			{
				id: "model1",
				displayName: "Test Model 1",
				iconAssetId: null,
				iconUrl: null,
			},
		]);

		const response = await GET({} as any);
		const data = await response.json();

		expect(data.providers[0].models).toEqual([
			{ id: "model1", displayName: "Test Model 1", iconUrl: null },
		]);
	});

	it("includes new providers with their models", async () => {
		mockListEnabledProviders.mockResolvedValue([
			{
				id: "new-1",
				name: "custom",
				displayName: "Custom Provider",
				iconAssetId: "custom-icon",
				enabled: true,
			},
		]);
		mockListEnabledProviderModels.mockResolvedValue([
			{ id: "m1", name: "gpt-4", displayName: "GPT-4", enabled: true },
			{ id: "m2", name: "gpt-3.5", displayName: "GPT-3.5", enabled: false },
		]);

		const response = await GET({} as any);
		const data = await response.json();

		const newProvider = data.providers.find(
			(p: { id: string }) => p.id === "new-1",
		);
		expect(newProvider).toBeDefined();
		expect(newProvider.displayName).toBe("Custom Provider");
		expect(newProvider.models).toEqual([
			{ id: "provider:new-1:m1", displayName: "GPT-4", iconUrl: null },
		]);
	});
});
