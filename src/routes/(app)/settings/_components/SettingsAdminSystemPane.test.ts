import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsAdminSystemPane from "./SettingsAdminSystemPane.svelte";

vi.mock("$lib/client/api/admin", () => ({
	createAdminSystemSkill: vi.fn(),
	createProviderEntry: vi.fn(),
	deleteProviderEntry: vi.fn(),
	discoverProviderModels: vi.fn(),
	fetchAdminSystemSkills: vi.fn(() => Promise.resolve([])),
	fetchPersonalityProfiles: vi.fn(() => Promise.resolve([])),
	fetchProviderList: vi.fn(() => Promise.resolve([])),
	updateAdminConfig: vi.fn(),
	updateAdminSystemSkill: vi.fn(),
	updateProviderEntry: vi.fn(),
}));

vi.mock("$lib/client/api/campaign-assets", () => ({
	saveModelIconAssetCrop: vi.fn(),
	uploadCampaignAssetSource: vi.fn(),
	uploadModelIconAsset: vi.fn(),
}));

import {
	createProviderEntry,
	fetchAdminSystemSkills,
	fetchProviderList,
	updateProviderEntry,
	updateAdminConfig,
	updateAdminSystemSkill,
} from "$lib/client/api/admin";
import {
	saveModelIconAssetCrop,
	uploadCampaignAssetSource,
	uploadModelIconAsset,
} from "$lib/client/api/campaign-assets";
import { createModelCapabilitySet } from "$lib/model-capabilities";

const mockCreateProviderEntry = createProviderEntry as ReturnType<typeof vi.fn>;
const mockFetchAdminSystemSkills = fetchAdminSystemSkills as ReturnType<typeof vi.fn>;
const mockFetchProviderList = fetchProviderList as ReturnType<typeof vi.fn>;
const mockUpdateProviderEntry = updateProviderEntry as ReturnType<typeof vi.fn>;
const mockUpdateAdminConfig = updateAdminConfig as ReturnType<typeof vi.fn>;
const mockUpdateAdminSystemSkill = updateAdminSystemSkill as ReturnType<typeof vi.fn>;
const mockSaveModelIconAssetCrop = saveModelIconAssetCrop as ReturnType<typeof vi.fn>;
const mockUploadCampaignAssetSource = uploadCampaignAssetSource as ReturnType<typeof vi.fn>;
const mockUploadModelIconAsset = uploadModelIconAsset as ReturnType<typeof vi.fn>;

function byExactTextContent(text: string) {
	return (_content: string, element: Element | null) =>
		element?.textContent?.replace(/\s+/g, " ").trim() === text;
}

function providerFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "provider-1",
		name: "provider_1",
		displayName: "Provider 1",
		baseUrl: "https://provider.example/v1",
		modelName: "provider-model",
		reasoningEffort: null,
		thinkingType: null,
		enabled: true,
		sortOrder: 0,
		maxModelContext: 128000,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: null,
		maxTokens: null,
		iconAssetId: null,
		iconUrl: null,
		rateLimitFallbackEnabled: false,
		rateLimitFallbackBaseUrl: null,
		rateLimitFallbackModelName: null,
		rateLimitFallbackTimeoutMs: 10000,
		capabilities: createModelCapabilitySet(),
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

describe("SettingsAdminSystemPane", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreateProviderEntry.mockResolvedValue({
			id: "provider-1",
			name: "fireworks-ai",
			displayName: "Fireworks AI",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			reasoningEffort: null,
			thinkingType: null,
			enabled: true,
			sortOrder: 0,
			maxModelContext: 262144,
			compactionUiThreshold: null,
			targetConstructedContext: null,
			maxMessageLength: null,
			maxTokens: null,
			createdAt: "",
			updatedAt: "",
		});
		mockFetchAdminSystemSkills.mockResolvedValue([]);
		mockFetchProviderList.mockResolvedValue([]);
		mockUpdateProviderEntry.mockResolvedValue(undefined);
		mockUpdateAdminConfig.mockResolvedValue(undefined);
		mockSaveModelIconAssetCrop.mockResolvedValue({ id: "icon-crop-1" });
		mockUploadCampaignAssetSource.mockResolvedValue({ id: "source-1" });
		mockUploadModelIconAsset.mockResolvedValue({ id: "icon-1" });
		Object.defineProperty(URL, "createObjectURL", {
			value: vi.fn(() => "blob:model-icon"),
			configurable: true,
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			value: vi.fn(),
			configurable: true,
		});
		Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
			value: vi.fn(() => ({
				clearRect: vi.fn(),
				drawImage: vi.fn(),
			})),
			configurable: true,
		});
		Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
			value: vi.fn((callback: BlobCallback) => {
				callback(new Blob(["webp"], { type: "image/webp" }));
			}),
			configurable: true,
		});
	});

	it("lets admins enable the Composer Command Registry feature flag", async () => {
		const adminConfig = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "false",
			MODEL_2_ENABLED: "true",
			DEEP_RESEARCH_ENABLED: "false",
			DEEP_RESEARCH_WORKER_ENABLED: "false",
		};

		const { getByLabelText, getByText } = render(SettingsAdminSystemPane, {
			adminConfig,
			envDefaults: { COMPOSER_COMMAND_REGISTRY_ENABLED: "false" },
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onCheckHonchoHealth: vi.fn(),
			onSaveAdminConfig: vi.fn(),
		});

		await waitFor(() => {
			expect(getByText("Composer Command Registry")).toBeInTheDocument();
		});

		const toggle = getByLabelText("Enable Composer Command Registry");
		await fireEvent.click(toggle);

		expect(adminConfig.COMPOSER_COMMAND_REGISTRY_ENABLED).toBe("true");
	});

	it("lets admins edit and save the silent app version override", async () => {
		const onSaveAdminConfig = vi.fn();
		const adminConfig = {
			APP_VERSION_OVERRIDE: "",
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
			DEEP_RESEARCH_ENABLED: "false",
			DEEP_RESEARCH_WORKER_ENABLED: "false",
		};

		const { getByLabelText, getByRole } = render(SettingsAdminSystemPane, {
			adminConfig,
			envDefaults: { APP_VERSION_OVERRIDE: "" },
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onCheckHonchoHealth: vi.fn(),
			onSaveAdminConfig,
		});

		await fireEvent.input(getByLabelText("App version override"), {
			target: { value: "2026.05-admin" },
		});
		await fireEvent.click(
			getByRole("button", { name: "Save Configuration" }),
		);

		expect(adminConfig.APP_VERSION_OVERRIDE).toBe("2026.05-admin");
		expect(onSaveAdminConfig).toHaveBeenCalledTimes(1);
	});

	it("lets admins select an optional Reasoning Depth classifier model", async () => {
		const adminConfig = {
			REASONING_DEPTH_CLASSIFIER_MODEL: "",
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
			DEEP_RESEARCH_ENABLED: "false",
			DEEP_RESEARCH_WORKER_ENABLED: "false",
		};

		const { getByLabelText, getByText } = render(SettingsAdminSystemPane, {
			adminConfig,
			envDefaults: { REASONING_DEPTH_CLASSIFIER_MODEL: "" },
			availableModels: [
				{ id: "model1", displayName: "Model 1" },
				{ id: "provider:provider-1:classifier-1", displayName: "Classifier Mini" },
			],
			onCheckHonchoHealth: vi.fn(),
			onSaveAdminConfig: vi.fn(),
		});

		expect(getByText("Reasoning Depth classifier")).toBeInTheDocument();
		expect(getByText("Use selected chat model")).toBeInTheDocument();

		await fireEvent.change(getByLabelText("Depth classifier model"), {
			target: { value: "provider:provider-1:classifier-1" },
		});

		expect(adminConfig.REASONING_DEPTH_CLASSIFIER_MODEL).toBe(
			"provider:provider-1:classifier-1",
		);
	});

	it("lets admins publish draft System Skills", async () => {
		mockFetchAdminSystemSkills.mockResolvedValue([
			{
				id: "system:interview",
				ownership: "system",
				displayName: "Interview",
				description: "Runs a structured interview.",
				instructions: "Ask focused questions.",
				activationExamples: [],
				enabled: false,
				published: false,
				durationPolicy: "next_message",
				questionPolicy: "ask_when_needed",
				notesPolicy: "none",
				sourceScope: "selected_sources_only",
				creationSource: "system_seed",
				version: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		mockUpdateAdminSystemSkill.mockResolvedValue({
			id: "system:interview",
			ownership: "system",
			displayName: "Interview",
			published: true,
			enabled: true,
		});

		const { getByRole, getByText } = render(SettingsAdminSystemPane, {
			adminConfig: {
				COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
				MODEL_2_ENABLED: "true",
				DEEP_RESEARCH_ENABLED: "false",
				DEEP_RESEARCH_WORKER_ENABLED: "false",
			},
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onCheckHonchoHealth: vi.fn(),
			onSaveAdminConfig: vi.fn(),
		});

		await waitFor(() => {
			expect(getByText("Interview")).toBeInTheDocument();
		});

		await fireEvent.click(getByRole("button", { name: "Publish Interview" }));

		expect(mockUpdateAdminSystemSkill).toHaveBeenCalledWith("system:interview", {
			published: true,
			enabled: true,
		});
	});

});
