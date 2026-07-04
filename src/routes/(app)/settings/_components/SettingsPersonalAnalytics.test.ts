import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import SettingsPersonalAnalytics from "./SettingsPersonalAnalytics.svelte";

// Capture the config passed to each Chart instance so animation behaviour
// can be asserted (ADR-0043 Wave 9 reduced-motion guard).
interface CapturedChartConfig {
	options?: { animation?: false | Record<string, unknown> };
}
const chartConfigs: CapturedChartConfig[] = [];

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

function personalFixture(): AnalyticsResponse {
	return {
		availableMonths: ["2026-04", "2026-05", "2026-06"],
		personal: {
			byModel: [],
			byProvider: [],
			totalMessages: 1,
			avgGenerationMs: 1200,
			totalTokens: 150,
			promptTokens: 100,
			cachedInputTokens: 0,
			outputTokens: 50,
			reasoningTokens: 0,
			totalCostUsd: 1,
			favoriteModel: "model1",
			chatCount: 1,
			monthly: [
				{ month: "2026-03", messages: 1, totalTokens: 150, totalCostUsd: 1 },
				{ month: "2026-06", messages: 1, totalTokens: 150, totalCostUsd: 2 },
			],
		},
	};
}

describe("SettingsPersonalAnalytics (ADR-0043 slice 18c)", () => {
	it("renders the personal usage stats (Your Activity content)", () => {
		const { getByText } = render(SettingsPersonalAnalytics, {
			analyticsData: personalFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedMonth: "2026-06",
		});

		// Personal stats labels render.
		expect(getByText("Messages sent")).toBeInTheDocument();
		expect(getByText("Tokens used")).toBeInTheDocument();
		expect(getByText("Conversations")).toBeInTheDocument();
	});

	it("keeps existing analytics content visible during month refreshes", () => {
		const { queryByText, getByText } = render(SettingsPersonalAnalytics, {
			analyticsData: personalFixture(),
			analyticsLoading: true,
			modelNames: {},
			onRetry: vi.fn(),
			selectedMonth: "2026-06",
		});

		expect(queryByText("Loading analytics...")).not.toBeInTheDocument();
		expect(getByText("June 2026")).toBeInTheDocument();
	});

	it("selects the previous available month from All Time instead of the oldest month", async () => {
		const onMonthChange = vi.fn();
		const { getByLabelText } = render(SettingsPersonalAnalytics, {
			analyticsData: personalFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedMonth: null,
			onMonthChange,
		});

		await fireEvent.click(getByLabelText("Previous month"));

		expect(onMonthChange).toHaveBeenCalledWith("2026-05");
	});

	it("shows a graceful empty state when there is no data yet", () => {
		const { getByText } = render(SettingsPersonalAnalytics, {
			analyticsData: null,
			modelNames: {},
			onRetry: vi.fn(),
		});

		expect(getByText("No analytics data yet.")).toBeInTheDocument();
	});

	it("disables Chart.js animation under prefers-reduced-motion (ADR-0043 Wave 9)", async () => {
		reducedMotionMatchMedia();
		chartConfigs.length = 0;

		const data: AnalyticsResponse = {
			...personalFixture(),
			personal: {
				...personalFixture().personal,
				byModel: [
					{
						model: "model1",
						displayName: "Model 1",
						msgCount: 1,
						totalCostUsd: 1.5,
					},
				],
			},
			timeline: [
				{ label: "w1", tokens: 100 },
				{ label: "w2", tokens: 200 },
			],
		};

		render(SettingsPersonalAnalytics, {
			analyticsData: data,
			modelNames: {},
			onRetry: vi.fn(),
			selectedMonth: "2026-06",
		});

		// Chart.js runs inside an awaited dynamic import + tick; flush.
		await vi.waitFor(() => {
			expect(chartConfigs.length).toBeGreaterThan(0);
		});

		for (const config of chartConfigs) {
			expect(config.options?.animation).toBe(false);
		}
	});
});
