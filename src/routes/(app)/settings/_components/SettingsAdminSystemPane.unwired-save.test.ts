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

// PUT /api/admin/config refuses a key marked `effect: "unwired"`, and it
// validates the WHOLE patch before writing any of it. So one inert key riding
// along in a save would take every other edit in that save down with it: the
// admin changes five real settings, presses Save and none of them land.
//
// The row's control is disabled, but that is markup. This is the guarantee.
describe("SettingsAdminSystemPane — inert keys and the save payload", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("never counts one as an unsaved change", async () => {
		// `adminConfigSaved` is the baseline "unsaved" is measured against.
		// Handing over a baseline that disagrees with the current values is the
		// only way an inert key can come out dirty — a disabled field cannot
		// be typed into — and it must still read as nothing pending.
		const { getByTestId } = render(SettingsAdminSystemPane, {
			adminConfig: {
				COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
				MODEL_2_ENABLED: "true",
				TEI_RERANKER_MODEL: "bge-reranker-v2-m3",
				FILE_PRODUCTION_SANDBOX_TIMEOUT_MS: "120000",
				WORKING_SET_PROMPT_TOKEN_BUDGET: "999",
			},
			adminConfigSaved: {
				COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
				MODEL_2_ENABLED: "true",
				TEI_RERANKER_MODEL: "",
				FILE_PRODUCTION_SANDBOX_TIMEOUT_MS: "300000",
				WORKING_SET_PROMPT_TOKEN_BUDGET: "20000",
			},
			envDefaults: {},
			availableModels: [{ id: "model1", displayName: "Model 1" }],
			onSaveAdminConfig: vi.fn(),
		});

		await waitFor(() => {
			expect(getByTestId("system-save-bar")).toHaveAttribute(
				"data-pending",
				"0",
			);
		});
		expect(getByTestId("system-save")).toBeDisabled();
	});

	it("sends the real edit and nothing else when both are pending", async () => {
		const onSaveAdminConfig = vi.fn();
		const { getByLabelText, getByRole, getByTestId } = render(
			SettingsAdminSystemPane,
			{
				adminConfig: {
					APP_VERSION_OVERRIDE: "",
					COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
					MODEL_2_ENABLED: "true",
					TEI_RERANKER_MODEL: "bge-reranker-v2-m3",
				},
				adminConfigSaved: {
					APP_VERSION_OVERRIDE: "",
					COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
					MODEL_2_ENABLED: "true",
					// Differs, so without the filter this key would be dirty and
					// would join the patch — and sink it.
					TEI_RERANKER_MODEL: "",
				},
				envDefaults: { APP_VERSION_OVERRIDE: "" },
				availableModels: [{ id: "model1", displayName: "Model 1" }],
				onSaveAdminConfig,
			},
		);

		await fireEvent.input(getByLabelText("App version override"), {
			target: { value: "2026.05-admin" },
		});
		await waitFor(() => {
			expect(getByTestId("system-save-bar")).toHaveAttribute(
				"data-pending",
				"1",
			);
		});

		await fireEvent.click(getByRole("button", { name: "Save 1 change" }));

		expect(onSaveAdminConfig).toHaveBeenCalledTimes(1);
		expect(onSaveAdminConfig).toHaveBeenCalledWith({
			APP_VERSION_OVERRIDE: "2026.05-admin",
		});
	});
});
