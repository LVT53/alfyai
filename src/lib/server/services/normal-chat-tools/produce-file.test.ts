import { describe, expect, it } from "vitest";

import { validateGeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";

import {
	applyTextPatches,
	buildNoPatchBaseMessage,
	buildProduceFileRunningPayload,
	buildSameTurnProduceFileArtifactKey,
	buildSameTurnProduceFileDedupeKey,
	buildScopedIdempotencyKey,
	createProduceFileToolCallEntry,
	isInlineTextRequest,
	type NormalizedProduceFileInput,
	normalizeProduceFileInput,
	PATCHES_WITH_OWN_CONTENT_ERROR,
	produceFileInputSchema,
	produceFileModelInputSchema,
	sanitizeProduceFileInput,
	sanitizeUnsafeProduceFileInput,
	summarizeProduceFileResult,
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

// Program mode used to fall back to a `{ type: "file" }` sentinel whenever the
// model named no format. Nothing downstream maps "file" to an extension, so the
// job queued, the sandbox ran the program to completion, and the result was
// discarded with `unsupported_program_output_type`. The type is now either
// derived from something the caller actually said, or the call is refused.
describe("program-mode output type resolution", () => {
	const program = {
		language: "javascript" as const,
		sourceCode: 'workbook.xlsx.writeFile("/output/fruits.xlsx")',
	};

	function normalizeProgram(
		input: Partial<Parameters<typeof normalizeProduceFileInput>[0]>,
	) {
		return normalizeProduceFileInput({
			requestTitle: "Fruit workbook",
			program,
			...input,
		});
	}

	function requestedTypes(
		result: ReturnType<typeof normalizeProduceFileInput>,
	): string[] {
		if (!result.ok) {
			throw new Error(`expected ok result, got error: ${result.error}`);
		}
		return result.input.requestedOutputs.map((output) => output.type);
	}

	it("takes the type from requestedOutputs, the field the built-in skills prescribe", () => {
		expect(
			requestedTypes(
				normalizeProgram({ requestedOutputs: [{ type: "xlsx" }] }),
			),
		).toEqual(["xlsx"]);
	});

	it("takes the type from outputType", () => {
		expect(requestedTypes(normalizeProgram({ outputType: "pptx" }))).toEqual([
			"pptx",
		]);
	});

	it("derives the type from the top-level filename extension", () => {
		expect(
			requestedTypes(normalizeProgram({ filename: "fruits.xlsx" })),
		).toEqual(["xlsx"]);
	});

	it("derives the type from program.filename when nothing else names one", () => {
		expect(
			requestedTypes(
				normalizeProgram({ program: { ...program, filename: "fruits.xlsx" } }),
			),
		).toEqual(["xlsx"]);
	});

	it("prefers an explicit filename over program.filename", () => {
		expect(
			requestedTypes(
				normalizeProgram({
					filename: "fruits.csv",
					program: { ...program, filename: "fruits.xlsx" },
				}),
			),
		).toEqual(["csv"]);
	});

	it("refuses a program call whose output type nothing names, naming valid examples", () => {
		const result = normalizeProgram({});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the call to be refused");
		expect(result.error).toContain(
			"outputType is required for program mode, e.g. xlsx, docx, pptx, pdf, csv, zip",
		);
	});

	it("never invents a 'file' output type from a blank requestedOutputs entry", () => {
		const result = normalizeProgram({
			requestedOutputs: [{ type: "  " }],
			program: { ...program, filename: "fruits.xlsx" },
		});
		expect(requestedTypes(result)).toEqual(["xlsx"]);
	});
});

describe("produceFileModelInputSchema", () => {
	it("accepts requestedOutputs, sourceMode and program — the shape the skills prescribe", () => {
		const parsed = produceFileModelInputSchema.safeParse({
			requestTitle: "Fruit workbook",
			sourceMode: "program",
			requestedOutputs: [{ type: "xlsx" }],
			program: {
				language: "javascript",
				sourceCode: 'workbook.xlsx.writeFile("/output/fruits.xlsx")',
				filename: "fruits.xlsx",
			},
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.requestedOutputs).toEqual([{ type: "xlsx" }]);
	});

	it("tells the model where a program must write", () => {
		expect(produceFileModelInputSchema.shape.program.description).toContain(
			"/output",
		);
	});
});

// `dev` derived the output type with /\.([a-z0-9]+)$/i, so a filename whose
// tail after the last dot is not purely alphanumeric named NO type and the
// caller fell through to its markdown/text/documentSource default. Swapping in
// the registry's `fileExtension` (which returns everything after the last dot)
// turned those tails into bogus output types, and the request is then refused
// as an unsupported type instead of producing the file.
describe("output type derived from a filename", () => {
	function outputsFor(
		input: Partial<Parameters<typeof normalizeProduceFileInput>[0]>,
	): Array<{ type: string }> {
		const result = normalizeProduceFileInput({
			requestTitle: "Test report",
			...input,
		} as Parameters<typeof normalizeProduceFileInput>[0]);
		if (!result.ok) {
			throw new Error(`expected ok result, got error: ${result.error}`);
		}
		return result.input.requestedOutputs;
	}

	const BODY = [
		"# Quarterly summary",
		"",
		"Revenue grew 12% quarter over quarter, driven by the two enterprise",
		"renewals that closed in March. Support load fell for the third quarter",
		"running, and the migration backlog is now under fifty tickets.",
	].join("\n");

	it.each([
		"Q1 vs Q2 (rev. 3)",
		"Report 3.5 Final",
		"Budget v1.2 draft",
		"chart.c++",
	])("ignores the non-extension tail of %s", (filename) => {
		expect(outputsFor({ filename, markdown: BODY })).toEqual([{ type: "md" }]);
	});

	it("still derives a real extension", () => {
		expect(outputsFor({ filename: "summary.xlsx", markdown: BODY })).toEqual([
			{ type: "xlsx" },
		]);
		expect(outputsFor({ filename: "notes.tar.gz", markdown: BODY })).toEqual([
			{ type: "gz" },
		]);
	});
});

// Phase 6 D8 / §4.2. A request whose outputs are ALL plain-text types and whose
// bytes the model supplied verbatim is written by the app, not by a Python
// one-liner inside a Docker container.
describe("inline_text production mode", () => {
	const MARKDOWN = [
		"# Quarterly summary",
		"",
		"Revenue grew 12% quarter over quarter, driven by the two enterprise",
		"renewals that closed in March, and the migration backlog is now under",
		"fifty tickets.",
		"",
		"| Region | Revenue |",
		"|---|---|",
		"| North | €24.25 |",
		"",
		"```python",
		"print('kept verbatim')",
		"```",
	].join("\n");

	const TSV = [
		"region\trevenue\trenewals\tbacklog",
		"North\t24.25\t2\t48",
		"South\t25.75\t3\t31",
		"East\t18.50\t1\t12",
		"West\t31.00\t4\t27",
		"Central\t22.75\t2\t19",
	].join("\n");

	function normalize(
		input: Partial<Parameters<typeof normalizeProduceFileInput>[0]>,
	) {
		return normalizeProduceFileInput({
			requestTitle: "Quarterly summary",
			...input,
		} as Parameters<typeof normalizeProduceFileInput>[0]);
	}

	function expectOk(result: ReturnType<typeof normalizeProduceFileInput>) {
		if (!result.ok) {
			throw new Error(`expected ok result, got error: ${result.error}`);
		}
		return result.input;
	}

	it("classifies a request by whether every output is a plain-text type", () => {
		expect(isInlineTextRequest(["md"])).toBe(true);
		expect(isInlineTextRequest(["txt", "csv", "tsv", "json"])).toBe(true);
		expect(isInlineTextRequest(["py"])).toBe(true);
		// html is text-validated but is a document source: it belongs to the
		// report renderers, not to a verbatim byte copy.
		expect(isInlineTextRequest(["html"])).toBe(false);
		expect(isInlineTextRequest(["pdf"])).toBe(false);
		expect(isInlineTextRequest(["xlsx"])).toBe(false);
		expect(isInlineTextRequest(["md", "pdf"])).toBe(false);
		// The caller's default-type ladder has already run, so an empty list is
		// "nothing named a type", not "every type qualifies".
		expect(isInlineTextRequest([])).toBe(false);
	});

	it("routes a bare markdown call to inline_text with the content verbatim", () => {
		const input = expectOk(normalize({ markdown: MARKDOWN }));

		expect(input.sourceMode).toBe("inline_text");
		expect(input.program).toBeUndefined();
		expect(input.documentSource).toBeUndefined();
		expect(input.inlineText).toEqual({
			content: MARKDOWN,
			files: [{ filename: "quarterly-summary.md", outputType: "md" }],
		});
	});

	it("writes the same bytes the program path would have written", () => {
		// `buildTextFileProgram` embedded `content` in a Python `write_text` call,
		// so the container wrote exactly the (already trimmed) string. The inline
		// mode must hand storage that same string — no reformatting, no added or
		// stripped trailing newline, CRLF left alone.
		const crlf = `${MARKDOWN.replace(/\n/g, "\r\n")}\r\n\r\n`;
		const input = expectOk(normalize({ content: crlf }));

		expect(input.sourceMode).toBe("inline_text");
		// `firstNonEmptyString` trims, exactly as it did for the program path.
		expect(input.inlineText?.content).toBe(crlf.trim());
	});

	it("honours an explicit filename and its extension", () => {
		const input = expectOk(
			normalize({ filename: "Q1 report.tsv", content: TSV }),
		);

		expect(input.sourceMode).toBe("inline_text");
		expect(input.requestedOutputs).toEqual([{ type: "tsv" }]);
		expect(input.inlineText?.files).toEqual([
			{ filename: "Q1 report.tsv", outputType: "tsv" },
		]);
	});

	it("writes one file per requested text output", () => {
		const input = expectOk(
			normalize({
				requestedOutputs: [{ type: "md" }, { type: "txt" }],
				markdown: MARKDOWN,
			}),
		);

		expect(input.sourceMode).toBe("inline_text");
		expect(input.inlineText?.files).toEqual([
			{ filename: "quarterly-summary.md", outputType: "md" },
			{ filename: "quarterly-summary.txt", outputType: "txt" },
		]);
	});

	it("keeps the document-source path for pdf, docx and html", () => {
		for (const type of ["pdf", "docx", "html"]) {
			const input = expectOk(
				normalize({ requestedOutputs: [{ type }], markdown: MARKDOWN }),
			);
			expect(input.sourceMode).toBe("document_source");
			expect(input.inlineText).toBeUndefined();
		}
	});

	it("keeps the sandbox path for xlsx, pptx, odt, zip and svg", () => {
		for (const type of ["xlsx", "pptx", "odt", "zip", "svg"]) {
			const input = expectOk(
				normalize({ requestedOutputs: [{ type }], content: MARKDOWN }),
			);
			expect(input.sourceMode).toBe("program");
			expect(input.inlineText).toBeUndefined();
		}
	});

	// Condition 1 of §4.2: an explicit program-mode request returns two branches
	// earlier and is completely unaffected, markdown output or not.
	it("leaves an explicit program-mode markdown request on the sandbox path", () => {
		const input = expectOk(
			normalize({
				sourceMode: "program",
				requestedOutputs: [{ type: "md" }],
				program: {
					language: "python",
					sourceCode:
						"from pathlib import Path\nPath('/output/notes.md').write_text('# hi')",
					filename: "notes.md",
				},
			}),
		);

		expect(input.sourceMode).toBe("program");
		expect(input.program?.sourceCode).toContain("write_text");
		expect(input.inlineText).toBeUndefined();
	});

	// Condition 2: an explicit documentSource keeps the report renderers even
	// when markdown is among the outputs.
	it("leaves an explicit documentSource markdown request on the renderer path", () => {
		const input = expectOk(
			normalize({
				sourceMode: "document_source",
				requestedOutputs: [{ type: "md" }],
				documentSource: {
					blocks: [
						{
							type: "paragraph",
							text: "Substantive content for the standard report renderer.",
						},
					],
				},
			}),
		);

		expect(input.sourceMode).toBe("document_source");
		expect(input.inlineText).toBeUndefined();
	});

	// Condition 3: `hasSubstantiveContent` still gates the whole content branch.
	it("still refuses placeholder content before choosing a mode", () => {
		const result = normalize({ markdown: "TODO" });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the call to be refused");
		expect(result.error).toContain("Content is too short");
	});

	// Patch resolution needs the PREVIOUS version of the file, which only the
	// tool adapter can fetch, so normalization cannot decide the mode here: a
	// patch-carrying request leaves this function on the program path with its
	// patches attached. Once the adapter HAS the patched bytes it re-runs this
	// function with them as `content`, which is how an all-plain-text patch
	// reaches inline_text — see `produce-file-patch-mode.test.ts`.
	it("keeps a patch-carrying request on the program path so patches still resolve", () => {
		const patchOnly = expectOk(
			normalize({
				filename: "notes.md",
				patches: [{ oldText: "North", newText: "South" }],
			}),
		);
		expect(patchOnly.sourceMode).toBe("program");
		expect(patchOnly.patches).toEqual([{ oldText: "North", newText: "South" }]);
	});

	// A patch brings its own content — the base file plus the edit — so a call
	// that sends patches and nothing else has named no mode it can be held to.
	// Validating the mode it DID name against the content it was never going to
	// send is what refused the live call
	// (`documentSource or content is required when sourceMode is
	// document_source`) and made the model rewrite the whole file. The adapter
	// decides the real mode once it has the patched bytes.
	it.each([
		"document_source",
		"program",
	] as const)("ignores sourceMode %o on a call that carries only patches", (sourceMode) => {
		const patchOnly = expectOk(
			normalize({
				filename: "notes.md",
				sourceMode,
				patches: [{ oldText: "North", newText: "South" }],
			}),
		);
		expect(patchOnly.sourceMode).toBe("program");
		expect(patchOnly.patches).toEqual([{ oldText: "North", newText: "South" }]);
		expect(patchOnly.program?.filename).toBe("notes.md");
	});

	// …and a call that carries BOTH patches and content of its own is refused.
	// It used to be honoured in whichever direction the request happened to
	// point — an explicit mode took the content and threw the patches away, no
	// mode took the patches and threw the content away — and both reported
	// success on a file the model had not asked for. The two claims are
	// contradictory (a patch changes the previous version, content replaces the
	// whole file), so neither half is safe to guess at.
	it.each([
		[
			"content with an explicit mode",
			{ sourceMode: "document_source" as const, markdown: MARKDOWN },
		],
		["content with no mode at all", { markdown: MARKDOWN }],
		[
			"a model-authored documentSource",
			{
				sourceMode: "document_source" as const,
				documentSource: {
					title: "Notes",
					blocks: [{ type: "paragraph" as const, text: MARKDOWN }],
				},
			},
		],
		[
			"a model-authored program",
			{
				outputType: "xlsx",
				sourceMode: "program" as const,
				program: {
					language: "python" as const,
					sourceCode: "print('builds the workbook')",
					filename: "notes.xlsx",
				},
			},
		],
	])("refuses patches sent alongside %s", (_label, rest) => {
		const result = normalize({
			filename: "notes.md",
			...rest,
			patches: [{ oldText: "North", newText: "South" }],
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the call to be refused");
		expect(result.error).toBe(PATCHES_WITH_OWN_CONTENT_ERROR);
		expect(result.error).toContain("not both");
	});

	it("leaves a model-authored program or documentSource in charge", () => {
		const withProgram = expectOk(
			normalize({
				outputType: "xlsx",
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "print('builds the workbook')",
					filename: "notes.xlsx",
				},
			}),
		);
		expect(withProgram.sourceMode).toBe("program");
		expect(withProgram.program?.sourceCode).toContain("builds the workbook");
	});

	it("round-trips applyTextPatches output back through an inline_text produce", () => {
		const patched = applyTextPatches(MARKDOWN, [
			{ oldText: "North", newText: "South" },
		]);
		expect(patched.ok).toBe(true);
		if (!patched.ok) throw new Error(patched.error);

		const input = expectOk(normalize({ markdown: patched.resolvedText }));
		expect(input.sourceMode).toBe("inline_text");
		expect(input.inlineText?.content).toBe(patched.resolvedText);
		expect(input.inlineText?.content).toContain("| South | €24.25 |");
	});
});

// THE SHIPPED BUG (spec §1.4 / §4.2 bonus fix). `[pdf, md]` fails
// `shouldUseDocumentSourceForOutputs` (md is not a document source), so the
// request fell through to program mode and `resolveTextFilename` named the file
// after `requestedOutputs[0]` — `.pdf`. The generated Python one-liner then
// wrote raw markdown into a file called `.pdf`.
describe("mixed document/text output requests", () => {
	const MARKDOWN = [
		"# Quarterly summary",
		"",
		"Revenue grew 12% quarter over quarter, driven by the two enterprise",
		"renewals that closed in March, and the migration backlog is now under",
		"fifty tickets.",
	].join("\n");

	it.each([
		["pdf", "md"],
		["docx", "txt"],
		["html", "md"],
		["pdf", "csv"],
	])("refuses [%s, %s] instead of mis-naming a text file", (first, second) => {
		const result = normalizeProduceFileInput({
			requestTitle: "Quarterly summary",
			requestedOutputs: [{ type: first }, { type: second }],
			markdown: MARKDOWN,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error(
				`expected a refusal, got sourceMode=${result.input.sourceMode} ` +
					`filename=${result.input.program?.filename ?? "-"}`,
			);
		}
		expect(result.error).toContain(`${first}, ${second}`);
		expect(result.error).toContain("Request one group of formats at a time");
		expect(result.error).toContain("documentSource");
	});

	it("refuses the same mix when the model asked for program mode without code", () => {
		const result = normalizeProduceFileInput({
			requestTitle: "Quarterly summary",
			sourceMode: "program",
			requestedOutputs: [{ type: "pdf" }, { type: "md" }],
			markdown: MARKDOWN,
		});

		expect(result.ok).toBe(false);
	});

	// A single pdf with raw markdown and no documentSource already works: the
	// registry says pdf IS a document source, so the content is parsed into
	// blocks and the report renderer produces a real PDF.
	it("still renders a single pdf request through the document source", () => {
		const result = normalizeProduceFileInput({
			requestTitle: "Quarterly summary",
			requestedOutputs: [{ type: "pdf" }],
			markdown: MARKDOWN,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.input.sourceMode).toBe("document_source");
		expect(result.input.documentSource?.blocks).toBeTruthy();
	});

	it("leaves a mixed request alone when the model supplied the program itself", () => {
		const result = normalizeProduceFileInput({
			requestTitle: "Quarterly summary",
			sourceMode: "program",
			requestedOutputs: [{ type: "pdf" }, { type: "md" }],
			program: {
				language: "python",
				sourceCode: "# writes both /output/report.pdf and /output/report.md",
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.input.sourceMode).toBe("program");
	});

	it("leaves a mixed request alone when the model supplied a documentSource", () => {
		const result = normalizeProduceFileInput({
			requestTitle: "Quarterly summary",
			sourceMode: "document_source",
			requestedOutputs: [{ type: "pdf" }, { type: "md" }],
			documentSource: {
				blocks: [
					{
						type: "paragraph",
						text: "Substantive content for the standard report renderer.",
					},
				],
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.input.sourceMode).toBe("document_source");
	});
});

/**
 * THE LIVE FAILURE. Turn 1 produced `release-notes.md` as `inline_text`, and
 * that mode was persisted as the call's `input` — which the next turn replays
 * to the model as its own history. Turn 2 the model imitated it, sent
 * `sourceMode: "inline_text"` with its patches, and the call was REJECTED: the
 * model-facing schema only admits `program` and `document_source`. The retry
 * then lost the filename too, so the user paid two failed tool calls for one
 * edit.
 *
 * Two independent guards, because either one alone leaves a trap: the history
 * must not teach an argument the tool refuses, AND the tool must not refuse a
 * whole request over a field whose value it was going to choose anyway.
 */
describe("what the model's own history teaches it about sourceMode", () => {
	const MARKDOWN = [
		"# Release notes",
		"",
		"Version 2.0 ships the new file production pipeline, with patches for",
		"every format and a read-back tool the model can call by filename.",
		"",
		"Line three names the thing the user will want to change.",
	].join("\n");

	function recordedInput(
		input: Parameters<typeof normalizeProduceFileInput>[0],
	) {
		const normalized = normalizeProduceFileInput(input);
		if (!normalized.ok) throw new Error(normalized.error);
		const payload = {
			ok: true as const,
			status: "succeeded" as const,
			jobId: "job-1",
			files: [
				{
					filename: "release-notes.md",
					mimeType: "text/markdown",
					sizeBytes: 1,
				},
			],
		};
		return createProduceFileToolCallEntry({
			callId: "call-1",
			input: sanitizeProduceFileInput(normalized.input),
			payload,
			outputSummary: summarizeProduceFileResult(payload),
		});
	}

	it("is an input the tool would accept back", () => {
		const entry = recordedInput({
			requestTitle: "Release notes",
			filename: "release-notes.md",
			markdown: MARKDOWN,
		});

		// The mode the SERVER chose is never persisted as an argument…
		expect(entry.input.sourceMode).toBeUndefined();
		// …and the record as a whole replays: this is exactly the object
		// `conversation-history.ts` hands back to the model as its own tool call.
		expect(produceFileModelInputSchema.safeParse(entry.input).success).toBe(
			true,
		);
		// It is still recorded, as what it is: a fact about the run.
		expect(entry.metadata?.sourceMode).toBe("inline_text");
	});

	it("records a paused job as queued, which is what the ledger row says", () => {
		const paused = buildProduceFileRunningPayload({
			jobId: "job-paused",
			productionPaused: true,
		});
		const running = buildProduceFileRunningPayload({ jobId: "job-running" });
		const entryFor = (payload: typeof paused) =>
			createProduceFileToolCallEntry({
				callId: "call-paused",
				input: sanitizeUnsafeProduceFileInput({
					requestTitle: "Release notes",
				}),
				payload,
				outputSummary: summarizeProduceFileResult(payload),
			});

		// The model still hears `running` — the tool description's word for
		// "not ready yet" — and the message beside it says production is
		// paused. The RECORD says what the ledger says.
		expect(paused.status).toBe("running");
		expect(entryFor(paused).metadata?.jobStatus).toBe("queued");
		expect(entryFor(running).metadata?.jobStatus).toBe("running");
		// The human-readable digest is untouched by either.
		expect(summarizeProduceFileResult(paused)).toBe(
			"File production job job-paused is still running; no file exists yet.",
		);
	});

	it("keeps a mode the model itself may send in the input", () => {
		const entry = recordedInput({
			requestTitle: "Fruit workbook",
			requestedOutputs: [{ type: "xlsx" }],
			sourceMode: "program",
			program: {
				language: "python",
				sourceCode: "open('/output/fruits.xlsx','w').write('x')",
				filename: "fruits.xlsx",
			},
		});

		expect(entry.input.sourceMode).toBe("program");
		expect(entry.metadata?.sourceMode).toBeUndefined();
	});

	it("does not persist a mode the model invented", () => {
		const entry = createProduceFileToolCallEntry({
			callId: "call-2",
			input: sanitizeUnsafeProduceFileInput({
				requestTitle: "Release notes",
				sourceMode: "inline_text",
				content: MARKDOWN,
			}),
			payload: {
				ok: false,
				status: "failed",
				errorCode: "invalid_tool_input",
				message: "nope",
				retryable: true,
			},
			outputSummary: "File production failed (invalid_tool_input): nope",
		});

		// The refusal record is replayed too (`conversation-history.ts` strips the
		// content digest beside it), so it must not carry the value back either.
		expect(entry.input.sourceMode).toBeUndefined();
		expect(entry.metadata?.sourceMode).toBe("inline_text");
	});

	it.each([
		"inline_text",
		"auto",
		"",
	])("accepts a call whose sourceMode is %o and lets the server choose", (sourceMode) => {
		const raw = {
			requestTitle: "Release notes",
			filename: "release-notes.md",
			sourceMode,
			markdown: MARKDOWN,
		};

		// The schema the SDK validates the raw tool call against…
		const model = produceFileModelInputSchema.safeParse(raw);
		expect(model.success).toBe(true);
		// …and the one `execute` parses with.
		const parsed = produceFileInputSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.sourceMode).toBeUndefined();

		const normalized = normalizeProduceFileInput(parsed.data);
		expect(normalized.ok).toBe(true);
		if (!normalized.ok) return;
		expect(normalized.input.sourceMode).toBe("inline_text");
	});
});

describe("what a produced file's digest tells the next turn", () => {
	it("names the file for reading it back AND for changing it", () => {
		const payload = {
			ok: true as const,
			status: "succeeded" as const,
			jobId: "job-1",
			files: [
				{
					filename: "release-notes.md",
					mimeType: "text/markdown",
					sizeBytes: 12,
				},
			],
		};
		const entry = createProduceFileToolCallEntry({
			callId: "call-1",
			input: {},
			payload,
			outputSummary: summarizeProduceFileResult(payload),
		});

		expect(entry.resultDigest).toBe(
			'Read it back with read_generated_file({filename:"release-notes.md"}). Change it with produce_file patches on "release-notes.md".',
		);
		// The digest is paid on every turn the call stays in the window, so it
		// stays well inside the ~100-token budget (4 chars ≈ 1 token).
		expect(
			Math.ceil((entry.resultDigest?.length ?? 0) / 4),
		).toBeLessThanOrEqual(100);
	});
});

describe("the refusal for a patch with no base", () => {
	it("names the files the model can choose between", () => {
		const message = buildNoPatchBaseMessage([
			"release-notes.md",
			"changelog.md",
		]);
		expect(message).toContain("release-notes.md, changelog.md");
		expect(message).toContain("filename");
	});

	it("keeps the old wording when this conversation produced nothing", () => {
		expect(buildNoPatchBaseMessage([])).toBe(
			"No previous version of this file could be found. Use content, markdown, or text to create the initial version instead of patches.",
		);
	});
});

describe("same-turn dedupe and intake idempotency keys", () => {
	const base = (text: string): NormalizedProduceFileInput => ({
		requestTitle: "Quarterly report",
		requestedOutputs: [{ type: "pdf" }],
		sourceMode: "document_source",
		documentSource: {
			version: 1,
			template: "alfyai_standard_report",
			title: "Quarterly report",
			blocks: [{ type: "paragraph", text }],
		},
	});
	const program = (sourceCode: string): NormalizedProduceFileInput => ({
		requestTitle: "Budget",
		requestedOutputs: [{ type: "xlsx" }],
		sourceMode: "program",
		program: { language: "python", sourceCode, filename: "budget.xlsx" },
	});

	it("replays only a byte-identical resend of the same artifact", () => {
		expect(buildSameTurnProduceFileDedupeKey(base("a"))).toBe(
			buildSameTurnProduceFileDedupeKey(base("a")),
		);
		expect(buildSameTurnProduceFileDedupeKey(base("a"))).not.toBe(
			buildSameTurnProduceFileDedupeKey(base("b")),
		);
		expect(buildSameTurnProduceFileDedupeKey(program("x = 1"))).not.toBe(
			buildSameTurnProduceFileDedupeKey(program("x = 2")),
		);
	});

	it("keeps one artifact key across content corrections, so the resubmission cap still holds", () => {
		expect(buildSameTurnProduceFileArtifactKey(base("a"))).toBe(
			buildSameTurnProduceFileArtifactKey(base("b")),
		);
		expect(buildSameTurnProduceFileArtifactKey(program("x = 1"))).toBe(
			buildSameTurnProduceFileArtifactKey(program("x = 2")),
		);
	});

	it("gives intake a different idempotency key when only the content changes", () => {
		// Intake reuses an existing job on a key match, so a key blind to
		// content would hand a corrected resend the broken job back.
		const key = (input: NormalizedProduceFileInput) =>
			buildScopedIdempotencyKey({ turnId: "turn-1", input });
		expect(key(base("a"))).not.toBe(key(base("b")));
		expect(key(program("x = 1"))).not.toBe(key(program("x = 2")));
		expect(key(base("a"))).toBe(key(base("a")));
	});
});

describe("documentSource without blocks", () => {
	function envelope(documentSource: Record<string, unknown>) {
		return normalizeProduceFileInput({
			requestTitle: "Field report",
			sourceMode: "document_source",
			documentSource,
		});
	}

	it("builds blocks from documentSource.markdown", () => {
		const blocks = documentBlocks({
			documentSource: {
				markdown:
					"## Findings\n\nThe pump failed twice in March.\n\n- Seal worn\n- Filter clogged",
			},
		});
		expect(blocks).toEqual([
			{ type: "heading", level: 2, text: "Findings" },
			{ type: "paragraph", text: "The pump failed twice in March." },
			{ type: "list", style: "bullet", items: ["Seal worn", "Filter clogged"] },
		]);
	});

	it("builds blocks from a documentSource.content string as markdown", () => {
		const blocks = documentBlocks({
			documentSource: {
				content: "## Findings\n\nThe pump failed twice in March.",
			},
		});
		expect(blocks).toEqual([
			{ type: "heading", level: 2, text: "Findings" },
			{ type: "paragraph", text: "The pump failed twice in March." },
		]);
	});

	it("takes a documentSource.content array as the blocks", () => {
		const blocks = documentBlocks({
			documentSource: {
				content: [
					{ type: "heading", level: 2, text: "Findings" },
					{ type: "paragraph", text: "The pump failed twice in March." },
				],
			},
		});
		expect(blocks).toEqual([
			{ type: "heading", level: 2, text: "Findings" },
			{ type: "paragraph", text: "The pump failed twice in March." },
		]);
	});

	it("turns documentSource.sections into a heading plus that section's blocks", () => {
		const blocks = documentBlocks({
			documentSource: {
				sections: [
					{ heading: "Findings", content: "The pump failed twice in March." },
					{
						title: "Actions",
						blocks: [{ type: "list", items: ["Replace seal", "Clean filter"] }],
					},
				],
			},
		});
		expect(blocks).toEqual([
			{ type: "heading", level: 2, text: "Findings" },
			{ type: "paragraph", text: "The pump failed twice in March." },
			{ type: "heading", level: 2, text: "Actions" },
			{ type: "list", items: ["Replace seal", "Clean filter"] },
		]);
	});

	it("refuses a documentSource with no usable content instead of inventing a placeholder", () => {
		const result = envelope({ title: "Field report", summary: "Pump notes" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('"blocks"');
		expect(result.error).toContain("markdown");
		expect(result.error).toContain("summary");
		expect(result.error).not.toContain("Generated file request");
	});

	it("refuses an empty blocks array the same way", () => {
		const result = envelope({ blocks: [], summary: "Pump notes" });
		expect(result.ok).toBe(false);
	});
});

// Model-written block shapes the validator used to refuse outright. Each one
// is repaired into the schema's own field names, and the repaired document
// must then pass the real validator.
describe("document block field aliases", () => {
	function repaired(blocks: unknown[]) {
		const result = normalizeProduceFileInput({
			requestTitle: "Field report",
			sourceMode: "document_source",
			documentSource: { blocks },
		});
		if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
		const source = result.input.documentSource as Record<string, unknown>;
		const validation = validateGeneratedDocumentSource(source);
		if (!validation.ok) {
			throw new Error(`repaired source still invalid: ${validation.message}`);
		}
		return {
			blocks: source.blocks as Array<Record<string, unknown>>,
			warnings: result.warnings ?? [],
		};
	}

	it("reads a code block's `code` as its text", () => {
		expect(
			repaired([{ type: "code", language: "python", code: "print(1)" }]).blocks,
		).toEqual([
			expect.objectContaining({
				type: "code",
				language: "python",
				text: "print(1)",
			}),
		]);
	});

	it("reads a paragraph's `content` as its text", () => {
		expect(
			repaired([{ type: "paragraph", content: "The pump failed." }]).blocks,
		).toEqual([
			expect.objectContaining({ type: "paragraph", text: "The pump failed." }),
		]);
	});

	it("turns a string heading level into a number", () => {
		expect(
			repaired([{ type: "heading", level: "2", text: "Findings" }]).blocks,
		).toEqual([{ type: "heading", level: 2, text: "Findings" }]);
	});

	it("maps heading levels 4-6 onto the deepest supported level", () => {
		expect(
			repaired([
				{ type: "heading", level: 5, text: "Deep" },
				{ type: "h6", text: "Deeper" },
				{ type: "heading", level: "h4", text: "Tagged" },
			]).blocks,
		).toEqual([
			expect.objectContaining({ level: 3, text: "Deep" }),
			expect.objectContaining({ level: 3, text: "Deeper" }),
			expect.objectContaining({ level: 3, text: "Tagged" }),
		]);
	});

	it("flattens list items given as {text} objects", () => {
		expect(
			repaired([
				{ type: "list", items: [{ text: "Seal worn" }, { text: "Filter" }] },
			]).blocks,
		).toEqual([expect.objectContaining({ items: ["Seal worn", "Filter"] })]);
	});

	it("reads `ordered: true` as a numbered list", () => {
		expect(
			repaired([{ type: "list", ordered: true, items: ["One", "Two"] }]).blocks,
		).toEqual([
			expect.objectContaining({ style: "numbered", items: ["One", "Two"] }),
		]);
	});

	it("drops empty paragraphs", () => {
		expect(
			repaired([
				{ type: "paragraph", text: "   " },
				{ type: "paragraph", text: "Kept." },
				{ type: "paragraph" },
			]).blocks,
		).toEqual([{ type: "paragraph", text: "Kept." }]);
	});

	it("turns object table cells into scalars", () => {
		const { blocks } = repaired([
			{
				type: "table",
				columns: ["Item", "Count"],
				rows: [[{ text: "Seals" }, { value: 4 }]],
			},
		]);
		expect(blocks[0]?.rows).toEqual([["Seals", 4]]);
	});

	it("truncates rows longer than the columns, with a warning, and pads short rows", () => {
		const { blocks, warnings } = repaired([
			{
				type: "table",
				columns: ["Item", "Count"],
				rows: [["Seals", 4, "extra", "more"], ["Filters"]],
			},
		]);
		expect(blocks[0]?.rows).toEqual([
			["Seals", 4],
			["Filters", null],
		]);
		expect(warnings).toEqual([
			expect.stringMatching(/Block 1 \(table\).*1 row.*2 columns/),
		]);
	});

	it("reads an image's `url` or `src` as its https source", () => {
		const { blocks } = repaired([
			{ type: "image", url: "https://example.com/a.png", altText: "A" },
			{ type: "image", src: "https://example.com/b.png", alt: "B" },
		]);
		expect(blocks).toEqual([
			expect.objectContaining({
				type: "image",
				source: { kind: "https", url: "https://example.com/a.png" },
				altText: "A",
			}),
			expect.objectContaining({
				type: "image",
				source: { kind: "https", url: "https://example.com/b.png" },
				altText: "B",
			}),
		]);
	});

	it("keeps a mermaid block or fence as a mermaid code block, not a paragraph", () => {
		const { blocks } = repaired([
			{ type: "mermaid", code: "graph TD; A-->B" },
			{ type: "diagram", text: "graph LR; C-->D" },
			{ type: "paragraph", text: "```mermaid\ngraph TD; E-->F\n```" },
		]);
		expect(blocks).toEqual([
			expect.objectContaining({
				type: "code",
				language: "mermaid",
				text: "graph TD; A-->B",
			}),
			expect.objectContaining({
				type: "code",
				language: "mermaid",
				text: "graph LR; C-->D",
			}),
			expect.objectContaining({
				type: "code",
				language: "mermaid",
				text: "graph TD; E-->F",
			}),
		]);
	});
});

describe("chart data shapes and multiple series", () => {
	function chartResult(block: Record<string, unknown>) {
		return normalizeProduceFileInput({
			requestTitle: "Sales report",
			sourceMode: "document_source",
			documentSource: {
				blocks: [{ type: "paragraph", text: "Intro." }, block],
			},
		});
	}
	function chartBlock(block: Record<string, unknown>) {
		const result = chartResult(block);
		if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
		const source = result.input.documentSource as Record<string, unknown>;
		const validation = validateGeneratedDocumentSource(source);
		if (!validation.ok) {
			throw new Error(`repaired source still invalid: ${validation.message}`);
		}
		return (source.blocks as Array<Record<string, unknown>>)[1];
	}

	it("turns wide rows into long form with a series key for a stacked bar chart", () => {
		const block = chartBlock({
			type: "chart",
			chartType: "stackedBar",
			title: "Revenue",
			data: [
				{ region: "North", q2: 10, q3: 12 },
				{ region: "South", q2: 20, q3: 18 },
			],
		});
		expect(block).toMatchObject({
			xKey: "label",
			yKey: "value",
			seriesKey: "series",
			data: [
				{ label: "North", series: "q2", value: 10 },
				{ label: "North", series: "q3", value: 12 },
				{ label: "South", series: "q2", value: 20 },
				{ label: "South", series: "q3", value: 18 },
			],
		});
	});

	it("refuses wide rows on a chart type that draws one series, naming the series", () => {
		const result = chartResult({
			type: "chart",
			chartType: "bar",
			title: "Revenue",
			data: [
				{ region: "North", q2: 10, q3: 12 },
				{ region: "South", q2: 20, q3: 18 },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/^Block 2 \(chart\): /);
		expect(result.error).toContain("q2, q3");
		expect(result.error).toContain('"stackedBar"');
		expect(result.error).toContain('"yKey"');
	});

	it("plots the one series the model named even when other numeric columns exist", () => {
		const block = chartBlock({
			type: "chart",
			chartType: "bar",
			title: "Revenue",
			yKey: "q3",
			data: [
				{ region: "North", q2: 10, q3: 12 },
				{ region: "South", q2: 20, q3: 18 },
			],
		});
		expect(block).toMatchObject({ xKey: "region", yKey: "q3" });
	});

	it("turns {labels, values} into rows", () => {
		const block = chartBlock({
			type: "chart",
			chartType: "bar",
			title: "Revenue",
			data: { labels: ["North", "South"], values: [10, 20] },
		});
		expect(block).toMatchObject({
			xKey: "label",
			yKey: "value",
			data: [
				{ label: "North", value: 10 },
				{ label: "South", value: 20 },
			],
		});
	});

	it("keeps every dataset of a multi-series ```chart fence in Markdown, as a table", () => {
		const blocks = documentBlocks({
			content: [
				"```chart",
				JSON.stringify({
					type: "bar",
					data: {
						labels: ["North", "South"],
						datasets: [
							{ label: "Q2", data: [10, 20] },
							{ label: "Q3", data: [12, 18] },
						],
					},
				}),
				"```",
			].join("\n"),
		});
		expect(blocks).toEqual([
			expect.objectContaining({
				type: "table",
				rows: [
					{ label: "North", q2: 10, q3: 12 },
					{ label: "South", q2: 20, q3: 18 },
				],
			}),
		]);
	});

	it("turns [[label, value]] pairs into rows", () => {
		const block = chartBlock({
			type: "chart",
			chartType: "pie",
			title: "Share",
			data: [
				["North", 60],
				["South", 40],
			],
		});
		expect(block).toMatchObject({
			labelKey: "label",
			valueKey: "value",
			data: [
				{ label: "North", value: 60 },
				{ label: "South", value: 40 },
			],
		});
	});
});

// The envelope, alias and chart repairs exist so a model's content is never
// lost on the way to the renderer. Each case below used to render a document
// with part of what the model sent silently missing.
describe("documentSource repairs never drop content silently", () => {
	function normalize(documentSource: Record<string, unknown>) {
		return normalizeProduceFileInput({
			requestTitle: "Field report",
			sourceMode: "document_source",
			documentSource,
		});
	}

	it("refuses a section whose body sits under a key it does not read, naming the section and key", () => {
		const result = normalize({
			sections: [
				{ heading: "Findings", paragraphs: ["Seal worn.", "Filter clogged."] },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("sections[0]");
		expect(result.error).toContain('"paragraphs"');
	});

	it("refuses a section that carries two bodies instead of rendering only the first", () => {
		const result = normalize({
			sections: [
				{
					heading: "Findings",
					content: "The pump failed twice.",
					blocks: [{ type: "paragraph", text: "Replace the seal." }],
				},
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("sections[0]");
	});

	it("refuses a documentSource that sends its body twice (blocks plus markdown)", () => {
		const result = normalize({
			blocks: [{ type: "paragraph", text: "Intro only." }],
			markdown: "## Findings\n\nThe pump failed twice in March.",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('"blocks"');
		expect(result.error).toContain('"markdown"');
	});

	it("keeps every field of an object list item, and every item of a nested list", () => {
		const blocks = documentBlocks({
			documentSource: {
				blocks: [
					{
						type: "list",
						items: [
							{ title: "Step 1", description: "Drain the tank" },
							["Close valve A", "Close valve B"],
							"Refill",
						],
					},
				],
			},
		});
		const items = blocks[0].items as string[];
		expect(items.join(" | ")).toContain("Step 1");
		expect(items.join(" | ")).toContain("Drain the tank");
		expect(items.join(" | ")).toContain("Close valve A");
		expect(items.join(" | ")).toContain("Close valve B");
		expect(items).toContain("Refill");
	});

	it("refuses an object list item with no text in it rather than dropping it", () => {
		const result = normalize({
			blocks: [{ type: "list", items: ["Keep", { done: true }] }],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/^Block 1 \(list\): /);
	});

	it("keeps every field of an object table cell", () => {
		const blocks = documentBlocks({
			documentSource: {
				blocks: [
					{
						type: "table",
						columns: ["Item", "Weight"],
						rows: [["Pump", { value: 12, unit: "kg" }]],
					},
				],
			},
		});
		expect(JSON.stringify(blocks[0])).toContain("12 kg");
	});

	it("still sees a series with a missing value as a series (bar chart refuses, not drops it)", () => {
		const result = normalize({
			blocks: [
				{
					type: "chart",
					chartType: "bar",
					title: "Revenue",
					data: [
						{ region: "North", q2: 10, q3: 12 },
						{ region: "South", q2: 20, q3: null },
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("q2, q3");
	});
});
