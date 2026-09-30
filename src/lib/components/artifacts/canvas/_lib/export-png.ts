/**
 * A picture of the whole board as one PNG (Feature 2 · Artifacts, Slice 3, T7).
 * The board is a Svelte Flow viewport of positioned DOM, so the picture is a
 * clone of that DOM rendered by `html-to-image` — which is honest about
 * everything a clone can carry (text, shapes, marks, thumbnails, a chart's
 * bitmap) and blind to what it cannot (an App's sandboxed frame, the map's WebGL
 * canvas). Those blocks are drawn from their posters (`poster.ts`) and one with
 * none as a legible card, and the result NAMES every block that was drawn as a
 * card, so nothing is quietly an empty box.
 *
 * The order is the whole design, and the two things that must not outlive a
 * failed picture are undone in a `finally`: the camera goes back where the reader
 * had it, and every poster comes off the board. A picture that throws anywhere
 * leaves the board exactly as it was.
 *
 *  1. the bounds of everything on the board (blocks and marks), clamped to a
 *     picture between 800 x 600 and 2,400 x 1,800;
 *  2. the camera that fits those bounds into that size, the reader's own camera
 *     remembered first; one animation frame for the board to draw there;
 *  3. the posters mounted (a placeholder for a block with none);
 *  4. `toPng` on the viewport's own element, its transform overridden to the
 *     camera of step 2 and the reader's tools left out (`keepInPicture`);
 *  5. the camera restored and the posters unmounted, always;
 *  6. the picture sent to the server, which keeps it as a produced file.
 * Not part of the picture: comment pins and the catcher, the drawing tools' own
 * chrome, a block's anchors and resize corners (`poster.ts`'s list).
 */
import { toPng } from "html-to-image";
import { uploadCanvasImage } from "$lib/client/api/canvas-export";
import type { I18nKey } from "$lib/i18n";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import { annotationBounds } from "./annotations";
import { needsPoster } from "./block-meta";
import type { Rect } from "./board";
import {
	blockName,
	boardFonts,
	keepInPicture,
	posterOf,
	tokenColor,
} from "./poster";

/** The picture's size is the board's, held between these. */
export const EXPORT_MIN = { width: 800, height: 600 } as const;
export const EXPORT_MAX = { width: 2400, height: 1800 } as const;
/** The camera the picture is taken from: never further out than a fifth, never in past double. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
/** Room around the board's content, as a share of it. */
const PADDING = 0.1;

export type Camera = { x: number; y: number; zoom: number };

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** The smallest rectangle holding all of these, or null for none. */
export function unionRects(rects: readonly Rect[]): Rect | null {
	if (rects.length === 0) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const rect of rects) {
		minX = Math.min(minX, rect.x);
		minY = Math.min(minY, rect.y);
		maxX = Math.max(maxX, rect.x + rect.width);
		maxY = Math.max(maxY, rect.y + rect.height);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The picture's size for content of this size: the same, clamped to what a phone screen and a 4K display can both use. */
export function exportSize(bounds: Rect): { width: number; height: number } {
	return {
		width: clamp(Math.round(bounds.width), EXPORT_MIN.width, EXPORT_MAX.width),
		height: clamp(
			Math.round(bounds.height),
			EXPORT_MIN.height,
			EXPORT_MAX.height,
		),
	};
}

/** The camera that fits `bounds` into a picture of `size`, centred, with room around it (the library's own `getViewportForBounds`). */
export function cameraForBounds(
	bounds: Rect,
	size: { width: number; height: number },
): Camera {
	const zoom = clamp(
		Math.min(
			size.width / (bounds.width * (1 + PADDING)),
			size.height / (bounds.height * (1 + PADDING)),
		),
		MIN_ZOOM,
		MAX_ZOOM,
	);
	return {
		x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom,
		y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom,
		zoom,
	};
}

export type CanvasExportResult = {
	fileId: string;
	/** The stored file's name: what the browser saves the download as. */
	filename: string;
	width: number;
	height: number;
	/** Blocks drawn as a placeholder card because no poster existed. */
	missingPosters: { nodeId: string; title: string }[];
};

export class ExportError extends Error {
	constructor(
		/** `empty`: nothing on the board; `draw`: the picture could not be drawn; `upload`: it could not be kept (`uploadReason` says why). */
		readonly reason: "empty" | "draw" | "upload",
		readonly uploadReason?: string,
		cause?: unknown,
	) {
		super(`export: ${reason}`, cause === undefined ? undefined : { cause });
		this.name = "ExportError";
	}
}

export type ExportInput = {
	/** The board as drawn now: its blocks (with their posters, if they have them) and its marks. */
	body: CanvasBody;
	/** Every block's rectangle in board space as the panel measured it: a note has no stored height. */
	rects: readonly Rect[];
	artifactId: string;
	conversationId: string | null;
	/** The element to clone: the board's `.svelte-flow__viewport`. */
	viewportEl: HTMLElement;
	/** The library's camera, to set and to put back. */
	setViewport: (
		camera: Camera,
		options?: { duration: number },
	) => Promise<unknown> | unknown;
	getViewport: () => Camera;
	/** Draws each poster-needing block's poster in its place; `missing` are the ids that have none and are drawn as a card. */
	mountPosters: (missing: string[]) => Promise<void> | void;
	unmountPosters: () => void;
	translate: (key: I18nKey) => string;
	/** Test seams: the renderer, the frame clock and the upload. */
	toPng?: typeof toPng;
	nextFrame?: () => Promise<void>;
	upload?: typeof uploadCanvasImage;
};

function animationFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function exportBoardPng(
	input: ExportInput,
): Promise<CanvasExportResult> {
	const marks = input.body.annotations.map(annotationBounds);
	const bounds = unionRects([...input.rects, ...marks]);
	if (!bounds) throw new ExportError("empty");

	const missing = input.body.nodes.filter(
		(node) => needsPoster(node.type) && !posterOf(node.data),
	);
	const size = exportSize(bounds);
	const camera = cameraForBounds(bounds, size);
	const nextFrame = input.nextFrame ?? animationFrame;
	const remembered = { ...input.getViewport() };

	let dataUrl: string;
	try {
		await input.setViewport(camera, { duration: 0 });
		await nextFrame();
		await input.mountPosters(missing.map((node) => node.id));
		await nextFrame();
		dataUrl = await (input.toPng ?? toPng)(input.viewportEl, {
			width: size.width,
			height: size.height,
			pixelRatio: 1,
			backgroundColor: tokenColor("--surface-page", "#ffffff"),
			fontEmbedCSS: await boardFonts(input.viewportEl),
			filter: keepInPicture,
			includeQueryParams: true,
			skipAutoScale: true,
			style: {
				width: `${size.width}px`,
				height: `${size.height}px`,
				transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
			},
		});
	} catch (error) {
		throw new ExportError("draw", undefined, error);
	} finally {
		// Whatever happened above, the board goes back to how the reader had it.
		try {
			input.unmountPosters();
		} finally {
			await Promise.resolve(
				input.setViewport(remembered, { duration: 0 }),
			).catch(() => undefined);
		}
	}

	const stored = await (input.upload ?? uploadCanvasImage)({
		artifactId: input.artifactId,
		conversationId: input.conversationId,
		source: "canvas-export",
		dataUrl,
		width: size.width,
		height: size.height,
	});
	if (!stored.ok) throw new ExportError("upload", stored.reason);
	return {
		fileId: stored.fileId,
		filename: stored.filename,
		width: stored.width,
		height: stored.height,
		missingPosters: missing.map((node) => ({
			nodeId: node.id,
			title: blockName(node.data, input.translate),
		})),
	};
}
