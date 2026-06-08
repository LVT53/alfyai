import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({
	createNormalizedArtifact: vi.fn(),
	resolvePromptAttachmentArtifacts: vi.fn(),
	saveUploadedArtifact: vi.fn(),
	saveUploadedArtifactFromStoredFile: vi.fn(),
}));

vi.mock("$lib/server/services/honcho", () => ({
	syncArtifactToHoncho: vi.fn(),
}));

vi.mock("$lib/server/services/attachment-trace", () => ({
	logAttachmentTrace: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({ maxFileUploadSize: 50 * 1024 * 1024 })),
}));

vi.mock("$lib/server/env", () => ({
	getAdapterBodySizeLimitBytes: vi.fn(() => 40 * 1024 * 1024),
}));

import { getConfig } from "$lib/server/config-store";
import { getAdapterBodySizeLimitBytes } from "$lib/server/env";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import { getConversation } from "$lib/server/services/conversations";
import { syncArtifactToHoncho } from "$lib/server/services/honcho";
import {
	createNormalizedArtifact,
	resolvePromptAttachmentArtifacts,
	saveUploadedArtifact,
	saveUploadedArtifactFromStoredFile,
} from "./store";
import {
	completeKnowledgeUploadFromFile,
	completeKnowledgeUploadFromStoredFile,
	resolveKnowledgeUploadLimits,
} from "./upload-intake";

const mockCreateNormalizedArtifact = createNormalizedArtifact as ReturnType<
	typeof vi.fn
>;
const mockResolvePromptAttachmentArtifacts =
	resolvePromptAttachmentArtifacts as ReturnType<typeof vi.fn>;
const mockSaveUploadedArtifact = saveUploadedArtifact as ReturnType<
	typeof vi.fn
>;
const mockSaveUploadedArtifactFromStoredFile =
	saveUploadedArtifactFromStoredFile as ReturnType<typeof vi.fn>;
const mockSyncArtifactToHoncho = syncArtifactToHoncho as ReturnType<
	typeof vi.fn
>;
const mockLogAttachmentTrace = logAttachmentTrace as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockGetAdapterBodySizeLimitBytes =
	getAdapterBodySizeLimitBytes as ReturnType<typeof vi.fn>;

const now = Date.parse("2026-05-31T10:00:00Z");
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;

function artifact(overrides: Record<string, unknown> = {}) {
	return {
		id: "artifact-1",
		userId: "user-1",
		conversationId: "conv-1",
		type: "source_document",
		retrievalClass: "durable",
		name: "recipe.pdf",
		mimeType: "application/pdf",
		extension: "pdf",
		sizeBytes: 1024,
		binaryHash: "binary-hash",
		storagePath: "data/knowledge/user-1/artifact-1.pdf",
		contentText: null,
		summary: "recipe.pdf",
		metadata: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("Knowledge Upload Intake", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
		mockGetConfig.mockReturnValue({ maxFileUploadSize: 50 * 1024 * 1024 });
		mockGetAdapterBodySizeLimitBytes.mockReturnValue(40 * 1024 * 1024);
		mockCreateNormalizedArtifact.mockResolvedValue(null);
		mockSyncArtifactToHoncho.mockResolvedValue({
			uploaded: true,
			mode: "native",
		});
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [],
			promptArtifacts: [],
			items: [],
			unresolvedItems: [],
		});
	});

	it("centralizes upload limits for multipart, stored, and chunk adapters", () => {
		const limits = resolveKnowledgeUploadLimits();

		expect(limits).toEqual({
			maxFileUploadSize: 50 * 1024 * 1024,
			adapterBodySizeLimit: 40 * 1024 * 1024,
			multipartBodyLimit: 40 * 1024 * 1024,
			storedFileLimit: 40 * 1024 * 1024,
			chunkFileLimit: 50 * 1024 * 1024,
			chunkBodyLimit: 1024 * 1024,
			multipartOverheadAllowance: 1024 * 1024,
		});
	});

	afterEach(() => {
		consoleInfoSpy?.mockRestore();
		consoleInfoSpy = null;
	});

	it("completes a browser File upload with prompt-ready metadata", async () => {
		const sourceArtifact = artifact();
		const normalizedArtifact = artifact({
			id: "normalized-1",
			type: "normalized_document",
			name: "recipe.txt",
			mimeType: "text/plain",
			extension: "txt",
			sizeBytes: 400,
			contentText: "Readable recipe text",
			storagePath: null,
		});
		const file = new File(["recipe"], "recipe.pdf", {
			type: "application/pdf",
		});
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact,
			reusedExistingArtifact: false,
		});
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [sourceArtifact],
			promptArtifacts: [normalizedArtifact],
			items: [
				{
					requestedArtifactId: sourceArtifact.id,
					displayArtifact: sourceArtifact,
					promptArtifact: normalizedArtifact,
					promptReady: true,
					readinessError: null,
					contentLength: 320,
					contentPreview: "Readable recipe text",
					contentHash: "content-hash",
					chunkCount: 2,
				},
			],
			unresolvedItems: [],
		});

		const response = await completeKnowledgeUploadFromFile({
			userId: "user-1",
			conversationId: "conv-1",
			file,
			traceId: "trace-file",
			startedAt: now,
		});

		expect(response).toMatchObject({
			artifact: sourceArtifact,
			normalizedArtifact,
			reusedExistingArtifact: false,
			honcho: { uploaded: true, mode: "native" },
			promptReady: true,
			promptArtifactId: "normalized-1",
			readinessError: null,
		});
		expect(mockSaveUploadedArtifact).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			file,
		});
		expect(mockSyncArtifactToHoncho).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			artifact: sourceArtifact,
			file,
		});
		expect(mockLogAttachmentTrace).toHaveBeenCalledWith(
			"upload_result",
			expect.objectContaining({
				traceId: "trace-file",
				sourceArtifactId: "artifact-1",
				normalizedArtifactId: "normalized-1",
				promptReady: true,
				promptArtifactId: "normalized-1",
				extractionTextLength: 320,
				chunkCount: 2,
				contentHash: "content-hash",
			}),
		);
	});

	it("completes a stored temporary upload file with binary hash and rename metadata intact", async () => {
		const sourceArtifact = artifact({
			id: "artifact-stored",
			name: "report_1.pdf",
			binaryHash: "stored-binary-hash",
			storagePath: "data/knowledge/user-1/artifact-stored.pdf",
		});
		const normalizedArtifact = artifact({
			id: "normalized-stored",
			type: "normalized_document",
			name: "report_1.txt",
			mimeType: "text/plain",
			extension: "txt",
			sizeBytes: 520,
			contentText: "Stored report text",
			storagePath: null,
		});
		mockSaveUploadedArtifactFromStoredFile.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact,
			reusedExistingArtifact: false,
			renameInfo: {
				originalName: "report.pdf",
				wasRenamed: true,
			},
		});
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [sourceArtifact],
			promptArtifacts: [normalizedArtifact],
			items: [
				{
					requestedArtifactId: sourceArtifact.id,
					displayArtifact: sourceArtifact,
					promptArtifact: normalizedArtifact,
					promptReady: true,
					readinessError: null,
					contentLength: 480,
					contentPreview: "Stored report text",
					contentHash: "stored-content-hash",
					chunkCount: 3,
				},
			],
			unresolvedItems: [],
		});

		const response = await completeKnowledgeUploadFromStoredFile({
			userId: "user-1",
			conversationId: "conv-1",
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2048,
			binaryHash: "stored-binary-hash",
			tempPathAbsolute: "/tmp/report-upload",
			traceId: "trace-stored",
			startedAt: now,
			logPrefix: "Raw",
		});

		expect(response).toMatchObject({
			artifact: sourceArtifact,
			normalizedArtifact,
			honcho: { uploaded: true, mode: "native" },
			promptReady: true,
			promptArtifactId: "normalized-stored",
			readinessError: null,
			renameInfo: {
				originalName: "report.pdf",
				wasRenamed: true,
			},
		});
		expect(mockSaveUploadedArtifactFromStoredFile).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2048,
			binaryHash: "stored-binary-hash",
			tempPathAbsolute: "/tmp/report-upload",
		});
		expect(mockSyncArtifactToHoncho).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			artifact: sourceArtifact,
		});
	});

	it("tries native File Honcho sync before falling back to normalized text", async () => {
		const sourceArtifact = artifact({
			id: "artifact-image",
			name: "photo.png",
			mimeType: "image/png",
			extension: "png",
		});
		const normalizedArtifact = artifact({
			id: "normalized-image",
			type: "normalized_document",
			name: "photo.txt",
			mimeType: "text/plain",
			extension: "txt",
			sizeBytes: 220,
			contentText: "OCR text",
			storagePath: null,
		});
		const file = new File(["image"], "photo.png", { type: "image/png" });
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact,
			reusedExistingArtifact: false,
		});
		mockSyncArtifactToHoncho
			.mockResolvedValueOnce({ uploaded: false, mode: "none" })
			.mockResolvedValueOnce({ uploaded: true, mode: "normalized" });
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [sourceArtifact],
			promptArtifacts: [normalizedArtifact],
			items: [
				{
					requestedArtifactId: sourceArtifact.id,
					displayArtifact: sourceArtifact,
					promptArtifact: normalizedArtifact,
					promptReady: true,
					readinessError: null,
					contentLength: 180,
					contentPreview: "OCR text",
					contentHash: "ocr-hash",
					chunkCount: 1,
				},
			],
			unresolvedItems: [],
		});

		const response = await completeKnowledgeUploadFromFile({
			userId: "user-1",
			conversationId: "conv-1",
			file,
			traceId: "trace-fallback",
			startedAt: now,
		});

		expect(response.honcho).toEqual({ uploaded: true, mode: "normalized" });
		expect(mockSyncArtifactToHoncho).toHaveBeenNthCalledWith(1, {
			userId: "user-1",
			conversationId: "conv-1",
			artifact: sourceArtifact,
			file,
		});
		expect(mockSyncArtifactToHoncho).toHaveBeenNthCalledWith(2, {
			userId: "user-1",
			conversationId: "conv-1",
			artifact: sourceArtifact,
			fallbackTextArtifact: normalizedArtifact,
		});
	});

	it("returns readiness failure metadata when extraction cannot produce prompt-ready text", async () => {
		const sourceArtifact = artifact({
			id: "artifact-scan",
			name: "scan.pdf",
			storagePath: "data/knowledge/user-1/artifact-scan.pdf",
		});
		const file = new File(["scan"], "scan.pdf", { type: "application/pdf" });
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact: null,
			reusedExistingArtifact: false,
		});
		mockCreateNormalizedArtifact.mockResolvedValue(null);
		mockSyncArtifactToHoncho.mockResolvedValue({
			uploaded: false,
			mode: "none",
		});
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [sourceArtifact],
			promptArtifacts: [],
			items: [
				{
					requestedArtifactId: sourceArtifact.id,
					displayArtifact: sourceArtifact,
					promptArtifact: null,
					promptReady: false,
					readinessError: "This file could not be prepared for chat.",
					contentLength: 0,
					contentPreview: null,
					contentHash: null,
					chunkCount: 0,
				},
			],
			unresolvedItems: [],
		});

		const response = await completeKnowledgeUploadFromFile({
			userId: "user-1",
			conversationId: "conv-1",
			file,
			traceId: "trace-unreadable",
			startedAt: now,
		});

		expect(response.promptReady).toBe(false);
		expect(response.promptArtifactId).toBeNull();
		expect(response.readinessError).toBe(
			"This file could not be prepared for chat.",
		);
		expect(mockCreateNormalizedArtifact).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			sourceArtifactId: "artifact-scan",
			sourceStoragePath: "data/knowledge/user-1/artifact-scan.pdf",
			sourceName: "scan.pdf",
			sourceMimeType: "application/pdf",
		});
	});

	it("rejects missing conversations before artifact insert or link writes", async () => {
		mockGetConversation.mockResolvedValue(null);

		await expect(
			completeKnowledgeUploadFromStoredFile({
				userId: "user-1",
				conversationId: "missing-conv",
				fileName: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 2048,
				binaryHash: "stored-binary-hash",
				tempPathAbsolute: "/tmp/report-upload",
				traceId: "trace-missing-conv",
				startedAt: now,
				logPrefix: "Chunked",
			}),
		).rejects.toMatchObject({
			name: "KnowledgeUploadConversationError",
			code: "invalid_conversation",
			status: 400,
			message: "Conversation not found or access denied",
		});

		expect(mockSaveUploadedArtifact).not.toHaveBeenCalled();
		expect(mockSaveUploadedArtifactFromStoredFile).not.toHaveBeenCalled();
		expect(mockSyncArtifactToHoncho).not.toHaveBeenCalled();
	});
});
