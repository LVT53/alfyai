import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileProductionJob } from "$lib/types";

const fileProductionMocks = vi.hoisted(() => ({
	drainFileProductionWorker: vi.fn(async () => undefined),
	listConversationFileProductionJobs: vi.fn(),
	submitFileProductionIntake: vi.fn(),
}));

vi.mock("$lib/server/services/file-production", () => ({
	drainFileProductionWorker: fileProductionMocks.drainFileProductionWorker,
	listConversationFileProductionJobs:
		fileProductionMocks.listConversationFileProductionJobs,
	submitFileProductionIntake: fileProductionMocks.submitFileProductionIntake,
}));

function fileProductionJob(
	overrides: Partial<FileProductionJob> = {},
): FileProductionJob {
	return {
		id: "fp-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		title: "Atlas Report",
		status: "running",
		stage: null,
		createdAt: 1,
		updatedAt: 1,
		files: [],
		warnings: [],
		error: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

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
			]),
		});
		expect(source.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "heading", text: "Honesty markers" }),
				expect.objectContaining({ type: "confidenceMarker" }),
			]),
		);
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

	it("removes duplicate opening title and subtitle blocks before Executive Summary", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			subtitle: null,
			assembledMarkdown: [
				"# Enterprise Search Atlas",
				"",
				"Strategic operating model for 2026",
				"",
				"## Executive Summary",
				"The first substantive report section should be the executive summary after app-owned title chrome.",
				"",
				"## Findings",
				"Evidence-backed findings remain in the report body.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
		});

		const bodyHeadings = source.blocks.filter(
			(
				block,
			): block is Extract<
				(typeof source.blocks)[number],
				{ type: "heading" }
			> => block.type === "heading",
		);

		expect(bodyHeadings[0]).toMatchObject({
			type: "heading",
			level: 2,
			text: "Executive Summary",
		});
		expect(
			source.blocks.some(
				(block) =>
					block.type === "heading" && block.text === "Enterprise Search Atlas",
			),
		).toBe(false);
		expect(
			source.blocks.some(
				(block) =>
					block.type === "paragraph" &&
					block.text === "Strategic operating model for 2026",
			),
		).toBe(false);
	});

	it("keeps later title-like section headings after Executive Summary", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			assembledMarkdown: [
				"# Enterprise Search Atlas",
				"",
				"## Executive Summary",
				"Executive summary content starts the authored body.",
				"",
				"## Product Title",
				"This legitimate later section heading must survive opening cleanup.",
			].join("\n"),
			sources: [],
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

		expect(headings.map((heading) => heading.text)).toEqual(
			expect.arrayContaining(["Executive Summary", "Product Title"]),
		);
		expect(
			headings.find((heading) => heading.text === "Product Title"),
		).toMatchObject({
			level: 2,
			text: "Product Title",
		});
	});

	it("keeps vetted model-authored report images instead of duplicating structured Atlas image candidates", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			assembledMarkdown: [
				"# Enterprise Search Atlas",
				"",
				"## Executive Summary",
				"Hybrid retrieval remains the clearest default for teams that need exact-match recall and semantic discovery in the same workflow.",
				"",
				'![Authored enterprise search architecture diagram](https://example.com/structured.png "Structured source")',
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-candidate-1",
					query: "enterprise search architecture",
					title: "Enterprise search architecture diagram",
					imageUrl: "https://example.com/structured.png",
					sourcePageUrl: "https://example.com/structured-source",
					sourceTitle: "Structured source",
					thumbnailUrl: null,
					width: null,
					height: null,
					caption: "Enterprise search architecture diagram",
					selectionReason: "Image result for enterprise search architecture.",
				},
			],
			maxRenderedImages: 1,
		});

		const imageBlocks = source.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			source: { kind: "https", url: "https://example.com/structured.png" },
			altText: "Authored enterprise search architecture diagram",
		});
	});

	it("drops unvetted authored logo images and inserts a vetted relevant candidate", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Enterprise search architecture decisions should combine lexical retrieval, semantic retrieval, and reranking.",
				"",
				'![Algolia logo](https://cdn.jsdelivr.net/gh/devicons/devicon/icons/algolia/algolia-original.svg "Algolia logo")',
				"",
				"## Findings",
				"Enterprise search architecture diagrams are useful when they clarify ingestion, indexing, retrieval, and reranking responsibilities.",
				"",
				"## Limitations",
				"The evidence is representative rather than exhaustive.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-candidate-1",
					query: "enterprise search architecture",
					title: "Enterprise search architecture diagram",
					imageUrl: "https://example.com/enterprise-search-architecture.png",
					sourcePageUrl: "https://example.com/enterprise-search-architecture",
					sourceTitle: "Example Research",
					thumbnailUrl: null,
					width: 1200,
					height: 800,
					caption: "Enterprise search architecture diagram",
					selectionReason: "Image result for enterprise search architecture.",
				},
			],
			maxRenderedImages: 2,
		});

		const imageBlocks = source.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			source: {
				kind: "https",
				url: "https://example.com/enterprise-search-architecture.png",
			},
			caption: "Enterprise search architecture diagram",
		});
	});

	it("does not render image candidates whose relevance only appears in the image filename", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Enterprise search architecture decisions should combine lexical retrieval, semantic retrieval, and reranking.",
				"",
				"## Findings",
				"Architecture diagrams are useful when they clarify ingestion, indexing, retrieval, and reranking responsibilities.",
				"",
				"## Limitations",
				"The evidence is representative rather than exhaustive.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-candidate-weak",
					query: "enterprise search architecture",
					title: "Generic cover artwork",
					imageUrl:
						"https://cdn.example.com/enterprise-search-architecture-cover.png",
					sourcePageUrl: "https://example.com/stock-artwork",
					sourceTitle: "Example Images",
					thumbnailUrl: null,
					width: 1200,
					height: 800,
					caption: "Stock product illustration",
					selectionReason: "Image result for enterprise search architecture.",
				},
				{
					id: "image-candidate-strong",
					query: "enterprise search architecture",
					title: "Enterprise search architecture diagram",
					imageUrl: "https://example.com/enterprise-search-architecture.png",
					sourcePageUrl: "https://example.com/enterprise-search-architecture",
					sourceTitle: "Example Research",
					thumbnailUrl: null,
					width: 1200,
					height: 800,
					caption: "Enterprise search architecture diagram",
					selectionReason: "Image result for enterprise search architecture.",
				},
			],
			maxRenderedImages: 2,
		});

		const imageBlocks = source.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			source: {
				kind: "https",
				url: "https://example.com/enterprise-search-architecture.png",
			},
			caption: "Enterprise search architecture diagram",
		});
	});

	it("caps model-authored report images by section density", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Crowded Visual Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Image-heavy model output should be reduced before rendering.",
				"",
				'![First authored image](https://example.com/authored-1.png "First")',
				"",
				"## Findings",
				"The report has enough sections for one visual, not a gallery.",
				"",
				'![Second authored image](https://example.com/authored-2.png "Second")',
				"",
				"## Limitations",
				"The image cap is based on section density.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			maxRenderedImages: 4,
		});

		const imageBlocks = source.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			source: { kind: "https", url: "https://example.com/authored-1.png" },
		});
	});

	it("caps deterministic Atlas images by report section density", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Short Visual Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Short reports should not be crowded with automatically selected images.",
				"",
				"## Findings",
				"The accepted evidence supports one compact visual at most for this report.",
				"",
				"## Limitations",
				"The evidence is representative rather than exhaustive.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [1, 2, 3, 4].map((index) => ({
				id: `image-candidate-${index}`,
				query: "short visual atlas",
				title: `Short visual atlas diagram ${index}`,
				imageUrl: `https://example.com/structured-${index}.png`,
				sourcePageUrl: `https://example.com/structured-source-${index}`,
				sourceTitle: `Structured source ${index}`,
				thumbnailUrl: null,
				width: null,
				height: null,
				caption: `Short visual atlas structured image candidate ${index}`,
				selectionReason: "Image result for short visual atlas.",
			})),
			maxRenderedImages: 4,
		});

		const imageBlocks = source.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			source: { kind: "https", url: "https://example.com/structured-1.png" },
		});
	});

	it("does not insert otherwise usable image candidates without report-section relevance", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Enterprise search architecture should balance lexical retrieval, semantic retrieval, and reranking.",
				"",
				"## Findings",
				"Governance and latency controls are the main implementation concerns.",
				"",
				"## Limitations",
				"The evidence is representative rather than exhaustive.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-candidate-payroll",
					query: "payroll compliance workflow",
					title: "Payroll compliance workflow diagram",
					imageUrl: "https://example.com/payroll-compliance-workflow.png",
					sourcePageUrl: "https://example.com/payroll-compliance-workflow",
					sourceTitle: "Workflow Research",
					thumbnailUrl: null,
					width: 1200,
					height: 800,
					caption: "Payroll compliance workflow diagram",
					selectionReason: "Image result for payroll compliance workflow.",
				},
			],
			maxRenderedImages: 2,
		});

		expect(
			source.blocks.filter((block) => block.type === "image"),
		).toHaveLength(0);
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
		expect(source.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "heading",
					text: "Honesty markers",
				}),
				expect.objectContaining({
					type: "confidenceMarker",
				}),
				expect.objectContaining({
					code: "atlas_audit_passed",
				}),
			]),
		);
	});

	it("projects Atlas Claim Basis into paragraph basis markers when section context exists", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Basis Projection Atlas",
			assembledMarkdown: [
				"## Executive summary",
				"Search should combine local authority and web freshness.",
				"",
				"## Risks",
				"The market has unresolved adoption signals.",
			].join("\n"),
			sources: [
				{
					title: "Vendor docs",
					url: "https://example.com/docs",
					reasoning: "Accepted web evidence gathered by Atlas.",
				},
			],
			honestyMarkers: [],
			claimBasis: [
				{
					version: "atlas.claim-basis.v1",
					id: "basis-supported",
					locator: {
						sectionTitle: "Executive summary",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText:
							"Search should combine local authority and web freshness.",
						quote: "local authority and web freshness",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "supported",
					evidencePackIds: ["pack-1"],
					sourceRefs: [
						{
							id: "source-1",
							kind: "web",
							title: "Vendor docs",
							url: "https://example.com/docs",
							authority: "accepted_web",
						},
					],
					supportRationale:
						"Accepted source states both local authority and web freshness are required.",
					auditConcernCode: null,
				},
				{
					version: "atlas.claim-basis.v1",
					id: "basis-unanchored",
					locator: {
						sectionTitle: "Risks",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "The unsupported claim is not quoted in the report.",
						quote: "nonexistent quote",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "unsupported",
					evidencePackIds: [],
					sourceRefs: [],
					supportRationale:
						"No accepted source supports the unanchored risk claim.",
					auditConcernCode: "atlas_unanchored_risk",
				},
			],
		});

		const paragraphs = source.blocks.filter(
			(
				block,
			): block is Extract<
				(typeof source.blocks)[number],
				{ type: "paragraph" }
			> => block.type === "paragraph",
		);
		expect(paragraphs[0].basisMarkers).toEqual([
			{
				type: "basisMarker",
				id: "basis-supported",
				support: "supported",
				anchorText: "local authority and web freshness",
				occurrence: 0,
				rationale:
					"Accepted source states both local authority and web freshness are required.",
			},
		]);
		expect(paragraphs[1].basisMarkers).toEqual([
			{
				type: "basisMarker",
				id: "basis-unanchored",
				support: "unsupported",
				anchorText: "The market has unresolved adoption signals.",
				occurrence: 0,
				rationale: "No accepted source supports the unanchored risk claim.",
				auditCode: "atlas_unanchored_risk",
			},
		]);
		expect(source.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "basisMarker",
					id: "basis-unanchored",
				}),
			]),
		);
		expect(source.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "heading", text: "Honesty markers" }),
				expect.objectContaining({ type: "confidenceMarker" }),
				expect.objectContaining({ code: "atlas_audit_passed" }),
			]),
		);
	});

	it("attaches unlocatable Atlas Claim Basis markers to nearby paragraph text", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Nearby Basis Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"The report keeps unsupported marker fallbacks near visible text.",
				"",
				"## Findings",
				"The report has a substantive paragraph after the requested section.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			claimBasis: [
				{
					version: "atlas.claim-basis.v1",
					id: "basis-unlocatable",
					locator: {
						sectionTitle: "Stage: Integrate",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "A malformed model envelope section was audited.",
						quote: "malformed model envelope",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: ["pack-1"],
					sourceRefs: [],
					supportRationale:
						"The claim-basis fallback should stay inline with report text.",
					auditConcernCode: "atlas_claim_basis_section_fallback",
				},
			],
		});

		const paragraphs = source.blocks.filter(
			(
				block,
			): block is Extract<
				(typeof source.blocks)[number],
				{ type: "paragraph" }
			> => block.type === "paragraph",
		);
		expect(paragraphs.some((paragraph) => paragraph.basisMarkers?.length)).toBe(
			true,
		);
		expect(source.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "basisMarker",
					id: "basis-unlocatable",
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

	it("removes model-authored bibliography reference and citation appendix sections", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Canonical Sources Atlas",
			assembledMarkdown: [
				"## Findings",
				"Atlas keeps the authored analysis and removes bibliography-style appendices.",
				"",
				"### Citation Appendix",
				"- Nested citation appendix item that should not render.",
				"",
				"### Method",
				"This legitimate subsection remains after the nested appendix.",
				"",
				"## Bibliography",
				"- Model bibliography item that should not render.",
				"",
				"## References",
				"- Model reference item that should not render.",
				"",
				"## Forrasok",
				"- Accentless Hungarian source appendix that should not render.",
				"",
				"## Források",
				"- Hungarian source appendix that should not render.",
				"",
				"### Citation Appendix",
				"- Citation appendix item that should not render.",
				"",
				"## Follow-up",
				"This legitimate section remains after repaired source appendices.",
			].join("\n"),
			sources: [
				{
					title: "Accepted source",
					url: "https://example.com/accepted",
				},
			],
			honestyMarkers: [],
			language: "en",
		});

		const allText = source.blocks
			.flatMap((block) => {
				if (block.type === "heading" || block.type === "paragraph")
					return [block.text];
				if (block.type === "list") return block.items;
				return [];
			})
			.join("\n");
		expect(allText).toContain("Atlas keeps the authored analysis");
		expect(allText).toContain(
			"This legitimate subsection remains after the nested appendix.",
		);
		expect(allText).toContain("This legitimate section remains");
		expect(allText).not.toContain("Nested citation appendix item");
		expect(allText).not.toContain("Model bibliography item");
		expect(allText).not.toContain("Model reference item");
		expect(allText).not.toContain("Accentless Hungarian source appendix");
		expect(allText).not.toContain("Hungarian source appendix");
		expect(allText).not.toContain("Citation appendix item");
		expect(
			source.blocks.filter(
				(block) => block.type === "heading" && block.text === "Sources",
			),
		).toHaveLength(1);
		expect(source.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						expect.objectContaining({
							title: "Accepted source",
							url: "https://example.com/accepted",
						}),
					],
				}),
			]),
		);
	});

	it("removes terminal prose source lists without removing analytical source sections", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Source Quality Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Atlas summarizes accepted evidence before the model drifts into a prose source list.",
				"",
				"## Source quality analysis",
				"The report should discuss source quality without being mistaken for a bibliography.",
				"",
				"Sources consulted by the model:",
				"1. https://unaccepted.example.com/model-only",
				"2. Model-only source appendix text",
			].join("\n"),
			sources: [
				{
					title: "Accepted source",
					url: "https://example.com/accepted",
				},
			],
			honestyMarkers: [],
		});

		const allText = source.blocks
			.flatMap((block) => {
				if (block.type === "heading" || block.type === "paragraph")
					return [block.text];
				if (block.type === "list") return block.items;
				return [];
			})
			.join("\n");
		expect(allText).toContain("Source quality analysis");
		expect(allText).toContain(
			"The report should discuss source quality without being mistaken for a bibliography.",
		);
		expect(allText).not.toContain("Sources consulted by the model");
		expect(allText).not.toContain("https://unaccepted.example.com/model-only");
		expect(allText).not.toContain("Model-only source appendix text");
		expect(source.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						expect.objectContaining({
							title: "Accepted source",
							url: "https://example.com/accepted",
						}),
					],
				}),
			]),
		);
	});

	it("keeps key takeaways as optional compact section callouts instead of a forced report-wide top block", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "AI Market Atlas",
			assembledMarkdown: [
				"# AI Market Atlas",
				"",
				"## Executive Summary",
				"Market growth is concentrated in vendors that can pair enterprise controls with practical deployment support.",
				"",
				"## Enterprise adoption pressure",
				"Dense adoption evidence spans buyer controls, implementation support, regulated rollout timelines, and measurable support outcomes across several source clusters.",
				"",
				"### Key takeaway",
				"Enterprise controls matter most when rollouts span regulated workflows and support teams.",
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

		expect(source.blocks[0]).not.toMatchObject({
			type: "callout",
			title: "Key takeaway",
			text: "Market growth is concentrated in vendors that can pair enterprise controls with practical deployment support.",
		});
		expect(source.blocks).toEqual(
			expect.arrayContaining([
				{
					type: "callout",
					tone: "tip",
					title: "Key takeaway",
					text: "Enterprise controls matter most when rollouts span regulated workflows and support teams.",
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
		expect(source.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "heading",
					text: "Key takeaway",
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
			]),
		);
		expect(source.blocks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "heading",
					text: "Őszinteségi jelölések",
				}),
				expect.objectContaining({ type: "confidenceMarker" }),
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

	it("waits for an asynchronously claimed file-production output job before returning file ids", async () => {
		vi.useFakeTimers();
		vi.setTimerTickMode("nextTimerAsync");
		const { buildAtlasDocumentSource, renderAtlasOutputs } = await import(
			"./renderer-output"
		);
		const source = buildAtlasDocumentSource({
			title: "Async Atlas Output",
			assembledMarkdown: "## Executive Summary\nAtlas output should wait.",
			sources: [],
			honestyMarkers: [],
		});
		const runningJob = fileProductionJob({
			id: "fp-job-async",
			status: "running",
			files: [],
		});
		const succeededJob = fileProductionJob({
			id: "fp-job-async",
			status: "succeeded",
			files: [
				{
					id: "file-html",
					filename: "atlas.html",
					mimeType: "text/html",
					sizeBytes: 12,
					downloadUrl: "/download/html",
					previewUrl: "/preview/html",
				},
				{
					id: "file-pdf",
					filename: "atlas.pdf",
					mimeType: "application/pdf",
					sizeBytes: 12,
					downloadUrl: "/download/pdf",
					previewUrl: "/preview/pdf",
				},
				{
					id: "file-md",
					filename: "atlas.md",
					mimeType: "text/markdown",
					sizeBytes: 12,
					downloadUrl: "/download/md",
					previewUrl: null,
				},
			],
		});
		fileProductionMocks.submitFileProductionIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: runningJob,
			reused: false,
		});
		fileProductionMocks.listConversationFileProductionJobs
			.mockResolvedValueOnce([runningJob])
			.mockResolvedValueOnce([succeededJob]);

		const outputs = await renderAtlasOutputs({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			jobId: "atlas-job-async",
			source,
		});

		expect(outputs).toEqual({
			fileProductionJobId: "fp-job-async",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		});
	});
});
