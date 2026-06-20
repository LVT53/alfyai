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
				expect.objectContaining({
					type: "confidenceMarker",
					code: "limited_web",
					label: "Supported",
					severity: "info",
					message: "Representative web coverage.",
				}),
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

	it("adds accepted-source chips to substantive paragraphs when Markdown has no explicit citations", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Inline Evidence Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Enterprise buyers are prioritizing source-grounded research assistants because evaluation, auditability, and retrieval controls now drive deployment confidence across regulated teams.",
				"",
				"Teams that combine fresh web evidence with local document context can make faster decisions while keeping uncertainty visible to reviewers and approvers.",
			].join("\n"),
			sources: [
				{
					title: "Vendor release notes",
					url: "https://example.com/releases",
					reasoning: "Explains the current enterprise release requirements.",
				},
				{
					title: "Auditability benchmark",
					url: "https://example.com/audit",
					reasoning: "Documents auditability expectations for research tools.",
				},
			],
			honestyMarkers: [],
		});

		const paragraphs = source.blocks.filter(
			(
				block,
			): block is Extract<
				(typeof source.blocks)[number],
				{ type: "paragraph" }
			> => block.type === "paragraph",
		);
		expect(paragraphs[0].sources).toEqual([
			expect.objectContaining({
				title: "Vendor release notes",
				url: "https://example.com/releases",
				kind: "web",
				reasoning: "Explains the current enterprise release requirements.",
			}),
		]);
		expect(paragraphs[1].sources).toEqual([
			expect.objectContaining({
				title: "Auditability benchmark",
				url: "https://example.com/audit",
				kind: "web",
				reasoning: "Documents auditability expectations for research tools.",
			}),
		]);
		expect(source.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "heading",
					text: "Honesty markers",
				}),
				expect.objectContaining({
					type: "confidenceMarker",
					code: "atlas_audit_passed",
					label: "Audit checked",
					severity: "info",
				}),
			]),
		);
	});

	it("replaces model-authored final source sections with canonical backend source chips", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Canonical Sources Atlas",
			assembledMarkdown: [
				"## Findings",
				"Atlas summarized the evidence before the model attempted to append its own source list.",
				"",
				"## Sources",
				"1. Old source text that should not survive in the generated report.",
				"",
				"## Follow-up",
				"This section remains part of the authored report after the removed source list.",
			].join("\n"),
			sources: [
				{
					title: "Accepted source",
					url: "https://example.com/accepted",
					reasoning: "Accepted evidence selected by the backend.",
				},
			],
			honestyMarkers: [],
		});

		const headings = source.blocks.filter(
			(
				block,
			): block is Extract<
				(typeof source.blocks)[number],
				{ type: "heading" }
			> => block.type === "heading",
		);
		expect(headings.filter((block) => block.text === "Sources")).toHaveLength(
			1,
		);
		expect(source.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "heading", text: "Findings" }),
				expect.objectContaining({ type: "heading", text: "Follow-up" }),
				expect.objectContaining({
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						expect.objectContaining({
							title: "Accepted source",
							url: "https://example.com/accepted",
							reasoning: "Accepted evidence selected by the backend.",
						}),
					],
				}),
			]),
		);
		expect(
			source.blocks
				.map((block) =>
					"text" in block && typeof block.text === "string" ? block.text : "",
				)
				.join("\n"),
		).not.toContain("Old source text");
	});

	it("adds a key takeaway, useful chart, and source-attributed image blocks when the report content supports them", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "AI Market Atlas",
			assembledMarkdown: [
				"# AI Market Atlas",
				"",
				"## Executive Summary",
				"Market growth is concentrated in vendors that can pair enterprise controls with practical deployment support.",
				"",
				"| Segment | Growth |",
				"| --- | ---: |",
				"| Enterprise search | 42% |",
				"| Customer support | 27% |",
				"| Developer tools | 18% |",
				"",
				'![Vendor adoption chart](https://example.com/adoption.png "Vendor benchmark")',
			].join("\n"),
			sources: [
				{
					title: "Vendor benchmark",
					url: "https://example.com/benchmark",
					reasoning: "The benchmark includes the adoption chart.",
				},
			],
			honestyMarkers: [],
		});

		expect(source.blocks).toEqual(
			expect.arrayContaining([
				{
					type: "callout",
					tone: "tip",
					title: "Key takeaway",
					text: "Market growth is concentrated in vendors that can pair enterprise controls with practical deployment support.",
				},
				expect.objectContaining({
					type: "chart",
					chartType: "bar",
					title: "Growth by Segment",
					xKey: "segment",
					yKey: "growth",
					units: "%",
					data: [
						{ segment: "Enterprise search", growth: 42 },
						{ segment: "Customer support", growth: 27 },
						{ segment: "Developer tools", growth: 18 },
					],
				}),
				expect.objectContaining({
					type: "image",
					source: {
						kind: "https",
						url: "https://example.com/adoption.png",
					},
					altText: "Vendor adoption chart",
					caption: "Vendor benchmark",
					sourceAttribution: {
						title: "Vendor benchmark",
						url: "https://example.com/adoption.png",
					},
				}),
			]),
		);
	});

	it("uses Hungarian report chrome for generated backend blocks in Hungarian Atlas reports", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Magyar Atlas",
			assembledMarkdown:
				"## Vezetői összefoglaló\nA magyar jelentés a friss forrásokra támaszkodik, és külön jelöli a bizonytalan következtetéseket.",
			sources: [
				{
					title: "Helyi forrás",
					authority: "explicit",
				},
				{
					title: "Webes forrás",
					url: "https://example.com/forras",
				},
			],
			honestyMarkers: [
				{
					code: "limited_sources",
					message: "Kevés elfogadott forrás állt rendelkezésre.",
					severity: "warning",
				},
			],
			date: "2026-06-20",
		});

		expect(source.cover).toEqual({
			enabled: true,
			eyebrow: "Jelentés dátuma: 2026-06-20",
			dateLabel: null,
		});
		expect(source.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "callout",
					title: "Kulcsüzenet",
				}),
				expect.objectContaining({
					type: "heading",
					text: "Őszinteségi jelölések",
				}),
				expect.objectContaining({
					type: "heading",
					text: "Források",
				}),
				expect.objectContaining({
					type: "sourceChips",
					title: "Webes források",
				}),
				expect.objectContaining({
					type: "sourceChips",
					title: "Saját könyvtár",
				}),
				expect.objectContaining({
					type: "confidenceMarker",
					label: "Részben alátámasztott",
					message: "Kevés elfogadott forrás állt rendelkezésre.",
				}),
			]),
		);
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
			eyebrow: "Report date",
			dateLabel: null,
		});
		expect(createOutputJob).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					documentIntent: "Atlas research report; atlas_job_id=atlas-child-1",
					templateHint: "alfyai_standard_report",
					documentSource: source,
				}),
			}),
		);
	});
});
