import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import SettingsPersonalAnalytics from "./SettingsPersonalAnalytics.svelte";

vi.mock("chart.js/auto", () => {
	class Chart {
		static getChart = vi.fn(() => null);
		destroy = vi.fn();
	}
	return { Chart };
});

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
});
