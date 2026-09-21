import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/attachment-trace", () => ({
	createAttachmentTraceId: vi.fn(() => "trace-upload"),
}));

vi.mock("$lib/server/services/extraction/config", () => ({
	getExtractionConfig: vi.fn(() => ({ maxDirectTextBytes: 8 * 1024 * 1024 })),
}));

const OPEN_GATE = {
	disabledEntryIds: new Set<string>(),
	reason: null as "backend_version" | null,
	backendVersion: null as string | null,
	checkedAt: new Date(0).toISOString(),
};

vi.mock("$lib/server/services/knowledge/format-availability", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/knowledge/format-availability")
	>("$lib/server/services/knowledge/format-availability");
	return {
		...actual,
		getUploadFormatGate: vi.fn(async () => OPEN_GATE),
	};
});

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
import { getExtractionConfig } from "$lib/server/services/extraction/config";
import { getUploadFormatGate } from "$lib/server/services/knowledge/format-availability";
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
const mockGetExtractionConfig = vi.mocked(getExtractionConfig);
const mockGetUploadFormatGate = vi.mocked(getUploadFormatGate);
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
		mockGetUploadFormatGate.mockResolvedValue(OPEN_GATE);
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
		mockGetExtractionConfig.mockReturnValue({
			maxDirectTextBytes: 8 * 1024 * 1024,
		} as ReturnType<typeof getExtractionConfig>);
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
			"scan.ofd",
			"application/ofd",
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
			"We can't read mystery.wat — that file type isn't supported. Save it as PDF, DOCX or plain text and upload that.",
		);

		const ofd = await POST(
			makeEvent({ fileName: "scan.ofd", fileSize: 1, mimeType: null }),
		);
		expect((await ofd.json()).error).toBe(
			"OFD files aren't supported yet. Save it as PDF or DOCX and upload that.",
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
	// Bug B5. A direct-text file is read whole, chunked and embedded, so the cap
	// is a user-visible refusal of something that uploads fine today — it is
	// admin-raisable, and the extractor enforces the same number again for the
	// routes that never call this handshake.
	describe("direct-text size cap (B5)", () => {
		it("refuses an oversized text file with 413 before the conversation lookup", async () => {
			const response = await POST(
				makeEvent({
					fileName: "server.log",
					fileSize: 9 * 1024 * 1024,
					mimeType: "text/plain",
					conversationId: "conv-1",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(413);
			expect(data.code).toBe("upload_direct_text_too_large");
			expect(data.errorKey).toBe("knowledge.uploadDirectTextTooLarge");
			expect(data.details).toMatchObject({
				fileName: "server.log",
				fileSize: 9 * 1024 * 1024,
				maxBytes: 8 * 1024 * 1024,
			});
			expect(mockValidateKnowledgeUploadConversation).not.toHaveBeenCalled();
		});

		it("admits a text file exactly at the cap", async () => {
			const response = await POST(
				makeEvent({
					fileName: "notes.txt",
					fileSize: 8 * 1024 * 1024,
					mimeType: "text/plain",
					conversationId: "conv-1",
				}),
			);

			expect(response.status).toBe(200);
		});

		it("does not apply the text cap to a document that goes to the backend", async () => {
			const response = await POST(
				makeEvent({
					fileName: "scan.pdf",
					fileSize: 9 * 1024 * 1024,
					mimeType: "application/pdf",
					conversationId: "conv-1",
				}),
			);

			expect(response.status).toBe(200);
		});

		it("keeps the Phase 1 refusals ahead of it", async () => {
			// Over the app file limit: still 413 upload_file_too_large.
			const tooLarge = await POST(
				makeEvent({
					fileName: "huge.txt",
					fileSize: 200 * 1024 * 1024,
					mimeType: "text/plain",
					conversationId: "conv-1",
				}),
			);
			expect((await tooLarge.json()).code).toBe("upload_file_too_large");

			// Refused type: still 415, even though it is also over the text cap.
			const unsupported = await POST(
				makeEvent({
					fileName: "clip.mp4",
					fileSize: 9 * 1024 * 1024,
					mimeType: "video/mp4",
					conversationId: "conv-1",
				}),
			);
			expect(unsupported.status).toBe(415);
			expect((await unsupported.json()).code).toBe("upload_unsupported_type");
		});

		it("follows the admin-configured cap", async () => {
			mockGetExtractionConfig.mockReturnValue({
				maxDirectTextBytes: 32 * 1024 * 1024,
			} as ReturnType<typeof getExtractionConfig>);

			const response = await POST(
				makeEvent({
					fileName: "server.log",
					fileSize: 9 * 1024 * 1024,
					mimeType: "text/plain",
					conversationId: "conv-1",
				}),
			);

			expect(response.status).toBe(200);
		});
	});

	// Phase 5 P5-B: the MinerU-4 availability gate (spec §3.5). The registry
	// admits epub/rtf/odt/ods/odp unconditionally; whether the CONFIGURED
	// backend can actually parse them right now is this gate's call.
	describe("MinerU-4 availability gate", () => {
		it("admits a gated format when the gate is open (unknown or healthy backend)", async () => {
			const response = await POST(
				makeEvent({
					fileName: "book.epub",
					fileSize: 1024,
					mimeType: "application/epub+zip",
					conversationId: "conv-1",
				}),
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.disabledFileTypeIds).toEqual([]);
		});

		it("refuses a gated format with 415 formatNotEnabled when a pre-4 backend is detected", async () => {
			mockGetUploadFormatGate.mockResolvedValueOnce({
				disabledEntryIds: new Set(["epub", "odp", "ods", "odt", "rtf"]),
				reason: "backend_version",
				backendVersion: "3.9.0",
				checkedAt: new Date(0).toISOString(),
			});

			const response = await POST(
				makeEvent({
					fileName: "book.epub",
					fileSize: 1024,
					mimeType: "application/epub+zip",
					conversationId: "conv-1",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(415);
			expect(data.code).toBe("upload_unsupported_type");
			expect(data.errorKey).toBe("knowledge.uploadRejectedFormatNotEnabled");
			expect(data.details).toMatchObject({
				fileName: "book.epub",
				extension: "epub",
				reason: "formatNotEnabled",
			});
		});

		it("does not gate html: a closed gate degrades it to direct-text instead of refusing it", async () => {
			mockGetUploadFormatGate.mockResolvedValueOnce({
				disabledEntryIds: new Set(["epub", "odp", "ods", "odt", "rtf"]),
				reason: "backend_version",
				backendVersion: "3.9.0",
				checkedAt: new Date(0).toISOString(),
			});

			const response = await POST(
				makeEvent({
					fileName: "page.html",
					fileSize: 1024,
					mimeType: "text/html",
					conversationId: "conv-1",
				}),
			);

			expect(response.status).toBe(200);
		});

		it("applies the direct-text cap to html once a closed gate falls it back to direct-text", async () => {
			mockGetUploadFormatGate.mockResolvedValueOnce({
				disabledEntryIds: new Set(["epub", "odp", "ods", "odt", "rtf"]),
				reason: "backend_version",
				backendVersion: "3.9.0",
				checkedAt: new Date(0).toISOString(),
			});

			const response = await POST(
				makeEvent({
					fileName: "huge.html",
					fileSize: 9 * 1024 * 1024,
					mimeType: "text/html",
					conversationId: "conv-1",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(413);
			expect(data.code).toBe("upload_direct_text_too_large");
		});

		it("does not apply the direct-text cap to html while the gate stays open", async () => {
			const response = await POST(
				makeEvent({
					fileName: "huge.html",
					fileSize: 9 * 1024 * 1024,
					mimeType: "text/html",
					conversationId: "conv-1",
				}),
			);

			expect(response.status).toBe(200);
		});

		it("reports the disabled entry ids on the success payload", async () => {
			mockGetUploadFormatGate.mockResolvedValueOnce({
				disabledEntryIds: new Set(["epub", "odp", "ods", "odt", "rtf"]),
				reason: "backend_version",
				backendVersion: "3.9.0",
				checkedAt: new Date(0).toISOString(),
			});

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
			expect([...data.disabledFileTypeIds].sort()).toEqual([
				"epub",
				"odp",
				"ods",
				"odt",
				"rtf",
			]);
		});
	});
});
