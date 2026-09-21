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

const {
	buildArtifactNamePrefixPattern,
	NOT_PREPARED_READINESS_ERROR,
	saveUploadedArtifact,
	saveUploadedArtifactFromStoredFile,
} = await import("./attachments");

/**
 * `getNormalizedArtifactForSource`'s query shape:
 * `select().from(links).innerJoin(artifacts).where().orderBy().limit()`.
 */
function makeNormalizedLookupResult(rows: Array<{ artifact: unknown }>) {
	return {
		from: vi.fn(() => ({
			innerJoin: vi.fn(() => ({
				where: vi.fn(() => ({
					orderBy: vi.fn(() => ({
						limit: vi.fn(() => Promise.resolve(rows)),
					})),
				})),
			})),
		})),
	};
}

/**
 * The `node:crypto` mock above only covers this test file's own imports — the
 * store still hashes for real — so a dedupe fixture has to carry the hash the
 * store will actually compute for the fixture file's bytes.
 */
const { createHash: realCreateHash } =
	await vi.importActual<typeof import("node:crypto")>("node:crypto");

function realHashOfFixtureBytes(size: number): string {
	return realCreateHash("sha256")
		.update(Buffer.from(new ArrayBuffer(size)))
		.digest("hex");
}

/**
 * Walks a drizzle condition tree and collects every string it carries, so a
 * test can assert on the LIKE pattern a query was built with without depending
 * on drizzle's internal class names.
 */
function collectConditionStrings(node: unknown, depth = 0): string[] {
	if (depth > 8 || node === null || node === undefined) return [];
	if (typeof node === "string") return [node];
	if (Array.isArray(node)) {
		return node.flatMap((entry) => collectConditionStrings(entry, depth + 1));
	}
	if (typeof node === "object") {
		return Object.values(node as Record<string, unknown>).flatMap((entry) =>
			collectConditionStrings(entry, depth + 1),
		);
	}
	return [];
}

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
			const insertedArtifact = firstInsertCall[0] as {
				name: string;
				summary: string | null;
				metadataJson: string;
			};
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

// Bug B1, live-confirmed on the dev box: re-uploading identical bytes returned
// the same source artifact but `normalizedArtifact: null`, so intake extracted
// the file again and minted a SECOND normalized_document for it. Both dedupe
// branches now hand back the text that was already extracted.
describe("Attachments - dedupe returns the existing normalized artifact (B1)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const dedupedHash = realHashOfFixtureBytes(1024);
	const existingSource = makeArtifactRow({
		id: "existing-artifact",
		userId: "user-1",
		name: "report.pdf",
		type: "source_document",
		// Same bytes as the fixture file, so the dedupe branch is taken.
		binaryHash: dedupedHash,
		retrievalClass: "durable",
		storagePath: "data/knowledge/user-1/existing-artifact.pdf",
	});
	const existingNormalized = makeArtifactRow({
		id: "existing-normalized",
		userId: "user-1",
		name: "report.txt",
		type: "normalized_document",
		contentText: "already extracted text",
	});

	it("returns it for a browser File re-upload", async () => {
		queueMockResponses(mockDb.select, [
			makeSelectLimitResult([existingSource]),
			makeNormalizedLookupResult([{ artifact: existingNormalized }]),
		]);

		const result = await saveUploadedArtifact({
			userId: "user-1",
			// No conversation: the link write is a separate concern from dedupe.
			conversationId: null,
			file: makeFileFixture("report.pdf", "application/pdf", 1024),
		});

		expect(result.reusedExistingArtifact).toBe(true);
		expect(result.artifact.id).toBe("existing-artifact");
		expect(result.normalizedArtifact?.id).toBe("existing-normalized");
		expect(result.normalizedArtifact?.contentText).toBe(
			"already extracted text",
		);
		// Nothing new was written: no second artifact, no second normalization.
		expect(mockDb.insert).not.toHaveBeenCalled();
	});

	it("returns it for the stored-file (raw/chunk) re-upload path", async () => {
		queueMockResponses(mockDb.select, [
			makeSelectLimitResult([existingSource]),
			makeNormalizedLookupResult([{ artifact: existingNormalized }]),
		]);

		const result = await saveUploadedArtifactFromStoredFile({
			userId: "user-1",
			conversationId: null,
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1024,
			binaryHash: dedupedHash,
			tempPathAbsolute: "/tmp/does-not-exist.upload",
		});

		expect(result.reusedExistingArtifact).toBe(true);
		expect(result.artifact.id).toBe("existing-artifact");
		expect(result.normalizedArtifact?.id).toBe("existing-normalized");
		expect(mockDb.insert).not.toHaveBeenCalled();
	});

	it("still returns null when the deduped artifact was never extracted", async () => {
		queueMockResponses(mockDb.select, [
			makeSelectLimitResult([existingSource]),
			makeNormalizedLookupResult([]),
		]);

		const result = await saveUploadedArtifact({
			userId: "user-1",
			conversationId: null,
			file: makeFileFixture("report.pdf", "application/pdf", 1024),
		});

		expect(result.reusedExistingArtifact).toBe(true);
		expect(result.normalizedArtifact).toBeNull();
	});
});

// Bug B4: the collision path used to read EVERY artifact name the user owns.
describe("Attachments - auto-rename asks for a name prefix, not the table (B4)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("queries only the names that could collide, and picks the first free suffix", async () => {
		const whereArgs: unknown[] = [];
		const recordingPrefixQuery = {
			from: vi.fn(() => ({
				where: vi.fn(async (condition: unknown) => {
					whereArgs.push(condition);
					return [{ name: "report.pdf" }, { name: "report_1.pdf" }];
				}),
			})),
		};

		queueMockResponses(mockDb.select, [
			// 1. binary-hash lookup: a different hash, so no dedupe.
			makeSelectLimitResult([
				makeArtifactRow({ id: "other", binaryHash: "different-hash" }),
			]),
			// 2. exact-name lookup: a collision.
			makeSelectLimitResult([
				makeArtifactRow({ id: "same-name", name: "report.pdf" }),
			]),
			// 3. the prefix query under test.
			recordingPrefixQuery,
		]);

		const insertChain = makeInsertChain([
			makeArtifactRow({ id: "artifact-uuid-123", name: "report_2.pdf" }),
		]);
		mockDb.insert.mockReturnValue(insertChain);

		await saveUploadedArtifact({
			userId: "user-1",
			conversationId: null,
			file: makeFileFixture("report.pdf", "application/pdf", 1024),
		});

		expect(whereArgs).toHaveLength(1);
		expect(collectConditionStrings(whereArgs[0])).toContain("report%.pdf");

		const insertedName = (
			insertChain.values.mock.calls[0]?.[0] as { name: string }
		).name;
		expect(insertedName).toBe("report_2.pdf");
	});

	it("escapes the characters LIKE would otherwise treat as wildcards", () => {
		// A real file name with an underscore must not match every name with any
		// character in that position.
		expect(buildArtifactNamePrefixPattern("q1_report.pdf")).toBe(
			"q1\\_report%.pdf",
		);
		expect(buildArtifactNamePrefixPattern("50%_of_it.txt")).toBe(
			"50\\%\\_of\\_it%.txt",
		);
		expect(buildArtifactNamePrefixPattern("back\\slash.md")).toBe(
			"back\\\\slash%.md",
		);
		// No extension: the pattern is just the escaped base plus the wildcard.
		expect(buildArtifactNamePrefixPattern("README")).toBe("README%");
	});
});

describe("prompt-attachment readiness error", () => {
	// Spec row 41 (slice E). The format list now comes from the registry, so
	// this is the byte-identity guard: the sentence a user sees must not have
	// moved when the literal was replaced by a derivation.
	//
	// Frozen copy. DELIBERATELY RE-FROZEN: the old copy promised HEIC/HEIF
	// "when server conversion support is installed", and no such server
	// conversion exists — .heic/.heif go straight to MinerU. It also left out
	// OpenDocument, EPUB and RTF, which the registry does admit.
	const FROZEN_NOT_PREPARED =
		"This file could not be prepared for chat. Supported extraction currently works best for text, HTML, JSON, PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF, and common image formats.";

	it("renders byte-identically to its frozen copy", () => {
		expect(NOT_PREPARED_READINESS_ERROR).toBe(FROZEN_NOT_PREPARED);
	});

	it("does not promise a HEIC conversion the server cannot do", () => {
		expect(NOT_PREPARED_READINESS_ERROR).not.toContain("HEIC");
		expect(NOT_PREPARED_READINESS_ERROR).not.toContain("conversion");
	});

	it("owns the sentence, including the full stop", () => {
		// `getSupportedExtractionSummary` returns the list without terminal
		// punctuation (slice A outcome, spec section 10).
		expect(NOT_PREPARED_READINESS_ERROR.endsWith(".")).toBe(true);
		expect(NOT_PREPARED_READINESS_ERROR).not.toContain("..");
	});
});
