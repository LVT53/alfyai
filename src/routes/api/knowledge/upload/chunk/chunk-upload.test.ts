import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/attachment-trace", () => ({
	createAttachmentTraceId: vi.fn(() => "trace-upload"),
}));

vi.mock("$lib/server/services/knowledge/upload-intake", () => ({
	completeKnowledgeUploadFromStoredFile: vi.fn(),
	isKnowledgeUploadConversationError: vi.fn(() => false),
	resolveKnowledgeUploadLimits: vi.fn(() => ({
		maxFileUploadSize: 100 * 1024 * 1024,
		adapterBodySizeLimit: 100 * 1024 * 1024,
		multipartBodyLimit: 100 * 1024 * 1024,
		storedFileLimit: 100 * 1024 * 1024,
		chunkFileLimit: 100 * 1024 * 1024,
		multipartOverheadAllowance: 1024 * 1024,
	})),
	validateKnowledgeUploadConversation: vi.fn(
		async (params: { conversationId?: string | null }) =>
			params.conversationId?.trim() || null,
	),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	completeKnowledgeUploadFromStoredFile,
	isKnowledgeUploadConversationError,
	validateKnowledgeUploadConversation,
} from "$lib/server/services/knowledge/upload-intake";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCompleteKnowledgeUploadFromStoredFile =
	completeKnowledgeUploadFromStoredFile as ReturnType<typeof vi.fn>;
const mockIsKnowledgeUploadConversationError =
	isKnowledgeUploadConversationError as ReturnType<typeof vi.fn>;
const mockValidateKnowledgeUploadConversation =
	validateKnowledgeUploadConversation as ReturnType<typeof vi.fn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;

function makeChunkEvent(body: BodyInit, headers: Record<string, string>) {
	return {
		request: new Request("http://localhost/api/knowledge/upload/chunk", {
			method: "POST",
			headers,
			body,
		}),
		locals: { user: { id: "user-1", email: "test@example.com" } },
		params: {},
		url: new URL("http://localhost/api/knowledge/upload/chunk"),
		route: { id: "/api/knowledge/upload/chunk" },
	} as any;
}

function chunkHeaders(overrides: Record<string, string> = {}) {
	return {
		"content-type": "application/pdf",
		"x-alfyai-upload-name": "scan.pdf",
		"x-alfyai-upload-size": "10",
		"x-alfyai-upload-trace-id": "upload-chunktest",
		"x-alfyai-conversation-id": "conv-1",
		"x-alfyai-chunk-total": "2",
		...overrides,
	};
}

describe("POST /api/knowledge/upload/chunk", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		consoleWarnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		mockRequireAuth.mockReturnValue(undefined);
		mockIsKnowledgeUploadConversationError.mockReturnValue(false);
		mockValidateKnowledgeUploadConversation.mockImplementation(
			async (params: { conversationId?: string | null }) =>
				params.conversationId?.trim() || null,
		);
		mockCompleteKnowledgeUploadFromStoredFile.mockResolvedValue({
			artifact: { id: "artifact-1" },
			normalizedArtifact: null,
			reusedExistingArtifact: false,
			honcho: { uploaded: false, mode: "none" },
			promptReady: true,
		});
	});

	afterEach(async () => {
		consoleInfoSpy?.mockRestore();
		consoleWarnSpy?.mockRestore();
		consoleInfoSpy = null;
		consoleWarnSpy = null;
		await rm(
			join(
				process.cwd(),
				"data",
				"knowledge",
				"user-1",
				".incoming",
				"upload-chunktest",
			),
			{
				force: true,
				recursive: true,
			},
		);
	});

	it("accepts non-final chunks without starting extraction", async () => {
		const response = await POST(
			makeChunkEvent(
				Buffer.from("hello"),
				chunkHeaders({
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
				}),
			),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.complete).toBe(false);
		expect(data.receivedBytes).toBe(5);
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("rejects an invalid conversation before writing a non-final chunk", async () => {
		const error = new Error("Conversation not found or access denied");
		mockValidateKnowledgeUploadConversation.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		const response = await POST(
			makeChunkEvent(
				Buffer.from("hello"),
				chunkHeaders({
					"x-alfyai-conversation-id": "missing-conv",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
				}),
			),
		);
		const data = await response.json();
		const uploadDir = await stat(
			join(
				process.cwd(),
				"data",
				"knowledge",
				"user-1",
				".incoming",
				"upload-chunktest",
			),
		).catch(() => null);

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			error: "Conversation not found or access denied",
			code: "conversation_not_found",
			traceId: "upload-chunktest",
		});
		expect(uploadDir).toBeNull();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("assembles all chunks and completes the knowledge upload on the final chunk", async () => {
		await POST(
			makeChunkEvent(
				Buffer.from("hello"),
				chunkHeaders({
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
				}),
			),
		);
		const response = await POST(
			makeChunkEvent(
				Buffer.from("world"),
				chunkHeaders({
					"x-alfyai-chunk-index": "1",
					"x-alfyai-chunk-start": "5",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "true",
				}),
			),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.complete).toBe(true);
		expect(mockCompleteKnowledgeUploadFromStoredFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				fileName: "scan.pdf",
				mimeType: "application/pdf",
				sizeBytes: 10,
				binaryHash: createHash("sha256").update("helloworld").digest("hex"),
				tempPathAbsolute: expect.stringContaining("upload-chunktest.assembled"),
				traceId: "upload-chunktest",
				logPrefix: "Chunked",
			}),
		);
	});

	it("rejects chunks whose declared size does not match the received body", async () => {
		const response = await POST(
			makeChunkEvent(
				Buffer.from("nope"),
				chunkHeaders({
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
				}),
			),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe("chunk_size_mismatch");
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("translates intake conversation validation failures on the final chunk", async () => {
		const error = new Error("Conversation not found or access denied");
		mockCompleteKnowledgeUploadFromStoredFile.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		await POST(
			makeChunkEvent(
				Buffer.from("hello"),
				chunkHeaders({
					"x-alfyai-upload-trace-id": "upload-missing-conv",
					"x-alfyai-conversation-id": "missing-conv",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
				}),
			),
		);
		const response = await POST(
			makeChunkEvent(
				Buffer.from("world"),
				chunkHeaders({
					"x-alfyai-upload-trace-id": "upload-missing-conv",
					"x-alfyai-conversation-id": "missing-conv",
					"x-alfyai-chunk-index": "1",
					"x-alfyai-chunk-start": "5",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "true",
				}),
			),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			error: "Conversation not found or access denied",
			code: "conversation_not_found",
			traceId: "upload-missing-conv",
		});
	});
});
