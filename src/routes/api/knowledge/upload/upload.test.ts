import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/hooks', () => ({
	requireAuth: vi.fn(),
}));

vi.mock('$lib/server/services/knowledge', () => ({
	createNormalizedArtifact: vi.fn(),
	resolvePromptAttachmentArtifacts: vi.fn(),
	saveUploadedArtifact: vi.fn(),
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
	saveUploadedArtifact,
} from '$lib/server/services/knowledge';
import { syncArtifactToHoncho } from '$lib/server/services/honcho';
import { getConversation } from '$lib/server/services/conversations';

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCreateNormalizedArtifact = createNormalizedArtifact as ReturnType<typeof vi.fn>;
const mockResolvePromptAttachmentArtifacts = resolvePromptAttachmentArtifacts as ReturnType<typeof vi.fn>;
const mockSaveUploadedArtifact = saveUploadedArtifact as ReturnType<typeof vi.fn>;
const mockSyncArtifactToHoncho = syncArtifactToHoncho as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;

function makeEventWithFormData(formData: FormData) {
	return {
		request: {
			formData: vi.fn().mockResolvedValue(formData),
			headers: {
				get: vi.fn().mockReturnValue(null),
			},
		},
		locals: { user: { id: 'user-1', email: 'test@example.com' } },
		params: {},
		url: new URL('http://localhost/api/knowledge/upload'),
		route: { id: '/api/knowledge/upload' },
	} as any;
}

describe('POST /api/knowledge/upload', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		mockRequireAuth.mockReturnValue(undefined);
		mockSyncArtifactToHoncho.mockResolvedValue({ uploaded: true, mode: 'native' });
		mockCreateNormalizedArtifact.mockResolvedValue(null);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [],
			promptArtifacts: [],
			items: [],
			unresolvedItems: [],
		});
		mockGetConversation.mockResolvedValue({
			id: 'conv-1',
			title: 'Test Conversation',
			projectId: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});

	afterEach(() => {
		consoleInfoSpy?.mockRestore();
		consoleInfoSpy = null;
	});

	it('rejects files larger than 100MB', async () => {
		const formData = new FormData();
		const file = new File(['tiny'], 'large.pdf', { type: 'application/pdf' });
		Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 + 1 });
		formData.append('file', file);
		formData.append('conversationId', 'conv-1');

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/100MB/i);
		expect(mockSaveUploadedArtifact).not.toHaveBeenCalled();
	});

	it('returns prompt-ready metadata when a normalized artifact exists', async () => {
		const artifact = {
			id: 'artifact-1',
			type: 'source_document',
			retrievalClass: 'durable',
			name: 'recipe.pdf',
			mimeType: 'application/pdf',
			sizeBytes: 1024,
			conversationId: 'conv-1',
			summary: 'Recipe',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const normalizedArtifact = {
			id: 'normalized-1',
			type: 'normalized_document',
			retrievalClass: 'durable',
			name: 'recipe.txt',
			mimeType: 'text/plain',
			sizeBytes: 400,
			conversationId: 'conv-1',
			summary: 'Recipe text',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact,
			reusedExistingArtifact: false,
			normalizedArtifact,
		});
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [artifact],
			promptArtifacts: [normalizedArtifact],
			items: [
				{
					requestedArtifactId: artifact.id,
					displayArtifact: artifact,
					promptArtifact: normalizedArtifact,
					promptReady: true,
					readinessError: null,
					contentLength: 320,
					contentPreview: 'Recipe text',
					contentHash: 'hash-1',
					chunkCount: 2,
				},
			],
			unresolvedItems: [],
		});

		const formData = new FormData();
		formData.append('file', new File(['recipe'], 'recipe.pdf', { type: 'application/pdf' }));
		formData.append('conversationId', 'conv-1');

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.promptReady).toBe(true);
		expect(data.promptArtifactId).toBe('normalized-1');
		expect(data.readinessError).toBeNull();
	});

	it('keeps upload successful when Honcho native sync is unsupported and fallback sync succeeds', async () => {
		const artifact = {
			id: 'artifact-image-415',
			type: 'source_document',
			retrievalClass: 'durable',
			name: 'photo.png',
			mimeType: 'image/png',
			sizeBytes: 1024,
			conversationId: 'conv-1',
			summary: 'Image OCR',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const normalizedArtifact = {
			id: 'normalized-image-415',
			type: 'normalized_document',
			retrievalClass: 'durable',
			name: 'photo.txt',
			mimeType: 'text/plain',
			sizeBytes: 240,
			conversationId: 'conv-1',
			summary: 'OCR text',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		mockSaveUploadedArtifact.mockResolvedValue({
			artifact,
			reusedExistingArtifact: false,
			normalizedArtifact,
		});
		mockSyncArtifactToHoncho
			.mockResolvedValueOnce({ uploaded: false, mode: 'none' })
			.mockResolvedValueOnce({ uploaded: true, mode: 'normalized' });
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [artifact],
			promptArtifacts: [normalizedArtifact],
			items: [
				{
					requestedArtifactId: artifact.id,
					displayArtifact: artifact,
					promptArtifact: normalizedArtifact,
					promptReady: true,
					readinessError: null,
					contentLength: 220,
					contentPreview: 'Detected text from image OCR',
					contentHash: 'hash-image-415',
					chunkCount: 2,
				},
			],
			unresolvedItems: [],
		});

		const formData = new FormData();
		formData.append('file', new File(['image'], 'photo.png', { type: 'image/png' }));
		formData.append('conversationId', 'conv-1');

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.promptReady).toBe(true);
		expect(data.readinessError).toBeNull();
		expect(data.honcho).toEqual({ uploaded: true, mode: 'normalized' });
		expect(mockSyncArtifactToHoncho).toHaveBeenCalledTimes(2);
	});

	it('returns a readiness error when the file cannot be normalized for chat', async () => {
		const artifact = {
			id: 'artifact-2',
			type: 'source_document',
			retrievalClass: 'durable',
			name: 'scan.pdf',
			mimeType: 'application/pdf',
			sizeBytes: 1024,
			conversationId: 'conv-1',
			summary: 'Scan',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact,
			reusedExistingArtifact: false,
			normalizedArtifact: null,
		});
		mockSyncArtifactToHoncho.mockResolvedValue({ uploaded: false, mode: 'none' });
		mockCreateNormalizedArtifact.mockResolvedValue(null);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [artifact],
			promptArtifacts: [],
			items: [
				{
					requestedArtifactId: artifact.id,
					displayArtifact: artifact,
					promptArtifact: null,
					promptReady: false,
					readinessError: 'This file could not be prepared for chat.',
					contentLength: 0,
					contentPreview: null,
					contentHash: null,
					chunkCount: 0,
				},
			],
			unresolvedItems: [
				{
					requestedArtifactId: artifact.id,
					displayArtifact: artifact,
					promptArtifact: null,
					promptReady: false,
					readinessError: 'This file could not be prepared for chat.',
					contentLength: 0,
					contentPreview: null,
					contentHash: null,
					chunkCount: 0,
				},
			],
		});

		const formData = new FormData();
		formData.append('file', new File(['scan'], 'scan.pdf', { type: 'application/pdf' }));
		formData.append('conversationId', 'conv-1');

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.promptReady).toBe(false);
		expect(data.promptArtifactId).toBeNull();
		expect(data.readinessError).toMatch(/could not be prepared for chat/i);
	});

	it('returns promptReady false when the normalized artifact exists but the extracted content is too thin', async () => {
		const artifact = {
			id: 'artifact-3',
			type: 'source_document',
			retrievalClass: 'durable',
			name: 'emptyish.pdf',
			mimeType: 'application/pdf',
			sizeBytes: 1024,
			conversationId: 'conv-1',
			summary: 'Thin extraction',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const normalizedArtifact = {
			id: 'normalized-3',
			type: 'normalized_document',
			retrievalClass: 'durable',
			name: 'emptyish.txt',
			mimeType: 'text/plain',
			sizeBytes: 12,
			conversationId: 'conv-1',
			summary: 'Thin text',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact,
			reusedExistingArtifact: false,
			normalizedArtifact,
		});
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [artifact],
			promptArtifacts: [],
			items: [
				{
					requestedArtifactId: artifact.id,
					displayArtifact: artifact,
					promptArtifact: normalizedArtifact,
					promptReady: false,
					readinessError: 'This file was uploaded, but no usable readable text could be prepared for chat from it.',
					contentLength: 8,
					contentPreview: 'Too thin',
					contentHash: 'hash-thin',
					chunkCount: 1,
				},
			],
			unresolvedItems: [],
		});

		const formData = new FormData();
		formData.append('file', new File(['thin'], 'emptyish.pdf', { type: 'application/pdf' }));
		formData.append('conversationId', 'conv-1');

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.promptReady).toBe(false);
		expect(data.promptArtifactId).toBeNull();
		expect(data.readinessError).toMatch(/usable readable text/i);
	});

	it('returns updated 413 guidance when multipart parsing exceeds the server limit', async () => {
		const event = {
			request: {
				formData: vi.fn().mockRejectedValue(new Error('request body size exceeded')),
				headers: {
					get: vi.fn().mockReturnValue('99999999'),
				},
			},
			locals: { user: { id: 'user-1', email: 'test@example.com' } },
			params: {},
			url: new URL('http://localhost/api/knowledge/upload'),
			route: { id: '/api/knowledge/upload' },
		} as any;

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(413);
		expect(data.error).toMatch(/100MB/i);
		expect(data.error).toMatch(/BODY_SIZE_LIMIT/i);
	});

	it('rejects oversized multipart bodies before parsing them', async () => {
		const formData = vi.fn();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const event = {
			request: {
				formData,
				headers: {
					get: vi.fn().mockReturnValue(String(102 * 1024 * 1024)),
				},
			},
			locals: { user: { id: 'user-1', email: 'test@example.com' } },
			params: {},
			url: new URL('http://localhost/api/knowledge/upload'),
			route: { id: '/api/knowledge/upload' },
		} as any;

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(413);
		expect(data.code).toBe('upload_body_too_large');
		expect(data.error).toMatch(/BODY_SIZE_LIMIT/i);
		expect(formData).not.toHaveBeenCalled();
		expect(mockSaveUploadedArtifact).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('rejects uploads above the adapter BODY_SIZE_LIMIT before multipart parsing', async () => {
		const originalBodySizeLimit = process.env.BODY_SIZE_LIMIT;
		process.env.BODY_SIZE_LIMIT = '40M';
		const formData = vi.fn();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const event = {
			request: {
				formData,
				headers: {
					get: vi.fn((name: string) => {
						const normalized = name.toLowerCase();
						if (normalized === 'content-length') return String(47 * 1024 * 1024);
						if (normalized === 'x-alfyai-upload-name') return encodeURIComponent('large.pdf');
						if (normalized === 'x-alfyai-upload-size') return String(46 * 1024 * 1024);
						return null;
					}),
				},
			},
			locals: { user: { id: 'user-1', email: 'test@example.com' } },
			params: {},
			url: new URL('http://localhost/api/knowledge/upload'),
			route: { id: '/api/knowledge/upload' },
		} as any;

		try {
			const response = await POST(event);
			const data = await response.json();

			expect(response.status).toBe(413);
			expect(data.code).toBe('upload_body_too_large');
			expect(data.error).toMatch(/40MB/i);
			expect(data.details.fileName).toBe('large.pdf');
			expect(formData).not.toHaveBeenCalled();
		} finally {
			if (originalBodySizeLimit === undefined) {
				delete process.env.BODY_SIZE_LIMIT;
			} else {
				process.env.BODY_SIZE_LIMIT = originalBodySizeLimit;
			}
			warnSpy.mockRestore();
		}
	});

	it('returns an explicit upload aborted error when multipart parsing is interrupted', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const event = {
			request: {
				formData: vi.fn().mockRejectedValue(new Error('aborted')),
				headers: {
					get: vi.fn((name: string) => {
						const normalized = name.toLowerCase();
						if (normalized === 'content-length') return '19021532';
						if (normalized === 'x-alfyai-upload-name') return encodeURIComponent('Quarterly report.pdf');
						if (normalized === 'x-alfyai-upload-size') return '18874368';
						return null;
					}),
				},
				signal: { aborted: true },
			},
			locals: { user: { id: 'user-1', email: 'test@example.com' } },
			params: {},
			url: new URL('http://localhost/api/knowledge/upload'),
			route: { id: '/api/knowledge/upload' },
		} as any;

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe('upload_aborted');
		expect(data.error).toMatch(/Quarterly report\.pdf/i);
		expect(data.error).toMatch(/BODY_SIZE_LIMIT/i);
		expect(data.details.classification).toBe('connection_closed_before_multipart_parse');
		expect(data.details.requestSignalAborted).toBe(true);
		expect(mockSaveUploadedArtifact).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('uploads a conversation-scoped attachment', async () => {
		const artifact = {
			id: 'artifact-1',
			type: 'source_document',
			retrievalClass: 'durable',
			name: 'doc.pdf',
			mimeType: 'application/pdf',
			sizeBytes: 1024,
			conversationId: 'conv-1',
			summary: 'Doc',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact,
			reusedExistingArtifact: false,
			normalizedArtifact: null,
		});
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [artifact],
			promptArtifacts: [],
			items: [
				{
					requestedArtifactId: artifact.id,
					displayArtifact: artifact,
					promptArtifact: null,
					promptReady: true,
					readinessError: null,
					contentLength: 0,
					contentPreview: null,
					contentHash: null,
					chunkCount: 0,
				},
			],
			unresolvedItems: [],
		});

		const formData = new FormData();
		formData.append('file', new File(['doc'], 'doc.pdf', { type: 'application/pdf' }));
		formData.append('conversationId', 'conv-1');

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockSaveUploadedArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user-1',
				conversationId: 'conv-1',
			})
		);
	});

	it('returns 400 when conversationId does not exist', async () => {
		mockGetConversation.mockResolvedValue(null);

		const formData = new FormData();
		formData.append('file', new File(['doc'], 'doc.pdf', { type: 'application/pdf' }));
		formData.append('conversationId', 'missing-conv');

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/conversation not found/i);
		expect(mockSaveUploadedArtifact).not.toHaveBeenCalled();
	});
});
