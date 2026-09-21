/**
 * Page markers in the full text of a document too small to have chunks.
 *
 * `SMALL_FILE_THRESHOLD_CHARS` is 5 000 and every recorded MinerU fixture
 * renders to less than that, so the common case is a document with ZERO chunk
 * rows — and page citations live only on chunk rows. Lowering the threshold
 * would change retrieval for every document in every account (OQ6: no), so the
 * full text that gets injected for these documents carries the page boundaries
 * itself, in the same `[p. N]` / `[slide N]` / `[sheet N]` vocabulary.
 *
 * Real bundles on disk, like `bundle.test.ts`: the whole point of the feature
 * is that the offsets come from `pages.json` and are trusted only when
 * `manifest.markdownSha256` still matches the text being injected.
 */
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { Artifact } from "$lib/server/services/knowledge/types";
import {
	MINERU_BUNDLE_MARKDOWN,
	mineruBundleDir,
	writeMineruParseBundle,
} from "$lib/server/services/mineru/bundle";
import { parseMineruResultZip } from "$lib/server/services/mineru/result";

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

const { getPromptArtifactSnippets } = await import("./artifacts");

const PDF_ZIP = join(
	process.cwd(),
	"fixtures",
	"mineru-v1",
	"pdf",
	"result.zip",
);
const NOW = new Date("2026-09-20T10:00:00.000Z");
const QUERY = "ledger";

let userId: string;
let sourceArtifactId: string;

async function pdfResult() {
	return (
		await parseMineruResultZip({
			zipPathAbsolute: PDF_ZIP,
			jobTier: "basic",
			serverParserVersion: "4.0.4",
			sourceFilename: "sample.pdf",
		})
	).result;
}

/**
 * The normalized artifact a small structured PDF produces: the full text, the
 * page metadata, a bundle on disk — and NO chunk rows, because the text is
 * under the small-file threshold.
 */
function seedNormalized(params: {
	contentText: string;
	pageCount: number;
	pageCountKind: string;
	sourceArtifactId?: string | null;
}): Artifact {
	const id = randomUUID();
	const metadata: Record<string, unknown> = {
		pageCount: params.pageCount,
		pageCountKind: params.pageCountKind,
		...(params.sourceArtifactId === null
			? {}
			: { sourceArtifactId: params.sourceArtifactId ?? sourceArtifactId }),
	};
	memory.db
		.insert(schema.artifacts)
		.values({
			id,
			userId,
			type: "normalized_document",
			name: `${id}.md`,
			contentText: params.contentText,
			metadataJson: JSON.stringify(metadata),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();

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
		pageCount: params.pageCount,
		userId,
		extension: "md",
		storagePath: null,
		contentText: params.contentText,
		metadata,
	};
}

async function snippetFor(
	artifact: Artifact,
	perArtifactCharBudget = 100_000,
): Promise<string> {
	const snippets = await getPromptArtifactSnippets({
		userId,
		artifacts: [artifact],
		query: QUERY,
		perArtifactCharBudget,
	});
	return snippets.get(artifact.id) ?? "";
}

beforeEach(() => {
	userId = `snippet-user-${randomUUID()}`;
	sourceArtifactId = randomUUID();
	memory = createInMemoryDatabase();
	memory.db
		.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
});

afterEach(async () => {
	memory.close();
	await rm(join(process.cwd(), "data", "knowledge", userId), {
		recursive: true,
		force: true,
	}).catch(() => undefined);
});

describe("page markers on a document with no chunks", () => {
	it("marks the page boundaries of the injected full text", async () => {
		const result = await pdfResult();
		await writeMineruParseBundle({
			userId,
			sourceArtifactId,
			zipPathAbsolute: PDF_ZIP,
			result,
			maxBytes: 33_554_432,
		});
		// The whole point: the recorded three-page PDF is well under the
		// small-file threshold, so it has no chunk rows to cite from.
		expect(result.markdown.length).toBeLessThan(5_000);
		expect(result.pageCount).toBe(3);

		const artifact = seedNormalized({
			contentText: result.markdown,
			pageCount: result.pageCount,
			pageCountKind: result.pageCountKind,
		});

		const snippet = await snippetFor(artifact);

		expect(snippet).toContain("[p. 1]");
		expect(snippet).toContain("[p. 2]");
		expect(snippet).toContain("[p. 3]");
		// Markers, not a rewrite: every word of the document is still there.
		for (const word of result.markdown.split(/\s+/).filter(Boolean)) {
			expect(snippet).toContain(word);
		}
	});

	it("pays for the markers out of the artifact's own budget", async () => {
		// A retrieval feature that quietly grows every turn's context is a
		// regression whatever it cites, so the markers must DISPLACE body text.
		const result = await pdfResult();
		await writeMineruParseBundle({
			userId,
			sourceArtifactId,
			zipPathAbsolute: PDF_ZIP,
			result,
			maxBytes: 33_554_432,
		});
		const marked = seedNormalized({
			contentText: result.markdown,
			pageCount: result.pageCount,
			pageCountKind: result.pageCountKind,
		});
		// Same text, same budget, no bundle to read: the unmarked control.
		const plain = seedNormalized({
			contentText: result.markdown,
			pageCount: result.pageCount,
			pageCountKind: result.pageCountKind,
			sourceArtifactId: null,
		});

		const budget = 600;
		const withMarkers = await snippetFor(marked, budget);
		const withoutMarkers = await snippetFor(plain, budget);

		expect(withMarkers).toContain("[p. 1]");
		expect(withoutMarkers).not.toContain("[p. 1]");
		expect(withMarkers.length).toBeLessThanOrEqual(budget);
		// Neither snippet is longer than the other: the markers took their room
		// from the body, which is now shorter by exactly what they cost.
		expect(withMarkers.length).toBe(withoutMarkers.length);
		expect(withMarkers.replace(/\[p\. \d+] /g, "").length).toBeLessThan(
			withoutMarkers.length,
		);
	});

	it("injects plain text when the bundle is stale", async () => {
		// The bundle is written by the EXTRACTOR, before `persist.ts` rewrites
		// the artifact's text. An attempt that parses and then dies leaves a
		// bundle one parse ahead of the document, and every offset in it then
		// lands somewhere else. `markdownSha256` is what catches that.
		const result = await pdfResult();
		await writeMineruParseBundle({
			userId,
			sourceArtifactId,
			zipPathAbsolute: PDF_ZIP,
			result,
			maxBytes: 33_554_432,
		});
		await writeFile(
			join(mineruBundleDir(userId, sourceArtifactId), MINERU_BUNDLE_MARKDOWN),
			"A different parse of the same document.",
		);

		const artifact = seedNormalized({
			contentText: "A different parse of the same document.",
			pageCount: 3,
			pageCountKind: "physical",
		});

		const snippet = await snippetFor(artifact);

		expect(snippet).not.toContain("[p.");
		expect(snippet).toContain("A different parse of the same document.");
	});

	it("injects plain text when there is no bundle at all", async () => {
		const artifact = seedNormalized({
			contentText: "A direct-text upload has no bundle.",
			pageCount: 4,
			pageCountKind: "physical",
		});

		expect(await snippetFor(artifact)).toBe(
			"A direct-text upload has no bundle.",
		);
	});

	it("does not mark a document whose page kind is not citable", async () => {
		const result = await pdfResult();
		await writeMineruParseBundle({
			userId,
			sourceArtifactId,
			zipPathAbsolute: PDF_ZIP,
			result,
			maxBytes: 33_554_432,
		});
		// `logical` is what CSV and HTML report; "p. 1" there is an invention.
		const artifact = seedNormalized({
			contentText: result.markdown,
			pageCount: result.pageCount,
			pageCountKind: "logical",
		});

		expect(await snippetFor(artifact)).not.toContain("[p.");
	});

	it("does not mark a single-page document", async () => {
		const result = await pdfResult();
		await writeMineruParseBundle({
			userId,
			sourceArtifactId,
			zipPathAbsolute: PDF_ZIP,
			result,
			maxBytes: 33_554_432,
		});
		const artifact = seedNormalized({
			contentText: result.markdown,
			pageCount: 1,
			pageCountKind: "physical",
		});

		expect(await snippetFor(artifact)).not.toContain("[p.");
	});
});
