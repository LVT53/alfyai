import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
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

vi.mock("$lib/client/api/campaign-assets", () => ({
	saveModelIconAssetCrop: vi.fn(),
	uploadCampaignAssetSource: vi.fn(),
	uploadModelIconAsset: vi.fn(),
}));

vi.mock("$lib/client/api/admin-system-health", () => ({
	fetchAdminEffectiveConfig: vi.fn(),
	fetchAdminToolHealth: vi.fn(),
}));

import {
	type EffectiveConfigReport,
	fetchAdminEffectiveConfig,
	fetchAdminToolHealth,
	type ToolHealthSnapshot,
} from "$lib/client/api/admin-system-health";

const mockFetchToolHealth = fetchAdminToolHealth as ReturnType<typeof vi.fn>;
const mockFetchEffectiveConfig = fetchAdminEffectiveConfig as ReturnType<
	typeof vi.fn
>;

function snapshotFixture(): ToolHealthSnapshot {
	const checkedAt = "2026-09-05T10:00:00.000Z";
	return {
		checkedAt,
		durationMs: 42,
		tools: [
			{
				id: "research_web",
				tool: "research_web",
				backend: "Parallel API",
				status: "healthy",
				configured: true,
				probed: true,
				latencyMs: 120,
				detail: "reachable, key accepted (HTTP 400)",
				connectedConnections: null,
				checkedAt,
				degradedSince: null,
			},
			{
				id: "image_search",
				tool: "image_search",
				backend: "Brave Search",
				status: "degraded",
				configured: true,
				probed: true,
				latencyMs: 5000,
				detail: "timed out after 5000ms",
				connectedConnections: null,
				checkedAt,
				degradedSince: checkedAt,
			},
			{
				id: "map_route",
				tool: "map_route",
				backend: "OpenRouteService",
				status: "unconfigured",
				configured: false,
				probed: false,
				latencyMs: null,
				detail: "not configured",
				connectedConnections: null,
				checkedAt,
				degradedSince: null,
			},
		],
	};
}

function effectiveConfigFixture(): EffectiveConfigReport {
	return {
		generatedAt: "2026-09-05T10:00:00.000Z",
		entries: [
			{
				key: "PARALLEL_API_KEY",
				envValue: "[set]",
				adminOverride: null,
				effectiveValue: "[set]",
				source: "env",
				secret: true,
			},
			{
				key: "MODEL_1_NAME",
				envValue: "env-model",
				adminOverride: "override-model",
				effectiveValue: "override-model",
				source: "admin_config",
				secret: false,
			},
			{
				key: "ORS_BASE_URL",
				envValue: "",
				adminOverride: null,
				effectiveValue: "",
				source: "default",
				secret: false,
			},
		] as EffectiveConfigReport["entries"],
		models: [
			{
				key: "model1",
				providerRowFound: true,
				providerEnabled: true,
				resolvedModelId: "provider-model",
				resolvedModelName: "provider-model",
				resolvedBaseUrl: "https://provider.example/v1",
				resolvedFrom: "providers_table",
				shadowedOverrides: ["MODEL_1_NAME"],
				error: null,
			},
			{
				key: "model2",
				providerRowFound: false,
				providerEnabled: false,
				resolvedModelId: "model2",
				resolvedModelName: "env-model-2",
				resolvedBaseUrl: "https://env.example/v1",
				resolvedFrom: "admin_config_env",
				shadowedOverrides: [],
				error: null,
			},
		],
	};
}

function renderPane() {
	return render(SettingsAdminSystemPane, {
		adminConfig: { MODEL_2_ENABLED: "true" },
		envDefaults: {},
		availableModels: [{ id: "model1", displayName: "Model 1" }],
		onSaveAdminConfig: vi.fn(),
	});
}

describe("SettingsAdminSystemPane system health sections", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchToolHealth.mockResolvedValue(snapshotFixture());
		mockFetchEffectiveConfig.mockResolvedValue(effectiveConfigFixture());
	});

	it("renders the tool health table with status pills, latency and detail", async () => {
		const { getByTestId } = renderPane();

		await waitFor(() => {
			expect(getByTestId("tool-health-table")).toBeInTheDocument();
		});
		expect(mockFetchToolHealth).toHaveBeenCalledWith({ refresh: false });

		const healthy = within(getByTestId("tool-health-row-research_web"));
		expect(healthy.getByText("Healthy")).toBeInTheDocument();
		expect(healthy.getByText("Parallel API")).toBeInTheDocument();
		expect(healthy.getByText("120 ms")).toBeInTheDocument();
		expect(
			healthy.getByText("reachable, key accepted (HTTP 400)"),
		).toBeInTheDocument();

		const degraded = within(getByTestId("tool-health-row-image_search"));
		expect(degraded.getByText("Degraded")).toHaveAttribute(
			"data-status",
			"degraded",
		);

		const unconfigured = within(getByTestId("tool-health-row-map_route"));
		expect(unconfigured.getByText("Not configured")).toBeInTheDocument();
		expect(unconfigured.getByText("—")).toBeInTheDocument();
	});

	it("forces a fresh probe run from the refresh button", async () => {
		const { getByTestId } = renderPane();
		await waitFor(() => {
			expect(getByTestId("tool-health-table")).toBeInTheDocument();
		});

		const section = within(getByTestId("tool-health-section"));
		await fireEvent.click(section.getByRole("button", { name: "Refresh" }));

		await waitFor(() => {
			expect(mockFetchToolHealth).toHaveBeenLastCalledWith({ refresh: true });
		});
	});

	it("shows an error when tool health cannot be loaded", async () => {
		mockFetchToolHealth.mockRejectedValueOnce(new Error("Forbidden"));
		const { getByTestId } = renderPane();

		await waitFor(() => {
			expect(
				within(getByTestId("tool-health-section")).getByRole("alert"),
			).toHaveTextContent("Forbidden");
		});
	});

	it("renders the effective configuration table with masked secrets and sources", async () => {
		const { getByTestId } = renderPane();

		await waitFor(() => {
			expect(getByTestId("effective-config-table")).toBeInTheDocument();
		});

		const secret = within(getByTestId("effective-config-row-PARALLEL_API_KEY"));
		expect(secret.getByText("[set]")).toBeInTheDocument();
		expect(secret.getByText("environment")).toHaveAttribute(
			"data-source",
			"env",
		);

		const override = within(getByTestId("effective-config-row-MODEL_1_NAME"));
		expect(override.getByText("admin override")).toBeInTheDocument();
		expect(override.getAllByText("override-model")).toHaveLength(2);

		const unset = within(getByTestId("effective-config-row-ORS_BASE_URL"));
		expect(unset.getByText("not set")).toBeInTheDocument();
		expect(unset.getByText("default")).toBeInTheDocument();

		const model1 = getByTestId("effective-config-model-model1");
		expect(model1).toHaveTextContent("providers row enabled");
		expect(model1).toHaveTextContent("resolved from the providers table");
		expect(model1).toHaveTextContent("resolves to provider-model");
		expect(model1).toHaveTextContent("Shadowed admin overrides: MODEL_1_NAME");

		const model2 = getByTestId("effective-config-model-model2");
		expect(model2).toHaveTextContent("no providers row");
		expect(model2).toHaveTextContent("resolved from admin config / env");
	});

	it("filters effective configuration rows by key or value", async () => {
		const { getByTestId, getByLabelText, queryByTestId, getByText } =
			renderPane();
		await waitFor(() => {
			expect(getByTestId("effective-config-table")).toBeInTheDocument();
		});

		const filter = getByLabelText("Filter configuration keys");
		await fireEvent.input(filter, { target: { value: "ors_" } });

		await waitFor(() => {
			expect(
				getByTestId("effective-config-row-ORS_BASE_URL"),
			).toBeInTheDocument();
			expect(queryByTestId("effective-config-row-MODEL_1_NAME")).toBeNull();
		});

		await fireEvent.input(filter, { target: { value: "override-model" } });
		await waitFor(() => {
			expect(
				getByTestId("effective-config-row-MODEL_1_NAME"),
			).toBeInTheDocument();
			expect(queryByTestId("effective-config-row-ORS_BASE_URL")).toBeNull();
		});

		await fireEvent.input(filter, { target: { value: "no-such-key" } });
		await waitFor(() => {
			expect(
				getByText("No configuration keys match the filter."),
			).toBeInTheDocument();
		});
	});
});
