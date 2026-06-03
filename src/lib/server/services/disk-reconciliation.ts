import { readdir, stat } from 'fs/promises';
import { join, relative } from 'path';
import { isNotNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { artifacts, chatGeneratedFiles } from '$lib/server/db/schema';

export interface OrphanFile {
	path: string;
	sizeBytes: number;
	category: 'knowledge' | 'chat-files';
}

export interface OrphanReport {
	totalFileCount: number;
	totalSizeBytes: number;
	orphanFiles: OrphanFile[];
	orphanCount: number;
	orphanTotalSizeBytes: number;
}

async function walkDir(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				const subFiles = await walkDir(fullPath);
				files.push(...subFiles);
			} else if (entry.isFile()) {
				files.push(fullPath);
			}
		}
		return files;
	} catch {
		return [];
	}
}

function normalizeKnowledgeDbPath(dbPath: string): string | null {
	const markers = ['/knowledge/', '\\knowledge\\'];
	for (const marker of markers) {
		const idx = dbPath.indexOf(marker);
		if (idx !== -1) {
			return dbPath.slice(idx + marker.length);
		}
	}
	return null;
}

export async function findOrphanFiles(opts?: {
	dataDir?: string;
}): Promise<OrphanReport> {
	const dataDir = opts?.dataDir ?? join(process.cwd(), 'data');
	const knowledgeDir = join(dataDir, 'knowledge');
	const chatFilesDir = join(dataDir, 'chat-files');

	const knowledgeDiskFiles = await walkDir(knowledgeDir);
	const chatFilesDiskFiles = await walkDir(chatFilesDir);

	const artifactRows = await db
		.select({ storagePath: artifacts.storagePath })
		.from(artifacts)
		.where(isNotNull(artifacts.storagePath));

	const chatFileRows = await db
		.select({ storagePath: chatGeneratedFiles.storagePath })
		.from(chatGeneratedFiles);

	const knownKnowledgePaths = new Set<string>();
	for (const row of artifactRows) {
		const rel = normalizeKnowledgeDbPath(row.storagePath!);
		if (rel) knownKnowledgePaths.add(rel);
	}

	const knownChatFilePaths = new Set<string>();
	for (const row of chatFileRows) {
		knownChatFilePaths.add(row.storagePath);
	}

	const diskEntries: { relPath: string; absPath: string; category: 'knowledge' | 'chat-files' }[] = [];

	for (const absPath of knowledgeDiskFiles) {
		diskEntries.push({
			relPath: relative(knowledgeDir, absPath),
			absPath,
			category: 'knowledge',
		});
	}

	for (const absPath of chatFilesDiskFiles) {
		diskEntries.push({
			relPath: relative(chatFilesDir, absPath),
			absPath,
			category: 'chat-files',
		});
	}

	const orphanFiles: OrphanFile[] = [];
	let totalSizeBytes = 0;

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
			entry.category === 'knowledge'
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

	orphanFiles.sort((a, b) => a.path.localeCompare(b.path));

	const orphanTotalSizeBytes = orphanFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

	return {
		totalFileCount: diskEntries.length,
		totalSizeBytes,
		orphanFiles,
		orphanCount: orphanFiles.length,
		orphanTotalSizeBytes,
	};
}
