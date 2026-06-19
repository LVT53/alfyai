import { describe, expect, it, vi } from "vitest";

describe("Atlas renderer output", () => {
	it("assembles a GeneratedDocumentSource and delegates HTML/PDF/Markdown sibling storage to file production", async () => {
		const { buildAtlasDocumentSource, renderAtlasOutputs } = await import(
			"./renderer-output"
		);
		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			subtitle: "Representative evidence map",
			assembledMarkdown:
				"# Executive summary\n\nSearch should combine local authority and web freshness.",
			sources: [
				{
					title: "Uploaded strategy memo",
					authority: "explicit",
				},
				{
					title: "Vendor docs",
					url: "https://example.com/docs",
					reasoning: "Vendor documentation covers current API limits.",
				},
			],
			honestyMarkers: [
				{
					code: "limited_web",
					message: "Representative web coverage.",
					severity: "info",
				},
			],
			date: "2026-06-19",
		});
		const createOutputJob = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		const outputs = await renderAtlasOutputs({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			jobId: "atlas-job-1",
			source,
			createOutputJob,
		});

		expect(source).toMatchObject({
			version: 1,
			template: "alfyai_standard_report",
			title: "Enterprise Search Atlas",
			blocks: expect.arrayContaining([
				expect.objectContaining({ type: "heading", text: "Executive summary" }),
				expect.objectContaining({ type: "heading", text: "Sources" }),
				expect.objectContaining({
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						expect.objectContaining({
							title: "Vendor docs",
							url: "https://example.com/docs",
							reasoning: "Vendor documentation covers current API limits.",
						}),
					],
				}),
				expect.objectContaining({
					type: "sourceChips",
					title: "Your Library",
					sources: [
						expect.objectContaining({
							title: "Uploaded strategy memo",
							provided: true,
							reasoning: "You provided these",
						}),
					],
				}),
				expect.objectContaining({ type: "heading", text: "Honesty markers" }),
			]),
		});
		const sourceHeadings = source.blocks
			.map((block, index) =>
				block.type === "sourceChips" ? { title: block.title, index } : null,
			)
			.filter((entry): entry is { title: string; index: number } =>
				Boolean(entry),
			);
		expect(sourceHeadings).toEqual([
			{ title: "Web Sources", index: expect.any(Number) },
			{ title: "Your Library", index: expect.any(Number) },
		]);
		expect(sourceHeadings[0].index).toBeLessThan(sourceHeadings[1].index);
		expect(createOutputJob).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				body: expect.objectContaining({
					conversationId: "conv-1",
					assistantMessageId: "assistant-1",
					idempotencyKey: "atlas-output:v2:atlas-job-1",
					requestTitle: "Enterprise Search Atlas",
					sourceMode: "document_source",
					requestedOutputs: [
						{ type: "html" },
						{ type: "pdf" },
						{ type: "markdown" },
					],
					documentSource: source,
				}),
			}),
		);
		expect(outputs).toEqual({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		});
	});

	it("converts Atlas Markdown into semantic document blocks for rendered HTML and PDF", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			assembledMarkdown: [
				"# Executive summary",
				"",
				"Atlas found **repeatable** _implementation_ patterns with [source labels](https://example.com) and `inline code`.",
				"",
				"- **Hybrid** retrieval is common",
				"- Evaluation needs [source-level checks](https://example.com/checks)",
				"",
				"| **Vendor** | Fit |",
				"| --- | --- |",
				"| [Alpha](https://example.com/alpha) | **Strong** |",
				"| Beta | `Watch` |",
				"",
				"```ts",
				"const score = '**preserved** [literal](url)';",
				"```",
				"",
				"> Treat **web coverage** as [representative](https://example.com).",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
		});

		expect(source.blocks).toEqual(
			expect.arrayContaining([
				{ type: "heading", level: 2, text: "Executive summary" },
				{
					type: "paragraph",
					text: "Atlas found repeatable implementation patterns with source labels and inline code.",
				},
				{
					type: "list",
					style: "bullet",
					items: [
						"Hybrid retrieval is common",
						"Evaluation needs source-level checks",
					],
				},
				{
					type: "table",
					columns: [
						{ key: "vendor", label: "Vendor", kind: "text" },
						{ key: "fit", label: "Fit", kind: "text" },
					],
					rows: [
						{ vendor: "Alpha", fit: "Strong" },
						{ vendor: "Beta", fit: "Watch" },
					],
				},
				{
					type: "code",
					language: "ts",
					text: "const score = '**preserved** [literal](url)';",
				},
				{
					type: "quote",
					text: "Treat web coverage as representative.",
					citation: null,
				},
			]),
		);
		const renderedText = source.blocks
			.flatMap((block) => {
				if (block.type === "paragraph" || block.type === "heading") {
					return [block.text];
				}
				if (block.type === "list") return block.items;
				if (block.type === "quote") return [block.text];
				if (block.type === "table") {
					return [
						...block.columns.map((column) => column.label),
						...block.rows.flatMap((row) =>
							Object.values(row).map((value) => String(value ?? "")),
						),
					];
				}
				return [];
			})
			.join("\n");
		expect(renderedText).not.toMatch(/\*\*|`|\[|\]\(/);
	});

	it("persists Atlas lifecycle family metadata through document source and request metadata", async () => {
		const { buildAtlasDocumentSource, renderAtlasOutputs } = await import(
			"./renderer-output"
		);
		const source = buildAtlasDocumentSource({
			title: "Continued Atlas",
			subtitle: "in-depth Atlas report",
			family: {
				familyId: "atlas-family-1",
				mode: "same_family",
				action: "continue",
				rootAtlasJobId: "atlas-root-1",
				currentAtlasJobId: "atlas-child-1",
				parentAtlasJobId: "atlas-parent-1",
				forkedFromAtlasJobId: null,
			},
			assembledMarkdown: "Continued findings.",
			sources: [],
			honestyMarkers: [],
		});
		const createOutputJob = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await renderAtlasOutputs({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			jobId: "atlas-child-1",
			source,
			createOutputJob,
		});

		expect(source.cover).toEqual({
			enabled: true,
			eyebrow: "Atlas same_family atlas-family-1",
		});
		expect(createOutputJob).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					documentIntent:
						"Atlas research report; atlas_job_id=atlas-child-1; atlas_source=Atlas same_family atlas-family-1",
					templateHint:
						"alfyai_standard_report:Atlas same_family atlas-family-1",
					documentSource: source,
				}),
			}),
		);
	});
});
