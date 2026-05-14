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
	updateAdminSystemSkill: vi.fn(),
	updateProvider: vi.fn(),
	validateProvider: vi.fn(),
}));

import {
	fetchAdminSystemSkills,
	updateAdminSystemSkill,
} from "$lib/client/api/admin";

const mockFetchAdminSystemSkills = fetchAdminSystemSkills as ReturnType<typeof vi.fn>;
const mockUpdateAdminSystemSkill = updateAdminSystemSkill as ReturnType<typeof vi.fn>;

describe("SettingsAdminSystemPane", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchAdminSystemSkills.mockResolvedValue([]);
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
