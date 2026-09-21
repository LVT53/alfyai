// The on-disk parse bundle.
//
// Every case runs against a real `fixtures/mineru-v1/pdf/result.zip` and a
// real directory under `data/knowledge/`, because the properties worth
// asserting — atomic rename, nothing left behind after a failure, a symlink
// that does not escape — are properties of the filesystem, not of a mock.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MINERU_BUNDLE_DIR_SUFFIX,
	MINERU_BUNDLE_MANIFEST,
	MINERU_BUNDLE_MARKDOWN,
	MINERU_BUNDLE_PAGES,
	MINERU_BUNDLE_STRUCTURED_CONTENT,
	MINERU_BUNDLE_TMP_INFIX,
	mineruBundleDir,
	mineruFigureContentType,
	readMineruFigure,
	readMineruNormalizedMarkdown,
	readMineruPageIndex,
	readMineruParseManifest,
	removeMineruParseBundle,
	setMineruParseBundleNormalizedArtifactId,
	writeMineruParseBundle,
} from "./bundle";
import {
	parseMineruResultZip,
	type StructuredExtractionResult,
} from "./result";

const PDF_ZIP = join(
	process.cwd(),
	"fixtures",
	"mineru-v1",
	"pdf",
	"result.zip",
);
const DOCX_ZIP = join(
	process.cwd(),
	"fixtures",
	"mineru-v1",
	"docx",
	"result.zip",
);
/** The default: 32 MiB, `MINERU_BUNDLE_MAX_BYTES`. */
const MAX_BYTES = 33_554_432;

let userId: string;
let sourceArtifactId: string;

async function pdfResult(): Promise<StructuredExtractionResult> {
	return (
		await parseMineruResultZip({
			zipPathAbsolute: PDF_ZIP,
			jobTier: "basic",
			serverParserVersion: "4.0.4",
			sourceFilename: "sample.pdf",
		})
	).result;
}

async function writePdfBundle(
	overrides?: Partial<Parameters<typeof writeMineruParseBundle>[0]>,
) {
	return writeMineruParseBundle({
		userId,
		sourceArtifactId,
		zipPathAbsolute: PDF_ZIP,
		result: await pdfResult(),
		maxBytes: MAX_BYTES,
		...overrides,
	});
}

beforeEach(() => {
	userId = `bundle-user-${randomUUID()}`;
	sourceArtifactId = randomUUID();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(join(process.cwd(), "data", "knowledge", userId), {
		recursive: true,
		force: true,
	}).catch(() => undefined);
});

describe("mineruBundleDir", () => {
	it("sits beside the source artifact's own bytes", () => {
		expect(mineruBundleDir("user-1", "artifact-1")).toBe(
			join(process.cwd(), "data", "knowledge", "user-1", "artifact-1.parse"),
		);
	});

	it("refuses a path segment that is not a plain identifier", () => {
		expect(() => mineruBundleDir("../etc", "artifact-1")).toThrow(/Unsafe/);
		expect(() => mineruBundleDir("user-1", "..")).toThrow(/Unsafe/);
		expect(() => mineruBundleDir("user-1", "a/b")).toThrow(/Unsafe/);
	});
});

describe("writeMineruParseBundle", () => {
	it("writes the documented layout and manifest", async () => {
		const manifest = await writePdfBundle();
		const dir = mineruBundleDir(userId, sourceArtifactId);

		expect((await readdir(dir)).sort()).toEqual(
			[
				MINERU_BUNDLE_MANIFEST,
				MINERU_BUNDLE_MARKDOWN,
				"images",
				MINERU_BUNDLE_PAGES,
				MINERU_BUNDLE_STRUCTURED_CONTENT,
			].sort(),
		);

		expect(manifest.version).toBe(1);
		expect(manifest.sourceArtifactId).toBe(sourceArtifactId);
		expect(manifest.normalizedArtifactId).toBeNull();
		expect(manifest.effectiveTier).toBe("basic");
		expect(manifest.jobTier).toBe("basic");
		expect(manifest.parseMode).toBe("txt");
		expect(manifest.pageCount).toBe(3);
		expect(manifest.pageCountKind).toBe("physical");
		expect(manifest.imagesOmitted).toBe(false);
		expect(manifest.figures).toHaveLength(1);
		expect(manifest.markdownSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(manifest.totalBytes).toBeGreaterThan(manifest.markdownBytes);
	});

	it("stores the zip copy of structured_content, not a data-URI copy", async () => {
		await writePdfBundle();
		const dir = mineruBundleDir(userId, sourceArtifactId);
		const stored = await readFile(
			join(dir, MINERU_BUNDLE_STRUCTURED_CONTENT),
			"utf8",
		);

		expect(stored).toContain('"images/page_2_image_body_3.jpg"');
		expect(stored).not.toContain("data:image/");
	});

	it("keeps normalized.md byte-identical to the rendered markdown", async () => {
		const result = await pdfResult();
		await writePdfBundle({ result });

		expect(await readMineruNormalizedMarkdown(userId, sourceArtifactId)).toBe(
			result.markdown,
		);
	});

	it("does not keep middle_json, model_output or the zip itself", async () => {
		await writePdfBundle();
		const entries = await readdir(mineruBundleDir(userId, sourceArtifactId));

		expect(entries).not.toContain("middle_json.json");
		expect(entries).not.toContain("model_output.json");
		expect(entries).not.toContain("result.zip");
	});

	it("writes only the images a figure references", async () => {
		await writePdfBundle();
		const images = await readdir(
			join(mineruBundleDir(userId, sourceArtifactId), "images"),
		);

		// The zip also carries `page_1_table_body_3.jpg`, a snapshot of the
		// table whose text is already in the Markdown. It is not a figure.
		expect(images).toEqual(["page_2_image_body_3.jpg"]);
	});

	it("replaces an existing bundle atomically", async () => {
		await writePdfBundle();
		await writeFile(
			join(mineruBundleDir(userId, sourceArtifactId), "stale.txt"),
			"left over from the previous parse",
		);

		await writeMineruParseBundle({
			userId,
			sourceArtifactId,
			zipPathAbsolute: DOCX_ZIP,
			result: (
				await parseMineruResultZip({
					zipPathAbsolute: DOCX_ZIP,
					sourceFilename: "sample.docx",
				})
			).result,
			maxBytes: MAX_BYTES,
		});

		const entries = await readdir(mineruBundleDir(userId, sourceArtifactId));
		expect(entries).not.toContain("stale.txt");
		const manifest = await readMineruParseManifest(userId, sourceArtifactId);
		expect(manifest?.effectiveTier).toBe("flash");
		expect(manifest?.pageCountKind).toBe("declared");
	});

	it("leaves no temp directory behind when the swap fails mid-write", async () => {
		// A genuine mid-write failure: everything is written into the temp
		// directory, and the `rm -rf` of the previous bundle then fails because
		// its directory is not writable. The catch must remove the temp
		// directory and rethrow.
		await writePdfBundle();
		const userDir = join(process.cwd(), "data", "knowledge", userId);
		const bundleDir = mineruBundleDir(userId, sourceArtifactId);
		await chmod(bundleDir, 0o500);

		try {
			await expect(writePdfBundle()).rejects.toThrow();
		} finally {
			await chmod(bundleDir, 0o700);
		}

		const leftovers = (await readdir(userDir)).filter((entry) =>
			entry.includes(MINERU_BUNDLE_TMP_INFIX),
		);
		expect(leftovers).toEqual([]);
		// …and the previous bundle is still intact.
		expect(existsSync(join(bundleDir, MINERU_BUNDLE_MANIFEST))).toBe(true);
	});

	it("leaves no temp directory behind after a successful write", async () => {
		await writePdfBundle();
		const entries = await readdir(
			join(process.cwd(), "data", "knowledge", userId),
		);

		expect(entries).toEqual([`${sourceArtifactId}${MINERU_BUNDLE_DIR_SUFFIX}`]);
	});

	it("leaves the previous bundle untouched when the new write fails", async () => {
		await writePdfBundle();
		const before = await readMineruParseManifest(userId, sourceArtifactId);

		await expect(
			writeMineruParseBundle({
				userId,
				sourceArtifactId,
				zipPathAbsolute: join(process.cwd(), "fixtures", "does-not-exist.zip"),
				result: await pdfResult(),
				maxBytes: MAX_BYTES,
			}),
		).rejects.toThrow();

		expect(await readMineruParseManifest(userId, sourceArtifactId)).toEqual(
			before,
		);
	});
});

describe("writeMineruParseBundle — the byte budget", () => {
	it("always writes the JSON and the Markdown, even under a tiny budget", async () => {
		const manifest = await writePdfBundle({ maxBytes: 1 });
		const dir = mineruBundleDir(userId, sourceArtifactId);

		expect(await readdir(join(dir, "images"))).toEqual([]);
		expect(manifest.imagesOmitted).toBe(true);
		expect(manifest.markdownBytes).toBeGreaterThan(0);
		expect(
			(await readFile(join(dir, MINERU_BUNDLE_STRUCTURED_CONTENT), "utf8"))
				.length,
		).toBeGreaterThan(0);
	});

	it("skips a single image larger than a quarter of the budget", async () => {
		// The PDF figure is 24 862 uncompressed bytes, so a 40 000 byte budget
		// has room for it overall but not under the quarter-budget rule.
		const manifest = await writePdfBundle({ maxBytes: 40_000 });

		expect(manifest.imagesOmitted).toBe(true);
		expect(
			await readdir(join(mineruBundleDir(userId, sourceArtifactId), "images")),
		).toEqual([]);
		// The figure is still LISTED: the endpoint 404s on the missing file
		// rather than pretending the figure never existed.
		expect(manifest.figures).toHaveLength(1);
	});

	it("keeps the image when the budget allows it", async () => {
		const manifest = await writePdfBundle({ maxBytes: 200_000 });

		expect(manifest.imagesOmitted).toBe(false);
		expect(
			await readdir(join(mineruBundleDir(userId, sourceArtifactId), "images")),
		).toEqual(["page_2_image_body_3.jpg"]);
	});
});

describe("readMineruParseManifest / readMineruPageIndex", () => {
	it("round-trips the page index", async () => {
		const result = await pdfResult();
		await writePdfBundle({ result });

		expect(await readMineruPageIndex(userId, sourceArtifactId)).toEqual(
			result.pages.map((page) => ({ ...page })),
		);
	});

	it("returns null when there is no bundle", async () => {
		expect(await readMineruParseManifest(userId, sourceArtifactId)).toBeNull();
		expect(await readMineruPageIndex(userId, sourceArtifactId)).toBeNull();
		expect(
			await readMineruNormalizedMarkdown(userId, sourceArtifactId),
		).toBeNull();
	});

	it("returns null for a corrupt manifest rather than throwing", async () => {
		await writePdfBundle();
		await writeFile(
			join(mineruBundleDir(userId, sourceArtifactId), MINERU_BUNDLE_MANIFEST),
			"{ not json",
		);

		expect(await readMineruParseManifest(userId, sourceArtifactId)).toBeNull();
	});

	it("patches the normalized artifact id in after persist", async () => {
		await writePdfBundle();

		expect(
			await setMineruParseBundleNormalizedArtifactId(
				userId,
				sourceArtifactId,
				"normalized-1",
			),
		).toBe(true);
		const manifest = await readMineruParseManifest(userId, sourceArtifactId);
		expect(manifest?.normalizedArtifactId).toBe("normalized-1");
		// Nothing else moved.
		expect(manifest?.figures).toHaveLength(1);
		expect(
			await setMineruParseBundleNormalizedArtifactId(
				userId,
				randomUUID(),
				"normalized-1",
			),
		).toBe(false);
	});
});

describe("readMineruFigure", () => {
	async function readAll(stream: ReadableStream<Uint8Array>): Promise<number> {
		let total = 0;
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
		}
		return total;
	}

	it("serves a listed figure with the content type from its extension", async () => {
		await writePdfBundle();
		const figure = await readMineruFigure({
			userId,
			sourceArtifactId,
			name: "page_2_image_body_3.jpg",
		});

		expect(figure).not.toBeNull();
		expect(figure?.contentType).toBe("image/jpeg");
		expect(figure?.bytes).toBe(24_862);
		expect(await readAll(figure?.stream as ReadableStream<Uint8Array>)).toBe(
			24_862,
		);
	});

	it("refuses a traversal name", async () => {
		await writePdfBundle();

		for (const name of [
			"../manifest.json",
			"../../../../etc/passwd",
			"..",
			"images/page_2_image_body_3.jpg",
			"/etc/passwd",
			"a\\b.jpg",
		]) {
			expect(
				await readMineruFigure({ userId, sourceArtifactId, name }),
				name,
			).toBeNull();
		}
	});

	it("refuses a name the manifest does not list", async () => {
		await writePdfBundle();
		// Present on disk, absent from the manifest: still refused.
		await writeFile(
			join(mineruBundleDir(userId, sourceArtifactId), "images", "smuggled.jpg"),
			"bytes",
		);

		expect(
			await readMineruFigure({
				userId,
				sourceArtifactId,
				name: "smuggled.jpg",
			}),
		).toBeNull();
	});

	it("refuses a symlink that escapes the bundle", async () => {
		await writePdfBundle();
		const dir = mineruBundleDir(userId, sourceArtifactId);
		const secret = join(
			process.cwd(),
			"data",
			"knowledge",
			userId,
			"secret.jpg",
		);
		await writeFile(secret, "not yours");
		// A symlink whose NAME is the listed figure, pointing outside.
		await rm(join(dir, "images", "page_2_image_body_3.jpg"), { force: true });
		await symlink(secret, join(dir, "images", "page_2_image_body_3.jpg"));

		// `lstat` refuses it: the endpoint never follows a link out of the
		// bundle, even one whose name the manifest does list.
		expect(
			await readMineruFigure({
				userId,
				sourceArtifactId,
				name: "page_2_image_body_3.jpg",
			}),
		).toBeNull();
	});

	it("refuses an SVG and anything else that is not a served image type", async () => {
		expect(mineruFigureContentType("a.svg")).toBeNull();
		expect(mineruFigureContentType("a.html")).toBeNull();
		expect(mineruFigureContentType("a")).toBeNull();
		expect(mineruFigureContentType("a.JPG")).toBe("image/jpeg");
		expect(mineruFigureContentType("a.png")).toBe("image/png");
	});

	it("returns null when the bundle is gone", async () => {
		expect(
			await readMineruFigure({
				userId,
				sourceArtifactId,
				name: "page_2_image_body_3.jpg",
			}),
		).toBeNull();
	});

	it("returns null when the manifest lists a figure that was dropped", async () => {
		await writePdfBundle({ maxBytes: 40_000 });

		expect(
			await readMineruFigure({
				userId,
				sourceArtifactId,
				name: "page_2_image_body_3.jpg",
			}),
		).toBeNull();
	});
});

describe("removeMineruParseBundle", () => {
	it("removes the bundle", async () => {
		await writePdfBundle();
		expect(existsSync(mineruBundleDir(userId, sourceArtifactId))).toBe(true);

		await removeMineruParseBundle(userId, sourceArtifactId);
		expect(existsSync(mineruBundleDir(userId, sourceArtifactId))).toBe(false);
	});

	it("is a no-op when there is nothing to remove", async () => {
		await expect(
			removeMineruParseBundle(userId, sourceArtifactId),
		).resolves.toBeUndefined();
	});

	it("never throws, not even on an unsafe id", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			removeMineruParseBundle("../escape", "id"),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});
});
