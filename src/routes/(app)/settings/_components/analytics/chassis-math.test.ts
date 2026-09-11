import { describe, expect, it } from "vitest";
import {
	buildColumnChart,
	buildComparisonDelta,
	buildCostSplit,
	findPreviousMonth,
	formatCompactNumber,
	formatCurrencyUsd,
	monthlyChartPoints,
} from "./chassis-math";

describe("formatCurrencyUsd", () => {
	it("always shows two decimals", () => {
		expect(formatCurrencyUsd(2.4231)).toBe("$2.42");
		expect(formatCurrencyUsd(128.7449)).toBe("$128.74");
		expect(formatCurrencyUsd(2)).toBe("$2.00");
		expect(formatCurrencyUsd(0)).toBe("$0.00");
	});

	it("rounds rather than truncates", () => {
		expect(formatCurrencyUsd(0.005)).toBe("$0.01");
		expect(formatCurrencyUsd(1.999)).toBe("$2.00");
	});

	it("survives null, undefined and NaN", () => {
		expect(formatCurrencyUsd(null)).toBe("$0.00");
		expect(formatCurrencyUsd(undefined)).toBe("$0.00");
		expect(formatCurrencyUsd(Number.NaN)).toBe("$0.00");
	});
});

describe("buildCostSplit", () => {
	it("splits the hero into halves that add up to it", () => {
		const split = buildCostSplit([
			{ label: "Chat", value: 1.98, color: "var(--accent)" },
			{ label: "Atlas", value: 0.44, color: "rgba(0,0,0,0.4)" },
		]);
		expect(split.total).toBeCloseTo(2.42, 5);
		expect(formatCurrencyUsd(split.total)).toBe("$2.42");
		const summed = split.segments.reduce(
			(sum, segment) => sum + segment.value,
			0,
		);
		expect(formatCurrencyUsd(summed)).toBe(formatCurrencyUsd(split.total));
	});

	it("fills the bar exactly — percentages total 100", () => {
		const split = buildCostSplit([
			{ label: "LLM", value: 96.31, color: "a" },
			{ label: "Parallel", value: 32.43, color: "b" },
		]);
		const total = split.segments.reduce(
			(sum, segment) => sum + segment.percent,
			0,
		);
		expect(total).toBeCloseTo(100, 6);
	});

	it("fills the bar exactly for a three-way split with awkward thirds", () => {
		const split = buildCostSplit([
			{ label: "A", value: 1, color: "a" },
			{ label: "B", value: 1, color: "b" },
			{ label: "C", value: 1, color: "c" },
		]);
		const total = split.segments.reduce(
			(sum, segment) => sum + segment.percent,
			0,
		);
		expect(total).toBeCloseTo(100, 6);
	});

	it("names each half with its amount in the legend", () => {
		const split = buildCostSplit([
			{ label: "Chat", value: 1.98, color: "a" },
			{ label: "Atlas", value: 0.44, color: "b" },
		]);
		expect(split.segments.map((segment) => segment.legend)).toEqual([
			"Chat · $1.98",
			"Atlas · $0.44",
		]);
	});

	it("drops segments worth nothing rather than drawing an empty sliver", () => {
		const split = buildCostSplit([
			{ label: "LLM", value: 96.31, color: "a" },
			{ label: "Parallel", value: 0, color: "b" },
		]);
		expect(split.segments).toHaveLength(1);
		expect(split.segments[0].percent).toBeCloseTo(100, 6);
	});

	it("returns an empty split when nothing was spent", () => {
		expect(buildCostSplit([{ label: "LLM", value: 0, color: "a" }])).toEqual({
			total: 0,
			segments: [],
		});
		expect(buildCostSplit([])).toEqual({ total: 0, segments: [] });
	});

	it("ignores non-finite amounts", () => {
		const split = buildCostSplit([
			{ label: "Good", value: 10, color: "a" },
			{ label: "Bad", value: Number.NaN, color: "b" },
		]);
		expect(split.segments).toHaveLength(1);
		expect(split.total).toBe(10);
	});
});

describe("buildComparisonDelta", () => {
	it("reads a fall as down and a rise as up", () => {
		expect(buildComparisonDelta(2.42, 2.63)).toEqual({
			direction: "down",
			percent: 8,
		});
		expect(buildComparisonDelta(128.74, 112.93)).toEqual({
			direction: "up",
			percent: 14,
		});
	});

	it("reports an unchanged period as flat rather than a 0% rise", () => {
		expect(buildComparisonDelta(100, 100)).toEqual({
			direction: "flat",
			percent: 0,
		});
	});

	it("refuses to compare against nothing", () => {
		expect(buildComparisonDelta(10, 0)).toBeNull();
		expect(buildComparisonDelta(10, -1)).toBeNull();
		expect(buildComparisonDelta(Number.NaN, 10)).toBeNull();
	});
});

describe("buildColumnChart", () => {
	const points = [
		{ label: "late Jul", value: 310 },
		{ label: "", value: 420 },
		{ label: "", value: 388 },
		{ label: "Aug", value: 512 },
		{ label: "", value: 470 },
		{ label: "", value: 604 },
		{ label: "this week", value: 690 },
	];

	it("scales every bar against the tallest", () => {
		const chart = buildColumnChart(points);
		expect(chart.peak).toBe(690);
		expect(chart.columns[6].heightPct).toBe(100);
		expect(chart.columns[0].heightPct).toBe(45);
	});

	it("marks the last column as the period still running", () => {
		const chart = buildColumnChart(points);
		expect(chart.columns.filter((column) => column.current)).toHaveLength(1);
		expect(chart.columns[6].current).toBe(true);
	});

	it("lets the caller move which column is the current one", () => {
		const chart = buildColumnChart(points, { currentIndex: 3 });
		expect(chart.columns[3].current).toBe(true);
		expect(chart.columns[6].current).toBe(false);
	});

	it("puts gridlines every quarter", () => {
		expect(buildColumnChart(points).gridlines).toEqual([0, 25, 50, 75, 100]);
	});

	it("keeps a tiny-but-real period visible", () => {
		const chart = buildColumnChart([
			{ label: "a", value: 1 },
			{ label: "b", value: 100_000 },
		]);
		expect(chart.columns[0].heightPct).toBe(3);
	});

	it("gives a period that recorded nothing no bar at all", () => {
		const chart = buildColumnChart([
			{ label: "a", value: 500 },
			{ label: "b", value: 0 },
			{ label: "c", value: 1 },
		]);
		// A floor under a zero would draw an empty month at the same height as
		// a month with real spend in it.
		expect(chart.columns[1].heightPct).toBe(0);
		expect(chart.columns[2].heightPct).toBe(3);
	});

	it("draws nothing above the axis for an all-zero series", () => {
		const chart = buildColumnChart([
			{ label: "a", value: 0 },
			{ label: "b", value: 0 },
		]);
		expect(chart.empty).toBe(true);
		expect(chart.columns.every((column) => column.heightPct === 0)).toBe(true);
	});

	it("is empty for no points at all", () => {
		const chart = buildColumnChart([]);
		expect(chart.empty).toBe(true);
		expect(chart.columns).toEqual([]);
		expect(chart.peak).toBe(0);
	});

	it("thins the x-axis but always labels the ends", () => {
		const many = Array.from({ length: 12 }, (_, index) => ({
			label: `m${index}`,
			value: index + 1,
		}));
		const chart = buildColumnChart(many, { labelEvery: 4 });
		expect(chart.columns[0].labelled).toBe(true);
		expect(chart.columns[11].labelled).toBe(true);
		expect(chart.columns[1].labelled).toBe(false);
		expect(chart.columns[4].labelled).toBe(true);
	});
});

describe("formatCompactNumber", () => {
	it("shortens millions and billions to one decimal", () => {
		expect(formatCompactNumber(18_400_000)).toBe("18.4M");
		expect(formatCompactNumber(312_000_000)).toBe("312.0M");
		expect(formatCompactNumber(2_500_000_000)).toBe("2.5B");
	});

	it("shortens ten thousands and leaves smaller numbers grouped", () => {
		expect(formatCompactNumber(41_208)).toBe("41K");
		expect(formatCompactNumber(4_812)).toBe("4,812");
		expect(formatCompactNumber(312)).toBe("312");
	});

	it("is zero for nothing", () => {
		expect(formatCompactNumber(0)).toBe("0");
		expect(formatCompactNumber(null)).toBe("0");
		expect(formatCompactNumber(undefined)).toBe("0");
	});
});

describe("monthly series order", () => {
	// The read model hands its months oldest-first and the e2e fixtures
	// newest-first. Both have to draw forwards and compare backwards.
	const ascending = [
		{ month: "2026-06", totalCostUsd: 100 },
		{ month: "2026-07", totalCostUsd: 110 },
		{ month: "2026-08", totalCostUsd: 120 },
	];
	const descending = [...ascending].reverse();

	it("finds the previous month by key, whichever way the list runs", () => {
		for (const series of [ascending, descending]) {
			expect(findPreviousMonth(series, "2026-08")?.month).toBe("2026-07");
			expect(findPreviousMonth(series, "2026-07")?.month).toBe("2026-06");
			// Nothing precedes the oldest month, and a month not in the series
			// still resolves against whatever came before it.
			expect(findPreviousMonth(series, "2026-06")).toBeNull();
			expect(findPreviousMonth(series, "2026-09")?.month).toBe("2026-08");
		}
	});

	it("charts oldest first, so the solid last column really is the current one", () => {
		for (const series of [ascending, descending]) {
			const points = monthlyChartPoints(series, (row) => ({
				label: row.month,
				value: row.totalCostUsd,
			}));
			expect(points.map((point) => point.label)).toEqual([
				"2026-06",
				"2026-07",
				"2026-08",
			]);
			const chart = buildColumnChart(points);
			expect(chart.columns.at(-1)?.label).toBe("2026-08");
			expect(chart.columns.at(-1)?.current).toBe(true);
		}
	});
});
