import { describe, expect, it } from "vitest";
import { fileExtension, getFileType } from "./attachment-file-type";

// The `.docx` bug the chips redesign was asked to fix, plus the two formats
// that escaped it by luck. A Word file's mime type is
//
//   application/vnd.openxmlformats-officedocument.wordprocessingml.document
//
// and the old order tested `mime.includes("xml")` — which "openxmlformats"
// satisfies — BEFORE it tested for a document, so every Word file in the
// product drew the source-code glyph. `.xlsx` and `.pptx` share the same
// "openxmlformats" prefix and were saved only because their own branches
// happened to run first; they are pinned here so a future reorder cannot
// break them the same way.

const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME =
	"application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("getFileType — the OOXML trio", () => {
	it("draws a .docx as a document, not as source code", () => {
		expect(getFileType(DOCX_MIME, "Employee handbook.docx")).toBe("text");
	});

	it("draws a .xlsx as a spreadsheet", () => {
		expect(getFileType(XLSX_MIME, "Q3 figures.xlsx")).toBe("xlsx");
	});

	it("draws a .pptx as a presentation", () => {
		expect(getFileType(PPTX_MIME, "Board deck.pptx")).toBe("pptx");
	});

	// The same three when the browser hands over no mime type at all — the
	// extension is what the user actually named the file.
	it("decides all three from the extension alone", () => {
		expect(getFileType(null, "handbook.docx")).toBe("text");
		expect(getFileType(null, "figures.xlsx")).toBe("xlsx");
		expect(getFileType(null, "deck.pptx")).toBe("pptx");
	});

	// ...and when the mime type is right but the name carries no extension.
	it("decides all three from the mime type alone", () => {
		expect(getFileType(DOCX_MIME, "handbook")).toBe("text");
		expect(getFileType(XLSX_MIME, "figures")).toBe("xlsx");
		expect(getFileType(PPTX_MIME, "deck")).toBe("pptx");
	});

	it("still recognises legacy Office mime types", () => {
		expect(getFileType("application/msword", "memo")).toBe("text");
		expect(getFileType("application/vnd.ms-excel", "figures")).toBe("xlsx");
	});
});

describe("getFileType — everything else keeps working", () => {
	it("recognises images by extension and by mime family", () => {
		expect(getFileType("image/png", "floor-plan-level-2.png")).toBe("image");
		expect(getFileType(null, "damp-north-wall.JPG")).toBe("image");
		expect(getFileType("image/heic", "shot")).toBe("image");
	});

	it("recognises a PDF", () => {
		expect(getFileType("application/pdf", "Lease agreement 2026.pdf")).toBe(
			"pdf",
		);
		expect(getFileType(null, "lease.pdf")).toBe("pdf");
	});

	it("still calls real source code code", () => {
		expect(getFileType("text/plain", "server.ts")).toBe("code");
		expect(getFileType("application/json", "package.json")).toBe("code");
		expect(getFileType("text/html", "index.html")).toBe("code");
		expect(getFileType("application/xml", "feed")).toBe("code");
	});

	it("recognises archives and plain text", () => {
		expect(getFileType("application/zip", "bundle.zip")).toBe("archive");
		expect(getFileType("text/markdown", "notes.md")).toBe("text");
		expect(getFileType("text/plain", "server.log")).toBe("text");
	});

	it("gives up rather than guessing", () => {
		expect(getFileType(null, "mystery")).toBe("unsupported");
		expect(getFileType("application/octet-stream", "blob.bin")).toBe(
			"unsupported",
		);
	});
});

describe("fileExtension", () => {
	it("lowercases and trims", () => {
		expect(fileExtension("Report.PDF")).toBe("pdf");
	});

	it("is empty for a name that carries none", () => {
		expect(fileExtension("README")).toBe("");
	});

	it("takes the last segment of a multi-dot name", () => {
		expect(fileExtension("archive.tar.gz")).toBe("gz");
	});
});
