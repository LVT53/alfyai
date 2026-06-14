import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/attachment-trace", () => ({
	createAttachmentTraceId: vi.fn(() => "trace-upload"),
	logAttachmentTrace: vi.fn(),
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
type RawUploadEvent = Parameters<typeof POST>[0];

function makeRawUploadEvent(
	body: BodyInit,
	headers: Record<string, string>,
): RawUploadEvent {
	return {
		request: new Request("http://localhost/api/knowledge/upload/raw", {
			method: "POST",
			headers,
			body,
		}),
		locals: { user: { id: "raw-user", email: "test@example.com" } },
		params: {},
		url: new URL("http://localhost/api/knowledge/upload/raw"),
		route: { id: "/api/knowledge/upload/raw" },
	} as RawUploadEvent;
}

describe("POST /api/knowledge/upload/raw", () => {
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
			artifact: {
				id: "artifact-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "scan.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5,
				conversationId: "conv-1",
				summary: "scan.pdf",
				storagePath: "data/knowledge/user-1/artifact-1.pdf",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
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
			join(process.cwd(), "data", "knowledge", "raw-user", ".incoming"),
			{
				force: true,
				recursive: true,
			},
		);
	});

	it("streams the raw file body to temporary storage and persists a source artifact", async () => {
		const bytes = Buffer.from("hello");
		const response = await POST(
			makeRawUploadEvent(bytes, {
				"content-type": "application/pdf",
				"x-alfyai-upload-name": encodeURIComponent("scan.pdf"),
				"x-alfyai-upload-size": String(bytes.length),
				"x-alfyai-upload-trace-id": "upload-rawtest",
				"x-alfyai-conversation-id": "conv-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.artifact.id).toBe("artifact-1");
		expect(mockCompleteKnowledgeUploadFromStoredFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "raw-user",
				conversationId: "conv-1",
				fileName: "scan.pdf",
				mimeType: "application/pdf",
				sizeBytes: bytes.length,
				binaryHash: createHash("sha256").update(bytes).digest("hex"),
				tempPathAbsolute: expect.stringContaining(".incoming"),
				traceId: "upload-rawtest",
				logPrefix: "Raw",
			}),
		);
		expect(consoleInfoSpy).toHaveBeenCalledWith(
			"[KNOWLEDGE] Raw upload receive completed",
			expect.objectContaining({
				traceId: "upload-rawtest",
				receivedBytes: bytes.length,
			}),
		);
	});

	it("rejects raw uploads when the declared browser size does not match received bytes", async () => {
		const response = await POST(
			makeRawUploadEvent(Buffer.from("hello"), {
				"content-type": "application/pdf",
				"x-alfyai-upload-name": "scan.pdf",
				"x-alfyai-upload-size": "6",
				"x-alfyai-upload-trace-id": "upload-mismatch",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe("upload_size_mismatch");
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("rejects an invalid conversation before writing a raw temporary file", async () => {
		const error = new Error("Conversation not found or access denied");
		mockValidateKnowledgeUploadConversation.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		const response = await POST(
			makeRawUploadEvent(Buffer.from("hello"), {
				"content-type": "application/pdf",
				"x-alfyai-upload-name": "scan.pdf",
				"x-alfyai-upload-size": "5",
				"x-alfyai-upload-trace-id": "upload-missing-conv-early",
				"x-alfyai-conversation-id": "missing-conv",
			}),
		);
		const data = await response.json();
		const incomingDir = await stat(
			join(process.cwd(), "data", "knowledge", "raw-user", ".incoming"),
		).catch(() => null);

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			error: "Conversation not found or access denied",
			code: "conversation_not_found",
			traceId: "upload-missing-conv-early",
		});
		expect(incomingDir).toBeNull();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("translates intake conversation validation failures without changing the public raw-upload response", async () => {
		const error = new Error("Conversation not found or access denied");
		mockCompleteKnowledgeUploadFromStoredFile.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		const response = await POST(
			makeRawUploadEvent(Buffer.from("hello"), {
				"content-type": "application/pdf",
				"x-alfyai-upload-name": "scan.pdf",
				"x-alfyai-upload-size": "5",
				"x-alfyai-upload-trace-id": "upload-missing-conv",
				"x-alfyai-conversation-id": "missing-conv",
			}),
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
