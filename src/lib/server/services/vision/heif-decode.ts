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

/**
 * The most boxes the size reader looks at in one file, counted over the whole
 * walk: the top-level boxes up to `meta`, the boxes of `meta` up to `iprp`, and
 * every box inside `iprp` and inside each `ipco`. A real photo has dozens. The
 * bytes are an upload and a box can be as small as 8, so 100 MB can hold 12
 * million empty ones: what reading a file costs has to be bounded by this, not
 * by how big the file is. A file with more says nothing of its size.
 */
export const HEIF_MAX_BOXES_READ = 10_000;

/** A box type: its four letters as the 32-bit number they are stored as. */
const boxType = (letters: string): number =>
	((letters.charCodeAt(0) << 24) |
		(letters.charCodeAt(1) << 16) |
		(letters.charCodeAt(2) << 8) |
		letters.charCodeAt(3)) >>>
	0;
const META = boxType("meta");
const IPRP = boxType("iprp");
const IPCO = boxType("ipco");
const ISPE = boxType("ispe");

/**
 * Reads the boxes of one file, one at a time, and counts them against
 * `HEIF_MAX_BOXES_READ`. It leaves the box it read in its own fields and not in
 * an object, and compares types as numbers and not as strings, so walking a run
 * of boxes allocates nothing per box. One reader walks a whole file: its count is
 * the file's, not a run's.
 */
class BoxReader {
	readonly view: DataView;
	/** The box read last: its type, where its payload starts and where it ends. */
	type = 0;
	payloadStart = 0;
	end = 0;
	private remaining = HEIF_MAX_BOXES_READ;

	constructor(view: DataView) {
		this.view = view;
	}

	/**
	 * Reads the box that starts at `position` in a run that ends at `end`. False
	 * when it does not fit there (a size smaller than its own header, or running
	 * past the end) and when the file has used up the boxes it may read.
	 */
	read(position: number, end: number): boolean {
		if (this.remaining === 0 || end - position < BOX_HEADER_BYTES) return false;
		this.remaining -= 1;
		const declared = this.view.getUint32(position);
		let headerBytes = BOX_HEADER_BYTES;
		let size = declared;
		if (declared === 1) {
			headerBytes = LARGE_BOX_HEADER_BYTES;
			if (end - position < headerBytes) return false;
			// Exact below 2**53; a size beyond that is past any buffer anyway.
			size =
				this.view.getUint32(position + 8) * 2 ** 32 +
				this.view.getUint32(position + 12);
		} else if (declared === 0) {
			size = end - position;
		}
		if (size < headerBytes || size > end - position) return false;
		this.type = this.view.getUint32(position + 4);
		this.payloadStart = position + headerBytes;
		this.end = position + size;
		return true;
	}
}

/**
 * Finds the first box of `type` in [start, end) and leaves it in `reader`. It
 * stops at the first box it finds, and false is what it says when there is none,
 * when a box before it is malformed and when the file is out of boxes to read.
 */
function findBox(
	reader: BoxReader,
	start: number,
	end: number,
	type: number,
): boolean {
	for (let position = start; position < end; ) {
		if (!reader.read(position, end)) return false;
		if (reader.type === type) return true;
		position = reader.end;
	}
	return false;
}

/**
 * The largest width times height among the `ispe` boxes in [start, end): 0 when
 * there is none, and null when a box of the run is malformed (an `ispe` too short
 * to hold a size is) or the file is out of boxes to read. An image with no pixels
 * is not one libheif reads, so it does not count.
 */
function largestIspeIn(
	reader: BoxReader,
	start: number,
	end: number,
): number | null {
	let largest = 0;
	for (let position = start; position < end; ) {
		if (!reader.read(position, end)) return null;
		if (reader.type === ISPE) {
			const sizeAt = reader.payloadStart + FULL_BOX_WORD_BYTES;
			if (reader.end - sizeAt < ISPE_SIZE_BYTES) return null;
			const pixels =
				reader.view.getUint32(sizeAt) * reader.view.getUint32(sizeAt + 4);
			if (pixels > largest) largest = pixels;
		}
		position = reader.end;
	}
	return largest;
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
 * says its size. It also looks at no more than `HEIF_MAX_BOXES_READ` boxes, all
 * of the walk counted together, and a file with more says nothing of its size:
 * a crafted run of millions of empty boxes costs no more than that to refuse.
 */
export function readHeifPixelCount(bytes: Uint8Array): number | null {
	let view: DataView;
	try {
		view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	} catch {
		return null;
	}
	const reader = new BoxReader(view);
	if (!findBox(reader, 0, bytes.byteLength, META)) return null;
	const metaEnd = reader.end;
	if (
		!findBox(reader, reader.payloadStart + FULL_BOX_WORD_BYTES, metaEnd, IPRP)
	) {
		return null;
	}

	// Every box of `iprp` must be well formed, and every `ipco` among them is
	// searched for its sizes as it is met. The reader holds one box at a time, so
	// where `iprp` ends and where its next box starts are taken before a run inside
	// it is walked.
	const iprpEnd = reader.end;
	let largest = 0;
	for (let position = reader.payloadStart; position < iprpEnd; ) {
		if (!reader.read(position, iprpEnd)) return null;
		const next = reader.end;
		if (reader.type === IPCO) {
			const pixels = largestIspeIn(reader, reader.payloadStart, next);
			if (pixels === null) return null;
			if (pixels > largest) largest = pixels;
		}
		position = next;
	}
	return largest > 0 ? largest : null;
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

/**
 * Where heic-decode is installed, found once from this module. Nothing imports
 * the package: only the worker loads it, by this path, and a static import here
 * would load libheif on the main thread. Fallow sees no use of it for that
 * reason, so `.fallowrc.json` lists it under `ignoreDependencies`; take it out
 * of the list only together with this loader.
 */
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
 * the worker is stopped at its deadline, with an `ImageDecodeUnavailableError`
 * when the system will not make the worker's thread at all, with an
 * `ImagePreparationError` for a file libheif refuses (and for a worker that
 * crashed or left without an answer), and with `signal.reason` when the signal
 * is aborted (a decode that
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
