/**
 * The on-disk parse bundle: everything Phase 4 keeps from one MinerU parse
 * that does not belong in a database column.
 *
 * Location: `data/knowledge/<userId>/<sourceArtifactId>.parse/`, a sibling of
 * the source artifact's own bytes at
 * `data/knowledge/<userId>/<sourceArtifactId>.<ext>`. The filename stem
 * already IS the artifact UUID (`knowledge/store/attachments.ts`), so the
 * directory name is derived rather than stored, account erasure already
 * removes it (`account-lifecycle` `rm -rf`s `data/knowledge/<userId>`), and
 * nothing needs a BLOB column.
 *
 *   <sourceArtifactId>.parse/
 *     manifest.json            MineruParseBundleManifest
 *     normalized.md            === the normalized artifact's contentText
 *     structured_content.json  the ZIP copy: relative image paths, no data URIs
 *     pages.json               [{page,start,end}], split out so a page lookup
 *                              never has to parse the blocks
 *     images/<name>.jpg        only the files a figure actually references
 *
 * Deliberately NOT kept: `middle_json.json` (nothing consumes HTML tables or
 * `styles:["bold"]` yet, and it is the second-largest artifact),
 * `model_output.json` (the largest, undocumented, and useless to us) and the
 * downloaded `result.zip` itself.
 *
 * This module is disk and nothing else: no database, no HTTP, no config
 * lookup. The budget arrives as a parameter so `resolveMineruConfig()` is read
 * once by the caller.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { getEntryByFilename } from "$lib/shared/file-types";
import {
	MINERU_IMAGE_NAME_PATTERN,
	MINERU_ZIP_IMAGE_PREFIX,
	MINERU_ZIP_STRUCTURED_CONTENT,
	type MineruZipLimits,
	openMineruResultZip,
	type PageCountKind,
	type PageOffset,
	type RenderedFigure,
	type StructuredExtractionResult,
	type StructuredExtractionStats,
} from "./result";

export const MINERU_BUNDLE_DIR_SUFFIX = ".parse";
/** The prefix of a half-written bundle: `<id>.parse.tmp-<pid>-<rand>`. */
export const MINERU_BUNDLE_TMP_INFIX = ".parse.tmp-";

export const MINERU_BUNDLE_MANIFEST = "manifest.json";
export const MINERU_BUNDLE_MARKDOWN = "normalized.md";
export const MINERU_BUNDLE_STRUCTURED_CONTENT = "structured_content.json";
export const MINERU_BUNDLE_PAGES = "pages.json";
export const MINERU_BUNDLE_IMAGES_DIR = "images";

/** A path segment the app may join: a UUID in practice, checked anyway. */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MineruParseBundleManifest {
	version: 1;
	sourceArtifactId: string;
	/** Patched in after `persist.ts` has created the normalized artifact. */
	normalizedArtifactId: string | null;
	createdAt: string;
	parserVersion: string;
	producerVersion: string | null;
	serverParserVersion: string | null;
	/** `extensions.mineru.tier` — the real per-file tier. */
	effectiveTier: string | null;
	jobTier: string | null;
	parseMode: string | null;
	pageCount: number;
	pageCountKind: PageCountKind;
	markdownBytes: number;
	/** sha256 of `normalized.md`, so a reader can detect a stale bundle. */
	markdownSha256: string;
	/** The allow-list the figure endpoint serves from. Nothing else is readable. */
	figures: readonly RenderedFigure[];
	/** True when an image was dropped to stay inside the byte budget. */
	imagesOmitted: boolean;
	/**
	 * The bundle's payload bytes: `normalized.md` + `structured_content.json` +
	 * `pages.json` + `images/`. The manifest cannot include its own size
	 * without being circular, so it does not try.
	 */
	totalBytes: number;
	stats: StructuredExtractionStats;
}

function assertSafeSegment(value: string, label: string): string {
	if (!SAFE_PATH_SEGMENT.test(value) || value === "." || value === "..") {
		throw new Error(`Unsafe ${label} for a MinerU parse bundle: ${value}`);
	}
	return value;
}

/**
 * `data/knowledge/<userId>` — the same tree `knowledgeUserDir`
 * (`knowledge/store/core.ts`) builds. Recomputed here rather than imported so
 * this module keeps no database dependency; the two must not drift.
 */
function knowledgeUserDirectory(userId: string): string {
	return join(process.cwd(), "data", "knowledge", userId);
}

export function mineruBundleDir(
	userId: string,
	sourceArtifactId: string,
): string {
	return join(
		knowledgeUserDirectory(assertSafeSegment(userId, "userId")),
		`${assertSafeSegment(sourceArtifactId, "sourceArtifactId")}${MINERU_BUNDLE_DIR_SUFFIX}`,
	);
}

/**
 * The content type a figure may be served as, or null when it is not one.
 *
 * The answer comes from the shared file-type registry rather than a table
 * here, with two conditions on top: the entry must be an image, and its
 * canonical type must not be an XML dialect. That second rule is what
 * excludes SVG — a script-bearing document, produced by a service parsing a
 * user-supplied file, which must never be served inline. No recorded MinerU
 * output contains one; if one ever appears it is dropped rather than stored.
 */
export function mineruFigureContentType(name: string): string | null {
	const entry = getEntryByFilename(name);
	if (!entry || entry.category !== "image") return null;
	const contentType = entry.mimeTypes[0];
	return contentType.endsWith("+xml") ? null : contentType;
}

function figureLeafName(path: string): string | null {
	if (!path.startsWith(MINERU_ZIP_IMAGE_PREFIX)) return null;
	const leaf = path.slice(MINERU_ZIP_IMAGE_PREFIX.length);
	return MINERU_IMAGE_NAME_PATTERN.test(leaf) ? leaf : null;
}

export interface WriteMineruParseBundleInput {
	userId: string;
	sourceArtifactId: string;
	/** The downloaded `result.zip`. Read, never moved into the bundle. */
	zipPathAbsolute: string;
	result: StructuredExtractionResult;
	/** `resolveMineruConfig().bundleMaxBytes`. */
	maxBytes: number;
	/** Set when the caller already knows it; otherwise patched in later. */
	normalizedArtifactId?: string | null;
	limits?: Partial<MineruZipLimits>;
	now?: () => Date;
}

/**
 * Writes the bundle atomically and idempotently.
 *
 *   1. write into `<id>.parse.tmp-<pid>-<rand>/`;
 *   2. `rm -rf` any existing `<id>.parse/`;
 *   3. `rename` the temp directory into place — atomic on one filesystem;
 *   4. on any failure, `rm -rf` the temp directory and rethrow.
 *
 * A crash therefore leaves either the old bundle or the new one, never half of
 * either. Step 2 cannot race a live reader because Phase 3's
 * `UNIQUE(source_artifact_id)` on the job row means two attempts for the same
 * artifact can never run at once.
 */
export async function writeMineruParseBundle(
	input: WriteMineruParseBundleInput,
): Promise<MineruParseBundleManifest> {
	const bundleDir = mineruBundleDir(input.userId, input.sourceArtifactId);
	const tempDir = `${bundleDir}.tmp-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;

	try {
		const zip = await openMineruResultZip({
			zipPathAbsolute: input.zipPathAbsolute,
			...(input.limits ? { limits: input.limits } : {}),
		});

		const markdown = input.result.markdown;
		const markdownBytes = Buffer.byteLength(markdown, "utf8");
		const structuredContent =
			(await zip.readText(MINERU_ZIP_STRUCTURED_CONTENT)) ?? "";
		const structuredBytes = Buffer.byteLength(structuredContent, "utf8");
		const pagesJson = JSON.stringify(input.result.pages);
		const pagesBytes = Buffer.byteLength(pagesJson, "utf8");

		await mkdir(join(tempDir, MINERU_BUNDLE_IMAGES_DIR), { recursive: true });
		await writeFile(join(tempDir, MINERU_BUNDLE_MARKDOWN), markdown, "utf8");
		await writeFile(
			join(tempDir, MINERU_BUNDLE_STRUCTURED_CONTENT),
			structuredContent,
			"utf8",
		);
		await writeFile(join(tempDir, MINERU_BUNDLE_PAGES), pagesJson, "utf8");

		const written = await writeBundleImages({
			tempDir,
			zip,
			figures: input.result.figures,
			maxBytes: input.maxBytes,
			usedBytes: markdownBytes + structuredBytes + pagesBytes,
		});

		const manifest: MineruParseBundleManifest = {
			version: 1,
			sourceArtifactId: input.sourceArtifactId,
			normalizedArtifactId: input.normalizedArtifactId ?? null,
			createdAt: (input.now?.() ?? new Date()).toISOString(),
			parserVersion: input.result.parserVersion,
			producerVersion: input.result.producerVersion,
			serverParserVersion: input.result.serverParserVersion,
			effectiveTier: input.result.effectiveTier,
			jobTier: input.result.jobTier,
			parseMode: input.result.parseMode,
			pageCount: input.result.pageCount,
			pageCountKind: input.result.pageCountKind,
			markdownBytes,
			markdownSha256: createHash("sha256")
				.update(markdown, "utf8")
				.digest("hex"),
			figures: input.result.figures,
			imagesOmitted: written.imagesOmitted,
			totalBytes:
				markdownBytes + structuredBytes + pagesBytes + written.imageBytes,
			stats: input.result.stats,
		};

		await writeFile(
			join(tempDir, MINERU_BUNDLE_MANIFEST),
			JSON.stringify(manifest, null, 2),
			"utf8",
		);

		await rm(bundleDir, { recursive: true, force: true });
		await rename(tempDir, bundleDir);
		return manifest;
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Images, newest page first, until the budget runs out.
 *
 * Newest-page-first rather than reading order because when a budget bites it
 * is on a long document, and the pages a user is most likely to be looking at
 * when they hit "show me the figure" are the ones near the end. A single image
 * larger than a quarter of the whole budget is skipped outright rather than
 * being allowed to evict three others.
 */
async function writeBundleImages(params: {
	tempDir: string;
	zip: Awaited<ReturnType<typeof openMineruResultZip>>;
	figures: readonly RenderedFigure[];
	maxBytes: number;
	usedBytes: number;
}): Promise<{ imageBytes: number; imagesOmitted: boolean }> {
	const ordered = [...params.figures].sort(
		(a, b) => b.page - a.page || a.index - b.index,
	);
	const singleImageCap = Math.floor(params.maxBytes / 4);

	let used = params.usedBytes;
	let imageBytes = 0;
	let imagesOmitted = false;
	const seen = new Set<string>();

	for (const figure of ordered) {
		const leaf = figureLeafName(figure.path);
		if (!leaf || seen.has(leaf)) continue;
		if (!mineruFigureContentType(leaf)) {
			// Not an image type this app will ever serve — never store it.
			imagesOmitted = true;
			continue;
		}
		seen.add(leaf);

		// The budget is checked against the UNCOMPRESSED size declared by the
		// zip, before a byte is inflated.
		const declared = params.zip.entries.get(figure.path) ?? 0;
		if (declared > singleImageCap || used + declared > params.maxBytes) {
			imagesOmitted = true;
			continue;
		}

		const bytes = await params.zip.readBytes(figure.path);
		if (!bytes) continue;
		await writeFile(
			join(params.tempDir, MINERU_BUNDLE_IMAGES_DIR, leaf),
			Buffer.from(bytes),
		);
		used += bytes.byteLength;
		imageBytes += bytes.byteLength;
	}

	return { imageBytes, imagesOmitted };
}

async function readBundleJson<T>(
	userId: string,
	sourceArtifactId: string,
	file: string,
): Promise<T | null> {
	try {
		const raw = await readFile(
			join(mineruBundleDir(userId, sourceArtifactId), file),
			"utf8",
		);
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** null when there is no bundle, or it is unreadable. Never throws. */
export async function readMineruParseManifest(
	userId: string,
	sourceArtifactId: string,
): Promise<MineruParseBundleManifest | null> {
	const manifest = await readBundleJson<MineruParseBundleManifest>(
		userId,
		sourceArtifactId,
		MINERU_BUNDLE_MANIFEST,
	);
	return manifest && manifest.version === 1 ? manifest : null;
}

/**
 * The page index, without parsing the blocks.
 *
 * `read_generated_file?page=` (P4-C) calls this on a tool call, never on the
 * prompt-assembly path, so the cost is one small JSON read per `page`-using
 * call.
 */
export async function readMineruPageIndex(
	userId: string,
	sourceArtifactId: string,
): Promise<readonly PageOffset[] | null> {
	const pages = await readBundleJson<PageOffset[]>(
		userId,
		sourceArtifactId,
		MINERU_BUNDLE_PAGES,
	);
	return Array.isArray(pages) ? pages : null;
}

/** The normalized Markdown as it was written. null when there is no bundle. */
export async function readMineruNormalizedMarkdown(
	userId: string,
	sourceArtifactId: string,
): Promise<string | null> {
	try {
		return await readFile(
			join(mineruBundleDir(userId, sourceArtifactId), MINERU_BUNDLE_MARKDOWN),
			"utf8",
		);
	} catch {
		return null;
	}
}

export interface MineruFigureRead {
	stream: ReadableStream<Uint8Array>;
	bytes: number;
	contentType: string;
}

/**
 * One figure's bytes, by the name the manifest lists.
 *
 * The manifest IS the allow-list: a name that is not in `figures[].path` is
 * refused before any path is built, so there is nothing for a traversal to
 * reach even if the containment check below were wrong. Both checks are kept —
 * the name pattern refuses `..` and separators outright, and the resolved path
 * must still sit inside the bundle directory.
 */
export async function readMineruFigure(input: {
	userId: string;
	sourceArtifactId: string;
	name: string;
}): Promise<MineruFigureRead | null> {
	if (!MINERU_IMAGE_NAME_PATTERN.test(input.name)) return null;
	if (input.name.includes("..")) return null;

	const contentType = mineruFigureContentType(input.name);
	if (!contentType) return null;

	const manifest = await readMineruParseManifest(
		input.userId,
		input.sourceArtifactId,
	);
	if (!manifest) return null;
	const listed = manifest.figures.some(
		(figure) => figureLeafName(figure.path) === input.name,
	);
	if (!listed) return null;

	const bundleDir = mineruBundleDir(input.userId, input.sourceArtifactId);
	const imagesDir = join(bundleDir, MINERU_BUNDLE_IMAGES_DIR);
	const filePath = resolve(imagesDir, input.name);
	// Containment, not the deny-list `isUnsafeStoredArtifactPath` uses: the
	// RESOLVED path must still sit inside the bundle's images directory.
	if (!filePath.startsWith(`${resolve(imagesDir)}${sep}`)) {
		return null;
	}

	let bytes: number;
	try {
		// `lstat`, not `stat`: a symlink here must be refused rather than
		// followed. Writing one requires access to the bundle directory already,
		// and the zip reader never creates one — but the endpoint is the thing
		// facing the network, so it does not rely on that.
		const stats = await lstat(filePath);
		if (!stats.isFile()) return null;
		bytes = stats.size;
	} catch {
		return null;
	}

	return {
		stream: Readable.toWeb(
			createReadStream(filePath),
		) as ReadableStream<Uint8Array>,
		bytes,
		contentType,
	};
}

/**
 * Records the normalized artifact's id on an already-written bundle.
 *
 * `persist.ts` (P4-B) only learns the id after the bundle exists, and the
 * alternative — deferring the whole write until after persist — would mean
 * holding the zip open across a database transaction. Returns false when there
 * is no bundle to patch.
 */
export async function setMineruParseBundleNormalizedArtifactId(
	userId: string,
	sourceArtifactId: string,
	normalizedArtifactId: string | null,
): Promise<boolean> {
	const manifest = await readMineruParseManifest(userId, sourceArtifactId);
	if (!manifest) return false;
	const next: MineruParseBundleManifest = { ...manifest, normalizedArtifactId };
	try {
		await writeFile(
			join(mineruBundleDir(userId, sourceArtifactId), MINERU_BUNDLE_MANIFEST),
			JSON.stringify(next, null, 2),
			"utf8",
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Best effort. Never throws — a bundle that outlives its artifact is a disk
 * report entry, while a throw here would abort the remaining unlinks in
 * `cleanup.ts` and leave real bytes behind.
 */
export async function removeMineruParseBundle(
	userId: string,
	sourceArtifactId: string,
): Promise<void> {
	let bundleDir: string;
	try {
		bundleDir = mineruBundleDir(userId, sourceArtifactId);
	} catch (error) {
		console.warn("[KNOWLEDGE_DELETE] Parse bundle path rejected", {
			userId,
			sourceArtifactId,
			error: error instanceof Error ? error.message : error,
		});
		return;
	}

	try {
		await rm(bundleDir, { recursive: true, force: true });
	} catch (error) {
		console.warn("[KNOWLEDGE_DELETE] Parse bundle cleanup failed", {
			userId,
			sourceArtifactId,
			bundleDir,
			error,
		});
	}
}
