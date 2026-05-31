import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/chat-files", () => ({
	getChatFileByConversationOwner: vi.fn(),
	getChatFileByUser: vi.fn(),
	readChatFileContentByConversationOwner: vi.fn(),
	readChatFileContentByUser: vi.fn(),
}));

vi.mock("$lib/server/services/file-production/read-model", () => ({
	hasSucceededFileProductionJobForChatFile: vi.fn(),
}));

import {
	type ChatFile,
	getChatFileByConversationOwner,
	getChatFileByUser,
	readChatFileContentByConversationOwner,
	readChatFileContentByUser,
} from "$lib/server/services/chat-files";
import { hasSucceededFileProductionJobForChatFile } from "$lib/server/services/file-production/read-model";
import { resolveGeneratedFileServing } from "./generated-file-serving";

const mockGetChatFileByUser = vi.mocked(getChatFileByUser);
const mockGetChatFileByConversationOwner = vi.mocked(
	getChatFileByConversationOwner,
);
const mockReadChatFileContentByUser = vi.mocked(readChatFileContentByUser);
const mockReadChatFileContentByConversationOwner = vi.mocked(
	readChatFileContentByConversationOwner,
);
const mockHasSucceededFileProductionJobForChatFile = vi.mocked(
	hasSucceededFileProductionJobForChatFile,
);

function chatFile(overrides: Partial<ChatFile> = {}): ChatFile {
	return {
		id: "file-1",
		conversationId: "conv-1",
		assistantMessageId: "message-1",
		artifactId: null,
		userId: "user-1",
		filename: "notes.txt",
		mimeType: "text/plain",
		sizeBytes: 11,
		storagePath: "conv-1/file-1.txt",
		createdAt: Date.now(),
		...overrides,
	};
}

describe("resolveGeneratedFileServing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHasSucceededFileProductionJobForChatFile.mockResolvedValue(false);
	});

	it("serves a user-owned generated file with inline preview headers", async () => {
		mockGetChatFileByUser.mockResolvedValue(chatFile());
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from("hello world"));

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Buffer.from(result.body).toString()).toBe("hello world");
		expect(result.headers).toEqual({
			"Content-Type": "text/plain",
			"Content-Length": "11",
			"Content-Disposition": 'inline; filename="notes.txt"',
			"Cache-Control": "private, max-age=3600",
		});
		expect(mockGetChatFileByUser).toHaveBeenCalledWith("file-1", "user-1");
		expect(mockGetChatFileByConversationOwner).not.toHaveBeenCalled();
		expect(mockHasSucceededFileProductionJobForChatFile).not.toHaveBeenCalled();
	});

	it("serves generated HTML previews with restrictive browser headers", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "report.html",
				mimeType: "text/html",
				sizeBytes: 31,
				storagePath: "conv-1/file-1.html",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(
			Buffer.from("<!doctype html><h1>Report</h1>"),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.headers["Content-Type"]).toBe("text/html; charset=utf-8");
		expect(result.headers["Content-Security-Policy"]).toBe(
			"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
		);
		expect(result.headers["X-Content-Type-Options"]).toBe("nosniff");
		expect(result.headers["Referrer-Policy"]).toBe("no-referrer");
	});

	it("infers preview content type for ODT files from the filename", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "draft.odt",
				mimeType: null,
				sizeBytes: 9,
				storagePath: "conv-1/file-1.odt",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from("odt bytes"));

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.headers["Content-Type"]).toBe(
			"application/vnd.oasis.opendocument.text",
		);
	});

	it("serves legacy generated shell scripts stored with generic MIME", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "install.sh",
				mimeType: "application/octet-stream",
				sizeBytes: 31,
				storagePath: "conv-1/file-1.sh",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(
			Buffer.from("#!/usr/bin/env bash\necho ok\n"),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "download",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.headers["Content-Type"]).toBe("application/x-sh");
		expect(result.headers["Content-Disposition"]).toBe(
			"attachment; filename*=UTF-8''install.sh",
		);
		expect(Buffer.from(result.body).toString()).toBe(
			"#!/usr/bin/env bash\necho ok\n",
		);
	});

	it("returns not found when lookup cannot find the generated file", async () => {
		mockGetChatFileByUser.mockResolvedValue(null);
		mockGetChatFileByConversationOwner.mockResolvedValue(null);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "missing-file",
			mode: "preview",
		});

		expect(result).toEqual({
			ok: false,
			status: 404,
			error: "File not found",
		});
		expect(mockGetChatFileByUser).toHaveBeenCalledWith(
			"missing-file",
			"user-1",
		);
		expect(mockGetChatFileByConversationOwner).toHaveBeenCalledWith(
			"missing-file",
			"user-1",
		);
	});

	it("returns not found for unassigned generated files without an eligible job link", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({ assistantMessageId: null }),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "download",
		});

		expect(result).toEqual({
			ok: false,
			status: 404,
			error: "File not found",
		});
		expect(mockHasSucceededFileProductionJobForChatFile).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			chatGeneratedFileId: "file-1",
		});
		expect(mockReadChatFileContentByUser).not.toHaveBeenCalled();
		expect(mockReadChatFileContentByConversationOwner).not.toHaveBeenCalled();
	});

	it("serves unassigned generated files linked to a succeeded file-production job", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({ assistantMessageId: null }),
		);
		mockHasSucceededFileProductionJobForChatFile.mockResolvedValue(true);
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from("job output"));

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "download",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Buffer.from(result.body).toString()).toBe("job output");
		expect(result.headers["Content-Disposition"]).toBe(
			"attachment; filename*=UTF-8''notes.txt",
		);
		expect(mockHasSucceededFileProductionJobForChatFile).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			chatGeneratedFileId: "file-1",
		});
	});

	it("returns a read failure when validated metadata points to missing bytes", async () => {
		mockGetChatFileByUser.mockResolvedValue(chatFile());
		mockReadChatFileContentByUser.mockResolvedValue(null);
		mockReadChatFileContentByConversationOwner.mockResolvedValue(null);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "download",
		});

		expect(result).toEqual({
			ok: false,
			status: 500,
			error: "Failed to read file content",
		});
	});

	it("falls back to conversation-owner lookup for legacy generated files", async () => {
		mockGetChatFileByUser.mockResolvedValue(null);
		mockGetChatFileByConversationOwner.mockResolvedValue(
			chatFile({
				userId: "legacy-mismatch",
				filename: "legacy.pdf",
				mimeType: "application/pdf",
				sizeBytes: 5,
				storagePath: "conv-1/file-1.pdf",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(null);
		mockReadChatFileContentByConversationOwner.mockResolvedValue(
			Buffer.from("hello"),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "download",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Buffer.from(result.body).toString()).toBe("hello");
		expect(result.headers["Content-Type"]).toBe("application/pdf");
		expect(result.headers["Content-Disposition"]).toBe(
			"attachment; filename*=UTF-8''legacy.pdf",
		);
		expect(mockGetChatFileByConversationOwner).toHaveBeenCalledWith(
			"file-1",
			"user-1",
		);
		expect(mockReadChatFileContentByConversationOwner).toHaveBeenCalledWith(
			"file-1",
			"user-1",
		);
	});

	it("rejects unsupported filename and MIME pairs before reading bytes", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "report.pdf",
				mimeType: "text/plain",
				storagePath: "conv-1/file-1.pdf",
			}),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
		});

		expect(result).toEqual({
			ok: false,
			status: 415,
			error: "Unsupported generated file type",
		});
		expect(mockReadChatFileContentByUser).not.toHaveBeenCalled();
		expect(mockReadChatFileContentByConversationOwner).not.toHaveBeenCalled();
	});

	it("rejects invalid generated file bytes after reading content", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "workbook.xlsx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				sizeBytes: 16,
				storagePath: "conv-1/file-1.xlsx",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(
			Buffer.from("not an ooxml zip"),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "download",
		});

		expect(result).toEqual({
			ok: false,
			status: 415,
			error: "Invalid generated file content",
		});
	});

	it("serves downloads with attachment headers and optional display filename", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "raw-output.json",
				mimeType: "application/json",
				sizeBytes: 2,
				storagePath: "conv-1/file-1.json",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from("{}"));

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "download",
			displayFilename: "Final Report.json",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.headers["Content-Type"]).toBe("application/json");
		expect(result.headers["Content-Length"]).toBe("2");
		expect(result.headers["Content-Disposition"]).toBe(
			"attachment; filename*=UTF-8''Final%20Report.json",
		);
		expect(result.headers["Cache-Control"]).toBe("private, no-store");
		expect(result.headers["Content-Security-Policy"]).toBeUndefined();
	});
});
