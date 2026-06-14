import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs/promises
vi.mock(import("node:fs/promises"), async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	return {
		...actual,
		mkdir: vi.fn(() => Promise.resolve(undefined)),
		writeFile: vi.fn(() => Promise.resolve(undefined)),
		readFile: vi.fn(() => Promise.resolve(Buffer.from("test content"))),
	};
});

// Mock crypto
vi.mock(import("node:crypto"), async (importOriginal) => {
	const actual = await importOriginal<typeof import("crypto")>();
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

const mockDb = {
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
			const mockFile = {
				name: "report.pdf",
				size: 1024,
				type: "application/pdf",
				arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(1024))),
			} as unknown as File;

			// No existing artifact with same name
			mockDb.select.mockReturnValue({
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						limit: vi.fn(() => Promise.resolve([])),
					})),
				})),
			});

			mockDb.insert.mockReturnValue({
				values: vi.fn(() => ({
					returning: vi.fn(() =>
						Promise.resolve([
							{
								id: "artifact-uuid-123",
								userId: "user-1",
								conversationId: "conv-1",
								type: "source_document",
								name: "report.pdf",
								mimeType: "application/pdf",
								extension: "pdf",
								sizeBytes: 1024,
								binaryHash: "mock-hash-123",
								storagePath: "data/knowledge/user-1/artifact-uuid-123.pdf",
								contentText: null,
								summary: "report.pdf",
								metadataJson: JSON.stringify({ uploadSource: "chat" }),
								retrievalClass: "durable",
								createdAt: new Date("2024-01-01"),
								updatedAt: new Date("2024-01-01"),
							},
						]),
					),
				})),
			});

			const result = await saveUploadedArtifact({
				userId: "user-1",
				conversationId: "conv-1",
				file: mockFile,
			});

			expect(result.artifact.name).toBe("report.pdf");
			expect(result.renameInfo).toBeUndefined();
		});

		it("should auto-rename when filename conflict exists across all user artifacts", async () => {
			const mockFile = {
				name: "report.pdf",
				size: 1024,
				type: "application/pdf",
				arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(1024))),
			} as unknown as File;

			let callCount = 0;
			mockDb.select.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() => ({
								limit: vi.fn(() =>
									Promise.resolve([
										{
											id: "existing-artifact",
											userId: "user-1",
											name: "report.pdf",
											type: "source_document",
											binaryHash: "different-hash",
											createdAt: new Date("2024-01-01"),
											updatedAt: new Date("2024-01-01"),
										},
									]),
								),
							})),
						})),
					};
				}
				if (callCount === 2) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() =>
								Promise.resolve([
									{ name: "report.pdf" },
									{ name: "other.pdf" },
									{ name: "doc.pdf" },
								]),
							),
						})),
					};
				}
				return {
					from: vi.fn(() => ({
						where: vi.fn(() => ({
							limit: vi.fn(() =>
								Promise.resolve([
									{
										id: "existing-link",
										userId: "user-1",
										name: "report.pdf",
										type: "source_document",
										binaryHash: "different-hash",
										createdAt: new Date("2024-01-01"),
										updatedAt: new Date("2024-01-01"),
									},
								]),
							),
						})),
					})),
				};
			});

			mockDb.insert.mockReturnValue({
				values: vi.fn(() => ({
					returning: vi.fn(() =>
						Promise.resolve([
							{
								id: "artifact-uuid-123",
								userId: "user-1",
								conversationId: "conv-1",
								type: "source_document",
								name: "report_1.pdf",
								mimeType: "application/pdf",
								extension: "pdf",
								sizeBytes: 1024,
								binaryHash: "mock-hash-123",
								storagePath: "data/knowledge/user-1/artifact-uuid-123.pdf",
								contentText: null,
								summary: "report_1.pdf",
								metadataJson: JSON.stringify({
									uploadSource: "chat",
									originalName: "report.pdf",
									renamed: true,
								}),
								retrievalClass: "durable",
								createdAt: new Date("2024-01-01"),
								updatedAt: new Date("2024-01-01"),
							},
						]),
					),
				})),
			});

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
			const mockFile = {
				name: "report.pdf",
				size: 1024,
				type: "application/pdf",
				arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(1024))),
			} as unknown as File;

			let callCount = 0;
			mockDb.select.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() => ({
								limit: vi.fn(() =>
									Promise.resolve([
										{
											id: "existing-artifact",
											userId: "user-1",
											name: "report.pdf",
											type: "source_document",
											binaryHash: "different-hash",
											createdAt: new Date("2024-01-01"),
											updatedAt: new Date("2024-01-01"),
										},
									]),
								),
							})),
						})),
					};
				}
				if (callCount === 2) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() => ({
								limit: vi.fn(() =>
									Promise.resolve([
										{
											id: "existing-name-conflict",
											userId: "user-1",
											name: "report.pdf",
											type: "source_document",
											binaryHash: "different-hash",
											createdAt: new Date("2024-01-01"),
											updatedAt: new Date("2024-01-01"),
										},
									]),
								),
							})),
						})),
					};
				}
				if (callCount === 3) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() =>
								Promise.resolve([
									{ name: "report.pdf" },
									{ name: "report_1.pdf" },
									{ name: "report_2.pdf" },
								]),
							),
						})),
					};
				}
				return {
					from: vi.fn(() => ({
						where: vi.fn(() => ({
							limit: vi.fn(() =>
								Promise.resolve([
									{
										id: "existing-link",
										userId: "user-1",
										name: "report.pdf",
										type: "source_document",
										binaryHash: "different-hash",
										createdAt: new Date("2024-01-01"),
										updatedAt: new Date("2024-01-01"),
									},
								]),
							),
						})),
					})),
				};
			});

			const insertValues = vi.fn(() => ({
				returning: vi.fn(() =>
					Promise.resolve([
						{
							id: "artifact-uuid-123",
							userId: "user-1",
							conversationId: "conv-1",
							type: "source_document",
							name: "report_3.pdf",
							mimeType: "application/pdf",
							extension: "pdf",
							sizeBytes: 1024,
							binaryHash: "mock-hash-123",
							storagePath: "data/knowledge/user-1/artifact-uuid-123.pdf",
							contentText: null,
							summary: "report_3.pdf",
							metadataJson: JSON.stringify({
								uploadSource: "chat",
								originalName: "report.pdf",
								renamed: true,
							}),
							retrievalClass: "durable",
							createdAt: new Date("2024-01-01"),
							updatedAt: new Date("2024-01-01"),
						},
					]),
				),
			}));

			mockDb.insert.mockReturnValue({
				values: insertValues,
			});

			const result = await saveUploadedArtifact({
				userId: "user-1",
				conversationId: "conv-1",
				file: mockFile,
			});

			expect(result.artifact.name).toBe("report_3.pdf");
			expect(result.renameInfo?.wasRenamed).toBe(true);
			expect(result.renameInfo?.originalName).toBe("report.pdf");

			const insertedArtifact = insertValues.mock.calls[0]?.[0];
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
			const mockFile = {
				name: "document.docx",
				size: 2048,
				type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(2048))),
			} as unknown as File;

			let callCount = 0;
			mockDb.select.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() => ({
								limit: vi.fn(() =>
									Promise.resolve([
										{
											id: "existing",
											userId: "user-1",
											name: "document.docx",
											type: "source_document",
											binaryHash: "different",
											createdAt: new Date("2024-01-01"),
											updatedAt: new Date("2024-01-01"),
										},
									]),
								),
							})),
						})),
					};
				}
				if (callCount === 2) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() => Promise.resolve([{ name: "document.docx" }])),
						})),
					};
				}
				return {
					from: vi.fn(() => ({
						where: vi.fn(() => ({
							limit: vi.fn(() =>
								Promise.resolve([
									{
										id: "existing-link",
										userId: "user-1",
										name: "document.docx",
										type: "source_document",
										binaryHash: "different",
										createdAt: new Date("2024-01-01"),
										updatedAt: new Date("2024-01-01"),
									},
								]),
							),
						})),
					})),
				};
			});

			const insertMock = vi.fn(() =>
				Promise.resolve([
					{
						id: "artifact-uuid-123",
						userId: "user-1",
						conversationId: "conv-1",
						type: "source_document",
						name: "document_1.docx",
						mimeType:
							"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
						extension: "docx",
						sizeBytes: 2048,
						binaryHash: "mock-hash-123",
						storagePath: "data/knowledge/user-1/artifact-uuid-123.docx",
						contentText: null,
						summary: "document_1.docx",
						metadataJson: JSON.stringify({
							uploadSource: "chat",
							originalName: "document.docx",
							renamed: true,
						}),
						retrievalClass: "durable",
						createdAt: new Date("2024-01-01"),
						updatedAt: new Date("2024-01-01"),
					},
				]),
			);

			mockDb.insert.mockReturnValue({
				values: vi.fn(() => ({
					returning: insertMock,
				})),
			});

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
			const mockFile = {
				name: "report.pdf",
				size: 1024,
				type: "application/pdf",
				arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(1024))),
			} as unknown as File;

			let callCount = 0;
			mockDb.select.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() => ({
								limit: vi.fn(() =>
									Promise.resolve([
										{
											id: "existing-artifact",
											userId: "user-1",
											name: "report.pdf",
											type: "source_document",
											binaryHash: "different-hash",
											createdAt: new Date("2024-01-01"),
											updatedAt: new Date("2024-01-01"),
										},
									]),
								),
							})),
						})),
					};
				}
				if (callCount === 2) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() =>
								Promise.resolve([
									{ name: "report.pdf" },
									{ name: "other.pdf" },
								]),
							),
						})),
					};
				}
				return {
					from: vi.fn(() => ({
						where: vi.fn(() => ({
							limit: vi.fn(() =>
								Promise.resolve([
									{
										id: "existing-link",
										userId: "user-1",
										name: "README",
										type: "source_document",
										binaryHash: "different",
										createdAt: new Date("2024-01-01"),
										updatedAt: new Date("2024-01-01"),
									},
								]),
							),
						})),
					})),
				};
			});

			mockDb.insert.mockReturnValue({
				values: vi.fn(() => ({
					returning: vi.fn(() =>
						Promise.resolve([
							{
								id: "artifact-uuid-123",
								userId: "user-1",
								conversationId: "conv-1",
								type: "source_document",
								name: "report_1.pdf",
								mimeType: "application/pdf",
								extension: "pdf",
								sizeBytes: 1024,
								binaryHash: "mock-hash-123",
								storagePath: "data/knowledge/user-1/artifact-uuid-123.pdf",
								contentText: null,
								summary: "report_1.pdf",
								metadataJson: JSON.stringify({
									uploadSource: "chat",
									originalName: "report.pdf",
									renamed: true,
								}),
								retrievalClass: "durable",
								createdAt: new Date("2024-01-01"),
								updatedAt: new Date("2024-01-01"),
							},
						]),
					),
				})),
			});

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
			const mockFile = {
				name: "README",
				size: 1024,
				type: "text/plain",
				arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(1024))),
			} as unknown as File;

			let callCount = 0;
			mockDb.select.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() => ({
								limit: vi.fn(() =>
									Promise.resolve([
										{
											id: "existing",
											userId: "user-1",
											name: "README",
											type: "source_document",
											binaryHash: "different",
											createdAt: new Date("2024-01-01"),
											updatedAt: new Date("2024-01-01"),
										},
									]),
								),
							})),
						})),
					};
				}
				if (callCount === 2) {
					return {
						from: vi.fn(() => ({
							where: vi.fn(() => Promise.resolve([{ name: "README" }])),
						})),
					};
				}
				return {
					from: vi.fn(() => ({
						where: vi.fn(() => ({
							limit: vi.fn(() =>
								Promise.resolve([
									{
										id: "existing-link",
										userId: "user-1",
										name: "README",
										type: "source_document",
										binaryHash: "different",
										createdAt: new Date("2024-01-01"),
										updatedAt: new Date("2024-01-01"),
									},
								]),
							),
						})),
					})),
				};
			});

			mockDb.insert.mockReturnValue({
				values: vi.fn(() => ({
					returning: vi.fn(() =>
						Promise.resolve([
							{
								id: "artifact-uuid-123",
								userId: "user-1",
								conversationId: "conv-1",
								type: "source_document",
								name: "README_1",
								mimeType: "text/plain",
								extension: null,
								sizeBytes: 1024,
								binaryHash: "mock-hash-123",
								storagePath: "data/knowledge/user-1/artifact-uuid-123",
								contentText: null,
								summary: "README_1",
								metadataJson: JSON.stringify({
									uploadSource: "chat",
									originalName: "README",
									renamed: true,
								}),
								retrievalClass: "durable",
								createdAt: new Date("2024-01-01"),
								updatedAt: new Date("2024-01-01"),
							},
						]),
					),
				})),
			});

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
