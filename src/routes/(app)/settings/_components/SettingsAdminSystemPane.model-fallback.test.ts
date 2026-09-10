import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import SettingsAdminSystemPane from "./SettingsAdminSystemPane.svelte";

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

vi.mock("$lib/client/api/admin-system-health", () => ({
	fetchAdminConfigOverrideMeta: vi.fn(() => Promise.resolve({})),
	fetchAdminEffectiveConfig: vi.fn(),
	fetchAdminToolHealth: vi.fn(),
	validateProviderConnection: vi.fn(() => Promise.resolve({ valid: true })),
}));

vi.mock("$lib/client/api/campaign-assets", () => ({
	saveModelIconAssetCrop: vi.fn(),
	uploadCampaignAssetSource: vi.fn(),
	uploadModelIconAsset: vi.fn(),
}));

import { fetchProviderList, fetchProviderModels } from "$lib/client/api/admin";

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
		guideNoteEn: null,
		guideNoteHu: null,
		guideBadge: null,
		guideNoCost: false,
		estimatedTokensPerSecond: null,
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
		const { getByRole, getByText, getByTitle, getAllByTitle, getByTestId } =
			render(SettingsAdminSystemPane, {
				adminConfig: {
					COMPOSER_COMMAND_REGISTRY_ENABLED: "false",
					MODEL_2_ENABLED: "true",
				},
				envDefaults: {},
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onSaveAdminConfig: vi.fn(),
			});

		await fireEvent.click(getByTestId("system-nav-models"));

		await waitFor(() => {
			expect(
				getAllByTitle("Some models have no compatible fallback"),
			).not.toHaveLength(0);
		});

		// The models of a provider open in a drawer on its row now.
		await fireEvent.click(getByTestId("provider-models-provider-1"));
		await waitFor(() => {
			expect(getByText("Source Model")).toBeInTheDocument();
		});

		expect(getByTitle("No compatible fallback")).toBeInTheDocument();

		await fireEvent.click(getByRole("button", { name: "Edit Source Model" }));
		await waitFor(() => {
			expect(
				getByText(
					"No compatible model-specific fallback is available for this model.",
				),
			).toBeInTheDocument();
		});

		const select = getByRole("combobox", {
			name: "Model-specific fallback",
		}) as HTMLSelectElement;
		expect(select.options).toHaveLength(2);
		expect(select.options[0].textContent?.trim()).toBe(
			"No model-specific fallback",
		);
		expect(select.options[1].disabled).toBe(true);
		expect(select.options[1].textContent?.replace(/\s+/g, " ").trim()).toBe(
			"Provider 2 - Fallback Model — Model is disabled.",
		);
	});

	it("does not render provider-only timeout failover options when provider models exist", async () => {
		const { getByRole, getByTestId } = render(SettingsAdminSystemPane, {
			adminConfig: {
				COMPOSER_COMMAND_REGISTRY_ENABLED: "false",
				MODEL_2_ENABLED: "true",
				MODEL_TIMEOUT_FAILOVER_TARGET_MODEL: "provider:provider-1:model-1",
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
			onSaveAdminConfig: vi.fn(),
		});

		await fireEvent.click(getByTestId("system-nav-models"));
		await waitFor(() => {
			expect(getByTestId("provider-models-provider-1")).toBeInTheDocument();
		});

		// "Retry on" is the timeout-failover target, on its own card below the
		// provider list rather than inside it.
		const select = getByRole("combobox", {
			name: "Retry on",
		}) as HTMLSelectElement;
		const providerRowButton = getByTestId("provider-models-provider-1");

		expect(
			select.compareDocumentPosition(providerRowButton) &
				Node.DOCUMENT_POSITION_PRECEDING,
		).not.toBe(0);

		expect(Array.from(select.options).map((option) => option.value)).toEqual([
			"model1",
			"model2",
			"provider:provider-1:model-1",
		]);
		expect(
			Array.from(select.options).some(
				(option) => option.value === "provider:provider-1",
			),
		).toBe(false);
	});

	it("renders the memory judge and consolidation model selectors with the failover option set", async () => {
		const { getByRole, getByTestId } = render(SettingsAdminSystemPane, {
			adminConfig: {
				COMPOSER_COMMAND_REGISTRY_ENABLED: "false",
				MODEL_2_ENABLED: "true",
				MEMORY_JUDGE_MODEL: "provider:provider-1:model-1",
				MEMORY_CONSOLIDATION_MODEL: "model2",
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
			onSaveAdminConfig: vi.fn(),
		});

		await fireEvent.click(getByTestId("system-nav-aiTasks"));
		await waitFor(() => {
			expect(getByTestId("system-page-ai-tasks")).toBeInTheDocument();
		});

		const judgeSelect = getByRole("combobox", {
			name: "Memory judge model",
		}) as HTMLSelectElement;
		const consolidationSelect = getByRole("combobox", {
			name: "Memory consolidation model",
		}) as HTMLSelectElement;

		expect(
			Array.from(judgeSelect.options).map((option) => option.value),
		).toEqual(["model1", "model2", "provider:provider-1:model-1"]);
		expect(judgeSelect.value).toBe("provider:provider-1:model-1");
		expect(consolidationSelect.value).toBe("model2");

		await fireEvent.change(judgeSelect, { target: { value: "model1" } });
		await fireEvent.change(consolidationSelect, {
			target: { value: "provider:provider-1:model-1" },
		});
	});

	it("keeps a stale configured memory model id visible and selected instead of dropping it", async () => {
		const adminConfig = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "false",
			MODEL_2_ENABLED: "true",
			MEMORY_JUDGE_MODEL: "provider:stale-provider:stale-model",
		};

		const { getByRole, getByTestId } = render(SettingsAdminSystemPane, {
			adminConfig,
			envDefaults: {},
			availableModels: [
				{ id: "model1", displayName: "Model 1" },
				{ id: "model2", displayName: "Model 2" },
			],
			onSaveAdminConfig: vi.fn(),
		});

		await fireEvent.click(getByTestId("system-nav-aiTasks"));
		await waitFor(() => {
			expect(getByTestId("system-page-ai-tasks")).toBeInTheDocument();
		});

		const judgeSelect = getByRole("combobox", {
			name: "Memory judge model",
		}) as HTMLSelectElement;

		expect(judgeSelect.value).toBe("provider:stale-provider:stale-model");
		expect(
			Array.from(judgeSelect.options).some(
				(option) => option.value === "provider:stale-provider:stale-model",
			),
		).toBe(true);
	});

	it("keeps EVERY stale id visible, not only the first select's", async () => {
		// The three selects share one option list. Rescuing one configured id
		// left the others with no matching option, and a select with no matching
		// option renders whatever happens to be first — so the screen said
		// "Model 1" while the stored config still named the deleted model.
		const adminConfig = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "false",
			MODEL_2_ENABLED: "true",
			MEMORY_JUDGE_MODEL: "model1",
			MEMORY_CONSOLIDATION_MODEL: "provider:gone:consolidation-model",
			MODEL_TIMEOUT_FAILOVER_TARGET_MODEL: "provider:gone:failover-model",
		};

		const { getByRole, getByTestId } = render(SettingsAdminSystemPane, {
			adminConfig,
			envDefaults: {},
			availableModels: [
				{ id: "model1", displayName: "Model 1" },
				{ id: "model2", displayName: "Model 2" },
			],
			onSaveAdminConfig: vi.fn(),
		});

		await fireEvent.click(getByTestId("system-nav-aiTasks"));
		await waitFor(() => {
			expect(getByTestId("system-page-ai-tasks")).toBeInTheDocument();
		});

		const consolidationSelect = getByRole("combobox", {
			name: "Memory consolidation model",
		}) as HTMLSelectElement;
		expect(consolidationSelect.value).toBe("provider:gone:consolidation-model");

		await fireEvent.click(getByTestId("system-nav-models"));
		await waitFor(() => {
			expect(getByTestId("system-page-models")).toBeInTheDocument();
		});

		const failoverSelect = getByRole("combobox", {
			name: "Retry on",
		}) as HTMLSelectElement;
		expect(failoverSelect.value).toBe("provider:gone:failover-model");
	});
});
