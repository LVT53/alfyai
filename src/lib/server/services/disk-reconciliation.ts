import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isNotNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts, chatGeneratedFiles } from "$lib/server/db/schema";

export interface OrphanFile {
	path: string;
	sizeBytes: number;
	category: "knowledge" | "chat-files";
	/**
	 * "bundle" is a whole `<artifactId>.parse/` directory reported as one
	 * entry. Absent means a single file, which is what every row was before
	 * parse bundles existed.
	 */
	kind?: "bundle";
}

export interface OrphanReport {
	totalFileCount: number;
	totalSizeBytes: number;
	orphanFiles: OrphanFile[];
	orphanCount: number;
	orphanTotalSizeBytes: number;
}

/**
 * Directories under `data/knowledge/` that are NOT artifact bytes and must
 * never be matched against `artifacts.storage_path` file by file.
 *
 * `.incoming` is the upload staging area — a pre-existing false-positive
 * source that this walk reported as an orphan on every run. `<id>.parse` is a
 * MinerU parse bundle, and `<id>.parse.tmp-<pid>-<rand>` is a half-written
 * one; listing either per file would add one orphan row per image and per
 * JSON and drown the report.
 *
 * NOTE the shape of the temp suffix: the directory is named
 * `<id>.parse.tmp-<pid>-<rand>`, so a plain `endsWith(".parse.tmp")` would
 * never match a real one.
 */
const IGNORED_KNOWLEDGE_DIR_NAMES = /^\.incoming$/;
const IGNORED_KNOWLEDGE_DIR_SUFFIXES = /\.parse(?:\.tmp(?:-.*)?)?$/;

function isIgnoredKnowledgeDir(name: string): boolean {
	return (
		IGNORED_KNOWLEDGE_DIR_NAMES.test(name) ||
		IGNORED_KNOWLEDGE_DIR_SUFFIXES.test(name)
	);
}

/**
 * `user-1/abc.parse` → `user-1/abc`, the same shape `storagePathStem` produces
 * from a known storage path. null for anything that is not a settled bundle
 * directory, which excludes the half-written `.parse.tmp-…` ones.
 */
function parseBundleStem(relPath: string): string | null {
	if (!relPath.endsWith(".parse")) return null;
	const stem = relPath.slice(0, -".parse".length);
	return stem.length > 0 ? stem : null;
}

interface SkippedDir {
	absPath: string;
	/** Relative to the knowledge root, e.g. `user-1/abc.parse`. */
	relPath: string;
	fileCount: number;
	sizeBytes: number;
}

interface WalkResult {
	files: string[];
	skippedDirs: SkippedDir[];
}

async function walkFilesOnly(
	dir: string,
): Promise<{ files: string[]; sizeBytes: number }> {
	let sizeBytes = 0;
	const files: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				const nested = await walkFilesOnly(fullPath);
				files.push(...nested.files);
				sizeBytes += nested.sizeBytes;
			} else if (entry.isFile()) {
				files.push(fullPath);
				try {
					sizeBytes += (await stat(fullPath)).size;
				} catch {
					// Vanished between readdir and stat. Nothing to report.
				}
			}
		}
	} catch {
		return { files: [], sizeBytes: 0 };
	}
	return { files, sizeBytes };
}

/**
 * Walks `dir`, collecting files but stepping around the directories that are
 * not artifact bytes.
 *
 * A skipped directory is still measured — its bytes and file count stay in the
 * report's totals, so "how much is on disk" remains true — but it is never
 * matched file by file against a storage path.
 */
async function walkDir(
	dir: string,
	root: string,
	/** The ignore rules are about the knowledge tree's layout only. */
	applyKnowledgeIgnores: boolean,
): Promise<WalkResult> {
	const files: string[] = [];
	const skippedDirs: SkippedDir[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (applyKnowledgeIgnores && isIgnoredKnowledgeDir(entry.name)) {
					const measured = await walkFilesOnly(fullPath);
					skippedDirs.push({
						absPath: fullPath,
						relPath: relative(root, fullPath),
						fileCount: measured.files.length,
						sizeBytes: measured.sizeBytes,
					});
					continue;
				}
				const nested = await walkDir(fullPath, root, applyKnowledgeIgnores);
				files.push(...nested.files);
				skippedDirs.push(...nested.skippedDirs);
			} else if (entry.isFile()) {
				files.push(fullPath);
			}
		}
	} catch {
		return { files: [], skippedDirs: [] };
	}
	return { files, skippedDirs };
}

function normalizeKnowledgeDbPath(dbPath: string): string | null {
	const markers = ["/knowledge/", "\\knowledge\\"];
	for (const marker of markers) {
		const idx = dbPath.indexOf(marker);
		if (idx !== -1) {
			return dbPath.slice(idx + marker.length);
		}
	}
	return null;
}

/**
 * `user-1/abc.pdf` → `user-1/abc`.
 *
 * A source artifact's bytes are stored as `<artifactId>.<ext>`, so the stem of
 * a known storage path IS a live artifact id. That is what tells a live parse
 * bundle from one whose artifact was deleted without it, and it needs no extra
 * query.
 */
function storagePathStem(relPath: string): string {
	const dot = relPath.lastIndexOf(".");
	const slash = relPath.lastIndexOf("/");
	return dot > slash + 1 ? relPath.slice(0, dot) : relPath;
}

export async function findOrphanFiles(opts?: {
	dataDir?: string;
}): Promise<OrphanReport> {
	const dataDir = opts?.dataDir ?? join(process.cwd(), "data");
	const knowledgeDir = join(dataDir, "knowledge");
	const chatFilesDir = join(dataDir, "chat-files");

	const knowledgeWalk = await walkDir(knowledgeDir, knowledgeDir, true);
	const chatFilesWalk = await walkDir(chatFilesDir, chatFilesDir, false);

	const artifactRows = await db
		.select({ storagePath: artifacts.storagePath })
		.from(artifacts)
		.where(isNotNull(artifacts.storagePath));

	const chatFileRows = await db
		.select({ storagePath: chatGeneratedFiles.storagePath })
		.from(chatGeneratedFiles);

	const knownKnowledgePaths = new Set<string>();
	const knownKnowledgeStems = new Set<string>();
	for (const row of artifactRows) {
		if (!row.storagePath) continue;
		const rel = normalizeKnowledgeDbPath(row.storagePath);
		if (!rel) continue;
		knownKnowledgePaths.add(rel);
		knownKnowledgeStems.add(storagePathStem(rel.split("\\").join("/")));
	}

	const knownChatFilePaths = new Set<string>();
	for (const row of chatFileRows) {
		knownChatFilePaths.add(row.storagePath);
	}

	const diskEntries: {
		relPath: string;
		absPath: string;
		category: "knowledge" | "chat-files";
	}[] = [];

	for (const absPath of knowledgeWalk.files) {
		diskEntries.push({
			relPath: relative(knowledgeDir, absPath),
			absPath,
			category: "knowledge",
		});
	}

	for (const absPath of chatFilesWalk.files) {
		diskEntries.push({
			relPath: relative(chatFilesDir, absPath),
			absPath,
			category: "chat-files",
		});
	}

	const orphanFiles: OrphanFile[] = [];
	let totalSizeBytes = 0;
	let totalFileCount = diskEntries.length;

	for (const entry of diskEntries) {
		let fileSize = 0;
		try {
			const s = await stat(entry.absPath);
			fileSize = s.size;
		} catch {
			continue;
		}

		totalSizeBytes += fileSize;

		const isKnown =
			entry.category === "knowledge"
				? knownKnowledgePaths.has(entry.relPath)
				: knownChatFilePaths.has(entry.relPath);

		if (!isKnown) {
			orphanFiles.push({
				path: entry.relPath,
				sizeBytes: fileSize,
				category: entry.category,
			});
		}
	}

	// The skipped directories still count towards what is on disk, and a parse
	// bundle whose source artifact is gone is reported as ONE entry. A
	// `.parse.tmp-…` directory is never reported: it is either in flight right
	// now or the debris of a crash, and the next write removes it.
	for (const skipped of knowledgeWalk.skippedDirs) {
		totalFileCount += skipped.fileCount;
		totalSizeBytes += skipped.sizeBytes;

		const bundleStem = parseBundleStem(skipped.relPath.split("\\").join("/"));
		if (!bundleStem) continue;
		if (knownKnowledgeStems.has(bundleStem)) continue;

		orphanFiles.push({
			path: skipped.relPath,
			sizeBytes: skipped.sizeBytes,
			category: "knowledge",
			kind: "bundle",
		});
	}

	orphanFiles.sort((a, b) => a.path.localeCompare(b.path));

	const orphanTotalSizeBytes = orphanFiles.reduce(
		(sum, f) => sum + f.sizeBytes,
		0,
	);

	return {
		totalFileCount,
		totalSizeBytes,
		orphanFiles,
		orphanCount: orphanFiles.length,
		orphanTotalSizeBytes,
	};
}
