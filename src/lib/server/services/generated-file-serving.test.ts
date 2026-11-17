import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/chat-files", () => ({
	getChatFileByConversationOwner: vi.fn(),
	getChatFileByUser: vi.fn(),
	readChatFileContentByConversationOwner: vi.fn(),
	readChatFileContentByUser: vi.fn(),
}));

vi.mock("$lib/server/services/file-production/read-model", () => ({
	getSucceededFileProductionJobForChatFile: vi.fn(),
}));

import {
	type ChatFile,
	getChatFileByConversationOwner,
	getChatFileByUser,
	readChatFileContentByConversationOwner,
	readChatFileContentByUser,
} from "$lib/server/services/chat-files";
import { getSucceededFileProductionJobForChatFile } from "$lib/server/services/file-production/read-model";
import { withReportBridge } from "$lib/shared/read-aloud/report-bridge";
import {
	readStandardReportHtml,
	resolveGeneratedFileServing,
} from "./generated-file-serving";

const mockGetChatFileByUser = vi.mocked(getChatFileByUser);
const mockGetChatFileByConversationOwner = vi.mocked(
	getChatFileByConversationOwner,
);
const mockReadChatFileContentByUser = vi.mocked(readChatFileContentByUser);
const mockReadChatFileContentByConversationOwner = vi.mocked(
	readChatFileContentByConversationOwner,
);
const mockGetSucceededFileProductionJobForChatFile = vi.mocked(
	getSucceededFileProductionJobForChatFile,
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
		mockGetSucceededFileProductionJobForChatFile.mockResolvedValue(null);
	});

	afterEach(async () => {
		await rm(join(process.cwd(), "data", "chat-files", "conv-1"), {
			recursive: true,
			force: true,
		});
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
		expect(result.status).toBe(200);
		expect(Buffer.from(result.body).toString()).toBe("hello world");
		expect(result.headers).toEqual({
			"Content-Type": "text/plain",
			"Content-Length": "11",
			"Accept-Ranges": "bytes",
			"Content-Disposition": `inline; filename="notes.txt"; filename*=UTF-8''notes.txt`,
			"Cache-Control": "private, max-age=3600",
		});
		expect(mockGetChatFileByUser).toHaveBeenCalledWith("file-1", "user-1");
		expect(mockGetChatFileByConversationOwner).not.toHaveBeenCalled();
		expect(mockGetSucceededFileProductionJobForChatFile).not.toHaveBeenCalled();
	});

	it("serves a valid byte range for generated preview requests", async () => {
		mockGetChatFileByUser.mockResolvedValue(chatFile());
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from("hello world"));

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
			rangeHeader: "bytes=6-10",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe(206);
		expect(Buffer.from(result.body).toString()).toBe("world");
		expect(result.headers).toMatchObject({
			"Accept-Ranges": "bytes",
			"Content-Length": "5",
			"Content-Range": "bytes 6-10/11",
			"Content-Type": "text/plain",
		});
		expect(result.headers["Content-Disposition"]).toBe(
			`inline; filename="notes.txt"; filename*=UTF-8''notes.txt`,
		);
	});

	it("serves range-safe generated file ranges without reading the full file", async () => {
		const storagePath = "conv-1/file-1.pdf";
		const absolutePath = join(process.cwd(), "data", "chat-files", storagePath);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, Buffer.from("0123456789"));
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 10,
				storagePath,
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(null);
		mockReadChatFileContentByConversationOwner.mockResolvedValue(null);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
			rangeHeader: "bytes=5-7",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe(206);
		expect(Buffer.from(result.body).toString()).toBe("567");
		expect(result.headers).toMatchObject({
			"Content-Length": "3",
			"Content-Range": "bytes 5-7/10",
			"Content-Type": "application/pdf",
		});
		expect(mockReadChatFileContentByUser).not.toHaveBeenCalled();
		expect(mockReadChatFileContentByConversationOwner).not.toHaveBeenCalled();
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

	it("serves document-source report HTML previews with the report runtime policy", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "atlas-report.html",
				mimeType: "text/html",
				sizeBytes: 31,
				storagePath: "conv-1/file-1.html",
			}),
		);
		mockGetSucceededFileProductionJobForChatFile.mockResolvedValue({
			id: "job-1",
			sourceMode: "document_source",
			origin: "file_production",
		});
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
			"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
		);
		expect(result.headers["X-Content-Type-Options"]).toBe("nosniff");
		expect(result.headers["Referrer-Policy"]).toBe("no-referrer");
		expect(mockGetSucceededFileProductionJobForChatFile).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			chatGeneratedFileId: "file-1",
		});
	});

	it("serves generated SVG previews with restrictive browser headers", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "diagram.svg",
				mimeType: "image/svg+xml",
				sizeBytes: 38,
				storagePath: "conv-1/file-1.svg",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(
			Buffer.from('<svg><script>alert("xss")</script></svg>'),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.headers["Content-Type"]).toBe("image/svg+xml");
		expect(result.headers["Content-Security-Policy"]).toBe(
			"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
		);
		expect(result.headers["X-Content-Type-Options"]).toBe("nosniff");
		expect(result.headers["Referrer-Policy"]).toBe("no-referrer");
	});

	it("serves generated SVG previews with restrictive headers when the display filename omits the extension", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				filename: "diagram.svg",
				mimeType: "text/plain",
				sizeBytes: 16,
				storagePath: "conv-1/file-1.svg",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from("<svg></svg>"));

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
			displayFilename: "Diagram",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.headers["Content-Type"]).toBe("text/plain");
		expect(result.headers["Content-Disposition"]).toBe(
			`inline; filename="Diagram"; filename*=UTF-8''Diagram`,
		);
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
			`attachment; filename="install.sh"; filename*=UTF-8''install.sh`,
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
		expect(mockGetSucceededFileProductionJobForChatFile).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			chatGeneratedFileId: "file-1",
		});
		expect(mockReadChatFileContentByUser).not.toHaveBeenCalled();
		expect(mockReadChatFileContentByConversationOwner).not.toHaveBeenCalled();
	});

	it("serves a board's poster, which hangs from no reply on purpose, with no job link", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				assistantMessageId: null,
				filename: "canvas-poster-board-1-app-1.png",
				mimeType: "image/png",
			}),
		);
		mockReadChatFileContentByUser.mockResolvedValue(
			Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
				0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
				0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
				0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
			]),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.headers["Content-Type"]).toBe("image/png");
		expect(mockGetSucceededFileProductionJobForChatFile).not.toHaveBeenCalled();
	});

	it("still refuses an unassigned file that only looks like one (a poster's name is a png's)", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({
				assistantMessageId: null,
				filename: "canvas-poster-board-1-app-1.txt",
				mimeType: "text/plain",
			}),
		);

		const result = await resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
		});

		expect(result).toEqual({ ok: false, status: 404, error: "File not found" });
	});

	it("serves unassigned generated files linked to a succeeded file-production job", async () => {
		mockGetChatFileByUser.mockResolvedValue(
			chatFile({ assistantMessageId: null }),
		);
		mockGetSucceededFileProductionJobForChatFile.mockResolvedValue({
			id: "job-1",
			sourceMode: "program",
			origin: "file_production",
		});
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
			`attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`,
		);
		expect(mockGetSucceededFileProductionJobForChatFile).toHaveBeenCalledWith({
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
			`attachment; filename="legacy.pdf"; filename*=UTF-8''legacy.pdf`,
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
			`attachment; filename="Final Report.json"; filename*=UTF-8''Final%20Report.json`,
		);
		expect(result.headers["Cache-Control"]).toBe("private, no-store");
		expect(result.headers["Content-Security-Policy"]).toBeUndefined();
	});
});

// Read aloud's report target (`/api/read-aloud/sessions`): the words are checked
// against the report the panel's preview shows, read by the preview's own rules.
describe("readStandardReportHtml", () => {
	const REPORT_HTML = "<!doctype html><h1>Report</h1>";
	const reportFile = () =>
		chatFile({
			filename: "atlas-report.html",
			mimeType: "text/html",
			sizeBytes: 31,
			storagePath: "conv-1/file-1.html",
		});
	const documentSourceJob = {
		id: "job-1",
		sourceMode: "document_source" as const,
		origin: "file_production" as const,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSucceededFileProductionJobForChatFile.mockResolvedValue(null);
	});

	it("is a standard report's HTML, for the person the preview serves it to", async () => {
		mockGetChatFileByUser.mockResolvedValue(reportFile());
		mockGetSucceededFileProductionJobForChatFile.mockResolvedValue(
			documentSourceJob,
		);
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from(REPORT_HTML));
		await expect(
			readStandardReportHtml({ userId: "user-1", fileId: "file-1" }),
		).resolves.toBe(REPORT_HTML);
		expect(mockGetChatFileByUser).toHaveBeenCalledWith("file-1", "user-1");
	});

	it("is null for a file the preview would not serve this person", async () => {
		mockGetChatFileByUser.mockResolvedValue(null);
		mockGetChatFileByConversationOwner.mockResolvedValue(null);
		await expect(
			readStandardReportHtml({ userId: "user-2", fileId: "file-1" }),
		).resolves.toBeNull();
		expect(mockReadChatFileContentByUser).not.toHaveBeenCalled();
	});

	it("is null for HTML that is not a standard report (its preview runs no script)", async () => {
		mockGetChatFileByUser.mockResolvedValue(reportFile());
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from(REPORT_HTML));
		await expect(
			readStandardReportHtml({ userId: "user-1", fileId: "file-1" }),
		).resolves.toBeNull();
	});

	it("is null for a file that is not HTML, whatever made it", async () => {
		mockGetChatFileByUser.mockResolvedValue(chatFile());
		mockGetSucceededFileProductionJobForChatFile.mockResolvedValue(
			documentSourceJob,
		);
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from("hello world"));
		await expect(
			readStandardReportHtml({ userId: "user-1", fileId: "file-1" }),
		).resolves.toBeNull();
	});
});

// Read aloud's bridge (`$lib/shared/read-aloud/report-bridge.ts`): the server adds
// it to a standard report's preview response, at preview time, so a report made
// before read aloud gets it too. The panel frames the report by that address.
describe("read aloud's bridge in a standard report's preview", () => {
	const REPORT_HTML =
		"<!doctype html><html><body><h1>Report</h1><script>window.ready=true</script></body></html>";
	const ORIGIN = "https://alfy.example";
	const reportFile = () =>
		chatFile({
			filename: "atlas-report.html",
			mimeType: "text/html",
			sizeBytes: REPORT_HTML.length,
			storagePath: "conv-1/file-1.html",
		});
	const documentSourceJob = {
		id: "job-1",
		sourceMode: "document_source" as const,
		origin: "file_production" as const,
	};
	const serve = (
		mode: "preview" | "download",
		bridgeOrigin: string | null = ORIGIN,
	) =>
		resolveGeneratedFileServing({
			userId: "user-1",
			fileId: "file-1",
			mode,
			bridgeOrigin,
		});
	const text = (body: Uint8Array) => Buffer.from(body).toString("utf8");

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetChatFileByUser.mockResolvedValue(reportFile());
		mockGetSucceededFileProductionJobForChatFile.mockResolvedValue(
			documentSourceJob,
		);
		mockReadChatFileContentByUser.mockResolvedValue(Buffer.from(REPORT_HTML));
	});

	it("is the last thing in a standard report's preview, and its length counts it", async () => {
		const result = await serve("preview");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const body = text(result.body);
		expect(body).toBe(withReportBridge(REPORT_HTML, ORIGIN));
		expect(body).not.toBe(REPORT_HTML);
		expect(result.headers["Content-Length"]).toBe(
			String(Buffer.byteLength(body)),
		);
		// The report's own policy, unchanged: it is what lets the bridge run.
		expect(result.headers["Content-Security-Policy"]).toBe(
			"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
		);
	});

	it("is counted by a range: the range is of the report with the bridge in it", async () => {
		const full = Buffer.from(withReportBridge(REPORT_HTML, ORIGIN), "utf8");
		const ranged = (rangeHeader: string) =>
			resolveGeneratedFileServing({
				userId: "user-1",
				fileId: "file-1",
				mode: "preview",
				bridgeOrigin: ORIGIN,
				rangeHeader,
			});
		const head = await ranged("bytes=0-9");
		expect(head.ok && head.status).toBe(206);
		if (!head.ok) return;
		expect(head.headers["Content-Range"]).toBe(`bytes 0-9/${full.length}`);
		expect(text(head.body)).toBe(full.subarray(0, 10).toString("utf8"));
		const end = full.length - 1;
		const tail = await ranged(`bytes=${end - 19}-${end}`);
		expect(tail.ok && text(tail.body)).toBe(
			full.subarray(end - 19).toString("utf8"),
		);
		expect(tail.ok && tail.headers["Content-Range"]).toBe(
			`bytes ${end - 19}-${end}/${full.length}`,
		);
	});

	it("is never in a download", async () => {
		const result = await serve("download");
		expect(result.ok && text(result.body)).toBe(REPORT_HTML);
	});

	it("is never in HTML that is not a standard report", async () => {
		mockGetSucceededFileProductionJobForChatFile.mockResolvedValue(null);
		const result = await serve("preview");
		expect(result.ok && text(result.body)).toBe(REPORT_HTML);
	});

	it("is not added without the app's origin, and the session route reads the report as written", async () => {
		const result = await serve("preview", null);
		expect(result.ok && text(result.body)).toBe(REPORT_HTML);
		await expect(
			readStandardReportHtml({ userId: "user-1", fileId: "file-1" }),
		).resolves.toBe(REPORT_HTML);
	});
});
