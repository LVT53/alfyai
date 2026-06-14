import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/attachment-trace", () => ({
	createAttachmentTraceId: vi.fn(() => "trace-upload"),
}));

vi.mock("$lib/server/services/knowledge/upload-intake", () => ({
	isKnowledgeUploadConversationError: vi.fn(() => false),
	resolveKnowledgeUploadLimits: vi.fn(() => ({
		maxFileUploadSize: 100 * 1024 * 1024,
		adapterBodySizeLimit: 100 * 1024 * 1024,
		multipartBodyLimit: 100 * 1024 * 1024,
		storedFileLimit: 100 * 1024 * 1024,
		chunkFileLimit: 100 * 1024 * 1024,
		chunkBodyLimit: 1024 * 1024,
		multipartOverheadAllowance: 1024 * 1024,
	})),
	validateKnowledgeUploadConversation: vi.fn(
		async (params: { conversationId?: string | null }) =>
			params.conversationId?.trim() || null,
	),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	isKnowledgeUploadConversationError,
	resolveKnowledgeUploadLimits,
	validateKnowledgeUploadConversation,
} from "$lib/server/services/knowledge/upload-intake";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockIsKnowledgeUploadConversationError =
	isKnowledgeUploadConversationError as ReturnType<typeof vi.fn>;
const mockResolveKnowledgeUploadLimits =
	resolveKnowledgeUploadLimits as ReturnType<typeof vi.fn>;
const mockValidateKnowledgeUploadConversation =
	validateKnowledgeUploadConversation as ReturnType<typeof vi.fn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;
type UploadIntentEvent = Parameters<typeof POST>[0];

function makeEvent(payload: unknown): UploadIntentEvent {
	return {
		request: {
			json: vi.fn().mockResolvedValue(payload),
		},
		locals: { user: { id: "user-1", email: "test@example.com" } },
		params: {},
		url: new URL("http://localhost/api/knowledge/upload/intent"),
		route: { id: "/api/knowledge/upload/intent" },
	} as UploadIntentEvent;
}

describe("POST /api/knowledge/upload/intent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		mockRequireAuth.mockReturnValue(undefined);
		mockIsKnowledgeUploadConversationError.mockReturnValue(false);
		mockResolveKnowledgeUploadLimits.mockReturnValue({
			maxFileUploadSize: 100 * 1024 * 1024,
			adapterBodySizeLimit: 100 * 1024 * 1024,
			multipartBodyLimit: 100 * 1024 * 1024,
			storedFileLimit: 100 * 1024 * 1024,
			chunkFileLimit: 100 * 1024 * 1024,
			chunkBodyLimit: 1024 * 1024,
			multipartOverheadAllowance: 1024 * 1024,
		});
		mockValidateKnowledgeUploadConversation.mockImplementation(
			async (params: { conversationId?: string | null }) =>
				params.conversationId?.trim() || null,
		);
	});

	afterEach(() => {
		consoleInfoSpy?.mockRestore();
		consoleInfoSpy = null;
	});

	it("creates a trace id for a valid upload intent before the multipart body is sent", async () => {
		const response = await POST(
			makeEvent({
				fileName: "brief.pdf",
				fileSize: 1024,
				mimeType: "application/pdf",
				conversationId: "conv-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.traceId).toBe("trace-upload");
		expect(data.maxFileUploadSize).toBeGreaterThan(1024);
	});

	it("allows a chunked upload intent above the adapter body limit when it is under the app file limit", async () => {
		mockResolveKnowledgeUploadLimits.mockReturnValueOnce({
			maxFileUploadSize: 100 * 1024 * 1024,
			adapterBodySizeLimit: 40 * 1024 * 1024,
			multipartBodyLimit: 40 * 1024 * 1024,
			storedFileLimit: 40 * 1024 * 1024,
			chunkFileLimit: 100 * 1024 * 1024,
			chunkBodyLimit: 1024 * 1024,
			multipartOverheadAllowance: 1024 * 1024,
		});

		const response = await POST(
			makeEvent({
				fileName: "field-guide.pdf",
				fileSize: 46 * 1024 * 1024,
				mimeType: "application/pdf",
				conversationId: "conv-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.traceId).toBe("trace-upload");
		expect(data.maxFileUploadSize).toBe(100 * 1024 * 1024);
		expect(data.requestBodyLimit).toBe(40 * 1024 * 1024);
		expect(data.rawUploadLimit).toBe(40 * 1024 * 1024);
		expect(data.chunkBodyLimit).toBe(1024 * 1024);
	});

	it("reports explicit raw and chunk body limits for the browser upload client", async () => {
		mockResolveKnowledgeUploadLimits.mockReturnValueOnce({
			maxFileUploadSize: 100 * 1024 * 1024,
			adapterBodySizeLimit: 128 * 1024,
			multipartBodyLimit: 128 * 1024,
			storedFileLimit: 128 * 1024,
			chunkFileLimit: 100 * 1024 * 1024,
			chunkBodyLimit: 128 * 1024,
			multipartOverheadAllowance: 1024 * 1024,
		});

		const response = await POST(
			makeEvent({
				fileName: "adapter-limited.pdf",
				fileSize: 129 * 1024,
				mimeType: "application/pdf",
				conversationId: "conv-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.rawUploadLimit).toBe(128 * 1024);
		expect(data.chunkBodyLimit).toBe(128 * 1024);
		expect(data.maxFileUploadSize).toBe(100 * 1024 * 1024);
	});

	it("rejects oversized uploads before the browser sends the multipart body", async () => {
		const response = await POST(
			makeEvent({
				fileName: "too-large.pdf",
				fileSize: 100 * 1024 * 1024 + 1,
				mimeType: "application/pdf",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(413);
		expect(data.code).toBe("upload_file_too_large");
		expect(data.traceId).toBe("trace-upload");
	});

	it("rejects an inaccessible conversation during upload preflight", async () => {
		const error = new Error("Conversation not found or access denied");
		mockValidateKnowledgeUploadConversation.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		const response = await POST(
			makeEvent({
				fileName: "brief.pdf",
				fileSize: 1024,
				mimeType: "application/pdf",
				conversationId: "missing-conv",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			error: "Conversation not found or access denied",
			code: "conversation_not_found",
			traceId: "trace-upload",
		});
		expect(mockValidateKnowledgeUploadConversation).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "missing-conv",
		});
	});
});
