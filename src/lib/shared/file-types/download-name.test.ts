import { describe, expect, it } from "vitest";
import { ensureFilenameExtension, withFileExtension } from "./download-name";

const DOCX =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("ensureFilenameExtension", () => {
	it("adds the type's extension after a suffix that belongs to another type", () => {
		expect(ensureFilenameExtension("Intro to Node.js", DOCX)).toBe(
			"Intro to Node.js.docx",
		);
		expect(ensureFilenameExtension("Setup.md", DOCX)).toBe("Setup.md.docx");
		expect(ensureFilenameExtension("x.py", "application/pdf")).toBe("x.py.pdf");
	});
	it("keeps a suffix that matches the type", () => {
		expect(ensureFilenameExtension("Plan.DOCX", DOCX)).toBe("Plan.DOCX");
		expect(ensureFilenameExtension("a.markdown", "text/markdown")).toBe(
			"a.markdown",
		);
	});
	it("adds the extension to a bare or unknown-suffixed name", () => {
		expect(ensureFilenameExtension("Terv", DOCX)).toBe("Terv.docx");
		expect(ensureFilenameExtension("Report v1.2", DOCX)).toBe(
			"Report v1.2.docx",
		);
	});
	it("is lenient only for generic text/plain, and leaves unknown or generic types alone", () => {
		expect(ensureFilenameExtension("script.py", "text/plain")).toBe(
			"script.py",
		);
		expect(ensureFilenameExtension("notes", "text/plain")).toBe("notes.txt");
		expect(ensureFilenameExtension("blob", "application/octet-stream")).toBe(
			"blob",
		);
	});
});

describe("withFileExtension", () => {
	it("is lenient for a text/plain extension and ignores an unknown one", () => {
		expect(withFileExtension("notes.md", "txt")).toBe("notes.md");
		expect(withFileExtension("notes", "txt")).toBe("notes.txt");
		expect(withFileExtension("notes", "zzzunknown")).toBe("notes");
	});
	it("stays strict for a specific type", () => {
		expect(withFileExtension("Intro to Node.js", "docx")).toBe(
			"Intro to Node.js.docx",
		);
	});
});
