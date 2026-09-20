import { describe, expect, it } from "vitest";
import {
	determinePreviewFileType,
	getPreviewContentType,
	getPreviewLanguage,
	isPreviewableFile,
} from "./file-preview";

describe("file-preview utils", () => {
	it("classifies every generated previewable format correctly", () => {
		expect(determinePreviewFileType("application/pdf", "file.pdf")).toBe("pdf");
		expect(
			determinePreviewFileType(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"file.docx",
			),
		).toBe("docx");
		expect(
			determinePreviewFileType(
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				"file.xlsx",
			),
		).toBe("xlsx");
		expect(
			determinePreviewFileType(
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				"file.pptx",
			),
		).toBe("pptx");
		expect(
			determinePreviewFileType(
				"application/vnd.oasis.opendocument.text",
				"file.odt",
			),
		).toBe("odt");
		expect(determinePreviewFileType("image/svg+xml", "file.svg")).toBe("image");
		expect(determinePreviewFileType("application/xml", "file.xml")).toBe(
			"text",
		);
		expect(determinePreviewFileType("application/rtf", "file.rtf")).toBe(
			"text",
		);
		expect(determinePreviewFileType("text/css", "file.css")).toBe("text");
		expect(determinePreviewFileType("application/javascript", "file.js")).toBe(
			"text",
		);
		expect(determinePreviewFileType("application/x-sh", "file.sh")).toBe(
			"text",
		);
		expect(determinePreviewFileType("text/x-python", "file.py")).toBe("text");
		expect(determinePreviewFileType("text/x-ruby", "file.rb")).toBe("text");
		expect(
			determinePreviewFileType("application/graphql", "schema.graphql"),
		).toBe("text");
		expect(determinePreviewFileType("image/heic", "file.heic")).toBe("image");
		expect(determinePreviewFileType("image/heif", "file.heif")).toBe("image");
	});

	it("infers content types for generated formats from filename when mime is absent", () => {
		expect(getPreviewContentType("file.odt", null)).toBe(
			"application/vnd.oasis.opendocument.text",
		);
		expect(getPreviewContentType("file.xml", null)).toBe("application/xml");
		expect(getPreviewContentType("file.rtf", null)).toBe("application/rtf");
		expect(getPreviewContentType("file.css", null)).toBe("text/css");
		expect(getPreviewContentType("file.js", null)).toBe("text/javascript");
		expect(getPreviewContentType("file.sh", null)).toBe("application/x-sh");
		expect(getPreviewContentType("file.tsx", null)).toBe("text/tsx");
		expect(getPreviewContentType("file.graphql", null)).toBe(
			"application/graphql",
		);
		expect(getPreviewContentType("file.py", null)).toBe("text/x-python");
		expect(getPreviewContentType("file.heic", null)).toBe("image/heic");
		expect(getPreviewContentType("file.heif", null)).toBe("image/heif");
	});

	// The two content-type deltas the shared registry deliberately introduces
	// (spec section 2.3 conflicts 1 and 2). Both are also pinned in
	// `file-types/legacy-equivalence.test.ts`'s KNOWN_DELTAS; they are repeated
	// here because this is the module whose OUTPUT changed.
	it("serves JavaScript as text/javascript, keeping the old value readable", () => {
		expect(getPreviewContentType("bundle.js", null)).toBe("text/javascript");
		expect(getPreviewContentType("bundle.mjs", null)).toBe("text/javascript");
		expect(getPreviewContentType("bundle.cjs", null)).toBe("text/javascript");
		// `application/javascript` is still an accepted alias on the way in.
		expect(getPreviewContentType("bundle.js", "application/javascript")).toBe(
			"application/javascript",
		);
		expect(getPreviewLanguage("application/javascript", "x.bin")).toBe(
			"javascript",
		);
	});

	it("knows a .jfif is a JPEG rather than an unknown blob", () => {
		expect(getPreviewContentType("scan.jfif", null)).toBe("image/jpeg");
		expect(determinePreviewFileType(null, "scan.jfif")).toBe("image");
	});

	it("classifies extension-only HTML as a rendered HTML preview", () => {
		expect(determinePreviewFileType(null, "site-export.html")).toBe("html");
		expect(determinePreviewFileType(null, "site-export.htm")).toBe("html");
		expect(determinePreviewFileType("", "site-export.HTML")).toBe("html");
	});

	it("trusts known visual file extensions over generic text MIME metadata", () => {
		expect(determinePreviewFileType("text/plain", "contract.docx")).toBe(
			"docx",
		);
		expect(determinePreviewFileType("text/plain", "workbook.xlsx")).toBe(
			"xlsx",
		);
		expect(determinePreviewFileType("text/plain", "slides.pptx")).toBe("pptx");
		expect(determinePreviewFileType("text/plain", "report.pdf")).toBe("pdf");
		expect(determinePreviewFileType("text/plain", "site.htm")).toBe("html");
	});

	it("exposes syntax languages for code-like previewable formats", () => {
		expect(getPreviewLanguage(null, "script.py")).toBe("python");
		expect(getPreviewLanguage(null, "styles.css")).toBe("css");
		expect(getPreviewLanguage(null, "theme.scss")).toBe("scss");
		expect(getPreviewLanguage(null, "script.sh")).toBe("bash");
		expect(getPreviewLanguage(null, "component.tsx")).toBe("tsx");
		expect(getPreviewLanguage(null, "query.graphql")).toBe("graphql");
		expect(getPreviewLanguage(null, "main.rs")).toBe("rust");
		expect(getPreviewLanguage(null, "program.c")).toBe("c");
		expect(getPreviewLanguage(null, "config.xml")).toBe("xml");
		expect(getPreviewLanguage(null, "doc.md")).toBe("markdown");
		expect(getPreviewLanguage("application/javascript", "script.bin")).toBe(
			"javascript",
		);
		expect(getPreviewLanguage("application/x-sh", "script.bin")).toBe("bash");
	});

	it("normalizes MIME parameters when selecting preview languages", () => {
		expect(getPreviewLanguage("text/markdown; charset=utf-8", "download")).toBe(
			"markdown",
		);
		expect(
			getPreviewLanguage("application/javascript; charset=utf-8", "download"),
		).toBe("javascript");
	});

	it("marks generated document and code formats as previewable", () => {
		expect(
			isPreviewableFile("application/vnd.oasis.opendocument.text", "draft.odt"),
		).toBe(true);
		expect(isPreviewableFile("application/xml", "draft.xml")).toBe(true);
		expect(isPreviewableFile("application/rtf", "draft.rtf")).toBe(true);
		expect(isPreviewableFile("text/css", "draft.css")).toBe(true);
		expect(isPreviewableFile("application/javascript", "draft.js")).toBe(true);
		expect(isPreviewableFile("application/x-sh", "draft.sh")).toBe(true);
		expect(isPreviewableFile("application/typescript", "draft.ts")).toBe(true);
		expect(isPreviewableFile("application/graphql", "schema.graphql")).toBe(
			true,
		);
		expect(isPreviewableFile("text/x-python", "draft.py")).toBe(true);
		expect(isPreviewableFile("image/heic", "draft.heic")).toBe(true);
		expect(isPreviewableFile("application/octet-stream", "draft.bin")).toBe(
			false,
		);
	});
});
