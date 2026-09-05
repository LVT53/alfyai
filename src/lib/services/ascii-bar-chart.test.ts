import { describe, expect, it } from "vitest";

import { asciiBarChartToChartJs, parseAsciiBarChart } from "./ascii-bar-chart";

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
		expect(chart?.units).toBe("€20");
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
