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

const mockRequireAuth = vi.mocked(requireAuth);
const mockIsKnowledgeUploadConversationError = vi.mocked(
	isKnowledgeUploadConversationError,
);
const mockResolveKnowledgeUploadLimits = vi.mocked(
	resolveKnowledgeUploadLimits,
);
const mockValidateKnowledgeUploadConversation = vi.mocked(
	validateKnowledgeUploadConversation,
);
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
	} as unknown as UploadIntentEvent;
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

	// Spec exceptions (b) and (c): the server has a type allowlist now. Every
	// refusal is one machine code with `details.reason` discriminating, plus an
	// `errorKey` the client renders in the user's own language.
	it.each([
		["clip.mp4", "video/mp4", "media", "knowledge.uploadRejectedMedia"],
		[
			"notes.zip",
			"application/zip",
			"archive",
			"knowledge.uploadRejectedArchive",
		],
		[
			"memo.rtf",
			"application/rtf",
			"formatNotEnabled",
			"knowledge.uploadRejectedFormatNotEnabled",
		],
		["mystery.wat", null, "unknownType", "knowledge.uploadUnsupportedType"],
	])("refuses %s with 415 and a localizable reason", async (fileName, mimeType, reason, errorKey) => {
		const response = await POST(
			makeEvent({
				fileName,
				fileSize: 1024,
				mimeType,
				conversationId: "conv-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(415);
		expect(data.code).toBe("upload_unsupported_type");
		expect(data.errorKey).toBe(errorKey);
		expect(data.traceId).toBe("trace-upload");
		expect(data.details).toMatchObject({ fileName, reason });
		expect(typeof data.error).toBe("string");
		expect(data.error).not.toContain("{");
		// Refused before the conversation is even looked up.
		expect(mockValidateKnowledgeUploadConversation).not.toHaveBeenCalled();
	});

	it("names the file and the extension in the English fallback text", async () => {
		const unknown = await POST(
			makeEvent({ fileName: "mystery.wat", fileSize: 1, mimeType: null }),
		);
		expect((await unknown.json()).error).toBe(
			"We can't read mystery.wat — that file type isn't supported.",
		);

		const rtf = await POST(
			makeEvent({ fileName: "memo.rtf", fileSize: 1, mimeType: null }),
		);
		expect((await rtf.json()).error).toBe(
			"RTF files aren't supported yet. Save it as PDF or DOCX and upload that.",
		);
	});

	// Exception (a): the 34 code/text extensions that preview as text now take
	// the direct-text route instead of failing inside MinerU.
	it.each([
		["script.py", "text/x-python"],
		["notes.odt", "application/vnd.oasis.opendocument.text"],
		["config.yaml", "application/yaml"],
		["shot.heic", "image/heic"],
		["page.html", "text/html"],
	])("admits %s", async (fileName, mimeType) => {
		const response = await POST(
			makeEvent({
				fileName,
				fileSize: 1024,
				mimeType,
				conversationId: "conv-1",
			}),
		);

		expect(response.status).toBe(200);
		expect((await response.json()).traceId).toBe("trace-upload");
	});

	it("resolves the type by extension first and the declared MIME second", async () => {
		// A browser that reports nothing must not turn a known extension into an
		// unknown type, and a nameless upload must still resolve by MIME.
		const byExtension = await POST(
			makeEvent({ fileName: "brief.pdf", fileSize: 1024, mimeType: null }),
		);
		expect(byExtension.status).toBe(200);

		const byMime = await POST(
			makeEvent({
				fileName: "download",
				fileSize: 1024,
				mimeType: "application/pdf",
			}),
		);
		expect(byMime.status).toBe(200);

		// The extension wins: a .mp4 mislabelled as a PDF is still refused.
		const extensionWins = await POST(
			makeEvent({
				fileName: "clip.mp4",
				fileSize: 1024,
				mimeType: "application/pdf",
			}),
		);
		expect(extensionWins.status).toBe(415);
	});

	it("checks the size before the type", async () => {
		// Order is load-bearing: an oversized file of an unsupported type is
		// still a 413, which is what the browser's retry logic keys on.
		const response = await POST(
			makeEvent({
				fileName: "huge.mp4",
				fileSize: 100 * 1024 * 1024 + 1,
				mimeType: "video/mp4",
			}),
		);

		expect(response.status).toBe(413);
		expect((await response.json()).code).toBe("upload_file_too_large");
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
