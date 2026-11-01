/**
 * The geometry of the person's marks on the open picture (plan 2b T6). Pure:
 * `MarkLayer.svelte` measures the picture's own rectangle and asks these for
 * the box a drag drew, the letter it gets and the box a tap is on. A box is a
 * fraction of the picture's width and height, the numbers the server's painter
 * reads (`images/marks.ts`), so the smallest side is the parser's own rule.
 */
import {
	type ImageMark,
	MARK_LETTERS,
	MAX_MARKS,
	type MarkLetter,
	MIN_MARK_SIDE,
} from "$lib/shared/artifacts/image-body";

export type Point = { x: number; y: number };
export type MarkBox = { x: number; y: number; w: number; h: number };

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

/**
 * The box between two points of a drag, in fractions of the frame, clamped to
 * it (a drag past the edge stops at the edge). The points are in the frame's
 * own pixels from its top-left corner. No size check: the box being drawn.
 */
export function dragBox(
	start: Point,
	end: Point,
	frame: { width: number; height: number },
): MarkBox | null {
	if (frame.width <= 0 || frame.height <= 0) return null;
	const left = clamp(Math.min(start.x, end.x), frame.width);
	const right = clamp(Math.max(start.x, end.x), frame.width);
	const top = clamp(Math.min(start.y, end.y), frame.height);
	const bottom = clamp(Math.max(start.y, end.y), frame.height);
	return {
		x: left / frame.width,
		y: top / frame.height,
		w: (right - left) / frame.width,
		h: (bottom - top) / frame.height,
	};
}

/** The mark a drag drew, or `null` when a side is under `MIN_MARK_SIDE` (a slip, not a box). */
export function boxFromDrag(
	start: Point,
	end: Point,
	frame: { width: number; height: number },
): MarkBox | null {
	const box = dragBox(start, end, frame);
	if (!box || box.w < MIN_MARK_SIDE || box.h < MIN_MARK_SIDE) return null;
	return box;
}

/** The first letter no mark uses, or `null` once there are eight. */
export function nextLetter(marks: readonly ImageMark[]): MarkLetter | null {
	if (marks.length >= MAX_MARKS) return null;
	const used = new Set(marks.map((mark) => mark.letter));
	return MARK_LETTERS.find((letter) => !used.has(letter)) ?? null;
}

/** The last-drawn mark under a point (in fractions), or `null`. */
export function hitMark(
	point: Point,
	marks: readonly ImageMark[],
): MarkLetter | null {
	for (let index = marks.length - 1; index >= 0; index--) {
		const mark = marks[index];
		if (
			point.x >= mark.x &&
			point.x <= mark.x + mark.w &&
			point.y >= mark.y &&
			point.y <= mark.y + mark.h
		) {
			return mark.letter;
		}
	}
	return null;
}

/** The line over the picture while Mark is on: the limit, what to do next, or how to start. */
export function markNoteKey(state: {
	refused: boolean;
	marking: boolean;
	count: number;
	isPhone: boolean;
}):
	| "artifacts.image.panel.tooManyMarks"
	| "artifacts.image.panel.markHint"
	| "artifacts.image.panel.markedPhone"
	| "artifacts.image.panel.markedDesktop"
	| null {
	if (state.refused) return "artifacts.image.panel.tooManyMarks";
	if (!state.marking) return null;
	if (state.count === 0) return "artifacts.image.panel.markHint";
	return state.isPhone
		? "artifacts.image.panel.markedPhone"
		: "artifacts.image.panel.markedDesktop";
}
