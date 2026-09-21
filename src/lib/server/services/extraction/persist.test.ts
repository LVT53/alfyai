// The `indexing` phase, against a real database and real parsed fixtures.
//
// Everything here runs on a migrated SQLite file and on
// `fixtures/mineru-v1/*/result.zip` read through `parseMineruResultZip`,
// because the facts worth asserting are facts about rows and files: that a
// re-extraction keeps the normalized artifact's id, that it leaves exactly one
// `derived_from` link, that the previous parse's metadata keys do not survive
// it, and that a bundle failure costs the figures but never the text.
//
// The one mock is `resolveMineruConfig`, so a case can shrink the bundle
// budget below the fixture's own images — the real config floor is 1 MiB and
// the PDF's figures are kilobytes.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MINERU_BUNDLE_MANIFEST,
	mineruBundleDir,
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

const { bundleMaxBytes } = vi.hoisted(() => ({
	bundleMaxBytes: { value: 33_554_432 },
}));

vi.mock("$lib/server/services/mineru/config", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/mineru/config")>();
	return {
		...actual,
		resolveMineruConfig: () => ({
			...actual.resolveMineruConfig(),
			bundleMaxBytes: bundleMaxBytes.value,
		}),
	};
});

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
let tempDir: string;

beforeEach(async () => {
	bundleMaxBytes.value = 33_554_432;
	userId = `persist-user-${randomUUID()}`;
	fixture = createLedgerFixture("persist");
	fixture.seedUser(userId);
	sourceArtifactId = fixture.seedArtifact({ userId, name: "sample.pdf" });
	tempDir = await mkdtemp(join(tmpdir(), "alfyai-persist-"));

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	persist = await import("./persist");
});

afterEach(async () => {
	fixture.cleanup();
	await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
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

async function persistFixture(options: {
	name?: string;
	extension?: string;
	zip?: string | null;
	result?: StructuredExtractionResult;
	text?: string;
}) {
	const result = options.result ?? (await parsedFixture(options.name ?? "pdf"));
	const zip =
		options.zip === null ? null : (options.zip ?? fixtureZip(options.name ?? "pdf"));
	return persist.createNormalizedArtifactFromExtraction({
		userId,
		conversationId: null,
		sourceArtifactId,
		sourceName: `sample.${options.extension ?? options.name ?? "pdf"}`,
		text: options.text ?? result.markdown,
		normalizedName: "sample.md",
		mimeType: "text/markdown",
		structured: zip ? { result, zipPathAbsolute: zip } : result,
	});
}

describe("createNormalizedArtifactFromExtraction — structured results", () => {
	it("writes the parse bundle, the artifact and the metadata on both rows", async () => {
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
			expect(metadata.extractionBundleError).toBeUndefined();
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
				metadata: { producer: { name: "mineru", version: "4.0.4" }, document: {} },
				extensions: { mineru: { tier: "flash", parse_mode: "txt" } },
			} as never,
			jobTier: "basic",
			sourceFilename: "notes.docx",
		});

		const artifact = await persistFixture({ result, zip: null, name: "docx" });
		const outline = metadataOf(artifact.id).outline as Array<
			Record<string, unknown>
		>;
		expect(outline.map((entry) => entry.title)).toEqual([
			"ECHO Introduction",
			"FOXTROT Detail",
		]);
	});

	it("omits the bundle keys and stores no outline when the parse has neither", async () => {
		const result = await parsedFixture("csv");
		const artifact = await persistFixture({ result, zip: null, name: "csv" });

		const metadata = metadataOf(artifact.id);
		expect(metadata.outline).toBeUndefined();
		expect(metadata.extractionBundleBytes).toBeUndefined();
		expect(metadata.extractionFigureCount).toBe(0);
		expect(metadata.pageCountKind).toBe("logical");
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

describe("createNormalizedArtifactFromExtraction — bundle failures", () => {
	it("drops images that do not fit the budget and records it", async () => {
		// Below the PDF figure's own size, so the image is skipped while the
		// JSON and the Markdown are still written.
		bundleMaxBytes.value = 24_000;
		const artifact = await persistFixture({ name: "pdf" });

		const bundleDir = mineruBundleDir(userId, sourceArtifactId);
		expect(await readdir(join(bundleDir, "images"))).toEqual([]);
		expect(metadataOf(artifact.id).extractionImagesOmitted).toBe(true);
		expect(metadataOf(sourceArtifactId).extractionImagesOmitted).toBe(true);
		// The text survived the budget intact.
		expect(artifact.contentText).toContain("ALFA Quarterly Overview");
	});

	it("keeps the text and records the failure when the bundle cannot be written", async () => {
		const corruptZip = join(tempDir, "result.zip");
		await writeFile(corruptZip, "this is not a zip file", "utf8");
		const result = await parsedFixture("pdf");

		const artifact = await persistFixture({ result, zip: corruptZip });

		expect(artifact.contentText).toBe(result.markdown);
		expect(existsSync(mineruBundleDir(userId, sourceArtifactId))).toBe(false);
		for (const id of [artifact.id, sourceArtifactId]) {
			const metadata = metadataOf(id);
			expect(typeof metadata.extractionBundleError).toBe("string");
			expect(metadata.extractionBundleBytes).toBeUndefined();
			// The parse itself still happened, so its provenance is still true.
			expect(metadata.extractionProducer).toBe("mineru");
			expect(metadata.pageCount).toBe(3);
		}
	});

	it("uses a bundle the extractor wrote itself when no zip is handed over", async () => {
		const { writeMineruParseBundle } = await import(
			"$lib/server/services/mineru/bundle"
		);
		const result = await parsedFixture("pdf");
		const manifest = await writeMineruParseBundle({
			userId,
			sourceArtifactId,
			zipPathAbsolute: fixtureZip("pdf"),
			result,
			maxBytes: 33_554_432,
		});

		// The bare `StructuredExtractionResult` — the contract's own shape.
		const artifact = await persistFixture({ result, zip: null });

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
		fixture.sqlite.prepare("DELETE FROM artifacts WHERE id = ?").run(
			sourceArtifactId,
		);

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
