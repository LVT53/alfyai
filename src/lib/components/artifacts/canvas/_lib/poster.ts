/**
 * The still image of a block (Feature 2 · Artifacts, Slice 3, T7), and what a
 * picture of the board leaves out of every block.
 *
 * A picture of the board is a clone of its DOM rendered by `html-to-image`, and a
 * clone has no second document and no bitmap of its own: an App's sandboxed frame,
 * the map's WebGL canvas and a lazily loaded thumbnail would ship as empty boxes,
 * and nobody would notice. So a block of those kinds carries a POSTER, a picture
 * of its own content taken while it is drawn in its still form (`BlockPicture`:
 * the live parts left out, what stands in for them said in words), stored as a
 * file and named in the block's data (`PosterRef`). The export puts it where the
 * live content was; a block with none is drawn as a legible card that says its
 * live version is not in the image (`posterPlaceholder`).
 *
 * Loaded with the export, never with the editor: it brings `html-to-image`, which
 * nothing on the board's first paint needs. Which kinds want a poster is the
 * registry's (`needsPoster` in `block-meta.ts`), so the editor can ask without
 * loading this.
 */
import { getFontEmbedCSS, toPng } from "html-to-image";
import { uploadCanvasImage } from "$lib/client/api/canvas-export";
import type { I18nKey } from "$lib/i18n";
import type {
	CanvasBlockData,
	PosterRef,
} from "$lib/shared/artifacts/canvas-blocks";

/** The poster a block's data names, if it has one (only the four kinds a poster is for carry the field). */
export function posterOf(data: CanvasBlockData): PosterRef | undefined {
	return (data as { poster?: PosterRef }).poster;
}

/** The box a poster is drawn to fit: file size against legibility, and the export upscales from it. */
export const POSTER_WIDTH = 640;
export const POSTER_HEIGHT = 400;
/** A small block is drawn no larger than twice its size, a large one no smaller than half. */
const MIN_RATIO = 0.5;
const MAX_RATIO = 2;
/** The most a poster's PNG may weigh before it is sent (the server's own cap, `POSTER_PNG_MAX_BYTES`, refuses more). */
const MAX_POSTER_BYTES = 1536 * 1024;

/**
 * What a picture of the board leaves out: the reader's tools and every other
 * layer that is not the board's own content. One list for a poster and for the
 * export, so a block never differs between the two.
 */
const LEFT_OUT = [
	// Marked by the component that draws it, wherever it sits.
	"[data-export-skip]",
	// The comment layer: its pins and the catcher of the Comment tool.
	".comment-pins",
	'[data-testid="canvas-comment-catcher"]',
	// Alfy's change: the rings and the frame that shows it arranging.
	'[data-testid="canvas-alfy-ring"]',
	'[data-testid="canvas-arranging-frame"]',
	// The drawing layer's own tools: the pad, the selection box, a mark under
	// the eraser, the field a text mark is typed in.
	'[data-testid="canvas-drawing-layer"]',
	"[data-annotation-chrome]",
	".mark--sweep",
	".annotation-text",
	// The library's chrome: a block's anchors and resize corners, the selection.
	".svelte-flow__handle",
	".svelte-flow__resize-control",
	".svelte-flow__nodesselection",
	".svelte-flow__selection",
].join(",");

/** `html-to-image`'s filter: false for a node that is the reader's tool rather than the board's content. */
export function keepInPicture(node: Node): boolean {
	if (!(node instanceof Element)) return true;
	return !node.matches(LEFT_OUT);
}

/** The scale a block's own content is drawn at so that it fits the poster box (never enlarged past twice, never shrunk under half). */
export function posterPixelRatio(width: number, height: number): number {
	if (!(width > 0) || !(height > 0)) return 1;
	const fit = Math.min(POSTER_WIDTH / width, POSTER_HEIGHT / height);
	return Math.min(MAX_RATIO, Math.max(MIN_RATIO, fit));
}

/**
 * What the export draws in place of a block that has no poster: its name and a
 * line saying the live version is not in the image. Never nothing.
 */
export function posterPlaceholder(
	data: CanvasBlockData,
	translate: (key: I18nKey) => string,
): { title: string; subtitle: string } {
	return {
		title: blockName(data, translate),
		subtitle: translate(
			STILL_NOTE[data.kind] ?? "artifacts.canvas.export.stillOther",
		),
	};
}

/** What a block is called on a placeholder and in the notice that names the blocks drawn as one. */
export function blockName(
	data: CanvasBlockData,
	translate: (key: I18nKey) => string,
): string {
	switch (data.kind) {
		case "app":
			return data.title || translate("artifacts.canvas.insert.app");
		case "map":
			return (
				data.label || data.route || translate("artifacts.canvas.insert.map")
			);
		case "liveweb":
			return data.query || translate("artifacts.canvas.insert.liveweb");
		case "photo":
			return translate("artifacts.canvas.insert.photo");
		default:
			return translate("artifacts.canvas.blockMissingKind");
	}
}

/** Why a block of each kind is a card and not the block: what is left out of the image is said, per kind, in words. */
const STILL_NOTE: Partial<Record<CanvasBlockData["kind"], I18nKey>> = {
	app: "artifacts.canvas.export.stillApp",
	map: "artifacts.canvas.export.stillMap",
	photo: "artifacts.canvas.export.stillPhoto",
	liveweb: "artifacts.canvas.export.stillWeb",
};

let embeddedFonts: Promise<string> | null = null;

/**
 * The web fonts the board is set in, as CSS `html-to-image` can put in a picture.
 * Read once and kept: scanning the page's style sheets for them is the slowest
 * part of a picture, and they do not change while the panel is open.
 */
export function boardFonts(element: HTMLElement): Promise<string> {
	embeddedFonts ??= getFontEmbedCSS(element).catch(() => "");
	return embeddedFonts;
}

/** A colour token as the page resolves it now, so a picture is drawn in whichever theme is showing. */
export function tokenColor(name: string, fallback: string): string {
	if (typeof document === "undefined") return fallback;
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	return value || fallback;
}

type PosterDeps = {
	toPng?: typeof toPng;
	fonts?: (element: HTMLElement) => Promise<string>;
	upload?: typeof uploadCanvasImage;
	now?: () => number;
};

export class PosterError extends Error {
	constructor(
		readonly reason: "render" | "too_large" | "upload",
		cause?: unknown,
	) {
		super(`poster: ${reason}`, cause === undefined ? undefined : { cause });
		this.name = "PosterError";
	}
}

/** Bytes a PNG data URL holds, without decoding it. */
function dataUrlBytes(dataUrl: string): number {
	const comma = dataUrl.indexOf(",");
	return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

/**
 * Draws one element (a block's own content, in its still form) as a PNG that fits
 * the poster box. A picture that comes out heavier than a poster may be is drawn
 * once more at half the scale before it is given up on.
 */
export async function renderPoster(
	element: HTMLElement,
	deps: PosterDeps = {},
): Promise<{ dataUrl: string; width: number; height: number }> {
	const draw = deps.toPng ?? toPng;
	const width = Math.max(1, element.offsetWidth);
	const height = Math.max(1, element.offsetHeight);
	const fontEmbedCSS = await (deps.fonts ?? boardFonts)(element);
	let ratio = posterPixelRatio(width, height);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let dataUrl: string;
		try {
			dataUrl = await draw(element, {
				width,
				height,
				pixelRatio: ratio,
				backgroundColor: tokenColor("--surface-elevated", "#ffffff"),
				filter: keepInPicture,
				fontEmbedCSS,
				includeQueryParams: true,
				skipAutoScale: true,
			});
		} catch (error) {
			throw new PosterError("render", error);
		}
		if (dataUrlBytes(dataUrl) <= MAX_POSTER_BYTES) {
			return {
				dataUrl,
				width: Math.round(width * ratio),
				height: Math.round(height * ratio),
			};
		}
		ratio /= 2;
	}
	throw new PosterError("too_large");
}

/**
 * Draws a block's content into a poster, keeps it on the server and returns the
 * reference to put in the block's data. Rejects (with a `PosterError`) when the
 * picture could not be drawn or kept, and nothing is left behind: a failed
 * capture is never a failed board.
 */
export async function capturePoster(
	input: {
		artifactId: string;
		conversationId: string | null;
		nodeId: string;
		element: HTMLElement;
	},
	deps: PosterDeps = {},
): Promise<PosterRef> {
	const picture = await renderPoster(input.element, deps);
	const stored = await (deps.upload ?? uploadCanvasImage)({
		artifactId: input.artifactId,
		conversationId: input.conversationId,
		source: "canvas-poster",
		nodeId: input.nodeId,
		dataUrl: picture.dataUrl,
		width: picture.width,
		height: picture.height,
	});
	if (!stored.ok) throw new PosterError("upload");
	return {
		fileId: stored.fileId,
		width: stored.width,
		height: stored.height,
		capturedAt: (deps.now ?? Date.now)(),
	};
}
