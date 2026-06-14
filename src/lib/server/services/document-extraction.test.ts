import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractDocumentText,
	resetDocumentExtractionExecutableCache,
} from "./document-extraction";

vi.mock("../config-store", () => ({
	getConfig: vi.fn(),
}));

const { readFileMock } = vi.hoisted(() => ({
	readFileMock: vi.fn().mockResolvedValue(Buffer.from("mock file content")),
}));

vi.mock("node:fs/promises", () => ({
	readFile: readFileMock,
	default: { readFile: readFileMock },
}));

import { getConfig } from "../config-store";

const mockGetConfig = getConfig as unknown as ReturnType<typeof vi.fn>;

function createMockResponse(status: number, json: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(json),
	};
}

function mineruMdResponse(filename: string, mdContent: string) {
	const stem = filename.replace(/\.[^.]+$/, "");
	return { results: { [stem]: { md_content: mdContent } } };
}

describe("extractDocumentText", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetDocumentExtractionExecutableCache();

		mockGetConfig.mockReturnValue({
			mineruApiUrl: "http://127.0.0.1:8001",
			mineruTimeoutMs: 300000,
		});
	});

	it("returns markdown text on successful MinerU response", async () => {
		const markdown =
			"# Hello\n\nThis is **markdown** content.\n\n| A | B |\n|---|---|\n| 1 | 2 |";

		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					createMockResponse(200, mineruMdResponse("file.pdf", markdown)),
				),
		);

		const result = await extractDocumentText(
			"/path/to/file.pdf",
			"application/pdf",
			"file.pdf",
		);

		expect(result.text).toBe(markdown);
		expect(result.mimeType).toBe("text/markdown");
		expect(result.normalizedName).toBe("file.md");
	});

	it("reads markdown files directly without sending them to MinerU", async () => {
		readFileMock.mockResolvedValueOnce(
			Buffer.from("# Notes\n\nDirect markdown."),
		);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await extractDocumentText(
			"/path/to/notes.md",
			"text/markdown",
			"notes.md",
		);

		expect(result).toEqual({
			text: "# Notes\n\nDirect markdown.",
			normalizedName: "notes.md",
			mimeType: "text/markdown",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reads plain text files directly without sending them to MinerU", async () => {
		readFileMock.mockResolvedValueOnce(Buffer.from("Plain text notes."));
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await extractDocumentText(
			"/path/to/notes.txt",
			"text/plain",
			"notes.txt",
		);

		expect(result.text).toBe("Plain text notes.");
		expect(result.normalizedName).toBe("notes.md");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns null text when MinerU returns empty md_content", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					createMockResponse(200, mineruMdResponse("empty.pdf", "")),
				),
		);

		const result = await extractDocumentText(
			"/path/to/empty.pdf",
			"application/pdf",
			"empty.pdf",
		);

		expect(result.text).toBeNull();
		expect(result.mimeType).toBe("text/markdown");
	});

	it("returns null text when MinerU returns error status", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					createMockResponse(500, { error: "Internal Server Error" }),
				),
		);

		const result = await extractDocumentText(
			"/path/to/bad.pdf",
			"application/pdf",
			"bad.pdf",
		);

		expect(result.text).toBeNull();
	});

	it("returns null text when response has no results", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(createMockResponse(200, { other: "data" })),
		);

		const result = await extractDocumentText(
			"/path/to/weird.pdf",
			"application/pdf",
			"weird.pdf",
		);

		expect(result.text).toBeNull();
	});

	it("returns null text when results are empty", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(createMockResponse(200, { results: {} })),
		);

		const result = await extractDocumentText(
			"/path/to/empty_results.pdf",
			"application/pdf",
			"empty_results.pdf",
		);

		expect(result.text).toBeNull();
	});

	it("returns null text when MinerU is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
		);

		const result = await extractDocumentText(
			"/path/to/file.pdf",
			"application/pdf",
			"file.pdf",
		);

		expect(result.text).toBeNull();
	});

	it("returns null text on timeout", async () => {
		mockGetConfig.mockReturnValue({
			mineruApiUrl: "http://127.0.0.1:8001",
			mineruTimeoutMs: 1000,
		});

		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => {
				return new Promise((_, reject) => {
					const error = new DOMException(
						"The operation was aborted",
						"AbortError",
					);
					setTimeout(() => reject(error), 2000);
				});
			}),
		);

		const result = await extractDocumentText(
			"/path/to/slow.pdf",
			"application/pdf",
			"slow.pdf",
		);

		expect(result.text).toBeNull();
	});

	it("handles missing mimeType gracefully", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					createMockResponse(200, mineruMdResponse("unknown.bin", "content")),
				),
		);

		const result = await extractDocumentText(
			"/path/to/unknown.bin",
			null,
			"unknown.bin",
		);

		expect(result.text).toBe("content");
		expect(result.normalizedName).toBe("unknown.md");
	});

	it("sends files field with correct multipart form data", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				createMockResponse(200, mineruMdResponse("doc.docx", "data")),
			);
		vi.stubGlobal("fetch", fetchSpy);

		await extractDocumentText(
			"/path/to/doc.docx",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"doc.docx",
		);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const callUrl = fetchSpy.mock.calls[0][0];
		expect(callUrl).toBe("http://127.0.0.1:8001/file_parse");

		const callOptions = fetchSpy.mock.calls[0][1];
		expect(callOptions.method).toBe("POST");
		expect(callOptions.body).toBeInstanceOf(FormData);
		expect(callOptions.signal).toBeInstanceOf(AbortSignal);

		const formData = callOptions.body as FormData;
		expect(formData.has("files")).toBe(true);
		expect(formData.has("return_md")).toBe(true);
		expect(formData.get("return_md")).toBe("true");
		expect(formData.has("parse_method")).toBe(false);
		expect(formData.has("backend")).toBe(true);
		expect(formData.get("backend")).toBe("hybrid-auto-engine");
	});

	it("produces normalized .md file name", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					createMockResponse(200, mineruMdResponse("report.pdf", "text")),
				),
		);

		const result = await extractDocumentText(
			"/path/to/report.pdf",
			"application/pdf",
			"report.pdf",
		);

		expect(result.normalizedName).toBe("report.md");
	});

	it("handles filenames with multiple dots", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					createMockResponse(200, mineruMdResponse("archive.tar.gz", "text")),
				),
		);

		const result = await extractDocumentText(
			"/path/to/file.tar.gz",
			"application/gzip",
			"archive.tar.gz",
		);

		expect(result.normalizedName).toBe("archive.tar.md");
	});

	it("caches nothing between calls — stateless", () => {
		resetDocumentExtractionExecutableCache();
		expect(() => resetDocumentExtractionExecutableCache()).not.toThrow();
	});

	it("falls back to first result when key does not match", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				createMockResponse(200, {
					results: { some_unexpected_key: { md_content: "fallback content" } },
				}),
			),
		);

		const result = await extractDocumentText(
			"/path/to/report.pdf",
			"application/pdf",
			"report.pdf",
		);

		expect(result.text).toBe("fallback content");
	});
});
