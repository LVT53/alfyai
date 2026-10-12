import { describe, expect, it } from "vitest";
import { fileFacts, isShared, rowMadeAtLabel, sharedNames } from "./row-facts";

describe("the extension a file row names", () => {
	it("is the extension in capitals", () => {
		expect(fileFacts({ filename: "trip-notes.pdf" })).toBe("PDF");
		expect(fileFacts({ filename: "Bécsi hétvégi útiterv.docx" })).toBe("DOCX");
		expect(fileFacts({ filename: "archive.tar.gz" })).toBe("GZ");
	});

	it("is nothing for a name without one", () => {
		expect(fileFacts({ filename: "README" })).toBeNull();
		expect(fileFacts({ filename: ".env" })).toBeNull();
		expect(fileFacts({ filename: "trailing." })).toBeNull();
		expect(fileFacts({ filename: "a note. Not an extension" })).toBeNull();
	});
});

describe("fileFacts", () => {
	it("says the extension and the size", () => {
		expect(fileFacts({ filename: "trip.pdf", sizeBytes: 371_507 })).toBe(
			"PDF · 362.8 KB",
		);
		expect(fileFacts({ filename: "notes.md", sizeBytes: 36 })).toBe(
			"MD · 36 B",
		);
	});

	it("leaves out what it does not know", () => {
		expect(fileFacts({ filename: "trip.pdf" })).toBe("PDF");
		expect(fileFacts({ filename: "trip.pdf", sizeBytes: null })).toBe("PDF");
		expect(fileFacts({ filename: "README", sizeBytes: 2048 })).toBe("2 KB");
		expect(fileFacts({ filename: "README" })).toBeNull();
	});
});

describe("same names", () => {
	it("finds the names more than one row has, as a reader compares them", () => {
		const shared = sharedNames([
			"Tip calculator",
			"Trip notes",
			"tip calculator ",
			"Weekend board",
		]);
		expect(isShared(shared, "Tip calculator")).toBe(true);
		expect(isShared(shared, "TIP CALCULATOR")).toBe(true);
		expect(isShared(shared, "Trip notes")).toBe(false);
		expect(isShared(shared, "Something else")).toBe(false);
	});
});

describe("rowMadeAtLabel", () => {
	const now = new Date(2026, 9, 12, 16, 0).getTime();

	it("is the clock for today, in the 24-hour clock of both languages", () => {
		const at = new Date(2026, 9, 12, 14, 32).getTime();
		expect(rowMadeAtLabel(at, "en", now)).toBe("14:32");
		expect(rowMadeAtLabel(at, "hu", now)).toBe("14:32");
		expect(
			rowMadeAtLabel(new Date(2026, 9, 12, 9, 5).getTime(), "en", now),
		).toBe("09:05");
	});

	it("is the day and the clock for another day", () => {
		const at = new Date(2026, 9, 11, 14, 32).getTime();
		const en = rowMadeAtLabel(at, "en", now);
		const hu = rowMadeAtLabel(at, "hu", now);
		expect(en).toMatch(/11/);
		expect(en).toMatch(/Oct/);
		expect(en.endsWith("14:32")).toBe(true);
		expect(hu).toMatch(/11/);
		expect(hu).toMatch(/okt/i);
		expect(hu.endsWith("14:32")).toBe(true);
	});

	it("reads a time in seconds as one", () => {
		const at = new Date(2026, 9, 12, 14, 32).getTime();
		expect(rowMadeAtLabel(Math.floor(at / 1000), "en", now)).toBe("14:32");
	});
});
