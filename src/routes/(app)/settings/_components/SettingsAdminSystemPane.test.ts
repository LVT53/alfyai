import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsAdminSystemPane from "./SettingsAdminSystemPane.svelte";

vi.mock("$lib/client/api/admin", () => ({
	createAdminSystemSkill: vi.fn(),
	createProvider: vi.fn(),
	deleteProvider: vi.fn(),
	fetchAdminSystemSkills: vi.fn(() => Promise.resolve([])),
	fetchPersonalityProfiles: vi.fn(() => Promise.resolve([])),
	fetchProviders: vi.fn(() => Promise.resolve([])),
	updateAdminConfig: vi.fn(),
	updateAdminSystemSkill: vi.fn(),
	updateProvider: vi.fn(),
	validateProvider: vi.fn(),
}));

vi.mock("$lib/client/api/campaign-assets", () => ({
	saveModelIconAssetCrop: vi.fn(),
	uploadCampaignAssetSource: vi.fn(),
	uploadModelIconAsset: vi.fn(),
}));

import {
	createProvider,
	fetchAdminSystemSkills,
	fetchProviders,
	updateProvider,
	updateAdminConfig,
	updateAdminSystemSkill,
} from "$lib/client/api/admin";
import {
	saveModelIconAssetCrop,
	uploadCampaignAssetSource,
	uploadModelIconAsset,
} from "$lib/client/api/campaign-assets";
import { createModelCapabilitySet } from "$lib/model-capabilities";

const mockCreateProvider = createProvider as ReturnType<typeof vi.fn>;
const mockFetchAdminSystemSkills = fetchAdminSystemSkills as ReturnType<typeof vi.fn>;
const mockFetchProviders = fetchProviders as ReturnType<typeof vi.fn>;
const mockUpdateProvider = updateProvider as ReturnType<typeof vi.fn>;
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
		mockCreateProvider.mockResolvedValue({
			id: "provider-1",
			name: "fireworks-ai",
			displayName: "Fireworks AI",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/models/kimi-k2",
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
		mockFetchProviders.mockResolvedValue([]);
		mockUpdateProvider.mockResolvedValue(undefined);
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

	it("lets admins configure a rate-limit fallback when creating a provider", async () => {
		const { getByLabelText, getByRole, getByText } = render(SettingsAdminSystemPane, {
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
			expect(getByText("Add Provider")).toBeInTheDocument();
		});

		await fireEvent.click(getByText("Add Provider"));
		await fireEvent.input(getByLabelText("Name (ID)"), {
			target: { value: "fireworks-ai" },
		});
		await fireEvent.input(getByLabelText("Display Name"), {
			target: { value: "Fireworks AI" },
		});
		await fireEvent.input(getByLabelText("Base URL"), {
			target: { value: "https://api.fireworks.ai/inference/v1" },
		});
		await fireEvent.input(getByLabelText("API Key"), {
			target: { value: "primary-key" },
		});
		await fireEvent.input(getByLabelText("Model Name"), {
			target: { value: "accounts/fireworks/models/kimi-k2" },
		});
		await fireEvent.input(getByLabelText("Max Model Context (tokens)"), {
			target: { value: "262144" },
		});

		await fireEvent.click(getByLabelText("Enable rate-limit fallback"));
		await fireEvent.input(getByLabelText("Fallback Base URL"), {
			target: { value: "https://fallback.example/v1" },
		});
		await fireEvent.input(getByLabelText("Fallback API Key"), {
			target: { value: "fallback-key" },
		});
		await fireEvent.input(getByLabelText("Fallback Model Name"), {
			target: { value: "fallback-model" },
		});
		await fireEvent.input(getByLabelText("Fallback Timeout (ms)"), {
			target: { value: "45000" },
		});

		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		await waitFor(() => {
			expect(mockCreateProvider).toHaveBeenCalledWith(
				expect.objectContaining({
					rateLimitFallbackEnabled: true,
					rateLimitFallbackBaseUrl: "https://fallback.example/v1",
					rateLimitFallbackApiKey: "fallback-key",
					rateLimitFallbackModelName: "fallback-model",
					rateLimitFallbackTimeoutMs: 45000,
				}),
			);
		});
	});

	it("lets admins choose an enabled provider as the default model for new users", async () => {
		mockFetchProviders.mockResolvedValue([
			{
				id: "fire-pass",
				name: "fire_pass",
				displayName: "Fire Pass",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
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
			},
		]);
		const adminConfig = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			DEFAULT_NEW_USER_MODEL: "model1",
			MODEL_2_ENABLED: "true",
			DEEP_RESEARCH_ENABLED: "false",
			DEEP_RESEARCH_WORKER_ENABLED: "false",
		};

		const { getAllByText, getByLabelText } = render(SettingsAdminSystemPane, {
			adminConfig,
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onCheckHonchoHealth: vi.fn(),
			onSaveAdminConfig: vi.fn(),
		});

		await waitFor(() => {
			expect(getAllByText("Fire Pass").length).toBeGreaterThan(0);
		});

		await fireEvent.change(getByLabelText("Default model for new users"), {
			target: { value: "provider:fire-pass" },
		});

		expect(adminConfig.DEFAULT_NEW_USER_MODEL).toBe("provider:fire-pass");
	});

	it("shows probed provider capabilities in provider rows", async () => {
		mockFetchProviders.mockResolvedValue([
			providerFixture({
				displayName: "Capability Probe",
				capabilities: createModelCapabilitySet({
					tools: { state: "detected", source: "probe" },
					structuredOutput: { state: "not_detected", source: "probe" },
					usageReporting: { state: "unknown", source: "probe" },
					reasoningControls: {
						state: "manual_override",
						supported: true,
						source: "manual_override",
					},
				}),
			}),
		]);

		const { getAllByText, getByLabelText } = render(SettingsAdminSystemPane, {
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
			expect(getAllByText("Capability Probe").length).toBeGreaterThan(0);
		});

		expect(getByLabelText("Tools: Detected")).toHaveTextContent("Tools Detected");
		expect(getByLabelText("Structured output: Not detected")).toHaveTextContent(
			"Structured output Not detected",
		);
		expect(getByLabelText("Usage: Unknown")).toHaveTextContent("Usage Unknown");
		expect(
			getByLabelText("Reasoning: Manual override: supported"),
		).toHaveTextContent("Reasoning Manual override: supported");
		expect(getAllByText(byExactTextContent("Tools Detected")).length).toBe(1);
	});

	it("crops raster model icon uploads and clears the uploading label after save", async () => {
		const adminConfig = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_1_ICON_ASSET_ID: "",
			MODEL_2_ENABLED: "true",
			DEEP_RESEARCH_ENABLED: "false",
			DEEP_RESEARCH_WORKER_ENABLED: "false",
		};
		const {
			container,
			getAllByLabelText,
			getAllByRole,
			getByRole,
			getByText,
			queryByText,
		} = render(SettingsAdminSystemPane, {
			adminConfig,
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onCheckHonchoHealth: vi.fn(),
			onSaveAdminConfig: vi.fn(),
		});

		await waitFor(() => {
			expect(getAllByRole("button", { name: "Edit" }).length).toBeGreaterThan(
				0,
			);
		});
		await fireEvent.click(getAllByRole("button", { name: "Edit" })[0]);
		await waitFor(() => {
			expect(getAllByLabelText("Upload icon").length).toBeGreaterThan(0);
		});

		await fireEvent.change(getAllByLabelText("Upload icon")[0], {
			target: {
				files: [new File(["png"], "wide-icon.png", { type: "image/png" })],
			},
		});

		await waitFor(() => {
			expect(getByText("Crop model icon")).toBeInTheDocument();
		});
		expect(mockUploadCampaignAssetSource).toHaveBeenCalledWith({
			image: expect.any(File),
		});
		expect(mockUploadModelIconAsset).not.toHaveBeenCalled();

		const cropImage = container.querySelector(
			".crop-frame img",
		) as HTMLImageElement | null;
		expect(cropImage).not.toBeNull();
		Object.defineProperty(cropImage, "naturalWidth", {
			value: 1200,
			configurable: true,
		});
		Object.defineProperty(cropImage, "naturalHeight", {
			value: 800,
			configurable: true,
		});
		await fireEvent.load(cropImage as HTMLImageElement);

		await fireEvent.click(getByRole("button", { name: "Save crop" }));

		await waitFor(() => {
			expect(mockSaveModelIconAssetCrop).toHaveBeenCalledWith({
				sourceAssetId: "source-1",
				crop: expect.any(Object),
				image: expect.any(File),
				width: 512,
				height: 512,
			});
		});
		expect(mockUpdateAdminConfig).toHaveBeenCalledWith({
			MODEL_1_ICON_ASSET_ID: "icon-crop-1",
		});
		expect(adminConfig.MODEL_1_ICON_ASSET_ID).toBe("icon-crop-1");
		await waitFor(() => {
			expect(queryByText("Uploading...")).not.toBeInTheDocument();
		});
	});

	it("stores SVG model icons directly without opening the cropper", async () => {
		const adminConfig = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_1_ICON_ASSET_ID: "",
			MODEL_2_ENABLED: "true",
			DEEP_RESEARCH_ENABLED: "false",
			DEEP_RESEARCH_WORKER_ENABLED: "false",
		};
		const { getAllByLabelText, getAllByRole, queryByText } = render(
			SettingsAdminSystemPane,
			{
				adminConfig,
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onCheckHonchoHealth: vi.fn(),
				onSaveAdminConfig: vi.fn(),
			},
		);

		await waitFor(() => {
			expect(getAllByRole("button", { name: "Edit" }).length).toBeGreaterThan(
				0,
			);
		});
		await fireEvent.click(getAllByRole("button", { name: "Edit" })[0]);
		await waitFor(() => {
			expect(getAllByLabelText("Upload icon").length).toBeGreaterThan(0);
		});

		await fireEvent.change(getAllByLabelText("Upload icon")[0], {
			target: {
				files: [new File(["<svg></svg>"], "icon.svg", { type: "image/svg+xml" })],
			},
		});

		await waitFor(() => {
			expect(mockUploadModelIconAsset).toHaveBeenCalledWith({
				image: expect.any(File),
			});
		});
		expect(mockUpdateAdminConfig).toHaveBeenCalledWith({ MODEL_1_ICON_ASSET_ID: "icon-1" });
		expect(adminConfig.MODEL_1_ICON_ASSET_ID).toBe("icon-1");
		expect(mockUploadCampaignAssetSource).not.toHaveBeenCalled();
		expect(queryByText("Crop model icon")).not.toBeInTheDocument();
	});

	it("routes provider icon uploads by provider id instead of display slug", async () => {
		mockFetchProviders.mockResolvedValue([
			providerFixture({ id: "provider-1", name: "firepass" }),
		]);
		const { getAllByLabelText, getAllByRole } = render(
			SettingsAdminSystemPane,
			{
				adminConfig: {
					COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
					MODEL_2_ENABLED: "true",
					DEEP_RESEARCH_ENABLED: "false",
					DEEP_RESEARCH_WORKER_ENABLED: "false",
				},
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onCheckHonchoHealth: vi.fn(),
				onSaveAdminConfig: vi.fn(),
			},
		);

		await waitFor(() => {
			expect(getAllByRole("button", { name: "Edit" }).length).toBeGreaterThan(
				2,
			);
		});
		await fireEvent.click(getAllByRole("button", { name: "Edit" })[2]);
		await waitFor(() => {
			expect(getAllByLabelText("Upload icon").length).toBeGreaterThan(0);
		});

		await fireEvent.change(getAllByLabelText("Upload icon")[0], {
			target: {
				files: [
					new File(["<svg></svg>"], "provider.svg", {
						type: "image/svg+xml",
					}),
				],
			},
		});

		await waitFor(() => {
			expect(mockUpdateProvider).toHaveBeenCalledWith("provider-1", {
				iconAssetId: "icon-1",
			});
		});
	});
});
