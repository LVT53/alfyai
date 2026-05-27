import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	validateGeneratedOutputFile,
	validateProgramOutputContract,
	validateXlsxBytes,
} from "./output-validation";

async function buildMinimalXlsxZip(extraEntries = 0): Promise<Buffer> {
	const zip = new JSZip();
	zip.file("[Content_Types].xml", "<Types></Types>");
	zip.file("_rels/.rels", "<Relationships></Relationships>");
	zip.file("xl/workbook.xml", "<workbook></workbook>");
	zip.file("xl/_rels/workbook.xml.rels", "<Relationships></Relationships>");
	zip.file("xl/worksheets/sheet1.xml", "<worksheet></worksheet>");
	for (let index = 0; index < extraEntries; index += 1) {
		zip.file(`xl/sharedStrings/${index}.xml`, "<sst></sst>");
	}
	return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("file-production output validation", () => {
	it("rejects XLSX validation inputs above the byte ceiling before loading the ZIP", async () => {
		await expect(
			validateXlsxBytes(Buffer.alloc(5), { maxBytes: 4 }),
		).resolves.toMatchObject({
			ok: false,
			code: "xlsx_output_too_large",
		});
	});

	it("rejects XLSX packages with too many ZIP entries", async () => {
		const content = await buildMinimalXlsxZip(3);

		await expect(
			validateXlsxBytes(content, { maxZipEntries: 4 }),
		).resolves.toMatchObject({
			ok: false,
			code: "xlsx_output_too_complex",
		});
	});

	it("accepts repo-documented Markdown, SVG, and ZIP program output types", async () => {
		for (const requestedType of ["md", "markdown", "text/markdown"]) {
			await expect(
				validateProgramOutputContract({
					requestedOutputTypes: [requestedType],
					programFilename: "notes.md",
					files: [
						{
							filename: "notes.md",
							mimeType: "text/markdown",
							content: Buffer.from("# Notes\n"),
						},
					],
				}),
			).resolves.toEqual({ ok: true });
		}

		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["svg"],
				programFilename: "diagram.svg",
				files: [
					{
						filename: "diagram.svg",
						mimeType: "image/svg+xml",
						content: Buffer.from("<svg></svg>"),
					},
				],
			}),
		).resolves.toEqual({ ok: true });

		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["zip"],
				programFilename: "archive.zip",
				files: [
					{
						filename: "archive.zip",
						mimeType: "application/zip",
						content: Buffer.from("zip bytes"),
					},
				],
			}),
		).resolves.toEqual({ ok: true });
	});

	it("accepts common Markdown, SVG, and ZIP MIME aliases on download validation", async () => {
		await expect(
			validateGeneratedOutputFile({
				filename: "notes.markdown",
				mimeType: "text/plain",
				content: Buffer.from("# Notes\n"),
			}),
		).resolves.toEqual({ ok: true });
		await expect(
			validateGeneratedOutputFile({
				filename: "diagram.svg",
				mimeType: "text/xml",
				content: Buffer.from("<svg></svg>"),
			}),
		).resolves.toEqual({ ok: true });
		await expect(
			validateGeneratedOutputFile({
				filename: "archive.zip",
				mimeType: "application/octet-stream",
				content: Buffer.from("zip bytes"),
			}),
		).resolves.toEqual({ ok: true });
	});
});
