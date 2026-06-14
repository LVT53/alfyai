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
	if (!chart || chart.type !== "chart") {
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
});
