import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockArtifactStoragePaths, mockChatFileStoragePaths, resetMockState } =
	vi.hoisted(() => {
		const mockArtifactStoragePaths: (string | null)[] = [];
		const mockChatFileStoragePaths: string[] = [];

		function resetMockState() {
			mockArtifactStoragePaths.length = 0;
			mockChatFileStoragePaths.length = 0;
		}

		return {
			mockArtifactStoragePaths,
			mockChatFileStoragePaths,
			resetMockState,
		};
	});

vi.mock("$lib/server/db/schema", () => ({
	artifacts: {
		__table: "artifacts",
		storagePath: { name: "storage_path" },
	},
	chatGeneratedFiles: {
		__table: "chat_generated_files",
		storagePath: { name: "storage_path" },
	},
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn((table: unknown) => {
				const tableName = (table as Record<string, unknown>).__table as
					| string
					| undefined;

				function rowsForTable() {
					if (tableName === "artifacts") {
						return mockArtifactStoragePaths
							.filter((p): p is string => p !== null)
							.map((p) => ({ storagePath: p }));
					}
					if (tableName === "chat_generated_files") {
						return mockChatFileStoragePaths.map((p) => ({ storagePath: p }));
					}
					return [];
				}

				const rows = rowsForTable();
				return Object.assign(Promise.resolve(rows), {
					where: vi.fn(() => Promise.resolve(rows)),
				});
			}),
		})),
	},
}));

import { findOrphanFiles } from "./disk-reconciliation";

async function createTempDataDir(): Promise<string> {
	const root = join(tmpdir(), `disk-recon-test-${randomUUID()}`);
	await mkdir(root, { recursive: true });
	return root;
}

async function writeTestFile(
	baseDir: string,
	relPath: string,
	content = "test",
): Promise<string> {
	const fullPath = join(baseDir, relPath);
	await mkdir(join(fullPath, ".."), { recursive: true });
	await writeFile(fullPath, content);
	return relPath;
}

describe("findOrphanFiles", () => {
	let tempDir: string;

	beforeEach(async () => {
		resetMockState();
		tempDir = await createTempDataDir();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	it("returns empty report when no files exist on disk", async () => {
		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(0);
		expect(report.totalSizeBytes).toBe(0);
		expect(report.orphanFiles).toEqual([]);
		expect(report.orphanCount).toBe(0);
		expect(report.orphanTotalSizeBytes).toBe(0);
	});

	it("reports all knowledge files as orphans when DB has no artifact paths", async () => {
		await writeTestFile(tempDir, "knowledge/user-1/file.pdf", "content");
		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(1);
		expect(report.totalSizeBytes).toBe("content".length);
		expect(report.orphanCount).toBe(1);
		expect(report.orphanTotalSizeBytes).toBe("content".length);
		expect(report.orphanFiles).toHaveLength(1);
		expect(report.orphanFiles[0]).toMatchObject({
			path: "user-1/file.pdf",
			category: "knowledge",
			sizeBytes: "content".length,
		});
	});

	it("reports all chat-files as orphans when DB has no chat file paths", async () => {
		await writeTestFile(tempDir, "chat-files/conv-123/uuid-file.txt", "hello");
		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(1);
		expect(report.orphanCount).toBe(1);
		expect(report.orphanFiles[0]).toMatchObject({
			path: "conv-123/uuid-file.txt",
			category: "chat-files",
			sizeBytes: "hello".length,
		});
	});

	it("excludes known knowledge files from orphans", async () => {
		mockArtifactStoragePaths.push("data/knowledge/user-1/file.pdf");

		await writeTestFile(tempDir, "knowledge/user-1/file.pdf", "matched");
		await writeTestFile(tempDir, "knowledge/user-1/orphan.txt", "orphan");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(2);
		expect(report.orphanCount).toBe(1);
		expect(report.orphanFiles[0].path).toBe("user-1/orphan.txt");
		expect(report.orphanFiles[0].category).toBe("knowledge");
	});

	it("excludes known chat-files from orphans", async () => {
		mockChatFileStoragePaths.push("conv-123/file.pdf");

		await writeTestFile(tempDir, "chat-files/conv-123/file.pdf", "known");
		await writeTestFile(tempDir, "chat-files/conv-456/orphan.txt", "orphan");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(2);
		expect(report.orphanCount).toBe(1);
		expect(report.orphanFiles[0].path).toBe("conv-456/orphan.txt");
		expect(report.orphanFiles[0].category).toBe("chat-files");
	});

	it("handles mixed knowledge and chat-file orphans", async () => {
		mockArtifactStoragePaths.push("data/knowledge/user-1/good.pdf");
		mockChatFileStoragePaths.push("conv-g/known.txt");

		await writeTestFile(tempDir, "knowledge/user-1/good.pdf", "k1");
		await writeTestFile(tempDir, "knowledge/user-1/bad.pdf", "o1");
		await writeTestFile(tempDir, "chat-files/conv-g/known.txt", "k2");
		await writeTestFile(tempDir, "chat-files/conv-b/bad.txt", "o2");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(4);
		expect(report.orphanCount).toBe(2);
		const orphanPaths = report.orphanFiles.map((f) => f.path).sort();
		expect(orphanPaths).toEqual(["conv-b/bad.txt", "user-1/bad.pdf"]);
	});

	it("handles nested knowledge directories", async () => {
		mockArtifactStoragePaths.push("data/knowledge/user-1/nested/deep/file.txt");
		await writeTestFile(
			tempDir,
			"knowledge/user-1/nested/deep/file.txt",
			"deep",
		);
		await writeTestFile(
			tempDir,
			"knowledge/user-1/nested/orphan.txt",
			"orphan",
		);

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(2);
		expect(report.orphanCount).toBe(1);
		expect(report.orphanFiles[0].path).toBe("user-1/nested/orphan.txt");
	});

	it("tolerates missing knowledge directory", async () => {
		mockChatFileStoragePaths.push("conv/known.txt");
		await writeTestFile(tempDir, "chat-files/conv/known.txt", "ok");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(1);
		expect(report.orphanCount).toBe(0);
	});

	it("tolerates missing chat-files directory", async () => {
		mockArtifactStoragePaths.push("data/knowledge/user-1/file.pdf");
		await writeTestFile(tempDir, "knowledge/user-1/file.pdf", "ok");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(1);
		expect(report.orphanCount).toBe(0);
	});

	it("normalizes knowledge DB paths with forward slashes", async () => {
		mockArtifactStoragePaths.push("data/knowledge/user-1/doc.pdf");
		await writeTestFile(tempDir, "knowledge/user-1/doc.pdf", "ok");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.orphanCount).toBe(0);
	});

	it("handles null storagePath in artifacts table", async () => {
		mockArtifactStoragePaths.push(null);
		mockArtifactStoragePaths.push("data/knowledge/user-1/file.pdf");

		await writeTestFile(tempDir, "knowledge/user-1/file.pdf", "ok");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.orphanCount).toBe(0);
	});

	it("accumulates total sizes correctly", async () => {
		mockArtifactStoragePaths.push("data/knowledge/user-1/a.pdf");
		await writeTestFile(tempDir, "knowledge/user-1/a.pdf", "AAAAA");
		await writeTestFile(tempDir, "knowledge/user-1/b.txt", "BBB");
		await writeTestFile(tempDir, "chat-files/c/x.bin", "CCCCCCCCCC");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.totalFileCount).toBe(3);
		expect(report.totalSizeBytes).toBe(5 + 3 + 10);
		expect(report.orphanCount).toBe(2);
		expect(report.orphanTotalSizeBytes).toBe(3 + 10);
	});

	it("sorts orphan files by path for deterministic output", async () => {
		await writeTestFile(tempDir, "knowledge/user-1/z.pdf", "z");
		await writeTestFile(tempDir, "knowledge/user-1/a.txt", "a");
		await writeTestFile(tempDir, "chat-files/conv/m.txt", "m");

		const report = await findOrphanFiles({ dataDir: tempDir });

		expect(report.orphanCount).toBe(3);
		const paths = report.orphanFiles.map((f) => f.path);
		expect(paths).toEqual([...paths].sort());
	});
});
