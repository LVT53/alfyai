import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./providers", () => ({
	listEnabledProviders: vi.fn(),
}));

vi.mock("./provider-models", () => ({
	listEnabledProviderModels: vi.fn(),
}));

import type { RuntimeConfig } from "../config-store";
import {
	getAvailableModelProviderGroups,
	getAvailableModelsWithProvidersForSettings,
	projectBuiltInAvailableModels,
} from "./available-models";
import { listEnabledProviderModels } from "./provider-models";
import { listEnabledProviders } from "./providers";

const mockListEnabledProviders = vi.mocked(listEnabledProviders);
const mockListEnabledProviderModels = vi.mocked(listEnabledProviderModels);

function runtimeConfig(): RuntimeConfig {
	return {
		model1: {
			baseUrl: "http://localhost:3001/v1",
			apiKey: "",
			modelName: "primary",
			displayName: "Primary",
			systemPrompt: "",
			maxTokens: null,
			reasoningEffort: null,
			thinkingType: null,
		},
		model2: {
			baseUrl: "http://localhost:3002/v1",
			apiKey: "",
			modelName: "backup",
			displayName: "Backup",
			systemPrompt: "",
			maxTokens: null,
			reasoningEffort: null,
			thinkingType: null,
		},
		model1IconAssetId: "primary-icon",
		model2IconAssetId: null,
		model2Enabled: true,
	} as RuntimeConfig;
}

describe("available model projection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListEnabledProviders.mockResolvedValue([
			{
				id: "provider-1",
				name: "openrouter",
				displayName: "OpenRouter",
				iconAssetId: "provider-icon",
				processingRegionCode: "US",
				privacyPolicyUrl: "https://example.com/privacy",
				enabled: true,
			} as Awaited<ReturnType<typeof listEnabledProviders>>[number],
		]);
		mockListEnabledProviderModels.mockResolvedValue([
			{
				id: "model-a",
				displayName: "Model A",
				iconAssetId: "model-icon",
				guideNoteEn: "Best for careful work.",
				guideNoteHu: null,
				guideBadge: "intelligent",
				guideNoCost: true,
				maxModelContext: 128000,
				inputUsdMicrosPer1m: 1000,
				outputUsdMicrosPer1m: 2000,
				enabled: true,
			} as Awaited<ReturnType<typeof listEnabledProviderModels>>[number],
		]);
	});

	it("projects built-in models plus enabled provider models for settings and API groups", async () => {
		const config = runtimeConfig();

		expect(projectBuiltInAvailableModels(config)).toEqual([
			{
				id: "model1",
				displayName: "Primary",
				iconAssetId: "primary-icon",
				iconUrl: "/api/campaign-assets/primary-icon/content",
			},
			{
				id: "model2",
				displayName: "Backup",
				iconAssetId: null,
				iconUrl: null,
			},
		]);

		await expect(
			getAvailableModelsWithProvidersForSettings(config),
		).resolves.toEqual([
			{
				id: "model1",
				displayName: "Primary",
				isThirdParty: false,
				iconAssetId: "primary-icon",
				iconUrl: "/api/campaign-assets/primary-icon/content",
			},
			{
				id: "model2",
				displayName: "Backup",
				isThirdParty: false,
				iconAssetId: null,
				iconUrl: null,
			},
			{
				id: "provider:provider-1:model-a",
				displayName: "OpenRouter - Model A",
				isThirdParty: true,
				iconAssetId: "model-icon",
				iconUrl: "/api/campaign-assets/model-icon/content",
			},
		]);

		await expect(getAvailableModelProviderGroups(config)).resolves.toEqual([
			{
				id: "built-in",
				name: "built-in",
				displayName: "AlfyAI",
				iconAssetId: null,
				iconUrl: null,
				processingRegionCode: null,
				privacyPolicyUrl: null,
				models: [
					{
						id: "model1",
						displayName: "Primary",
						iconUrl: "/api/campaign-assets/primary-icon/content",
						guideNoteEn: null,
						guideNoteHu: null,
						guideBadge: null,
						guideNoCost: false,
						maxModelContext: null,
						inputUsdMicrosPer1m: 0,
						outputUsdMicrosPer1m: 0,
					},
					{
						id: "model2",
						displayName: "Backup",
						iconUrl: null,
						guideNoteEn: null,
						guideNoteHu: null,
						guideBadge: null,
						guideNoCost: false,
						maxModelContext: null,
						inputUsdMicrosPer1m: 0,
						outputUsdMicrosPer1m: 0,
					},
				],
			},
			{
				id: "provider-1",
				name: "openrouter",
				displayName: "OpenRouter",
				iconAssetId: "provider-icon",
				iconUrl: "/api/campaign-assets/provider-icon/content",
				processingRegionCode: "US",
				privacyPolicyUrl: "https://example.com/privacy",
				models: [
					{
						id: "provider:provider-1:model-a",
						displayName: "Model A",
						iconUrl: "/api/campaign-assets/model-icon/content",
						guideNoteEn: "Best for careful work.",
						guideNoteHu: null,
						guideBadge: "intelligent",
						guideNoCost: true,
						maxModelContext: 128000,
						inputUsdMicrosPer1m: 1000,
						outputUsdMicrosPer1m: 2000,
					},
				],
			},
		]);
	});
});
