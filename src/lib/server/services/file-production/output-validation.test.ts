import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	hasCompleteOutputStructure,
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
						// Real local-file-header magic: the produced-output contract
						// now refuses bytes that do not match the extension
						// (`validateProducedFileSignature`), so the fixture has to be
						// a plausible archive rather than the words "zip bytes".
						content: Buffer.concat([
							Buffer.from([0x50, 0x4b, 0x03, 0x04]),
							Buffer.from(" entries"),
						]),
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

	it("accepts code and stylesheet program output types", async () => {
		for (const file of [
			{
				requestedType: "css",
				filename: "theme.css",
				mimeType: "text/css",
				content: "body { color: rebeccapurple; }\n",
			},
			{
				requestedType: "js",
				filename: "widget.js",
				mimeType: "text/javascript",
				content: "export const answer = 42;\n",
			},
			{
				requestedType: "ts",
				filename: "widget.ts",
				mimeType: "application/typescript",
				content: "export const answer: number = 42;\n",
			},
			{
				requestedType: "sh",
				filename: "install.sh",
				mimeType: "application/x-sh",
				content: "#!/usr/bin/env bash\nset -euo pipefail\n",
			},
			{
				requestedType: "graphql",
				filename: "schema.graphql",
				mimeType: "application/graphql",
				content: "type Query { status: String }\n",
			},
			{
				requestedType: "rust",
				filename: "main.rs",
				mimeType: "text/rust",
				content: "fn main() {}\n",
			},
		]) {
			await expect(
				validateProgramOutputContract({
					requestedOutputTypes: [file.requestedType],
					programFilename: file.filename,
					files: [
						{
							filename: file.filename,
							mimeType: file.mimeType,
							content: Buffer.from(file.content),
						},
					],
				}),
			).resolves.toEqual({ ok: true });
		}
	});

	// Intake now refuses an unresolvable type, so a job can only still carry one
	// if it was queued before that rule existed. Its run has already been paid
	// for; the single file it produced names the type unambiguously.
	it("resolves an unresolvable requested type from the single file the program wrote", async () => {
		const content = await buildMinimalXlsxZip();

		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["file"],
				programFilename: "fruits.xlsx",
				files: [
					{
						filename: "fruits.xlsx",
						mimeType:
							"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
						content,
					},
				],
			}),
		).resolves.toEqual({ ok: true });
	});

	it("still rejects an unresolvable requested type when the program wrote several files", async () => {
		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["file"],
				files: [
					{
						filename: "a.csv",
						mimeType: "text/csv",
						content: Buffer.from("a,b\n1,2\n"),
					},
					{
						filename: "b.csv",
						mimeType: "text/csv",
						content: Buffer.from("a,b\n3,4\n"),
					},
				],
			}),
		).resolves.toMatchObject({
			ok: false,
			code: "unsupported_program_output_type",
		});
	});

	it("does not let the single-file fallback paper over a real type mismatch", async () => {
		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["pdf"],
				files: [
					{
						filename: "report.csv",
						mimeType: "text/csv",
						content: Buffer.from("a,b\n1,2\n"),
					},
				],
			}),
		).resolves.toMatchObject({
			ok: false,
			code: "program_output_type_mismatch",
		});
	});

	// The dangerous shape of the fallback: a legacy request that named a REAL
	// type alongside the old sentinel. Letting the produced file redefine the
	// whole request would drop the pdf the caller actually asked for.
	it("keeps a resolvable requested type when the request also carries an unresolvable one", async () => {
		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["pdf", "file"],
				files: [
					{
						filename: "report.csv",
						mimeType: "text/csv",
						content: Buffer.from("a,b\n1,2\n"),
					},
				],
			}),
		).resolves.toMatchObject({
			ok: false,
			code: "program_output_type_mismatch",
		});
	});

	// `.markdown` maps to the output type `markdown`, whose expected extension
	// is `.md` — deriving it would reject the very file it was derived from.
	it("does not derive an output type that would then reject the produced file", async () => {
		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["file"],
				files: [
					{
						filename: "notes.markdown",
						mimeType: "text/markdown",
						content: Buffer.from("# notes\n"),
					},
				],
			}),
		).resolves.toMatchObject({
			ok: false,
			code: "unsupported_program_output_type",
		});
	});

	it("accepts legacy generic MIME for text/code outputs after byte validation", async () => {
		await expect(
			validateGeneratedOutputFile({
				filename: "install.sh",
				mimeType: "application/octet-stream",
				content: Buffer.from("#!/usr/bin/env bash\necho ok\n"),
			}),
		).resolves.toEqual({ ok: true });

		await expect(
			validateProgramOutputContract({
				requestedOutputTypes: ["sh"],
				programFilename: "install.sh",
				files: [
					{
						filename: "install.sh",
						mimeType: "application/octet-stream",
						content: Buffer.from("#!/usr/bin/env bash\necho ok\n"),
					},
				],
			}),
		).resolves.toEqual({ ok: true });
	});

	it("rejects binary bytes for text/code outputs with generic MIME", async () => {
		await expect(
			validateGeneratedOutputFile({
				filename: "install.sh",
				mimeType: "application/octet-stream",
				content: Buffer.from([0x00, 0x01, 0x02, 0x03]),
			}),
		).resolves.toMatchObject({
			ok: false,
			code: "invalid_text_output",
		});
	});
});

describe("hasCompleteOutputStructure", () => {
	it("accepts a whole OOXML package and a PDF that ends in its trailer", async () => {
		const xlsx = await buildMinimalXlsxZip();
		await expect(
			hasCompleteOutputStructure({ filename: "book.xlsx", content: xlsx }),
		).resolves.toBe(true);
		await expect(
			hasCompleteOutputStructure({
				filename: "report.pdf",
				content: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"),
			}),
		).resolves.toBe(true);
	});

	it("refuses a truncated package, a PDF without its trailer, and every type with no completeness marker", async () => {
		const xlsx = await buildMinimalXlsxZip();
		await expect(
			hasCompleteOutputStructure({
				filename: "book.xlsx",
				content: xlsx.subarray(0, xlsx.length - 30),
			}),
		).resolves.toBe(false);
		await expect(
			hasCompleteOutputStructure({
				filename: "report.pdf",
				content: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\n"),
			}),
		).resolves.toBe(false);
		for (const filename of [
			"data.csv",
			"notes.txt",
			"chart.png",
			"data.json",
		]) {
			await expect(
				hasCompleteOutputStructure({
					filename,
					content: Buffer.from("complete-looking content"),
				}),
			).resolves.toBe(false);
		}
	});
});
