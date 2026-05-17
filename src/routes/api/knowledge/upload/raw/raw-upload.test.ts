import { createHash } from 'crypto';
import { rm } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/hooks', () => ({
	requireAuth: vi.fn(),
}));

vi.mock('$lib/server/services/knowledge', () => ({
	createNormalizedArtifact: vi.fn(),
	resolvePromptAttachmentArtifacts: vi.fn(),
	saveUploadedArtifactFromStoredFile: vi.fn(),
}));

vi.mock('$lib/server/services/honcho', () => ({
	syncArtifactToHoncho: vi.fn(),
}));

vi.mock('$lib/server/services/attachment-trace', () => ({
	createAttachmentTraceId: vi.fn(() => 'trace-upload'),
	logAttachmentTrace: vi.fn(),
}));

vi.mock('$lib/server/services/conversations', () => ({
	getConversation: vi.fn(),
}));

import { POST } from './+server';
import { requireAuth } from '$lib/server/auth/hooks';
import {
	createNormalizedArtifact,
	resolvePromptAttachmentArtifacts,
	saveUploadedArtifactFromStoredFile,
} from '$lib/server/services/knowledge';
import { syncArtifactToHoncho } from '$lib/server/services/honcho';
import { getConversation } from '$lib/server/services/conversations';

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCreateNormalizedArtifact = createNormalizedArtifact as ReturnType<typeof vi.fn>;
const mockResolvePromptAttachmentArtifacts = resolvePromptAttachmentArtifacts as ReturnType<typeof vi.fn>;
const mockSaveUploadedArtifactFromStoredFile = saveUploadedArtifactFromStoredFile as ReturnType<typeof vi.fn>;
const mockSyncArtifactToHoncho = syncArtifactToHoncho as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;

function makeRawUploadEvent(body: BodyInit, headers: Record<string, string>) {
	return {
		request: new Request('http://localhost/api/knowledge/upload/raw', {
			method: 'POST',
			headers,
			body,
		}),
		locals: { user: { id: 'user-1', email: 'test@example.com' } },
		params: {},
		url: new URL('http://localhost/api/knowledge/upload/raw'),
		route: { id: '/api/knowledge/upload/raw' },
	} as any;
}

describe('POST /api/knowledge/upload/raw', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversation.mockResolvedValue({
			id: 'conv-1',
			title: 'Test Conversation',
			projectId: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		mockSyncArtifactToHoncho.mockResolvedValue({ uploaded: true, mode: 'native' });
		mockCreateNormalizedArtifact.mockResolvedValue(null);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [],
			promptArtifacts: [],
			items: [],
			unresolvedItems: [],
		});
		mockSaveUploadedArtifactFromStoredFile.mockResolvedValue({
			artifact: {
				id: 'artifact-1',
				type: 'source_document',
				retrievalClass: 'durable',
				name: 'scan.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 5,
				conversationId: 'conv-1',
				summary: 'scan.pdf',
				storagePath: 'data/knowledge/user-1/artifact-1.pdf',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			normalizedArtifact: null,
		});
	});

	afterEach(async () => {
		consoleInfoSpy?.mockRestore();
		consoleWarnSpy?.mockRestore();
		consoleInfoSpy = null;
		consoleWarnSpy = null;
		await rm(join(process.cwd(), 'data', 'knowledge', 'user-1', '.incoming'), {
			force: true,
			recursive: true,
		});
	});

	it('streams the raw file body to temporary storage and persists a source artifact', async () => {
		const bytes = Buffer.from('hello');
		const response = await POST(
			makeRawUploadEvent(bytes, {
				'content-type': 'application/pdf',
				'x-alfyai-upload-name': encodeURIComponent('scan.pdf'),
				'x-alfyai-upload-size': String(bytes.length),
				'x-alfyai-upload-trace-id': 'upload-rawtest',
				'x-alfyai-conversation-id': 'conv-1',
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.artifact.id).toBe('artifact-1');
		expect(mockSaveUploadedArtifactFromStoredFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user-1',
				conversationId: 'conv-1',
				fileName: 'scan.pdf',
				mimeType: 'application/pdf',
				sizeBytes: bytes.length,
				binaryHash: createHash('sha256').update(bytes).digest('hex'),
				tempPathAbsolute: expect.stringContaining('.incoming'),
			}),
		);
		expect(consoleInfoSpy).toHaveBeenCalledWith(
			'[KNOWLEDGE] Raw upload receive completed',
			expect.objectContaining({
				traceId: 'upload-rawtest',
				receivedBytes: bytes.length,
			}),
		);
	});

	it('rejects raw uploads when the declared browser size does not match received bytes', async () => {
		const response = await POST(
			makeRawUploadEvent(Buffer.from('hello'), {
				'content-type': 'application/pdf',
				'x-alfyai-upload-name': 'scan.pdf',
				'x-alfyai-upload-size': '6',
				'x-alfyai-upload-trace-id': 'upload-mismatch',
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe('upload_size_mismatch');
		expect(mockSaveUploadedArtifactFromStoredFile).not.toHaveBeenCalled();
	});
});
