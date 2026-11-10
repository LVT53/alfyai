// @vitest-environment node
//
// Node and not the default jsdom: the real decoder refuses a Node Buffer under
// jsdom ("Cannot pass non-string to std::string") and takes it under Node, as
// the server does.
import { readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MINERU_TEMP_MAX_AGE_MS,
	sweepMineruTempDirs,
} from "$lib/server/services/mineru/temp-sweep";
import { HEIF_MAX_PIXELS } from "$lib/server/services/vision/heif-decode";
import { ImageDecodeTimeoutError } from "$lib/server/services/vision/image-errors";
import * as prepareImage from "$lib/server/services/vision/prepare-image";
import { DocumentExtractionError, extractionErrorMessage } from "./contracts";
import { prepareReaderInput, readerFileFor } from "./reader-input";

// What the extraction runner hands the document reader: the stored file as it
// is, or, for a type the reader cannot take (a HEIC or HEIF photo), a PNG that
// lives for one attempt. The real decoder runs here, on the real fixture.

// `vision/__fixtures__/tiny.heic` is 64x42, brand `ftypheic`; how it was made is
// written in `vision/prepare-image.test.ts`.
const here = path.dirname(fileURLToPath(import.meta.url));
const tinyHeic = readFileSync(
	path.join(here, "..", "vision", "__fixtures__", "tiny.heic"),
);
// `vision/__fixtures__/transparent-page.heic` is 800x600: "Invoice" and "No. 4271"
// in bold black on a fully transparent page (how it was made is written in
// `vision/heif-decode.test.ts`). libheif gives the page as RGBA 0,0,0,0.
const transparentPage = readFileSync(
	path.join(here, "..", "vision", "__fixtures__", "transparent-page.heic"),
);

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const OUTPUT_PREFIX = "alfyai-reader-input-";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "alfyai-reader-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

/**
 * A copy of a real photo that says it has another size: the first `ispe` box
 * holds the width and the height, after its version and flags (the pattern of
 * `vision/heif-decode.test.ts`). The decoder reads the size before it decodes.
 */
function withIspe(bytes: Buffer, width: number, height: number): Buffer {
	const patched = Buffer.from(bytes);
	const at = patched.indexOf("ispe");
	patched.writeUInt32BE(width, at + 8);
	patched.writeUInt32BE(height, at + 12);
	return patched;
}

async function stored(name: string, bytes: Buffer): Promise<string> {
	const filePathAbsolute = path.join(root, name);
	await writeFile(filePathAbsolute, bytes);
	return filePathAbsolute;
}

/** The converted files the helper left in the per-test temp root. */
async function converted(): Promise<string[]> {
	return (await readdir(root)).filter((name) => name.startsWith(OUTPUT_PREFIX));
}

async function prepare(
	filePathAbsolute: string,
	fileName: string,
	mimeType: string | null,
	attemptId = "attempt-1",
) {
	return prepareReaderInput({
		fileName,
		mimeType,
		sizeBytes: 12,
		filePathAbsolute,
		contentSha256: "a".repeat(64),
		attemptId,
		tempDirRoot: root,
	});
}

describe("prepareReaderInput", () => {
	it("hands the reader a PNG of a HEIC photo, named for it, and leaves the original alone", async () => {
		const original = await stored("IMG_0042.HEIC", tinyHeic);

		const reader = await prepare(original, "IMG_0042.HEIC", "image/heic");

		const png = await readFile(reader.input.filePathAbsolute);
		expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
		expect(reader.input).toEqual({
			filePathAbsolute: path.join(root, `${OUTPUT_PREFIX}attempt-1.png`),
			fileName: "IMG_0042.png",
			mimeType: "image/png",
			sizeBytes: png.length,
			// The digest on the ledger is of the HEIC. The reader hashes the PNG itself.
			contentSha256: null,
		});
		// The photo itself, whole: the IHDR chunk holds the width and the height.
		expect(png.readUInt32BE(16)).toBe(64);
		expect(png.readUInt32BE(20)).toBe(42);
		expect(await readFile(original)).toEqual(tinyHeic);
	});

	it.each([
		["a .heif", "shot.heif", "image/heif", "shot.png"],
		[
			"a .heic a browser sent as octet-stream",
			"IMG_0042.heic",
			"application/octet-stream",
			"IMG_0042.png",
		],
		["a .heic sent with no type", "IMG_0042.heic", null, "IMG_0042.png"],
	])("converts %s the same way", async (_label, fileName, mimeType, expected) => {
		const original = await stored(fileName, tinyHeic);

		const reader = await prepare(original, fileName, mimeType);

		const png = await readFile(reader.input.filePathAbsolute);
		expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
		expect(reader.input).toMatchObject({
			fileName: expected,
			mimeType: "image/png",
			sizeBytes: png.length,
			contentSha256: null,
		});
	});

	it("writes the PNG for its owner alone", async () => {
		// A person's photo, in a temp directory every other service on the host can
		// list: the extractor's own temp directories are private, and so is this file.
		const original = await stored("IMG_0042.heic", tinyHeic);

		const reader = await prepare(original, "IMG_0042.heic", "image/heic");

		const { mode } = await stat(reader.input.filePathAbsolute);
		expect((mode & 0o777).toString(8)).toBe("600");
	});

	it("makes the same bytes every time it converts the same photo", async () => {
		// A resumed attempt converts again, and the extractor keeps the digest it took
		// of the first PNG in its stored handle: that digest names the file the
		// resumed attempt is handed only if the conversion is repeatable.
		const original = await stored("IMG_0042.heic", tinyHeic);

		const first = await prepare(
			original,
			"IMG_0042.heic",
			"image/heic",
			"attempt-1",
		);
		const second = await prepare(
			original,
			"IMG_0042.heic",
			"image/heic",
			"attempt-2",
		);

		expect(second.input.filePathAbsolute).not.toBe(
			first.input.filePathAbsolute,
		);
		expect(await readFile(second.input.filePathAbsolute)).toEqual(
			await readFile(first.input.filePathAbsolute),
		);
	});

	it("decodes at 4096 px on the long side, handing the decoder the entry's MIME type and not the job's", async () => {
		const decode = vi.spyOn(prepareImage, "decodeImageToPng");
		const original = await stored("IMG_0042.heic", tinyHeic);

		await prepare(original, "IMG_0042.heic", "application/octet-stream");

		// A 12 MP phone photo (4032 px) keeps its size and a 48 MP one is halved.
		// The entry's own MIME is what makes the decoder take the HEIC hop even for
		// bytes whose brand it cannot find by itself.
		expect(decode).toHaveBeenCalledTimes(1);
		expect(decode).toHaveBeenCalledWith(expect.any(Uint8Array), "image/heic", {
			maxLongEdge: 4096,
			background: "#ffffff",
		});
	});

	// A transparent page is black text on pixels libheif gives as 0,0,0,0, and a
	// reader shown that sees black on black: the document read as empty, with no
	// error. The photo goes to the reader on a white page.
	it("hands the reader a transparent photo on white, with no alpha left", async () => {
		const original = await stored("invoice.heic", transparentPage);

		const reader = await prepare(original, "invoice.heic", "image/heic");

		const png = await readFile(reader.input.filePathAbsolute);
		expect((await sharp(png).metadata()).hasAlpha).toBe(false);
		const { data, info } = await sharp(png)
			.raw()
			.toBuffer({ resolveWithObject: true });
		expect([info.width, info.height, info.channels]).toEqual([800, 600, 3]);
		const at = (x: number, y: number) =>
			Array.from(data.subarray((y * info.width + x) * 3).subarray(0, 3));
		expect([at(0, 0), at(799, 0), at(0, 599), at(799, 599)]).toEqual([
			[255, 255, 255],
			[255, 255, 255],
			[255, 255, 255],
			[255, 255, 255],
		]);
		// The stem of the "I" of "Invoice" (x 70 to 91, y 152 to 255) is still dark.
		expect(at(80, 200)).toEqual([0, 0, 0]);
	});

	it.each([
		["a jpg", "photo.jpg", "image/jpeg"],
		["a pdf", "report.pdf", "application/pdf"],
	])("hands the reader %s as it was given, and its release does nothing", async (_label, fileName, mimeType) => {
		const original = await stored(fileName, Buffer.from("stored bytes"));
		const source = {
			fileName,
			mimeType,
			sizeBytes: 12,
			filePathAbsolute: original,
			contentSha256: "b".repeat(64),
		};

		const reader = await prepareReaderInput({
			...source,
			attemptId: "attempt-2",
			tempDirRoot: root,
		});

		expect(reader.input).toEqual(source);
		await reader.release();
		expect(await readFile(original, "utf8")).toBe("stored bytes");
		expect(await converted()).toEqual([]);
	});

	it("fails bytes it cannot decode as an unreadable document, and leaves no file behind", async () => {
		const original = await stored("broken.heic", Buffer.from("not a photo"));

		const failure = await prepare(original, "broken.heic", "image/heic").catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(DocumentExtractionError);
		expect(failure).toMatchObject({
			code: "document_unreadable",
			retryable: false,
			// The person is told the document sentence; the decoder's reason is for the log.
			message: extractionErrorMessage("document_unreadable", ""),
			details: { reason: expect.stringContaining("image preparation failed") },
		});
		expect(await converted()).toEqual([]);
	});

	// The job's stored message is what the browser is sent, and a Node file error
	// names the absolute path it failed on (the storage directory, or the host's temp
	// directory). So a file the helper cannot read or write is the ledger's error with
	// the fixed sentence, and the raw text is left for the attempt's diagnostics.
	//
	// The code and the sentence are the ones a missing PDF gets from the MinerU
	// extractor, whose fallback for an error it does not know (`ENOENT` is one) is
	// `unavailable`, retryable: the same fault, the same words, whichever type it hits.
	it.each([
		["gone from storage", ["gone", "IMG_0042.heic"], "ENOENT"],
		["a directory where the file should be", ["IMG_0042.heic"], "EISDIR"],
	])("fails an original that is %s as the document service being unavailable, and keeps the raw text out of the message", async (_label, relative, errno) => {
		const at = path.join(root, ...relative);
		if (errno === "EISDIR") await mkdir(at);

		const failure = await prepare(at, "IMG_0042.heic", "image/heic").catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(DocumentExtractionError);
		expect(failure).toMatchObject({
			code: "unavailable",
			retryable: true,
			message: extractionErrorMessage("unavailable", ""),
			// The raw text is for the log and the attempt's diagnostics.
			details: {
				step: "read",
				errno,
				rawMessage: expect.stringContaining(errno),
			},
			cause: expect.objectContaining({ code: errno }),
		});
		expect((failure as Error).message).not.toContain(errno);
		expect((failure as Error).message).not.toContain(root);
		expect(await converted()).toEqual([]);
		if (errno === "ENOENT") {
			// Node names the path it failed on, which is why the raw text stays out.
			expect(
				(failure as DocumentExtractionError).details?.rawMessage,
			).toContain(at);
		}
	});

	it("fails a converted file it cannot write the same way, and leaves the original alone", async () => {
		const original = await stored("IMG_0042.heic", tinyHeic);
		const noSuchDirectory = path.join(root, "no-such-directory");

		const failure = await prepareReaderInput({
			fileName: "IMG_0042.heic",
			mimeType: "image/heic",
			sizeBytes: 12,
			filePathAbsolute: original,
			contentSha256: "a".repeat(64),
			attemptId: "attempt-1",
			tempDirRoot: noSuchDirectory,
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DocumentExtractionError);
		expect(failure).toMatchObject({
			code: "unavailable",
			retryable: true,
			message: extractionErrorMessage("unavailable", ""),
			details: {
				step: "write",
				errno: "ENOENT",
				rawMessage: expect.stringContaining(noSuchDirectory),
			},
			cause: expect.objectContaining({ code: "ENOENT" }),
		});
		expect((failure as Error).message).not.toContain(root);
		expect(await readFile(original)).toEqual(tinyHeic);
	});

	// What the ledger says of a photo the decoder gives up on (D9): a photo over
	// the pixel limit is its own fact about the photo, a decode that ran out of
	// time is the box being slow and gets another try, and a photo libheif refuses
	// is unreadable, as it always was (the test above).
	it("fails a photo over the pixel limit as image_too_large, not retryable, and leaves no file", async () => {
		const original = await stored(
			"panorama.heic",
			withIspe(tinyHeic, 10_001, 10_000),
		);

		const failure = await prepare(
			original,
			"panorama.heic",
			"image/heic",
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DocumentExtractionError);
		expect(failure).toMatchObject({
			code: "image_too_large",
			retryable: false,
			message: extractionErrorMessage("image_too_large", ""),
			details: { pixels: 100_010_000, limit: HEIF_MAX_PIXELS },
		});
		expect(await converted()).toEqual([]);
	});

	it("fails a decode that ran out of time as job_failed, retryable, so it is tried again", async () => {
		vi.spyOn(prepareImage, "decodeImageToPng").mockRejectedValueOnce(
			new ImageDecodeTimeoutError(60_000),
		);
		const original = await stored("IMG_0042.heic", tinyHeic);

		const failure = await prepare(
			original,
			"IMG_0042.heic",
			"image/heic",
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DocumentExtractionError);
		expect(failure).toMatchObject({
			code: "job_failed",
			retryable: true,
			message: extractionErrorMessage("job_failed", ""),
			details: { timeoutMs: 60_000 },
		});
		expect(await converted()).toEqual([]);
	});

	it("removes the PNG on release, and a second release does nothing", async () => {
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = await prepare(original, "IMG_0042.heic", "image/heic");
		expect(await converted()).toEqual([`${OUTPUT_PREFIX}attempt-1.png`]);

		await reader.release();
		expect(await converted()).toEqual([]);

		await expect(reader.release()).resolves.toBeUndefined();
		expect(await readFile(original)).toEqual(tinyHeic);
	});

	it("leaves, for a process that is killed before `release`, a file the temp sweep collects once it is old", async () => {
		// The sweep and the helper agree on the name only if the sweep finds what the
		// helper really wrote, so this runs the helper and then the sweep.
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = await prepare(original, "IMG_0042.heic", "image/heic");
		expect(await converted()).toEqual([`${OUTPUT_PREFIX}attempt-1.png`]);
		const sweep = () =>
			sweepMineruTempDirs({
				tempRootAbsolute: root,
				knowledgeRootAbsolute: path.join(root, "no-knowledge-directory"),
			});

		// Young: an attempt may be running right now, in this process or another.
		expect(await sweep()).toEqual({ scanned: 1, removed: 0 });
		expect(await converted()).toEqual([`${OUTPUT_PREFIX}attempt-1.png`]);

		const old = new Date(Date.now() - MINERU_TEMP_MAX_AGE_MS - 60_000);
		await utimes(reader.input.filePathAbsolute, old, old);
		expect(await sweep()).toEqual({ scanned: 1, removed: 1 });
		expect(await converted()).toEqual([]);
		// The photo the person uploaded is not the helper's to lose, nor the sweep's.
		expect(await readFile(original)).toEqual(tinyHeic);
	});

	it("never throws from release: a file it cannot remove is a warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = await prepare(original, "IMG_0042.heic", "image/heic");
		// `rm` without `recursive` refuses a directory, so this removal fails.
		await rm(reader.input.filePathAbsolute);
		await mkdir(reader.input.filePathAbsolute);

		await expect(reader.release()).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/^\[EXTRACTION\] /);
	});
});

describe("readerFileFor", () => {
	it("names the converted file for the stem of the stored name, under the type it is read as", () => {
		expect(readerFileFor("IMG_0042.HEIC", "png")).toEqual({
			fileName: "IMG_0042.png",
			mimeType: "image/png",
		});
		expect(readerFileFor("shot.heif", "png").fileName).toBe("shot.png");
		// Dots in the stem stay; a name with no extension keeps all of it, and one
		// with nothing to keep gets a neutral stem.
		expect(readerFileFor("trip.2026.heic", "png").fileName).toBe(
			"trip.2026.png",
		);
		expect(readerFileFor("IMG_0042", "png").fileName).toBe("IMG_0042.png");
		expect(readerFileFor("", "png").fileName).toBe("document.png");
	});
});
