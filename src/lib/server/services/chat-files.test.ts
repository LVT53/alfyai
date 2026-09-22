import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileInput } from "./chat-files";

type ChatFileRow = {
	id: string;
	conversationId: string;
	assistantMessageId: string | null;
	userId: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	storagePath: string;
	createdAt: Date;
};

type ArtifactRow = {
	id: string;
	userId: string;
	type: string;
	retrievalClass: string;
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	summary: string | null;
	metadataJson: string | null;
	contentText: string | null;
	extension: string | null;
	storagePath: string | null;
	createdAt: Date;
	updatedAt: Date;
};

const {
	mockRows,
	mockArtifactRows,
	mockConversationIds,
	mockIncognitoConversationIds,
	mockDeleteWhere,
	mockUnlink,
	mockRm,
	mockMkdir,
	mockWriteFile,
	mockReadFile,
	mockAccess,
	mockCreateGeneratedOutputArtifact,
	mockCreateArtifactLink,
	mockStartGeneratedFileReadback,
	mockRecordMemoryEvent,
} = vi.hoisted(() => {
	const mockRows: ChatFileRow[] = [];
	const mockArtifactRows: ArtifactRow[] = [];
	const mockConversationIds = new Set<string>();
	const mockIncognitoConversationIds = new Set<string>();

	const mockDeleteWhere = vi.fn(
		async (conversationId: string, fileId?: string) => {
			const indicesToRemove: number[] = [];
			mockRows.forEach((row, index) => {
				if (
					row.conversationId === conversationId &&
					(!fileId || row.id === fileId)
				) {
					indicesToRemove.push(index);
				}
			});
			const removed = indicesToRemove.length;
			indicesToRemove.reverse().forEach((index) => {
				mockRows.splice(index, 1);
			});
			return removed;
		},
	);

	const mockUnlink = vi.fn(() => Promise.resolve(undefined));
	const mockRm = vi.fn(() => Promise.resolve(undefined));
	const mockMkdir = vi.fn(() => Promise.resolve(undefined));
	const mockWriteFile = vi.fn(() => Promise.resolve(undefined));
	const mockReadFile = vi.fn(() =>
		Promise.resolve(Buffer.from("test content")),
	);
	const mockAccess = vi.fn(() => Promise.resolve(undefined));
	const mockCreateGeneratedOutputArtifact = vi.fn(
		async (params: { content: string; nameOverride?: string }) => ({
			id: "artifact-1",
			userId: "user-1",
			conversationId: "conv-a",
			type: "generated_output",
			retrievalClass: "durable",
			name: params.nameOverride ?? "result",
			mimeType: "text/markdown",
			sizeBytes: params.content.length,
			storagePath: null,
			contentText: params.content,
			summary: "summary",
			metadata: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	const mockCreateArtifactLink = vi.fn(async () => undefined);
	const mockStartGeneratedFileReadback = vi.fn(async () => ({
		id: "extraction-job-1",
		status: "queued",
	}));
	const mockRecordMemoryEvent = vi.fn(async () => undefined);

	return {
		mockRows,
		mockArtifactRows,
		mockConversationIds,
		mockIncognitoConversationIds,
		mockDeleteWhere,
		mockUnlink,
		mockRm,
		mockMkdir,
		mockWriteFile,
		mockReadFile,
		mockAccess,
		mockCreateGeneratedOutputArtifact,
		mockCreateArtifactLink,
		mockStartGeneratedFileReadback,
		mockRecordMemoryEvent,
	};
});

vi.mock("node:fs/promises", () => ({
	default: {
		mkdir: mockMkdir,
		writeFile: mockWriteFile,
		readFile: mockReadFile,
		unlink: mockUnlink,
		rm: mockRm,
		access: mockAccess,
	},
	mkdir: mockMkdir,
	writeFile: mockWriteFile,
	readFile: mockReadFile,
	unlink: mockUnlink,
	rm: mockRm,
	access: mockAccess,
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn((table: { __table?: string }) => ({
				// A real promise carrying the builder methods, rather than a
				// plain object: `getArtifactOwnershipScope` awaits the `where`
				// itself — it wants every conversation of one user and neither
				// orders nor limits them — while everything else here still
				// chains `.orderBy()` or `.limit()` onto it first.
				where: vi.fn((condition: unknown) =>
					Object.assign(Promise.resolve(selectRowsForTable(table, condition)), {
						orderBy: vi.fn(() => {
							const rows = selectRowsForTable(table, condition);
							return Object.assign(rows, {
								limit: vi.fn(async (count: number) => rows.slice(0, count)),
							});
						}),
						limit: vi.fn(async () => {
							return selectRowsForTable(table, condition).slice(0, 1);
						}),
					}),
				),
			})),
		})),
		insert: vi.fn(() => ({
			values: vi.fn((values: ChatFileRow | ChatFileRow[]) => {
				const items = Array.isArray(values) ? values : [values];
				const now = new Date();
				const itemsWithDate = items.map((item) => ({
					...item,
					createdAt: item.createdAt || now,
				}));
				mockRows.push(...itemsWithDate);
				return {
					returning: vi.fn(() =>
						Promise.resolve(itemsWithDate.map((item) => ({ ...item }))),
					),
				};
			}),
		})),
		update: vi.fn(() => ({
			set: vi.fn((values: { assistantMessageId?: string | null }) => ({
				where: vi.fn((condition: unknown) => {
					const conversationId = extractConversationId(condition);
					const fileIds = extractFileIds(condition);
					mockRows.forEach((row) => {
						if (
							(!conversationId || row.conversationId === conversationId) &&
							(fileIds.length === 0 || fileIds.includes(row.id))
						) {
							row.assistantMessageId =
								typeof values.assistantMessageId === "string"
									? values.assistantMessageId
									: row.assistantMessageId;
						}
					});
					return Promise.resolve(undefined);
				}),
			})),
		})),
		delete: vi.fn(() => ({
			where: vi.fn((condition: unknown) => {
				const conds = Array.isArray(condition) ? condition : [condition];
				const idCondition = conds.find(
					(c: { field: string; value: unknown }) =>
						c.field === "id" && Array.isArray(c.value),
				);
				if (idCondition) {
					const idsToDelete = new Set(idCondition.value);
					let count = 0;
					for (let i = mockRows.length - 1; i >= 0; i--) {
						if (idsToDelete.has(mockRows[i].id)) {
							mockRows.splice(i, 1);
							count++;
						}
					}
					return Promise.resolve(count);
				}
				const conversationId = extractConversationId(condition);
				const fileId = extractFileId(condition);
				return Promise.resolve(mockDeleteWhere(conversationId, fileId));
			}),
		})),
	},
}));

function extractConversationId(condition: unknown): string {
	if (Array.isArray(condition)) {
		const convCondition = condition.find(
			(c: { field: string }) => c.field === "conversationId",
		);
		if (convCondition) return convCondition.value;
	}
	if (
		typeof condition === "object" &&
		condition !== null &&
		"field" in condition
	) {
		const c = condition as { field: string; value: string };
		if (c.field === "conversationId") return c.value;
	}
	if (typeof condition === "string") return condition;
	return "";
}

function extractFileId(condition: unknown): string | undefined {
	if (Array.isArray(condition)) {
		const idCondition = condition.find(
			(c: { field: string }) => c.field === "id",
		);
		if (idCondition) return idCondition.value;
	}
	return undefined;
}

function extractFileIds(condition: unknown): string[] {
	if (Array.isArray(condition)) {
		const idCondition = condition.find(
			(c: { field: string; value: string[] }) => c.field === "id",
		);
		if (idCondition && Array.isArray(idCondition.value))
			return idCondition.value;
	}
	return [];
}

function extractUserId(condition: unknown): string | undefined {
	if (Array.isArray(condition)) {
		const userCondition = condition.find(
			(c: { field: string }) => c.field === "userId",
		);
		if (userCondition) return userCondition.value;
	}
	if (
		typeof condition === "object" &&
		condition !== null &&
		"field" in condition
	) {
		const c = condition as { field: string; value: string };
		if (c.field === "userId") return c.value;
	}
	return undefined;
}

function extractAssistantMessageId(condition: unknown): string | undefined {
	if (Array.isArray(condition)) {
		const assistantCondition = condition.find(
			(c: { field: string; operator?: string }) =>
				c.field === "assistantMessageId" && c.operator !== "isNotNull",
		);
		if (assistantCondition) return assistantCondition.value;
	}
	if (
		typeof condition === "object" &&
		condition !== null &&
		"field" in condition
	) {
		const c = condition as { field: string; value: string; operator?: string };
		if (c.field === "assistantMessageId" && c.operator !== "isNotNull")
			return c.value;
	}
	return undefined;
}

function requiresAssistantMessage(condition: unknown): boolean {
	if (Array.isArray(condition)) {
		return condition.some(
			(c: { field: string; operator?: string }) =>
				c.field === "assistantMessageId" && c.operator === "isNotNull",
		);
	}
	if (
		typeof condition === "object" &&
		condition !== null &&
		"field" in condition
	) {
		const c = condition as { field: string; operator?: string };
		return c.field === "assistantMessageId" && c.operator === "isNotNull";
	}
	return false;
}

function extractArtifactType(condition: unknown): string | undefined {
	if (Array.isArray(condition)) {
		const typeCondition = condition.find(
			(c: { field: string }) => c.field === "type",
		);
		if (typeCondition) return typeCondition.value;
	}
	if (
		typeof condition === "object" &&
		condition !== null &&
		"field" in condition
	) {
		const c = condition as { field: string; value: string };
		if (c.field === "type") return c.value;
	}
	return undefined;
}

function selectRowsForTable(
	table: { __table?: string },
	condition: unknown,
): Array<ChatFileRow | ArtifactRow | { id: string }> {
	if (table.__table === "conversations") {
		// Every conversation a seeded row belongs to exists, as it does in the
		// database — the orphan-sweep tests are the ones that populate
		// `mockConversationIds` by hand, to say which ones survived.
		// `memoryIncognito` rides along because the ownership scope reads it to
		// decide which conversations an artifact may be held through.
		const ids = new Set(mockConversationIds);
		for (const row of mockRows) ids.add(row.conversationId);
		for (const row of mockArtifactRows) {
			if (row.conversationId) ids.add(row.conversationId);
		}
		return Array.from(ids).map((id) => ({
			id,
			memoryIncognito: mockIncognitoConversationIds.has(id),
		}));
	}

	if (
		typeof condition === "object" &&
		condition !== null &&
		(condition as { operator?: string }).operator === "notInSubquery"
	) {
		const cond = condition as {
			operator: string;
			conversationIdSet: Set<string>;
		};
		return mockRows
			.filter((row) => !cond.conversationIdSet.has(row.conversationId))
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.map((row) => ({ ...row }));
	}

	if (table.__table === "artifacts") {
		const conversationId = extractConversationId(condition);
		const artifactId = extractFileId(condition);
		const userId = extractUserId(condition);
		const type = extractArtifactType(condition);
		return mockArtifactRows
			.filter(
				(row) =>
					(!conversationId || row.conversationId === conversationId) &&
					(!artifactId || row.id === artifactId) &&
					(!userId || row.userId === userId) &&
					(!type || row.type === type),
			)
			.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
			.map((row) => ({ ...row }));
	}

	const conversationId = extractConversationId(condition);
	const fileId = extractFileId(condition);
	const userId = extractUserId(condition);
	const assistantMessageId = extractAssistantMessageId(condition);
	const assistantMessageRequired = requiresAssistantMessage(condition);
	return mockRows
		.filter(
			(row) =>
				(!conversationId || row.conversationId === conversationId) &&
				(!fileId || row.id === fileId) &&
				(!userId || row.userId === userId) &&
				(!assistantMessageId ||
					row.assistantMessageId === assistantMessageId) &&
				(!assistantMessageRequired || row.assistantMessageId !== null),
		)
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
		.map((row) => ({ ...row }));
}

vi.mock("$lib/server/db/schema", () => ({
	artifacts: {
		__table: "artifacts",
		id: { name: "id" },
		userId: { name: "userId" },
		type: { name: "type" },
		retrievalClass: { name: "retrievalClass" },
		name: { name: "name" },
		mimeType: { name: "mimeType" },
		sizeBytes: { name: "sizeBytes" },
		conversationId: { name: "conversationId" },
		summary: { name: "summary" },
		metadataJson: { name: "metadataJson" },
		createdAt: { name: "createdAt" },
		updatedAt: { name: "updatedAt" },
		storagePath: { name: "storagePath" },
		contentText: { name: "contentText" },
	},
	artifactLinks: {
		artifactId: { name: "artifactId" },
		relatedArtifactId: { name: "relatedArtifactId" },
		userId: { name: "userId" },
		linkType: { name: "linkType" },
	},
	chatGeneratedFiles: {
		__table: "chatGeneratedFiles",
		id: { name: "id" },
		conversationId: { name: "conversationId" },
		assistantMessageId: { name: "assistantMessageId" },
		userId: { name: "userId" },
		filename: { name: "filename" },
		mimeType: { name: "mimeType" },
		sizeBytes: { name: "sizeBytes" },
		storagePath: { name: "storagePath" },
		createdAt: { name: "createdAt" },
	},
	conversations: {
		__table: "conversations",
		id: { name: "id" },
		userId: { name: "userId" },
		// Read by `getArtifactOwnershipScope`, which decides which
		// conversations a generated file's document family may span.
		memoryIncognito: { name: "memoryIncognito" },
	},
	users: { id: { name: "id" } },
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) =>
		conditions.filter(
			(c): c is { field: string } =>
				typeof c === "object" && c !== null && "field" in c,
		),
	),
	desc: vi.fn(() => "desc"),
	inArray: vi.fn((field: { name: string }, values: string[]) => ({
		field: field.name,
		value: values,
	})),
	isNotNull: vi.fn((field: { name: string }) => ({
		field: field.name,
		operator: "isNotNull",
	})),
	notInArray: vi.fn((field: { name: string }, _subquery: unknown) => ({
		field: field.name,
		operator: "notInSubquery",
		conversationIdSet: mockConversationIds,
	})),
	eq: vi.fn((field: { name: string }, value: string) => ({
		field: field.name,
		value,
	})),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	createArtifactLink: (...args: Parameters<typeof mockCreateArtifactLink>) =>
		mockCreateArtifactLink(...args),
	createGeneratedOutputArtifact: (
		...args: Parameters<typeof mockCreateGeneratedOutputArtifact>
	) => mockCreateGeneratedOutputArtifact(...args),
}));

vi.mock("$lib/server/services/memory-behavior-log", () => ({
	recordMemoryBehaviorEvent: (
		...args: Parameters<typeof mockRecordMemoryEvent>
	) => mockRecordMemoryEvent(...args),
}));

// The ledger façade. `chat-files` reaches it through a dynamic import, so the
// real module (and the worker behind it) never loads here; the readback module
// it imports statically is real, which is what keeps the memory wrapper's
// shape under test rather than under mock.
vi.mock("$lib/server/services/extraction", () => ({
	startGeneratedFileReadback: (
		...args: Parameters<typeof mockStartGeneratedFileReadback>
	) => mockStartGeneratedFileReadback(...args),
}));

describe("chat-files service", () => {
	beforeEach(() => {
		mockRows.length = 0;
		mockArtifactRows.length = 0;
		mockConversationIds.clear();
		mockIncognitoConversationIds.clear();
		vi.clearAllMocks();
		mockRm.mockResolvedValue(undefined);
		mockCreateArtifactLink.mockResolvedValue(undefined);
		mockRecordMemoryEvent.mockResolvedValue(undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	describe("storeGeneratedFile", () => {
		it("creates file and database record", async () => {
			const { storeGeneratedFile } = await import("./chat-files");

			const file: FileInput = {
				filename: "test-document.pdf",
				mimeType: "application/pdf",
				content: Buffer.from("PDF content here"),
			};

			const result = await storeGeneratedFile("conv-123", "user-456", file);

			expect(result).toMatchObject({
				conversationId: "conv-123",
				assistantMessageId: null,
				userId: "user-456",
				filename: "test-document.pdf",
				mimeType: "application/pdf",
				sizeBytes: 16,
			});
			expect(result.id).toBeDefined();
			expect(result.storagePath).toMatch(/^conv-123\/[a-f0-9-]+\.pdf$/);
			expect(result.createdAt).toBeDefined();

			expect(mockRows).toHaveLength(1);
			expect(mockRows[0]).toMatchObject({
				conversationId: "conv-123",
				assistantMessageId: null,
				userId: "user-456",
				filename: "test-document.pdf",
				mimeType: "application/pdf",
				sizeBytes: 16,
			});
		});

		it("handles files without extension", async () => {
			const { storeGeneratedFile } = await import("./chat-files");

			const file: FileInput = {
				filename: "README",
				content: Buffer.from("Documentation"),
			};

			const result = await storeGeneratedFile("conv-123", "user-456", file);

			expect(result.storagePath).toMatch(/\.bin$/);
		});

		// Spec section 10: the extension parser is the shared registry one now.
		// `extname(".env")` returned "" and the file stored as `<id>.bin`;
		// the registry parser answers "env", so the dotfile keeps its name.
		// Ordinary names, including multi-dot and upper-case ones, are unchanged.
		it("stores a dotfile under its own extension", async () => {
			const { storeGeneratedFile } = await import("./chat-files");

			const result = await storeGeneratedFile("conv-123", "user-456", {
				filename: ".env",
				content: Buffer.from("KEY=value"),
			});

			expect(result.storagePath).toMatch(/^conv-123\/[a-f0-9-]+\.env$/);
		});

		it.each([
			["report.final.PDF", "pdf"],
			["archive.tar.gz", "gz"],
			["sheet.xlsx", "xlsx"],
		])("keeps the stored extension of %s as .%s", async (filename, extension) => {
			const { storeGeneratedFile } = await import("./chat-files");

			const result = await storeGeneratedFile("conv-123", "user-456", {
				filename,
				content: Buffer.from("x"),
			});

			expect(result.storagePath).toBe(`conv-123/${result.id}.${extension}`);
		});

		it("handles Uint8Array content", async () => {
			const { storeGeneratedFile } = await import("./chat-files");

			const file: FileInput = {
				filename: "data.json",
				mimeType: "application/json",
				content: new Uint8Array([
					123, 34, 107, 101, 121, 34, 58, 34, 118, 97, 108, 117, 101, 34, 125,
				]),
			};

			const result = await storeGeneratedFile("conv-123", "user-456", file);

			expect(result.sizeBytes).toBe(15);
			expect(result.mimeType).toBe("application/json");
		});
	});

	describe("getChatFiles", () => {
		it("hides unassigned staged files from the conversation generated files surface", async () => {
			const { getChatFiles } = await import("./chat-files");

			mockRows.push(
				{
					id: "file-staged-orphan",
					conversationId: "conv-a",
					assistantMessageId: null,
					userId: "user-1",
					filename: "partial.csv",
					mimeType: "text/csv",
					sizeBytes: 1000,
					storagePath: "conv-a/file-staged-orphan.csv",
					createdAt: new Date("2026-01-04"),
				},
				{
					id: "file-visible",
					conversationId: "conv-a",
					assistantMessageId: "assistant-a",
					userId: "user-1",
					filename: "report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2000,
					storagePath: "conv-a/file-visible.pdf",
					createdAt: new Date("2026-01-03"),
				},
			);

			const result = await getChatFiles("conv-a");

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				id: "file-visible",
				assistantMessageId: "assistant-a",
			});
			expect(result.map((file) => file.id)).not.toContain("file-staged-orphan");
		});

		it("returns only files for the specified conversation", async () => {
			const { getChatFiles } = await import("./chat-files");

			mockRows.push(
				{
					id: "file-1",
					conversationId: "conv-a",
					assistantMessageId: "assistant-a",
					userId: "user-1",
					filename: "doc1.pdf",
					mimeType: "application/pdf",
					sizeBytes: 1000,
					storagePath: "conv-a/file-1.pdf",
					createdAt: new Date("2026-01-01"),
				},
				{
					id: "file-2",
					conversationId: "conv-b",
					assistantMessageId: null,
					userId: "user-1",
					filename: "doc2.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2000,
					storagePath: "conv-b/file-2.pdf",
					createdAt: new Date("2026-01-02"),
				},
				{
					id: "file-3",
					conversationId: "conv-a",
					assistantMessageId: "assistant-c",
					userId: "user-1",
					filename: "doc3.pdf",
					mimeType: "application/pdf",
					sizeBytes: 3000,
					storagePath: "conv-a/file-3.pdf",
					createdAt: new Date("2026-01-03"),
				},
			);

			const result = await getChatFiles("conv-a");

			expect(result).toHaveLength(2);
			expect(result.map((f) => f.id)).toContain("file-1");
			expect(result.map((f) => f.id)).toContain("file-3");
			expect(result.map((f) => f.id)).not.toContain("file-2");
		});

		it("returns empty array when conversation has no files", async () => {
			const { getChatFiles } = await import("./chat-files");

			const result = await getChatFiles("conv-empty");

			expect(result).toEqual([]);
		});

		it("returns files sorted by createdAt descending", async () => {
			const { getChatFiles } = await import("./chat-files");

			mockRows.push(
				{
					id: "file-1",
					conversationId: "conv-a",
					assistantMessageId: "assistant-a",
					userId: "user-1",
					filename: "oldest.pdf",
					mimeType: "application/pdf",
					sizeBytes: 1000,
					storagePath: "conv-a/file-1.pdf",
					createdAt: new Date("2026-01-01"),
				},
				{
					id: "file-2",
					conversationId: "conv-a",
					assistantMessageId: "assistant-b",
					userId: "user-1",
					filename: "newest.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2000,
					storagePath: "conv-a/file-2.pdf",
					createdAt: new Date("2026-01-03"),
				},
			);

			const result = await getChatFiles("conv-a");

			expect(result[0].filename).toBe("newest.pdf");
			expect(result[1].filename).toBe("oldest.pdf");
		});

		it("returns only files for the specified assistant message when requested", async () => {
			const { getChatFilesForAssistantMessage } = await import("./chat-files");

			mockRows.push(
				{
					id: "file-1",
					conversationId: "conv-a",
					assistantMessageId: "assistant-a",
					userId: "user-1",
					filename: "oldest.pdf",
					mimeType: "application/pdf",
					sizeBytes: 1000,
					storagePath: "conv-a/file-1.pdf",
					createdAt: new Date("2026-01-01"),
				},
				{
					id: "file-2",
					conversationId: "conv-a",
					assistantMessageId: "assistant-b",
					userId: "user-1",
					filename: "newest.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2000,
					storagePath: "conv-a/file-2.pdf",
					createdAt: new Date("2026-01-03"),
				},
			);

			const result = await getChatFilesForAssistantMessage(
				"conv-a",
				"assistant-b",
			);

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("file-2");
			expect(result[0].assistantMessageId).toBe("assistant-b");
		});
	});

	describe("assignGeneratedFilesToAssistantMessage", () => {
		it("updates only matching files in a conversation", async () => {
			const { assignGeneratedFilesToAssistantMessage } = await import(
				"./chat-files"
			);

			mockRows.push(
				{
					id: "file-1",
					conversationId: "conv-a",
					assistantMessageId: null,
					userId: "user-1",
					filename: "doc1.pdf",
					mimeType: "application/pdf",
					sizeBytes: 1000,
					storagePath: "conv-a/file-1.pdf",
					createdAt: new Date("2026-01-01"),
				},
				{
					id: "file-2",
					conversationId: "conv-b",
					assistantMessageId: null,
					userId: "user-1",
					filename: "doc2.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2000,
					storagePath: "conv-b/file-2.pdf",
					createdAt: new Date("2026-01-02"),
				},
			);

			await assignGeneratedFilesToAssistantMessage("conv-a", "assistant-a", [
				"file-1",
			]);

			expect(mockRows[0].assistantMessageId).toBe("assistant-a");
			expect(mockRows[1].assistantMessageId).toBeNull();
		});
	});

	describe("getChatFile", () => {
		it("returns file when found in conversation", async () => {
			const { getChatFile } = await import("./chat-files");

			mockRows.push({
				id: "file-1",
				conversationId: "conv-a",
				assistantMessageId: null,
				userId: "user-1",
				filename: "document.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-a/file-1.pdf",
				createdAt: new Date("2026-01-01"),
			});

			const result = await getChatFile("conv-a", "file-1");

			expect(result).toMatchObject({
				id: "file-1",
				conversationId: "conv-a",
				filename: "document.pdf",
			});
		});

		it("returns null when file not found", async () => {
			const { getChatFile } = await import("./chat-files");

			const result = await getChatFile("conv-a", "nonexistent");

			expect(result).toBeNull();
		});

		it("returns null when file exists in different conversation", async () => {
			const { getChatFile } = await import("./chat-files");

			mockRows.push({
				id: "file-1",
				conversationId: "conv-b",
				assistantMessageId: null,
				userId: "user-1",
				filename: "document.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-b/file-1.pdf",
				createdAt: new Date("2026-01-01"),
			});

			const result = await getChatFile("conv-a", "file-1");

			expect(result).toBeNull();
		});
	});

	describe("getChatFileByUser", () => {
		it("returns a file when the user owns it", async () => {
			const { getChatFileByUser } = await import("./chat-files");

			mockRows.push({
				id: "file-7",
				conversationId: "conv-a",
				assistantMessageId: null,
				userId: "user-7",
				filename: "owned.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1234,
				storagePath: "conv-a/file-7.pdf",
				createdAt: new Date("2026-01-01"),
			});

			const result = await getChatFileByUser("file-7", "user-7");

			expect(result).toMatchObject({
				id: "file-7",
				userId: "user-7",
				filename: "owned.pdf",
			});
		});

		it("returns null when the file belongs to a different user", async () => {
			const { getChatFileByUser } = await import("./chat-files");

			mockRows.push({
				id: "file-8",
				conversationId: "conv-a",
				assistantMessageId: null,
				userId: "user-8",
				filename: "private.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1234,
				storagePath: "conv-a/file-8.pdf",
				createdAt: new Date("2026-01-01"),
			});

			const result = await getChatFileByUser("file-8", "user-7");

			expect(result).toBeNull();
		});
	});

	describe("syncGeneratedFilesToMemory", () => {
		it("keeps source-first rendered document source out of direct extraction by default", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			const now = new Date("2026-01-01T12:00:00.000Z");
			mockRows.push(
				{
					id: "file-source-pdf",
					conversationId: "conv-a",
					assistantMessageId: "assistant-a",
					userId: "user-1",
					filename: "report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 5000,
					storagePath: "conv-a/file-source-pdf.pdf",
					createdAt: now,
				},
				{
					id: "file-source-html",
					conversationId: "conv-a",
					assistantMessageId: "assistant-a",
					userId: "user-1",
					filename: "report.html",
					mimeType: "text/html",
					sizeBytes: 4000,
					storagePath: "conv-a/file-source-html.html",
					createdAt: now,
				},
			);
			mockArtifactRows.push({
				id: "artifact-source-1",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Source-first report",
				mimeType: "application/vnd.alfyai.generated-document+json",
				sizeBytes: null,
				conversationId: "conv-a",
				summary: "Source-first report",
				metadataJson: JSON.stringify({
					generatedDocumentSourceVersion: 1,
					generatedDocumentSource: {
						version: 1,
						template: "alfyai_standard_report",
						title: "Source-first report",
					},
					fileProductionJobId: "job-source-1",
					documentFamilyId: "artifact-source-1",
					documentFamilyStatus: "active",
					documentLabel: "Source-first report",
					versionNumber: 1,
					originConversationId: "conv-a",
					originAssistantMessageId: "assistant-a",
					originalChatFileId: "file-source-pdf",
					sourceChatFileId: "file-source-pdf",
					generatedDocumentRenderedChatFileIds: [
						"file-source-pdf",
						"file-source-html",
					],
				}),
				contentText:
					"Source-first report\n\nCanonical generated document source text.",
				extension: "alfyidoc.json",
				storagePath: null,
				createdAt: now,
				updatedAt: now,
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-source-pdf", "file-source-html"],
				assistantResponse: "Here is the report.",
			});

			expect(mockAccess).not.toHaveBeenCalled();
			expect(mockReadFile).not.toHaveBeenCalled();
			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			expect(mockCreateGeneratedOutputArtifact).not.toHaveBeenCalled();
		});

		// The other half of D9's ruling: the source's text has to actually be
		// there. When the markdown render failed, the source artifact carries
		// none, and the rendered binaries must not be left permanently
		// unreadable — they fall back to exactly what any other generated file
		// does, a memory wrapper plus a readback job.
		it("falls back to readback when the document source carries no text", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			const now = new Date("2026-01-01T12:00:00.000Z");
			mockRows.push({
				id: "file-empty-source-pdf",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-a/file-empty-source-pdf.pdf",
				createdAt: now,
			});
			mockArtifactRows.push({
				id: "artifact-empty-source",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Source-first report",
				mimeType: "application/vnd.alfyai.generated-document+json",
				sizeBytes: null,
				conversationId: "conv-a",
				summary: "Source-first report",
				metadataJson: JSON.stringify({
					generatedDocumentSourceVersion: 1,
					generatedDocumentSource: {
						version: 1,
						template: "alfyai_standard_report",
						title: "Source-first report",
					},
					fileProductionJobId: "job-source-2",
					originalChatFileId: "file-empty-source-pdf",
					generatedDocumentRenderedChatFileIds: ["file-empty-source-pdf"],
				}),
				contentText: "",
				extension: "alfyidoc.json",
				storagePath: null,
				createdAt: now,
				updatedAt: now,
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-empty-source-pdf"],
				assistantResponse: "Here is the report.",
			});

			expect(mockStartGeneratedFileReadback).toHaveBeenCalledWith(
				expect.objectContaining({
					chatGeneratedFileId: "file-empty-source-pdf",
					hints: { preferredTier: "flash" },
				}),
			);
		});

		// The core of slice S5: the artifact, its version metadata and its family
		// link are all written now; only the text waits.
		it("creates the generated-file artifact immediately and queues the binary's text", async () => {
			const { getChatFile, syncGeneratedFilesToMemory } = await import(
				"./chat-files"
			);
			mockRows.push({
				id: "file-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-a/file-1.pdf",
				createdAt: new Date("2026-01-01"),
			});
			expect(await getChatFile("conv-a", "file-1")).toMatchObject({
				id: "file-1",
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-1"],
				assistantResponse: "Here is the report.",
			});

			expect(console.error).not.toHaveBeenCalled();
			expect(mockCreateGeneratedOutputArtifact).toHaveBeenCalledWith(
				expect.objectContaining({
					nameOverride: "report.pdf",
					metadata: expect.objectContaining({
						originalChatFileId: "file-1",
						generatedFilename: "report.pdf",
						generatedFileVersion: 1,
						versionNumber: 1,
						sourceChatFileId: "file-1",
					}),
				}),
			);
			const content =
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content;
			expect(content).toContain("Generated file version: v1");
			// Exactly the text today's "extraction failed" path leaves behind.
			expect(content).toContain(
				"Extracted file content: No readable text could be extracted from this file.",
			);
			expect(mockStartGeneratedFileReadback).toHaveBeenCalledWith({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				chatGeneratedFileId: "file-1",
				fileName: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				// D10: a PDF this app produced is born-digital, so it parses at
				// flash rather than waiting on a cold OCR-capable tier. Soft —
				// `preferredTier`, not `tier` — so a server without flash still
				// parses it instead of failing the job.
				hints: { preferredTier: "flash" },
			});
		});

		it("reads a text-like generated file without touching the ledger", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockReadFile.mockResolvedValueOnce(
				Buffer.from("# Report\r\n\r\nGenerated markdown body.\n"),
			);
			mockRows.push({
				id: "file-md",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "report.md",
				mimeType: "text/markdown",
				sizeBytes: 40,
				storagePath: "conv-a/file-md.md",
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-md"],
				assistantResponse: "Here is the report.",
			});

			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			expect(
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content,
			).toContain("Extracted file content:\n# Report Generated markdown body.");
		});

		// D8's `inline_text` outputs, which never spawn a container to be
		// written and must not spawn a MinerU job to be read either.
		it.each([
			[
				"file-tsv",
				"regions.tsv",
				"text/tab-separated-values",
				"a\tb\n1\t2\n",
				"a b 1 2",
			],
			["file-csv", "regions.csv", "text/csv", "a,b\n1,2\n", "a,b 1,2"],
			["file-json", "data.json", "application/json", '{"a":1}\n', '{"a":1}'],
			["file-txt", "notes.txt", "text/plain", "plain notes\n", "plain notes"],
		])("decodes an inline_text output (%s) without a ledger job", async (id, filename, mimeType, body, expectedPreview) => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockReadFile.mockResolvedValueOnce(Buffer.from(body));
			mockRows.push({
				id,
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename,
				mimeType,
				sizeBytes: body.length,
				storagePath: `conv-a/${id}`,
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: [id],
				assistantResponse: "Here is the file.",
			});

			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			// The wrapper's preview collapses runs of whitespace, so the
			// delimiters are the assertion, not the line breaks.
			expect(
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content,
			).toContain(`Extracted file content:\n${expectedPreview}`);
		});

		// HTML is a MinerU route for UPLOADS since Phase 5 (a real page is
		// mostly nav, scripts and ads, which MinerU strips). A `.html` this app
		// generated is our own markup, so it is decoded on the spot: waiting on
		// a backend to read back what we just wrote would be a regression with
		// no upside, and it would break while MinerU is down.
		it("decodes a generated .html instead of sending it to MinerU", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockReadFile.mockResolvedValueOnce(
				Buffer.from("<h1>Quarterly report</h1>\r\n<p>Revenue grew.</p>\n"),
			);
			mockRows.push({
				id: "file-html",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "report.html",
				mimeType: "text/html",
				sizeBytes: 48,
				storagePath: "conv-a/file-html.html",
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-html"],
				assistantResponse: "Here is the report.",
			});

			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			expect(
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content,
			).toContain("Extracted file content:\n<h1>Quarterly report</h1>");
		});

		it("round-trips a generated .md that carries a UTF-8 BOM", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockReadFile.mockResolvedValueOnce(
				Buffer.concat([
					Buffer.from([0xef, 0xbb, 0xbf]),
					Buffer.from("# Report\n\nBody.\n"),
				]),
			);
			mockRows.push({
				id: "file-bom",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "report.md",
				mimeType: "text/markdown",
				sizeBytes: 19,
				storagePath: "conv-a/file-bom.md",
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-bom"],
				assistantResponse: "Here is the report.",
			});

			const content =
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content;
			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			expect(content).toContain("Extracted file content:\n# Report");
			expect(content).not.toContain("﻿");
		});

		// The shared `decodeTextBuffer` (`extraction/text-decode.ts`) is the
		// single decoder now — the same module the direct-text extractor uses for
		// uploads. These four cases exercise behaviour the old hand-rolled
		// `content.toString("utf8")...` body could not have: real UTF-16LE
		// decoding, and NUL bytes turning into "no readable text" instead of
		// leaking a control character into memory.
		it("decodes a generated .txt that carries a UTF-16LE BOM", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockReadFile.mockResolvedValueOnce(
				Buffer.concat([
					Buffer.from([0xff, 0xfe]),
					Buffer.from("Grew 12%\n", "utf16le"),
				]),
			);
			mockRows.push({
				id: "file-utf16le",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "notes.txt",
				mimeType: "text/plain",
				sizeBytes: 20,
				storagePath: "conv-a/file-utf16le.txt",
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-utf16le"],
				assistantResponse: "Here is the file.",
			});

			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			expect(
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content,
			).toContain("Extracted file content:\nGrew 12%");
		});

		it("treats a generated text-like file with a NUL byte as unreadable rather than storing it", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockReadFile.mockResolvedValueOnce(
				Buffer.from("before\0after\n", "utf8"),
			);
			mockRows.push({
				id: "file-nul",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "notes.txt",
				mimeType: "text/plain",
				sizeBytes: 13,
				storagePath: "conv-a/file-nul.txt",
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-nul"],
				assistantResponse: "Here is the file.",
			});

			// A text-like route never enqueues a ledger job, even when the decode
			// fails — there is no backend to send it to.
			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			const content =
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content;
			expect(content).toContain(
				"Extracted file content: No readable text could be extracted from this file.",
			);
			expect(content).not.toContain("before");
		});

		it("round-trips ordinary Hungarian UTF-8 text untouched", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			const body = "Árvíztűrő tükörfúrógép.\n";
			mockReadFile.mockResolvedValueOnce(Buffer.from(body, "utf8"));
			mockRows.push({
				id: "file-hu",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "jegyzet.txt",
				mimeType: "text/plain",
				sizeBytes: Buffer.byteLength(body, "utf8"),
				storagePath: "conv-a/file-hu.txt",
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-hu"],
				assistantResponse: "Here is the file.",
			});

			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			expect(
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content,
			).toContain("Extracted file content:\nÁrvíztűrő tükörfúrógép.");
		});

		it("queues nothing for a generated file no backend can read", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockRows.push({
				id: "file-zip",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "bundle.zip",
				mimeType: "application/zip",
				sizeBytes: 900,
				storagePath: "conv-a/file-zip.zip",
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-zip"],
				assistantResponse: "Here is the bundle.",
			});

			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
			expect(mockCreateGeneratedOutputArtifact).toHaveBeenCalledTimes(1);
			expect(
				mockCreateGeneratedOutputArtifact.mock.calls[0][0].content,
			).toContain(
				"Extracted file content: No readable text could be extracted from this file.",
			);
		});

		it("keeps the sync going when the ledger refuses the job", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockStartGeneratedFileReadback.mockRejectedValueOnce(
				new Error("ledger unavailable"),
			);
			mockRows.push({
				id: "file-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-a/file-1.pdf",
				createdAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-1"],
				assistantResponse: "Here is the report.",
			});

			expect(console.error).not.toHaveBeenCalled();
			expect(mockCreateGeneratedOutputArtifact).toHaveBeenCalledTimes(1);
			expect(console.warn).toHaveBeenCalledWith(
				"[CHAT_FILES] Could not queue generated file text extraction; the file keeps its metadata",
				expect.objectContaining({ fileId: "file-1", filename: "report.pdf" }),
			);
		});

		it("syncs the same generated file once, however often it is asked", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockRows.push({
				id: "file-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				userId: "user-1",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-a/file-1.pdf",
				createdAt: new Date("2026-01-01"),
			});
			mockArtifactRows.push({
				id: "artifact-existing",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "report.pdf",
				mimeType: "text/markdown",
				sizeBytes: 900,
				conversationId: "conv-a",
				summary: "Report",
				metadataJson: JSON.stringify({
					generatedFile: true,
					originalChatFileId: "file-1",
					generatedFilename: "report.pdf",
					versionNumber: 1,
				}),
				contentText: "Generated file: report.pdf",
				extension: "md",
				storagePath: null,
				createdAt: new Date("2026-01-01"),
				updatedAt: new Date("2026-01-01"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-1", "file-1"],
				assistantResponse: "Here is the report.",
			});

			expect(mockCreateGeneratedOutputArtifact).not.toHaveBeenCalled();
			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
		});

		it("skips a generated file whose row was deleted before the sync ran", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-a",
				fileIds: ["file-gone"],
				assistantResponse: "Here is the report.",
			});

			expect(console.error).not.toHaveBeenCalled();
			expect(mockCreateGeneratedOutputArtifact).not.toHaveBeenCalled();
			expect(mockStartGeneratedFileReadback).not.toHaveBeenCalled();
		});

		it("records generated document supersession metadata", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			const previousUpdatedAt = new Date("2026-01-01T12:00:00.000Z");
			mockArtifactRows.push({
				id: "artifact-prev",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "report.pdf",
				mimeType: "text/markdown",
				sizeBytes: 1200,
				conversationId: "conv-a",
				summary: "Previous report summary",
				metadataJson: JSON.stringify({
					generatedFile: true,
					generatedFilename: "report.pdf",
					generatedFileVersion: 2,
					documentFamilyId: "family-report",
					documentFamilyStatus: "active",
					documentLabel: "report.pdf",
					documentRole: "draft",
					versionNumber: 2,
					sourceChatFileId: "file-prev",
				}),
				contentText: "Previous generated report body.",
				extension: "md",
				storagePath: null,
				createdAt: previousUpdatedAt,
				updatedAt: previousUpdatedAt,
			});
			mockRows.push({
				id: "file-next",
				conversationId: "conv-a",
				assistantMessageId: "assistant-next",
				userId: "user-1",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-a/file-next.pdf",
				createdAt: new Date("2026-01-02T12:00:00.000Z"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-a",
				assistantMessageId: "assistant-next",
				fileIds: ["file-next"],
				assistantResponse: "Here is the revised report.",
			});

			expect(mockCreateGeneratedOutputArtifact).toHaveBeenCalledWith(
				expect.objectContaining({
					nameOverride: "report.pdf",
					metadata: expect.objectContaining({
						documentFamilyId: "family-report",
						documentFamilyStatus: "active",
						documentLabel: "report.pdf",
						documentRole: "draft",
						versionNumber: 3,
						supersedesArtifactId: "artifact-prev",
						previousGeneratedArtifactId: "artifact-prev",
					}),
				}),
			);
			expect(mockCreateArtifactLink).toHaveBeenCalledWith({
				userId: "user-1",
				artifactId: "artifact-1",
				relatedArtifactId: "artifact-prev",
				conversationId: "conv-a",
				messageId: "assistant-next",
				linkType: "supersedes",
			});
			expect(mockRecordMemoryEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					eventKey: "document_superseded:artifact-prev:artifact-1",
					userId: "user-1",
					conversationId: "conv-a",
					messageId: "assistant-next",
					domain: "document",
					eventType: "document_superseded",
					subjectId: "artifact-1",
					relatedId: "artifact-prev",
					payload: expect.objectContaining({
						documentFamilyId: "family-report",
						documentLabel: "report.pdf",
						documentRole: "draft",
						versionNumber: 3,
						previousVersion: 2,
						currentFilename: "report.pdf",
					}),
				}),
			);
		});

		// The owner's ruling: a document family is per user and per filename
		// ACROSS conversations, so continuing a file in a NEW conversation joins
		// the same family rather than starting a second one at v1. That is what
		// makes the first `report.pdf` of a fresh conversation honestly v3, and
		// it is the half `read_generated_file` and `produce_file` patches now
		// match by being able to reach the earlier version.
		it("continues the family when the new version lands in another conversation", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			const previousUpdatedAt = new Date("2026-01-01T12:00:00.000Z");
			mockArtifactRows.push({
				id: "artifact-prev",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "report.pdf",
				mimeType: "text/markdown",
				sizeBytes: 1200,
				conversationId: "conv-a",
				summary: "Previous report summary",
				metadataJson: JSON.stringify({
					generatedFile: true,
					generatedFilename: "report.pdf",
					generatedFileVersion: 2,
					documentFamilyId: "family-report",
					documentFamilyStatus: "active",
					documentLabel: "report.pdf",
					documentRole: "draft",
					versionNumber: 2,
					sourceChatFileId: "file-prev",
				}),
				contentText: "Previous generated report body.",
				extension: "md",
				storagePath: null,
				createdAt: previousUpdatedAt,
				updatedAt: previousUpdatedAt,
			});
			mockRows.push({
				id: "file-next",
				conversationId: "conv-b",
				assistantMessageId: "assistant-next",
				userId: "user-1",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-b/file-next.pdf",
				createdAt: new Date("2026-01-02T12:00:00.000Z"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-b",
				assistantMessageId: "assistant-next",
				fileIds: ["file-next"],
				assistantResponse: "Here is the revised report.",
			});

			expect(mockCreateGeneratedOutputArtifact).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conv-b",
					metadata: expect.objectContaining({
						documentFamilyId: "family-report",
						documentLabel: "report.pdf",
						versionNumber: 3,
						// Still linked to the version from the OTHER conversation.
						supersedesArtifactId: "artifact-prev",
						originConversationId: "conv-b",
					}),
				}),
			);
			expect(mockCreateArtifactLink).toHaveBeenCalledWith(
				expect.objectContaining({
					relatedArtifactId: "artifact-prev",
					conversationId: "conv-b",
					linkType: "supersedes",
				}),
			);
		});

		// The wrapper a new version carries lists the earlier ones, and that list
		// used to quote each earlier version's stored SUMMARY. A generated file's
		// summary IS its own wrapper's head — `Chat file id: …`, `Generated in
		// conversation: …` — so every version line carried the ids of the chat
		// and the file it came from, flattened onto one line where the read-back
		// redaction's line-prefix rules could never reach them. The excerpt is
		// now the earlier version's own TEXT, which cannot contain either.
		it("quotes only a prior version's content, never its id-bearing summary", async () => {
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			const previousUpdatedAt = new Date("2026-01-01T12:00:00.000Z");
			const previousWrapper = [
				"Generated file: report.pdf",
				"File type: application/pdf",
				"Chat file id: file-prev",
				"Generated in conversation: conv-a",
				"Generated file version: v2",
				"",
				"Extracted file content:",
				"Quarterly revenue was flat.",
			].join("\n");
			mockArtifactRows.push({
				id: "artifact-prev",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "report.pdf",
				mimeType: "text/markdown",
				sizeBytes: 1200,
				conversationId: "conv-a",
				// What `guessSummary` stores for a generated file: the wrapper's
				// own head, ids and all.
				summary: previousWrapper.replace(/\s+/g, " ").trim().slice(0, 240),
				metadataJson: JSON.stringify({
					generatedFile: true,
					generatedFilename: "report.pdf",
					documentFamilyId: "family-report",
					documentLabel: "report.pdf",
					versionNumber: 2,
				}),
				contentText: previousWrapper,
				extension: "md",
				storagePath: null,
				createdAt: previousUpdatedAt,
				updatedAt: previousUpdatedAt,
			});
			mockRows.push({
				id: "file-next",
				conversationId: "conv-b",
				assistantMessageId: "assistant-next",
				userId: "user-1",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-b/file-next.pdf",
				createdAt: new Date("2026-01-02T12:00:00.000Z"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-b",
				assistantMessageId: "assistant-next",
				fileIds: ["file-next"],
				assistantResponse: "Here is the revised report.",
			});

			const call = mockCreateGeneratedOutputArtifact.mock.calls[0][0] as {
				content: string;
			};
			const versionLine = call.content
				.split("\n")
				.find((line) => line.startsWith("- v2 from "));
			expect(versionLine).toBeDefined();
			expect(versionLine).toContain("Quarterly revenue was flat.");
			expect(versionLine).not.toContain("file-prev");
			expect(versionLine).not.toContain("Chat file id");
			expect(versionLine).not.toContain("Generated in conversation");
		});

		it("does not continue a family seeded in an INCOGNITO conversation", async () => {
			// The family scan is per user and per filename across conversations,
			// which is what makes the test above work — and is exactly how an
			// incognito chat's output would otherwise reach a normal one. The new
			// file's wrapper would carry the incognito version's label and an
			// excerpt of its text, and the model would be told it is v3.
			const { syncGeneratedFilesToMemory } = await import("./chat-files");
			mockIncognitoConversationIds.add("conv-a");
			const previousUpdatedAt = new Date("2026-01-01T12:00:00.000Z");
			mockArtifactRows.push({
				id: "artifact-prev",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "report.pdf",
				mimeType: "text/markdown",
				sizeBytes: 1200,
				conversationId: "conv-a",
				summary: "Previous report summary",
				metadataJson: JSON.stringify({
					generatedFile: true,
					generatedFilename: "report.pdf",
					generatedFileVersion: 2,
					documentFamilyId: "family-report",
					documentFamilyStatus: "active",
					documentLabel: "report.pdf",
					versionNumber: 2,
					sourceChatFileId: "file-prev",
				}),
				contentText: "Previous generated report body.",
				extension: "md",
				storagePath: null,
				createdAt: previousUpdatedAt,
				updatedAt: previousUpdatedAt,
			});
			mockRows.push({
				id: "file-next",
				conversationId: "conv-b",
				assistantMessageId: "assistant-next",
				userId: "user-1",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-b/file-next.pdf",
				createdAt: new Date("2026-01-02T12:00:00.000Z"),
			});

			await syncGeneratedFilesToMemory({
				userId: "user-1",
				conversationId: "conv-b",
				assistantMessageId: "assistant-next",
				fileIds: ["file-next"],
				assistantResponse: "Here is the revised report.",
			});

			const call = mockCreateGeneratedOutputArtifact.mock.calls[0][0] as {
				content: string;
				metadata: Record<string, unknown>;
			};
			expect(call.metadata.versionNumber).toBe(1);
			expect(call.metadata.documentFamilyId).not.toBe("family-report");
			expect(call.metadata.supersedesArtifactId).toBeNull();
			expect(call.content).not.toContain("Recent prior versions");
			expect(call.content).not.toContain("Previous report summary");
			expect(mockCreateArtifactLink).not.toHaveBeenCalledWith(
				expect.objectContaining({ linkType: "supersedes" }),
			);
		});
	});

	describe("deleteChatFile", () => {
		it("deletes file and returns true when found", async () => {
			const { deleteChatFile } = await import("./chat-files");

			mockRows.push({
				id: "file-1",
				conversationId: "conv-a",
				assistantMessageId: null,
				userId: "user-1",
				filename: "document.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-a/file-1.pdf",
				createdAt: new Date("2026-01-01"),
			});

			const result = await deleteChatFile("conv-a", "file-1");

			expect(result).toBe(true);
			expect(mockRows).toHaveLength(0);
		});

		it("returns false when file not found", async () => {
			const { deleteChatFile } = await import("./chat-files");

			const result = await deleteChatFile("conv-a", "nonexistent");

			expect(result).toBe(false);
		});

		it("returns false when file exists in different conversation", async () => {
			const { deleteChatFile } = await import("./chat-files");

			mockRows.push({
				id: "file-1",
				conversationId: "conv-b",
				assistantMessageId: null,
				userId: "user-1",
				filename: "document.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5000,
				storagePath: "conv-b/file-1.pdf",
				createdAt: new Date("2026-01-01"),
			});

			const result = await deleteChatFile("conv-a", "file-1");

			expect(result).toBe(false);
			expect(mockRows).toHaveLength(1);
		});
	});

	describe("deleteAllChatFilesForConversation", () => {
		it("deletes all files for conversation and returns count", async () => {
			const { deleteAllChatFilesForConversation } = await import(
				"./chat-files"
			);

			mockRows.push(
				{
					id: "file-1",
					conversationId: "conv-a",
					assistantMessageId: null,
					userId: "user-1",
					filename: "doc1.pdf",
					mimeType: "application/pdf",
					sizeBytes: 1000,
					storagePath: "conv-a/file-1.pdf",
					createdAt: new Date("2026-01-01"),
				},
				{
					id: "file-2",
					conversationId: "conv-a",
					assistantMessageId: null,
					userId: "user-1",
					filename: "doc2.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2000,
					storagePath: "conv-a/file-2.pdf",
					createdAt: new Date("2026-01-02"),
				},
				{
					id: "file-3",
					conversationId: "conv-b",
					assistantMessageId: null,
					userId: "user-1",
					filename: "other.pdf",
					mimeType: "application/pdf",
					sizeBytes: 3000,
					storagePath: "conv-b/file-3.pdf",
					createdAt: new Date("2026-01-03"),
				},
			);

			await deleteAllChatFilesForConversation("conv-a");

			expect(mockRows).toHaveLength(1);
			expect(mockRows[0].id).toBe("file-3");
		});

		it("returns 0 when conversation has no files", async () => {
			const { deleteAllChatFilesForConversation } = await import(
				"./chat-files"
			);

			const result = await deleteAllChatFilesForConversation("conv-empty");

			expect(result).toBe(0);
		});
	});

	describe("deleteOrphanChatFiles", () => {
		it("deletes chat-generated file rows whose parent conversation no longer exists", async () => {
			const { deleteOrphanChatFiles } = await import("./chat-files");

			// conv-a exists, conv-orphan-1 and conv-orphan-2 do not
			mockConversationIds.add("conv-a");
			mockConversationIds.add("conv-b");

			mockRows.push(
				{
					id: "file-active",
					conversationId: "conv-a",
					assistantMessageId: "msg-1",
					userId: "user-1",
					filename: "active-report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 5000,
					storagePath: "conv-a/file-active.pdf",
					createdAt: new Date("2026-01-01"),
				},
				{
					id: "file-orphan-1",
					conversationId: "conv-orphan-1",
					assistantMessageId: "msg-2",
					userId: "user-1",
					filename: "orphan-report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 3000,
					storagePath: "conv-orphan-1/file-orphan-1.pdf",
					createdAt: new Date("2026-01-02"),
				},
				{
					id: "file-orphan-2",
					conversationId: "conv-orphan-2",
					assistantMessageId: "msg-3",
					userId: "user-1",
					filename: "orphan-report-2.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2000,
					storagePath: "conv-orphan-2/file-orphan-2.pdf",
					createdAt: new Date("2026-01-03"),
				},
			);

			const deletedCount = await deleteOrphanChatFiles();

			expect(deletedCount).toBe(2);
			expect(mockRows).toHaveLength(1);
			expect(mockRows[0].id).toBe("file-active");
		});

		it("returns 0 when there are no orphan files", async () => {
			const { deleteOrphanChatFiles } = await import("./chat-files");

			mockConversationIds.add("conv-a");
			mockConversationIds.add("conv-b");

			mockRows.push(
				{
					id: "file-1",
					conversationId: "conv-a",
					assistantMessageId: "msg-1",
					userId: "user-1",
					filename: "doc1.pdf",
					mimeType: "application/pdf",
					sizeBytes: 1000,
					storagePath: "conv-a/file-1.pdf",
					createdAt: new Date("2026-01-01"),
				},
				{
					id: "file-2",
					conversationId: "conv-b",
					assistantMessageId: "msg-2",
					userId: "user-1",
					filename: "doc2.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2000,
					storagePath: "conv-b/file-2.pdf",
					createdAt: new Date("2026-01-02"),
				},
			);

			const result = await deleteOrphanChatFiles();

			expect(result).toBe(0);
			expect(mockRows).toHaveLength(2);
		});

		it("returns 0 when there are no chat files at all", async () => {
			const { deleteOrphanChatFiles } = await import("./chat-files");

			mockConversationIds.add("conv-a");

			const result = await deleteOrphanChatFiles();

			expect(result).toBe(0);
		});
	});
});
