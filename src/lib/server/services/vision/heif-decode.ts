// What a HEIC or HEIF file says about its size, read from its boxes before
// anything decodes it. libheif (WebAssembly) allocates what the file declares,
// and the files are uploads, so a photo far over what a phone makes is refused
// on this number and never decoded.

/**
 * The most pixels a photo may have, read from its file before any decoding. Every
 * phone photo fits, a 48 or 50 MP one and an iPhone panorama included, and the
 * decode of one this size takes about 1 GB (RGBA, four bytes a pixel, as well as
 * libheif's own heap); more than this is refused, not decoded.
 */
export const HEIF_MAX_PIXELS = 100_000_000;

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
