import { describe, expect, it, vi } from "vitest";

// `$lib/client/api/http` navigates to /login on an expired session, and this
// module now reads its error bodies through it.
const goto = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("$app/navigation", () => ({ goto }));

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

	// This is the one call site that CONSUMED the old 303-to-login: `fetch`
	// followed the redirect, `response.ok` was true, and the runtime blobbed an
	// HTML login page and handed it to a renderer. The hook now answers 401
	// instead, which stops that — but the runtime dead-ends on a generic
	// "Failed to load file" and tells the rest of the app nothing, so the
	// workspace sits on that message forever on an expired session while every
	// centrally-routed call in the app has already noticed.
	it("reports an expired session instead of dead-ending on it", async () => {
		const unauthorized = await loadPreviewRuntime({
			artifactId: "artifact-401",
			previewUrl: null,
			filename: "private.pdf",
			mimeType: "application/pdf",
			fetchImpl: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
			),
		});

		expectError(unauthorized);
		// The whole chain, not a spy on the middle of it: the runtime reads the
		// error body through the same helper every centrally-routed call uses,
		// and that helper's one reaction to an expired session is to navigate.
		// The navigation is deliberately not awaited by the caller — it collapses
		// a burst of 401s into one — so wait for it rather than for the call.
		await vi.waitFor(() =>
			expect(goto).toHaveBeenCalledWith("/login", { invalidateAll: true }),
		);
	});
});

// The office renderers load with `await import("./office")`. A dynamic import
// only splits a chunk when NOTHING imports the module statically as well:
// Rollup reports INEFFECTIVE_DYNAMIC_IMPORT and folds the module (and
// `$lib/utils/html-sanitizer` with it) into the caller's chunk. The kinds and
// the runtime guard therefore live in the leaf `./office/kinds`, and this
// module must not reach for `./office` outside the dynamic import. The
// preview-performance note in `src/lib/server/services/AGENTS.md` is the rule
// this protects.
describe("office renderer code splitting", () => {
	it("imports ./office only dynamically", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const source = readFileSync(
			join(
				process.cwd(),
				"src/lib/components/document-workspace/preview-runtime/index.ts",
			),
			"utf8",
		);

		expect(source).toContain('await import("./office")');
		// `import ... from "./office"` in any form except `import type`.
		const staticImports = [
			...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"\.\/office";/gms),
		];
		expect(
			staticImports.map((match) => match[0]),
			"import the kinds from ./office/kinds instead",
		).toEqual([]);
	});
});
