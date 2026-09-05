import { describe, expect, it } from "vitest";

import {
	asciiBarChartToChartJs,
	barFillLength,
	hasBarChars,
	isBarOnlyCell,
	legendPerBlock,
	parseAsciiBarChart,
	parseNumericCell,
	pickBarMatchedColumn,
} from "./ascii-bar-chart";

describe("parseAsciiBarChart", () => {
	it("parses euro-prefixed values with decimal points", () => {
		const chart = parseAsciiBarChart(
			[
				"Riverstone       ████████████████████████░░░░  €24.25",
				"Cutters Choice   █████████████████████████░░░  €25.75",
			].join("\n"),
		);

		expect(chart).toEqual({
			units: "€",
			points: [
				{ label: "Riverstone", value: 24.25 },
				{ label: "Cutters Choice", value: 25.75 },
			],
		});
	});

	it("parses approximate values marked with ~", () => {
		const chart = parseAsciiBarChart(
			[
				"Riverstone       ████████████████░░░░  ~€13",
				"Cutters Choice   ██████████████████░░░░  ~€15",
			].join("\n"),
		);

		expect(chart).not.toBeNull();
		expect(chart?.points).toEqual([
			{ label: "Riverstone", value: 13 },
			{ label: "Cutters Choice", value: 15 },
		]);
	});

	it("reads a legend line declaring the unit per block", () => {
		const chart = parseAsciiBarChart(
			[
				"one block = €20",
				"Riverstone       ████████████████████████░░░░  480",
				"Cutters Choice   █████████████████████████░░░  510",
			].join("\n"),
		);

		expect(chart).not.toBeNull();
		expect(chart?.units).toBe("€");
		expect(chart?.points).toEqual([
			{ label: "Riverstone", value: 480 },
			{ label: "Cutters Choice", value: 510 },
		]);
	});

	it("reads a leading title line", () => {
		const chart = parseAsciiBarChart(
			[
				"Price per 30g pouch",
				"Riverstone       ████████████████████████░░░░  €24.25",
				"Cutters Choice   █████████████████████████░░░  €25.75",
			].join("\n"),
		);

		expect(chart?.title).toBe("Price per 30g pouch");
		expect(chart?.points).toHaveLength(2);
	});

	it("returns null for text that is not an ASCII bar chart", () => {
		expect(
			parseAsciiBarChart(
				["This is just a normal paragraph.", "It has two lines of prose."].join(
					"\n",
				),
			),
		).toBeNull();
	});

	it("returns null for a single bar (needs at least two)", () => {
		expect(
			parseAsciiBarChart(
				"Riverstone       ████████████████████████░░░░  €24.25",
			),
		).toBeNull();
	});

	it("converts a parsed chart into a Chart.js bar config", () => {
		const chart = parseAsciiBarChart(
			[
				"Riverstone       ████████████████████████░░░░  €24.25",
				"Cutters Choice   █████████████████████████░░░  €25.75",
			].join("\n"),
		);
		expect(chart).not.toBeNull();
		if (!chart) return;

		const chartJs = asciiBarChartToChartJs(chart);
		expect(chartJs).toEqual({
			type: "bar",
			data: {
				labels: ["Riverstone", "Cutters Choice"],
				datasets: [
					{
						label: "Value (€)",
						data: [24.25, 25.75],
					},
				],
			},
		});
	});

	it("includes a Chart.js title plugin config when the chart has a title", () => {
		const chart = parseAsciiBarChart(
			[
				"Price per 30g pouch",
				"Riverstone       ████████████████████████░░░░  €24.25",
				"Cutters Choice   █████████████████████████░░░  €25.75",
			].join("\n"),
		);
		expect(chart).not.toBeNull();
		if (!chart) return;

		const chartJs = asciiBarChartToChartJs(chart);
		expect(chartJs.options).toEqual({
			plugins: { title: { display: true, text: "Price per 30g pouch" } },
		});
	});
});

describe("parseAsciiBarChart — value before the bar and scale legends", () => {
	it("parses lines where the value is printed before the bar", () => {
		const chart = parseAsciiBarChart(
			[
				"Monthly cost",
				"Scale: each █ ≈ €20",
				"",
				"10/day, low    €121 ██████",
				"10/day, high   €217 ███████████",
				"20/day, low    €243 ████████████",
				"20/day, high   €407 ████████████████████",
			].join("\n"),
		);
		expect(chart).not.toBeNull();
		expect(chart?.title).toBe("Monthly cost");
		expect(chart?.units).toBe("€");
		expect(chart?.points).toEqual([
			{ label: "10/day, low", value: 121 },
			{ label: "10/day, high", value: 217 },
			{ label: "20/day, low", value: 243 },
			{ label: "20/day, high", value: 407 },
		]);
	});

	it("takes the unit from an 'each block = kg' legend without the number", () => {
		const chart = parseAsciiBarChart(
			["one block = 10 kg", "Alpha ████ 40", "Beta ██ 20"].join("\n"),
		);
		expect(chart?.units).toBeUndefined();
		const chart2 = parseAsciiBarChart(
			["each ■ ≈ kg", "Alpha ■■■■ 40", "Beta ■■ 20"].join("\n"),
		);
		expect(chart2?.units).toBe("kg");
	});
});

describe("parseNumericCell / bar cell helpers", () => {
	it("parses currency, percent, thousands and decimal-comma cells", () => {
		expect(parseNumericCell("€24.25")).toEqual({ value: 24.25, units: "€" });
		expect(parseNumericCell("13%")).toEqual({ value: 13, units: "%" });
		expect(parseNumericCell("1,200")).toEqual({ value: 1200 });
		expect(parseNumericCell("24,5 kg")).toEqual({ value: 24.5, units: "kg" });
		expect(parseNumericCell(7)).toEqual({ value: 7 });
		expect(parseNumericCell("10/day, low band")).toBeNull();
		expect(parseNumericCell("")).toBeNull();
	});

	it("recognises bar-only cells, with or without backticks", () => {
		expect(isBarOnlyCell("`██████`")).toBe(true);
		expect(isBarOnlyCell("███")).toBe(true);
		expect(isBarOnlyCell("€121 ███")).toBe(false);
		expect(hasBarChars("€121 ███")).toBe(true);
		expect(hasBarChars("€121")).toBe(false);
	});
});

describe("pickBarMatchedColumn / barFillLength", () => {
	it("counts filled bar characters only", () => {
		expect(barFillLength("████░░░░")).toBe(4);
		expect(barFillLength("`██████`")).toBe(6);
		expect(barFillLength("€121")).toBe(0);
	});

	it("chooses the column proportional to the bars, using the legend on ties", () => {
		const bars = [6, 11, 12, 20];
		const annual = { id: "annual", values: [1452, 2604, 2916, 4884] };
		const monthly = { id: "monthly", values: [121, 217, 243, 407] };
		const noise = { id: "noise", values: [5, 900, 3, 77] };
		// Annual is exactly 12× monthly: a tie, resolved by the legend.
		expect(pickBarMatchedColumn(bars, [annual, monthly], 20)).toBe("monthly");
		expect(pickBarMatchedColumn(bars, [monthly, annual], 240)).toBe("annual");
		// No legend: the tie goes to the first (nearest) candidate.
		expect(pickBarMatchedColumn(bars, [annual, monthly])).toBe("annual");
		// A clearly non-proportional column loses to a proportional one.
		expect(pickBarMatchedColumn(bars, [noise, monthly])).toBe("monthly");
		expect(
			pickBarMatchedColumn(bars, [{ id: "only", values: [1, 2, 3, 4] }]),
		).toBe("only");
		expect(pickBarMatchedColumn(bars, [])).toBeNull();
	});

	it("reads the value per block from a legend or column header", () => {
		expect(legendPerBlock("Scale (1 █ ≈ €20)")).toBe(20);
		expect(legendPerBlock("each block = 2.5")).toBe(2.5);
		expect(legendPerBlock("Relative Scale")).toBeNull();
		expect(legendPerBlock(42)).toBeNull();
	});
});
