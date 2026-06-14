import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAuth = vi.fn();
const mockGetArtifactForUser = vi.fn();
const mockGetSourceArtifactId = vi.fn();
const mockGetChatFileByUser = vi.fn();
const mockReadChatFileContentByUser = vi.fn();

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("$lib/server/services/knowledge/store/core", () => ({
	getArtifactForUser: (...args: unknown[]) => mockGetArtifactForUser(...args),
	getSourceArtifactIdForNormalizedArtifact: (...args: unknown[]) =>
		mockGetSourceArtifactId(...args),
}));

vi.mock("$lib/server/services/chat-files", () => ({
	getChatFileByUser: (...args: unknown[]) => mockGetChatFileByUser(...args),
	readChatFileContentByUser: (...args: unknown[]) =>
		mockReadChatFileContentByUser(...args),
}));

import { GET } from "./+server";

type PreviewRouteEvent = Parameters<typeof GET>[0];

async function writePreviewFile(
	storagePath: string,
	contents: Buffer | string,
) {
	const absolutePath = join(process.cwd(), storagePath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, contents);
}

async function buildMinimalXlsxBuffer(): Promise<Buffer> {
	const JSZip = (await import("jszip")).default;
	const zip = new JSZip();
	zip.file("[Content_Types].xml", "<Types></Types>");
	zip.file("_rels/.rels", "<Relationships></Relationships>");
	zip.file("xl/workbook.xml", "<workbook></workbook>");
	zip.file("xl/_rels/workbook.xml.rels", "<Relationships></Relationships>");
	zip.file("xl/worksheets/sheet1.xml", "<worksheet></worksheet>");
	return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("GET /api/knowledge/[id]/preview", () => {
	const mockUser = { id: "user-123", email: "test@example.com" };

	function makePreviewEvent(artifactId = "artifact-123"): PreviewRouteEvent {
		return {
			locals: { user: mockUser },
			params: { id: artifactId },
		} as unknown as PreviewRouteEvent;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockImplementation(() => {});
		mockGetChatFileByUser.mockResolvedValue(null);
		mockReadChatFileContentByUser.mockResolvedValue(null);
	});

	afterEach(async () => {
		await rm(join(process.cwd(), "data", "knowledge", mockUser.id), {
			recursive: true,
			force: true,
		});
	});

	it("returns 404 when artifact not found", async () => {
		mockGetArtifactForUser.mockResolvedValue(null);

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error).toBe("Artifact not found");
	});

	it("returns 404 when artifact has no storage path or content text", async () => {
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "test.txt",
			storagePath: null,
			contentText: null,
			mimeType: "text/plain",
			extension: "txt",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error).toBe("File not available for preview");
	});

	it("returns content text for artifacts with contentText (normalized_document)", async () => {
		const contentText = "This is the normalized text content.";
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "normalized-document.txt",
			storagePath: null,
			contentText,
			mimeType: "text/plain",
			extension: "txt",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(response.headers.get("Content-Length")).toBe(
			Buffer.byteLength(contentText, "utf-8").toString(),
		);
		expect(response.headers.get("Content-Disposition")).toContain(
			"normalized-document.txt",
		);
		expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");

		const body = await response.text();
		expect(body).toBe(contentText);
	});

	it("prefers contentText over storagePath when both exist", async () => {
		await writePreviewFile(
			"data/knowledge/user-123/document.pdf",
			Buffer.from("PDF binary content"),
		);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "document.txt",
			storagePath: "data/knowledge/user-123/document.pdf",
			contentText: "Text content takes priority",
			mimeType: "text/plain",
			extension: "txt",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/plain; charset=utf-8",
		);
		const body = await response.text();
		expect(body).toBe("Text content takes priority");
	});

	it("returns file content with correct headers for PDF", async () => {
		const fileBuffer = Buffer.from("PDF content");
		await writePreviewFile("data/knowledge/user-123/document.pdf", fileBuffer);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "document.pdf",
			storagePath: "data/knowledge/user-123/document.pdf",
			mimeType: "application/pdf",
			extension: "pdf",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/pdf");
		expect(response.headers.get("Content-Length")).toBe("11");
		expect(response.headers.get("Content-Disposition")).toContain(
			"document.pdf",
		);
		expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");

		const body = await response.arrayBuffer();
		expect(Buffer.from(body).toString()).toBe("PDF content");
	});

	it("returns file content with inferred mime type from extension", async () => {
		const fileBuffer = Buffer.from("DOCX content");
		await writePreviewFile("data/knowledge/user-123/document.docx", fileBuffer);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "document.docx",
			storagePath: "data/knowledge/user-123/document.docx",
			mimeType: null,
			extension: "docx",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
	});

	it("returns 404 when file read fails with ENOENT", async () => {
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "document.pdf",
			storagePath: "data/knowledge/user-123/document.pdf",
			mimeType: "application/pdf",
			extension: "pdf",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error).toBe("File not found on disk");
	});

	it("handles image files correctly", async () => {
		const fileBuffer = Buffer.from("PNG image data");
		await writePreviewFile("data/knowledge/user-123/image.png", fileBuffer);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "image.png",
			storagePath: "data/knowledge/user-123/image.png",
			mimeType: "image/png",
			extension: "png",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/png");
	});

	it("handles XLSX files correctly", async () => {
		const fileBuffer = Buffer.from("XLSX spreadsheet data");
		await writePreviewFile(
			"data/knowledge/user-123/spreadsheet.xlsx",
			fileBuffer,
		);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "spreadsheet.xlsx",
			storagePath: "data/knowledge/user-123/spreadsheet.xlsx",
			mimeType: null,
			extension: "xlsx",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
	});

	it("handles PPTX files correctly", async () => {
		const fileBuffer = Buffer.from("PPTX presentation data");
		await writePreviewFile(
			"data/knowledge/user-123/presentation.pptx",
			fileBuffer,
		);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "presentation.pptx",
			storagePath: "data/knowledge/user-123/presentation.pptx",
			mimeType: null,
			extension: "pptx",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		);
	});

	it("handles ODT files correctly", async () => {
		const fileBuffer = Buffer.from("ODT document data");
		await writePreviewFile("data/knowledge/user-123/document.odt", fileBuffer);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "document.odt",
			storagePath: "data/knowledge/user-123/document.odt",
			mimeType: null,
			extension: "odt",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"application/vnd.oasis.opendocument.text",
		);
	});

	it("handles text files correctly", async () => {
		const fileBuffer = Buffer.from("Plain text content");
		await writePreviewFile("data/knowledge/user-123/notes.txt", fileBuffer);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "notes.txt",
			storagePath: "data/knowledge/user-123/notes.txt",
			mimeType: "text/plain",
			extension: "txt",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/plain");
	});

	it("returns shared restricted browser headers for stored HTML previews", async () => {
		const fileBuffer = Buffer.from("<!doctype html><h1>Knowledge report</h1>");
		await writePreviewFile("data/knowledge/user-123/report.html", fileBuffer);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "report.html",
			storagePath: "data/knowledge/user-123/report.html",
			mimeType: "text/html",
			extension: "html",
		});

		const response = await GET(makePreviewEvent());

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(response.headers.get("Content-Disposition")).toBe(
			'inline; filename="report.html"',
		);
		expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
		expect(response.headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
		);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(fileBuffer);
	});

	it("encodes filename in Content-Disposition header", async () => {
		const fileBuffer = Buffer.from("PDF content");
		await writePreviewFile("data/knowledge/user-123/document.pdf", fileBuffer);
		mockGetArtifactForUser.mockResolvedValue({
			id: "artifact-123",
			name: "document with spaces & special chars.pdf",
			storagePath: "data/knowledge/user-123/document.pdf",
			mimeType: "application/pdf",
			extension: "pdf",
		});

		const event = makePreviewEvent();

		const response = await GET(event);

		expect(response.status).toBe(200);
		const contentDisposition = response.headers.get("Content-Disposition");
		expect(contentDisposition).toContain("inline");
		expect(contentDisposition).toContain(
			encodeURIComponent("document with spaces & special chars.pdf"),
		);
	});
	it("resolves normalized_document to source_document for PDF preview", async () => {
		const pdfBuffer = Buffer.from("PDF binary content");
		await writePreviewFile("data/knowledge/user-123/source.pdf", pdfBuffer);

		mockGetArtifactForUser.mockImplementation(
			async (_userId: string, id: string) => {
				if (id === "normalized-123") {
					return {
						id: "normalized-123",
						name: "document.pdf",
						storagePath: null,
						contentText: "Extracted text content",
						mimeType: "text/plain",
						extension: "pdf",
						type: "normalized_document",
					};
				}
				if (id === "source-123") {
					return {
						id: "source-123",
						name: "document.pdf",
						storagePath: "data/knowledge/user-123/source.pdf",
						contentText: null,
						mimeType: "application/pdf",
						extension: "pdf",
						type: "source_document",
					};
				}
				return null;
			},
		);

		mockGetSourceArtifactId.mockResolvedValue("source-123");

		const event = makePreviewEvent("normalized-123");

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/pdf");
		const body = await response.arrayBuffer();
		expect(Buffer.from(body).toString()).toBe("PDF binary content");
	});

	it("resolves generated_output to source chat file for binary preview", async () => {
		mockGetArtifactForUser.mockResolvedValue({
			id: "generated-123",
			name: "generated_report.xlsx",
			storagePath: null,
			contentText: "Some generated text summary",
			mimeType: "text/plain",
			extension: "xlsx",
			type: "generated_output",
			metadata: { sourceChatFileId: "chatfile-456" },
		});

		mockGetChatFileByUser.mockResolvedValue({
			id: "chatfile-456",
			filename: "report.xlsx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});

		const xlsxBuffer = await buildMinimalXlsxBuffer();
		mockReadChatFileContentByUser.mockResolvedValue(xlsxBuffer);

		const event = makePreviewEvent("generated-123");

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
		expect(mockGetChatFileByUser).toHaveBeenCalledWith(
			"chatfile-456",
			"user-123",
		);
		expect(mockReadChatFileContentByUser).toHaveBeenCalledWith(
			"chatfile-456",
			"user-123",
		);
		const body = await response.arrayBuffer();
		expect(Buffer.from(body)).toEqual(xlsxBuffer);
	});

	it("rejects invalid generated_output XLSX source chat files before preview", async () => {
		mockGetArtifactForUser.mockResolvedValue({
			id: "generated-123",
			name: "generated_report.xlsx",
			storagePath: null,
			contentText: "Some generated text summary",
			mimeType: "text/plain",
			extension: "xlsx",
			type: "generated_output",
			metadata: { sourceChatFileId: "chatfile-456" },
		});

		mockGetChatFileByUser.mockResolvedValue({
			id: "chatfile-456",
			filename: "report.xlsx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});
		mockReadChatFileContentByUser.mockResolvedValue(
			Buffer.from("not an ooxml zip"),
		);

		const event = makePreviewEvent("generated-123");

		const response = await GET(event);

		expect(response.status).toBe(415);
		const body = await response.json();
		expect(body.error).toBe("Invalid generated file content");
	});
});
