// The `indexing` phase, against a real database and real parsed fixtures.
//
// Everything here runs on a migrated SQLite file and on
// `fixtures/mineru-v1/*/result.zip` read through `parseMineruResultZip`,
// because the facts worth asserting are facts about rows and files: that a
// re-extraction keeps the normalized artifact's id, that it leaves exactly one
// `derived_from` link, that the previous parse's metadata keys do not survive
// it, and that a document whose bundle never made it to disk still becomes a
// readable artifact.
//
// The extractor writes the bundle (it holds the zip, in a temp directory that
// is gone by the time persist runs), so these cases write it the same way and
// hand persist the manifest, exactly as `structured.bundle` carries it.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MINERU_BUNDLE_MANIFEST,
	type MineruParseBundleManifest,
	mineruBundleDir,
	writeMineruParseBundle,
} from "$lib/server/services/mineru/bundle";
import {
	buildStructuredExtractionResult,
	parseMineruResultZip,
	type StructuredExtractionResult,
} from "$lib/server/services/mineru/result";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

type Persist = typeof import("./persist");

function fixtureZip(name: string): string {
	return join(process.cwd(), "fixtures", "mineru-v1", name, "result.zip");
}

async function parsedFixture(
	name: string,
	extension = name,
): Promise<StructuredExtractionResult> {
	const parsed = await parseMineruResultZip({
		zipPathAbsolute: fixtureZip(name),
		jobTier: "basic",
		serverParserVersion: "4.0.4",
		sourceFilename: `sample.${extension}`,
	});
	return parsed.result;
}

let fixture: LedgerFixture;
let persist: Persist;
let userId: string;
let sourceArtifactId: string;

/** What the extractor does before it returns: write the bundle, keep the id. */
async function writeBundle(
	result: StructuredExtractionResult,
	options: { name?: string; maxBytes?: number } = {},
): Promise<MineruParseBundleManifest> {
	return writeMineruParseBundle({
		userId,
		sourceArtifactId,
		zipPathAbsolute: fixtureZip(options.name ?? "pdf"),
		result,
		maxBytes: options.maxBytes ?? 33_554_432,
	});
}

beforeEach(async () => {
	userId = `persist-user-${randomUUID()}`;
	fixture = createLedgerFixture("persist");
	fixture.seedUser(userId);
	sourceArtifactId = fixture.seedArtifact({ userId, name: "sample.pdf" });

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	persist = await import("./persist");
});

afterEach(async () => {
	fixture.cleanup();
	await rm(join(process.cwd(), "data", "knowledge", userId), {
		recursive: true,
		force: true,
	}).catch(() => undefined);
});

/** Reads a row's metadata straight off the fixture database. */
function metadataOf(artifactId: string): Record<string, unknown> {
	const row = fixture.sqlite
		.prepare("SELECT metadata_json FROM artifacts WHERE id = ?")
		.get(artifactId) as { metadata_json: string | null } | undefined;
	return row?.metadata_json
		? (JSON.parse(row.metadata_json) as Record<string, unknown>)
		: {};
}

function linkCount(normalizedArtifactId: string): number {
	const row = fixture.sqlite
		.prepare(
			"SELECT count(*) AS count FROM artifact_links WHERE artifact_id = ? AND link_type = 'derived_from'",
		)
		.get(normalizedArtifactId) as { count: number };
	return row.count;
}

/**
 * One extraction, shaped exactly as the worker hands it over: the parsed
 * result spread flat, plus the bundle manifest the extractor wrote (or null).
 */
async function persistFixture(options: {
	name?: string;
	extension?: string;
	result?: StructuredExtractionResult;
	/** Omit to write the bundle first; pass null for "the extractor had none". */
	bundle?: MineruParseBundleManifest | null;
	maxBytes?: number;
	text?: string;
}) {
	const name = options.name ?? "pdf";
	const result = options.result ?? (await parsedFixture(name));
	const bundle =
		options.bundle === undefined
			? await writeBundle(result, { name, maxBytes: options.maxBytes })
			: options.bundle;
	return persist.createNormalizedArtifactFromExtraction({
		userId,
		conversationId: null,
		sourceArtifactId,
		sourceName: `sample.${options.extension ?? name}`,
		text: options.text ?? result.markdown,
		normalizedName: "sample.md",
		mimeType: "text/markdown",
		structured: { ...result, bundle },
	});
}

describe("createNormalizedArtifactFromExtraction — structured results", () => {
	it("stamps the bundle with the artifact id and the metadata on both rows", async () => {
		const result = await parsedFixture("pdf");
		const artifact = await persistFixture({ name: "pdf" });

		expect(artifact.contentText).toBe(result.markdown);
		expect(linkCount(artifact.id)).toBe(1);

		const bundleDir = mineruBundleDir(userId, sourceArtifactId);
		expect(existsSync(bundleDir)).toBe(true);
		const manifest = JSON.parse(
			await readFile(join(bundleDir, MINERU_BUNDLE_MANIFEST), "utf8"),
		) as Record<string, unknown>;
		// The id is only knowable after the row exists, so persist patches it in.
		expect(manifest.normalizedArtifactId).toBe(artifact.id);

		for (const id of [artifact.id, sourceArtifactId]) {
			const metadata = metadataOf(id);
			expect(metadata.pageCount).toBe(3);
			expect(metadata.pageCountKind).toBe("physical");
			expect(metadata.extractionProducer).toBe("mineru");
			expect(metadata.extractionProducerVersion).toBe("4.0.4");
			expect(metadata.extractionServerParserVersion).toBe("4.0.4");
			expect(metadata.extractionParserVersion).toBe(result.parserVersion);
			expect(metadata.extractionTier).toBe("basic");
			expect(metadata.extractionJobTier).toBe("basic");
			expect(metadata.extractionParseMode).toBe("txt");
			expect(metadata.extractionFigureCount).toBe(1);
			expect(metadata.extractionImagesOmitted).toBe(false);
			expect(metadata.extractionBundleBytes).toBe(manifest.totalBytes);
			expect(metadata.extractionBundleMissing).toBeUndefined();
			// Every fixture block type is known, so the GPU-box signal stays off
			// the row rather than being stored as an empty object.
			expect(metadata.extractionUnknownBlockTypes).toBeUndefined();
			expect(metadata.tokenEstimate).toBeGreaterThan(0);
		}
	});

	it("stores an outline whose entries carry the page they sit on", async () => {
		const artifact = await persistFixture({ name: "pdf" });
		const outline = metadataOf(artifact.id).outline as Array<
			Record<string, unknown>
		>;

		expect(outline.map((entry) => entry.title)).toEqual([
			"ALFA Quarterly Overview",
			"BRAVO Methodology",
			"CHARLIE Results",
			"DELTA Limitations",
		]);
		expect(outline.map((entry) => entry.page)).toEqual([1, 1, 2, 3]);
		// The offset still points at the heading's own `#` in contentText, which
		// is what the workspace's section lookup reads.
		const offset = outline[1].offset as number;
		expect(artifact.contentText?.slice(offset, offset + 21)).toBe(
			"## BRAVO Methodology\n",
		);
	});

	it("keeps DOCX headings, with the bold wrapper stripped and the level shifted", async () => {
		const artifact = await persistFixture({ name: "docx" });
		const outline = metadataOf(artifact.id).outline as Array<
			Record<string, unknown>
		>;

		expect(outline[0]).toMatchObject({
			level: 1,
			title: "ALFA Quarterly Overview",
			page: 1,
		});
		expect(outline.map((entry) => entry.title)).not.toContain(
			"**ALFA Quarterly Overview**",
		);
		// The effective tier is the one the FILE was parsed at — `flash` for an
		// Office document inside a `basic` job — not the job's.
		expect(metadataOf(artifact.id).extractionTier).toBe("flash");
		expect(metadataOf(artifact.id).extractionJobTier).toBe("basic");
		expect(metadataOf(artifact.id).pageCountKind).toBe("declared");
	});

	it("falls back to the heuristic outline when no block is a heading", async () => {
		// The shape the spec's fallback rule exists for: a producer that types
		// its headings as body text rather than as `paragraph_title` blocks.
		const result = buildStructuredExtractionResult({
			content: {
				pages: [
					{
						page_idx: 0,
						blocks: [
							{ type: "text", content: "# ECHO Introduction" },
							{ type: "text", content: "Body text under the first heading." },
							{ type: "text", content: "## FOXTROT Detail" },
							{ type: "text", content: "Body text under the second heading." },
						],
					},
				],
				metadata: {
					producer: { name: "mineru", version: "4.0.4" },
					document: {},
				},
				extensions: { mineru: { tier: "flash", parse_mode: "txt" } },
			} as never,
			jobTier: "basic",
			sourceFilename: "notes.docx",
		});

		const artifact = await persistFixture({
			result,
			bundle: null,
			name: "docx",
		});
		const outline = metadataOf(artifact.id).outline as Array<
			Record<string, unknown>
		>;
		expect(outline.map((entry) => entry.title)).toEqual([
			"ECHO Introduction",
			"FOXTROT Detail",
		]);
	});

	it("stores no outline when the parse has no headings at all", async () => {
		const result = await parsedFixture("csv");
		const artifact = await persistFixture({ result, name: "csv" });

		const metadata = metadataOf(artifact.id);
		expect(metadata.outline).toBeUndefined();
		expect(metadata.extractionFigureCount).toBe(0);
		expect(metadata.pageCountKind).toBe("logical");
	});
});

describe("createNormalizedArtifactFromExtraction — chunk plan", () => {
	/**
	 * A document long enough to survive the small-file bypass, with one block
	 * per page, so every chunk row can be traced back to a page.
	 */
	function longStructuredResult(pages: number): StructuredExtractionResult {
		return buildStructuredExtractionResult({
			content: {
				pages: Array.from({ length: pages }, (_, index) => ({
					page_idx: index,
					blocks: [
						{
							type: "paragraph_title",
							level: 2,
							content: `Section ${index + 1}`,
						},
						{
							type: "text",
							content: `Body of section ${index + 1}. ${"lorem ipsum ".repeat(120)}`,
						},
					],
				})),
				metadata: {
					producer: { name: "mineru", version: "4.0.4" },
					document: { page_count: pages, page_count_kind: "physical" },
				},
				extensions: { mineru: { tier: "basic", parse_mode: "txt" } },
			} as never,
			jobTier: "basic",
			sourceFilename: "long.pdf",
		});
	}

	function chunkRows(artifactId: string) {
		return fixture.sqlite
			.prepare(
				"SELECT chunk_index, page_start, page_end FROM artifact_chunks WHERE artifact_id = ? ORDER BY chunk_index",
			)
			.all(artifactId) as Array<{
			chunk_index: number;
			page_start: number | null;
			page_end: number | null;
		}>;
	}

	it("gives every chunk row the page its blocks came from", async () => {
		const result = longStructuredResult(6);
		expect(result.markdown.length).toBeGreaterThan(5000);

		const artifact = await persistFixture({ result, bundle: null });
		const rows = chunkRows(artifact.id);

		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) {
			expect(row.page_start).not.toBeNull();
			expect(row.page_end).not.toBeNull();
			expect(row.page_start).toBeGreaterThanOrEqual(1);
			expect(row.page_end).toBeGreaterThanOrEqual(row.page_start as number);
			expect(row.page_end).toBeLessThanOrEqual(6);
		}
		// The pages advance with the document rather than all claiming page 1.
		expect(rows[rows.length - 1].page_end).toBeGreaterThan(
			rows[0].page_start as number,
		);
	});

	it("re-derives the pages on a re-extraction rather than keeping the old ones", async () => {
		const first = await persistFixture({
			result: longStructuredResult(6),
			bundle: null,
		});
		expect(chunkRows(first.id).length).toBeGreaterThan(1);

		// The same document read again, shorter: the rows are rebuilt, not
		// merged with the previous parse's.
		const second = await persistFixture({
			result: longStructuredResult(4),
			bundle: null,
		});
		expect(second.id).toBe(first.id);
		const rows = chunkRows(second.id);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.page_end).toBeLessThanOrEqual(4);
		}
	});

	it("leaves the pages null for a document with no structure", async () => {
		const artifact = await persist.createNormalizedArtifactFromExtraction({
			userId,
			conversationId: null,
			sourceArtifactId,
			sourceName: "notes.txt",
			text: `# Notes\n\n${"lorem ipsum ".repeat(900)}`,
			normalizedName: "notes.md",
			mimeType: "text/markdown",
		});

		const rows = chunkRows(artifact.id);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.page_start).toBeNull();
			expect(row.page_end).toBeNull();
		}
	});
});

describe("createNormalizedArtifactFromExtraction — re-extraction", () => {
	it("rewrites the same artifact, replaces the bundle and drops stale keys", async () => {
		const first = await persistFixture({ name: "pdf" });
		const bundleDir = mineruBundleDir(userId, sourceArtifactId);
		const firstImages = await readdir(join(bundleDir, "images"));
		expect(firstImages.length).toBeGreaterThan(0);
		expect(metadataOf(first.id).extractionUnknownBlockTypes).toBeUndefined();

		// A previous parse that DID see an unknown block type, so the stale-key
		// removal has something to remove.
		fixture.sqlite
			.prepare(
				"UPDATE artifacts SET metadata_json = json_set(metadata_json, '$.extractionUnknownBlockTypes', json('{\"chart\":2}')) WHERE id IN (?, ?)",
			)
			.run(first.id, sourceArtifactId);
		expect(metadataOf(sourceArtifactId).extractionUnknownBlockTypes).toEqual({
			chart: 2,
		});

		const second = await persistFixture({ name: "csv", extension: "csv" });

		expect(second.id).toBe(first.id);
		expect(linkCount(first.id)).toBe(1);
		// The CSV parse has no figures, so the previous bundle's images are gone
		// rather than merged with the new one.
		expect(await readdir(join(bundleDir, "images"))).toEqual([]);
		for (const id of [first.id, sourceArtifactId]) {
			const metadata = metadataOf(id);
			expect(metadata.extractionUnknownBlockTypes).toBeUndefined();
			expect(metadata.pageCount).toBe(1);
			expect(metadata.pageCountKind).toBe("logical");
			expect(metadata.outline).toBeUndefined();
			expect(metadata.extractionTier).toBe("flash");
		}
	});
});

describe("createNormalizedArtifactFromExtraction — bundle edges", () => {
	it("records the budget verdict the extractor reached", async () => {
		// A budget below the PDF figure's own size: the JSON and the Markdown
		// are still written, the image is not, and the row says so.
		const artifact = await persistFixture({ name: "pdf", maxBytes: 24_000 });

		const bundleDir = mineruBundleDir(userId, sourceArtifactId);
		expect(await readdir(join(bundleDir, "images"))).toEqual([]);
		expect(metadataOf(artifact.id).extractionImagesOmitted).toBe(true);
		expect(metadataOf(sourceArtifactId).extractionImagesOmitted).toBe(true);
		// The text survived the budget intact.
		expect(artifact.contentText).toContain("ALFA Quarterly Overview");
	});

	it("keeps the text and says so when there is no bundle at all", async () => {
		// What the extractor reports when it could not write one — a failed
		// bundle write, or a request with no artifact to write under.
		const result = await parsedFixture("pdf");
		const artifact = await persistFixture({ result, bundle: null });

		expect(artifact.contentText).toBe(result.markdown);
		expect(existsSync(mineruBundleDir(userId, sourceArtifactId))).toBe(false);
		for (const id of [artifact.id, sourceArtifactId]) {
			const metadata = metadataOf(id);
			expect(metadata.extractionBundleMissing).toBe(true);
			expect(metadata.extractionBundleBytes).toBeUndefined();
			// The parse itself still happened, so its provenance is still true.
			expect(metadata.extractionProducer).toBe("mineru");
			expect(metadata.pageCount).toBe(3);
			expect(metadata.extractionFigureCount).toBe(1);
		}
	});

	it("patches the normalized artifact id into the bundle the extractor wrote", async () => {
		const result = await parsedFixture("pdf");
		const manifest = await writeBundle(result);
		// The extractor cannot know the id: the artifact does not exist yet.
		expect(manifest.normalizedArtifactId).toBeNull();

		const artifact = await persistFixture({ result, bundle: manifest });

		expect(metadataOf(artifact.id).extractionBundleBytes).toBe(
			manifest.totalBytes,
		);
		const patched = JSON.parse(
			await readFile(
				join(mineruBundleDir(userId, sourceArtifactId), MINERU_BUNDLE_MANIFEST),
				"utf8",
			),
		) as Record<string, unknown>;
		expect(patched.normalizedArtifactId).toBe(artifact.id);
	});
});

describe("createNormalizedArtifactFromExtraction — hostile inputs", () => {
	it("persists text only when `structured` is not a parse result", async () => {
		const artifact = await persist.createNormalizedArtifactFromExtraction({
			userId,
			conversationId: null,
			sourceArtifactId,
			sourceName: "notes.txt",
			text: "# Plain\n\nJust some direct text with a heading.",
			normalizedName: "notes.md",
			mimeType: "text/markdown",
			pageCount: 12,
			structured: { parserVersion: "mineru4/1" },
		});

		const metadata = metadataOf(artifact.id);
		// The direct-text contract: the caller's pageCount, the heuristic
		// outline, and none of the structured keys.
		expect(metadata.pageCount).toBe(12);
		expect(metadata.extractionProducer).toBeUndefined();
		expect(metadata.pageCountKind).toBeUndefined();
		expect(
			(metadata.outline as Array<Record<string, unknown>>)[0],
		).toMatchObject({ title: "Plain" });
		expect(existsSync(mineruBundleDir(userId, sourceArtifactId))).toBe(false);
	});

	it("survives the source artifact disappearing mid-persist", async () => {
		const result = await parsedFixture("pdf");
		fixture.sqlite
			.prepare("DELETE FROM artifacts WHERE id = ?")
			.run(sourceArtifactId);

		// The normalized artifact cannot be linked to a row that is gone, so the
		// attempt fails rather than half-succeeding — the ledger requeues it and
		// the bundle on disk is replaced by the next attempt.
		await expect(persistFixture({ result })).rejects.toThrow();

		const rows = fixture.sqlite
			.prepare("SELECT count(*) AS count FROM artifacts WHERE user_id = ?")
			.get(userId) as { count: number };
		expect(rows.count).toBe(0);
	});
});
