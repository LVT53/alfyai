import { createRequire } from "node:module";
import { types } from "node:util";
import { createDecodePool } from "./decode-pool";
import { ImagePreparationError, ImageTooLargeError } from "./image-errors";

// HEIC and HEIF to raw pixels, off the server's main thread.
//
// libheif (WebAssembly, through the heic-decode package) is the only decoder
// that reads these files, and it is a poor guest on the thread that serves chat
// streams: a 12 MP photo holds that thread for about half a second, a 48 MP one
// for seconds with a memory peak near 1.6 GB that libheif never returns, and a
// throw or a WebAssembly trap inside its own setTimeout is an uncaught
// exception, which exits Node. So each photo is decoded in a worker thread of
// its own (decode-pool.ts), which ends when the photo is done: its memory goes
// back to the system, a crash costs one decode, and a decode that hangs is
// terminated.
//
// Only libheif runs there. sharp stays on the main thread, where it already
// works off libuv's pool: orientation, flattening, resizing and encoding
// (prepare-image.ts).

/**
 * The most pixels a photo may have, read from its file before any decoding. Every
 * phone photo fits, a 48 or 50 MP one and an iPhone panorama included, and the
 * decode of one this size takes about 1 GB in its worker (RGBA, four bytes a
 * pixel, as well as libheif's own heap); more than this is refused, not decoded.
 */
export const HEIF_MAX_PIXELS = 100_000_000;

/**
 * Decodes at once for the whole process. Each is a thread and, for a big photo,
 * a gigabyte or so; the rest wait their turn.
 */
export const HEIF_DECODE_CONCURRENCY = 2;

/**
 * How long one decode may run, from its worker's start. The slowest photo
 * measured on the box, 48 MP, took about 6 s (with a step this decode no longer
 * has), so this is ten times that: a slow, busy machine still finishes, and only
 * a decode that is stuck is stopped.
 */
export const HEIF_DECODE_TIMEOUT_MS = 60_000;

/** The decoded picture: RGBA, `width * height * 4` bytes, not premultiplied. */
export type HeifPixels = { width: number; height: number; data: Uint8Array };

// --- What the file says its size is -----------------------------------------

// An ISO base media file is boxes laid end to end. A box is a 32-bit size, a
// four-letter type and its payload. A size of 1 says a 64-bit size follows the
// type, and a size of 0 says the box runs to the end of what holds it.
const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
/** `meta` and `ispe` are "full" boxes: a version and flags word comes before their content. */
const FULL_BOX_WORD_BYTES = 4;
/** An `ispe` holds the image's width and height, a 32-bit number each. */
const ISPE_SIZE_BYTES = 8;

type Box = { type: string; payloadStart: number; end: number };

/** The box that starts at `position` in a run that ends at `end`, or null when it does not fit. */
function readBox(view: DataView, position: number, end: number): Box | null {
	if (end - position < BOX_HEADER_BYTES) return null;
	const declared = view.getUint32(position);
	const type = String.fromCharCode(
		view.getUint8(position + 4),
		view.getUint8(position + 5),
		view.getUint8(position + 6),
		view.getUint8(position + 7),
	);
	let headerBytes = BOX_HEADER_BYTES;
	let size = declared;
	if (declared === 1) {
		headerBytes = LARGE_BOX_HEADER_BYTES;
		if (end - position < headerBytes) return null;
		// Exact below 2**53; a size beyond that is past any buffer anyway.
		size =
			view.getUint32(position + 8) * 2 ** 32 + view.getUint32(position + 12);
	} else if (declared === 0) {
		size = end - position;
	}
	if (size < headerBytes || size > end - position) return null;
	return { type, payloadStart: position + headerBytes, end: position + size };
}

/** The first box of `type` in [start, end). It stops at the first box it finds, and at the first that is malformed. */
function firstBox(
	view: DataView,
	start: number,
	end: number,
	type: string,
): Box | null {
	for (let position = start; position < end; ) {
		const box = readBox(view, position, end);
		if (!box) return null;
		if (box.type === type) return box;
		position = box.end;
	}
	return null;
}

/** Every box in [start, end), or null when any of them is malformed. */
function allBoxes(view: DataView, start: number, end: number): Box[] | null {
	const boxes: Box[] = [];
	for (let position = start; position < end; ) {
		const box = readBox(view, position, end);
		if (!box) return null;
		boxes.push(box);
		position = box.end;
	}
	return boxes;
}

/**
 * The pixel count a HEIC or HEIF file declares: the LARGEST width times height
 * among the `ispe` boxes in `meta` > `iprp` > `ipco`, or null when there is none.
 *
 * The largest, never less than the primary image's whatever the item
 * associations say: a grid photo holds the size of its tiles as well as its own,
 * and a file may hold thumbnails and auxiliary pictures. Overstating is safe
 * (the photo is refused), understating is not.
 *
 * This reads a file that anybody can upload, before anything decodes it. It
 * never throws and never reads past the end of the bytes: a box that does not
 * fit in what holds it, a size smaller than its own header, a missing `meta` or
 * a truncated buffer all mean "no size", which is null. It looks only at the
 * boxes it needs, so a file cut off inside its picture data (after `meta`) still
 * says its size.
 */
export function readHeifPixelCount(bytes: Uint8Array): number | null {
	let view: DataView;
	try {
		view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	} catch {
		return null;
	}
	const meta = firstBox(view, 0, bytes.byteLength, "meta");
	if (!meta) return null;
	const iprp = firstBox(
		view,
		meta.payloadStart + FULL_BOX_WORD_BYTES,
		meta.end,
		"iprp",
	);
	if (!iprp) return null;
	const containers = allBoxes(view, iprp.payloadStart, iprp.end);
	if (!containers) return null;

	let largest: number | null = null;
	for (const container of containers) {
		if (container.type !== "ipco") continue;
		const properties = allBoxes(view, container.payloadStart, container.end);
		if (!properties) return null;
		for (const property of properties) {
			if (property.type !== "ispe") continue;
			const sizeAt = property.payloadStart + FULL_BOX_WORD_BYTES;
			if (property.end - sizeAt < ISPE_SIZE_BYTES) return null;
			const pixels = view.getUint32(sizeAt) * view.getUint32(sizeAt + 4);
			// An image with no pixels is not one libheif reads.
			if (pixels > 0 && (largest === null || pixels > largest)) {
				largest = pixels;
			}
		}
	}
	return largest;
}

// --- The decode, in a worker --------------------------------------------------

/**
 * What a decode worker runs: CommonJS from an `eval` source, because Vite
 * rewrites `new URL("./file", import.meta.url)` for the browser build only, so a
 * worker FILE next to this module would not exist next to the server chunk,
 * while a string is the same everywhere. It loads heic-decode by the absolute
 * path the main thread resolved (a worker started from a string resolves bare
 * names from the working directory, not from this module), decodes once and
 * posts one answer:
 * the pixels' ArrayBuffer is moved to the main thread, not copied. A decode that
 * fails to load or to decode answers `{ ok: false }`; a throw or trap inside
 * libheif's own timer is an uncaught exception, which the pool sees as the
 * worker's `error` event.
 */
const DECODE_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
	try {
		const decode = require(workerData.decoderPath);
		const { width, height, data } = await decode({ buffer: workerData.input });
		parentPort.postMessage({ ok: true, width, height, data: data.buffer }, [data.buffer]);
	} catch (error) {
		parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
	}
})();
`;

const heifPool = createDecodePool({
	concurrency: HEIF_DECODE_CONCURRENCY,
	timeoutMs: HEIF_DECODE_TIMEOUT_MS,
	source: DECODE_WORKER_SOURCE,
});

let decoderPath: string | undefined;

/** Where heic-decode is installed, found once from this module. */
function resolveDecoderPath(): string {
	decoderPath ??= createRequire(import.meta.url).resolve("heic-decode");
	return decoderPath;
}

/**
 * The worker's answer as pixels, or the error it stands for. The answer is
 * checked, not trusted: a picture over the limit or pixels that are not the
 * size they claim are refused.
 */
export function readDecoderAnswer(answer: unknown): HeifPixels {
	const reply = (
		typeof answer === "object" && answer !== null ? answer : {}
	) as {
		ok?: unknown;
		message?: unknown;
		width?: unknown;
		height?: unknown;
		data?: unknown;
	};
	if (reply.ok !== true) {
		const reason =
			reply.ok === false && typeof reply.message === "string"
				? reply.message
				: "no answer it could use";
		throw new ImagePreparationError(`HEIF decode failed: ${reason}`);
	}
	const { width, height, data } = reply;
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 1 ||
		height < 1
	) {
		throw new ImagePreparationError(
			"HEIF decode failed: it gave no image size",
		);
	}
	if (width * height > HEIF_MAX_PIXELS) {
		throw new ImageTooLargeError(width * height, HEIF_MAX_PIXELS);
	}
	if (!types.isArrayBuffer(data) || data.byteLength !== width * height * 4) {
		throw new ImagePreparationError(
			"HEIF decode failed: its pixels are not the size it gave",
		);
	}
	return { width, height, data: new Uint8Array(data) };
}

/**
 * Decodes the primary image of a HEIC or HEIF file to RGBA in a worker thread.
 *
 * Rejects with an `ImageTooLargeError` before any worker starts when the file
 * declares more than `HEIF_MAX_PIXELS`, with an `ImageDecodeTimeoutError` when
 * the worker is stopped at its deadline, with an `ImagePreparationError` for a
 * file libheif refuses (and for a worker that crashed or left without an
 * answer), and with `signal.reason` when the signal is aborted (a decode that
 * is waiting for a place never starts; one that is running has its worker
 * terminated).
 *
 * `input` is only read: it may be a view into a larger buffer (a file read into
 * Node's buffer pool is one), so a copy that owns its memory is what moves to
 * the worker, and the caller's bytes are left as they were.
 */
export async function decodeHeifToRgba(
	input: Uint8Array,
	options: { signal?: AbortSignal } = {},
): Promise<HeifPixels> {
	options.signal?.throwIfAborted();
	const pixels = readHeifPixelCount(input);
	if (pixels === null) {
		throw new ImagePreparationError(
			"HEIF decode failed: the file says nothing of its size",
		);
	}
	if (pixels > HEIF_MAX_PIXELS) {
		throw new ImageTooLargeError(pixels, HEIF_MAX_PIXELS);
	}
	// `Uint8Array.slice` of a Buffer is a view on the same memory, and a pooled
	// Buffer's memory cannot be moved: copy into an array of our own.
	const copy = new Uint8Array(input);
	const answer = await heifPool.run({
		workerData: { decoderPath: resolveDecoderPath(), input: copy },
		transferList: [copy.buffer],
		signal: options.signal,
	});
	return readDecoderAnswer(answer);
}
