import { describe, expect, it } from "vitest";

import { validateGeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";

import {
	type NormalizedProduceFileInput,
	normalizeProduceFileInput,
} from "./produce-file";

function documentBlocks(
	input: Partial<Parameters<typeof normalizeProduceFileInput>[0]>,
): Array<Record<string, unknown>> {
	const result = normalizeProduceFileInput({
		requestTitle: "Test report",
		sourceMode: "document_source",
		...input,
	});
	if (!result.ok) {
		throw new Error(`expected ok result, got error: ${result.error}`);
	}
	const documentSource = (result.input as NormalizedProduceFileInput)
		.documentSource;
	return (documentSource?.blocks as Array<Record<string, unknown>>) ?? [];
}

describe("markdownishTextToBlocks (via normalizeProduceFileInput content path)", () => {
	it("converts a GFM pipe table into a table block", () => {
		const blocks = documentBlocks({
			content: [
				"# Prices",
				"",
				"| Brand | 30g price |",
				"|---|---|",
				"| Riverstone | €24.25 |",
				"| Cutters Choice | €25.75 |",
			].join("\n"),
		});

		const table = blocks.find((block) => block.type === "table");
		expect(table).toBeTruthy();
		expect(table?.columns).toEqual([
			{ key: "brand", label: "Brand" },
			{ key: "30g_price", label: "30g price" },
		]);
		expect(table?.rows).toEqual([
			{ brand: "Riverstone", "30g_price": "€24.25" },
			{ brand: "Cutters Choice", "30g_price": "€25.75" },
		]);
	});

	it("converts a ```chart Chart.js fence into a chart block", () => {
		const chartConfig = {
			type: "bar",
			data: {
				labels: ["Riverstone", "Cutters Choice"],
				datasets: [{ label: "Price", data: [24.25, 25.75] }],
			},
			options: { plugins: { title: { text: "Price per 30g pouch" } } },
		};
		const blocks = documentBlocks({
			content: [
				"Here is the chart:",
				"",
				"```chart",
				JSON.stringify(chartConfig),
				"```",
			].join("\n"),
		});

		const chart = blocks.find((block) => block.type === "chart");
		expect(chart).toBeTruthy();
		expect(chart?.chartType).toBe("bar");
		expect(chart?.title).toBe("Price per 30g pouch");
		expect(chart?.data).toEqual(chartConfig.data);
	});

	it("falls back to a table block for an unsupported Chart.js chart type", () => {
		const chartConfig = {
			type: "radar",
			data: {
				labels: ["Riverstone", "Cutters Choice"],
				datasets: [{ label: "Price", data: [24.25, 25.75] }],
			},
		};
		const blocks = documentBlocks({
			content: ["```chart", JSON.stringify(chartConfig), "```"].join("\n"),
		});

		const table = blocks.find((block) => block.type === "table");
		expect(table).toBeTruthy();
		expect(table?.rows).toEqual([
			{ label: "Riverstone", price: 24.25 },
			{ label: "Cutters Choice", price: 25.75 },
		]);
	});

	it("converts an ASCII bar chart in a bare fence into a chart block", () => {
		const blocks = documentBlocks({
			content: [
				"```",
				"Price per 30g pouch (one block = €1)",
				"Riverstone       ████████████████████████░░░░  €24.25",
				"Cutters Choice   █████████████████████████░░░  €25.75",
				"```",
			].join("\n"),
		});

		const chart = blocks.find((block) => block.type === "chart");
		expect(chart).toBeTruthy();
		expect(chart?.chartType).toBe("bar");
		expect(chart?.xKey).toBe("label");
		expect(chart?.yKey).toBe("value");
		expect(chart?.data).toEqual([
			{ label: "Riverstone", value: 24.25 },
			{ label: "Cutters Choice", value: 25.75 },
		]);
	});

	it("converts a ```csv fence into a table block", () => {
		const blocks = documentBlocks({
			content: ["```csv", "Brand,Price", "Riverstone,24.25", "```"].join("\n"),
		});

		const table = blocks.find((block) => block.type === "table");
		expect(table).toBeTruthy();
		expect(table?.columns).toEqual([
			{ key: "brand", label: "Brand" },
			{ key: "price", label: "Price" },
		]);
		expect(table?.rows).toEqual([{ brand: "Riverstone", price: "24.25" }]);
	});

	it("converts a numbered list into a numbered list block", () => {
		const blocks = documentBlocks({
			content: ["1. First step", "2. Second step", "3. Third step"].join("\n"),
		});

		const list = blocks.find((block) => block.type === "list");
		expect(list).toBeTruthy();
		expect(list?.style).toBe("numbered");
		expect(list?.items).toEqual(["First step", "Second step", "Third step"]);
	});

	it("converts a callout into a callout block", () => {
		const blocks = documentBlocks({
			content: ["> [!TIP] Save money", "> Buy in bulk."].join("\n"),
		});

		const callout = blocks.find((block) => block.type === "callout");
		expect(callout).toBeTruthy();
		expect(callout?.tone).toBe("tip");
		expect(callout?.title).toBe("Save money");
		expect(callout?.text).toBe("Buy in bulk.");
	});

	it("converts a generic fence into a code block", () => {
		const blocks = documentBlocks({
			content: ["```python", "print('hi')", "```"].join("\n"),
		});

		const code = blocks.find((block) => block.type === "code");
		expect(code).toBeTruthy();
		expect(code?.language).toBe("python");
		expect(code?.text).toBe("print('hi')");
	});
});

describe("normalizeDocumentSourceEnvelope block repair", () => {
	it("repairs a single-line paragraph pipe table", () => {
		const flattened = [
			"| Brand | 30g price |",
			"|---|---|",
			"| Riverstone | €24.25 |",
			"| Cutters Choice | €25.75 |",
		].join(" ");
		const blocks = documentBlocks({
			documentSource: {
				blocks: [{ type: "paragraph", text: flattened }],
			},
		});

		const table = blocks.find((block) => block.type === "table");
		expect(table).toBeTruthy();
		expect(table?.columns).toMatchObject([
			{ key: "brand", label: "Brand" },
			{ key: "30g_price", label: "30g price" },
		]);
		expect(table?.rows).toEqual([
			{ brand: "Riverstone", "30g_price": "€24.25" },
			{ brand: "Cutters Choice", "30g_price": "€25.75" },
		]);
	});

	it("repairs a backtick-wrapped ASCII bar chart paragraph", () => {
		const flattened =
			"`` Price per 30g pouch (one block = €1) Riverstone ████████████████████████░░░░ €24.25 Cutters Choice █████████████████████████░░░ €25.75 ``";
		const blocks = documentBlocks({
			documentSource: {
				blocks: [{ type: "paragraph", text: flattened }],
			},
		});

		const chart = blocks.find((block) => block.type === "chart");
		expect(chart).toBeTruthy();
		expect(chart?.chartType).toBe("bar");
		expect(chart?.data).toEqual([
			{ label: "Riverstone", value: 24.25 },
			{ label: "Cutters Choice", value: 25.75 },
		]);
	});

	it("splices multi-line markdown embedded in a single paragraph block", () => {
		const embedded = ["## Findings", "- First item", "- Second item"].join(
			"\n",
		);
		const blocks = documentBlocks({
			documentSource: {
				blocks: [{ type: "paragraph", text: embedded }],
			},
		});

		expect(blocks.some((block) => block.type === "heading")).toBe(true);
		expect(blocks.some((block) => block.type === "list")).toBe(true);
	});

	it("leaves non-paragraph blocks untouched", () => {
		const blocks = documentBlocks({
			documentSource: {
				blocks: [
					{ type: "heading", level: 2, text: "Untouched heading" },
					{ type: "paragraph", text: "A normal paragraph with no markdown." },
				],
			},
		});

		expect(blocks).toEqual([
			{ type: "heading", level: 2, text: "Untouched heading" },
			{ type: "paragraph", text: "A normal paragraph with no markdown." },
		]);
	});
});

describe("document source repair — title, dividers, escapes", () => {
	it("drops a leading H1 that repeats the document title, converts dividers and unescapes markdown", () => {
		const blocks = documentBlocks({
			requestTitle: "Ireland Tobacco & Travel Brief",
			documentSource: {
				title: "Ireland Tobacco & Travel Brief",
				blocks: [
					{ type: "heading", level: 1, text: "Ireland Tobacco & Travel Brief" },
					{
						type: "paragraph",
						text: "\\* 30g yields 40–60 sticks.\n\n---\n\nAfter the rule.",
					},
				],
			},
		});
		expect(blocks[0]?.type).not.toBe("heading");
		expect(blocks.map((block) => block.type)).toEqual([
			"paragraph",
			"divider",
			"paragraph",
		]);
		expect(blocks[0]?.text).toBe("* 30g yields 40–60 sticks.");
	});
});

describe("document source repair — model-shaped blocks", () => {
	it("infers missing block types, flattens nested chart blocks and fills chart defaults", () => {
		const blocks = documentBlocks({
			requestTitle: "Tobacco Cost Visualisation",
			documentSource: {
				blocks: [
					{ level: 1, text: "Tobacco Cost Visualisation" },
					{ text: "A simple visual summary." },
					{ level: 2, text: "Monthly Tobacco Costs" },
					{
						columns: [
							{ key: "scenario", label: "Usage / Band" },
							{ key: "cost", label: "Monthly Cost (€)" },
						],
						rows: [
							{ scenario: "10/day, low band", cost: "121" },
							{ scenario: "20/day, high band", cost: "407" },
						],
					},
					{
						chart: {
							chartType: "bar",
							title: "Monthly Tobacco Costs",
							labelKey: "scenario",
							valueKey: "cost",
							data: [
								{ scenario: "10/day, low", cost: 121 },
								{ scenario: "20/day, high", cost: 407 },
							],
						},
					},
					{ style: "bullet", items: ["Riverstone is cheapest."] },
				],
			},
		});
		expect(blocks.map((block) => block.type)).toEqual([
			"paragraph",
			"heading",
			"table",
			"chart",
			"list",
		]);
		const chart = blocks[3];
		expect(chart.xKey).toBe("scenario");
		expect(chart.yKey).toBe("cost");
		expect(chart.caption).toBeTruthy();
		expect(chart.altText).toBeTruthy();
		expect(chart.units).toBeTruthy();
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Tobacco Cost Visualisation",
			blocks,
		});
		expect(validation.ok).toBe(true);
	});

	it("converts currency strings in chart data to numbers and records the unit", () => {
		const blocks = documentBlocks({
			documentSource: {
				blocks: [
					{
						type: "chart",
						chartType: "doughnut",
						title: "Pouch prices",
						data: [
							{ brand: "Riverstone", price: "€24.25" },
							{ brand: "Amber Leaf", price: "€27.10" },
						],
					},
				],
			},
		});
		const chart = blocks[0];
		expect(chart.chartType).toBe("donut");
		expect(chart.labelKey).toBe("brand");
		expect(chart.valueKey).toBe("price");
		expect(chart.units).toBe("€");
		expect(chart.data).toEqual([
			{ brand: "Riverstone", price: 24.25 },
			{ brand: "Amber Leaf", price: 27.1 },
		]);
	});

	it("drops a bar-only table column and adds the chart it stood in for, once", () => {
		const blocks = documentBlocks({
			requestTitle: "Tobacco Cost Visualisation",
			documentSource: {
				title: "Tobacco Cost Visualisation",
				blocks: [
					{ type: "heading", level: 1, text: "Tobacco Cost Visualisation" },
					{
						type: "table",
						columns: [
							{ key: "usage_band", label: "Usage / Band" },
							{ key: "monthly_cost", label: "Monthly Cost" },
							{ key: "relative_scale", label: "Relative Scale" },
						],
						rows: [
							{
								usage_band: "10/day, low band",
								monthly_cost: "€121",
								relative_scale: "██████",
							},
							{
								usage_band: "20/day, high band",
								monthly_cost: "€407",
								relative_scale: "████████████████████",
							},
						],
					},
					{
						type: "code",
						language: "text",
						text: "Monthly cost\nScale: each █ ≈ €20\n\n10/day, low band    €121 ██████\n20/day, high band   €407 ████████████████████",
					},
					{ type: "heading", level: 2, text: "Key Observations" },
				],
			},
		});
		expect(blocks.map((block) => block.type)).toEqual([
			"table",
			"chart",
			"heading",
		]);
		const table = blocks[0];
		expect((table.columns as Array<{ key: string }>).map((c) => c.key)).toEqual(
			["usage_band", "monthly_cost"],
		);
		expect((table.rows as Array<Record<string, unknown>>)[0]).toEqual({
			usage_band: "10/day, low band",
			monthly_cost: "€121",
		});
		const chart = blocks[1];
		expect(chart.chartType).toBe("bar");
		expect(chart.units).toBe("€");
		expect(chart.data).toEqual([
			{ label: "10/day, low band", value: 121 },
			{ label: "20/day, high band", value: 407 },
		]);
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Tobacco Cost Visualisation",
			blocks,
		});
		expect(validation.ok).toBe(true);
	});

	it("promotes a leading H1 to the title when the model gave none, and matches titles loosely", () => {
		const result = normalizeProduceFileInput({
			requestTitle: "tobacco-cost-visualisation",
			sourceMode: "document_source",
			documentSource: {
				blocks: [
					{ type: "heading", level: 1, text: "Tobacco Cost Visualisation" },
					{
						type: "paragraph",
						text: "Enough substantive content to pass the size checks for this document.",
					},
				],
			},
		});
		if (!result.ok) throw new Error(result.error);
		const documentSource = (result.input as NormalizedProduceFileInput)
			.documentSource as Record<string, unknown>;
		expect(documentSource.title).toBe("Tobacco Cost Visualisation");
		expect(
			(documentSource.blocks as Array<Record<string, unknown>>).map(
				(b) => b.type,
			),
		).toEqual(["paragraph"]);
	});
});

describe("document source repair — provisional table chart vs model chart", () => {
	it("replaces the table-derived chart with the model's ASCII chart over the same categories", () => {
		const blocks = documentBlocks({
			documentSource: {
				blocks: [
					{
						type: "table",
						columns: [
							{ key: "usage", label: "Usage / Band" },
							{ key: "monthly", label: "Monthly" },
							{ key: "annual", label: "Annual" },
							{ key: "scale", label: "Visual scale" },
						],
						rows: [
							{
								usage: "10/day, low band",
								monthly: "€121",
								annual: "€1,452",
								scale: "██████",
							},
							{
								usage: "10/day, high band",
								monthly: "€217",
								annual: "€2,604",
								scale: "███████████",
							},
							{
								usage: "20/day, low band",
								monthly: "€243",
								annual: "€2,916",
								scale: "████████████",
							},
							{
								usage: "20/day, high band",
								monthly: "€407",
								annual: "€4,884",
								scale: "████████████████████",
							},
						],
					},
					{
						type: "code",
						language: "text",
						text: "Monthly cost\nScale: 1 █ ≈ €20\n\n10/day, low   €121  ██████\n10/day, high  €217  ███████████\n20/day, low   €243  ████████████\n20/day, high  €407  ████████████████████",
					},
				],
			},
		});
		expect(blocks.map((block) => block.type)).toEqual(["table", "chart"]);
		const chart = blocks[1];
		expect(chart.title).toBe("Monthly cost");
		expect(
			(chart.data as Array<{ value: number }>).map((row) => row.value),
		).toEqual([121, 217, 243, 407]);
		expect("derived" in chart).toBe(false);
	});
});
