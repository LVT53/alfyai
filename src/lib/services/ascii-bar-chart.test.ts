import { describe, expect, it } from "vitest";

import {
	asciiBarChartToChartJs,
	hasBarChars,
	isBarOnlyCell,
	parseAsciiBarChart,
	parseNumericCell,
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
