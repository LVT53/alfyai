import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import SettingsAnalyticsTab from "./SettingsAnalyticsTab.svelte";

vi.mock("chart.js/auto", () => {
	class Chart {
		static getChart = vi.fn(() => null);
		destroy = vi.fn();
	}
	return { Chart };
});

function analyticsFixture(): AnalyticsResponse {
	return {
		availableMonths: ["2026-03"],
		systemAvailableMonths: ["2026-03", "2026-06"],
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
				{
					month: "2026-03",
					messages: 1,
					totalTokens: 150,
					totalCostUsd: 1,
				},
			],
		},
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
				{
					month: "2026-03",
					messages: 1,
					totalTokens: 150,
					totalCostUsd: 1,
				},
				{
					month: "2026-06",
					messages: 1,
					totalTokens: 600,
					totalCostUsd: 2.5,
				},
			],
		},
		perUser: [],
	};
}

describe("SettingsAnalyticsTab", () => {
	it("uses all-user months for the admin System Overview picker", async () => {
		const onSystemMonthChange = vi.fn();
		const { getByLabelText } = render(SettingsAnalyticsTab, {
			analyticsData: analyticsFixture(),
			isAdmin: true,
			modelNames: {},
			onRetry: vi.fn(),
			selectedMonth: null,
			selectedSystemMonth: null,
			onMonthChange: vi.fn(),
			onSystemMonthChange,
		});

		await fireEvent.click(getByLabelText("Next system month"));

		expect(onSystemMonthChange).toHaveBeenCalledWith("2026-06");
	});
});
