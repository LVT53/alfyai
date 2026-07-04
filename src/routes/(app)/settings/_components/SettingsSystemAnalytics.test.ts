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

describe("SettingsSystemAnalytics (ADR-0043 slice 18c)", () => {
	it("renders the System Overview stats (system-level analytics, admin-only home)", () => {
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
		expect(getByText("Total users")).toBeInTheDocument();
		expect(getByText("Total conversations")).toBeInTheDocument();
	});

	it("uses all-user months for the admin System Overview picker", async () => {
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

		await fireEvent.click(getByLabelText("Next system month"));

		expect(onSystemMonthChange).toHaveBeenCalledWith("2026-06");
	});

	it("selects the previous system month from All Time instead of the oldest month", async () => {
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

		await fireEvent.click(getByLabelText("Previous system month"));

		expect(onSystemMonthChange).toHaveBeenCalledWith("2026-05");
	});

	it("renders the Per-User Breakdown and drives the per-user month picker", async () => {
		const onSystemMonthChange = vi.fn();
		const { getByLabelText, getByText, queryByText } = render(
			SettingsSystemAnalytics,
			{
				analyticsData: systemWithPerUserFixture(),
				modelNames: { model2: "Model 2" },
				onRetry: vi.fn(),
				selectedSystemMonth: null,
				onSystemMonthChange,
				allUsers: [],
				excludedUserIds: [],
				onExcludedUsersChange: vi.fn(),
			},
		);

		expect(queryByText("User Activity")).not.toBeInTheDocument();
		expect(getByText("Per-User Breakdown")).toBeInTheDocument();
		expect(getByText("User Two")).toBeInTheDocument();

		await fireEvent.click(getByLabelText("Next per-user month"));

		expect(onSystemMonthChange).toHaveBeenCalledWith("2026-06");
	});

	it("renders the Excluded Users section when admin users are provided", () => {
		const { getByText } = render(SettingsSystemAnalytics, {
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

		expect(getByText("Excluded Users")).toBeInTheDocument();
		expect(getByText("User Two")).toBeInTheDocument();
	});

	it("disables Chart.js animation under prefers-reduced-motion (ADR-0043 Wave 9)", async () => {
		reducedMotionMatchMedia();
		chartConfigs.length = 0;

		render(SettingsSystemAnalytics, {
			analyticsData: systemWithPerUserFixture(),
			modelNames: { model2: "Model 2" },
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
