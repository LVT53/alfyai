import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import SettingsSystemAnalytics from "./SettingsSystemAnalytics.svelte";

vi.mock("chart.js/auto", () => {
	class Chart {
		static getChart = vi.fn(() => null);
		destroy = vi.fn();
		constructor(_canvas: unknown, config: CapturedChartConfig) {
			chartConfigs.push(config);
		}
	}
	return { Chart };
});

// Capture the config passed to each Chart instance so animation behaviour
// can be asserted (ADR-0043 Wave 9 reduced-motion guard).
interface CapturedChartConfig {
	options?: { animation?: false | Record<string, unknown> };
}
const chartConfigs: CapturedChartConfig[] = [];

function reducedMotionMatchMedia() {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => ({
			matches: query === "(prefers-reduced-motion: reduce)",
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});
}

function systemFixture(): AnalyticsResponse {
	return {
		availableMonths: ["2026-04", "2026-05", "2026-06"],
		personal: {
			byModel: [],
			byProvider: [],
			totalMessages: 0,
			avgGenerationMs: 0,
			totalTokens: 0,
			promptTokens: 0,
			cachedInputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			totalCostUsd: 0,
			favoriteModel: null,
			chatCount: 0,
		},
		systemAvailableMonths: ["2026-04", "2026-05", "2026-06"],
		system: {
			byModel: [],
			byProvider: [],
			totalMessages: 1,
			avgGenerationMs: 900,
			totalTokens: 600,
			promptTokens: 400,
			cachedInputTokens: 0,
			outputTokens: 200,
			reasoningTokens: 0,
			totalCostUsd: 2.5,
			totalUsers: 1,
			totalConversations: 1,
			monthly: [
				{ month: "2026-03", messages: 1, totalTokens: 150, totalCostUsd: 1 },
				{ month: "2026-06", messages: 1, totalTokens: 600, totalCostUsd: 2.5 },
			],
		},
		perUser: [],
	};
}

function systemWithPerUserFixture(): AnalyticsResponse {
	return {
		...systemFixture(),
		perUser: [
			{
				userId: "user-2",
				displayName: "User Two",
				email: "user2@example.com",
				messageCount: 12,
				avgGenerationMs: 900,
				totalTokens: 600,
				promptTokens: 400,
				outputTokens: 200,
				reasoningTokens: 0,
				totalCostUsd: 2.5,
				favoriteModel: "model2",
				conversationCount: 3,
			},
		],
	};
}

function systemWithByModelFixture(): AnalyticsResponse {
	const base = systemFixture();
	const system = base.system;
	if (!system) throw new Error("systemFixture() must include system");
	return {
		...base,
		system: {
			...system,
			byModel: [
				{
					model: "model-a",
					displayName: "Model A",
					providerDisplayName: "OpenAI",
					msgCount: 7,
					promptTokens: 321,
					cachedInputTokens: 54,
					outputTokens: 187,
					reasoningTokens: 29,
					totalTokens: 591,
					totalCostUsd: 1.2345,
				},
			],
		},
	};
}

function systemWithParallelFixture(): AnalyticsResponse {
	const base = systemFixture();
	const system = base.system;
	if (!system) throw new Error("systemFixture() must include system");
	return {
		...base,
		system: {
			...system,
			parallel: {
				monthly: [
					{ month: "2026-05", turboCalls: 3, extractCalls: 2, costUsd: 0.4 },
					{ month: "2026-06", turboCalls: 5, extractCalls: 4, costUsd: 0.9 },
				],
				totalTurboCalls: 8,
				totalExtractCalls: 6,
				totalCostUsd: 1.3,
			},
		},
	};
}

describe("SettingsSystemAnalytics (Phase B wave B3)", () => {
	it("renders the System Overview stats on the default Overview tab", () => {
		const { getByText } = render(SettingsSystemAnalytics, {
			analyticsData: systemFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		expect(getByText("System Overview")).toBeInTheDocument();
		expect(getByText("Active users")).toBeInTheDocument();
		expect(getByText("Total conversations")).toBeInTheDocument();
	});

	it("steps from All Time to the newest month via the shared MonthNav", async () => {
		const onSystemMonthChange = vi.fn();
		const { getByLabelText } = render(SettingsSystemAnalytics, {
			analyticsData: systemFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange,
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByLabelText("Previous month"));

		expect(onSystemMonthChange).toHaveBeenCalledWith("2026-06");
	});

	it("steps to an older month from a selected month", async () => {
		const onSystemMonthChange = vi.fn();
		const { getByLabelText } = render(SettingsSystemAnalytics, {
			analyticsData: systemFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: "2026-06",
			onSystemMonthChange,
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByLabelText("Previous month"));

		expect(onSystemMonthChange).toHaveBeenCalledWith("2026-05");
	});

	it("renders the Per-User Breakdown under the By user tab", async () => {
		const { getByRole, getByText, queryByText } = render(
			SettingsSystemAnalytics,
			{
				analyticsData: systemWithPerUserFixture(),
				modelNames: { model2: "Model 2" },
				onRetry: vi.fn(),
				selectedSystemMonth: null,
				onSystemMonthChange: vi.fn(),
				allUsers: [],
				excludedUserIds: [],
				onExcludedUsersChange: vi.fn(),
			},
		);

		// Not shown until the By user tab is active.
		expect(queryByText("Per-User Breakdown")).not.toBeInTheDocument();

		await fireEvent.click(getByRole("tab", { name: "By user" }));

		expect(getByText("Per-User Breakdown")).toBeInTheDocument();
		expect(getByText("User Two")).toBeInTheDocument();
	});

	it("renders the Excluded Users control under the By user tab", async () => {
		const { getByRole, getByText } = render(SettingsSystemAnalytics, {
			analyticsData: systemFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [
				{ id: "user-2", email: "user2@example.com", name: "User Two" },
			],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByRole("tab", { name: "By user" }));

		expect(getByText("Excluded Users")).toBeInTheDocument();
		expect(getByText("User Two")).toBeInTheDocument();
	});

	it("renders the per-model usage table under the Usage by model tab", async () => {
		const { getByRole, getByText, getAllByText } = render(
			SettingsSystemAnalytics,
			{
				analyticsData: systemWithByModelFixture(),
				modelNames: {},
				onRetry: vi.fn(),
				selectedSystemMonth: null,
				onSystemMonthChange: vi.fn(),
				allUsers: [],
				excludedUserIds: [],
				onExcludedUsersChange: vi.fn(),
			},
		);

		await fireEvent.click(getByRole("tab", { name: "Usage by model" }));

		expect(getByText("Model A")).toBeInTheDocument();
		expect(getByText("OpenAI")).toBeInTheDocument();
		// 591 appears in both the model row and the pinned total row.
		expect(getAllByText("591").length).toBeGreaterThan(0);
		// SortableTable formats USD with the Intl currency formatter (2 dp).
		expect(getAllByText("US$1.23").length).toBeGreaterThan(0);
	});

	it("shows an empty state when byModel is empty on the Usage by model tab", async () => {
		const { getByRole, getByText } = render(SettingsSystemAnalytics, {
			analyticsData: systemFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByRole("tab", { name: "Usage by model" }));

		expect(getByText("No analytics data yet.")).toBeInTheDocument();
	});

	it("renders the Parallel API tab only when parallel data is present", async () => {
		const { getByRole, getByText, queryByRole } = render(
			SettingsSystemAnalytics,
			{
				analyticsData: systemWithParallelFixture(),
				modelNames: {},
				onRetry: vi.fn(),
				selectedSystemMonth: null,
				onSystemMonthChange: vi.fn(),
				allUsers: [],
				excludedUserIds: [],
				onExcludedUsersChange: vi.fn(),
			},
		);

		expect(queryByRole("tab", { name: "Parallel API" })).toBeInTheDocument();

		await fireEvent.click(getByRole("tab", { name: "Parallel API" }));

		expect(getByText("Turbo searches")).toBeInTheDocument();
		expect(getByText("Extract fetches")).toBeInTheDocument();
		expect(getByText("Parallel cost")).toBeInTheDocument();
		expect(getByText("Total calls")).toBeInTheDocument();
	});

	it("omits the Parallel API tab when there is no parallel data", () => {
		const { queryByRole } = render(SettingsSystemAnalytics, {
			analyticsData: systemFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		expect(
			queryByRole("tab", { name: "Parallel API" }),
		).not.toBeInTheDocument();
	});

	it("disables Chart.js animation under prefers-reduced-motion (ADR-0043 Wave 9)", async () => {
		reducedMotionMatchMedia();
		chartConfigs.length = 0;

		// The Overview tab renders the monthly cost chart by default.
		render(SettingsSystemAnalytics, {
			analyticsData: systemFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await vi.waitFor(() => {
			expect(chartConfigs.length).toBeGreaterThan(0);
		});

		for (const config of chartConfigs) {
			expect(config.options?.animation).toBe(false);
		}
	});
});
