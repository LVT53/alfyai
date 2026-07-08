import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary, KnowledgeUploadResponse } from "$lib/types";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/attachment-trace", () => ({
	createAttachmentTraceId: vi.fn(() => "trace-upload"),
}));

vi.mock("$lib/server/services/knowledge/upload-intake", () => ({
	completeKnowledgeUploadFromFile: vi.fn(),
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
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	completeKnowledgeUploadFromFile,
	isKnowledgeUploadConversationError,
	resolveKnowledgeUploadLimits,
} from "$lib/server/services/knowledge/upload-intake";
import { POST } from "./+server";

const mockRequireAuth = vi.mocked(requireAuth);
const mockCompleteKnowledgeUploadFromFile = vi.mocked(
	completeKnowledgeUploadFromFile,
);
const mockIsKnowledgeUploadConversationError = vi.mocked(
	isKnowledgeUploadConversationError,
);
const mockResolveKnowledgeUploadLimits = vi.mocked(
	resolveKnowledgeUploadLimits,
);
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;
type KnowledgeUploadEvent = Parameters<typeof POST>[0];

function uploadResponse(overrides: Partial<KnowledgeUploadResponse> = {}) {
	const artifact = {
		id: "artifact-1",
		type: "source_document",
		retrievalClass: "durable",
		name: "doc.pdf",
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: "conv-1",
		summary: "Doc",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} satisfies ArtifactSummary;

	return {
		artifact,
		normalizedArtifact: null,
		reusedExistingArtifact: false,
		promptReady: true,
		promptArtifactId: null,
		readinessError: null,
		...overrides,
	} satisfies KnowledgeUploadResponse;
}

function makeEventWithFormData(formData: FormData): KnowledgeUploadEvent {
	return {
		request: {
			formData: vi.fn().mockResolvedValue(formData),
			headers: {
				get: vi.fn().mockReturnValue(null),
			},
		},
		locals: { user: { id: "user-1", email: "test@example.com" } },
		params: {},
		url: new URL("http://localhost/api/knowledge/upload"),
		route: { id: "/api/knowledge/upload" },
	} as unknown as KnowledgeUploadEvent;
}

describe("POST /api/knowledge/upload", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consoleInfoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		mockRequireAuth.mockReturnValue(undefined);
		mockCompleteKnowledgeUploadFromFile.mockResolvedValue(uploadResponse());
		mockIsKnowledgeUploadConversationError.mockReturnValue(false);
	});

	afterEach(() => {
		consoleInfoSpy?.mockRestore();
		consoleInfoSpy = null;
	});

	it("rejects files larger than 100MB", async () => {
		const formData = new FormData();
		const file = new File(["tiny"], "large.pdf", { type: "application/pdf" });
		Object.defineProperty(file, "size", { value: 100 * 1024 * 1024 + 1 });
		formData.append("file", file);
		formData.append("conversationId", "conv-1");

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/100MB/i);
		expect(mockCompleteKnowledgeUploadFromFile).not.toHaveBeenCalled();
	});

	it("returns prompt-ready metadata when a normalized artifact exists", async () => {
		const artifact = {
			id: "artifact-1",
			type: "source_document",
			retrievalClass: "durable",
			name: "recipe.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Recipe",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ArtifactSummary;
		const normalizedArtifact = {
			id: "normalized-1",
			type: "normalized_document",
			retrievalClass: "durable",
			name: "recipe.txt",
			mimeType: "text/plain",
			sizeBytes: 400,
			conversationId: "conv-1",
			summary: "Recipe text",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ArtifactSummary;
		mockCompleteKnowledgeUploadFromFile.mockResolvedValue(
			uploadResponse({
				artifact,
				normalizedArtifact,
				promptReady: true,
				promptArtifactId: "normalized-1",
				readinessError: null,
			}),
		);

		const formData = new FormData();
		formData.append(
			"file",
			new File(["recipe"], "recipe.pdf", { type: "application/pdf" }),
		);
		formData.append("conversationId", "conv-1");

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.promptReady).toBe(true);
		expect(data.promptArtifactId).toBe("normalized-1");
		expect(data.readinessError).toBeNull();
	});

	it("keeps upload successful when a normalized fallback provides prompt-ready text", async () => {
		const artifact = {
			id: "artifact-image-415",
			type: "source_document",
			retrievalClass: "durable",
			name: "photo.png",
			mimeType: "image/png",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Image OCR",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ArtifactSummary;
		const normalizedArtifact = {
			id: "normalized-image-415",
			type: "normalized_document",
			retrievalClass: "durable",
			name: "photo.txt",
			mimeType: "text/plain",
			sizeBytes: 240,
			conversationId: "conv-1",
			summary: "OCR text",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ArtifactSummary;

		mockCompleteKnowledgeUploadFromFile.mockResolvedValue(
			uploadResponse({
				artifact,
				normalizedArtifact,
				promptReady: true,
				readinessError: null,
			}),
		);

		const formData = new FormData();
		formData.append(
			"file",
			new File(["image"], "photo.png", { type: "image/png" }),
		);
		formData.append("conversationId", "conv-1");

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.promptReady).toBe(true);
		expect(data.readinessError).toBeNull();
	});

	it("returns a readiness error when the file cannot be normalized for chat", async () => {
		const artifact = {
			id: "artifact-2",
			type: "source_document",
			retrievalClass: "durable",
			name: "scan.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Scan",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ArtifactSummary;
		mockCompleteKnowledgeUploadFromFile.mockResolvedValue(
			uploadResponse({
				artifact,
				normalizedArtifact: null,
				promptReady: false,
				promptArtifactId: null,
				readinessError: "This file could not be prepared for chat.",
			}),
		);

		const formData = new FormData();
		formData.append(
			"file",
			new File(["scan"], "scan.pdf", { type: "application/pdf" }),
		);
		formData.append("conversationId", "conv-1");

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.promptReady).toBe(false);
		expect(data.promptArtifactId).toBeNull();
		expect(data.readinessError).toMatch(/could not be prepared for chat/i);
	});

	it("returns promptReady false when the normalized artifact exists but the extracted content is too thin", async () => {
		const artifact = {
			id: "artifact-3",
			type: "source_document",
			retrievalClass: "durable",
			name: "emptyish.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Thin extraction",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ArtifactSummary;
		const normalizedArtifact = {
			id: "normalized-3",
			type: "normalized_document",
			retrievalClass: "durable",
			name: "emptyish.txt",
			mimeType: "text/plain",
			sizeBytes: 12,
			conversationId: "conv-1",
			summary: "Thin text",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ArtifactSummary;
		mockCompleteKnowledgeUploadFromFile.mockResolvedValue(
			uploadResponse({
				artifact,
				normalizedArtifact,
				promptReady: false,
				promptArtifactId: null,
				readinessError:
					"This file was uploaded, but no usable readable text could be prepared for chat from it.",
			}),
		);

		const formData = new FormData();
		formData.append(
			"file",
			new File(["thin"], "emptyish.pdf", { type: "application/pdf" }),
		);
		formData.append("conversationId", "conv-1");

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.promptReady).toBe(false);
		expect(data.promptArtifactId).toBeNull();
		expect(data.readinessError).toMatch(/usable readable text/i);
	});

	it("returns updated 413 guidance when multipart parsing exceeds the server limit", async () => {
		const event = {
			request: {
				formData: vi
					.fn()
					.mockRejectedValue(new Error("request body size exceeded")),
				headers: {
					get: vi.fn().mockReturnValue("99999999"),
				},
			},
			locals: { user: { id: "user-1", email: "test@example.com" } },
			params: {},
			url: new URL("http://localhost/api/knowledge/upload"),
			route: { id: "/api/knowledge/upload" },
		} as unknown as KnowledgeUploadEvent;

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(413);
		expect(data.error).toMatch(/100MB/i);
		expect(data.error).toMatch(/BODY_SIZE_LIMIT/i);
	});

	it("rejects oversized multipart bodies before parsing them", async () => {
		const formData = vi.fn();
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const event = {
			request: {
				formData,
				headers: {
					get: vi.fn().mockReturnValue(String(102 * 1024 * 1024)),
				},
			},
			locals: { user: { id: "user-1", email: "test@example.com" } },
			params: {},
			url: new URL("http://localhost/api/knowledge/upload"),
			route: { id: "/api/knowledge/upload" },
		} as unknown as KnowledgeUploadEvent;

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(413);
		expect(data.code).toBe("upload_body_too_large");
		expect(data.error).toMatch(/BODY_SIZE_LIMIT/i);
		expect(formData).not.toHaveBeenCalled();
		expect(mockCompleteKnowledgeUploadFromFile).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("rejects uploads above the adapter BODY_SIZE_LIMIT before multipart parsing", async () => {
		mockResolveKnowledgeUploadLimits.mockReturnValueOnce({
			maxFileUploadSize: 100 * 1024 * 1024,
			adapterBodySizeLimit: 40 * 1024 * 1024,
			multipartBodyLimit: 40 * 1024 * 1024,
			storedFileLimit: 40 * 1024 * 1024,
			chunkFileLimit: 40 * 1024 * 1024,
			chunkBodyLimit: 1024 * 1024,
			multipartOverheadAllowance: 1024 * 1024,
		});
		const formData = vi.fn();
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const event = {
			request: {
				formData,
				headers: {
					get: vi.fn((name: string) => {
						const normalized = name.toLowerCase();
						if (normalized === "content-length")
							return String(47 * 1024 * 1024);
						if (normalized === "x-alfyai-upload-name")
							return encodeURIComponent("large.pdf");
						if (normalized === "x-alfyai-upload-size")
							return String(46 * 1024 * 1024);
						return null;
					}),
				},
			},
			locals: { user: { id: "user-1", email: "test@example.com" } },
			params: {},
			url: new URL("http://localhost/api/knowledge/upload"),
			route: { id: "/api/knowledge/upload" },
		} as unknown as KnowledgeUploadEvent;

		try {
			const response = await POST(event);
			const data = await response.json();

			expect(response.status).toBe(413);
			expect(data.code).toBe("upload_body_too_large");
			expect(data.error).toMatch(/40MB/i);
			expect(data.details.fileName).toBe("large.pdf");
			expect(formData).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("returns an explicit upload aborted error when multipart parsing is interrupted", async () => {
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const event = {
			request: {
				formData: vi.fn().mockRejectedValue(new Error("aborted")),
				headers: {
					get: vi.fn((name: string) => {
						const normalized = name.toLowerCase();
						if (normalized === "content-length") return "19021532";
						if (normalized === "x-alfyai-upload-name")
							return encodeURIComponent("Quarterly report.pdf");
						if (normalized === "x-alfyai-upload-size") return "18874368";
						return null;
					}),
				},
				signal: { aborted: true },
			},
			locals: { user: { id: "user-1", email: "test@example.com" } },
			params: {},
			url: new URL("http://localhost/api/knowledge/upload"),
			route: { id: "/api/knowledge/upload" },
		} as unknown as KnowledgeUploadEvent;

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe("upload_aborted");
		expect(data.error).toMatch(/Quarterly report\.pdf/i);
		expect(data.error).toMatch(/BODY_SIZE_LIMIT/i);
		expect(data.details.classification).toBe(
			"connection_closed_before_multipart_parse",
		);
		expect(data.details.requestSignalAborted).toBe(true);
		expect(mockCompleteKnowledgeUploadFromFile).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("uploads a conversation-scoped attachment", async () => {
		const artifact = {
			id: "artifact-1",
			type: "source_document",
			retrievalClass: "durable",
			name: "doc.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Doc",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ArtifactSummary;
		mockCompleteKnowledgeUploadFromFile.mockResolvedValue(
			uploadResponse({
				artifact,
				normalizedArtifact: null,
			}),
		);

		const formData = new FormData();
		formData.append(
			"file",
			new File(["doc"], "doc.pdf", { type: "application/pdf" }),
		);
		formData.append("conversationId", "conv-1");

		const response = await POST(makeEventWithFormData(formData));

		expect(response.status).toBe(200);
		expect(mockCompleteKnowledgeUploadFromFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		);
	});

	it("returns 400 when conversationId does not exist", async () => {
		const error = new Error("Conversation not found or access denied");
		mockCompleteKnowledgeUploadFromFile.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		const formData = new FormData();
		formData.append(
			"file",
			new File(["doc"], "doc.pdf", { type: "application/pdf" }),
		);
		formData.append("conversationId", "missing-conv");

		const response = await POST(makeEventWithFormData(formData));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/conversation not found/i);
		expect(mockCompleteKnowledgeUploadFromFile).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "missing-conv",
			}),
		);
	});
});
