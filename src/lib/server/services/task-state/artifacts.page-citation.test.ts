/**
 * Page citations in the prompt's document excerpts.
 *
 * Two things are being pinned here, and the second matters more than the
 * first. One: which documents may be cited at all — only the page kinds that
 * describe a real page (physical, spine, slide, sheet) and only when there is
 * more than one of them, because DOCX reports `page_count: 1, kind:
 * "declared"` for a four-heading document and CSV/HTML report `logical`, so
 * "[p. 1]" there would be an invention rather than a citation. Two: that a
 * citation DISPLACES body text instead of adding to the prompt. A retrieval
 * feature that quietly grows every turn's context is a regression whatever it
 * cites.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { serializeWorkingSetArtifacts } from "$lib/server/utils/prompt-context";
import { estimateTokenCount } from "$lib/utils/tokens";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(),
}));

vi.mock("./control-model", () => ({
	canUseContextSummarizer: vi.fn(() => false),
	requestContextSummarizer: vi.fn(),
}));

const {
	formatPageCitation,
	getPromptArtifactSnippets,
	resolveArtifactPageLabel,
	selectDocumentPassages,
} = await import("./artifacts");

const USER = "user-1";
const NOW = new Date("2026-09-20T10:00:00.000Z");
const QUERY = "ledger";

interface SeedChunk {
	text: string;
	pageStart?: number | null;
	pageEnd?: number | null;
}

function seedDocument(params: {
	pageCountKind?: string;
	pageCount?: number;
	chunks: SeedChunk[];
	contentText?: string;
}): Artifact {
	const id = randomUUID();
	const metadata: Record<string, unknown> = {};
	if (params.pageCountKind) metadata.pageCountKind = params.pageCountKind;
	if (params.pageCount !== undefined) metadata.pageCount = params.pageCount;

	memory.db
		.insert(schema.artifacts)
		.values({
			id,
			userId: USER,
			type: "normalized_document",
			name: `${id}.md`,
			contentText: params.contentText ?? params.chunks[0]?.text ?? "",
			metadataJson: JSON.stringify(metadata),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();

	params.chunks.forEach((chunk, index) => {
		memory.db
			.insert(schema.artifactChunks)
			.values({
				id: randomUUID(),
				artifactId: id,
				userId: USER,
				chunkIndex: index,
				contentText: chunk.text,
				tokenEstimate: estimateTokenCount(chunk.text),
				pageStart: chunk.pageStart ?? null,
				pageEnd: chunk.pageEnd ?? null,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	});

	return {
		id,
		type: "normalized_document",
		retrievalClass: "durable",
		name: `${id}.md`,
		mimeType: "text/markdown",
		sizeBytes: null,
		conversationId: null,
		summary: null,
		createdAt: NOW.getTime(),
		updatedAt: NOW.getTime(),
		...(params.pageCount !== undefined ? { pageCount: params.pageCount } : {}),
		userId: USER,
		extension: "md",
		storagePath: null,
		contentText: params.contentText ?? params.chunks[0]?.text ?? "",
		metadata,
	};
}

async function snippetFor(
	artifact: Artifact,
	overrides: { perArtifactLimit?: number; perArtifactCharBudget?: number } = {},
): Promise<string> {
	const snippets = await getPromptArtifactSnippets({
		userId: USER,
		artifacts: [artifact],
		query: QUERY,
		perArtifactLimit: overrides.perArtifactLimit ?? 2,
		perArtifactCharBudget: overrides.perArtifactCharBudget ?? 1400,
	});
	return snippets.get(artifact.id) ?? "";
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	memory.db
		.insert(schema.users)
		.values({
			id: USER,
			email: `${USER}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
});

afterEach(() => {
	memory.close();
});

describe("which documents may be cited", () => {
	const kinds: Array<{ kind: string; prefix: string }> = [
		{ kind: "physical", prefix: "[p. 2]" },
		{ kind: "spine", prefix: "[p. 2]" },
		{ kind: "slide", prefix: "[slide 2]" },
		{ kind: "sheet", prefix: "[sheet 2]" },
	];

	for (const { kind, prefix } of kinds) {
		it(`cites a ${kind} document as ${prefix}`, async () => {
			const artifact = seedDocument({
				pageCountKind: kind,
				pageCount: 4,
				chunks: [{ text: "The ledger reconciles.", pageStart: 2, pageEnd: 2 }],
			});

			const snippet = await snippetFor(artifact);

			expect(snippet).toBe(`${prefix} The ledger reconciles.`);
		});
	}

	const uncitable = ["declared", "logical", "unknown"];
	for (const kind of uncitable) {
		it(`never cites a ${kind} document`, async () => {
			const artifact = seedDocument({
				pageCountKind: kind,
				pageCount: 4,
				chunks: [{ text: "The ledger reconciles.", pageStart: 1, pageEnd: 1 }],
			});

			const snippet = await snippetFor(artifact);

			expect(snippet).toBe("The ledger reconciles.");
			expect(snippet).not.toContain("[");
		});
	}

	it("does not cite a single-page document", async () => {
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 1,
			chunks: [{ text: "The ledger reconciles.", pageStart: 1, pageEnd: 1 }],
		});

		expect(await snippetFor(artifact)).toBe("The ledger reconciles.");
	});

	it("does not cite a document with no page kind at all", async () => {
		// Every pre-Phase-4 row: `metadata` carries no `pageCountKind`.
		const artifact = seedDocument({
			pageCount: 9,
			chunks: [{ text: "The ledger reconciles.", pageStart: 3, pageEnd: 3 }],
		});

		expect(await snippetFor(artifact)).toBe("The ledger reconciles.");
		expect(resolveArtifactPageLabel(artifact)).toBeNull();
	});

	it("does not cite a legacy chunk of a citable document", async () => {
		// A re-extracted document whose old rows were never re-synced: the
		// artifact is citable, this row is not.
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 4,
			chunks: [{ text: "The ledger reconciles.", pageStart: null }],
		});

		expect(await snippetFor(artifact)).toBe("The ledger reconciles.");
	});

	it("cites a span with an en dash", async () => {
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 9,
			chunks: [{ text: "The ledger reconciles.", pageStart: 3, pageEnd: 4 }],
		});

		expect(await snippetFor(artifact)).toBe("[p. 3–4] The ledger reconciles.");
	});

	it("does not cite a document that has no chunks at all", async () => {
		// The common case: the whole 3-page PDF fixture is 1 306 characters,
		// well under the chunking threshold, so it is served from
		// `contentText` by the no-chunks fallback and carries no citation.
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 3,
			chunks: [],
			contentText: "The ledger reconciles.",
		});

		expect(await snippetFor(artifact)).toBe("The ledger reconciles.");
	});
});

describe("formatPageCitation", () => {
	it("returns nothing without a label", () => {
		expect(formatPageCitation({ pageStart: 3, pageEnd: 3 }, null)).toBe("");
	});

	it("returns nothing for an unusable range", () => {
		expect(formatPageCitation({ pageStart: null, pageEnd: 2 }, "p.")).toBe("");
		expect(formatPageCitation({ pageStart: 0, pageEnd: 2 }, "p.")).toBe("");
		expect(formatPageCitation({ pageStart: 1.5, pageEnd: 2 }, "p.")).toBe("");
	});

	it("collapses a range that does not span pages", () => {
		expect(formatPageCitation({ pageStart: 3, pageEnd: 3 }, "p.")).toBe(
			"[p. 3]",
		);
		expect(formatPageCitation({ pageStart: 3, pageEnd: 2 }, "p.")).toBe(
			"[p. 3]",
		);
	});

	it("costs what the real estimator says it costs", () => {
		// Measured, not assumed — this is the per-citation price the §4.7
		// budget argument rests on. (§4.7's table says 4 for "[slide 2]";
		// the estimator says 5, and the estimator is what the budget uses.)
		expect(estimateTokenCount("[p. 3]")).toBe(5);
		expect(estimateTokenCount("[p. 3–4]")).toBe(7);
		expect(estimateTokenCount("[slide 2]")).toBe(5);
		expect(estimateTokenCount("[sheet 1]")).toBe(5);
	});
});

describe("the citation budget", () => {
	const longChunk = (page: number) =>
		`Page ${page}: ${"the quarterly ledger reconciles line by line. ".repeat(40)}`;

	it("never lets a cited snippet exceed the budget", async () => {
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 6,
			chunks: [
				{ text: longChunk(2), pageStart: 2, pageEnd: 2 },
				{ text: longChunk(5), pageStart: 5, pageEnd: 6 },
			],
		});

		for (const budget of [120, 400, 1400]) {
			const snippet = await snippetFor(artifact, {
				perArtifactCharBudget: budget,
			});
			expect(snippet.length).toBeLessThanOrEqual(budget);
		}
	});

	it("displaces body text rather than adding to it", async () => {
		const chunks: SeedChunk[] = [
			{ text: longChunk(2), pageStart: 2, pageEnd: 2 },
			{ text: longChunk(5), pageStart: 5, pageEnd: 6 },
		];
		const cited = seedDocument({
			pageCountKind: "physical",
			pageCount: 6,
			chunks,
		});
		// The same document with a page kind that may not be cited: identical
		// text, identical budget, no prefixes.
		const uncited = seedDocument({
			pageCountKind: "logical",
			pageCount: 6,
			chunks,
		});

		const citedSnippet = await snippetFor(cited, {
			perArtifactCharBudget: 400,
		});
		const uncitedSnippet = await snippetFor(uncited, {
			perArtifactCharBudget: 400,
		});

		expect(citedSnippet).toContain("[p. 2]");
		expect(citedSnippet).toContain("[p. 5–6]");
		expect(citedSnippet.length).toBeLessThanOrEqual(uncitedSnippet.length);
		// Same envelope, less body: what the citations cost came out of the
		// text, not out of the budget.
		const bodyLength = (snippet: string) =>
			snippet.replace(/\[[^\]]+\]\s?/g, "").length;
		expect(bodyLength(citedSnippet)).toBeLessThan(bodyLength(uncitedSnippet));
	});

	it("keeps body text when the budget cannot afford a citation", async () => {
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 6,
			chunks: [{ text: longChunk(2), pageStart: 2, pageEnd: 2 }],
		});

		const snippet = await snippetFor(artifact, { perArtifactCharBudget: 6 });

		expect(snippet).not.toContain("[p.");
		expect(snippet.length).toBeGreaterThan(0);
		expect(snippet.length).toBeLessThanOrEqual(6);
	});

	it("keeps the Retrieved Evidence section inside its token budget", async () => {
		// The section-level property: `serializeWorkingSetArtifacts` truncates
		// each excerpt to a token budget, so prefixes trim body text out of the
		// section rather than pushing the section past its share of the prompt.
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 6,
			chunks: [
				{ text: longChunk(2), pageStart: 2, pageEnd: 2 },
				{ text: longChunk(5), pageStart: 5, pageEnd: 6 },
			],
		});
		const snippets = await getPromptArtifactSnippets({
			userId: USER,
			artifacts: [artifact],
			query: QUERY,
			perArtifactLimit: 2,
			perArtifactCharBudget: 1400,
		});

		const totalBudget = 120;
		const body = serializeWorkingSetArtifacts({
			artifacts: [artifact],
			snippets,
			totalBudget,
			documentBudget: totalBudget,
			outputBudget: totalBudget,
		});

		expect(body).toContain("[p.");
		expect(estimateTokenCount(body)).toBeLessThanOrEqual(totalBudget);
	});
});

describe("selectDocumentPassages", () => {
	it("carries the page range of every passage", async () => {
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 6,
			chunks: [
				{ text: "The ledger reconciles on two.", pageStart: 2, pageEnd: 2 },
				{ text: "The ledger closes on five.", pageStart: 5, pageEnd: 6 },
			],
		});

		const { passages } = await selectDocumentPassages({
			userId: USER,
			artifact,
			query: "ledger",
			limit: 2,
		});

		expect(passages).toHaveLength(2);
		expect(
			passages.map((passage) => [passage.pageStart, passage.pageEnd]),
		).toEqual([
			[2, 2],
			[5, 6],
		]);
	});

	it("leaves the synthesized pseudo-chunk without a page", async () => {
		// A document below the chunking threshold has no rows; the passage is
		// the whole text, which spans every page, so no single page is honest.
		const artifact = seedDocument({
			pageCountKind: "physical",
			pageCount: 3,
			chunks: [],
			contentText: "The ledger reconciles across the whole document.",
		});

		const { passages } = await selectDocumentPassages({
			userId: USER,
			artifact,
			query: "ledger",
		});

		expect(passages).toHaveLength(1);
		expect(passages[0].pageStart).toBeNull();
		expect(passages[0].pageEnd).toBeNull();
	});
});
