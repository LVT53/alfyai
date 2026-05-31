import { describe, expect, it, vi } from "vitest";
import {
	loadPreviewRuntime,
	type PreviewRuntimeResult,
	resolvePreviewSourceUrl,
} from "./index";

function makeFetchResponse(blob: Blob, init: ResponseInit = {}) {
	return {
		ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
		status: init.status ?? 200,
		blob: async () => blob,
	} as Response;
}

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
