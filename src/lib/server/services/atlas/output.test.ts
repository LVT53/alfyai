import { marked } from "marked";
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

	it("converts confidence-marker paragraphs that follow headings into callout blocks", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Test Confidence Markers",
			assembledMarkdown:
				"## Analysis\n\n✅ Confirmed: This fact is verified by official sources.\n\n⚠️ Unverified: This claim fluctuates year to year.\n\n## Other Section\n\nRegular paragraph with no marker.",
			sources: [],
			honestyMarkers: [],
		});

		const analysisHeadingIndex = source.blocks.findIndex(
			(block) => block.type === "heading" && block.text === "Analysis",
		);
		expect(analysisHeadingIndex).toBeGreaterThanOrEqual(0);

		const confirmedCallout = source.blocks[analysisHeadingIndex + 1];
		expect(confirmedCallout?.type).toBe("callout");
		if (confirmedCallout?.type === "callout") {
			expect(confirmedCallout.title).toBe("✅ Confirmed");
			expect(confirmedCallout.tone).toBe("tip");
			expect(confirmedCallout.text).toBe(
				"This fact is verified by official sources.",
			);
		}

		const unverifiedCallout = source.blocks[analysisHeadingIndex + 2];
		expect(unverifiedCallout?.type).toBe("callout");
		if (unverifiedCallout?.type === "callout") {
			expect(unverifiedCallout.title).toBe("⚠️ Unverified");
			expect(unverifiedCallout.tone).toBe("warning");
			expect(unverifiedCallout.text).toBe(
				"This claim fluctuates year to year.",
			);
		}

		// Regular paragraph after "Other Section" heading should remain unchanged
		const otherHeadingIndex = source.blocks.findIndex(
			(block) => block.type === "heading" && block.text === "Other Section",
		);
		expect(otherHeadingIndex).toBeGreaterThanOrEqual(0);
		const regularParagraph = source.blocks[otherHeadingIndex + 1];
		expect(regularParagraph?.type).toBe("paragraph");
		if (regularParagraph?.type === "paragraph") {
			expect(regularParagraph.text).toBe("Regular paragraph with no marker.");
		}
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

	it("rejects decorative image candidates whose only query relevance comes from the source page", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Enterprise search architecture decisions should combine lexical retrieval, semantic retrieval, and reranking.",
				"",
				"## Findings",
				"The report body is relevant, but decorative artwork should not become evidence just because it came from a relevant page.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-candidate-decorative",
					query: "enterprise search architecture",
					title: "Abstract blue technology hero banner",
					imageUrl: "https://example.com/hero-banner.png",
					sourcePageUrl: "https://example.com/enterprise-search-architecture",
					sourceTitle: "Enterprise search architecture reference guide",
					thumbnailUrl: null,
					width: 1200,
					height: 800,
					caption: "Decorative stock background with glowing lines",
					selectionReason: "Image result for enterprise search architecture.",
				},
			],
			maxRenderedImages: 1,
		});

		expect(
			source.blocks.filter((block) => block.type === "image"),
		).toHaveLength(0);
	});

	it("rejects generic AI model stock images for embedding retrieval reports", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Embedding Model Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"English technical-document retrieval decisions should compare embedding quality, reranking fit, latency, memory, and deployment constraints.",
				"",
				"## Findings",
				"Relevant visuals should show embedding retrieval, vectors, indexing, or document-search architecture rather than generic AI artwork.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-candidate-stock-ai",
					query: "best self-hosted embedding models English retrieval",
					title: "Flowchart of vibe coding process with ai model integration",
					imageUrl: "https://images.unsplash.com/photo-stock-flowchart.jpg",
					sourcePageUrl: "https://unsplash.com/photos/stock-ai-flowchart",
					sourceTitle: "Unsplash",
					thumbnailUrl: null,
					width: 1080,
					height: 720,
					caption:
						"Flowchart of vibe coding process with ai model integration.",
					selectionReason: "Image result for embedding models.",
				},
			],
			maxRenderedImages: 1,
		});

		expect(
			source.blocks.filter((block) => block.type === "image"),
		).toHaveLength(0);
	});

	it("rejects managed API comparison hero images for self-hosted embedding retrieval reports", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Self-Hosted Embedding Model Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Self-hosted embedding model decisions should prioritize local deployment, retrieval quality, vector indexing, reranking, latency, and single-GPU serving constraints.",
				"",
				"## Scope Boundary",
				"Managed API comparisons such as OpenAI versus Gemini are useful contrast, but they are not evidence for a self-hosted retrieval deployment recommendation.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-ofox-managed-api-comparison",
					query:
						"best self-hosted embedding models English technical-document retrieval latency cost single GPU reranker",
					title:
						"Text Embedding Models Compared: OpenAI vs Gemini via One API (2026)",
					imageUrl:
						"https://ofox.ai/_next/image?url=%2Fblog%2Ftext-embedding-models-compared-openai-vs-gemini-via-one-api-2026.png",
					sourcePageUrl:
						"https://ofox.ai/blog/text-embedding-models-compared-openai-vs-gemini-via-one-api-2026",
					sourceTitle:
						"Text Embedding Models Compared: OpenAI vs Gemini via One API (2026)",
					thumbnailUrl: null,
					width: 1200,
					height: 630,
					caption:
						"Text Embedding Models Compared: OpenAI vs Gemini via One API (2026)",
					selectionReason: "Image result for self-hosted embedding models.",
				},
			],
			maxRenderedImages: 1,
		});

		expect(
			source.blocks.filter((block) => block.type === "image"),
		).toHaveLength(0);
	});

	it("keeps embedding retrieval architecture images for self-hosted deployment reports", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Self-Hosted Embedding Model Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Self-hosted embedding model decisions should prioritize local deployment, retrieval quality, vector indexing, reranking, latency, and single-GPU serving constraints.",
				"",
				"## Retrieval Architecture",
				"The most useful visual for this report is an architecture diagram that clarifies the local embedding server, document chunks, vector index, retrieval stage, and reranker.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-self-hosted-retrieval-architecture",
					query:
						"best self-hosted embedding models English technical-document retrieval latency cost single GPU reranker",
					title: "Self-hosted embedding retrieval architecture diagram",
					imageUrl:
						"https://example.com/self-hosted-embedding-retrieval-architecture.png",
					sourcePageUrl:
						"https://example.com/self-hosted-rag-retrieval-deployment",
					sourceTitle: "Self-hosted RAG retrieval deployment architecture",
					thumbnailUrl: null,
					width: 1400,
					height: 900,
					caption:
						"Architecture diagram showing local embedding model serving, a vector index, document retrieval, and reranking.",
					selectionReason: "Image result for self-hosted embedding retrieval.",
				},
			],
			maxRenderedImages: 1,
		});

		const imageBlocks = source.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			source: {
				kind: "https",
				url: "https://example.com/self-hosted-embedding-retrieval-architecture.png",
			},
			caption:
				"Architecture diagram showing local embedding model serving, a vector index, document retrieval, and reranking.",
		});
	});

	it("rejects generic article cover and blog diagrams without strong subject relevance", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Embedding Model Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"English technical-document retrieval decisions should compare embedding quality, reranking fit, latency, memory, and deployment constraints.",
				"",
				"## Findings",
				"Relevant visuals should clarify the selected retrieval stack, not decorate a blog article.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-medium-chunking",
					query: "embedding model retrieval reranking architecture",
					title: "Chunking strategy diagram",
					imageUrl: "https://miro.medium.com/v2/resize:fit:1400/chunking.png",
					sourcePageUrl: "https://medium.com/example/chunking-for-rag",
					sourceTitle: "Medium article about RAG chunking",
					thumbnailUrl: null,
					width: 1200,
					height: 675,
					caption: "Generic diagram for chunking strategies",
					selectionReason: "Image result for embedding retrieval.",
				},
				{
					id: "image-zilliz-cover",
					query: "embedding model retrieval reranking architecture",
					title: "Blog cover image",
					imageUrl: "https://zilliz.com/blog/assets/embedding-rag-cover.png",
					sourcePageUrl: "https://zilliz.com/blog/embedding-models-rag",
					sourceTitle: "Zilliz blog cover for embedding models",
					thumbnailUrl: null,
					width: 1200,
					height: 675,
					caption: "Featured image for an embedding models article",
					selectionReason: "Image result for embedding retrieval.",
				},
			],
			maxRenderedImages: 2,
		});

		expect(
			source.blocks.filter((block) => block.type === "image"),
		).toHaveLength(0);
	});

	it("requires image caption and source relevance before inserting a candidate", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Embedding Retrieval Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Embedding retrieval decisions should compare model quality, reranking, latency, and deployment cost.",
				"",
				"## Retrieval Architecture",
				"Relevant visuals should clarify the embedding retrieval stack, vector indexing, or reranking responsibilities.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-postgres-scaling",
					query: "postgresql scaling embedding retrieval",
					title: "Scaling for millions: PostgreSQL",
					imageUrl: "https://miro.medium.com/v2/resize:fit:1358/postgresql.png",
					sourcePageUrl:
						"https://medium.com/@example/scaling-for-millions-postgresql",
					sourceTitle: "Medium PostgreSQL scaling guide",
					thumbnailUrl: null,
					width: 1200,
					height: 675,
					caption: "PostgreSQL scaling diagram for millions of rows",
					selectionReason: "Image result from a mixed image-search query.",
				},
			],
			maxRenderedImages: 1,
		});

		expect(
			source.blocks.filter((block) => block.type === "image"),
		).toHaveLength(0);
	});

	it("keeps source-backed image candidates when visual text and source title both support the report query", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Enterprise Search Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Enterprise search architecture decisions should combine lexical retrieval, semantic retrieval, and reranking.",
				"",
				"## Findings",
				"Architecture diagrams clarify ingestion, indexing, retrieval, and reranking responsibilities.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-candidate-source-backed",
					query: "enterprise search architecture",
					title: "Reference architecture diagram",
					imageUrl: "https://example.com/reference-architecture.png",
					sourcePageUrl: "https://example.com/enterprise-search-architecture",
					sourceTitle: "Enterprise search architecture reference guide",
					thumbnailUrl: null,
					width: 1200,
					height: 800,
					caption: "Architecture diagram for the retrieval stack",
					selectionReason: "Image result for enterprise search architecture.",
				},
			],
			maxRenderedImages: 1,
		});

		const imageBlocks = source.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			source: {
				kind: "https",
				url: "https://example.com/reference-architecture.png",
			},
			caption: "Architecture diagram for the retrieval stack",
		});
	});

	it("deduplicates deterministic image candidates from the same article page", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Embedding Retrieval Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Embedding retrieval architecture choices should compare model quality, reranking, latency, and deployment cost.",
				"",
				"## Retrieval Architecture",
				"Embedding retrieval architecture diagrams are useful when they clarify model hosting, vector indexing, and reranking responsibilities.",
				"",
				"## Reranking",
				"Reranking changes both retrieval quality and latency, so it should be evaluated with the embedding model.",
				"",
				"## Latency",
				"Latency depends on model size, batching, quantization, and whether the reranker is resident.",
				"",
				"## Deployment",
				"Deployment choices should keep memory, serving maturity, and observability visible.",
				"",
				"## Limitations",
				"The evidence remains representative rather than exhaustive.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			imageCandidates: [
				{
					id: "image-medium-1",
					query: "embedding retrieval architecture reranking",
					title: "Embedding retrieval architecture diagram",
					imageUrl: "https://miro.medium.com/v2/resize:fit:1358/one.png",
					sourcePageUrl:
						"https://medium.com/@example/embedding-retrieval-architecture",
					sourceTitle: "Embedding retrieval architecture deep dive",
					thumbnailUrl: null,
					width: 1200,
					height: 675,
					caption:
						"Embedding retrieval architecture diagram with vector index and reranking.",
					selectionReason: "Image result for embedding retrieval.",
				},
				{
					id: "image-medium-2",
					query: "embedding retrieval architecture reranking",
					title: "Embedding retrieval architecture diagram",
					imageUrl: "https://miro.medium.com/v2/resize:fit:1358/two.png",
					sourcePageUrl:
						"https://medium.com/@example/embedding-retrieval-architecture#diagram",
					sourceTitle: "Embedding retrieval architecture deep dive",
					thumbnailUrl: null,
					width: 1200,
					height: 675,
					caption:
						"Embedding retrieval architecture diagram with vector index and reranking.",
					selectionReason: "Image result for embedding retrieval.",
				},
			],
			maxRenderedImages: 3,
		});

		const imageBlocks = source.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			source: {
				kind: "https",
				url: "https://miro.medium.com/v2/resize:fit:1358/one.png",
			},
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
			imageCandidates: [
				{
					id: "cand-1",
					query: "crowded visual atlas",
					title: "Crowded visual atlas first image",
					imageUrl: "https://example.com/authored-1.png",
					sourcePageUrl: "https://example.com/source-1",
					sourceTitle: "Source 1",
					thumbnailUrl: null,
					width: 800,
					height: 600,
					caption: "First authored image for crowded visual atlas",
					selectionReason: "Image result for crowded visual atlas.",
				},
				{
					id: "cand-2",
					query: "crowded visual atlas",
					title: "Crowded visual atlas second image",
					imageUrl: "https://example.com/authored-2.png",
					sourcePageUrl: "https://example.com/source-2",
					sourceTitle: "Source 2",
					thumbnailUrl: null,
					width: 800,
					height: 600,
					caption: "Second authored image for crowded visual atlas",
					selectionReason: "Image result for crowded visual atlas.",
				},
			],
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
		// Executive Summary section claim basis entries are skipped
		expect(paragraphs[0].basisMarkers).toBeUndefined();
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

	it("skips claim basis markers for Executive Summary but still marks Evidence Summary sections", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Exec Summary Exemption Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Hybrid retrieval improves recall before reranking.",
				"",
				"## Evidence Summary",
				"Multiple sources confirm the hybrid approach is effective.",
				"",
				"## Cost Summary",
				"Implementation costs are estimated at $50K.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			claimBasis: [
				{
					version: "atlas.claim-basis.v1",
					id: "basis-exec",
					locator: {
						sectionTitle: "Executive Summary",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "Hybrid retrieval improves recall before reranking.",
						quote: null,
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "supported",
					evidencePackIds: ["pack-1"],
					sourceRefs: [],
					supportRationale:
						"Hybrid retrieval evidence confirms recall improvement.",
					auditConcernCode: null,
				},
				{
					version: "atlas.claim-basis.v1",
					id: "basis-evidence-summary",
					locator: {
						sectionTitle: "Evidence Summary",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText:
							"Multiple sources confirm the hybrid approach is effective.",
						quote: null,
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "supported",
					evidencePackIds: ["pack-2"],
					sourceRefs: [],
					supportRationale:
						"Multiple accepted evidence packs confirm effectiveness.",
					auditConcernCode: null,
				},
				{
					version: "atlas.claim-basis.v1",
					id: "basis-cost",
					locator: {
						sectionTitle: "Cost Summary",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "Implementation costs are estimated at $50K.",
						quote: null,
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: [],
					sourceRefs: [],
					supportRationale:
						"Cost estimates are preliminary and not fully sourced.",
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
		// Executive Summary paragraph has NO basis markers (exempted)
		expect(paragraphs[0].basisMarkers).toBeUndefined();
		// Evidence Summary paragraph still has a basis marker
		expect(paragraphs[1].basisMarkers).toHaveLength(1);
		expect(paragraphs[1].basisMarkers?.[0]).toMatchObject({
			id: "basis-evidence-summary",
			support: "supported",
		});
		// Cost Summary paragraph still has a basis marker
		expect(paragraphs[2].basisMarkers).toHaveLength(1);
		expect(paragraphs[2].basisMarkers?.[0]).toMatchObject({
			id: "basis-cost",
			support: "partial",
		});
	});

	it("drops unlocatable Atlas Claim Basis markers without an Executive Summary section fallback", async () => {
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
		// No paragraph should have basis markers since the only target
		// section does not exist and the exec summary fallback is skipped
		expect(paragraphs.some((paragraph) => paragraph.basisMarkers?.length)).toBe(
			false,
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

	it("deduplicates basis markers and maps section aliases to the matching paragraph", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Basis Alias Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				"Embedding retrieval selection needs a measured rollout path.",
				"",
				"## Tradeoffs",
				"Latency and retrieval quality have to be evaluated together.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			claimBasis: [
				{
					version: "atlas.claim-basis.v1",
					id: "basis-exec-plain",
					locator: {
						sectionTitle: "Executive Summary",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText:
							"Embedding retrieval selection needs a measured rollout path.",
						quote: null,
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: ["pack-1"],
					sourceRefs: [],
					supportRationale:
						"Accepted sources provide section-level evidence for Executive Summary.",
					auditConcernCode: "atlas_claim_basis_section_fallback",
				},
				{
					version: "atlas.claim-basis.v1",
					id: "basis-exec-bold",
					locator: {
						sectionTitle: "**Executive Summary**",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText:
							"Embedding retrieval selection needs a measured rollout path.",
						quote: null,
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: ["pack-1"],
					sourceRefs: [],
					supportRationale:
						"Accepted sources provide section-level evidence for **Executive Summary**.",
					auditConcernCode: "atlas_claim_basis_section_fallback",
				},
				{
					version: "atlas.claim-basis.v1",
					id: "basis-model-tradeoffs",
					locator: {
						sectionTitle: "Model Tradeoffs",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText:
							"Latency and retrieval quality have to be evaluated together.",
						quote: null,
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: ["pack-2"],
					sourceRefs: [],
					supportRationale:
						"Accepted sources provide section-level evidence for Model Tradeoffs.",
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
		// Executive Summary section claim basis entries are skipped
		expect(paragraphs[0].basisMarkers).toBeUndefined();
		expect(paragraphs[1].basisMarkers).toEqual([
			expect.objectContaining({
				id: "basis-model-tradeoffs",
				anchorText:
					"Latency and retrieval quality have to be evaluated together.",
			}),
		]);
	});

	it("matches claims with normalized anchor text when exact whitespace or case differs", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Normalized Anchor Atlas",
			assembledMarkdown: [
				"## Efficiency",
				"Heat  pumps are efficient. They save  energy.",
			].join("\n"),
			sources: [
				{
					title: "Energy study",
					url: "https://example.com/study",
					reasoning: "Accepted evidence.",
				},
			],
			honestyMarkers: [],
			claimBasis: [
				{
					version: "atlas.claim-basis.v1",
					id: "basis-heat-pumps",
					locator: {
						sectionTitle: "Efficiency",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "Heat pumps are efficient.",
						quote: "heat pumps are efficient",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "supported",
					evidencePackIds: ["pack-1"],
					sourceRefs: [
						{
							id: "source-1",
							kind: "web",
							title: "Energy study",
							url: "https://example.com/study",
							authority: "accepted_web",
						},
					],
					supportRationale: "Energy study confirms heat pump efficiency.",
					auditConcernCode: null,
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
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0].basisMarkers).toHaveLength(1);
		expect(paragraphs[0].basisMarkers?.[0]).toMatchObject({
			id: "basis-heat-pumps",
			support: "supported",
		});
		const marker = paragraphs[0].basisMarkers?.[0];
		expect(marker?.anchorText).toBeTruthy();
		expect(
			paragraphs[0].text
				.toLowerCase()
				.includes((marker?.anchorText ?? "").toLowerCase()),
		).toBe(true);
	});

	it("places unplaceable markers after the first sentence instead of full paragraph end", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "First Sentence Fallback Atlas",
			assembledMarkdown: [
				"## Risks",
				"Market signals are unresolved. Adoption is uncertain. More research is needed.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			claimBasis: [
				{
					version: "atlas.claim-basis.v1",
					id: "basis-unmatched",
					locator: {
						sectionTitle: "Risks",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText:
							"A claim that does not appear verbatim in the report text.",
						quote: "text that is nowhere in the paragraph",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: ["pack-1"],
					sourceRefs: [],
					supportRationale:
						"Section-level evidence without claim-level anchor.",
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
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0].basisMarkers).toHaveLength(1);
		const anchorText = paragraphs[0].basisMarkers?.[0]?.anchorText ?? "";
		const fullParagraphText = paragraphs[0].text;
		expect(anchorText).not.toBe(fullParagraphText);
		expect(anchorText.length).toBeLessThan(fullParagraphText.length);
		expect(fullParagraphText).toContain(anchorText);
		expect(anchorText).toBe("Market signals are unresolved.");
	});

	it("distributes multiple unplaced markers across sentences in the same paragraph", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");

		const source = buildAtlasDocumentSource({
			title: "Multi Marker Distribution Atlas",
			assembledMarkdown: [
				"## Analysis",
				"First claim point. Second claim area. Third claim topic.",
			].join("\n"),
			sources: [],
			honestyMarkers: [],
			claimBasis: [
				{
					version: "atlas.claim-basis.v1",
					id: "basis-claim-a",
					locator: {
						sectionTitle: "Analysis",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "Claim A that is not verbatim in the text.",
						quote: "nowhere found claim A",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: ["pack-1"],
					sourceRefs: [],
					supportRationale: "Section-level fallback for claim A.",
					auditConcernCode: "atlas_claim_basis_section_fallback",
				},
				{
					version: "atlas.claim-basis.v1",
					id: "basis-claim-b",
					locator: {
						sectionTitle: "Analysis",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "Claim B that is not verbatim in the text.",
						quote: "nowhere found claim B",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: ["pack-2"],
					sourceRefs: [],
					supportRationale: "Section-level fallback for claim B.",
					auditConcernCode: "atlas_claim_basis_section_fallback",
				},
				{
					version: "atlas.claim-basis.v1",
					id: "basis-claim-c",
					locator: {
						sectionTitle: "Analysis",
						paragraphIndex: 0,
						claimIndex: 0,
						claimText: "Claim C that is not verbatim in the text.",
						quote: "nowhere found claim C",
						startOffset: null,
						endOffset: null,
					},
					supportLevel: "partial",
					evidencePackIds: ["pack-3"],
					sourceRefs: [],
					supportRationale: "Section-level fallback for claim C.",
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
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0].basisMarkers).toHaveLength(3);
		const anchors = paragraphs[0].basisMarkers?.map((m) => m.anchorText) ?? [];
		expect(anchors[0]).toBe("First claim point.");
		expect(anchors[1]).toBe("Second claim area.");
		expect(anchors[2]).toBe("Third claim topic.");
		const unique = new Set(anchors);
		expect(unique.size).toBe(3);
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

	it("compacts long fetched snippets in deterministic source chips", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");
		const longFetchedSnippet = [
			"Search result snippet: Framework routing docs.",
			"Fetched page excerpt:",
			Array.from(
				{ length: 120 },
				(_, index) =>
					`RAW_EXCERPT_SENTINEL_${index} navigation boilerplate paragraph copied from the fetched page`,
			).join(" "),
		].join(" ");

		const source = buildAtlasDocumentSource({
			title: "Compact Source Atlas",
			assembledMarkdown:
				"## Executive Summary\nAtlas keeps source identity visible without publishing fetched-page excerpts as the report body.",
			sources: [
				{
					title: "Routing docs",
					url: "https://example.com/routing",
					reasoning: longFetchedSnippet,
				},
			],
			honestyMarkers: [],
		});

		const webSources = source.blocks.find(
			(block) => block.type === "sourceChips" && block.title === "Web Sources",
		);
		if (webSources?.type !== "sourceChips") {
			throw new Error("Expected deterministic Web Sources source chips.");
		}
		const reasoning = webSources.sources[0]?.reasoning ?? "";

		expect(webSources.sources[0]).toMatchObject({
			title: "Routing docs",
			url: "https://example.com/routing",
		});
		expect(reasoning).toContain("Framework routing docs.");
		expect(reasoning.length).toBeLessThanOrEqual(240);
		expect(reasoning).not.toMatch(
			/Fetched page excerpt|Search result snippet|RAW_EXCERPT_SENTINEL/i,
		);
	});

	it("strips Search result snippet tail in withoutRawExcerptTail (asymmetry fix)", async () => {
		const { compactAtlasSourceRelevanceNote } = await import(
			"./renderer-output"
		);
		const result = compactAtlasSourceRelevanceNote({
			note: "The source provides useful context. Search result snippet: raw dump text that should be stripped from the reasoning note.",
			fallback: "Fallback reasoning",
		});
		expect(result).toContain("useful context");
		expect(result).not.toMatch(
			/Search result snippet|raw dump text|should be stripped/i,
		);
	});

	it("filters Hungarian YouTube UI boilerplate from English source notes", async () => {
		const { compactAtlasSourceRelevanceNote } = await import(
			"./renderer-output"
		);
		const result = compactAtlasSourceRelevanceNote({
			note: "The search result is relevant. Ismertető Sajtó Szerzői jog Kapcsolatfelvétel Alkotók Hirdetés Fejlesztők Feltételek Adatvédelem Irányelvek YouTube működése Új funkciók tesztelése. The main evidence supports the claim.",
			fallback: "Fallback reasoning",
		});
		expect(result).toContain("search result is relevant");
		expect(result).toContain("main evidence supports");
		expect(result).not.toMatch(/Ismertető|Sajtó|Szerzői jog/i);
	});

	it("filters SearXNG metadata echoes from source notes regardless of language", async () => {
		const { compactAtlasSourceRelevanceNote } = await import(
			"./renderer-output"
		);
		const result = compactAtlasSourceRelevanceNote({
			note: "Good evidence here. Nem tartalmazza a kért adatokat. Tartalmaznia kell más elemeket. The finding is corroborated.",
			fallback: "Fallback reasoning",
		});
		expect(result).toContain("Good evidence here");
		expect(result).not.toMatch(/Nem tartalmazza|Tartalmaznia kell/i);
	});

	it("filters Google copyright boilerplate from source notes", async () => {
		const { compactAtlasSourceRelevanceNote } = await import(
			"./renderer-output"
		);
		const result = compactAtlasSourceRelevanceNote({
			note: "The source analysis is accurate. Google LLC holds the rights. © 2026 Google. The report uses this data.",
			fallback: "Fallback reasoning",
		});
		expect(result).toContain("source analysis is accurate");
		expect(result).not.toMatch(/Google LLC|2026 Google/i);
	});

	it("preserves Hungarian UI patterns when language is hu", async () => {
		const { compactAtlasSourceRelevanceNote } = await import(
			"./renderer-output"
		);
		const result = compactAtlasSourceRelevanceNote({
			note: "A forrás hiteles. Ismertető és sajtó információk.",
			fallback: "Fallback reasoning",
			language: "hu",
		});
		expect(result).toContain("A forrás hiteles");
		expect(result).toContain("Ismertető");
	});

	it("passes language through sourceChipForAtlasSource to compactAtlasSourceRelevanceNote", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");
		const source = buildAtlasDocumentSource({
			title: "Hungarian Language Atlas",
			assembledMarkdown:
				"## Vezetői összefoglaló\nA magyar jelentés a friss forrásokra támaszkodik.",
			sources: [
				{
					title: "Magyar forrás",
					url: "https://example.com/hu",
					reasoning: "A forrás hiteles. Ismertető és sajtó információk.",
				},
			],
			honestyMarkers: [],
			language: "hu",
		});

		const webSources = source.blocks.find(
			(block) =>
				block.type === "sourceChips" && block.title === "Webes források",
		);
		if (webSources?.type !== "sourceChips") {
			throw new Error("Expected Webes források source chips.");
		}
		const reasoning = webSources.sources[0]?.reasoning ?? "";
		expect(reasoning).toContain("Ismertető");
		expect(reasoning).toContain("sajtó");
	});

	it("filters Hungarian UI patterns from English reports via sourceChipForAtlasSource", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");
		const source = buildAtlasDocumentSource({
			title: "English Language Atlas",
			assembledMarkdown:
				"## Executive Summary\nThe report analyzes market data.",
			sources: [
				{
					title: "English source",
					url: "https://example.com/en",
					reasoning:
						"The source is relevant. Ismertető Sajtó Szerzői jog. The evidence supports the finding.",
				},
			],
			honestyMarkers: [],
			language: "en",
		});

		const webSources = source.blocks.find(
			(block) => block.type === "sourceChips" && block.title === "Web Sources",
		);
		if (webSources?.type !== "sourceChips") {
			throw new Error("Expected Web Sources source chips.");
		}
		const reasoning = webSources.sources[0]?.reasoning ?? "";
		expect(reasoning).toContain("source is relevant");
		expect(reasoning).not.toMatch(/Ismertető|Sajtó|Szerzői jog/i);
	});

	it("sanitizeSourceTitle strips - YouTube suffix", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		const result = sanitizeSourceTitle(
			"Heat Pump Vs. Furnace - Which is BETTER? - YouTube",
		);
		expect(result).toBe("Heat Pump Vs. Furnace - Which is BETTER?");
	});

	it("sanitizeSourceTitle strips Reddit verification suffix", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		const result = sanitizeSourceTitle("Reddit - Please wait for verification");
		expect(result).toBe("Reddit");
	});

	it("sanitizeSourceTitle strips platform | suffix", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		expect(sanitizeSourceTitle("Cool content | Instagram")).toBe(
			"Cool content",
		);
		expect(sanitizeSourceTitle("Facebook post | Facebook")).toBe(
			"Facebook post",
		);
		expect(sanitizeSourceTitle("TikTok trends | TikTok")).toBe("TikTok trends");
	});

	it("sanitizeSourceTitle strips Hungarian date prefix", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		const result = sanitizeSourceTitle(
			"2024. jan. 26. · Actual relevant content",
		);
		expect(result).toBe("Actual relevant content");
	});

	it("sanitizeSourceTitle strips SearXNG Nem tartalmazza echo", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		const result = sanitizeSourceTitle(
			"Nem tartalmazza: English | Tartalmaznia kell: technical | Best practices",
		);
		expect(result).toBe("Best practices");
	});

	it("sanitizeSourceTitle preserves legitimate platform names in titles", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		expect(sanitizeSourceTitle("YouTube: Best Embedding Models")).toBe(
			"YouTube: Best Embedding Models",
		);
		expect(sanitizeSourceTitle("Reddit discussion on AI")).toBe(
			"Reddit discussion on AI",
		);
		expect(sanitizeSourceTitle("Instagram Marketing Guide")).toBe(
			"Instagram Marketing Guide",
		);
		expect(sanitizeSourceTitle("TikTok for Business")).toBe(
			"TikTok for Business",
		);
	});

	it("sanitizeSourceTitle handles empty and whitespace-only input", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		expect(sanitizeSourceTitle("")).toBe("");
		expect(sanitizeSourceTitle("   ")).toBe("");
	});

	it("sanitizeSourceTitle preserves normal titles unchanged", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		expect(sanitizeSourceTitle("A Comprehensive Guide to RAG")).toBe(
			"A Comprehensive Guide to RAG",
		);
		expect(sanitizeSourceTitle("Understanding Vector Databases")).toBe(
			"Understanding Vector Databases",
		);
	});

	it("applies sanitizeSourceTitle through sourceChipForAtlasSource", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");
		const source = buildAtlasDocumentSource({
			title: "Sanitized Sources Atlas",
			assembledMarkdown:
				"## Executive Summary\nSanitized titles appear in source chips.",
			sources: [
				{
					title: "Heat Pump Guide - YouTube",
					url: "https://example.com/heat-pump",
					reasoning: "Accepted evidence.",
				},
			],
			honestyMarkers: [],
		});
		const webSources = source.blocks.find(
			(block) => block.type === "sourceChips" && block.title === "Web Sources",
		);
		if (webSources?.type !== "sourceChips") {
			throw new Error("Expected Web Sources source chips.");
		}
		expect(webSources.sources[0]?.title).toBe("Heat Pump Guide");
	});

	it("regression: existing source projection tests still pass", async () => {
		const { compactAtlasSourceRelevanceNote } = await import(
			"./renderer-output"
		);
		const result = compactAtlasSourceRelevanceNote({
			note: "Accepted source evidence. Subscribe to our newsletter. Read the privacy policy.",
			fallback: "Fallback reasoning",
		});
		expect(result).toContain("Accepted source evidence");
		expect(result).not.toMatch(/subscribe|privacy policy/i);
	});

	it("falls back when source-chip reasoning starts directly with a fetched excerpt", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");
		const rawFirstSnippet = [
			"Fetched page excerpt:",
			Array.from(
				{ length: 80 },
				(_, index) =>
					`RAW_FIRST_SENTINEL_${index} copied source paragraph that should not publish`,
			).join(" "),
		].join(" ");

		const source = buildAtlasDocumentSource({
			title: "Raw First Source Atlas",
			assembledMarkdown:
				"## Executive Summary\nAtlas should not publish raw fetched excerpts when the source note starts with a dump label.",
			sources: [
				{
					title: "Raw source",
					url: "https://example.com/raw",
					reasoning: rawFirstSnippet,
				},
			],
			honestyMarkers: [],
		});

		const webSources = source.blocks.find(
			(block) => block.type === "sourceChips" && block.title === "Web Sources",
		);
		if (webSources?.type !== "sourceChips") {
			throw new Error("Expected deterministic Web Sources source chips.");
		}

		expect(webSources.sources[0]).toMatchObject({
			title: "Raw source",
			url: "https://example.com/raw",
			reasoning: "Accepted web evidence gathered by Atlas",
		});
	});

	it("diagnoses source-dominated reports as warnings without throwing", async () => {
		const { diagnoseAtlasReportShape } = await import(
			"./report-shape-diagnostics"
		);
		const sourceDump = Array.from(
			{ length: 1_200 },
			(_, index) => `sourceword${index}`,
		).join(" ");

		const diagnostics = diagnoseAtlasReportShape(
			[
				"## Executive Summary",
				"The report is currently too thin.",
				"",
				"## Findings",
				"Evidence exists but the synthesis is still shallow.",
				"",
				"## Tradeoffs",
				"Tradeoffs are mentioned without comparison.",
				"",
				"## Recommendation",
				"Recommendation remains unclear.",
				"",
				"## Limitations",
				"Coverage is limited.",
				"",
				"## Sources",
				"### Web Sources",
				`- [Routing docs](https://example.com/routing) Fetched page excerpt: ${sourceDump}`,
			].join("\n"),
		);

		const warningCodes = diagnostics.warnings.map((warning) => warning.code);
		expect(diagnostics.bodyWordCount).toBeLessThan(80);
		expect(diagnostics.sourceWordCount).toBeGreaterThan(1_000);
		expect(diagnostics.sourceWordShare).toBeGreaterThan(0.9);
		expect(warningCodes).toEqual(
			expect.arrayContaining([
				"atlas_report_body_too_thin",
				"atlas_source_projection_dominates_report",
				"atlas_recommendation_not_decisive",
			]),
		);
	});

	it("diagnoses sparse one-sentence reports with hollow recommendations", async () => {
		const { diagnoseAtlasReportShape } = await import(
			"./report-shape-diagnostics"
		);
		const diagnostics = diagnoseAtlasReportShape(
			[
				"## Executive Summary",
				"English technical-document retrieval needs a source-grounded model comparison across quality, latency, hardware fit, memory pressure, serving maturity, reranking compatibility, and maintenance boundaries, but the draft only names those criteria without resolving the operator choice.",
				"",
				"## Model Shortlist",
				"BGE, GTE, E5, Jina, and Nomic families appear in the accepted evidence with different multilingual coverage, embedding dimensions, operational maturity, licensing posture, reranker fit, and deployment assumptions for single-GPU operation.",
				"",
				"## Retrieval Quality",
				"Benchmark references are useful but incomplete because production retrieval depends on corpus chunking, query mix, reranker availability, technical vocabulary, document length, and validation against representative technical documents.",
				"",
				"## Latency and Cost",
				"Latency and cost depend on embedding dimension, batching, quantization, reranking depth, serving runtime, cache behavior, and whether the system can keep both embedder and reranker resident.",
				"",
				"## Deployment Implications",
				"Single-RT deployment favors models with predictable memory requirements, stable serving support, clear licensing, simple observability, tested fallback behavior, and enough multilingual behavior for the expected English-first workload.",
				"",
				"## Recommendation",
				"Recommendation for English Technical-Document Retrieval.",
				"",
				"## Limitations",
				"The evidence remains incomplete across identical hardware, identical corpora, current production latency measurements, matching reranker settings, and long-document retrieval workloads, so confidence is bounded by source coverage.",
				"",
				"## Evidence Gaps",
				"Several sources discuss benchmarks or production factors separately, but few connect all constraints into a definitive single-GPU deployment comparison with shared metrics and reproducible settings.",
			].join("\n"),
		);

		const warningCodes = diagnostics.warnings.map((warning) => warning.code);
		expect(diagnostics.bodyWordCount).toBeGreaterThan(220);
		expect(diagnostics.substantiveSectionCount).toBeLessThanOrEqual(1);
		expect(diagnostics.oneSentenceSectionCount).toBeGreaterThanOrEqual(8);
		expect(warningCodes).toEqual(
			expect.arrayContaining([
				"atlas_report_sections_too_sparse",
				"atlas_too_many_one_sentence_sections",
				"atlas_recommendation_not_decisive",
			]),
		);
	});

	it("diagnoses sentence-like claim headings while preserving concise section titles", async () => {
		const { diagnoseAtlasReportShape } = await import(
			"./report-shape-diagnostics"
		);
		const diagnostics = diagnoseAtlasReportShape(
			[
				"## Executive Summary",
				"The report starts with a legitimate concise section heading.",
				"",
				"## No single model dominates all domains",
				"This claim belongs in prose because claim-basis audit should evaluate it as a factual statement.",
				"",
				"## Qwen3 supports output dimensions 32-1024",
				"This claim also belongs in prose rather than a section title.",
				"",
				"## Tradeoffs",
				"Tradeoffs is a legitimate concise report section title.",
			].join("\n"),
		);

		expect(diagnostics.claimShapedHeadingCount).toBe(2);
		expect(diagnostics.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "atlas_claim_shaped_headings" }),
			]),
		);
	});

	it("does not warn when a substantive body has compact source projection", async () => {
		const { buildAtlasDocumentSource } = await import("./renderer-output");
		const { diagnoseAtlasReportShape } = await import(
			"./report-shape-diagnostics"
		);
		const bodyParagraph = [
			"Hybrid retrieval is the recommended default because it gives exact-term recall, semantic discovery, and a clear path to reranking without locking the team into one retrieval mode.",
			"Operationally, the strongest stack starts with measurable corpus evaluation, keeps source-level logging, and treats latency budgets as a design constraint rather than a post-launch tuning exercise.",
			"Teams should avoid publishing broad claims from a single benchmark and should validate the selected approach on representative internal documents before production rollout.",
		].join(" ");

		const source = buildAtlasDocumentSource({
			title: "Substantive Atlas",
			assembledMarkdown: [
				"## Executive Summary",
				bodyParagraph,
				"",
				"## Recommendation",
				bodyParagraph,
				"",
				"## Tradeoffs",
				bodyParagraph,
				"",
				"## Limitations",
				bodyParagraph,
			].join("\n"),
			sources: [
				{
					title: "Architecture benchmark",
					url: "https://example.com/benchmark",
					reasoning: "Supports the hybrid retrieval recommendation.",
				},
			],
			honestyMarkers: [],
		});

		const diagnostics = diagnoseAtlasReportShape(source);
		const warningCodes = diagnostics.warnings.map((warning) => warning.code);

		expect(diagnostics.bodyWordCount).toBeGreaterThan(250);
		expect(diagnostics.sourceWordCount).toBeLessThan(40);
		expect(diagnostics.hasDecisionOrRecommendationSignal).toBe(true);
		expect(warningCodes).not.toContain("atlas_report_body_too_thin");
		expect(warningCodes).not.toContain(
			"atlas_source_projection_dominates_report",
		);
		expect(warningCodes).not.toContain("atlas_recommendation_not_decisive");
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
			imageCandidates: [
				{
					id: "cand-adoption",
					query: "AI market atlas vendor adoption",
					title: "Vendor adoption chart",
					imageUrl: "https://example.com/adoption.png",
					sourcePageUrl: "https://example.com/benchmark",
					sourceTitle: "Vendor benchmark",
					thumbnailUrl: null,
					width: 800,
					height: 600,
					caption: "Vendor benchmark adoption chart",
					selectionReason: "Image result for vendor adoption.",
				},
			],
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

describe("sanitizeMarkdownForLexer", () => {
	it("escapes stray > at line start so marked.lexer sees a paragraph", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer(
			"The population is \n> 5 million.",
		);
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "blockquote")).toBe(false);
		expect(tokens.some((t) => t.type === "paragraph")).toBe(true);
	});

	it("preserves intentional multi-line blockquote so marked.lexer sees a blockquote", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer(
			"> This is a quote.\n> It spans two lines.",
		);
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "blockquote")).toBe(true);
	});

	it("escapes --- between paragraphs without blank line so marked.lexer does not produce an hr", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer(
			"Findings above.\n---\nFindings below.",
		);
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "hr")).toBe(false);
	});

	it("preserves --- with blank lines so marked.lexer produces an hr", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer(
			"Findings above.\n\n---\n\nFindings below.",
		);
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "hr")).toBe(true);
	});

	it("escapes #tag at line start so marked.lexer does not produce a heading", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer("#hashtag is not a heading.");
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "heading")).toBe(false);
	});

	it("preserves ## Heading so marked.lexer produces a heading", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer("## This is a heading");
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "heading")).toBe(true);
	});

	it("escapes stray pipe-delimited line without table separator so marked.lexer sees a paragraph", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer(
			"| 2 H5 & 4 O6/H7 in six Leaving Certificate subjects | ✅ Confirmed | Official TUS course page |",
		);
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "table")).toBe(false);
		expect(tokens.some((t) => t.type === "paragraph")).toBe(true);
	});

	it("preserves valid GFM table with separator row so marked.lexer produces a table", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer(
			"| Requirement | Confidence | Source |\n|---|---|---|\n| 2 H5 & 4 O6/H7 | ✅ Confirmed | TUS page |",
		);
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "table")).toBe(true);
	});

	it("preserves valid GFM table with separator on adjacent line", async () => {
		const { sanitizeMarkdownForLexer } = await import("./renderer-output");
		const sanitized = sanitizeMarkdownForLexer(
			"Before text.\n\n| Col A | Col B |\n|---|---|\n| Data 1 | Data 2 |\n\nAfter text.",
		);
		const tokens = marked.lexer(sanitized, { gfm: true });
		expect(tokens.some((t) => t.type === "table")).toBe(true);
		expect(tokens.some((t) => t.type === "paragraph")).toBe(true);
	});
});
