import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
}));

vi.mock("$lib/server/services/providers", () => ({
	listEnabledProviders: vi.fn(),
}));

vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: vi.fn(async () => []),
}));

import { getConfig } from "$lib/server/config-store";
import { listEnabledProviderModels } from "$lib/server/services/provider-models";
import { listEnabledProviders } from "$lib/server/services/providers";
import { GET } from "./+server";

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockListEnabledProviders = listEnabledProviders as ReturnType<
	typeof vi.fn
>;
const mockListEnabledProviderModels = listEnabledProviderModels as ReturnType<
	typeof vi.fn
>;

function routeEvent(): Parameters<typeof GET>[0] {
	return {} as Parameters<typeof GET>[0];
}

describe("GET /api/models", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({
			model1: {
				baseUrl: "http://localhost:3001/v1",
				modelName: "model-1",
				displayName: "Test Model 1",
			},
			model2: {
				baseUrl: "http://localhost:3002/v1",
				modelName: "model-2",
				displayName: "Test Model 2",
			},
			model1IconAssetId: null,
			model2IconAssetId: null,
			model2Enabled: true,
		});
		mockListEnabledProviders.mockResolvedValue([]);
		mockListEnabledProviderModels.mockImplementation(async () => []);
	});

	it("returns 200 with grouped providers", async () => {
		const response = await GET(routeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.providers).toBeDefined();
		expect(data.providers).toHaveLength(1);
	});

	it("returns built-in provider with model1 and model2", async () => {
		const response = await GET(routeEvent());
		const data = await response.json();

		const builtIn = data.providers[0];
		expect(builtIn.id).toBe("built-in");
		expect(builtIn.displayName).toBe("AlfyAI");
		expect(builtIn.models).toEqual([
			{
				id: "model1",
				displayName: "Test Model 1",
				iconUrl: null,
				guideNoteEn: null,
				guideNoteHu: null,
				guideBadge: null,
				guideNoCost: false,
				estimatedTokensPerSecond: null,
				maxModelContext: null,
				inputUsdMicrosPer1m: 0,
				outputUsdMicrosPer1m: 0,
			},
			{
				id: "model2",
				displayName: "Test Model 2",
				iconUrl: null,
				guideNoteEn: null,
				guideNoteHu: null,
				guideBadge: null,
				guideNoCost: false,
				estimatedTokensPerSecond: null,
				maxModelContext: null,
				inputUsdMicrosPer1m: 0,
				outputUsdMicrosPer1m: 0,
			},
		]);
	});

	it("hides model2 when model2 is disabled", async () => {
		mockGetConfig.mockReturnValue({
			model1: {
				baseUrl: "http://localhost:3001/v1",
				modelName: "model-1",
				displayName: "Test Model 1",
			},
			model2: {
				baseUrl: "http://localhost:3002/v1",
				modelName: "model-2",
				displayName: "Test Model 2",
			},
			model1IconAssetId: null,
			model2IconAssetId: null,
			model2Enabled: false,
		});

		const response = await GET(routeEvent());
		const data = await response.json();

		expect(data.providers[0].models).toEqual([
			{
				id: "model1",
				displayName: "Test Model 1",
				iconUrl: null,
				guideNoteEn: null,
				guideNoteHu: null,
				guideBadge: null,
				guideNoCost: false,
				estimatedTokensPerSecond: null,
				maxModelContext: null,
				inputUsdMicrosPer1m: 0,
				outputUsdMicrosPer1m: 0,
			},
		]);
	});

	it("includes new providers with their models", async () => {
		mockListEnabledProviders.mockResolvedValue([
			{
				id: "new-1",
				name: "custom",
				displayName: "Custom Provider",
				iconAssetId: "custom-icon",
				processingRegionCode: "CN",
				privacyPolicyUrl: "https://example.com/privacy",
				enabled: true,
			},
		]);
		mockListEnabledProviderModels.mockImplementation(async () =>
			[
				{
					id: "m1",
					name: "gpt-4",
					displayName: "GPT-4",
					enabled: true,
					guideNoteEn: "Best for hard tasks.",
					guideNoteHu: null,
					guideBadge: "intelligent",
					guideNoCost: true,
					estimatedTokensPerSecond: 150,
					maxModelContext: 128000,
					inputUsdMicrosPer1m: 1000,
					outputUsdMicrosPer1m: 2000,
				},
				{
					id: "m2",
					name: "gpt-3.5",
					displayName: "GPT-3.5",
					enabled: false,
				},
			].filter((model) => model.enabled !== false),
		);

		const response = await GET(routeEvent());
		const data = await response.json();

		const newProvider = data.providers.find(
			(p: { id: string }) => p.id === "new-1",
		);
		expect(newProvider).toBeDefined();
		expect(newProvider.displayName).toBe("Custom Provider");
		expect(newProvider.processingRegionCode).toBe("CN");
		expect(newProvider.privacyPolicyUrl).toBe("https://example.com/privacy");
		expect(newProvider.models).toEqual([
			{
				id: "provider:new-1:m1",
				displayName: "GPT-4",
				iconUrl: null,
				guideNoteEn: "Best for hard tasks.",
				guideNoteHu: null,
				guideBadge: "intelligent",
				guideNoCost: true,
				estimatedTokensPerSecond: 150,
				maxModelContext: 128000,
				inputUsdMicrosPer1m: 1000,
				outputUsdMicrosPer1m: 2000,
			},
		]);
	});
});
