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

	// ── parse bundles and upload staging ───────────────────────────────────
	//
	// `data/knowledge/` is not flat any more. A MinerU parse bundle is a
	// directory of JSON and images beside the artifact's own bytes, and the
	// upload path stages incoming files under `.incoming/`. Neither is an
	// artifact, so neither may be matched against `storage_path` file by file
	// — the bundle alone would add one orphan row per image and per JSON and
	// drown the report it is supposed to be read from.

	describe("parse bundles", () => {
		async function writeBundle(artifactRelPath: string, suffix = ".parse") {
			const dir = `knowledge/${artifactRelPath}${suffix}`;
			await writeTestFile(tempDir, `${dir}/manifest.json`, '{"version":1}');
			await writeTestFile(tempDir, `${dir}/normalized.md`, "# doc");
			await writeTestFile(tempDir, `${dir}/pages.json`, "[]");
			await writeTestFile(tempDir, `${dir}/structured_content.json`, "{}");
			await writeTestFile(tempDir, `${dir}/images/page_1_x.jpg`, "IMG");
		}

		it("does not report a bundle whose source artifact still exists", async () => {
			mockArtifactStoragePaths.push("data/knowledge/user-1/doc.pdf");
			await writeTestFile(tempDir, "knowledge/user-1/doc.pdf", "PDF");
			await writeBundle("user-1/doc");

			const report = await findOrphanFiles({ dataDir: tempDir });

			expect(report.orphanFiles).toEqual([]);
			// Its bytes still count towards what is on disk.
			expect(report.totalFileCount).toBe(6);
			expect(report.totalSizeBytes).toBeGreaterThan("PDF".length);
		});

		it("reports a bundle whose source artifact is gone, as ONE entry", async () => {
			mockArtifactStoragePaths.push("data/knowledge/user-1/kept.pdf");
			await writeTestFile(tempDir, "knowledge/user-1/kept.pdf", "PDF");
			await writeBundle("user-1/deleted");

			const report = await findOrphanFiles({ dataDir: tempDir });

			expect(report.orphanFiles).toEqual([
				{
					path: "user-1/deleted.parse",
					sizeBytes: '{"version":1}'.length + "# doc".length + 2 + 2 + 3,
					category: "knowledge",
					kind: "bundle",
				},
			]);
		});

		it("never reports a half-written bundle", async () => {
			// `<id>.parse.tmp-<pid>-<rand>` is either in flight right now or the
			// debris of a crash; the next write removes it either way. Note the
			// shape: a plain `endsWith(".parse.tmp")` would match none of these.
			await writeBundle("user-1/doc", ".parse.tmp-4242-ab12cd");
			await writeBundle("user-1/other", ".parse.tmp");

			const report = await findOrphanFiles({ dataDir: tempDir });

			expect(report.orphanFiles).toEqual([]);
			expect(report.totalFileCount).toBe(10);
		});

		it("does not report upload staging files", async () => {
			// A pre-existing false positive: `.incoming` was reported on every
			// run before parse bundles existed.
			await writeTestFile(tempDir, "knowledge/user-1/.incoming/part-1", "x");

			const report = await findOrphanFiles({ dataDir: tempDir });

			expect(report.orphanFiles).toEqual([]);
			expect(report.totalFileCount).toBe(1);
			expect(report.totalSizeBytes).toBe(1);
		});

		it("still reports a genuine stray file beside a bundle", async () => {
			mockArtifactStoragePaths.push("data/knowledge/user-1/doc.pdf");
			await writeTestFile(tempDir, "knowledge/user-1/doc.pdf", "PDF");
			await writeBundle("user-1/doc");
			await writeTestFile(tempDir, "knowledge/user-1/stray.bin", "STRAY");

			const report = await findOrphanFiles({ dataDir: tempDir });

			expect(report.orphanFiles).toEqual([
				{
					path: "user-1/stray.bin",
					sizeBytes: "STRAY".length,
					category: "knowledge",
				},
			]);
		});

		it("scopes the liveness check to the owning user", async () => {
			// `user-2` owns an artifact with the same id; `user-1`'s bundle is
			// still an orphan.
			mockArtifactStoragePaths.push("data/knowledge/user-2/doc.pdf");
			await writeTestFile(tempDir, "knowledge/user-2/doc.pdf", "PDF");
			await writeBundle("user-1/doc");

			const report = await findOrphanFiles({ dataDir: tempDir });

			expect(report.orphanFiles.map((f) => f.path)).toEqual([
				"user-1/doc.parse",
			]);
		});

		it("does not apply the knowledge ignore rules to chat-files", async () => {
			await writeTestFile(tempDir, "chat-files/conv/x.parse/inner.bin", "Z");

			const report = await findOrphanFiles({ dataDir: tempDir });

			expect(report.orphanFiles.map((f) => f.path)).toEqual([
				"conv/x.parse/inner.bin",
			]);
		});
	});
});
