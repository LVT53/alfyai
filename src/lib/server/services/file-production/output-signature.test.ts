// Defence in depth for Phase 6 P6-B: whatever produced a file — a sandbox
// program, a renderer, or the new inline_text mode — the bytes we STORE must
// match the extension we store them under. The registry already carries the
// leading-byte signatures the upload side checks (`entry.signatures`), so the
// produced-output contract reuses the same matcher rather than inventing a
// second table.
//
// The check runs at production time only (`validateProgramOutputContract` and
// the inline_text adapter), never on the serving path: a file that is already
// stored has to stay downloadable.
import { describe, expect, it } from "vitest";
import {
	validateProducedFileSignature,
	validateProgramOutputContract,
} from "./output-validation";

const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MARKDOWN = Buffer.from("# Quarterly summary\n\nRevenue grew 12%.\n");

function zipLike(body: string): Buffer {
	return Buffer.concat([ZIP_HEADER, Buffer.from(body)]);
}

describe("produced-file signature check", () => {
	it("refuses text bytes stored under a binary container extension", () => {
		for (const filename of [
			"report.pdf",
			"report.docx",
			"report.odt",
			"deck.pptx",
			"bundle.zip",
		]) {
			expect(
				validateProducedFileSignature({ filename, content: MARKDOWN }),
				filename,
			).toMatchObject({
				ok: false,
				code: "program_output_signature_mismatch",
				retryable: false,
			});
		}
	});

	it("accepts real container bytes", () => {
		expect(
			validateProducedFileSignature({
				filename: "report.docx",
				content: zipLike("word/document.xml"),
			}),
		).toEqual({ ok: true });
		expect(
			validateProducedFileSignature({
				filename: "report.pdf",
				content: Buffer.from("%PDF-1.7\n1 0 obj\n"),
			}),
		).toEqual({ ok: true });
	});

	it("never sniffs a type the registry gives no signature", () => {
		// Any byte sequence is a legal text file, and SVG deliberately carries no
		// signature — a program writing `<svg …>` verbatim must keep working.
		for (const filename of [
			"notes.md",
			"data.tsv",
			"data.csv",
			"diagram.svg",
			"widget.ts",
			"report.html",
		]) {
			expect(
				validateProducedFileSignature({ filename, content: MARKDOWN }),
				filename,
			).toEqual({ ok: true });
		}
	});

	// This is the storage half of the shipped bug: before P6-B the generated
	// Python one-liner wrote the model's markdown into `report.pdf` and the
	// output contract accepted it, because `pdf` has `validation: "none"`.
	it("refuses a program output whose text bytes were named .pdf", async () => {
		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["pdf"],
				programFilename: "report.pdf",
				files: [
					{
						filename: "report.pdf",
						mimeType: "application/pdf",
						content: MARKDOWN,
					},
				],
			}),
		).resolves.toMatchObject({
			ok: false,
			code: "program_output_signature_mismatch",
		});
	});

	it("refuses a program output whose text bytes were named .odt", async () => {
		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["odt"],
				programFilename: "report.odt",
				files: [
					{
						filename: "report.odt",
						mimeType: "application/vnd.oasis.opendocument.text",
						content: MARKDOWN,
					},
				],
			}),
		).resolves.toMatchObject({
			ok: false,
			code: "program_output_signature_mismatch",
		});
	});

	it("keeps accepting a real ODT/ZIP program output", async () => {
		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["odt"],
				programFilename: "report.odt",
				files: [
					{
						filename: "report.odt",
						mimeType: "application/vnd.oasis.opendocument.text",
						content: zipLike("mimetype"),
					},
				],
			}),
		).resolves.toEqual({ ok: true });
	});

	// An XLSX gets the stronger OOXML structure check first, so its diagnostic
	// stays the more specific one.
	it("keeps reporting invalid_xlsx_output for a broken workbook", async () => {
		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["xlsx"],
				programFilename: "workbook.xlsx",
				files: [
					{
						filename: "workbook.xlsx",
						mimeType:
							"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
						content: Buffer.from("not an ooxml zip"),
					},
				],
			}),
		).resolves.toMatchObject({ ok: false, code: "invalid_xlsx_output" });
	});
});
