/** A mark's box, relative to the element the marks are drawn in. */
export type Box = { left: number; top: number; width: number; height: number };

type Edges = { left: number; top: number; right: number; bottom: number };

/**
 * A range's client rects as one box per line: rects that overlap vertically by at least half
 * the smaller one's height are on one line, and on a line rects closer than `joinGapPx` are one
 * box (the spaces between words). Boxes are relative to `origin`; empty rects are skipped.
 */
export function lineBoxes(
	rects: readonly DOMRectReadOnly[],
	origin: DOMRectReadOnly,
	joinGapPx = 12,
): Box[] {
	const lines: Edges[][] = [];
	const sorted = rects
		.filter((rect) => rect.width > 0 && rect.height > 0)
		.map((rect) => ({
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
		}))
		.sort((a, b) => a.top - b.top || a.left - b.left);
	for (const rect of sorted) {
		const line = lines.find((candidate) =>
			candidate.some((other) => {
				const overlap =
					Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top);
				const height = Math.min(
					rect.bottom - rect.top,
					other.bottom - other.top,
				);
				return overlap >= height / 2;
			}),
		);
		if (line) line.push(rect);
		else lines.push([rect]);
	}
	const boxes: Box[] = [];
	for (const line of lines) {
		let current: Edges | null = null;
		for (const rect of [...line].sort((a, b) => a.left - b.left)) {
			if (current && rect.left - current.right <= joinGapPx) {
				current.right = Math.max(current.right, rect.right);
				current.top = Math.min(current.top, rect.top);
				current.bottom = Math.max(current.bottom, rect.bottom);
				continue;
			}
			if (current) boxes.push(toBox(current, origin));
			current = { ...rect };
		}
		if (current) boxes.push(toBox(current, origin));
	}
	return boxes;
}

function toBox(edges: Edges, origin: DOMRectReadOnly): Box {
	return {
		left: edges.left - origin.left,
		top: edges.top - origin.top,
		width: edges.right - edges.left,
		height: edges.bottom - edges.top,
	};
}
