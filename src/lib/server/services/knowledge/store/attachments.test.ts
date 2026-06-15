import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	makeArtifactRow,
	makeFileFixture,
	makeInsertChain,
	makeSelectLimitResult,
	makeSelectResult,
	queueMockResponses,
} from "./test-fixtures";

// Mock fs/promises
vi.mock("node:fs/promises", async () => {
	const actual =
		await vi.importActual<typeof import("node:fs/promises")>(
			"node:fs/promises",
		);
	return {
		...actual,
		mkdir: vi.fn(() => Promise.resolve(undefined)),
		writeFile: vi.fn(() => Promise.resolve(undefined)),
		readFile: vi.fn(() => Promise.resolve(Buffer.from("test content"))),
	};
});

// Mock crypto
vi.mock("node:crypto", async () => {
	const actual =
		await vi.importActual<typeof import("node:crypto")>("node:crypto");
	return {
		...actual,
		createHash: vi.fn(() => ({
			update: vi.fn(() => ({
				digest: vi.fn(() => "mock-hash-123"),
			})),
		})),
		randomUUID: vi.fn(() => "artifact-uuid-123"),
	};
});

// Mock task-state
vi.mock("../../task-state", () => ({
	syncArtifactChunks: vi.fn(() => Promise.resolve()),
}));

type MockDb = {
	insert: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	transaction: ReturnType<typeof vi.fn>;
};

const mockDb: MockDb = {
	insert: vi.fn(() => ({
		values: vi.fn(() => ({
			returning: vi.fn(),
		})),
	})),
	select: vi.fn(() => ({
		from: vi.fn(() => ({
			where: vi.fn(() => ({
				orderBy: vi.fn(() => ({
					limit: vi.fn(),
				})),
				innerJoin: vi.fn(() => ({
					where: vi.fn(() => ({
						orderBy: vi.fn(() => ({
							limit: vi.fn(),
						})),
					})),
				})),
			})),
		})),
	})),
	update: vi.fn(() => ({
		set: vi.fn(() => ({
			where: vi.fn(() => ({
				returning: vi.fn(),
			})),
		})),
	})),
	delete: vi.fn(() => ({
		where: vi.fn(() => Promise.resolve({ changes: 0 })),
	})),
	transaction: vi.fn((fn) =>
		fn({
			delete: vi.fn(() => ({
				where: vi.fn(() => ({
					run: vi.fn(),
				})),
			})),
		}),
	),
};

vi.mock("../../../db", () => ({
	db: mockDb,
}));

const { saveUploadedArtifact } = await import("./attachments");

describe("Attachments - Auto-Rename on Conflict", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("saveUploadedArtifact", () => {
		it("should not rename when no conflict exists", async () => {
			const mockFile = makeFileFixture("report.pdf", "application/pdf", 1024);

			mockDb.select.mockReturnValue(makeSelectLimitResult([]));

			mockDb.insert.mockReturnValue(
				makeInsertChain([
					makeArtifactRow({
						id: "artifact-uuid-123",
						userId: "user-1",
						conversationId: "conv-1",
						name: "report.pdf",
						mimeType: "application/pdf",
						extension: "pdf",
						sizeBytes: 1024,
						binaryHash: "mock-hash-123",
						storagePath: "data/knowledge/user-1/artifact-uuid-123.pdf",
						summary: "report.pdf",
						metadataJson: JSON.stringify({ uploadSource: "chat" }),
						retrievalClass: "durable",
					}),
				]),
			);

			const result = await saveUploadedArtifact({
				userId: "user-1",
				conversationId: "conv-1",
				file: mockFile,
			});

			expect(result.artifact.name).toBe("report.pdf");
			expect(result.renameInfo).toBeUndefined();
		});

		it("should auto-rename when filename conflict exists across all user artifacts", async () => {
			const mockFile = makeFileFixture("report.pdf", "application/pdf", 1024);

			queueMockResponses(mockDb.select, [
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-artifact",
						userId: "user-1",
						name: "report.pdf",
						type: "source_document",
						binaryHash: "different-hash",
					}),
				]),
				makeSelectResult([
					{ name: "report.pdf" },
					{ name: "other.pdf" },
					{ name: "doc.pdf" },
				]),
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-link",
						userId: "user-1",
						name: "report.pdf",
						type: "source_document",
						binaryHash: "different-hash",
					}),
				]),
			]);

			mockDb.insert.mockReturnValue(
				makeInsertChain([
					makeArtifactRow({
						id: "artifact-uuid-123",
						userId: "user-1",
						conversationId: "conv-1",
						name: "report_1.pdf",
						mimeType: "application/pdf",
						extension: "pdf",
						sizeBytes: 1024,
						binaryHash: "mock-hash-123",
						storagePath: "data/knowledge/user-1/artifact-uuid-123.pdf",
						summary: "report_1.pdf",
						metadataJson: JSON.stringify({
							uploadSource: "chat",
							originalName: "report.pdf",
							renamed: true,
						}),
						retrievalClass: "durable",
					}),
				]),
			);

			const result = await saveUploadedArtifact({
				userId: "user-1",
				conversationId: "conv-1",
				file: mockFile,
			});

			expect(result.artifact.name).toBe("report_1.pdf");
			expect(result.renameInfo).toBeDefined();
			expect(result.renameInfo?.wasRenamed).toBe(true);
			expect(result.renameInfo?.originalName).toBe("report.pdf");
			expect(mockDb.update).not.toHaveBeenCalled();
		});

		it("should increment counter for multiple duplicates", async () => {
			const mockFile = makeFileFixture("report.pdf", "application/pdf", 1024);

			queueMockResponses(mockDb.select, [
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-artifact",
						userId: "user-1",
						name: "report.pdf",
						type: "source_document",
						binaryHash: "different-hash",
					}),
				]),
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-name-conflict",
						userId: "user-1",
						name: "report.pdf",
						type: "source_document",
						binaryHash: "different-hash",
					}),
				]),
				makeSelectResult([
					{ name: "report.pdf" },
					{ name: "report_1.pdf" },
					{ name: "report_2.pdf" },
				]),
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-link",
						userId: "user-1",
						name: "report.pdf",
						type: "source_document",
						binaryHash: "different-hash",
					}),
				]),
			]);

			const insertChain = makeInsertChain([
				makeArtifactRow({
					id: "artifact-uuid-123",
					userId: "user-1",
					conversationId: "conv-1",
					name: "report_3.pdf",
					mimeType: "application/pdf",
					extension: "pdf",
					sizeBytes: 1024,
					binaryHash: "mock-hash-123",
					storagePath: "data/knowledge/user-1/artifact-uuid-123.pdf",
					summary: "report_3.pdf",
					metadataJson: JSON.stringify({
						uploadSource: "chat",
						originalName: "report.pdf",
						renamed: true,
					}),
					retrievalClass: "durable",
				}),
			]);

			mockDb.insert.mockReturnValue(insertChain);

			const result = await saveUploadedArtifact({
				userId: "user-1",
				conversationId: "conv-1",
				file: mockFile,
			});

			expect(result.artifact.name).toBe("report_3.pdf");
			expect(result.renameInfo?.wasRenamed).toBe(true);
			expect(result.renameInfo?.originalName).toBe("report.pdf");

			const firstInsertCall = insertChain.values.mock.calls[0];
			if (!firstInsertCall) throw new Error("Expected artifact insert call");
			const insertedArtifact = firstInsertCall[0];
			expect(insertedArtifact).toMatchObject({
				name: "report_3.pdf",
				summary: "report_3.pdf",
			});
			expect(JSON.parse(insertedArtifact.metadataJson)).toMatchObject({
				originalName: "report.pdf",
				renamed: true,
			});
		});

		it("should store original name in metadata when renamed", async () => {
			const mockFile = makeFileFixture(
				"document.docx",
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				2048,
			);

			queueMockResponses(mockDb.select, [
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing",
						userId: "user-1",
						name: "document.docx",
						type: "source_document",
						binaryHash: "different",
					}),
				]),
				makeSelectResult([{ name: "document.docx" }]),
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-link",
						userId: "user-1",
						name: "document.docx",
						type: "source_document",
						binaryHash: "different",
					}),
				]),
			]);

			mockDb.insert.mockReturnValue(
				makeInsertChain([
					makeArtifactRow({
						id: "artifact-uuid-123",
						userId: "user-1",
						conversationId: "conv-1",
						name: "document_1.docx",
						mimeType:
							"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
						extension: "docx",
						sizeBytes: 2048,
						binaryHash: "mock-hash-123",
						storagePath: "data/knowledge/user-1/artifact-uuid-123.docx",
						summary: "document_1.docx",
						metadataJson: JSON.stringify({
							uploadSource: "chat",
							originalName: "document.docx",
							renamed: true,
						}),
						retrievalClass: "durable",
					}),
				]),
			);

			const result = await saveUploadedArtifact({
				userId: "user-1",
				conversationId: "conv-1",
				file: mockFile,
			});

			expect(result.artifact.metadata).toEqual({
				uploadSource: "chat",
				originalName: "document.docx",
				renamed: true,
			});
		});

		it("should auto-rename for conversation-scoped uploads when conflict exists across user artifacts", async () => {
			const mockFile = makeFileFixture("report.pdf", "application/pdf", 1024);

			queueMockResponses(mockDb.select, [
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-artifact",
						userId: "user-1",
						name: "report.pdf",
						type: "source_document",
						binaryHash: "different-hash",
					}),
				]),
				makeSelectResult([{ name: "report.pdf" }, { name: "other.pdf" }]),
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-link",
						userId: "user-1",
						name: "README",
						type: "source_document",
						binaryHash: "different",
					}),
				]),
			]);

			mockDb.insert.mockReturnValue(
				makeInsertChain([
					makeArtifactRow({
						id: "artifact-uuid-123",
						userId: "user-1",
						conversationId: "conv-1",
						name: "report_1.pdf",
						mimeType: "application/pdf",
						extension: "pdf",
						sizeBytes: 1024,
						binaryHash: "mock-hash-123",
						storagePath: "data/knowledge/user-1/artifact-uuid-123.pdf",
						summary: "report_1.pdf",
						metadataJson: JSON.stringify({
							uploadSource: "chat",
							originalName: "report.pdf",
							renamed: true,
						}),
						retrievalClass: "durable",
					}),
				]),
			);

			const result = await saveUploadedArtifact({
				userId: "user-1",
				conversationId: "conv-1",
				file: mockFile,
			});

			expect(result.artifact.name).toBe("report_1.pdf");
			expect(result.renameInfo?.wasRenamed).toBe(true);
			expect(result.renameInfo?.originalName).toBe("report.pdf");
		});

		it("should handle files without extension", async () => {
			const mockFile = makeFileFixture("README", "text/plain", 1024);

			queueMockResponses(mockDb.select, [
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing",
						userId: "user-1",
						name: "README",
						type: "source_document",
						binaryHash: "different",
					}),
				]),
				makeSelectResult([{ name: "README" }]),
				makeSelectLimitResult([
					makeArtifactRow({
						id: "existing-link",
						userId: "user-1",
						name: "README",
						type: "source_document",
						binaryHash: "different",
					}),
				]),
			]);

			mockDb.insert.mockReturnValue(
				makeInsertChain([
					makeArtifactRow({
						id: "artifact-uuid-123",
						userId: "user-1",
						conversationId: "conv-1",
						name: "README_1",
						mimeType: "text/plain",
						extension: null,
						sizeBytes: 1024,
						binaryHash: "mock-hash-123",
						storagePath: "data/knowledge/user-1/artifact-uuid-123",
						summary: "README_1",
						metadataJson: JSON.stringify({
							uploadSource: "chat",
							originalName: "README",
							renamed: true,
						}),
						retrievalClass: "durable",
					}),
				]),
			);

			const result = await saveUploadedArtifact({
				userId: "user-1",
				conversationId: "conv-1",
				file: mockFile,
			});

			expect(result.artifact.name).toBe("README_1");
			expect(result.renameInfo?.wasRenamed).toBe(true);
			expect(result.renameInfo?.originalName).toBe("README");
		});
	});
});
