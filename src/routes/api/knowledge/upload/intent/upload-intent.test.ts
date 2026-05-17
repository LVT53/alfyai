import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/hooks', () => ({
	requireAuth: vi.fn(),
}));

vi.mock('$lib/server/services/attachment-trace', () => ({
	createAttachmentTraceId: vi.fn(() => 'trace-upload'),
}));

import { POST } from './+server';
import { requireAuth } from '$lib/server/auth/hooks';

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;

function makeEvent(payload: unknown) {
	return {
		request: {
			json: vi.fn().mockResolvedValue(payload),
		},
		locals: { user: { id: 'user-1', email: 'test@example.com' } },
		params: {},
		url: new URL('http://localhost/api/knowledge/upload/intent'),
		route: { id: '/api/knowledge/upload/intent' },
	} as any;
}

describe('POST /api/knowledge/upload/intent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		mockRequireAuth.mockReturnValue(undefined);
	});

	afterEach(() => {
		consoleInfoSpy?.mockRestore();
		consoleInfoSpy = null;
	});

	it('creates a trace id for a valid upload intent before the multipart body is sent', async () => {
		const response = await POST(
			makeEvent({
				fileName: 'brief.pdf',
				fileSize: 1024,
				mimeType: 'application/pdf',
				conversationId: 'conv-1',
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.traceId).toBe('trace-upload');
		expect(data.maxFileUploadSize).toBeGreaterThan(1024);
	});

	it('rejects oversized uploads before the browser sends the multipart body', async () => {
		const response = await POST(
			makeEvent({
				fileName: 'too-large.pdf',
				fileSize: 100 * 1024 * 1024 + 1,
				mimeType: 'application/pdf',
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(413);
		expect(data.code).toBe('upload_file_too_large');
		expect(data.traceId).toBe('trace-upload');
	});
});
