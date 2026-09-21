import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertUploadSignatureForFile,
	assertUploadSignatureForStoredFile,
	isKnowledgeUploadContentMismatchError,
	verifyUploadSignature,
} from "./upload-signature";

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = [0x47, 0x49, 0x46, 0x38];
const WEBP = [
	0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];
const BMP = [0x42, 0x4d];
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a];
const FTYP = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];
const ID3 = [0x49, 0x44, 0x33];
const MP3_FRAME = [0xff, 0xfb];
const RAR = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];
const SEVEN_ZIP = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const GZIP = [0x1f, 0x8b];
const RTF = [0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31];

/** Padded to 16 bytes so an offset-4 signature has something to read. */
function head(bytes: number[]): Buffer {
	const buffer = Buffer.alloc(16);
	Buffer.from(bytes).copy(buffer);
	return buffer;
}

function accepts(fileName: string, bytes: number[]): boolean {
	return verifyUploadSignature({ fileName, mimeType: null, head: head(bytes) })
		.ok;
}

describe("verifyUploadSignature", () => {
	it.each([
		["report.pdf", PDF],
		["report.docx", ZIP_LOCAL],
		["report.xlsx", ZIP_EMPTY],
		["deck.pptx", ZIP_SPANNED],
		["notes.odt", ZIP_LOCAL],
		["legacy.doc", OLE2],
		["legacy.xls", OLE2],
		["legacy.ppt", OLE2],
		["shot.png", PNG],
		["shot.jpg", JPEG],
		["shot.jpeg", JPEG],
		["shot.jfif", JPEG],
		["loop.gif", GIF],
		["shot.webp", WEBP],
		["shot.bmp", BMP],
		["scan.tif", TIFF_LE],
		["scan.tiff", TIFF_BE],
		["shot.heic", FTYP],
		["shot.heif", FTYP],
		["shot.avif", FTYP],
		["clip.mp4", FTYP],
		["clip.mov", FTYP],
		["song.mp3", ID3],
		["song.mp3", MP3_FRAME],
		["bundle.rar", RAR],
		["bundle.7z", SEVEN_ZIP],
		["bundle.gz", GZIP],
		["bundle.zip", ZIP_LOCAL],
		["memo.rtf", RTF],
	])("accepts %s with its own leading bytes", (fileName, bytes) => {
		expect(accepts(fileName, bytes)).toBe(true);
	});

	it.each([
		["report.pdf", ZIP_LOCAL],
		["report.docx", PDF],
		["legacy.doc", ZIP_LOCAL],
		["shot.png", PDF],
		["shot.jpg", PNG],
		["loop.gif", JPEG],
		["shot.webp", PNG],
		["shot.bmp", PDF],
		["scan.tif", PNG],
		["shot.heic", PNG],
		["song.mp3", PDF],
		["bundle.rar", ZIP_LOCAL],
		["bundle.7z", ZIP_LOCAL],
		["bundle.gz", ZIP_LOCAL],
		["memo.rtf", PDF],
	])("refuses %s carrying the wrong leading bytes", (fileName, bytes) => {
		expect(accepts(fileName, bytes)).toBe(false);
	});

	it("reads the WebP marker at offset 8, not at offset 4", () => {
		// RIFF container, right length field, wrong payload tag.
		const notWebp = [...WEBP];
		notWebp[8] = 0x41;
		expect(accepts("shot.webp", notWebp)).toBe(false);
	});

	it("never sniffs a text or code type", () => {
		// Any byte sequence is a legal text file, so these entries declare no
		// signature at all and the matcher must not invent one.
		//
		// `memo.rtf` moved out of this list in Phase 5 P5-B: `rtf` gained a
		// `{\rtf` signature (`registry.test.ts`), so it is sniffed like any other
		// signed type now — see the accepts/refuses tables above.
		for (const fileName of [
			"notes.txt",
			"notes.md",
			"data.csv",
			"data.json",
			"page.html",
			"script.py",
			"chart.svg",
		]) {
			expect(accepts(fileName, PDF), fileName).toBe(true);
			expect(accepts(fileName, [0x00, 0x00, 0x00]), fileName).toBe(true);
		}
	});

	// Every PDF reader accepts a header that is not at byte 0: the spec's own
	// implementation notes tell them to look within the first 1024 bytes, and
	// mail gateways, scanners and "optimizers" really do prepend junk.
	// Refusing those would be a false reject invented by this phase — they
	// extracted fine before the gate existed.
	it("accepts a PDF whose header is not at byte 0", () => {
		for (const preamble of [1, 16, 100, 1019]) {
			const bytes = [...new Array(preamble).fill(0x20), ...PDF];
			expect(
				verifyUploadSignature({
					fileName: "scan.pdf",
					mimeType: null,
					head: Buffer.from(bytes),
				}).ok,
				`preamble of ${preamble}`,
			).toBe(true);
		}
	});

	it("still refuses a PDF whose header is past the search window", () => {
		const bytes = [...new Array(1025).fill(0x20), ...PDF];
		expect(
			verifyUploadSignature({
				fileName: "scan.pdf",
				mimeType: null,
				head: Buffer.from(bytes),
			}).ok,
		).toBe(false);
	});

	it("does not let any other type wander from its offset", () => {
		// The search window is a PDF-specific allowance. A PNG or a ZIP whose
		// magic is one byte late is a real mismatch.
		for (const [fileName, bytes] of [
			["shot.png", PNG],
			["report.docx", ZIP_LOCAL],
			["shot.webp", WEBP],
		] as const) {
			expect(accepts(fileName, [0x20, ...bytes]), fileName).toBe(false);
		}
	});

	it("passes a type the registry does not know", () => {
		// The intent endpoint already refused it; the completion check is not a
		// second allowlist.
		expect(accepts("mystery.wat", PDF)).toBe(true);
		expect(accepts("noextension", PDF)).toBe(true);
	});

	it("falls back to the declared MIME when the name carries no extension", () => {
		expect(
			verifyUploadSignature({
				fileName: "scan",
				mimeType: "application/pdf",
				head: head(PDF),
			}).ok,
		).toBe(true);
		expect(
			verifyUploadSignature({
				fileName: "scan",
				mimeType: "application/pdf",
				head: head(PNG),
			}).ok,
		).toBe(false);
	});
});

describe("assertUploadSignatureForStoredFile", () => {
	let dir = "";

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "alfyai-upload-signature-"));
	});

	afterEach(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	async function write(name: string, bytes: number[]): Promise<string> {
		const path = join(dir, name);
		await writeFile(path, Buffer.from(bytes));
		return path;
	}

	it("keeps a matching file on disk", async () => {
		const path = await write("real.pdf", [...PDF, 0x31, 0x2e, 0x37]);
		await expect(
			assertUploadSignatureForStoredFile({
				fileName: "real.pdf",
				mimeType: "application/pdf",
				tempPathAbsolute: path,
			}),
		).resolves.toBeUndefined();
		await expect(readFile(path)).resolves.toBeInstanceOf(Buffer);
	});

	it("unlinks the temp file and throws on a mismatch", async () => {
		const path = await write("fake.png", PDF);

		await expect(
			assertUploadSignatureForStoredFile({
				fileName: "fake.png",
				mimeType: "image/png",
				tempPathAbsolute: path,
			}),
		).rejects.toSatisfy(isKnowledgeUploadContentMismatchError);

		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("carries the 415 contract on the thrown error", async () => {
		const path = await write("fake.png", PDF);
		const error = await assertUploadSignatureForStoredFile({
			fileName: "fake.png",
			mimeType: "image/png",
			tempPathAbsolute: path,
		}).catch((thrown: unknown) => thrown);

		expect(isKnowledgeUploadContentMismatchError(error)).toBe(true);
		expect(error).toMatchObject({
			status: 415,
			code: "upload_content_mismatch",
			errorKey: "knowledge.uploadContentMismatch",
			fileName: "fake.png",
			extension: "png",
		});
	});

	it("accepts a file shorter than the signature window", async () => {
		const path = await write("tiny.txt", [0x68, 0x69]);
		await expect(
			assertUploadSignatureForStoredFile({
				fileName: "tiny.txt",
				mimeType: "text/plain",
				tempPathAbsolute: path,
			}),
		).resolves.toBeUndefined();
	});

	it("refuses a file too short to carry its signature", async () => {
		const path = await write("truncated.png", [0x89, 0x50]);
		await expect(
			assertUploadSignatureForStoredFile({
				fileName: "truncated.png",
				mimeType: "image/png",
				tempPathAbsolute: path,
			}),
		).rejects.toSatisfy(isKnowledgeUploadContentMismatchError);
	});
});

describe("assertUploadSignatureForFile", () => {
	it("passes a multipart File whose bytes match", async () => {
		const file = new File([Buffer.from(PDF)], "real.pdf", {
			type: "application/pdf",
		});
		await expect(assertUploadSignatureForFile(file)).resolves.toBeUndefined();
	});

	it("refuses a multipart File whose bytes do not", async () => {
		const file = new File([Buffer.from(PDF)], "fake.png", {
			type: "image/png",
		});
		await expect(assertUploadSignatureForFile(file)).rejects.toSatisfy(
			isKnowledgeUploadContentMismatchError,
		);
	});
});
