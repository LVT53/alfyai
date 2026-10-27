// The person's marks, drawn onto a copy of the picture: boxes with a letter tag
// in each box's colour, so the model that is shown the copy (and the picture
// server that is given it) sees the same "A", "B" the person wrote about. The
// colours are the shared constant the panel's overlay draws with. The letters
// are strokes on a 5x7 grid, never text, so the painter needs no font installed.
import sharp from "sharp";
import {
	type ImageMark,
	MARK_COLOUR_NAMES,
	MARK_COLOURS,
	type MarkLetter,
} from "$lib/shared/artifacts/image-body";

/** Box stroke width: 0.6 % of the long side, at least 4 px. */
const STROKE_FRACTION = 0.006;
const MIN_STROKE = 4;
/** Letter tag side: 3.5 % of the long side, at least 28 px. */
const TAG_FRACTION = 0.035;
const MIN_TAG = 28;

type Point = readonly [number, number];

/** Each letter as polylines on a 5 wide, 7 tall grid (x 0..4, y 0..6). */
const LETTER_STROKES: Record<MarkLetter, readonly (readonly Point[])[]> = {
	A: [
		[
			[0, 6],
			[0, 2],
			[2, 0],
			[4, 2],
			[4, 6],
		],
		[
			[0, 3],
			[4, 3],
		],
	],
	B: [
		[
			[0, 0],
			[0, 6],
		],
		[
			[0, 0],
			[3, 0],
			[4, 1],
			[4, 2],
			[3, 3],
			[0, 3],
		],
		[
			[3, 3],
			[4, 4],
			[4, 5],
			[3, 6],
			[0, 6],
		],
	],
	C: [
		[
			[4, 1],
			[3, 0],
			[1, 0],
			[0, 1],
			[0, 5],
			[1, 6],
			[3, 6],
			[4, 5],
		],
	],
	D: [
		[
			[0, 0],
			[0, 6],
		],
		[
			[0, 0],
			[2, 0],
			[4, 2],
			[4, 4],
			[2, 6],
			[0, 6],
		],
	],
	E: [
		[
			[4, 0],
			[0, 0],
			[0, 6],
			[4, 6],
		],
		[
			[0, 3],
			[3, 3],
		],
	],
	F: [
		[
			[4, 0],
			[0, 0],
			[0, 6],
		],
		[
			[0, 3],
			[3, 3],
		],
	],
	G: [
		[
			[4, 1],
			[3, 0],
			[1, 0],
			[0, 1],
			[0, 5],
			[1, 6],
			[3, 6],
			[4, 5],
			[4, 3],
			[2, 3],
		],
	],
	H: [
		[
			[0, 0],
			[0, 6],
		],
		[
			[4, 0],
			[4, 6],
		],
		[
			[0, 3],
			[4, 3],
		],
	],
};

function letterPath(
	letter: MarkLetter,
	left: number,
	top: number,
	tag: number,
) {
	const pad = tag * 0.2;
	const cell = (tag - 2 * pad) / 6;
	const originX = left + (tag - cell * 4) / 2;
	const originY = top + pad;
	return LETTER_STROKES[letter]
		.map((line) =>
			line
				.map(
					([x, y], index) =>
						`${index === 0 ? "M" : "L"}${(originX + x * cell).toFixed(2)} ${(originY + y * cell).toFixed(2)}`,
				)
				.join(" "),
		)
		.join(" ");
}

function marksSvg(width: number, height: number, marks: readonly ImageMark[]) {
	const long = Math.max(width, height);
	const stroke = Math.max(MIN_STROKE, Math.round(STROKE_FRACTION * long));
	const tag = Math.max(MIN_TAG, Math.round(TAG_FRACTION * long));
	const shapes = marks.map((mark) => {
		const colour = MARK_COLOURS[mark.letter];
		const left = Math.round(mark.x * width);
		const top = Math.round(mark.y * height);
		const right = Math.round((mark.x + mark.w) * width);
		const bottom = Math.round((mark.y + mark.h) * height);
		// The stroke sits inside the box's edge: its outer side is the box.
		const inset = stroke / 2;
		const box = `<rect x="${left + inset}" y="${top + inset}" width="${Math.max(1, right - left - stroke)}" height="${Math.max(1, bottom - top - stroke)}" fill="none" stroke="${colour}" stroke-width="${stroke}"/>`;
		const tagRect = `<rect x="${left}" y="${top}" width="${tag}" height="${tag}" fill="${colour}"/>`;
		const letter = `<path d="${letterPath(mark.letter, left, top, tag)}" fill="none" stroke="#FFFFFF" stroke-width="${Math.max(2, Math.round(tag * 0.09))}" stroke-linecap="round" stroke-linejoin="round"/>`;
		return box + tagRect + letter;
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes.join("")}</svg>`;
}

/**
 * A copy of the picture with the marks drawn on it. Pixels outside the boxes
 * and tags are the input's own. A PNG out, whatever the input kept.
 */
export async function paintMarks(
	png: Uint8Array,
	marks: readonly ImageMark[],
): Promise<Buffer> {
	const meta = await sharp(png).metadata();
	if (!meta.width || !meta.height) {
		throw new Error("The picture has no size.");
	}
	const svg = marksSvg(meta.width, meta.height, marks);
	return sharp(png)
		.composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
		.png()
		.toBuffer();
}

/**
 * The marked copy's label in the model's words: "Picture 3 with the user's
 * marks: A = red box, B = blue box". English whatever the person writes: it is
 * scaffolding the model reads (ruling 79).
 */
export function marksLabel(
	baseNumber: number,
	marks: readonly ImageMark[],
): string {
	return `Picture ${baseNumber} with the user's marks: ${marks
		.map((mark) => `${mark.letter} = ${MARK_COLOUR_NAMES[mark.letter]} box`)
		.join(", ")}`;
}
