import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileInput } from './chat-files';

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
	mockDeleteWhere,
	mockUnlink,
	mockRm,
	mockMkdir,
	mockWriteFile,
	mockReadFile,
	mockAccess,
	mockCreateGeneratedOutputArtifact,
	mockSyncArtifactToHoncho,
	mockExtractDocumentText,
} = vi.hoisted(() => {
	const mockRows: ChatFileRow[] = [];
	const mockArtifactRows: ArtifactRow[] = [];
	const mockConversationIds = new Set<string>();

	const mockDeleteWhere = vi.fn(async (conversationId: string, fileId?: string) => {
		const indicesToRemove: number[] = [];
		mockRows.forEach((row, index) => {
			if (row.conversationId === conversationId && (!fileId || row.id === fileId)) {
				indicesToRemove.push(index);
			}
		});
		const removed = indicesToRemove.length;
		indicesToRemove.reverse().forEach((index) => {
			mockRows.splice(index, 1);
		});
		return removed;
	});

	const mockUnlink = vi.fn(() => Promise.resolve(undefined));
	const mockRm = vi.fn(() => Promise.resolve(undefined));
	const mockMkdir = vi.fn(() => Promise.resolve(undefined));
	const mockWriteFile = vi.fn(() => Promise.resolve(undefined));
	const mockReadFile = vi.fn(() => Promise.resolve(Buffer.from('test content')));
	const mockAccess = vi.fn(() => Promise.resolve(undefined));
	const mockCreateGeneratedOutputArtifact = vi.fn(async (params: { content: string; nameOverride?: string }) => ({
		id: 'artifact-1',
		userId: 'user-1',
		conversationId: 'conv-a',
		type: 'generated_output',
		retrievalClass: 'durable',
		name: params.nameOverride ?? 'result',
		mimeType: 'text/markdown',
		sizeBytes: params.content.length,
		storagePath: null,
		contentText: params.content,
		summary: 'summary',
		metadata: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
	}));
	const mockSyncArtifactToHoncho = vi.fn(async () => ({ uploaded: true, mode: 'native' }));
	const mockExtractDocumentText = vi.fn(async () => ({
		text: 'Extracted generated file text',
		normalizedName: 'generated.txt',
		mimeType: 'text/plain',
	}));

	return {
		mockRows,
		mockArtifactRows,
		mockConversationIds,
		mockDeleteWhere,
		mockUnlink,
		mockRm,
		mockMkdir,
		mockWriteFile,
		mockReadFile,
		mockAccess,
		mockCreateGeneratedOutputArtifact,
		mockSyncArtifactToHoncho,
		mockExtractDocumentText,
	};
});

vi.mock('fs/promises', () => ({
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

vi.mock('$lib/server/db', () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn((table: { __table?: string }) => ({
				where: vi.fn((condition: unknown) => ({
					orderBy: vi.fn(() => {
						const rows = selectRowsForTable(table, condition);
						return Object.assign(rows, {
							limit: vi.fn(async (count: number) => rows.slice(0, count)),
						});
					}),
					limit: vi.fn(async () => {
						return selectRowsForTable(table, condition).slice(0, 1);
					}),
				})),
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
					returning: vi.fn(() => Promise.resolve(itemsWithDate.map((item) => ({ ...item })))),
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
								typeof values.assistantMessageId === 'string'
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
						c.field === 'id' && Array.isArray(c.value)
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
		const convCondition = condition.find((c: { field: string }) => c.field === 'conversationId');
		if (convCondition) return convCondition.value;
	}
	if (typeof condition === 'object' && condition !== null && 'field' in condition) {
		const c = condition as { field: string; value: string };
		if (c.field === 'conversationId') return c.value;
	}
	if (typeof condition === 'string') return condition;
	return '';
}

function extractFileId(condition: unknown): string | undefined {
	if (Array.isArray(condition)) {
		const idCondition = condition.find((c: { field: string }) => c.field === 'id');
		if (idCondition) return idCondition.value;
	}
	return undefined;
}

function extractFileIds(condition: unknown): string[] {
	if (Array.isArray(condition)) {
		const idCondition = condition.find((c: { field: string; value: string[] }) => c.field === 'id');
		if (idCondition && Array.isArray(idCondition.value)) return idCondition.value;
	}
	return [];
}

function extractUserId(condition: unknown): string | undefined {
	if (Array.isArray(condition)) {
		const userCondition = condition.find((c: { field: string }) => c.field === 'userId');
		if (userCondition) return userCondition.value;
	}
	if (typeof condition === 'object' && condition !== null && 'field' in condition) {
		const c = condition as { field: string; value: string };
		if (c.field === 'userId') return c.value;
	}
	return undefined;
}

function extractAssistantMessageId(condition: unknown): string | undefined {
	if (Array.isArray(condition)) {
		const assistantCondition = condition.find(
			(c: { field: string; operator?: string }) =>
				c.field === 'assistantMessageId' && c.operator !== 'isNotNull'
		);
		if (assistantCondition) return assistantCondition.value;
	}
	if (typeof condition === 'object' && condition !== null && 'field' in condition) {
		const c = condition as { field: string; value: string; operator?: string };
		if (c.field === 'assistantMessageId' && c.operator !== 'isNotNull') return c.value;
	}
	return undefined;
}

function requiresAssistantMessage(condition: unknown): boolean {
	if (Array.isArray(condition)) {
		return condition.some(
			(c: { field: string; operator?: string }) =>
				c.field === 'assistantMessageId' && c.operator === 'isNotNull'
		);
	}
	if (typeof condition === 'object' && condition !== null && 'field' in condition) {
		const c = condition as { field: string; operator?: string };
		return c.field === 'assistantMessageId' && c.operator === 'isNotNull';
	}
	return false;
}

function extractArtifactType(condition: unknown): string | undefined {
	if (Array.isArray(condition)) {
		const typeCondition = condition.find((c: { field: string }) => c.field === 'type');
		if (typeCondition) return typeCondition.value;
	}
	if (typeof condition === 'object' && condition !== null && 'field' in condition) {
		const c = condition as { field: string; value: string };
		if (c.field === 'type') return c.value;
	}
	return undefined;
}

function selectRowsForTable(
	table: { __table?: string },
	condition: unknown
): Array<ChatFileRow | ArtifactRow> {
	if (table.__table === 'conversations') {
		return Array.from(mockConversationIds).map((id) => ({ id }));
	}

	if (
		typeof condition === 'object' &&
		condition !== null &&
		(condition as { operator?: string }).operator === 'notInSubquery'
	) {
		const cond = condition as { operator: string; conversationIdSet: Set<string> };
		return mockRows
			.filter((row) => !cond.conversationIdSet.has(row.conversationId))
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.map((row) => ({ ...row }));
	}

	if (table.__table === 'artifacts') {
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
					(!type || row.type === type)
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
				(!assistantMessageId || row.assistantMessageId === assistantMessageId) &&
				(!assistantMessageRequired || row.assistantMessageId !== null)
		)
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
		.map((row) => ({ ...row }));
}

vi.mock('$lib/server/db/schema', () => ({
	artifacts: {
		__table: 'artifacts',
		id: { name: 'id' },
		userId: { name: 'userId' },
		type: { name: 'type' },
		retrievalClass: { name: 'retrievalClass' },
		name: { name: 'name' },
		mimeType: { name: 'mimeType' },
		sizeBytes: { name: 'sizeBytes' },
		conversationId: { name: 'conversationId' },
		summary: { name: 'summary' },
		metadataJson: { name: 'metadataJson' },
		createdAt: { name: 'createdAt' },
		updatedAt: { name: 'updatedAt' },
		storagePath: { name: 'storagePath' },
		contentText: { name: 'contentText' },
	},
	artifactLinks: {
		artifactId: { name: 'artifactId' },
		relatedArtifactId: { name: 'relatedArtifactId' },
		userId: { name: 'userId' },
		linkType: { name: 'linkType' },
	},
	chatGeneratedFiles: {
		__table: 'chatGeneratedFiles',
		id: { name: 'id' },
		conversationId: { name: 'conversationId' },
		assistantMessageId: { name: 'assistantMessageId' },
		userId: { name: 'userId' },
		filename: { name: 'filename' },
		mimeType: { name: 'mimeType' },
		sizeBytes: { name: 'sizeBytes' },
		storagePath: { name: 'storagePath' },
		createdAt: { name: 'createdAt' },
	},
	conversations: { __table: 'conversations', id: { name: 'id' } },
	users: { id: { name: 'id' } },
}));

vi.mock('drizzle-orm', () => ({
	and: vi.fn((...conditions: unknown[]) =>
		conditions.filter(
			(c): c is { field: string } => typeof c === 'object' && c !== null && 'field' in c
		)
	),
	desc: vi.fn(() => 'desc'),
	inArray: vi.fn((field: { name: string }, values: string[]) => ({ field: field.name, value: values })),
	isNotNull: vi.fn((field: { name: string }) => ({ field: field.name, operator: 'isNotNull' })),
	notInArray: vi.fn((field: { name: string }, _subquery: unknown) => ({
		field: field.name,
		operator: 'notInSubquery',
		conversationIdSet: mockConversationIds,
	})),
	eq: vi.fn((field: { name: string }, value: string) => ({ field: field.name, value })),
}));

vi.mock('$lib/server/services/knowledge', () => ({
	createArtifactLink: vi.fn(async () => undefined),
	createGeneratedOutputArtifact: (...args: unknown[]) => mockCreateGeneratedOutputArtifact(...args),
}));

vi.mock('$lib/server/services/honcho', () => ({
	syncArtifactToHoncho: (...args: unknown[]) => mockSyncArtifactToHoncho(...args),
}));

vi.mock('./document-extraction', () => ({
	extractDocumentText: (...args: unknown[]) => mockExtractDocumentText(...args),
}));

describe('chat-files service', () => {
	beforeEach(() => {
		mockRows.length = 0;
		mockArtifactRows.length = 0;
		mockConversationIds.clear();
		vi.clearAllMocks();
		mockRm.mockResolvedValue(undefined);
		vi.spyOn(console, 'info').mockImplementation(() => undefined);
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	describe('storeGeneratedFile', () => {
		it('creates file and database record', async () => {
			const { storeGeneratedFile } = await import('./chat-files');

			const file: FileInput = {
				filename: 'test-document.pdf',
				mimeType: 'application/pdf',
				content: Buffer.from('PDF content here'),
			};

			const result = await storeGeneratedFile('conv-123', 'user-456', file);

			expect(result).toMatchObject({
				conversationId: 'conv-123',
				assistantMessageId: null,
				userId: 'user-456',
				filename: 'test-document.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 16,
			});
			expect(result.id).toBeDefined();
			expect(result.storagePath).toMatch(/^conv-123\/[a-f0-9-]+\.pdf$/);
			expect(result.createdAt).toBeDefined();

			expect(mockRows).toHaveLength(1);
			expect(mockRows[0]).toMatchObject({
				conversationId: 'conv-123',
				assistantMessageId: null,
				userId: 'user-456',
				filename: 'test-document.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 16,
			});
		});

		it('handles files without extension', async () => {
			const { storeGeneratedFile } = await import('./chat-files');

			const file: FileInput = {
				filename: 'README',
				content: Buffer.from('Documentation'),
			};

			const result = await storeGeneratedFile('conv-123', 'user-456', file);

			expect(result.storagePath).toMatch(/\.bin$/);
		});

		it('handles Uint8Array content', async () => {
			const { storeGeneratedFile } = await import('./chat-files');

			const file: FileInput = {
				filename: 'data.json',
				mimeType: 'application/json',
				content: new Uint8Array([123, 34, 107, 101, 121, 34, 58, 34, 118, 97, 108, 117, 101, 34, 125]),
			};

			const result = await storeGeneratedFile('conv-123', 'user-456', file);

			expect(result.sizeBytes).toBe(15);
			expect(result.mimeType).toBe('application/json');
		});
	});

	describe('getChatFiles', () => {
		it('hides unassigned staged files from the conversation generated files surface', async () => {
			const { getChatFiles } = await import('./chat-files');

			mockRows.push(
				{
					id: 'file-staged-orphan',
					conversationId: 'conv-a',
					assistantMessageId: null,
					userId: 'user-1',
					filename: 'partial.csv',
					mimeType: 'text/csv',
					sizeBytes: 1000,
					storagePath: 'conv-a/file-staged-orphan.csv',
					createdAt: new Date('2026-01-04'),
				},
				{
					id: 'file-visible',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-a',
					userId: 'user-1',
					filename: 'report.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2000,
					storagePath: 'conv-a/file-visible.pdf',
					createdAt: new Date('2026-01-03'),
				}
			);

			const result = await getChatFiles('conv-a');

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				id: 'file-visible',
				assistantMessageId: 'assistant-a',
			});
			expect(result.map((file) => file.id)).not.toContain('file-staged-orphan');
		});

		it('returns only files for the specified conversation', async () => {
			const { getChatFiles } = await import('./chat-files');

			mockRows.push(
				{
					id: 'file-1',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-a',
					userId: 'user-1',
					filename: 'doc1.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 1000,
					storagePath: 'conv-a/file-1.pdf',
					createdAt: new Date('2026-01-01'),
				},
				{
					id: 'file-2',
					conversationId: 'conv-b',
					assistantMessageId: null,
					userId: 'user-1',
					filename: 'doc2.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2000,
					storagePath: 'conv-b/file-2.pdf',
					createdAt: new Date('2026-01-02'),
				},
				{
					id: 'file-3',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-c',
					userId: 'user-1',
					filename: 'doc3.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 3000,
					storagePath: 'conv-a/file-3.pdf',
					createdAt: new Date('2026-01-03'),
				}
			);

			const result = await getChatFiles('conv-a');

			expect(result).toHaveLength(2);
			expect(result.map((f) => f.id)).toContain('file-1');
			expect(result.map((f) => f.id)).toContain('file-3');
			expect(result.map((f) => f.id)).not.toContain('file-2');
		});

		it('returns empty array when conversation has no files', async () => {
			const { getChatFiles } = await import('./chat-files');

			const result = await getChatFiles('conv-empty');

			expect(result).toEqual([]);
		});

		it('returns files sorted by createdAt descending', async () => {
			const { getChatFiles } = await import('./chat-files');

			mockRows.push(
				{
					id: 'file-1',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-a',
					userId: 'user-1',
					filename: 'oldest.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 1000,
					storagePath: 'conv-a/file-1.pdf',
					createdAt: new Date('2026-01-01'),
				},
				{
					id: 'file-2',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-b',
					userId: 'user-1',
					filename: 'newest.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2000,
					storagePath: 'conv-a/file-2.pdf',
					createdAt: new Date('2026-01-03'),
				}
			);

			const result = await getChatFiles('conv-a');

			expect(result[0].filename).toBe('newest.pdf');
			expect(result[1].filename).toBe('oldest.pdf');
		});

		it('returns only files for the specified assistant message when requested', async () => {
			const { getChatFilesForAssistantMessage } = await import('./chat-files');

			mockRows.push(
				{
					id: 'file-1',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-a',
					userId: 'user-1',
					filename: 'oldest.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 1000,
					storagePath: 'conv-a/file-1.pdf',
					createdAt: new Date('2026-01-01'),
				},
				{
					id: 'file-2',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-b',
					userId: 'user-1',
					filename: 'newest.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2000,
					storagePath: 'conv-a/file-2.pdf',
					createdAt: new Date('2026-01-03'),
				}
			);

			const result = await getChatFilesForAssistantMessage('conv-a', 'assistant-b');

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('file-2');
			expect(result[0].assistantMessageId).toBe('assistant-b');
		});
	});

	describe('assignGeneratedFilesToAssistantMessage', () => {
		it('updates only matching files in a conversation', async () => {
			const { assignGeneratedFilesToAssistantMessage } = await import('./chat-files');

			mockRows.push(
				{
					id: 'file-1',
					conversationId: 'conv-a',
					assistantMessageId: null,
					userId: 'user-1',
					filename: 'doc1.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 1000,
					storagePath: 'conv-a/file-1.pdf',
					createdAt: new Date('2026-01-01'),
				},
				{
					id: 'file-2',
					conversationId: 'conv-b',
					assistantMessageId: null,
					userId: 'user-1',
					filename: 'doc2.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2000,
					storagePath: 'conv-b/file-2.pdf',
					createdAt: new Date('2026-01-02'),
				}
			);

			await assignGeneratedFilesToAssistantMessage('conv-a', 'assistant-a', ['file-1']);

			expect(mockRows[0].assistantMessageId).toBe('assistant-a');
			expect(mockRows[1].assistantMessageId).toBeNull();
		});
	});

	describe('getChatFile', () => {
		it('returns file when found in conversation', async () => {
			const { getChatFile } = await import('./chat-files');

			mockRows.push({
				id: 'file-1',
				conversationId: 'conv-a',
				assistantMessageId: null,
				userId: 'user-1',
				filename: 'document.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 5000,
				storagePath: 'conv-a/file-1.pdf',
				createdAt: new Date('2026-01-01'),
			});

			const result = await getChatFile('conv-a', 'file-1');

			expect(result).toMatchObject({
				id: 'file-1',
				conversationId: 'conv-a',
				filename: 'document.pdf',
			});
		});

		it('returns null when file not found', async () => {
			const { getChatFile } = await import('./chat-files');

			const result = await getChatFile('conv-a', 'nonexistent');

			expect(result).toBeNull();
		});

		it('returns null when file exists in different conversation', async () => {
			const { getChatFile } = await import('./chat-files');

			mockRows.push({
				id: 'file-1',
				conversationId: 'conv-b',
				assistantMessageId: null,
				userId: 'user-1',
				filename: 'document.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 5000,
				storagePath: 'conv-b/file-1.pdf',
				createdAt: new Date('2026-01-01'),
			});

			const result = await getChatFile('conv-a', 'file-1');

			expect(result).toBeNull();
		});
	});

	describe('getChatFileByUser', () => {
		it('returns a file when the user owns it', async () => {
			const { getChatFileByUser } = await import('./chat-files');

			mockRows.push({
				id: 'file-7',
				conversationId: 'conv-a',
				assistantMessageId: null,
				userId: 'user-7',
				filename: 'owned.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 1234,
				storagePath: 'conv-a/file-7.pdf',
				createdAt: new Date('2026-01-01'),
			});

			const result = await getChatFileByUser('file-7', 'user-7');

			expect(result).toMatchObject({
				id: 'file-7',
				userId: 'user-7',
				filename: 'owned.pdf',
			});
		});

		it('returns null when the file belongs to a different user', async () => {
			const { getChatFileByUser } = await import('./chat-files');

			mockRows.push({
				id: 'file-8',
				conversationId: 'conv-a',
				assistantMessageId: null,
				userId: 'user-8',
				filename: 'private.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 1234,
				storagePath: 'conv-a/file-8.pdf',
				createdAt: new Date('2026-01-01'),
			});

			const result = await getChatFileByUser('file-8', 'user-7');

			expect(result).toBeNull();
		});
	});

	describe('syncGeneratedFilesToMemory', () => {
		it('uses the canonical source artifact for source-first rendered document files', async () => {
			const { syncGeneratedFilesToMemory } = await import('./chat-files');
			const now = new Date('2026-01-01T12:00:00.000Z');
			mockRows.push(
				{
					id: 'file-source-pdf',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-a',
					userId: 'user-1',
					filename: 'report.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 5000,
					storagePath: 'conv-a/file-source-pdf.pdf',
					createdAt: now,
				},
				{
					id: 'file-source-html',
					conversationId: 'conv-a',
					assistantMessageId: 'assistant-a',
					userId: 'user-1',
					filename: 'report.html',
					mimeType: 'text/html',
					sizeBytes: 4000,
					storagePath: 'conv-a/file-source-html.html',
					createdAt: now,
				}
			);
			mockArtifactRows.push({
				id: 'artifact-source-1',
				userId: 'user-1',
				type: 'generated_output',
				retrievalClass: 'durable',
				name: 'Source-first report',
				mimeType: 'application/vnd.alfyai.generated-document+json',
				sizeBytes: null,
				conversationId: 'conv-a',
				summary: 'Source-first report',
				metadataJson: JSON.stringify({
					generatedDocumentSourceVersion: 1,
					generatedDocumentSource: {
						version: 1,
						template: 'alfyai_standard_report',
						title: 'Source-first report',
					},
					fileProductionJobId: 'job-source-1',
					documentFamilyId: 'artifact-source-1',
					documentFamilyStatus: 'active',
					documentLabel: 'Source-first report',
					versionNumber: 1,
					originConversationId: 'conv-a',
					originAssistantMessageId: 'assistant-a',
					originalChatFileId: 'file-source-pdf',
					sourceChatFileId: 'file-source-pdf',
					generatedDocumentRenderedChatFileIds: [
						'file-source-pdf',
						'file-source-html',
					],
				}),
				contentText: 'Source-first report\n\nCanonical generated document source text.',
				extension: 'alfyidoc.json',
				storagePath: null,
				createdAt: now,
				updatedAt: now,
			});

			await syncGeneratedFilesToMemory({
				userId: 'user-1',
				conversationId: 'conv-a',
				assistantMessageId: 'assistant-a',
				fileIds: ['file-source-pdf', 'file-source-html'],
				assistantResponse: 'Here is the report.',
			});

			expect(mockAccess).not.toHaveBeenCalled();
			expect(mockReadFile).not.toHaveBeenCalled();
			expect(mockExtractDocumentText).not.toHaveBeenCalled();
			expect(mockCreateGeneratedOutputArtifact).not.toHaveBeenCalled();
			expect(mockSyncArtifactToHoncho).toHaveBeenCalledTimes(1);
			expect(mockSyncArtifactToHoncho).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: 'user-1',
					conversationId: 'conv-a',
					artifact: expect.objectContaining({
						id: 'artifact-source-1',
						contentText: expect.stringContaining('Canonical generated document source text.'),
					}),
					fallbackTextArtifact: expect.objectContaining({
						id: 'artifact-source-1',
					}),
				})
			);
		});

		it('preserves generated-file version metadata when text extraction fails', async () => {
			const { getChatFile, syncGeneratedFilesToMemory } = await import('./chat-files');
			mockExtractDocumentText.mockRejectedValueOnce(new Error('parser failed'));
			mockRows.push({
				id: 'file-1',
				conversationId: 'conv-a',
				assistantMessageId: 'assistant-a',
				userId: 'user-1',
				filename: 'report.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 5000,
				storagePath: 'conv-a/file-1.pdf',
				createdAt: new Date('2026-01-01'),
			});
			expect(await getChatFile('conv-a', 'file-1')).toMatchObject({
				id: 'file-1',
			});

			await syncGeneratedFilesToMemory({
				userId: 'user-1',
				conversationId: 'conv-a',
				assistantMessageId: 'assistant-a',
				fileIds: ['file-1'],
				assistantResponse: 'Here is the report.',
			});

			expect(console.error).not.toHaveBeenCalled();
			expect(mockAccess).toHaveBeenCalled();
			expect(mockReadFile).toHaveBeenCalled();
			expect(mockExtractDocumentText).toHaveBeenCalled();
			expect(mockCreateGeneratedOutputArtifact).toHaveBeenCalledWith(
				expect.objectContaining({
					nameOverride: 'report.pdf',
					metadata: expect.objectContaining({
						originalChatFileId: 'file-1',
						generatedFilename: 'report.pdf',
						generatedFileVersion: 1,
						versionNumber: 1,
						sourceChatFileId: 'file-1',
					}),
				})
			);
			expect(mockCreateGeneratedOutputArtifact.mock.calls[0][0].content).toContain(
				'Generated file version: v1'
			);
			expect(console.warn).toHaveBeenCalledWith(
				'[CHAT_FILES] Generated file text extraction failed; preserving version metadata',
				expect.objectContaining({
					fileId: 'file-1',
					filename: 'report.pdf',
				})
			);
		});
	});

	describe('deleteChatFile', () => {
		it('deletes file and returns true when found', async () => {
			const { deleteChatFile } = await import('./chat-files');

			mockRows.push({
				id: 'file-1',
				conversationId: 'conv-a',
				assistantMessageId: null,
				userId: 'user-1',
				filename: 'document.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 5000,
				storagePath: 'conv-a/file-1.pdf',
				createdAt: new Date('2026-01-01'),
			});

			const result = await deleteChatFile('conv-a', 'file-1');

			expect(result).toBe(true);
			expect(mockRows).toHaveLength(0);
		});

		it('returns false when file not found', async () => {
			const { deleteChatFile } = await import('./chat-files');

			const result = await deleteChatFile('conv-a', 'nonexistent');

			expect(result).toBe(false);
		});

		it('returns false when file exists in different conversation', async () => {
			const { deleteChatFile } = await import('./chat-files');

			mockRows.push({
				id: 'file-1',
				conversationId: 'conv-b',
				assistantMessageId: null,
				userId: 'user-1',
				filename: 'document.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 5000,
				storagePath: 'conv-b/file-1.pdf',
				createdAt: new Date('2026-01-01'),
			});

			const result = await deleteChatFile('conv-a', 'file-1');

			expect(result).toBe(false);
			expect(mockRows).toHaveLength(1);
		});
	});

	describe('deleteAllChatFilesForConversation', () => {
		it('deletes all files for conversation and returns count', async () => {
			const { deleteAllChatFilesForConversation } = await import('./chat-files');

			mockRows.push(
				{
					id: 'file-1',
					conversationId: 'conv-a',
					assistantMessageId: null,
					userId: 'user-1',
					filename: 'doc1.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 1000,
					storagePath: 'conv-a/file-1.pdf',
					createdAt: new Date('2026-01-01'),
				},
				{
					id: 'file-2',
					conversationId: 'conv-a',
					assistantMessageId: null,
					userId: 'user-1',
					filename: 'doc2.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2000,
					storagePath: 'conv-a/file-2.pdf',
					createdAt: new Date('2026-01-02'),
				},
				{
					id: 'file-3',
					conversationId: 'conv-b',
					assistantMessageId: null,
					userId: 'user-1',
					filename: 'other.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 3000,
					storagePath: 'conv-b/file-3.pdf',
					createdAt: new Date('2026-01-03'),
				}
			);

			await deleteAllChatFilesForConversation('conv-a');

			expect(mockRows).toHaveLength(1);
			expect(mockRows[0].id).toBe('file-3');
		});

		it('returns 0 when conversation has no files', async () => {
			const { deleteAllChatFilesForConversation } = await import('./chat-files');

			const result = await deleteAllChatFilesForConversation('conv-empty');

			expect(result).toBe(0);
		});
	});

	describe('deleteOrphanChatFiles', () => {
		it('deletes chat-generated file rows whose parent conversation no longer exists', async () => {
			const { deleteOrphanChatFiles } = await import('./chat-files');

			// conv-a exists, conv-orphan-1 and conv-orphan-2 do not
			mockConversationIds.add('conv-a');
			mockConversationIds.add('conv-b');

			mockRows.push(
				{
					id: 'file-active',
					conversationId: 'conv-a',
					assistantMessageId: 'msg-1',
					userId: 'user-1',
					filename: 'active-report.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 5000,
					storagePath: 'conv-a/file-active.pdf',
					createdAt: new Date('2026-01-01'),
				},
				{
					id: 'file-orphan-1',
					conversationId: 'conv-orphan-1',
					assistantMessageId: 'msg-2',
					userId: 'user-1',
					filename: 'orphan-report.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 3000,
					storagePath: 'conv-orphan-1/file-orphan-1.pdf',
					createdAt: new Date('2026-01-02'),
				},
				{
					id: 'file-orphan-2',
					conversationId: 'conv-orphan-2',
					assistantMessageId: 'msg-3',
					userId: 'user-1',
					filename: 'orphan-report-2.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2000,
					storagePath: 'conv-orphan-2/file-orphan-2.pdf',
					createdAt: new Date('2026-01-03'),
				}
			);

			const deletedCount = await deleteOrphanChatFiles();

			expect(deletedCount).toBe(2);
			expect(mockRows).toHaveLength(1);
			expect(mockRows[0].id).toBe('file-active');
		});

		it('returns 0 when there are no orphan files', async () => {
			const { deleteOrphanChatFiles } = await import('./chat-files');

			mockConversationIds.add('conv-a');
			mockConversationIds.add('conv-b');

			mockRows.push(
				{
					id: 'file-1',
					conversationId: 'conv-a',
					assistantMessageId: 'msg-1',
					userId: 'user-1',
					filename: 'doc1.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 1000,
					storagePath: 'conv-a/file-1.pdf',
					createdAt: new Date('2026-01-01'),
				},
				{
					id: 'file-2',
					conversationId: 'conv-b',
					assistantMessageId: 'msg-2',
					userId: 'user-1',
					filename: 'doc2.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2000,
					storagePath: 'conv-b/file-2.pdf',
					createdAt: new Date('2026-01-02'),
				}
			);

			const result = await deleteOrphanChatFiles();

			expect(result).toBe(0);
			expect(mockRows).toHaveLength(2);
		});

		it('returns 0 when there are no chat files at all', async () => {
			const { deleteOrphanChatFiles } = await import('./chat-files');

			mockConversationIds.add('conv-a');

			const result = await deleteOrphanChatFiles();

			expect(result).toBe(0);
		});
	});
});
