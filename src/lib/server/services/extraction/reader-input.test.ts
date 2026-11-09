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
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prepareImage from "$lib/server/services/vision/prepare-image";
import { DocumentExtractionError, extractionErrorMessage } from "./contracts";
import { prepareReaderInput } from "./reader-input";

// What the extraction runner hands the document reader: the stored file as it
// is, or, for a type the reader cannot take (a HEIC or HEIF photo), a PNG that
// lives for one attempt. The real decoder runs here, on the real fixture.

// `vision/__fixtures__/tiny.heic` is 64x42, brand `ftypheic`; how it was made is
// written in `vision/prepare-image.test.ts`.
const here = path.dirname(fileURLToPath(import.meta.url));
const tinyHeic = readFileSync(
	path.join(here, "..", "vision", "__fixtures__", "tiny.heic"),
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
		});
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

	it("removes the PNG on release, and a second release does nothing", async () => {
		const original = await stored("IMG_0042.heic", tinyHeic);
		const reader = await prepare(original, "IMG_0042.heic", "image/heic");
		expect(await converted()).toEqual([`${OUTPUT_PREFIX}attempt-1.png`]);

		await reader.release();
		expect(await converted()).toEqual([]);

		await expect(reader.release()).resolves.toBeUndefined();
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
