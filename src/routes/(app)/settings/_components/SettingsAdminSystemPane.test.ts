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

import {
	createProviderEntry,
	fetchAdminSystemSkills,
	fetchProviderList,
	fetchProviderModels,
	updateAdminConfig,
	updateAdminSystemSkill,
	updateProviderEntry,
	updateProviderModel,
} from "$lib/client/api/admin";
import {
	saveModelIconAssetCrop,
	uploadCampaignAssetSource,
	uploadModelIconAsset,
} from "$lib/client/api/campaign-assets";
import { createModelCapabilitySet } from "$lib/model-capabilities";

const mockCreateProviderEntry = createProviderEntry as ReturnType<typeof vi.fn>;
const mockFetchAdminSystemSkills = fetchAdminSystemSkills as ReturnType<
	typeof vi.fn
>;
const mockFetchProviderList = fetchProviderList as ReturnType<typeof vi.fn>;
const mockFetchProviderModels = fetchProviderModels as ReturnType<typeof vi.fn>;
const mockUpdateProviderEntry = updateProviderEntry as ReturnType<typeof vi.fn>;
const mockUpdateAdminConfig = updateAdminConfig as ReturnType<typeof vi.fn>;
const mockUpdateAdminSystemSkill = updateAdminSystemSkill as ReturnType<
	typeof vi.fn
>;
const mockUpdateProviderModel = updateProviderModel as ReturnType<typeof vi.fn>;
const mockSaveModelIconAssetCrop = saveModelIconAssetCrop as ReturnType<
	typeof vi.fn
>;
const mockUploadCampaignAssetSource = uploadCampaignAssetSource as ReturnType<
	typeof vi.fn
>;
const mockUploadModelIconAsset = uploadModelIconAsset as ReturnType<
	typeof vi.fn
>;

function _byExactTextContent(text: string) {
	return (_content: string, element: Element | null) =>
		element?.textContent?.replace(/\s+/g, " ").trim() === text;
}

function _providerFixture(overrides: Record<string, unknown> = {}) {
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
		mockFetchProviderModels.mockResolvedValue([]);
		mockUpdateProviderEntry.mockResolvedValue(undefined);
		mockUpdateAdminConfig.mockResolvedValue(undefined);
		mockUpdateProviderModel.mockResolvedValue(undefined);
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
		};

		const { getByLabelText, getByTestId } = render(SettingsAdminSystemPane, {
			adminConfig,
			envDefaults: { COMPOSER_COMMAND_REGISTRY_ENABLED: "false" },
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onSaveAdminConfig: vi.fn(),
		});

		// General is the page the screen opens on.
		await waitFor(() => {
			expect(getByTestId("system-page-general")).toBeInTheDocument();
		});

		const toggle = getByLabelText("Enable Composer Command Registry");
		await fireEvent.click(toggle);

		expect(adminConfig.COMPOSER_COMMAND_REGISTRY_ENABLED).toBe("true");
	});

	it("saves only the keys that changed, and names them in the bar", async () => {
		const onSaveAdminConfig = vi.fn();
		const adminConfig = {
			APP_VERSION_OVERRIDE: "",
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
			SYSTEM_PROMPT: "untouched",
		};

		const { getByLabelText, getByRole, getByTestId } = render(
			SettingsAdminSystemPane,
			{
				adminConfig,
				envDefaults: { APP_VERSION_OVERRIDE: "" },
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onSaveAdminConfig,
			},
		);

		// Nothing pending: the bar says so and both buttons are disabled.
		expect(getByTestId("system-save")).toBeDisabled();

		await fireEvent.input(getByLabelText("App version override"), {
			target: { value: "2026.05-admin" },
		});

		await waitFor(() => {
			expect(getByTestId("system-save-bar")).toHaveAttribute(
				"data-pending",
				"1",
			);
		});
		expect(getByTestId("system-nav-dirty-general")).toHaveTextContent("1");

		await fireEvent.click(getByRole("button", { name: "Save 1 change" }));

		expect(adminConfig.APP_VERSION_OVERRIDE).toBe("2026.05-admin");
		// The untouched keys are NOT written: an admin_config row is only created
		// for what the admin actually changed.
		expect(onSaveAdminConfig).toHaveBeenCalledTimes(1);
		expect(onSaveAdminConfig).toHaveBeenCalledWith({
			APP_VERSION_OVERRIDE: "2026.05-admin",
		});
	});

	it("discards pending edits back to what was last saved", async () => {
		const adminConfig = {
			APP_VERSION_OVERRIDE: "2026.01",
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
		};

		const { getByLabelText, getByRole, getByTestId } = render(
			SettingsAdminSystemPane,
			{
				adminConfig,
				envDefaults: {},
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onSaveAdminConfig: vi.fn(),
			},
		);

		await fireEvent.input(getByLabelText("App version override"), {
			target: { value: "wrong" },
		});
		await waitFor(() => {
			expect(getByTestId("system-save-bar")).toHaveAttribute(
				"data-pending",
				"1",
			);
		});

		await fireEvent.click(getByRole("button", { name: "Discard" }));

		expect(adminConfig.APP_VERSION_OVERRIDE).toBe("2026.01");
		await waitFor(() => {
			expect(getByTestId("system-save-bar")).toHaveAttribute(
				"data-pending",
				"0",
			);
		});
	});

	it("resets an advanced key to its default by clearing the override", async () => {
		const adminConfig = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
			TEI_EMBEDDER_BATCH_SIZE: "16",
		};

		const { getByRole, getByTestId } = render(SettingsAdminSystemPane, {
			adminConfig,
			envDefaults: { TEI_EMBEDDER_BATCH_SIZE: "8" },
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onSaveAdminConfig: vi.fn(),
		});

		await fireEvent.click(getByTestId("system-nav-advanced"));
		await waitFor(() => {
			expect(
				getByTestId("advanced-row-TEI_EMBEDDER_BATCH_SIZE"),
			).toBeInTheDocument();
		});

		await fireEvent.click(
			getByRole("button", {
				name: "Reset Texts per embed call to its default",
			}),
		);

		// PUT treats an empty value as "delete the override", which is exactly
		// what resetting to the default means.
		expect(adminConfig.TEI_EMBEDDER_BATCH_SIZE).toBe("");
	});

	it("refuses to save a value outside the bounds the server would clamp", async () => {
		const onSaveAdminConfig = vi.fn();
		const adminConfig = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
			ATLAS_V2_ENTAILMENT_BATCH: "10",
		};

		const { getByLabelText, getByTestId } = render(SettingsAdminSystemPane, {
			adminConfig,
			envDefaults: { ATLAS_V2_ENTAILMENT_BATCH: "10" },
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onSaveAdminConfig,
		});

		await fireEvent.click(getByTestId("system-nav-advanced"));
		await waitFor(() => {
			expect(
				getByTestId("advanced-row-ATLAS_V2_ENTAILMENT_BATCH"),
			).toBeInTheDocument();
		});

		await fireEvent.input(getByLabelText("Claims per entailment call"), {
			target: { value: "900" },
		});

		await waitFor(() => {
			expect(getByTestId("system-save")).toBeDisabled();
		});
		expect(onSaveAdminConfig).not.toHaveBeenCalled();
	});

	it("renders and edits all Atlas runtime settings", async () => {
		const adminConfig = {
			ATLAS_WORKER_ENABLED: "true",
			ATLAS_GLOBAL_ACTIVE_LIMIT: "2",
			ATLAS_SEARCH_CONCURRENCY: "3",
			ATLAS_SEARCH_BATCH_DELAY_MS: "500",
			ATLAS_SYNTHESIS_MODEL: "model1",
			ATLAS_AUDIT_MODEL: "model2",
			WEB_PUSH_VAPID_PUBLIC_KEY: "public-key",
			WEB_PUSH_VAPID_PRIVATE_KEY: "[set]",
			WEB_PUSH_VAPID_SUBJECT: "mailto:admin@example.com",
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
		};

		const { getByLabelText, getByRole, getByTestId, getByText } = render(
			SettingsAdminSystemPane,
			{
				adminConfig,
				envDefaults: {
					ATLAS_WORKER_ENABLED: "true",
					ATLAS_GLOBAL_ACTIVE_LIMIT: "2",
					ATLAS_SEARCH_CONCURRENCY: "3",
					ATLAS_SEARCH_BATCH_DELAY_MS: "500",
					ATLAS_SYNTHESIS_MODEL: "model1",
					ATLAS_AUDIT_MODEL: "model2",
					WEB_PUSH_VAPID_PUBLIC_KEY: "",
					WEB_PUSH_VAPID_PRIVATE_KEY: "",
					WEB_PUSH_VAPID_SUBJECT: "mailto:admin@localhost",
				},
				availableModels: [
					{ id: "model1", displayName: "Model 1" },
					{ id: "model2", displayName: "Model 2" },
					{
						id: "provider:provider-1:atlas-synthesis",
						displayName: "Atlas Synthesis",
					},
					{
						id: "provider:provider-1:atlas-audit",
						displayName: "Atlas Audit",
					},
				],
				onSaveAdminConfig: vi.fn(),
			},
		);

		await fireEvent.click(getByTestId("system-nav-aiTasks"));
		await waitFor(() => {
			expect(getByTestId("system-atlas-card")).toBeInTheDocument();
		});
		expect(getByText("Atlas research reports")).toBeInTheDocument();

		await fireEvent.click(getByLabelText("Enable Atlas Worker"));

		// The worker's own limits and the two Atlas models are on the same card,
		// one tab across.
		await fireEvent.click(getByRole("tab", { name: "Worker & limits" }));
		expect(
			getByText(/Atlas also requires a Parallel API Key in Web Research/),
		).toBeInTheDocument();

		await fireEvent.change(getByLabelText("Atlas Synthesis Model"), {
			target: { value: "provider:provider-1:atlas-synthesis" },
		});
		await fireEvent.change(getByLabelText("Atlas Audit Model"), {
			target: { value: "provider:provider-1:atlas-audit" },
		});
		await fireEvent.input(getByLabelText("Global Active Atlas Limit"), {
			target: { value: "4" },
		});
		await fireEvent.input(getByLabelText("Search Concurrency"), {
			target: { value: "5" },
		});
		await fireEvent.input(getByLabelText("Search Batch Delay (ms)"), {
			target: { value: "250" },
		});

		expect(adminConfig.ATLAS_WORKER_ENABLED).toBe("false");
		expect(adminConfig.ATLAS_SYNTHESIS_MODEL).toBe(
			"provider:provider-1:atlas-synthesis",
		);
		expect(adminConfig.ATLAS_AUDIT_MODEL).toBe(
			"provider:provider-1:atlas-audit",
		);
		expect(adminConfig.ATLAS_GLOBAL_ACTIVE_LIMIT).toBe("4");
		expect(adminConfig.ATLAS_SEARCH_CONCURRENCY).toBe("5");
		expect(adminConfig.ATLAS_SEARCH_BATCH_DELAY_MS).toBe("250");

		// The Web-Push keys are no longer on the Atlas card: they are secrets, so
		// they live with the other secrets on Integrations & keys.
		await fireEvent.click(getByTestId("system-nav-integrations"));
		await waitFor(() => {
			expect(getByTestId("system-page-integrations")).toBeInTheDocument();
		});
		await fireEvent.input(getByLabelText("Web Push VAPID Public Key"), {
			target: { value: "new-public-key" },
		});
		await fireEvent.input(getByLabelText("Web Push VAPID Subject"), {
			target: { value: "mailto:ops@example.com" },
		});
		expect(adminConfig.WEB_PUSH_VAPID_PUBLIC_KEY).toBe("new-public-key");
		expect(adminConfig.WEB_PUSH_VAPID_SUBJECT).toBe("mailto:ops@example.com");

		// A masked secret is replaced through the write-only field, never by
		// editing the "[set]" sentinel in place.
		await fireEvent.click(getByRole("button", { name: "Replace" }));
		await fireEvent.input(
			getByLabelText("New value for Web Push VAPID Private Key"),
			{ target: { value: "new-private-key" } },
		);
		expect(adminConfig.WEB_PUSH_VAPID_PRIVATE_KEY).toBe("new-private-key");
	});

	it("binds every Atlas v3 per-task model, and the pipeline selector", async () => {
		const adminConfig: Record<string, string> = {
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
			ATLAS_SYNTHESIS_MODEL: "model1",
			ATLAS_AUDIT_MODEL: "model2",
			ATLAS_PIPELINE: "v2",
		};

		const { getByLabelText, getByRole, getByTestId } = render(
			SettingsAdminSystemPane,
			{
				adminConfig,
				envDefaults: { ATLAS_PIPELINE: "v1" },
				availableModels: [
					{ id: "model1", displayName: "Model 1" },
					{ id: "model2", displayName: "Model 2" },
				],
				onSaveAdminConfig: vi.fn(),
			},
		);

		await fireEvent.click(getByTestId("system-nav-aiTasks"));
		await waitFor(() => {
			expect(getByTestId("system-atlas-card")).toBeInTheDocument();
		});

		for (const [label, key] of [
			["Ask", "ATLAS_V3_ASK_MODEL"],
			["Researcher", "ATLAS_V3_RESEARCHER_MODEL"],
			["Outline", "ATLAS_V3_OUTLINE_MODEL"],
			["Writer", "ATLAS_V3_WRITER_MODEL"],
			["Critic", "ATLAS_V3_CRITIC_MODEL"],
			["Verifier", "ATLAS_V3_VERIFIER_MODEL"],
		] as const) {
			const select = getByLabelText(label) as HTMLSelectElement;
			// Left alone, a task inherits the Atlas model its shape belongs to.
			expect(select.value).toBe("");
			expect(select.options[0].textContent).toContain("Inherit");
			await fireEvent.change(select, { target: { value: "model2" } });
			expect(adminConfig[key]).toBe("model2");
		}

		// Research depth: the v3 knobs, with the bounds the server clamps to.
		await fireEvent.click(getByRole("tab", { name: "Research depth" }));
		await fireEvent.input(getByLabelText("Critic rounds"), {
			target: { value: "3" },
		});
		await fireEvent.input(getByLabelText("Searches per step"), {
			target: { value: "5" },
		});
		expect(adminConfig.ATLAS_V3_CRITIC_ROUNDS).toBe("3");
		expect(adminConfig.ATLAS_V3_SEARCHES_PER_STEP).toBe("5");

		// All three pipelines are real, and v3 is selectable.
		await fireEvent.click(getByRole("tab", { name: "Pipeline" }));
		expect(getByTestId("atlas-pipeline-v2")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await fireEvent.click(getByTestId("atlas-pipeline-v3"));
		expect(adminConfig.ATLAS_PIPELINE).toBe("v3");
	});

	it("renders the Parallel and Brave search keys without legacy search controls", async () => {
		const adminConfig = {
			PARALLEL_API_KEY: "",
			BRAVE_SEARCH_API_KEY: "",
			COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			MODEL_2_ENABLED: "true",
		};

		const { getAllByRole, getByLabelText, getByTestId, queryByLabelText } =
			render(SettingsAdminSystemPane, {
				adminConfig,
				envDefaults: {
					PARALLEL_API_KEY: "",
					BRAVE_SEARCH_API_KEY: "",
				},
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onSaveAdminConfig: vi.fn(),
			});

		await fireEvent.click(getByTestId("system-nav-integrations"));
		await waitFor(() => {
			expect(getByTestId("system-page-integrations")).toBeInTheDocument();
		});

		// Unset keys offer "Add key" rather than a password box with no state.
		const addButtons = getAllByRole("button", { name: "Add key" });
		expect(addButtons.length).toBeGreaterThanOrEqual(2);
		await fireEvent.click(addButtons[0]);
		await fireEvent.input(getByLabelText("New value for Parallel API Key"), {
			target: { value: "parallel-key" },
		});
		expect(adminConfig.PARALLEL_API_KEY).toBe("parallel-key");

		expect(queryByLabelText("Max Returned Sources")).toBeNull();
		expect(queryByLabelText("Page Extractor Mode")).toBeNull();
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

		const { getByRole, getByTestId, getByText } = render(
			SettingsAdminSystemPane,
			{
				adminConfig: {
					COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
					MODEL_2_ENABLED: "true",
				},
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onSaveAdminConfig: vi.fn(),
			},
		);

		await fireEvent.click(getByTestId("system-nav-skills"));
		await waitFor(() => {
			expect(getByText("Interview")).toBeInTheDocument();
		});

		await fireEvent.click(
			getByRole("button", { name: "More actions for Interview" }),
		);
		await fireEvent.click(getByRole("menuitem", { name: "Publish Interview" }));

		expect(mockUpdateAdminSystemSkill).toHaveBeenCalledWith(
			"system:interview",
			{
				published: true,
				enabled: true,
			},
		);
	});

	it("surfaces the four skill policies the old form posted as silent defaults", async () => {
		mockFetchAdminSystemSkills.mockResolvedValue([]);

		const { getByLabelText, getByRole, getByTestId } = render(
			SettingsAdminSystemPane,
			{
				adminConfig: {
					COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
					MODEL_2_ENABLED: "true",
				},
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onSaveAdminConfig: vi.fn(),
			},
		);

		await fireEvent.click(getByTestId("system-nav-skills"));
		await fireEvent.click(getByRole("button", { name: "New skill" }));

		await waitFor(() => {
			expect(getByLabelText("Duration policy")).toBeInTheDocument();
		});
		expect(getByLabelText("Question policy")).toBeInTheDocument();
		expect(getByLabelText("Notes policy")).toBeInTheDocument();
		expect(getByLabelText("Source scope")).toBeInTheDocument();
	});
});
