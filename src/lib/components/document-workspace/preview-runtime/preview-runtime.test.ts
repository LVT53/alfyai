import { describe, expect, it, vi } from "vitest";
import {
	allowsTrustedHtmlPreviewRuntime,
	loadPreviewRuntime,
	type PreviewRuntimeResult,
	resolvePreviewSourceUrl,
} from "./index";

function makeFetchResponse(blob: Blob, init: ResponseInit = {}) {
	return {
		ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
		status: init.status ?? 200,
		headers: new Headers(init.headers),
		blob: async () => blob,
	} as Response;
}

const STANDARD_REPORT_CSP =
	"default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function expectReady(
	result: PreviewRuntimeResult,
): asserts result is Extract<PreviewRuntimeResult, { status: "ready" }> {
	expect(result.status).toBe("ready");
}

function expectError(
	result: PreviewRuntimeResult,
): asserts result is Extract<PreviewRuntimeResult, { status: "error" }> {
	expect(result.status).toBe("error");
}

describe("preview runtime", () => {
	it("resolves explicit preview URLs before artifact preview URLs", () => {
		expect(
			resolvePreviewSourceUrl({
				artifactId: "artifact-123",
				previewUrl: "/api/chat/files/generated/preview",
			}),
		).toBe("/api/chat/files/generated/preview");
		expect(
			resolvePreviewSourceUrl({
				artifactId: "artifact-123",
				previewUrl: null,
			}),
		).toBe("/api/knowledge/artifact-123/preview");
		expect(
			resolvePreviewSourceUrl({
				artifactId: "artifact-123",
				previewUrl: "",
			}),
		).toBe("/api/knowledge/artifact-123/preview");
		expect(
			resolvePreviewSourceUrl({ artifactId: null, previewUrl: null }),
		).toBe(null);
	});

	it("loads a blob and falls back from generic MIME metadata to the filename", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				makeFetchResponse(
					new Blob(["# Runtime notes"], { type: "application/octet-stream" }),
				),
			);

		const result = await loadPreviewRuntime({
			artifactId: "artifact-md",
			previewUrl: null,
			filename: "notes.md",
			mimeType: "application/octet-stream",
			fetchImpl,
		});

		expectReady(result);
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/knowledge/artifact-md/preview",
		);
		expect(result.fileType).toBe("text");
		expect(result.adapter).toMatchObject({
			kind: "text",
			text: "# Runtime notes",
			textKind: "markdown",
			language: "markdown",
		});
	});

	it("renders extension-only .markdown files through the Markdown document adapter", async () => {
		const result = await loadPreviewRuntime({
			artifactId: "artifact-markdown",
			previewUrl: null,
			filename: "research-notes.markdown",
			mimeType: "application/octet-stream",
			fetchImpl: vi.fn().mockResolvedValue(
				makeFetchResponse(
					new Blob(["# Research notes"], {
						type: "application/octet-stream",
					}),
				),
			),
		});

		expectReady(result);
		expect(result.fileType).toBe("text");
		expect(result.adapter).toMatchObject({
			kind: "text",
			textKind: "markdown",
			language: "markdown",
		});
	});

	it("selects syntax highlighting languages for code-like text previews", async () => {
		for (const file of [
			{ filename: "theme.css", mimeType: "text/css", language: "css" },
			{
				filename: "widget.js",
				mimeType: "text/javascript",
				language: "javascript",
			},
			{
				filename: "install.sh",
				mimeType: "application/x-sh",
				language: "bash",
			},
			{ filename: "component.tsx", mimeType: "text/tsx", language: "tsx" },
		]) {
			const result = await loadPreviewRuntime({
				artifactId: "artifact-code",
				previewUrl: null,
				filename: file.filename,
				mimeType: file.mimeType,
				fetchImpl: vi
					.fn()
					.mockResolvedValue(
						makeFetchResponse(new Blob(["content"], { type: file.mimeType })),
					),
			});

			expectReady(result);
			expect(result.fileType).toBe("text");
			expect(result.adapter).toMatchObject({
				kind: "text",
				textKind: "highlighted",
				language: file.language,
			});
		}
	});

	it("uses filename language hints when legacy text/code previews have generic MIME", async () => {
		const result = await loadPreviewRuntime({
			artifactId: "artifact-shell",
			previewUrl: null,
			filename: "install.sh",
			mimeType: "application/octet-stream",
			fetchImpl: vi.fn().mockResolvedValue(
				makeFetchResponse(
					new Blob(["#!/usr/bin/env bash\necho ok\n"], {
						type: "application/octet-stream",
					}),
				),
			),
		});

		expectReady(result);
		expect(result.fileType).toBe("text");
		expect(result.adapter).toMatchObject({
			kind: "text",
			textKind: "highlighted",
			language: "bash",
		});
	});

	it("classifies fetched previews from the response blob MIME when metadata is missing", async () => {
		const result = await loadPreviewRuntime({
			artifactId: "artifact-image",
			previewUrl: null,
			filename: "download",
			mimeType: null,
			fetchImpl: vi
				.fn()
				.mockResolvedValue(
					makeFetchResponse(new Blob(["image bytes"], { type: "image/png" })),
				),
		});

		expectReady(result);
		expect(result.fileType).toBe("image");
		expect(result.adapter.kind).toBe("image");
	});

	it("marks generated report HTML runtime trusted only when the response uses the report CSP", async () => {
		expect(allowsTrustedHtmlPreviewRuntime(STANDARD_REPORT_CSP)).toBe(true);
		expect(
			allowsTrustedHtmlPreviewRuntime(
				"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
			),
		).toBe(false);

		const result = await loadPreviewRuntime({
			artifactId: "artifact-html",
			previewUrl: null,
			filename: "atlas-report.html",
			mimeType: "text/html",
			fetchImpl: vi.fn().mockResolvedValue(
				makeFetchResponse(
					new Blob(["<!doctype html><div id='report-viewer'></div>"], {
						type: "text/html",
					}),
					{
						headers: {
							"Content-Security-Policy": STANDARD_REPORT_CSP,
						},
					},
				),
			),
		});

		expectReady(result);
		expect(result.fileType).toBe("html");
		expect(result.adapter).toMatchObject({
			kind: "html",
			trustedRuntime: true,
		});
	});

	it("uses the response blob MIME when generic metadata is parameterized", async () => {
		const result = await loadPreviewRuntime({
			artifactId: "artifact-image",
			previewUrl: null,
			filename: "download",
			mimeType: " application/octet-stream ; charset=binary ",
			fetchImpl: vi
				.fn()
				.mockResolvedValue(
					makeFetchResponse(new Blob(["image bytes"], { type: "image/png" })),
				),
		});

		expectReady(result);
		expect(result.fileType).toBe("image");
		expect(result.adapter.kind).toBe("image");
		expect(result.mimeType).toBe("image/png");
	});

	it("corrects text-selected binary previews by sniffing PDF and PPTX signatures", async () => {
		const pdfResult = await loadPreviewRuntime({
			artifactId: "artifact-pdf",
			previewUrl: null,
			filename: "download.txt",
			mimeType: "text/plain",
			fetchImpl: vi
				.fn()
				.mockResolvedValue(
					makeFetchResponse(new Blob(["%PDF-1.7 mocked content"])),
				),
		});
		expectReady(pdfResult);
		expect(pdfResult.fileType).toBe("pdf");
		expect(pdfResult.adapter.kind).toBe("pdf");

		const pptxResult = await loadPreviewRuntime({
			artifactId: "artifact-pptx",
			previewUrl: null,
			filename: "slides.pptx",
			mimeType: "text/plain",
			fetchImpl: vi
				.fn()
				.mockResolvedValue(
					makeFetchResponse(
						new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14])]),
					),
				),
		});
		expectReady(pptxResult);
		expect(pptxResult.fileType).toBe("pptx");
		expect(pptxResult.adapter.kind).toBe("pptx");
	});

	it("maps unavailable previews and fetch failures to renderer-compatible errors", async () => {
		const missingUrl = await loadPreviewRuntime({
			artifactId: null,
			previewUrl: null,
			filename: "missing.pdf",
			mimeType: "application/pdf",
			fetchImpl: vi.fn(),
		});
		expectError(missingUrl);
		expect(missingUrl.error).toBe("Preview not available");

		const notFound = await loadPreviewRuntime({
			artifactId: "artifact-404",
			previewUrl: null,
			filename: "missing.pdf",
			mimeType: "application/pdf",
			fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
		});
		expectError(notFound);
		expect(notFound.error).toBe("File not found");

		const networkFailure = await loadPreviewRuntime({
			artifactId: "artifact-network",
			previewUrl: null,
			filename: "network.pdf",
			mimeType: "application/pdf",
			fetchImpl: vi.fn().mockRejectedValue(new Error("Network error")),
		});
		expectError(networkFailure);
		expect(networkFailure.error).toBe("Network error");
	});
});
