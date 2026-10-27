/**
 * The Image kind's version body (Feature: pictures, design 5.3). A version of
 * an Image is a small JSON string that POINTS at its picture: the picture's
 * bytes live in `images/files.ts`'s folder, never in the row. The browser and
 * the server read one shape through the parser here.
 *
 * Browser-safe: no imports. A mark's box is a fraction of the picture, so the
 * panel's overlay and the server's painter use the same numbers.
 */

/**
 * The long edge of a picture's thumbnail (`?variant=thumb`), in pixels. The
 * server makes it; the card's `srcset` names its width from it.
 */
export const IMAGE_THUMB_LONG_EDGE = 320;

/** The width of a picture's thumbnail: never wider than the picture itself. */
export function thumbWidth(width: number, height: number): number {
	const longEdge = Math.max(width, height);
	if (longEdge <= IMAGE_THUMB_LONG_EDGE) return width;
	return Math.max(1, Math.round((width * IMAGE_THUMB_LONG_EDGE) / longEdge));
}

const MARK_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type MarkLetter = (typeof MARK_LETTERS)[number];
const MAX_MARKS = 8;

/** A boxed area of the picture, in fractions of its width and height. */
export type ImageMark = {
	letter: MarkLetter;
	x: number;
	y: number;
	w: number;
	h: number;
};

/** The eight mark colours are data: one constant shared by the panel and the server painter. */
export const MARK_COLOURS: Record<MarkLetter, string> = {
	A: "#E53935",
	B: "#1E88E5",
	C: "#43A047",
	D: "#FB8C00",
	E: "#8E24AA",
	F: "#00ACC1",
	G: "#D81B60",
	H: "#6D4C41",
};

export const MARK_COLOUR_NAMES: Record<MarkLetter, string> = {
	A: "red",
	B: "blue",
	C: "green",
	D: "orange",
	E: "purple",
	F: "cyan",
	G: "pink",
	H: "brown",
};

/** The smallest box side that is still a mark, as a fraction. */
const MIN_MARK_SIDE = 0.02;
/** Float noise from a drawn box is not a box past the edge. */
const EDGE_TOLERANCE = 1e-6;

export type ImageVersionBody = {
	v: 1;
	fileId: string;
	width: number;
	height: number;
	hasAlpha: boolean;
	/** The picture this one was made from (null for a first picture). */
	baseFileId: string | null;
	/** The pictures that rode along as references, with the names the person knows them by. */
	sources: Array<{ fileId: string; name: string }>;
	marks: ImageMark[] | null;
	prompt: string | null;
	takeId: string | null;
	seed: number | null;
	anchorFileId: string | null;
	chainSinceAnchor: number;
};

/** A picture a message or a tool call names: the file and the number the model sees it under. */
export type PictureRef = { imageFileId: string; number: number };
/** Marks the person drew on one picture, sent with a message. */
export type ImageMarksRequest = { imageFileId: string; marks: ImageMark[] };

/**
 * What a user message keeps of the pictures it carried besides its uploads
 * (`ChatMessage.pictures`): which card pictures were attached under which
 * number, which picture was open in the panel, and which letters the person
 * marked on which picture (with the marked copy that was made). Ids and names
 * only, never pixels: a later turn's history reads it as short lines.
 */
export type UserPicturesMetadata = {
	/** `open: true` marks an attached picture that is also the one open in the panel (recorded once). */
	refs: Array<{
		imageFileId: string;
		number: number;
		name: string;
		open?: true;
	}>;
	/**
	 * The uploads of the message under the numbers the model saw (they fill the
	 * numbers the refs left free, so only the server knows them). Absent in
	 * records from before this existed.
	 */
	uploads?: Array<{ artifactId: string; number: number }>;
	/** The open picture when it was not also attached. */
	open: { imageFileId: string; name: string } | null;
	marks: {
		imageFileId: string;
		markedFileId: string;
		letters: MarkLetter[];
		/** The boxes, so a regenerated turn can paint the marked copy again. */
		boxes?: ImageMark[];
	} | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isLetter(value: unknown): value is MarkLetter {
	return (
		typeof value === "string" &&
		(MARK_LETTERS as readonly string[]).includes(value)
	);
}

function isFraction(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Marks as a client or a model sent them, or `null` when they cannot stand:
 * a repeated letter, a box thinner than 2 %, a box past the picture's edge,
 * or more than eight of them. Never throws.
 */
export function parseImageMarks(value: unknown): ImageMark[] | null {
	if (!Array.isArray(value) || value.length > MAX_MARKS) return null;
	const seen = new Set<string>();
	const marks: ImageMark[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return null;
		const { letter, x, y, w, h } = entry;
		if (!isLetter(letter) || seen.has(letter)) return null;
		if (!isFraction(x) || !isFraction(y) || !isFraction(w) || !isFraction(h)) {
			return null;
		}
		if (x < 0 || y < 0 || w < MIN_MARK_SIDE || h < MIN_MARK_SIDE) return null;
		if (x + w > 1 + EDGE_TOLERANCE || y + h > 1 + EDGE_TOLERANCE) return null;
		seen.add(letter);
		marks.push({ letter, x, y, w, h });
	}
	return marks;
}

function parseSources(
	value: unknown,
): Array<{ fileId: string; name: string }> | null {
	if (!Array.isArray(value)) return null;
	const sources: Array<{ fileId: string; name: string }> = [];
	for (const entry of value) {
		if (!isRecord(entry)) return null;
		if (!isNonEmptyString(entry.fileId) || typeof entry.name !== "string") {
			return null;
		}
		sources.push({ fileId: entry.fileId, name: entry.name });
	}
	return sources;
}

function nullableString(value: unknown): string | null | undefined {
	if (value === null || value === undefined) return null;
	return typeof value === "string" ? value : undefined;
}

/**
 * The pictures a stored user message kept, or `undefined` when there is
 * nothing usable: a record from before this existed, or one that is malformed
 * reads as "carried none" and never reaches the page half-shaped.
 */
export function parseUserPictures(
	value: unknown,
): UserPicturesMetadata | undefined {
	if (!isRecord(value) || !Array.isArray(value.refs)) return undefined;
	const refs: UserPicturesMetadata["refs"] = [];
	for (const ref of value.refs) {
		if (
			!isRecord(ref) ||
			!isNonEmptyString(ref.imageFileId) ||
			typeof ref.number !== "number" ||
			!Number.isInteger(ref.number) ||
			typeof ref.name !== "string"
		) {
			return undefined;
		}
		refs.push({
			imageFileId: ref.imageFileId,
			number: ref.number,
			name: ref.name,
			...(ref.open === true ? { open: true as const } : {}),
		});
	}
	// Optional and best-effort: an older record has none, a malformed list is dropped.
	let uploads: NonNullable<UserPicturesMetadata["uploads"]> | undefined;
	if (Array.isArray(value.uploads)) {
		const parsed: NonNullable<UserPicturesMetadata["uploads"]> = [];
		for (const upload of value.uploads) {
			if (
				!isRecord(upload) ||
				!isNonEmptyString(upload.artifactId) ||
				typeof upload.number !== "number" ||
				!Number.isInteger(upload.number)
			) {
				parsed.length = 0;
				break;
			}
			parsed.push({ artifactId: upload.artifactId, number: upload.number });
		}
		if (parsed.length > 0) uploads = parsed;
	}
	let open: UserPicturesMetadata["open"] = null;
	if (value.open != null) {
		if (
			!isRecord(value.open) ||
			!isNonEmptyString(value.open.imageFileId) ||
			typeof value.open.name !== "string"
		) {
			return undefined;
		}
		open = { imageFileId: value.open.imageFileId, name: value.open.name };
	}
	let marks: UserPicturesMetadata["marks"] = null;
	if (value.marks != null) {
		const raw = value.marks;
		if (
			!isRecord(raw) ||
			!isNonEmptyString(raw.imageFileId) ||
			!isNonEmptyString(raw.markedFileId) ||
			!Array.isArray(raw.letters) ||
			!raw.letters.every(isLetter)
		) {
			return undefined;
		}
		const boxes =
			raw.boxes === undefined ? undefined : parseImageMarks(raw.boxes);
		marks = {
			imageFileId: raw.imageFileId,
			markedFileId: raw.markedFileId,
			letters: raw.letters,
			...(boxes ? { boxes } : {}),
		};
	}
	if (refs.length === 0 && !open && !marks) return undefined;
	return { refs, ...(uploads ? { uploads } : {}), open, marks };
}

/** The body a stored string holds, or `null` when it is not a version-1 image body. Never throws. */
export function parseImageVersionBody(
	stored: string | null,
): ImageVersionBody | null {
	if (!stored) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(stored);
	} catch {
		return null;
	}
	if (!isRecord(raw) || raw.v !== 1) return null;
	if (!isNonEmptyString(raw.fileId)) return null;
	const { width, height } = raw;
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return null;
	}
	const sources = parseSources(raw.sources ?? []);
	if (!sources) return null;
	let marks: ImageMark[] | null = null;
	if (raw.marks !== null && raw.marks !== undefined) {
		marks = parseImageMarks(raw.marks);
		if (!marks) return null;
	}
	const baseFileId = nullableString(raw.baseFileId);
	const prompt = nullableString(raw.prompt);
	const takeId = nullableString(raw.takeId);
	const anchorFileId = nullableString(raw.anchorFileId);
	if (
		baseFileId === undefined ||
		prompt === undefined ||
		takeId === undefined ||
		anchorFileId === undefined
	) {
		return null;
	}
	const seed =
		typeof raw.seed === "number" && Number.isFinite(raw.seed) ? raw.seed : null;
	const chain = raw.chainSinceAnchor;
	return {
		v: 1,
		fileId: raw.fileId,
		width,
		height,
		hasAlpha: raw.hasAlpha === true,
		baseFileId,
		sources,
		marks,
		prompt,
		takeId,
		seed,
		anchorFileId,
		chainSinceAnchor:
			typeof chain === "number" && Number.isInteger(chain) && chain >= 0
				? chain
				: 0,
	};
}

/** Equal bodies give equal strings: the key order is this function's, not the caller's. */
export function serializeImageVersionBody(body: ImageVersionBody): string {
	return JSON.stringify({
		v: 1,
		fileId: body.fileId,
		width: body.width,
		height: body.height,
		hasAlpha: body.hasAlpha,
		baseFileId: body.baseFileId,
		sources: body.sources.map((source) => ({
			fileId: source.fileId,
			name: source.name,
		})),
		marks: body.marks
			? body.marks.map((mark) => ({
					letter: mark.letter,
					x: mark.x,
					y: mark.y,
					w: mark.w,
					h: mark.h,
				}))
			: null,
		prompt: body.prompt,
		takeId: body.takeId,
		seed: body.seed,
		anchorFileId: body.anchorFileId,
		chainSinceAnchor: body.chainSinceAnchor,
	});
}
