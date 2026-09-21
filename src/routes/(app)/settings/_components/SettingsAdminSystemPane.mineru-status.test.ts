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

vi.mock("$lib/client/api/campaign-assets", () => ({
	saveModelIconAssetCrop: vi.fn(),
	uploadCampaignAssetSource: vi.fn(),
	uploadModelIconAsset: vi.fn(),
}));

vi.mock("$lib/client/api/admin-system-health", () => ({
	fetchAdminConfigOverrideMeta: vi.fn(() => Promise.resolve({})),
	fetchAdminEffectiveConfig: vi.fn(() => Promise.resolve(null)),
	fetchAdminMineruStatus: vi.fn(),
	fetchAdminToolHealth: vi.fn(),
	validateProviderConnection: vi.fn(() => Promise.resolve({ valid: true })),
}));

import {
	fetchAdminMineruStatus,
	type MineruStatusReport,
} from "$lib/client/api/admin-system-health";

const mockFetchMineruStatus = fetchAdminMineruStatus as ReturnType<
	typeof vi.fn
>;

function reachableReport(
	overrides: Partial<MineruStatusReport> = {},
): MineruStatusReport {
	return {
		checkedAt: "2026-09-20T10:00:00.000Z",
		baseUrl: "http://127.0.0.1:8001",
		reachable: true,
		version: "4.0.4",
		webhook: false,
		outputFormats: ["markdown", "middle_json", "structured_content", "zip"],
		sources: ["file_id", "url", "inline"],
		tiers: [
			{
				id: "flash",
				description: "Fast local text extraction.",
				currentModel: "flash",
			},
			{
				id: "basic",
				description: "Basic parsing with local lightweight models.",
				currentModel: "hybrid-basic",
			},
		],
		accessLevel: "anonymous",
		limits: {
			maxFileSizeBytes: 209715200,
			maxPagesPerFile: 1000,
			maxFilesPerJob: 100,
			maxConcurrentJobs: 1,
		},
		error: null,
		cached: false,
		...overrides,
	};
}

function renderPane(adminConfig: Record<string, string> = {}) {
	return render(SettingsAdminSystemPane, {
		adminConfig: { MODEL_2_ENABLED: "true", ...adminConfig },
		envDefaults: {
			MINERU_API_URL: "http://127.0.0.1:8001",
			MINERU_DEFAULT_TIER: "auto",
			MINERU_OCR_MODE: "auto",
			MINERU_JOB_TIMEOUT_MS: "300000",
			MINERU_STRUCTURE_CHUNKING_ENABLED: "true",
		},
		availableModels: [{ id: "model1", displayName: "Model 1" }],
		onSaveAdminConfig: vi.fn(),
	});
}

async function openIntegrations(utils: ReturnType<typeof renderPane>) {
	await fireEvent.click(utils.getByTestId("system-nav-integrations"));
	await waitFor(() => {
		expect(utils.getByTestId("system-page-integrations")).toBeInTheDocument();
	});
}

describe("MinerU status card", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchMineruStatus.mockResolvedValue(reachableReport());
	});

	it("shows the version, tiers and output formats the server reports", async () => {
		const utils = renderPane();
		await openIntegrations(utils);

		await waitFor(() => {
			expect(utils.getByTestId("mineru-status-card")).toBeInTheDocument();
		});
		expect(utils.getByTestId("mineru-status-pill")).toHaveTextContent(
			"Reachable",
		);
		expect(utils.getByTestId("mineru-status-row-version")).toHaveTextContent(
			"4.0.4",
		);
		expect(utils.getByTestId("mineru-status-row-tiers")).toHaveTextContent(
			"flash, basic",
		);
		expect(
			utils.getByTestId("mineru-status-row-outputFormats"),
		).toHaveTextContent("structured_content");
		expect(utils.getByTestId("mineru-status-row-endpoint")).toHaveTextContent(
			"http://127.0.0.1:8001",
		);
	});

	it("says unreachable, with the reason, when the service is down", async () => {
		// The point of the card: an admin who mistypes the endpoint or stops the
		// container learns it here, not hours later from a failed upload.
		mockFetchMineruStatus.mockResolvedValue(
			reachableReport({
				reachable: false,
				version: null,
				tiers: [],
				outputFormats: [],
				limits: null,
				accessLevel: null,
				error: { code: "unavailable", message: "fetch failed (ECONNREFUSED)" },
			}),
		);

		const utils = renderPane();
		await openIntegrations(utils);

		await waitFor(() => {
			expect(utils.getByTestId("mineru-status-pill")).toHaveTextContent(
				"Unreachable",
			);
		});
		expect(utils.getByTestId("mineru-status-error")).toHaveTextContent(
			"fetch failed (ECONNREFUSED)",
		);
	});

	it("re-checks with refresh when the button is pressed", async () => {
		const utils = renderPane();
		await openIntegrations(utils);

		await waitFor(() => {
			expect(mockFetchMineruStatus).toHaveBeenCalledWith({ refresh: false });
		});

		await fireEvent.click(utils.getByRole("button", { name: /Re-check/ }));
		await waitFor(() => {
			expect(mockFetchMineruStatus).toHaveBeenCalledWith({ refresh: true });
		});
	});

	it("renders the twelve MinerU settings rows with the right control per key", async () => {
		const utils = renderPane({
			MINERU_DEFAULT_TIER: "basic",
			MINERU_API_KEY: "[set]",
		});
		await openIntegrations(utils);

		// The endpoint and the timings are plain fields…
		expect(utils.getByLabelText("MinerU API URL")).toBeInTheDocument();
		// …the tier is a select whose options come from the key's spec, so the UI
		// can never offer a value validateAdminConfigValue would reject…
		const tier = utils.getByLabelText(
			"Default quality tier",
		) as HTMLSelectElement;
		expect(tier.tagName).toBe("SELECT");
		expect([...tier.options].map((option) => option.value)).toEqual([
			"auto",
			"flash",
			"basic",
			"standard",
			"advanced",
		]);
		expect(tier.value).toBe("basic");
		// …and the API key is a write-only secret field, never an editable value:
		// the masked "[set]" sentinel must not be reachable as an input.
		expect(utils.queryByDisplayValue("[set]")).toBeNull();
		const secretRow = document.querySelector(
			'[data-config-key="MINERU_API_KEY"]',
		);
		expect(secretRow).not.toBeNull();
		expect(secretRow?.querySelector("#MINERU_API_KEY")?.tagName).toBe("BUTTON");
	});

	it("shows the job timeout in seconds, the unit its spec declares", async () => {
		const utils = renderPane({ MINERU_JOB_TIMEOUT_MS: "600000" });
		await openIntegrations(utils);

		const field = utils.getByLabelText("Job timeout") as HTMLInputElement;
		expect(field.value).toBe("600");
	});
});
