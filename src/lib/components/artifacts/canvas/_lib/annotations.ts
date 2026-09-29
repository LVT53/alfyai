/**
 * The marks a reader draws on a board, as data and geometry — no component, no
 * pointer, so it is tested without a browser.
 *
 * Everything here is in BOARD coordinates: a stroke drawn at 100 % stays glued to
 * what it was drawn on at any zoom, and the PNG export (which clones the
 * viewport) gets the strokes for free.
 *
 * Undo and redo do not live here. A board has ONE in-session history of the
 * reader's own steps (`board-history.ts`, ruling 16): a stroke, a move and an
 * erase are each one step in it, next to a dragged block or a typed note, and
 * Alfy's changes and an earlier session's are a version restore through History,
 * not this. Comments are never in it: they are not part of a body (ruling 1).
 */
import { getStroke } from "perfect-freehand";
import {
	ANNOTATION_KINDS,
	type Annotation,
	type AnnotationKind,
	type Pt,
} from "$lib/shared/artifacts/canvas";

/** The seven kinds of mark a reader can draw. */
export type DrawingTool = AnnotationKind;
/** What the toolbar's pointer does: move around, draw one of the seven, or erase. */
export type Tool = "select" | "pan" | "eraser" | DrawingTool;

export const DRAWING_TOOLS: readonly DrawingTool[] = ANNOTATION_KINDS;

export function isDrawingTool(tool: Tool): tool is DrawingTool {
	return (DRAWING_TOOLS as readonly string[]).includes(tool);
}

/**
 * The four inks. A mark stores the CSS variable, not a hex, so it is drawn in the
 * ink of whichever theme is showing (a blue that reads on paper is not a blue
 * that reads on the dark surface). A hex from an older or foreign board draws as
 * itself.
 */
export const INKS = [
	{ id: "blue", color: "var(--ink-blue)" },
	{ id: "red", color: "var(--ink-red)" },
	{ id: "green", color: "var(--ink-green)" },
	{ id: "graphite", color: "var(--ink-graphite)" },
] as const;

export const DEFAULT_INK: string = INKS[0].color;

/** The stroke width of a mark (a text's is its font size), in board units. */
const BASE_SIZE: Record<DrawingTool, number> = {
	pen: 4,
	highlighter: 14,
	line: 3,
	arrow: 3,
	rect: 3,
	ellipse: 3,
	text: 20,
};

export function baseSize(tool: DrawingTool): number {
	return BASE_SIZE[tool];
}

// ---- Geometry: the paths a mark is drawn with -----------------------------

function fmt(n: number): string {
	return String(Math.round(n * 100) / 100);
}

/** A filled disc: what a click with the pen leaves. */
export function dabPath(at: Pt, size: number): string {
	const r = Math.max(size, 1) / 2;
	return `M ${fmt(at.x - r)} ${fmt(at.y)} a ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(r * 2)} 0 a ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-r * 2)} 0 Z`;
}

/** A stadium between two points: a stroke too short for the library to outline is still a mark. */
function capsulePath(a: Pt, b: Pt, size: number): string {
	const r = Math.max(size, 1) / 2;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy);
	if (length === 0) return dabPath(a, size);
	const nx = (-dy / length) * r;
	const ny = (dx / length) * r;
	return [
		`M ${fmt(a.x + nx)} ${fmt(a.y + ny)}`,
		`L ${fmt(b.x + nx)} ${fmt(b.y + ny)}`,
		`A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(b.x - nx)} ${fmt(b.y - ny)}`,
		`L ${fmt(a.x - nx)} ${fmt(a.y - ny)}`,
		`A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(a.x + nx)} ${fmt(a.y + ny)}`,
		"Z",
	].join(" ");
}

/**
 * The outline of a freehand stroke as an SVG path: `perfect-freehand` with a
 * velocity-simulated pressure (never a device's: the same board must draw the
 * same under a mouse and under synthetic pointer events), streamlined. The
 * highlighter is the same geometry with no thinning, so it keeps one width.
 * When the library cannot outline what it was given, a single point is a dab and
 * anything longer is a capsule from its first point to its last.
 */
export function strokePath(
	points: readonly Pt[],
	size: number,
	thinning = 0.5,
): string {
	if (points.length === 0) return "";
	const outline = getStroke(
		points.map((p) => [p.x, p.y]),
		// `last`: the stroke is drawn as if complete, so it reaches the point the
		// pointer reached and a drag that ends does not jump when it is let go.
		{
			size,
			thinning,
			smoothing: 0.5,
			streamline: 0.5,
			simulatePressure: true,
			last: true,
		},
	);
	if (outline.length < 3) {
		return points.length === 1
			? dabPath(points[0], size)
			: capsulePath(points[0], points[points.length - 1], size);
	}
	const path: (string | number)[] = ["M", ...outline[0].map(fmt), "Q"];
	for (let i = 0; i < outline.length; i += 1) {
		const [x0, y0] = outline[i];
		const [x1, y1] = outline[(i + 1) % outline.length];
		path.push(fmt(x0), fmt(y0), fmt((x0 + x1) / 2), fmt((y0 + y1) / 2));
	}
	path.push("Z");
	return path.join(" ");
}

/**
 * The head of an arrow: a triangle whose tip is `to`. It grows with the ink but
 * never past 40 % of a short arrow, so a small arrow is still an arrow. Empty for
 * an arrow with no length: there is nothing to point along.
 */
export function arrowHead(from: Pt, to: Pt, size: number): string {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length === 0) return "";
	const head = Math.min(Math.max(size * 4, 10), length * 0.4);
	const ux = dx / length;
	const uy = dy / length;
	const bx = to.x - ux * head;
	const by = to.y - uy * head;
	const wx = -uy * head * 0.45;
	const wy = ux * head * 0.45;
	return `M ${fmt(to.x)} ${fmt(to.y)} L ${fmt(bx + wx)} ${fmt(by + wy)} L ${fmt(bx - wx)} ${fmt(by - wy)} Z`;
}

/** Two opposite corners as a rectangle, whichever way the drag went. */
export function normRect(
	a: Pt,
	b: Pt,
): { x: number; y: number; width: number; height: number } {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		width: Math.abs(a.x - b.x),
		height: Math.abs(a.y - b.y),
	};
}

/** How wide a line of text is, estimated (a pure module cannot measure glyphs): good enough to box it and to hit it. */
export function textWidth(text: string, size: number): number {
	return Array.from(text).length * size * 0.56;
}

export function annotationBounds(a: Annotation): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	const pad = a.size / 2;
	let box: { x: number; y: number; width: number; height: number };
	if (a.kind === "text") {
		const at = a.at ?? { x: 0, y: 0 };
		return {
			x: at.x,
			y: at.y,
			width: textWidth(a.text ?? "", a.size),
			height: a.size * 1.3,
		};
	}
	if (a.kind === "pen" || a.kind === "highlighter") {
		const points = a.points?.length ? a.points : [{ x: 0, y: 0 }];
		const xs = points.map((p) => p.x);
		const ys = points.map((p) => p.y);
		box = normRect(
			{ x: Math.min(...xs), y: Math.min(...ys) },
			{ x: Math.max(...xs), y: Math.max(...ys) },
		);
	} else {
		box = normRect(a.from ?? { x: 0, y: 0 }, a.to ?? { x: 0, y: 0 });
	}
	return {
		x: box.x - pad,
		y: box.y - pad,
		width: box.width + pad * 2,
		height: box.height + pad * 2,
	};
}

// ---- Picking ---------------------------------------------------------------

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
	const t = Math.max(
		0,
		Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared),
	);
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insideRect(
	p: Pt,
	r: { x: number; y: number; width: number; height: number },
): boolean {
	return (
		r.width >= 0 &&
		r.height >= 0 &&
		p.x >= r.x &&
		p.x <= r.x + r.width &&
		p.y >= r.y &&
		p.y <= r.y + r.height
	);
}

/**
 * Whether `p` is on the mark, within `tolerance` board units of what is drawn: a
 * rectangle or ellipse is hit on its outline and not its middle (so a shape
 * drawn around a block does not swallow the block), a stroke or a line along its
 * path, a text anywhere in its box.
 */
export function hitTest(a: Annotation, p: Pt, tolerance: number): boolean {
	const reach = tolerance + a.size / 2;
	switch (a.kind) {
		case "pen":
		case "highlighter": {
			const points = a.points ?? [];
			if (points.length === 1) {
				return Math.hypot(p.x - points[0].x, p.y - points[0].y) <= reach;
			}
			for (let i = 1; i < points.length; i += 1) {
				if (distanceToSegment(p, points[i - 1], points[i]) <= reach)
					return true;
			}
			return false;
		}
		case "line":
		case "arrow":
			return a.from && a.to
				? distanceToSegment(p, a.from, a.to) <= reach
				: false;
		case "rect": {
			if (!a.from || !a.to) return false;
			const r = normRect(a.from, a.to);
			const outer = {
				x: r.x - reach,
				y: r.y - reach,
				width: r.width + reach * 2,
				height: r.height + reach * 2,
			};
			const inner = {
				x: r.x + reach,
				y: r.y + reach,
				width: r.width - reach * 2,
				height: r.height - reach * 2,
			};
			return insideRect(p, outer) && !insideRect(p, inner);
		}
		case "ellipse": {
			if (!a.from || !a.to) return false;
			const r = normRect(a.from, a.to);
			const rx = Math.max(r.width / 2, 0.5);
			const ry = Math.max(r.height / 2, 0.5);
			const f = Math.hypot((p.x - (r.x + rx)) / rx, (p.y - (r.y + ry)) / ry);
			return Math.abs(f - 1) * Math.min(rx, ry) <= reach;
		}
		case "text": {
			const b = annotationBounds(a);
			return insideRect(p, {
				x: b.x - tolerance,
				y: b.y - tolerance,
				width: b.width + tolerance * 2,
				height: b.height + tolerance * 2,
			});
		}
	}
}

/** The newest mark under `p` (a later one is drawn above an earlier one), or null. */
export function pickAnnotation(
	list: readonly Annotation[],
	p: Pt,
	tolerance: number,
): Annotation | null {
	for (let i = list.length - 1; i >= 0; i -= 1) {
		if (hitTest(list[i], p, tolerance)) return list[i];
	}
	return null;
}

/** The same mark, moved: a stroke, a shape and a text all carry their position differently, and all move. */
export function translate(a: Annotation, dx: number, dy: number): Annotation {
	const move = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
	return {
		...a,
		...(a.points ? { points: a.points.map(move) } : {}),
		...(a.from ? { from: move(a.from) } : {}),
		...(a.to ? { to: move(a.to) } : {}),
		...(a.at ? { at: move(a.at) } : {}),
	};
}
