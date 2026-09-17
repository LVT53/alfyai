import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type GeneratedDocumentChartBlock,
	validateGeneratedDocumentSource,
} from "../source-schema";
import { renderChartSvg } from "./chart-svg";

function readChartBlock() {
	const fixture = JSON.parse(
		readFileSync(
			path.resolve(
				"fixtures/file-production/standard-report/positive/chart-heavy-report.json",
			),
			"utf8",
		),
	) as { documentSource: unknown };
	const validation = validateGeneratedDocumentSource(fixture.documentSource);
	if (!validation.ok) {
		throw new Error(validation.code);
	}
	const chart = validation.source.blocks.find(
		(block) => block.type === "chart" && block.chartType === "line",
	);
	if (chart?.type !== "chart") {
		throw new Error("Fixture chart block is missing.");
	}
	return chart;
}

describe("generated document chart SVG renderer", () => {
	it("renders deterministic accessible SVG for the first line-chart path", () => {
		const chart = readChartBlock();
		const first = renderChartSvg(chart);
		const second = renderChartSvg(chart);

		expect(first).toEqual(second);
		expect(first.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
		expect(first.svg).toContain('role="img"');
		expect(first.svg).toContain(
			'<title id="chart-title">Weekly active users</title>',
		);
		expect(first.svg).toContain(
			'<desc id="chart-desc">Weekly active users rose from 1200 to 1630.</desc>',
		);
		expect(first.svg).toContain("<polyline");
		expect(first.svg).toContain('stroke="#B65F3D"');
		expect(first.svg).not.toContain("<script");
		expect(first.dataPointCount).toBe(3);
	});

	it("renders every v1 chart type deterministically with accessible metadata", () => {
		const charts: GeneratedDocumentChartBlock[] = [
			{
				type: "chart",
				chartType: "bar",
				title: "Bar chart",
				caption: "Bar caption",
				altText: "Bar alt text.",
				units: "items",
				xKey: "label",
				yKey: "value",
				data: [
					{ label: "A", value: 10 },
					{ label: "B", value: 16 },
				],
			},
			{
				type: "chart",
				chartType: "stackedBar",
				title: "Stacked chart",
				caption: "Stacked caption",
				altText: "Stacked alt text.",
				units: "items",
				xKey: "label",
				yKey: "value",
				seriesKey: "series",
				data: [
					{ label: "A", series: "North", value: 10 },
					{ label: "A", series: "South", value: 5 },
					{ label: "B", series: "North", value: 12 },
					{ label: "B", series: "South", value: 8 },
				],
			},
			{
				type: "chart",
				chartType: "area",
				title: "Area chart",
				caption: "Area caption",
				altText: "Area alt text.",
				units: "items",
				xKey: "label",
				yKey: "value",
				data: [
					{ label: "A", value: 10 },
					{ label: "B", value: 16 },
				],
			},
			{
				type: "chart",
				chartType: "scatter",
				title: "Scatter chart",
				caption: "Scatter caption",
				altText: "Scatter alt text.",
				units: "items",
				xKey: "x",
				yKey: "y",
				data: [
					{ x: 1, y: 10 },
					{ x: 2, y: 16 },
				],
			},
			{
				type: "chart",
				chartType: "pie",
				title: "Pie chart",
				caption: "Pie caption",
				altText: "Pie alt text.",
				units: "share",
				labelKey: "label",
				valueKey: "value",
				data: [
					{ label: "A", value: 10 },
					{ label: "B", value: 16 },
				],
			},
			{
				type: "chart",
				chartType: "donut",
				title: "Donut chart",
				caption: "Donut caption",
				altText: "Donut alt text.",
				units: "share",
				labelKey: "label",
				valueKey: "value",
				data: [
					{ label: "A", value: 10 },
					{ label: "B", value: 16 },
				],
			},
		];

		for (const chart of charts) {
			const first = renderChartSvg(chart);
			const second = renderChartSvg(chart);
			expect(first).toEqual(second);
			expect(first.svg).toContain(`>${chart.title}</title>`);
			expect(first.svg).toContain(chart.altText ?? "");
			expect(first.svg).toContain("data-chart-type");
			expect(first.dataPointCount).toBeGreaterThan(0);
		}
	});

	it("throws for missing cartesian axis keys", () => {
		expect(() =>
			renderChartSvg({
				type: "chart",
				chartType: "line",
				title: "Missing keys",
				xKey: null,
				yKey: "value",
				data: [{ value: 12 }],
			}),
		).toThrow("Cartesian charts require xKey and yKey.");
	});

	it("groups y-axis figures in the report's language", () => {
		// A Hungarian report's chrome is Hungarian (reportChrome in
		// standard-report-html) but its axis figures were pinned to en-US, so
		// a chart under a "Szakaszok" heading counted in American thousands.
		const chart: GeneratedDocumentChartBlock = {
			type: "chart",
			chartType: "line",
			title: "Nagy számok",
			xKey: "label",
			yKey: "value",
			data: [
				{ label: "A", value: 0 },
				{ label: "B", value: 1_200_000 },
			],
		};

		const english = renderChartSvg(chart, { language: "en" }).svg;
		const hungarian = renderChartSvg(chart, { language: "hu" }).svg;

		// The axis is drawn on rounded ticks, so 1,500,000 is the top one.
		expect(english).toContain(">1,500,000<");
		// hu-HU groups with a non-breaking space, not a comma.
		expect(hungarian).toContain(">1 500 000<");
		expect(hungarian).not.toContain(">1,500,000<");
	});

	it("still renders English when no language is given", () => {
		// Every existing caller passed nothing; none of them may change.
		const chart = readChartBlock();
		expect(renderChartSvg(chart)).toEqual(
			renderChartSvg(chart, { language: "en" }),
		);
	});

	it("throws for stacked bar charts without a series key", () => {
		expect(() =>
			renderChartSvg({
				type: "chart",
				chartType: "stackedBar",
				title: "Missing series",
				xKey: "label",
				yKey: "value",
				data: [
					{ label: "A", value: 10 },
					{ label: "B", value: 5 },
				],
			}),
		).toThrow("Stacked bar charts require seriesKey.");
	});
});
