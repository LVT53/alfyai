import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsAdminSystemPane from "./SettingsAdminSystemPane.svelte";
import { createModelCapabilitySet } from "$lib/model-capabilities";

vi.mock("$lib/client/api/admin", () => ({
	createAdminSystemSkill: vi.fn(),
	createProviderEntry: vi.fn(),
	deleteProviderEntry: vi.fn(),
	discoverProviderModels: vi.fn(),
	fetchAdminSystemSkills: vi.fn(() => Promise.resolve([])),
	fetchPersonalityProfiles: vi.fn(() => Promise.resolve([])),
	fetchProviderList: vi.fn(() => Promise.resolve([])),
	fetchProviderModels: vi.fn(() => Promise.resolve([])),
	updateAdminConfig: vi.fn(),
	updateAdminSystemSkill: vi.fn(),
	updateProviderEntry: vi.fn(),
	updateProviderModel: vi.fn(),
}));

vi.mock("$lib/client/api/campaign-assets", () => ({
	saveModelIconAssetCrop: vi.fn(),
	uploadCampaignAssetSource: vi.fn(),
	uploadModelIconAsset: vi.fn(),
}));

import {
	fetchProviderList,
	fetchProviderModels,
} from "$lib/client/api/admin";

const mockFetchProviderList = fetchProviderList as ReturnType<typeof vi.fn>;
const mockFetchProviderModels = fetchProviderModels as ReturnType<typeof vi.fn>;

function providerFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "provider-1",
		name: "provider-1",
		displayName: "Provider 1",
		baseUrl: "https://provider.example/v1",
		iconAssetId: null,
		rateLimitFallbackEnabled: false,
		rateLimitFallbackBaseUrl: null,
		rateLimitFallbackModelName: null,
		rateLimitFallbackTimeoutMs: 10_000,
		sortOrder: 0,
		enabled: true,
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function providerTwoFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "provider-2",
		name: "provider-2",
		displayName: "Provider 2",
		baseUrl: "https://provider-two.example/v1",
		iconAssetId: null,
		rateLimitFallbackEnabled: false,
		rateLimitFallbackBaseUrl: null,
		rateLimitFallbackModelName: null,
		rateLimitFallbackTimeoutMs: 10_000,
		sortOrder: 1,
		enabled: true,
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function modelFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "model-1",
		providerId: "provider-1",
		name: "source-model",
		displayName: "Source Model",
		iconAssetId: null,
		maxModelContext: 128_000,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: null,
		maxTokens: null,
		reasoningEffort: "low",
		thinkingType: null,
		capabilitiesJson: JSON.stringify(
			createModelCapabilitySet({
				chat: { state: "detected" },
				streaming: { state: "detected" },
				reasoningControls: { state: "detected" },
			}),
		),
		inputUsdMicrosPer1m: 0,
		cachedInputUsdMicrosPer1m: 0,
		cacheHitUsdMicrosPer1m: 0,
		cacheMissUsdMicrosPer1m: 0,
		outputUsdMicrosPer1m: 0,
		enabled: true,
		sortOrder: 0,
		createdAt: "",
		updatedAt: "",
		fallbackProviderModelId: null,
		...overrides,
	};
}

describe("SettingsAdminSystemPane model fallback UI", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchProviderList.mockResolvedValue([
			providerFixture(),
			providerTwoFixture(),
		]);
		mockFetchProviderModels.mockImplementation(async (providerId: string) => {
			if (providerId === "provider-1") {
				return [
					modelFixture({
						reasoningEffort: null,
					}),
				];
			}

			return [
				modelFixture({
					id: "model-2",
					providerId,
					name: "fallback-model",
					displayName: "Fallback Model",
					enabled: false,
					reasoningEffort: null,
					thinkingType: null,
					capabilitiesJson: JSON.stringify(
						createModelCapabilitySet({
							chat: { state: "detected" },
							streaming: { state: "detected" },
						}),
					),
					sortOrder: 1,
				}),
			];
		});
	});

	it("shows fallback compatibility warnings and disables incompatible fallback targets", async () => {
		const { getByRole, getByText, getByTitle, getAllByTitle, getAllByRole } =
			render(
			SettingsAdminSystemPane,
			{
				adminConfig: {
					COMPOSER_COMMAND_REGISTRY_ENABLED: "false",
					DEEP_RESEARCH_ENABLED: "false",
					DEEP_RESEARCH_WORKER_ENABLED: "false",
					MODEL_2_ENABLED: "true",
				},
				envDefaults: {},
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onCheckHonchoHealth: vi.fn(),
				onSaveAdminConfig: vi.fn(),
			},
		);

		await waitFor(() => {
			expect(
				getAllByTitle("Some models have no compatible fallback"),
			).not.toHaveLength(0);
		});

		await fireEvent.click(
			getAllByRole("button", { name: "Manage models" })[0],
		);
		await waitFor(() => {
			expect(getByText("Source Model")).toBeInTheDocument();
		});

		expect(getByTitle("No compatible fallback")).toBeInTheDocument();

		const editButtons = getAllByRole("button", { name: "Edit" });
		await fireEvent.click(editButtons[editButtons.length - 1]);
		await waitFor(() => {
			expect(getByText("No compatible model-specific fallback is available for this model.")).toBeInTheDocument();
		});

		const select = getByRole("combobox", { name: "Model-specific fallback" }) as HTMLSelectElement;
		expect(select.options).toHaveLength(2);
		expect(select.options[0].textContent?.trim()).toBe("No model-specific fallback");
		expect(select.options[1].disabled).toBe(true);
		expect(select.options[1].textContent?.replace(/\s+/g, " ").trim()).toBe(
			"Fallback Model — Model is disabled.",
		);
	});

	it("does not render provider-only timeout failover options when provider models exist", async () => {
		const { getByRole } = render(SettingsAdminSystemPane, {
			adminConfig: {
				COMPOSER_COMMAND_REGISTRY_ENABLED: "false",
				DEEP_RESEARCH_ENABLED: "false",
				DEEP_RESEARCH_WORKER_ENABLED: "false",
				MODEL_2_ENABLED: "true",
				MODEL_TIMEOUT_FAILOVER_TARGET_MODEL:
					"provider:provider-1:model-1",
			},
			envDefaults: {},
			availableModels: [
				{ id: "model1", displayName: "Model 1" },
				{ id: "model2", displayName: "Model 2" },
				{ id: "provider:provider-1", displayName: "Provider 1" },
				{
					id: "provider:provider-1:model-1",
					displayName: "Provider 1 - Model 1",
				},
			],
			onCheckHonchoHealth: vi.fn(),
			onSaveAdminConfig: vi.fn(),
		});

		const select = getByRole("combobox", {
			name: "Failover Model",
		}) as HTMLSelectElement;

		expect(Array.from(select.options).map((option) => option.value)).toEqual([
			"model1",
			"model2",
			"provider:provider-1:model-1",
		]);
		expect(Array.from(select.options).some((option) => option.value === "provider:provider-1")).toBe(
			false,
		);
	});
});
