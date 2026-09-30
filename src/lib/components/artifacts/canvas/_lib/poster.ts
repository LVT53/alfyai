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
/** A picture that has not come out after this long is given up on: one that hangs must not hold the board. */
const POSTER_DRAW_TIMEOUT_MS = 20_000;

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
	// Alfy's change: its layer (the rings, the frame that shows it arranging, the pill).
	'[data-testid="alfy-change-layer"]',
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

/** A short line of text in the card that stands where a block's live content was: inline styles only, because it is drawn into a picture. */
function stillCard(title: string, note: string): HTMLElement {
	const card = document.createElement("div");
	card.style.cssText =
		"display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;width:100%;height:100%;min-height:120px;padding:12px;text-align:center;background:var(--surface-elevated);color:var(--text-muted);font-family:var(--font-sans);font-size:var(--text-xs)";
	const heading = document.createElement("b");
	heading.textContent = title;
	heading.style.cssText =
		"max-width:100%;overflow:hidden;color:var(--text-primary);font-size:var(--text-sm);text-overflow:ellipsis;white-space:nowrap";
	const line = document.createElement("span");
	line.textContent = note;
	card.append(heading, line);
	return card;
}

/**
 * Turns a copy of a block's content into the form a picture can carry, without
 * touching the block on the board: whatever is live is taken out (frames,
 * bitmaps), what a picture cannot show is said in words in its place, and the
 * thumbnails a browser would load only when scrolled to are loaded now. It works
 * on a detached copy, so the reader never sees a block flicker into its still
 * form and an App's frame is never reloaded.
 */
export function stillify(
	copy: HTMLElement,
	data: CanvasBlockData,
	translate: (key: I18nKey) => string,
): void {
	for (const live of copy.querySelectorAll("iframe, canvas, video, script")) {
		live.remove();
	}
	for (const image of copy.querySelectorAll("img")) image.loading = "eager";
	if (data.kind === "app") {
		const frame = copy.querySelector('[data-testid="canvas-app"]') ?? copy;
		const { title, subtitle } = posterPlaceholder(data, translate);
		frame.replaceChildren(stillCard(title, subtitle));
	}
	if (data.kind === "map") {
		// The card's own inline route drawing is what a picture can carry: it is
		// always there, and hidden on screen only while the live map is up. The live
		// map (its markers are page elements over a bitmap) is not part of the still.
		copy.querySelector(".map-route-card__map")?.remove();
		copy
			.querySelector(".map-route-card__fallback--screen-hidden")
			?.classList.remove("map-route-card__fallback--screen-hidden");
		const body = copy.querySelector(".map-route-card__body");
		if (body) {
			const badge = document.createElement("span");
			badge.textContent = translate("artifacts.canvas.mapNotLive");
			badge.style.cssText =
				"position:absolute;top:6px;left:6px;padding:1px 6px;border-radius:999px;background:var(--surface-page);border:1px solid var(--border-default);color:var(--text-muted);font-family:var(--font-sans);font-size:var(--text-2xs)";
			body.append(badge);
		}
	}
}

/** Resolves when every image in `root` has loaded (or failed), or after `timeoutMs`: a poster is drawn with what arrived. */
export function imagesSettled(
	root: ParentNode,
	timeoutMs = 3000,
): Promise<void> {
	const pending = [...root.querySelectorAll("img")].filter(
		(image) => !image.complete,
	);
	if (pending.length === 0) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => resolve();
		const timer = setTimeout(done, timeoutMs);
		let left = pending.length;
		for (const image of pending) {
			const settle = () => {
				left -= 1;
				if (left === 0) {
					clearTimeout(timer);
					done();
				}
			};
			image.addEventListener("load", settle, { once: true });
			image.addEventListener("error", settle, { once: true });
		}
	});
}

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
	drawTimeoutMs?: number;
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

/** Rejects with `error()` when `promise` has not settled in `ms`. */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	error: () => Error,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(error()), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(reason) => {
				clearTimeout(timer);
				reject(reason);
			},
		);
	});
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
			dataUrl = await withTimeout(
				draw(element, {
					width,
					height,
					pixelRatio: ratio,
					backgroundColor: tokenColor("--surface-elevated", "#ffffff"),
					filter: keepInPicture,
					fontEmbedCSS,
					includeQueryParams: true,
					skipAutoScale: true,
				}),
				deps.drawTimeoutMs ?? POSTER_DRAW_TIMEOUT_MS,
				() => new Error("the poster was not drawn in time"),
			);
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
