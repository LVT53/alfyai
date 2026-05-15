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
	createProvider,
	fetchAdminSystemSkills,
	fetchProviders,
	updateAdminSystemSkill,
} from "$lib/client/api/admin";

const mockCreateProvider = createProvider as ReturnType<typeof vi.fn>;
const mockFetchAdminSystemSkills = fetchAdminSystemSkills as ReturnType<typeof vi.fn>;
const mockFetchProviders = fetchProviders as ReturnType<typeof vi.fn>;
const mockUpdateAdminSystemSkill = updateAdminSystemSkill as ReturnType<typeof vi.fn>;

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
});
