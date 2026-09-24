import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";

vi.mock("./store", () => ({
	getArtifactForUser: vi.fn(),
	resolvePromptAttachmentArtifacts: vi.fn(),
	saveUploadedArtifact: vi.fn(),
	saveUploadedArtifactFromStoredFile: vi.fn(),
}));

vi.mock("$lib/server/services/extraction", () => ({
	getExtractionConfig: vi.fn(() => ({ inlineBudgetMs: 1500 })),
	getExtractionJobForArtifact: vi.fn(),
	startUploadExtraction: vi.fn(),
	waitForExtractionJobVerdict: vi.fn(),
}));

vi.mock("$lib/server/services/attachment-trace", () => ({
	logAttachmentTrace: vi.fn(),
}));

// The magic-byte check has its own test file; these fixtures are named files
// with placeholder bytes and paths that never existed on disk. What matters
// here is that intake calls it, and calls it BEFORE anything is stored.
vi.mock("./upload-signature", () => ({
	assertUploadSignatureForFile: vi.fn(async () => undefined),
	assertUploadSignatureForStoredFile: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/projects", () => ({
	getProject: vi.fn(),
}));

// The link itself is Task E1's contract and has its own suite; what matters
// here is WHEN intake links (after a successful store, never before) and that
// a vanished project cannot turn a stored document into a failed upload.
vi.mock("./project-knowledge", () => ({
	linkProjectKnowledge: vi.fn(),
	isProjectKnowledgeError: vi.fn(
		(error: unknown) =>
			typeof error === "object" &&
			error !== null &&
			"name" in error &&
			(error as { name?: unknown }).name === "ProjectKnowledgeError",
	),
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
import {
	getExtractionConfig,
	getExtractionJobForArtifact,
	startUploadExtraction,
	waitForExtractionJobVerdict,
} from "$lib/server/services/extraction";
import { getProject } from "$lib/server/services/projects";
import { linkProjectKnowledge } from "./project-knowledge";
import {
	getArtifactForUser,
	resolvePromptAttachmentArtifacts,
	saveUploadedArtifact,
	saveUploadedArtifactFromStoredFile,
} from "./store";
import {
	completeKnowledgeUploadFromFile,
	completeKnowledgeUploadFromStoredFile,
	resolveKnowledgeUploadLimits,
} from "./upload-intake";
import {
	assertUploadSignatureForFile,
	assertUploadSignatureForStoredFile,
} from "./upload-signature";

const mockGetArtifactForUser = getArtifactForUser as ReturnType<typeof vi.fn>;
const mockResolvePromptAttachmentArtifacts =
	resolvePromptAttachmentArtifacts as ReturnType<typeof vi.fn>;
const mockSaveUploadedArtifact = saveUploadedArtifact as ReturnType<
	typeof vi.fn
>;
const mockSaveUploadedArtifactFromStoredFile =
	saveUploadedArtifactFromStoredFile as ReturnType<typeof vi.fn>;
const mockAssertUploadSignatureForFile =
	assertUploadSignatureForFile as ReturnType<typeof vi.fn>;
const mockAssertUploadSignatureForStoredFile =
	assertUploadSignatureForStoredFile as ReturnType<typeof vi.fn>;
const mockLogAttachmentTrace = logAttachmentTrace as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockGetProject = getProject as ReturnType<typeof vi.fn>;
const mockLinkProjectKnowledge = linkProjectKnowledge as ReturnType<
	typeof vi.fn
>;
const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockGetAdapterBodySizeLimitBytes =
	getAdapterBodySizeLimitBytes as ReturnType<typeof vi.fn>;
const mockStartUploadExtraction = startUploadExtraction as ReturnType<
	typeof vi.fn
>;
const mockWaitForExtractionJobVerdict =
	waitForExtractionJobVerdict as ReturnType<typeof vi.fn>;
const mockGetExtractionJobForArtifact =
	getExtractionJobForArtifact as ReturnType<typeof vi.fn>;
const mockGetExtractionConfig = getExtractionConfig as ReturnType<typeof vi.fn>;

const now = Date.parse("2026-05-31T10:00:00Z");
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;

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

function extractionJob(
	overrides: Partial<DocumentExtractionJobDTO> = {},
): DocumentExtractionJobDTO {
	return {
		id: "job-1",
		sourceArtifactId: "artifact-1",
		normalizedArtifactId: null,
		status: "queued",
		intakeRoute: "mineru",
		fileName: "recipe.pdf",
		attemptCount: 0,
		maxAttempts: 3,
		retryable: false,
		cancelable: true,
		error: null,
		createdAt: now,
		updatedAt: now,
		startedAt: null,
		legacy: false,
		...overrides,
	};
}

function resolvedReady(
	sourceArtifact: { id: string },
	promptArtifactId: string,
) {
	return {
		displayArtifacts: [sourceArtifact],
		promptArtifacts: [{ id: promptArtifactId }],
		items: [
			{
				requestedArtifactId: sourceArtifact.id,
				displayArtifact: sourceArtifact,
				promptArtifact: { id: promptArtifactId },
				promptReady: true,
				readinessError: null,
				contentLength: 320,
				contentPreview: "Readable text",
				contentHash: "content-hash",
				chunkCount: 2,
				extraction: null,
			},
		],
		unresolvedItems: [],
	};
}

describe("Knowledge Upload Intake", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		consoleWarnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
		mockGetProject.mockResolvedValue({
			id: "trip-project",
			name: "Vienna trip",
		});
		mockLinkProjectKnowledge.mockResolvedValue([]);
		mockAssertUploadSignatureForFile.mockResolvedValue(undefined);
		mockAssertUploadSignatureForStoredFile.mockResolvedValue(undefined);
		mockGetConfig.mockReturnValue({ maxFileUploadSize: 50 * 1024 * 1024 });
		mockGetAdapterBodySizeLimitBytes.mockReturnValue(40 * 1024 * 1024);
		mockGetExtractionConfig.mockReturnValue({ inlineBudgetMs: 1500 });
		mockStartUploadExtraction.mockResolvedValue(extractionJob());
		mockGetArtifactForUser.mockResolvedValue(null);
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
		consoleWarnSpy?.mockRestore();
		consoleWarnSpy = null;
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
			normalizedArtifact: null,
			reusedExistingArtifact: false,
		});
		mockStartUploadExtraction.mockResolvedValue(
			extractionJob({
				status: "succeeded",
				normalizedArtifactId: "normalized-1",
			}),
		);
		mockGetArtifactForUser.mockResolvedValue(normalizedArtifact);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue(
			resolvedReady(sourceArtifact, "normalized-1"),
		);

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
			promptReady: true,
			promptArtifactId: "normalized-1",
			readinessError: null,
		});
		expect(response.extraction.status).toBe("succeeded");
		expect(mockSaveUploadedArtifact).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
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
				extractionJobId: "job-1",
				extractionStatus: "succeeded",
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
			normalizedArtifact: null,
			reusedExistingArtifact: false,
			renameInfo: {
				originalName: "report.pdf",
				wasRenamed: true,
			},
		});
		mockStartUploadExtraction.mockResolvedValue(
			extractionJob({
				sourceArtifactId: "artifact-stored",
				status: "succeeded",
				normalizedArtifactId: "normalized-stored",
			}),
		);
		mockGetArtifactForUser.mockResolvedValue(normalizedArtifact);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue(
			resolvedReady(sourceArtifact, "normalized-stored"),
		);

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
	});

	// The headline of the phase: the request ends when the bytes are stored and
	// the job exists, not when a backend has finished reading the document.
	it("returns a queued job without extracting anything inside the request", async () => {
		const sourceArtifact = artifact({ id: "artifact-scan", name: "scan.pdf" });
		const file = new File(["scan"], "scan.pdf", { type: "application/pdf" });
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact: null,
			reusedExistingArtifact: false,
		});
		mockStartUploadExtraction.mockResolvedValue(
			extractionJob({
				sourceArtifactId: "artifact-scan",
				fileName: "scan.pdf",
			}),
		);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [sourceArtifact],
			promptArtifacts: [],
			items: [
				{
					requestedArtifactId: sourceArtifact.id,
					displayArtifact: sourceArtifact,
					promptArtifact: null,
					promptReady: false,
					readinessError:
						"This file is still being prepared for chat. Wait a moment and send it again.",
					readinessErrorCode: "still_preparing",
					contentLength: 0,
					contentPreview: null,
					contentHash: null,
					chunkCount: 0,
					extraction: null,
				},
			],
			unresolvedItems: [],
		});

		const response = await completeKnowledgeUploadFromFile({
			userId: "user-1",
			conversationId: "conv-1",
			file,
			traceId: "trace-queued",
			startedAt: now,
		});

		expect(response.extraction).toMatchObject({
			id: "job-1",
			status: "queued",
			intakeRoute: "mineru",
			sourceArtifactId: "artifact-scan",
		});
		expect(response.normalizedArtifact).toBeNull();
		expect(response.promptReady).toBe(false);
		// "not ready" is not "broken" — the message has to say so.
		expect(response.readinessError).toContain("still being prepared");
		// …and it has to say so in the user's language, which needs the code,
		// not the server's English sentence.
		expect(response.readinessErrorCode).toBe("still_preparing");
		expect(mockStartUploadExtraction).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				artifact: sourceArtifact,
				existingNormalizedArtifactId: null,
			}),
		);
		// No route but the deprecated multipart one waits for a verdict.
		expect(mockWaitForExtractionJobVerdict).not.toHaveBeenCalled();
	});

	it("reports a direct-text upload that settled inline as succeeded", async () => {
		const sourceArtifact = artifact({
			id: "artifact-notes",
			name: "notes.txt",
			mimeType: "text/plain",
			extension: "txt",
		});
		const normalizedArtifact = artifact({
			id: "normalized-notes",
			type: "normalized_document",
			contentText: "note text",
		});
		const file = new File(["notes"], "notes.txt", { type: "text/plain" });
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact: null,
			reusedExistingArtifact: false,
		});
		mockStartUploadExtraction.mockResolvedValue(
			extractionJob({
				sourceArtifactId: "artifact-notes",
				fileName: "notes.txt",
				intakeRoute: "direct-text",
				status: "succeeded",
				normalizedArtifactId: "normalized-notes",
				cancelable: false,
			}),
		);
		mockGetArtifactForUser.mockResolvedValue(normalizedArtifact);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue(
			resolvedReady(sourceArtifact, "normalized-notes"),
		);

		const response = await completeKnowledgeUploadFromFile({
			userId: "user-1",
			conversationId: "conv-1",
			file,
			traceId: "trace-direct-text",
			startedAt: now,
		});

		expect(response.extraction).toMatchObject({
			status: "succeeded",
			intakeRoute: "direct-text",
		});
		expect(response.normalizedArtifact).toMatchObject({
			id: "normalized-notes",
		});
		expect(response.promptReady).toBe(true);
	});

	// Bug B1: the same bytes, uploaded twice, must not be extracted twice.
	it("hands a dedupe hit's existing normalized artifact to the ledger", async () => {
		const sourceArtifact = artifact({ id: "artifact-dupe" });
		const normalizedArtifact = artifact({
			id: "normalized-dupe",
			type: "normalized_document",
			contentText: "already extracted",
		});
		const file = new File(["recipe"], "recipe.pdf", {
			type: "application/pdf",
		});
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact,
			reusedExistingArtifact: true,
		});
		mockStartUploadExtraction.mockResolvedValue(
			extractionJob({
				sourceArtifactId: "artifact-dupe",
				status: "succeeded",
				normalizedArtifactId: "normalized-dupe",
				cancelable: false,
			}),
		);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue(
			resolvedReady(sourceArtifact, "normalized-dupe"),
		);

		const response = await completeKnowledgeUploadFromFile({
			userId: "user-1",
			conversationId: "conv-1",
			file,
			traceId: "trace-dupe",
			startedAt: now,
		});

		expect(mockStartUploadExtraction).toHaveBeenCalledWith(
			expect.objectContaining({
				existingNormalizedArtifactId: "normalized-dupe",
			}),
		);
		expect(response.reusedExistingArtifact).toBe(true);
		expect(response.normalizedArtifact).toBe(normalizedArtifact);
		expect(response.extraction.status).toBe("succeeded");
		// The already-known artifact is reused as-is; nothing goes looking for it.
		expect(mockGetArtifactForUser).not.toHaveBeenCalled();
	});

	// B3/D9: the deprecated multipart route is the one caller that still waits.
	it("waits up to the inline budget when the caller asks it to", async () => {
		const sourceArtifact = artifact({ id: "artifact-legacy" });
		const file = new File(["recipe"], "recipe.pdf", {
			type: "application/pdf",
		});
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact: null,
			reusedExistingArtifact: false,
		});
		mockStartUploadExtraction.mockResolvedValue(
			extractionJob({ sourceArtifactId: "artifact-legacy" }),
		);
		mockWaitForExtractionJobVerdict.mockResolvedValue({
			settled: true,
			job: extractionJob({
				sourceArtifactId: "artifact-legacy",
				status: "succeeded",
				normalizedArtifactId: "normalized-legacy",
			}),
		});
		mockGetArtifactForUser.mockResolvedValue(
			artifact({ id: "normalized-legacy", type: "normalized_document" }),
		);
		mockResolvePromptAttachmentArtifacts.mockResolvedValue(
			resolvedReady(sourceArtifact, "normalized-legacy"),
		);

		const response = await completeKnowledgeUploadFromFile({
			userId: "user-1",
			conversationId: "conv-1",
			file,
			traceId: "trace-legacy",
			startedAt: now,
			waitForExtraction: true,
		});

		expect(mockWaitForExtractionJobVerdict).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: 1500 }),
		);
		expect(response.extraction.status).toBe("succeeded");
		expect(response.promptReady).toBe(true);
	});

	it("still answers with the old fields when the wait budget runs out", async () => {
		const sourceArtifact = artifact({ id: "artifact-slow" });
		const file = new File(["recipe"], "recipe.pdf", {
			type: "application/pdf",
		});
		mockSaveUploadedArtifact.mockResolvedValue({
			artifact: sourceArtifact,
			normalizedArtifact: null,
			reusedExistingArtifact: false,
		});
		const pending = extractionJob({
			sourceArtifactId: "artifact-slow",
			status: "parsing",
		});
		mockStartUploadExtraction.mockResolvedValue(pending);
		mockWaitForExtractionJobVerdict.mockResolvedValue({
			settled: false,
			job: pending,
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
					readinessError: "still going",
					contentLength: 0,
					contentPreview: null,
					contentHash: null,
					chunkCount: 0,
					extraction: pending,
				},
			],
			unresolvedItems: [],
		});

		const response = await completeKnowledgeUploadFromFile({
			userId: "user-1",
			conversationId: "conv-1",
			file,
			traceId: "trace-slow",
			startedAt: now,
			waitForExtraction: true,
		});

		// Backward compatible: every field the off-repo scripts read is present.
		expect(response).toMatchObject({
			artifact: sourceArtifact,
			normalizedArtifact: null,
			reusedExistingArtifact: false,
			promptReady: false,
		});
		expect(response.extraction.status).toBe("parsing");
		expect(mockGetExtractionJobForArtifact).not.toHaveBeenCalled();
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
		expect(mockStartUploadExtraction).not.toHaveBeenCalled();
	});

	it("content-checks a stored upload before it becomes an artifact", async () => {
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
		mockAssertUploadSignatureForStoredFile.mockRejectedValueOnce(
			Object.assign(new Error("fake.png doesn't look like a real png file"), {
				name: "KnowledgeUploadContentMismatchError",
				status: 415,
			}),
		);

		await expect(
			completeKnowledgeUploadFromStoredFile({
				userId: "user-1",
				conversationId: "conv-1",
				fileName: "fake.png",
				mimeType: "image/png",
				sizeBytes: 2048,
				binaryHash: "stored-binary-hash",
				tempPathAbsolute: "/tmp/fake-upload",
				traceId: "trace-mismatch",
				startedAt: now,
				logPrefix: "Raw",
			}),
		).rejects.toMatchObject({
			name: "KnowledgeUploadContentMismatchError",
			status: 415,
		});

		expect(mockAssertUploadSignatureForStoredFile).toHaveBeenCalledWith({
			fileName: "fake.png",
			mimeType: "image/png",
			tempPathAbsolute: "/tmp/fake-upload",
		});
		// Nothing was stored, so nothing has to be rolled back.
		expect(mockSaveUploadedArtifactFromStoredFile).not.toHaveBeenCalled();
	});

	it("content-checks a multipart upload before it becomes an artifact", async () => {
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
		const file = new File(["%PDF-"], "fake.png", { type: "image/png" });
		mockAssertUploadSignatureForFile.mockRejectedValueOnce(
			Object.assign(new Error("fake.png doesn't look like a real png file"), {
				name: "KnowledgeUploadContentMismatchError",
				status: 415,
			}),
		);

		await expect(
			completeKnowledgeUploadFromFile({
				userId: "user-1",
				conversationId: "conv-1",
				file,
				traceId: "trace-mismatch-file",
				startedAt: now,
			}),
		).rejects.toMatchObject({
			name: "KnowledgeUploadContentMismatchError",
			status: 415,
		});

		expect(mockAssertUploadSignatureForFile).toHaveBeenCalledWith(file);
		expect(mockSaveUploadedArtifact).not.toHaveBeenCalled();
	});

	describe("uploading straight into a project", () => {
		it("stores a library upload and links it to the given project", async () => {
			const sourceArtifact = artifact();
			const file = new File(["recipe"], "recipe.pdf", {
				type: "application/pdf",
			});
			mockSaveUploadedArtifact.mockResolvedValue({
				artifact: sourceArtifact,
				normalizedArtifact: null,
				reusedExistingArtifact: false,
			});

			const response = await completeKnowledgeUploadFromFile({
				userId: "user-1",
				conversationId: "conv-1",
				projectId: "trip-project",
				file,
				traceId: "trace-project-file",
				startedAt: now,
			});

			expect(response.artifact).toBe(sourceArtifact);
			expect(mockGetProject).toHaveBeenCalledWith("user-1", "trip-project");
			expect(mockLinkProjectKnowledge).toHaveBeenCalledWith({
				userId: "user-1",
				projectId: "trip-project",
				artifactIds: ["artifact-1"],
			});
		});

		// The raw and chunked routes both land here; the link cannot be a
		// property of the browser-File path only.
		it("links a stored upload to the project on the raw/chunked path", async () => {
			const sourceArtifact = artifact({ id: "artifact-stored" });
			mockSaveUploadedArtifactFromStoredFile.mockResolvedValue({
				artifact: sourceArtifact,
				normalizedArtifact: null,
				reusedExistingArtifact: false,
			});

			await completeKnowledgeUploadFromStoredFile({
				userId: "user-1",
				conversationId: "conv-1",
				projectId: "trip-project",
				fileName: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 2048,
				binaryHash: "stored-binary-hash",
				tempPathAbsolute: "/tmp/report-upload",
				traceId: "trace-project-stored",
				startedAt: now,
				logPrefix: "Raw",
			});

			expect(mockLinkProjectKnowledge).toHaveBeenCalledWith({
				userId: "user-1",
				projectId: "trip-project",
				artifactIds: ["artifact-stored"],
			});
		});

		it("rejects an upload naming another user's project with 400 and stores nothing", async () => {
			mockGetProject.mockResolvedValue(null);
			const file = new File(["recipe"], "recipe.pdf", {
				type: "application/pdf",
			});

			await expect(
				completeKnowledgeUploadFromFile({
					userId: "user-1",
					conversationId: "conv-1",
					projectId: "other-project",
					file,
					traceId: "trace-foreign-project",
					startedAt: now,
				}),
			).rejects.toMatchObject({
				name: "KnowledgeUploadProjectError",
				code: "invalid_project",
				status: 400,
				message: "Project not found or access denied",
			});

			// The rejection lands before the bytes are stored, so there is
			// nothing to roll back and no half-added file to explain.
			expect(mockSaveUploadedArtifact).not.toHaveBeenCalled();
			expect(mockStartUploadExtraction).not.toHaveBeenCalled();
			expect(mockLinkProjectKnowledge).not.toHaveBeenCalled();
		});

		it("links nothing when the project id is absent", async () => {
			const sourceArtifact = artifact();
			mockSaveUploadedArtifact.mockResolvedValue({
				artifact: sourceArtifact,
				normalizedArtifact: null,
				reusedExistingArtifact: false,
			});
			const file = new File(["recipe"], "recipe.pdf", {
				type: "application/pdf",
			});

			await completeKnowledgeUploadFromFile({
				userId: "user-1",
				conversationId: "conv-1",
				file,
				traceId: "trace-no-project",
				startedAt: now,
			});
			// A blank header is the same as none — the browser sets the header
			// from a prop, and "no project" must not become a lookup for "".
			await completeKnowledgeUploadFromFile({
				userId: "user-1",
				conversationId: "conv-1",
				projectId: "   ",
				file,
				traceId: "trace-blank-project",
				startedAt: now,
			});

			expect(mockGetProject).not.toHaveBeenCalled();
			expect(mockLinkProjectKnowledge).not.toHaveBeenCalled();
		});

		it("does not link when the store step fails", async () => {
			mockSaveUploadedArtifact.mockRejectedValueOnce(new Error("disk is full"));
			const file = new File(["recipe"], "recipe.pdf", {
				type: "application/pdf",
			});

			await expect(
				completeKnowledgeUploadFromFile({
					userId: "user-1",
					conversationId: "conv-1",
					projectId: "trip-project",
					file,
					traceId: "trace-store-failed",
					startedAt: now,
				}),
			).rejects.toThrow("disk is full");

			// The project was validated and the store was attempted — so this is
			// the failure ORDER under test, not an upload that never got that far.
			expect(mockGetProject).toHaveBeenCalledWith("user-1", "trip-project");
			expect(mockSaveUploadedArtifact).toHaveBeenCalled();
			expect(mockLinkProjectKnowledge).not.toHaveBeenCalled();
		});

		// A link cannot be a precondition for keeping the bytes: the document is
		// the user's and it is already in the library by the time the link runs.
		it("keeps a stored upload a success when the project vanishes before the link lands", async () => {
			const sourceArtifact = artifact();
			mockSaveUploadedArtifact.mockResolvedValue({
				artifact: sourceArtifact,
				normalizedArtifact: null,
				reusedExistingArtifact: false,
			});
			mockLinkProjectKnowledge.mockRejectedValueOnce(
				Object.assign(new Error("Project not found or access denied"), {
					name: "ProjectKnowledgeError",
					code: "project_not_found",
					status: 404,
				}),
			);
			const file = new File(["recipe"], "recipe.pdf", {
				type: "application/pdf",
			});

			const response = await completeKnowledgeUploadFromFile({
				userId: "user-1",
				conversationId: "conv-1",
				projectId: "trip-project",
				file,
				traceId: "trace-project-race",
				startedAt: now,
			});

			expect(response.artifact).toBe(sourceArtifact);
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining("project link skipped"),
				expect.objectContaining({
					traceId: "trace-project-race",
					artifactId: "artifact-1",
					projectId: "trip-project",
					code: "project_not_found",
				}),
			);
		});

		// The same rule as the test above, for the failures the policy guard
		// does not own. A `ProjectKnowledgeError` is one way a link can fail; a
		// `FOREIGN KEY constraint failed` from the project row being deleted
		// between the link's own ownership read and its insert (foreign keys are
		// ON, and the link cascades from `projects`), a locked database, or a
		// disk error are others. None of them is a reason for the file the user
		// just uploaded to never become readable — and before this test existed,
		// that is exactly what happened: the error escaped the intake call after
		// the bytes were committed but before `registerUploadExtraction` ran, so
		// the library kept a document with no extraction job behind it.
		it("registers extraction when the project link fails for an infrastructure reason", async () => {
			const sourceArtifact = artifact();
			mockSaveUploadedArtifact.mockResolvedValue({
				artifact: sourceArtifact,
				normalizedArtifact: null,
				reusedExistingArtifact: false,
			});
			mockLinkProjectKnowledge.mockRejectedValueOnce(
				new Error("FOREIGN KEY constraint failed"),
			);
			const file = new File(["recipe"], "recipe.pdf", {
				type: "application/pdf",
			});

			let escaped: unknown = null;
			let response: Awaited<
				ReturnType<typeof completeKnowledgeUploadFromFile>
			> | null = null;
			try {
				response = await completeKnowledgeUploadFromFile({
					userId: "user-1",
					conversationId: "conv-1",
					projectId: "trip-project",
					file,
					traceId: "trace-project-link-broken",
					startedAt: now,
				});
			} catch (error) {
				escaped = error;
			}

			// One assertion, so a failure names the whole consequence rather than
			// only its first symptom: the store happened (the artifact exists),
			// the extraction did not (nothing will ever read the file), and what
			// the caller got back was an error instead of an upload.
			expect({
				escaped: escaped instanceof Error ? escaped.message : null,
				storedArtifacts: mockSaveUploadedArtifact.mock.calls.length,
				extractionRegistrations: mockStartUploadExtraction.mock.calls.length,
			}).toEqual({
				escaped: null,
				storedArtifacts: 1,
				extractionRegistrations: 1,
			});
			expect(response?.artifact).toBe(sourceArtifact);
			// Not swallowed: the link failure is still on the record, under the
			// same fields the policy skip logs.
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining("project link failed"),
				expect.objectContaining({
					traceId: "trace-project-link-broken",
					userId: "user-1",
					projectId: "trip-project",
					artifactId: "artifact-1",
					code: "project_link_failed",
					message: "FOREIGN KEY constraint failed",
				}),
			);
		});
	});
});
