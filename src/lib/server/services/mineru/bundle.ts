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
import { createReadStream, type Dirent } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { resolveDeletablePath } from "$lib/server/storage-containment";
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
	 * True when `images/` was removed AFTER the fact, to bring the user's total
	 * bundle storage back under `MINERU_BUNDLE_USER_QUOTA_BYTES`.
	 *
	 * Distinct from `imagesOmitted`, which is about THIS document's own
	 * per-bundle budget at write time. Optional, and absent on every bundle
	 * written before the quota existed — a reader must treat that absence as
	 * false rather than as "unknown".
	 */
	imagesEvicted?: boolean;
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
	/**
	 * `resolveMineruConfig().bundleUserQuotaBytes`. 0 (and omitted) disable the
	 * per-user retention pass entirely, which is what every box did before the
	 * key existed.
	 */
	userQuotaBytes?: number;
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

		// AFTER the rename, so the bundle this parse just produced is on disk
		// and counted before anything is evicted to make room for it — and so a
		// failure here cannot cost the caller the parse it already paid for.
		await enforceMineruParseBundleQuota({
			userId: input.userId,
			keepSourceArtifactId: input.sourceArtifactId,
			quotaBytes: input.userQuotaBytes ?? 0,
		}).catch((error) => {
			console.warn("[MINERU] Parse bundle quota pass failed", { error });
			return null;
		});

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

// ---------------------------------------------------------------------------
// Per-user retention
// ---------------------------------------------------------------------------

/**
 * The most bundle directories one quota pass will measure and consider.
 *
 * The pass runs on the extraction path, after every successful parse, so it
 * has to be bounded rather than proportional to a user's whole library. 256 is
 * chosen against `MINERU_BUNDLE_MAX_BYTES`: 256 bundles at the 32 MiB per-file
 * cap is 8 GiB, four times the default quota, so the budget bites long before
 * the cap does. When it does bite, the pass simply frees less this time and
 * the next write continues — it is a bound on WORK, not on correctness.
 *
 * Bundles are measured oldest-first, so the cap never hides the candidates
 * eviction would have chosen anyway.
 */
export const MINERU_BUNDLE_QUOTA_MAX_EXAMINED = 256;

export interface MineruBundleQuotaResult {
	quotaBytes: number;
	examined: number;
	usedBytesBefore: number;
	usedBytesAfter: number;
	/** Bundles whose `images/` was dropped but which otherwise still work. */
	imagesEvicted: number;
	/** Bundles removed whole. */
	bundlesRemoved: number;
	freedBytes: number;
}

interface BundleCandidate {
	sourceArtifactId: string;
	dir: string;
	/** Last write of the bundle directory itself — when it was renamed into place. */
	writtenAtMs: number;
	bytes: number;
}

/** Real bytes on disk under `dir`, following no symlink. 0 when unreadable. */
async function directoryBytes(dir: string): Promise<number> {
	let total = 0;
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await directoryBytes(path);
			continue;
		}
		try {
			const stats = await lstat(path);
			if (stats.isFile()) total += stats.size;
		} catch {
			// Raced with a delete. It is not occupying bytes any more either.
		}
	}
	return total;
}

/**
 * Rename-then-remove.
 *
 * The rename is the atomic part: a concurrent reader either resolves the old
 * path and gets the file, or does not and gets an ENOENT, which every reader
 * here already answers with `null` (and the figure endpoint with a 404). It
 * never sees a directory with half its files gone. The renamed name carries
 * `MINERU_BUNDLE_TMP_INFIX`, so if the process dies between the two steps the
 * leftovers are what `temp-sweep.ts` already collects and what the disk report
 * already ignores.
 */
async function evictPath(path: string): Promise<boolean> {
	// Containment before the rename. These paths come from listing the disk
	// rather than from a row, so `assertSafeSegment` never saw them: a
	// symlinked bundle directory would otherwise let a recursive `rm` walk out
	// of `data/knowledge/` entirely.
	if (!(await resolveDeletablePath(path))) {
		console.warn("[MINERU] Refused to evict a path outside the data roots");
		return false;
	}
	const parked = `${path}${MINERU_BUNDLE_TMP_INFIX}evict-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
	try {
		await rename(path, parked);
	} catch {
		return false;
	}
	await rm(parked, { recursive: true, force: true }).catch(() => undefined);
	return true;
}

async function markImagesEvicted(
	userId: string,
	sourceArtifactId: string,
): Promise<void> {
	const manifest = await readMineruParseManifest(userId, sourceArtifactId);
	if (!manifest) return;
	await writeManifest(userId, sourceArtifactId, {
		...manifest,
		// The figure list IS the endpoint's allow-list, so emptying it makes the
		// endpoint answer 404 before it touches the filesystem, and makes any
		// surface that enumerates figures render none — which is the truth
		// about this bundle now. The flag beside it says the figures were
		// evicted rather than never produced, so "Re-extract" is the honest
		// offer and `imagesOmitted` keeps its own, different meaning.
		figures: [],
		imagesEvicted: true,
	});
}

/**
 * Brings one user's total parse-bundle storage back under the quota.
 *
 * A bundle is DERIVED data: the normalized text is in the database and
 * "Re-extract" rebuilds a bundle from scratch. So the budget is met by
 * throwing the cheapest thing away first, and in this order:
 *
 *   1. other documents' `images/` directories, least-recently-written first.
 *      `normalized.md`, `pages.json` and `structured_content.json` stay, so
 *      page citations and `read_generated_file?page=` keep working; only the
 *      figures go, and the figure endpoint already answers 404 for a file that
 *      is not there;
 *   2. if that is not enough, whole bundles, least-recently-written first.
 *
 * `keepSourceArtifactId` — the bundle the caller just wrote — is never
 * touched. Evicting the document a user is looking at right now, to make room
 * for itself, would be the one obviously wrong outcome.
 *
 * Returns null when the quota is disabled (`0`) or the user is under it.
 * Never throws: a failed eviction costs disk, and throwing here would fail an
 * extraction that has already succeeded.
 */
export async function enforceMineruParseBundleQuota(input: {
	userId: string;
	keepSourceArtifactId: string;
	quotaBytes: number;
	maxExamined?: number;
}): Promise<MineruBundleQuotaResult | null> {
	if (!Number.isFinite(input.quotaBytes) || input.quotaBytes <= 0) return null;

	let userDir: string;
	try {
		userDir = knowledgeUserDirectory(assertSafeSegment(input.userId, "userId"));
	} catch {
		return null;
	}

	let entries: Dirent[];
	try {
		entries = await readdir(userDir, { withFileTypes: true });
	} catch {
		return null;
	}

	// Name + mtime first (one stat each), so the expensive recursive sizing is
	// only paid for the bundles this pass can actually act on.
	const named: Array<{ sourceArtifactId: string; dir: string; mtime: number }> =
		[];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name.includes(MINERU_BUNDLE_TMP_INFIX)) continue;
		if (!entry.name.endsWith(MINERU_BUNDLE_DIR_SUFFIX)) continue;
		const sourceArtifactId = entry.name.slice(
			0,
			-MINERU_BUNDLE_DIR_SUFFIX.length,
		);
		if (!sourceArtifactId) continue;
		const dir = join(userDir, entry.name);
		try {
			const stats = await stat(dir);
			named.push({ sourceArtifactId, dir, mtime: stats.mtimeMs });
		} catch {
			// Gone between readdir and stat.
		}
	}

	const maxExamined = input.maxExamined ?? MINERU_BUNDLE_QUOTA_MAX_EXAMINED;
	// Oldest first, but the bundle just written is always measured: it counts
	// towards the total even though it can never be evicted.
	const ordered = named.sort((a, b) => a.mtime - b.mtime);
	const fresh = ordered.filter(
		(row) => row.sourceArtifactId === input.keepSourceArtifactId,
	);
	const rest = ordered.filter(
		(row) => row.sourceArtifactId !== input.keepSourceArtifactId,
	);
	const selected = [...fresh, ...rest.slice(0, Math.max(0, maxExamined - 1))];

	const candidates: BundleCandidate[] = [];
	for (const row of selected) {
		candidates.push({
			sourceArtifactId: row.sourceArtifactId,
			dir: row.dir,
			writtenAtMs: row.mtime,
			bytes: await directoryBytes(row.dir),
		});
	}

	const usedBytesBefore = candidates.reduce((sum, row) => sum + row.bytes, 0);

	// The quota this PASS enforces, which is the whole quota only when the
	// window covers every bundle the user has.
	//
	// The examination cap bounds the work, and its reasoning argues from
	// `MINERU_BUNDLE_MAX_BYTES`: 256 bundles at the 32 MiB per-file cap is four
	// times the default quota, so the window would always see the excess. That
	// holds for large bundles and fails completely for small ones. 256 bundles
	// of 100 KiB is 25 MiB — under any quota — while the 2 000 bundles the user
	// actually has are 195 MiB. `usedBytesBefore` then reports 25 MiB, the
	// comparison below finds no excess, and a user 551% over quota has nothing
	// evicted, ever. The cap silently switched the quota off rather than
	// bounding it.
	//
	// So the window is measured against its own SHARE of the quota. It is the
	// oldest bundles, which is what eviction would take first anyway, and each
	// write walks the same bounded number of directories — but now every write
	// makes real progress, and repeated writes converge on the true quota
	// instead of stalling above it. When the window is everything, the share is
	// the whole quota and nothing changes.
	const windowQuotaBytes =
		named.length > selected.length
			? Math.max(
					1,
					Math.floor((input.quotaBytes * selected.length) / named.length),
				)
			: input.quotaBytes;

	if (usedBytesBefore <= windowQuotaBytes) return null;

	const evictable = candidates
		.filter((row) => row.sourceArtifactId !== input.keepSourceArtifactId)
		.sort((a, b) => a.writtenAtMs - b.writtenAtMs);

	let used = usedBytesBefore;
	let imagesEvicted = 0;
	let bundlesRemoved = 0;
	const emptied = new Set<string>();

	// Pass 1 — figures only.
	for (const row of evictable) {
		if (used <= windowQuotaBytes) break;
		const imagesDir = join(row.dir, MINERU_BUNDLE_IMAGES_DIR);
		const imageBytes = await directoryBytes(imagesDir);
		if (imageBytes === 0) continue;
		if (!(await evictPath(imagesDir))) continue;
		await markImagesEvicted(input.userId, row.sourceArtifactId);
		used -= imageBytes;
		row.bytes -= imageBytes;
		imagesEvicted += 1;
		emptied.add(row.sourceArtifactId);
	}

	// Pass 2 — whole bundles.
	for (const row of evictable) {
		if (used <= windowQuotaBytes) break;
		if (!(await evictPath(row.dir))) continue;
		used -= row.bytes;
		if (emptied.has(row.sourceArtifactId)) imagesEvicted -= 1;
		bundlesRemoved += 1;
	}

	const result: MineruBundleQuotaResult = {
		quotaBytes: input.quotaBytes,
		examined: candidates.length,
		usedBytesBefore,
		usedBytesAfter: used,
		imagesEvicted,
		bundlesRemoved,
		freedBytes: usedBytesBefore - used,
	};

	// Counts and bytes only. No artifact ids, no file names, no user id — the
	// line is about disk, and a log line that named documents would turn a
	// retention sweep into a record of what this account uploaded.
	console.info("[MINERU] Parse bundle quota enforced", {
		quotaBytes: result.quotaBytes,
		examined: result.examined,
		usedBytesBefore: result.usedBytesBefore,
		usedBytesAfter: result.usedBytesAfter,
		imagesEvicted: result.imagesEvicted,
		bundlesRemoved: result.bundlesRemoved,
		freedBytes: result.freedBytes,
	});

	return result;
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
	options: { expectedMarkdown?: string | null } = {},
): Promise<readonly PageOffset[] | null> {
	// The offsets index the bundle's `normalized.md`, and the bundle is written
	// by the EXTRACTOR — before `persist.ts` rewrites the artifact's
	// `contentText`. An attempt that succeeds at the parse and then dies, is
	// cancelled, or loses its claim before persisting leaves a bundle that is
	// one parse ahead of the text, and every offset in it then lands somewhere
	// else in the document. That failure is silent: the reader gets the wrong
	// page, confidently, with a citation.
	//
	// `manifest.markdownSha256` exists precisely so a reader can detect that,
	// and nothing was checking it. A caller that knows the text it is about to
	// index passes it; a mismatch means "no page index", which the caller
	// already handles by reading from the start.
	if (typeof options.expectedMarkdown === "string") {
		const manifest = await readMineruParseManifest(userId, sourceArtifactId);
		if (!manifest) return null;
		const digest = createHash("sha256")
			.update(options.expectedMarkdown, "utf8")
			.digest("hex");
		if (manifest.markdownSha256 !== digest) return null;
	}

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
	return writeManifest(userId, sourceArtifactId, {
		...manifest,
		normalizedArtifactId,
	});
}

/**
 * Replaces a live bundle's manifest.
 *
 * Write-then-rename, not a plain overwrite. The manifest IS the figure
 * endpoint's allow-list and the page index's staleness check, so a crash
 * part-way through an in-place write would truncate it to invalid JSON,
 * `readMineruParseManifest` would return null forever after, and every figure
 * of that document would 404 with nothing left to repair it from.
 */
async function writeManifest(
	userId: string,
	sourceArtifactId: string,
	manifest: MineruParseBundleManifest,
): Promise<boolean> {
	const manifestPath = join(
		mineruBundleDir(userId, sourceArtifactId),
		MINERU_BUNDLE_MANIFEST,
	);
	const tempPath = `${manifestPath}.tmp-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
	try {
		await writeFile(tempPath, JSON.stringify(manifest, null, 2), "utf8");
		await rename(tempPath, manifestPath);
		return true;
	} catch {
		await rm(tempPath, { force: true }).catch(() => undefined);
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

	// `mineruBundleDir` already refuses an unsafe SEGMENT; this refuses an
	// unsafe RESOLVED path, which is the part a symlinked user directory could
	// still have moved outside `data/knowledge/`.
	if (!(await resolveDeletablePath(bundleDir))) {
		console.warn(
			"[KNOWLEDGE_DELETE] Parse bundle path outside the data roots",
			{
				userId,
				sourceArtifactId,
			},
		);
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
