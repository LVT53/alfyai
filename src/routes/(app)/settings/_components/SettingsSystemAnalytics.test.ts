import { fireEvent, render, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import SettingsSystemAnalytics from "./SettingsSystemAnalytics.svelte";

const { fetchAnalyticsMock } = vi.hoisted(() => ({
	fetchAnalyticsMock: vi.fn(),
}));

vi.mock("$lib/client/api/settings", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/settings")>();
	return {
		...actual,
		fetchAnalytics: fetchAnalyticsMock,
	};
});

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

function systemWithAvailabilityFixture(): AnalyticsResponse {
	const base = systemFixture();
	const system = base.system;
	if (!system) throw new Error("systemFixture() must include system");
	return {
		...base,
		system: {
			...system,
			byModel: [
				{
					model: "model-active",
					displayName: "Model Active",
					providerDisplayName: "OpenAI",
					msgCount: 10,
					totalTokens: 100,
					totalCostUsd: 1,
					availability: "active",
					firstTokenP50Ms: 200,
					firstTokenP90Ms: 400,
					generationP50Ms: 1200,
					avgReasoningTokens: 50,
				},
				{
					model: "model-disabled",
					displayName: "Model Disabled",
					providerDisplayName: "OpenAI",
					msgCount: 5,
					totalTokens: 50,
					totalCostUsd: 0.5,
					availability: "disabled",
				},
				{
					model: "model-removed",
					displayName: "Model Removed",
					providerDisplayName: "OpenAI",
					msgCount: 2,
					totalTokens: 20,
					totalCostUsd: 0.2,
					availability: "removed",
				},
			],
			byProvider: [
				{
					providerId: "provider-openai",
					displayName: "OpenAI",
					msgCount: 17,
					totalTokens: 170,
					totalCostUsd: 1.7,
				},
			],
		},
	};
}

function systemWithToolsAndLatencyFixture(): AnalyticsResponse {
	const base = systemFixture();
	const system = base.system;
	if (!system) throw new Error("systemFixture() must include system");
	const tools = Array.from({ length: 12 }, (_, i) => ({
		name: `tool_${i}`,
		calls: 100 - i,
		failed: i,
		cached: i * 2,
		p50DurationMs: 300 + i,
	}));
	const commandsAndSkills = Array.from({ length: 15 }, (_, i) => ({
		kind:
			i % 3 === 0
				? ("composer_command" as const)
				: i % 3 === 1
					? ("skill_use" as const)
					: ("follow_up_click" as const),
		name: `action_${i}`,
		count: 50 - i,
	}));
	return {
		...base,
		system,
		tools,
		commandsAndSkills,
		latencyByPromptBucket: [
			{
				bucket: "<10k",
				n: 10,
				firstTokenP50Ms: 100,
				firstTokenP90Ms: 200,
				reasoningTokensMedian: 20,
			},
			{
				bucket: "10-30k",
				n: 8,
				firstTokenP50Ms: 150,
				firstTokenP90Ms: 300,
				reasoningTokensMedian: 30,
			},
			{
				bucket: "30-60k",
				n: 6,
				firstTokenP50Ms: 200,
				firstTokenP90Ms: 500,
				reasoningTokensMedian: 40,
			},
			{
				bucket: "60-120k",
				n: 4,
				firstTokenP50Ms: 300,
				firstTokenP90Ms: 900,
				reasoningTokensMedian: 60,
			},
			{
				bucket: ">120k",
				n: 2,
				firstTokenP50Ms: 500,
				firstTokenP90Ms: 1500,
				reasoningTokensMedian: 100,
			},
		],
	};
}

// A month whose usage includes a model that no longer resolves: the system
// totals (as the server computes them) cover every model in scope, retired
// ones included.
function systemWithRetiredSpendFixture(): AnalyticsResponse {
	const base = systemFixture();
	const system = base.system;
	if (!system) throw new Error("systemFixture() must include system");
	return {
		...base,
		system: {
			...system,
			totalMessages: 30,
			totalTokens: 3_000,
			totalCostUsd: 6,
			byModel: [
				{
					model: "model-live",
					displayName: "Model Live",
					msgCount: 20,
					totalTokens: 2_000,
					totalCostUsd: 4,
					availability: "active",
				},
				{
					model: "model-gone",
					displayName: "Model Gone",
					msgCount: 10,
					totalTokens: 1_000,
					totalCostUsd: 2,
					availability: "removed",
				},
			],
		},
	};
}

function systemWithEmptyLatencyFixture(): AnalyticsResponse {
	const base = systemWithToolsAndLatencyFixture();
	return {
		...base,
		latencyByPromptBucket: (base.latencyByPromptBucket ?? []).map((row) => ({
			...row,
			n: 0,
			firstTokenP50Ms: null,
			firstTokenP90Ms: null,
			reasoningTokensMedian: null,
		})),
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
	beforeEach(() => {
		fetchAnalyticsMock.mockReset();
		fetchAnalyticsMock.mockResolvedValue(systemWithAvailabilityFixture());
	});

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
		expect(getByText("Active users this month")).toBeInTheDocument();
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

		const excludedCard = getByText("Excluded Users").closest("section");
		expect(excludedCard).not.toBeNull();
		expect(
			within(excludedCard as HTMLElement).getByText("User Two"),
		).toBeInTheDocument();
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
		// SortableTable formats USD with a locale-pinned (en-US) Intl currency
		// formatter (2 dp), so the output is the same on every machine.
		expect(getAllByText("$1.23").length).toBeGreaterThan(0);
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

		// Overview now draws its columns with the shared chassis chart; the
		// By user tab is where Chart.js still runs.
		const { getByRole } = render(SettingsSystemAnalytics, {
			analyticsData: {
				...systemFixture(),
				perUser: [
					{
						userId: "user-1",
						displayName: "User One",
						email: "user1@example.com",
						messageCount: 10,
						avgGenerationMs: 100,
						totalTokens: 1000,
						promptTokens: 600,
						outputTokens: 400,
						reasoningTokens: 0,
						totalCostUsd: 1,
						favoriteModel: null,
						conversationCount: 2,
					},
				],
			},
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByRole("tab", { name: "By user" }));

		await vi.waitFor(() => {
			expect(chartConfigs.length).toBeGreaterThan(0);
		});

		for (const config of chartConfigs) {
			expect(config.options?.animation).toBe(false);
		}
	});

	it("splits the hero between LLM and Parallel spend, to two decimals", () => {
		const { getByTestId } = render(SettingsSystemAnalytics, {
			analyticsData: systemFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		const hero = getByTestId("analytics-hero");
		expect(hero.textContent).toMatch(/\$\d+\.\d{2}(\D|$)/);
		expect(hero.textContent).not.toMatch(/\$\d+\.\d{4}/);
	});

	// Analytics overhaul (frontend half) — status badge, retired grouping, and
	// the "Show retired" toggle on the Usage by model tab.
	it("shows status badges, hides retired models by default, and reveals them via Show retired", async () => {
		const { getByRole, getByText, getByLabelText, queryByText } = render(
			SettingsSystemAnalytics,
			{
				analyticsData: systemWithAvailabilityFixture(),
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

		expect(getByText("Model Active")).toBeInTheDocument();
		expect(getByText("Model Disabled")).toBeInTheDocument();
		expect(getByText("Active")).toBeInTheDocument();
		expect(getByText("Disabled")).toBeInTheDocument();
		// Retired models are hidden until "Show retired" is toggled on.
		expect(queryByText("Model Removed")).not.toBeInTheDocument();
		expect(
			queryByText("Retired · no longer offered by any provider"),
		).not.toBeInTheDocument();

		await fireEvent.click(getByLabelText("Show retired"));

		expect(getByText("Model Removed")).toBeInTheDocument();
		expect(
			getByText("Retired · no longer offered by any provider"),
		).toBeInTheDocument();
		expect(getByText("Removed")).toBeInTheDocument();
	});

	// Analytics overhaul (frontend half) — the User/Provider/Model filters
	// call GET /api/analytics (via fetchAnalytics) with the new filter params.
	it("calls fetchAnalytics with the selected filter params", async () => {
		const { getByRole, getByLabelText } = render(SettingsSystemAnalytics, {
			analyticsData: systemWithAvailabilityFixture(),
			modelNames: { "model-active": "Model Active" },
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [
				{ id: "user-2", email: "user2@example.com", name: "User Two" },
			],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByRole("tab", { name: "Usage by model" }));

		await fireEvent.change(getByLabelText("User"), {
			target: { value: "user-2" },
		});

		await vi.waitFor(() => {
			expect(fetchAnalyticsMock).toHaveBeenCalledWith(
				false,
				undefined,
				undefined,
				undefined,
				{ userId: "user-2", modelId: null, providerId: null },
			);
		});

		await fireEvent.change(getByLabelText("Model"), {
			target: { value: "model-active" },
		});

		await vi.waitFor(() => {
			expect(fetchAnalyticsMock).toHaveBeenCalledWith(
				false,
				undefined,
				undefined,
				undefined,
				{ userId: "user-2", modelId: "model-active", providerId: null },
			);
		});
	});

	// A filtered fetch that fails used to be swallowed, leaving the previous
	// (differently filtered) numbers on screen as if they were the result.
	it("surfaces a failed filtered fetch in the page error state", async () => {
		fetchAnalyticsMock.mockRejectedValue(new Error("Filtered fetch failed"));
		const onRetry = vi.fn();
		const { getByRole, getByLabelText, getByText } = render(
			SettingsSystemAnalytics,
			{
				analyticsData: systemWithAvailabilityFixture(),
				modelNames: { "model-active": "Model Active" },
				onRetry,
				selectedSystemMonth: null,
				onSystemMonthChange: vi.fn(),
				allUsers: [
					{ id: "user-2", email: "user2@example.com", name: "User Two" },
				],
				excludedUserIds: [],
				onExcludedUsersChange: vi.fn(),
			},
		);

		await fireEvent.click(getByRole("tab", { name: "Usage by model" }));
		await fireEvent.change(getByLabelText("User"), {
			target: { value: "user-2" },
		});

		await vi.waitFor(() => {
			expect(getByText("Filtered fetch failed")).toBeInTheDocument();
		});

		fetchAnalyticsMock.mockResolvedValue(systemWithAvailabilityFixture());
		await fireEvent.click(getByRole("button", { name: "Retry" }));

		expect(onRetry).toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(getByRole("tab", { name: "Usage by model" })).toBeInTheDocument();
		});
	});

	// Analytics overhaul (frontend half) — the Tools & latency tab renders
	// from the new read-model sections, and its top-10 tables expand/collapse.
	describe("Tools & latency tab", () => {
		it("renders the tools, commands/skills, and latency-by-prompt-size cards", async () => {
			const { getByRole, getByText, getAllByText } = render(
				SettingsSystemAnalytics,
				{
					analyticsData: systemWithToolsAndLatencyFixture(),
					modelNames: {},
					onRetry: vi.fn(),
					selectedSystemMonth: null,
					onSystemMonthChange: vi.fn(),
					allUsers: [],
					excludedUserIds: [],
					onExcludedUsersChange: vi.fn(),
				},
			);

			await fireEvent.click(getByRole("tab", { name: "Tools & latency" }));

			expect(getByText("tool_0")).toBeInTheDocument();
			expect(getByText("Commands, skills and actions")).toBeInTheDocument();
			expect(getByText("action_0")).toBeInTheDocument();
			expect(getAllByText("Command").length).toBeGreaterThan(0);
			expect(getByText("Latency by prompt size")).toBeInTheDocument();
			expect(getByText("<10k")).toBeInTheDocument();
		});

		it("caps the tools table at 10 rows and expands/collapses via View all / Show fewer", async () => {
			const { getByRole, getByText, queryByText } = render(
				SettingsSystemAnalytics,
				{
					analyticsData: systemWithToolsAndLatencyFixture(),
					modelNames: {},
					onRetry: vi.fn(),
					selectedSystemMonth: null,
					onSystemMonthChange: vi.fn(),
					allUsers: [],
					excludedUserIds: [],
					onExcludedUsersChange: vi.fn(),
				},
			);

			await fireEvent.click(getByRole("tab", { name: "Tools & latency" }));

			// 12 tools total, sorted by calls desc by default -> tool_0..tool_9 (top 10).
			expect(getByText("tool_9")).toBeInTheDocument();
			expect(queryByText("tool_10")).not.toBeInTheDocument();
			const viewAll = getByText("Showing 10 of 12 · View all 12 →");
			expect(viewAll).toBeInTheDocument();

			await fireEvent.click(viewAll);

			expect(getByText("tool_10")).toBeInTheDocument();
			expect(getByText("tool_11")).toBeInTheDocument();
			const showFewer = getByText("Show fewer");
			expect(showFewer).toBeInTheDocument();

			await fireEvent.click(showFewer);

			expect(queryByText("tool_10")).not.toBeInTheDocument();
		});
	});

	// The stat row and the table's pinned Total row sit inside the SAME card,
	// so they must describe the same set of models: a retired model's spend
	// must not disappear from the card's arithmetic just because its row moved
	// into the collapsed group below.
	it("totals every model in scope in the pinned Total row, retired included", async () => {
		const { getByRole, container } = render(SettingsSystemAnalytics, {
			analyticsData: systemWithRetiredSpendFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByRole("tab", { name: "Usage by model" }));

		const statValues = [...container.querySelectorAll("[class*=stat-value]")]
			.map((node) => node.textContent?.trim() ?? "")
			.join(" ");
		expect(statValues).toContain("$6.00");
		expect(statValues).toContain("30");
		expect(statValues).toContain("3,000");

		const totalRow = [...container.querySelectorAll("table tbody tr")]
			.at(-1)
			?.textContent?.replace(/\s+/g, " ");
		expect(totalRow).toContain("Total");
		expect(totalRow).toContain("$6.00");
		expect(totalRow).toContain("30");
		expect(totalRow).toContain("3,000");
	});

	// Every prompt-size bucket is always present in the read model (n: 0 when
	// empty), so "is there data?" is a turn in some bucket — not a non-empty
	// row list, which renders five rows of em-dashes instead of the empty
	// state.
	it("shows the latency empty state when no prompt-size bucket has any turns", async () => {
		const { getByRole, container } = render(SettingsSystemAnalytics, {
			analyticsData: systemWithEmptyLatencyFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByRole("tab", { name: "Tools & latency" }));

		const latencyCard = [...container.querySelectorAll("section")]
			.filter((node) => node.textContent?.includes("Latency by prompt size"))
			.at(-1);
		expect(latencyCard).toBeTruthy();
		expect(latencyCard?.querySelector("table")).toBeNull();
		expect(latencyCard?.textContent).toContain("No analytics data yet.");
	});

	// The Tools/Commands/Latency column lists must follow the UI language the
	// way the card titles (and the byModel columns) do — a plain const would
	// freeze the labels in whatever language was active at mount.
	it("relabels the Tools table when the UI language changes", async () => {
		const { getByRole, container } = render(SettingsSystemAnalytics, {
			analyticsData: systemWithToolsAndLatencyFixture(),
			modelNames: {},
			onRetry: vi.fn(),
			selectedSystemMonth: null,
			onSystemMonthChange: vi.fn(),
			allUsers: [],
			excludedUserIds: [],
			onExcludedUsersChange: vi.fn(),
		});

		await fireEvent.click(getByRole("tab", { name: "Tools & latency" }));
		const { uiLanguage } = await import("$lib/stores/settings");
		uiLanguage.set("hu");
		await tick();

		const headers = [...container.querySelectorAll("thead th")]
			.map((node) => node.textContent?.trim() ?? "")
			.join(" | ");
		const cardTitles = [...container.querySelectorAll("h3")]
			.map((node) => node.textContent?.trim() ?? "")
			.join(" | ");
		uiLanguage.set("en");
		expect(cardTitles).toContain("Eszközök");
		expect(headers).toContain("Eszköz");
	});
});
