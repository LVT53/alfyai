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
import {
	ImageDecodeTimeoutError,
	ImageDecodeUnavailableError,
	ImagePreparationError,
} from "$lib/server/services/vision/image-errors";
import * as prepareImage from "$lib/server/services/vision/prepare-image";
import { DocumentExtractionError, extractionErrorMessage } from "./contracts";
import { prepareReaderInput, readerFileFor } from "./reader-input";

// What the extraction runner hands the document reader: the stored file as it
// is, or, for a type the reader cannot take (a HEIC or HEIF photo), a PNG that
// is made when the extractor asks for the file and lives for one attempt. The
// real decoder runs here, on the real fixture.

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

function prepare(
	filePathAbsolute: string,
	fileName: string,
	mimeType: string | null,
	attemptId = "attempt-1",
	signal: AbortSignal = new AbortController().signal,
) {
	return prepareReaderInput({
		fileName,
		mimeType,
		sizeBytes: 12,
		filePathAbsolute,
		contentSha256: "a".repeat(64),
		attemptId,
		tempDirRoot: root,
		signal,
	});
}

/** What a promise rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject, but it resolved");
}

describe("prepareReaderInput", () => {
	it("makes nothing until the file is asked for, and says what it will be called at once", async () => {
		const decode = vi.spyOn(prepareImage, "decodeImageToPng");
		// The original is not even there: nothing is read to answer these.
		const reader = prepare(
			path.join(root, "not-there.heic"),
			"IMG_0042.HEIC",
			"image/heic",
		);

		expect(reader.fileName).toBe("IMG_0042.png");
		expect(reader.mimeType).toBe("image/png");
		expect(decode).not.toHaveBeenCalled();
		expect(await converted()).toEqual([]);
	});

	it("hands the reader a PNG of a HEIC photo, named for it, and leaves the original alone", async () => {
		const original = await stored("IMG_0042.HEIC", tinyHeic);

		const reader = prepare(original, "IMG_0042.HEIC", "image/heic");
		const file = await reader.openFile();

		const png = await readFile(file.filePathAbsolute);
		expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
		expect([reader.fileName, reader.mimeType]).toEqual([
			"IMG_0042.png",
			"image/png",
		]);
		expect(file).toEqual({
			filePathAbsolute: path.join(root, `${OUTPUT_PREFIX}attempt-1.png`),
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

		const reader = prepare(original, fileName, mimeType);
		const file = await reader.openFile();

		const png = await readFile(file.filePathAbsolute);
		expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
		expect([reader.fileName, reader.mimeType]).toEqual([expected, "image/png"]);
		expect(file).toMatchObject({ sizeBytes: png.length, contentSha256: null });
	});

	it("writes the PNG for its owner alone", async () => {
		// A person's photo, in a temp directory every other service on the host can
		// list: the extractor's own temp directories are private, and so is this file.
		const original = await stored("IMG_0042.heic", tinyHeic);

		const file = await prepare(
			original,
			"IMG_0042.heic",
			"image/heic",
		).openFile();

		const { mode } = await stat(file.filePathAbsolute);
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
		).openFile();
		const second = await prepare(
			original,
			"IMG_0042.heic",
			"image/heic",
			"attempt-2",
		).openFile();

		expect(second.filePathAbsolute).not.toBe(first.filePathAbsolute);
		expect(await readFile(second.filePathAbsolute)).toEqual(
			await readFile(first.filePathAbsolute),
		);
	});

	it("decodes at 4096 px on the long side, onto white, for the attempt's signal, handing the decoder the entry's MIME type and not the job's", async () => {
		const decode = vi.spyOn(prepareImage, "decodeImageToPng");
		const original = await stored("IMG_0042.heic", tinyHeic);
		const controller = new AbortController();

		await prepare(
			original,
			"IMG_0042.heic",
			"application/octet-stream",
			"attempt-1",
			controller.signal,
		).openFile();

		// A 12 MP phone photo (4032 px) keeps its size and a 48 MP one is halved.
		// The entry's own MIME is what makes the decoder take the HEIC hop even for
		// bytes whose brand it cannot find by itself.
		expect(decode).toHaveBeenCalledTimes(1);
		expect(decode).toHaveBeenCalledWith(expect.any(Uint8Array), "image/heic", {
			maxLongEdge: 4096,
			background: "#ffffff",
			signal: controller.signal,
		});
	});

	// A transparent page is black text on pixels libheif gives as 0,0,0,0, and a
	// reader shown that sees black on black: the document read as empty, with no
	// error. The photo goes to the reader on a white page.
	it("hands the reader a transparent photo on white, with no alpha left", async () => {
		const original = await stored("invoice.heic", transparentPage);

		const file = await prepare(
			original,
			"invoice.heic",
			"image/heic",
		).openFile();

		const png = await readFile(file.filePathAbsolute);
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
	])("hands the reader %s as it was given, without touching it, and its release does nothing", async (_label, fileName, mimeType) => {
		const decode = vi.spyOn(prepareImage, "decodeImageToPng");
		const original = await stored(fileName, Buffer.from("stored bytes"));

		const reader = prepareReaderInput({
			fileName,
			mimeType,
			sizeBytes: 12,
			filePathAbsolute: original,
			contentSha256: "b".repeat(64),
			attemptId: "attempt-2",
			tempDirRoot: root,
			signal: new AbortController().signal,
		});

		expect([reader.fileName, reader.mimeType]).toEqual([fileName, mimeType]);
		expect(await reader.openFile()).toEqual({
			filePathAbsolute: original,
			sizeBytes: 12,
			contentSha256: "b".repeat(64),
		});
		await reader.release();
		expect(await readFile(original, "utf8")).toBe("stored bytes");
		expect(await converted()).toEqual([]);
		expect(decode).not.toHaveBeenCalled();
	});

	it("opens a stored file without looking at it: the file need not even be there", async () => {
		// The extractor reads it, and says what is wrong with it in its own words (a
		// missing PDF is `unavailable` there, as it always was).
		const gone = path.join(root, "gone", "report.pdf");

		const file = await prepareReaderInput({
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 12,
			filePathAbsolute: gone,
			contentSha256: null,
			attemptId: "attempt-2",
			tempDirRoot: root,
			signal: new AbortController().signal,
		}).openFile();

		expect(file).toEqual({
			filePathAbsolute: gone,
			sizeBytes: 12,
			contentSha256: null,
		});
	});

	it("opens once for the attempt: every later call gets the same file", async () => {
		const decode = vi.spyOn(prepareImage, "decodeImageToPng");
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = prepare(original, "IMG_0042.heic", "image/heic");

		const [first, second] = await Promise.all([
			reader.openFile(),
			reader.openFile(),
		]);
		const third = await reader.openFile();

		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(decode).toHaveBeenCalledTimes(1);
		expect(await converted()).toEqual([`${OUTPUT_PREFIX}attempt-1.png`]);
	});

	it("fails bytes it cannot decode as an unreadable document, leaves no file behind, and fails the same way again", async () => {
		const original = await stored("broken.heic", Buffer.from("not a photo"));
		const reader = prepare(original, "broken.heic", "image/heic");

		const failure = await rejection(reader.openFile());

		expect(failure).toBeInstanceOf(DocumentExtractionError);
		expect(failure).toMatchObject({
			code: "document_unreadable",
			retryable: false,
			// The person is told the document sentence; the decoder's reason is for the log.
			message: extractionErrorMessage("document_unreadable", ""),
			details: { reason: expect.stringContaining("image preparation failed") },
		});
		expect(await converted()).toEqual([]);
		// The attempt does not decode the same bytes a second time to find out.
		expect(await rejection(reader.openFile())).toBe(failure);
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

		const failure = await rejection(
			prepare(original, "panorama.heic", "image/heic").openFile(),
		);

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

		const failure = await rejection(
			prepare(original, "IMG_0042.heic", "image/heic").openFile(),
		);

		expect(failure).toBeInstanceOf(DocumentExtractionError);
		expect(failure).toMatchObject({
			code: "job_failed",
			retryable: true,
			message: extractionErrorMessage("job_failed", ""),
			details: { timeoutMs: 60_000 },
		});
		expect(await converted()).toEqual([]);
	});

	it("fails a decode that could not get a thread as job_failed, retryable: the box was short, the photo is not at fault", async () => {
		vi.spyOn(prepareImage, "decodeImageToPng").mockRejectedValueOnce(
			new ImageDecodeUnavailableError(
				"image decode worker could not start: Resource temporarily unavailable",
			),
		);
		const original = await stored("IMG_0042.heic", tinyHeic);

		const failure = await rejection(
			prepare(original, "IMG_0042.heic", "image/heic").openFile(),
		);

		expect(failure).toBeInstanceOf(DocumentExtractionError);
		expect(failure).toMatchObject({
			code: "job_failed",
			retryable: true,
			message: extractionErrorMessage("job_failed", ""),
			details: {
				reason: expect.stringContaining("could not start"),
			},
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

		const failure = await rejection(
			prepare(at, "IMG_0042.heic", "image/heic").openFile(),
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

		const failure = await rejection(
			prepareReaderInput({
				fileName: "IMG_0042.heic",
				mimeType: "image/heic",
				sizeBytes: 12,
				filePathAbsolute: original,
				contentSha256: "a".repeat(64),
				attemptId: "attempt-1",
				tempDirRoot: noSuchDirectory,
				signal: new AbortController().signal,
			}).openFile(),
		);

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

	it("removes the PNG on release, and a second release does nothing", async () => {
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = prepare(original, "IMG_0042.heic", "image/heic");
		await reader.openFile();
		expect(await converted()).toEqual([`${OUTPUT_PREFIX}attempt-1.png`]);

		await reader.release();
		expect(await converted()).toEqual([]);

		await expect(reader.release()).resolves.toBeUndefined();
		expect(await readFile(original)).toEqual(tinyHeic);
	});

	it("has nothing to remove when the file was never asked for", async () => {
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = prepare(original, "IMG_0042.heic", "image/heic");

		await expect(reader.release()).resolves.toBeUndefined();

		expect(await converted()).toEqual([]);
		expect(await readFile(original)).toEqual(tinyHeic);
	});

	it("waits for an open that is still going when it is released, and then removes what it made", async () => {
		// An extractor that is stopped while its open is in flight: the open ends,
		// and the file it writes is not left behind for a release that has gone.
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = prepare(original, "IMG_0042.heic", "image/heic");

		const opening = reader.openFile();
		await reader.release();

		await expect(opening).resolves.toMatchObject({ contentSha256: null });
		expect(await converted()).toEqual([]);
	});

	it.each([
		["a photo", "IMG_0042.heic", "image/heic"],
		["a stored file", "report.pdf", "application/pdf"],
	])("refuses to open %s once it has been released, and reads nothing", async (_label, fileName, mimeType) => {
		const decode = vi.spyOn(prepareImage, "decodeImageToPng");
		const original = await stored(fileName, tinyHeic);
		const reader = prepare(original, fileName, mimeType);
		await reader.release();

		const failure = await rejection(reader.openFile());

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/released/i);
		expect(decode).not.toHaveBeenCalled();
		expect(await converted()).toEqual([]);
	});

	it("leaves, for a process that is killed before `release`, a file the temp sweep collects once it is old", async () => {
		// The sweep and the helper agree on the name only if the sweep finds what the
		// helper really wrote, so this runs the helper and then the sweep.
		const original = await stored("IMG_0042.heic", tinyHeic);
		const file = await prepare(
			original,
			"IMG_0042.heic",
			"image/heic",
		).openFile();
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
		await utimes(file.filePathAbsolute, old, old);
		expect(await sweep()).toEqual({ scanned: 1, removed: 1 });
		expect(await converted()).toEqual([]);
		// The photo the person uploaded is not the helper's to lose, nor the sweep's.
		expect(await readFile(original)).toEqual(tinyHeic);
	});

	it("never throws from release: a file it cannot remove is a warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = prepare(original, "IMG_0042.heic", "image/heic");
		const file = await reader.openFile();
		// `rm` without `recursive` refuses a directory, so this removal fails.
		await rm(file.filePathAbsolute);
		await mkdir(file.filePathAbsolute);

		await expect(reader.release()).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/^\[EXTRACTION\] /);
	});

	// The signal is the attempt's. A cancel, or a claim taken away, calls the
	// decode off, and a decode that was called off writes nothing: a photo nobody
	// is going to read is not put on the disk.
	describe("when the attempt is called off", () => {
		const reason = new Error("the attempt was called off");

		it("refuses to start with the reason, and reads nothing, when it already is", async () => {
			const decode = vi.spyOn(prepareImage, "decodeImageToPng");
			// A read would fail as `unavailable`: the original is not there.
			const reader = prepare(
				path.join(root, "not-there.heic"),
				"IMG_0042.heic",
				"image/heic",
				"attempt-1",
				AbortSignal.abort(reason),
			);

			expect(await rejection(reader.openFile())).toBe(reason);

			expect(decode).not.toHaveBeenCalled();
			expect(await converted()).toEqual([]);
		});

		it("stops a decode that is running, with the reason as it is, and writes no file", async () => {
			const controller = new AbortController();
			// A decoder still at work when the call is called off.
			const decode = vi
				.spyOn(prepareImage, "decodeImageToPng")
				.mockImplementation(
					(_input, _mimeType, options) =>
						new Promise<never>((_resolve, reject) => {
							options?.signal?.addEventListener(
								"abort",
								() => reject(options.signal?.reason),
								{ once: true },
							);
						}),
				);
			const original = await stored("IMG_0042.heic", tinyHeic);
			const reader = prepare(
				original,
				"IMG_0042.heic",
				"image/heic",
				"attempt-1",
				controller.signal,
			);

			const opening = reader.openFile();
			await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
			controller.abort(reason);

			expect(await rejection(opening)).toBe(reason);
			// Looked at before `release` could remove anything: nothing was written.
			expect(await converted()).toEqual([]);
		});

		it("gives the reason, not a decoder error, when the decode fails because it was called off", async () => {
			const controller = new AbortController();
			vi.spyOn(prepareImage, "decodeImageToPng").mockImplementation(
				async () => {
					controller.abort(reason);
					throw new ImagePreparationError(
						"image preparation failed: its worker was stopped",
					);
				},
			);
			const original = await stored("IMG_0042.heic", tinyHeic);

			const failure = await rejection(
				prepare(
					original,
					"IMG_0042.heic",
					"image/heic",
					"attempt-1",
					controller.signal,
				).openFile(),
			);

			// Not an unreadable document: nobody was told the photo was bad.
			expect(failure).toBe(reason);
			expect(await converted()).toEqual([]);
		});

		it("writes no file for a decode that finished after it was called off", async () => {
			const controller = new AbortController();
			vi.spyOn(prepareImage, "decodeImageToPng").mockImplementation(
				async () => {
					controller.abort(reason);
					return {
						png: Buffer.from("png bytes"),
						width: 1,
						height: 1,
						hasAlpha: false,
					};
				},
			);
			const original = await stored("IMG_0042.heic", tinyHeic);

			const failure = await rejection(
				prepare(
					original,
					"IMG_0042.heic",
					"image/heic",
					"attempt-1",
					controller.signal,
				).openFile(),
			);

			expect(failure).toBe(reason);
			expect(await converted()).toEqual([]);
		});
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
