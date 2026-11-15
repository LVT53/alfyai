/**
 * The Video kind's version body (LTX video plan, slice 2). A version of a Video
 * is a small JSON string that POINTS at its clip: the mp4, its poster frame and
 * its thumbnail live in `images/video-files.ts`'s folder, never in the row. The
 * browser and the server read one shape through the parser here.
 *
 * The poster and the thumbnail are derived paths beside the clip, not rows of
 * their own (like a picture's `.thumb.png`), so `posterFileId` names the stored
 * file the poster is served from: `?variant=poster` on that id. It is the
 * clip's own file id today, and it is written out anyway so a card names the
 * poster without knowing how the route derives it.
 *
 * Browser-safe: no imports.
 */

export type VideoVersionBody = {
	v: 1;
	fileId: string;
	/** The stored file the poster is served from (`?variant=poster`). */
	posterFileId: string;
	width: number;
	height: number;
	/** The clip's length in whole milliseconds; the take's product length is 5000 or 10000. */
	durationMs: number;
	/** The still the clip was made from (null for a clip made from words alone). */
	sourceFileId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveWholeNumber(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value > 0 &&
		Number.isInteger(value)
	);
}

/**
 * The source still a body names: a non-empty id, or `null` for a clip made from
 * words alone. `undefined` means the value cannot be read at all (an empty
 * string, a number, an object), which makes the whole body unreadable.
 */
function parseSourceFileId(value: unknown): string | null | undefined {
	if (value === null || value === undefined) return null;
	return isNonEmptyString(value) ? value : undefined;
}

/**
 * The body a stored string holds, or `null` when it is not a version-1 video
 * body: a missing file, a non-positive or fractional duration, anything else
 * that cannot stand. Never throws.
 */
export function parseVideoVersionBody(
	stored: string | null,
): VideoVersionBody | null {
	if (!stored) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(stored);
	} catch {
		return null;
	}
	if (!isRecord(raw) || raw.v !== 1) return null;
	if (!isNonEmptyString(raw.fileId)) return null;
	if (!isNonEmptyString(raw.posterFileId)) return null;
	if (!isPositiveWholeNumber(raw.width) || !isPositiveWholeNumber(raw.height)) {
		return null;
	}
	if (!isPositiveWholeNumber(raw.durationMs)) return null;
	const sourceFileId = parseSourceFileId(raw.sourceFileId);
	if (sourceFileId === undefined) return null;
	return {
		v: 1,
		fileId: raw.fileId,
		posterFileId: raw.posterFileId,
		width: raw.width,
		height: raw.height,
		durationMs: raw.durationMs,
		sourceFileId,
	};
}

/** Equal bodies give equal strings: the key order is this function's, not the caller's. */
export function serializeVideoVersionBody(body: VideoVersionBody): string {
	return JSON.stringify({
		v: 1,
		fileId: body.fileId,
		posterFileId: body.posterFileId,
		width: body.width,
		height: body.height,
		durationMs: body.durationMs,
		sourceFileId: body.sourceFileId,
	});
}
