/**
 * Everything the board does to make a picture of itself, and the state the
 * header's Download and the panel's notice read: the still image of each block a
 * picture cannot carry live (its poster), and the export of the whole board.
 * The panel's editor makes one when a picture is first needed — a board with no
 * App, map, photos or live web, and a reader who never presses Download, never
 * load any of this or the renderer it brings.
 *
 * It does not draw and it does not save. It asks the board (`PicturesBoard`) for
 * what it needs and gives it what it made:
 *
 *  - A poster is captured from a COPY of the block's content, made by `stillify`
 *    (the live parts out, what a picture cannot show said in words), so the block
 *    on the board is never touched and never flickers. It is captured once, 800 ms
 *    after a block first shows with its data; again 800 ms after its data or size
 *    changes; and once more, at the start of an export, for any block still without
 *    one. It goes on the block's data without being a step of the reader's and is
 *    saved with their next step (`CanvasBoard.setBlockPoster`).
 *  - A capture that fails is not a failure of the board: the block keeps drawing
 *    live, says once in its meta line that it has no still image, is not retried
 *    for the same data, and the export draws it as a card and names it.
 *  - The export is `exportBoardPng` (order and cleanup in its own header); this
 *    adds what only the panel knows: the posters of the blocks that have them are
 *    mounted, the download of the stored file starts, and what happened is state.
 */
import { tick } from "svelte";
import { get } from "svelte/store";
import { startAuthenticatedDownload } from "$lib/client/downloads";
import { t } from "$lib/i18n";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import type {
	CanvasBlockData,
	PosterRef,
} from "$lib/shared/artifacts/canvas-blocks";
import { needsPoster } from "./block-meta";
import type { Rect } from "./board";
import type { BlockPicture } from "./board-context";
import {
	type Camera,
	type CanvasExportResult,
	ExportError,
	exportBoardPng,
} from "./export-png";
import {
	capturePoster,
	imagesSettled,
	posterOf,
	posterPlaceholder,
	stillify,
} from "./poster";

/** A poster is taken this long after the last change to a block: a drag or a burst of typing must not trigger one per frame. */
const CAPTURE_DEBOUNCE_MS = 800;
/** How long a block's content is waited for (its chunk, the map's inline drawing) before its poster is given up on. */
const READY_TIMEOUT_MS = 5000;
const READY_POLL_MS = 100;
/** A poster the board would not take yet (a block is being dragged) is offered again after this, a few times. */
const RETRY_MS = 1500;
const MAX_REFUSALS = 4;

/** What shows a block of each kind is drawn: the marker of its content, and (the map) of the drawing a picture can carry. */
const READY_SELECTOR: Record<string, string> = {
	app: '[data-testid="canvas-app"]',
	map: '[data-testid="map-route-fallback"]',
	photo: '[data-testid="canvas-photo"]',
	liveweb: '[data-testid="canvas-liveweb"]',
};

/** What the controller needs of the board it is for: the board's own methods, named. */
export type PicturesBoard = {
	pictureSource: () => {
		body: CanvasBody;
		rects: Rect[];
		viewportEl: HTMLElement | null;
	};
	nodeContentElement: (id: string) => HTMLElement | null;
	setBlockPoster: (id: string, poster: PosterRef | null) => boolean;
	showPictures: (pictures: ReadonlyMap<string, BlockPicture> | null) => void;
	markPosterFailed: (ids: ReadonlySet<string>) => void;
	getCamera: () => Camera;
	setCamera: (camera: Camera) => Promise<unknown>;
};

export type PicturesDeps = {
	artifactId: string;
	conversationId: string | null;
	/** The board as it is now, or null while there is none (a reload, a conflict). */
	board: () => PicturesBoard | null;
	/** Test seams: the renderer, the download, the clock. */
	capture?: typeof capturePoster;
	exportPng?: typeof exportBoardPng;
	download?: (url: string, filename?: string) => Promise<boolean>;
	debounceMs?: number;
	readyTimeoutMs?: number;
};

export type DownloadFailure =
	| "empty"
	| "failed"
	| "tooLarge"
	| "noConversation";

/** A block's data without its poster, and its size: what a still image is a picture of. */
function dataKey(node: CanvasNode): string {
	const { poster: _poster, ...rest } = node.data as CanvasBlockData & {
		poster?: unknown;
	};
	return `${node.width ?? ""}x${node.height ?? ""}:${JSON.stringify(rest)}`;
}

function failureOf(error: unknown): DownloadFailure {
	if (error instanceof ExportError) {
		if (error.reason === "empty") return "empty";
		if (error.reason === "upload") {
			if (error.uploadReason === "too_large") return "tooLarge";
			if (error.uploadReason === "no_conversation") return "noConversation";
		}
	}
	return "failed";
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export class CanvasPicturesController {
	/** The Download's state: idle, a picture being drawn, kept, or not. */
	status = $state<"idle" | "working" | "done" | "error">("idle");
	failure = $state<DownloadFailure | null>(null);
	/** The stored file of the last picture: the canonical download is `/api/chat/files/[id]/download`. */
	fileId = $state<string | null>(null);
	filename = $state<string | null>(null);
	/** Blocks the last picture drew as a card because they had no still image. */
	missing = $state.raw<{ nodeId: string; title: string }[]>([]);
	/** The notice naming them is showing (the reader may dismiss it). */
	noticeOpen = $state(false);

	readonly #deps: PicturesDeps;
	#nodes = new Map<string, CanvasNode>();
	/** Per block, the key of the data its poster is a picture of (or of the attempt that failed): a key already seen is not captured again. */
	#known = new Map<string, string>();
	#failed = new Set<string>();
	#refusals = new Map<string, number>();
	#timer: ReturnType<typeof setTimeout> | null = null;
	#running = false;
	#destroyed = false;

	constructor(deps: PicturesDeps) {
		this.#deps = deps;
	}

	/**
	 * The blocks as the board has them now (every step, and the first load): a
	 * block that shows a picture for the first time, or whose data or size is not
	 * the data its poster was taken of, is captured after the debounce. A poster the
	 * saved board already carries is taken as a picture of the data it came with.
	 */
	setNodes(nodes: readonly CanvasNode[]): void {
		this.#nodes = new Map(
			nodes
				.filter((node) => needsPoster(node.type))
				.map((node) => [node.id, node]),
		);
		for (const id of [...this.#known.keys()]) {
			if (this.#nodes.has(id)) continue;
			this.#known.delete(id);
			this.#failed.delete(id);
			this.#refusals.delete(id);
		}
		let due = false;
		for (const [id, node] of this.#nodes) {
			const key = dataKey(node);
			if (!this.#known.has(id) && posterOf(node.data)) this.#known.set(id, key);
			if (this.#known.get(id) !== key) due = true;
		}
		if (due) this.#schedule(this.#deps.debounceMs ?? CAPTURE_DEBOUNCE_MS);
	}

	#schedule(ms: number): void {
		if (this.#destroyed) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.#run();
		}, ms);
	}

	async #run(): Promise<void> {
		if (this.#running || this.#destroyed) return;
		this.#running = true;
		try {
			for (const node of [...this.#nodes.values()]) {
				if (this.#destroyed) return;
				const key = dataKey(node);
				if (this.#known.get(node.id) === key) continue;
				await this.#capture(node, key);
			}
		} finally {
			this.#running = false;
		}
	}

	/** Draws one block's still image and puts it on the block. Never throws: what went wrong is the block's `posterFailed`. */
	async #capture(node: CanvasNode, key: string): Promise<void> {
		const board = this.#deps.board();
		if (!board) return;
		let ref: PosterRef | null = null;
		let copyHost: HTMLElement | null = null;
		try {
			const source = await this.#contentOf(board, node);
			if (!source) throw new Error("no content");
			const translate = get(t);
			const copy = source.cloneNode(true) as HTMLElement;
			stillify(copy, node.data, translate);
			copy.style.cssText += `;width:${source.offsetWidth}px;height:${source.offsetHeight}px;flex:none;position:relative`;
			copyHost = document.createElement("div");
			copyHost.setAttribute("aria-hidden", "true");
			copyHost.inert = true;
			copyHost.style.cssText = `position:fixed;left:-100000px;top:0;width:${source.offsetWidth}px;height:${source.offsetHeight}px;pointer-events:none`;
			copyHost.append(copy);
			document.body.append(copyHost);
			await imagesSettled(copy);
			ref = await (this.#deps.capture ?? capturePoster)({
				artifactId: this.#deps.artifactId,
				conversationId: this.#deps.conversationId,
				nodeId: node.id,
				element: copy,
			});
		} catch {
			// A failed capture is not a failed board: the block keeps drawing live.
			this.#known.set(node.id, key);
			this.#failed.add(node.id);
			board.markPosterFailed(new Set(this.#failed));
			return;
		} finally {
			copyHost?.remove();
		}
		if (this.#destroyed) return;
		// The block may have changed, or gone, while its picture was being made.
		const current = this.#nodes.get(node.id);
		if (!current || dataKey(current) !== key) {
			this.#schedule(this.#deps.debounceMs ?? CAPTURE_DEBOUNCE_MS);
			return;
		}
		if (!board.setBlockPoster(node.id, ref)) {
			// The board would not take it now (a block is being dragged): offer it again shortly.
			const refused = (this.#refusals.get(node.id) ?? 0) + 1;
			this.#refusals.set(node.id, refused);
			if (refused < MAX_REFUSALS) this.#schedule(RETRY_MS);
			else this.#known.set(node.id, key);
			return;
		}
		this.#refusals.delete(node.id);
		this.#known.set(node.id, key);
		this.#failed.delete(node.id);
		board.markPosterFailed(new Set(this.#failed));
	}

	/** The block's content region once it has drawn (its chunk loaded, the map's inline route there), or null after a wait. */
	async #contentOf(
		board: PicturesBoard,
		node: CanvasNode,
	): Promise<HTMLElement | null> {
		const ready = READY_SELECTOR[node.type];
		const deadline =
			Date.now() + (this.#deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
		while (!this.#destroyed) {
			const element = board.nodeContentElement(node.id);
			if (
				element &&
				element.offsetWidth > 0 &&
				(!ready || element.querySelector(ready))
			) {
				return element;
			}
			if (Date.now() >= deadline) return null;
			await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
		}
		return null;
	}

	/** Once more before a picture of the board: every block that needs a still image and has none gets one, or is left to be drawn as a card. */
	async captureMissing(): Promise<void> {
		const board = this.#deps.board();
		if (!board) return;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		// A capture in flight is waited for, but not for ever.
		for (let waited = 0; this.#running && waited < 30_000; waited += 50) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		for (const node of board.pictureSource().body.nodes) {
			if (!needsPoster(node.type) || posterOf(node.data)) continue;
			this.#nodes.set(node.id, node);
			await this.#capture(node, dataKey(node));
		}
	}

	/** True when there is nothing on the board to make a picture of. */
	isEmpty(): boolean {
		const body = this.#deps.board()?.pictureSource().body;
		return !body || (body.nodes.length === 0 && body.annotations.length === 0);
	}

	/**
	 * The board as one PNG, stored as a file in this chat and downloaded. The state
	 * says how it went; nothing throws. The board is drawn opaque over by the
	 * editor while `status` is `working`, so the camera's short trip is not seen.
	 */
	async downloadPng(): Promise<void> {
		if (this.status === "working") return;
		this.status = "working";
		this.failure = null;
		this.missing = [];
		this.noticeOpen = false;
		try {
			if (this.isEmpty()) throw new ExportError("empty");
			await this.captureMissing();
			const board = this.#deps.board();
			const source = board?.pictureSource();
			if (!board || !source?.viewportEl) throw new ExportError("draw");
			const translate = get(t);
			const result: CanvasExportResult = await (
				this.#deps.exportPng ?? exportBoardPng
			)({
				body: source.body,
				rects: source.rects,
				artifactId: this.#deps.artifactId,
				conversationId: this.#deps.conversationId,
				viewportEl: source.viewportEl,
				setViewport: (camera) => board.setCamera(camera),
				getViewport: () => board.getCamera(),
				mountPosters: async () => {
					board.showPictures(this.#picturesFor(source.body, translate));
					await tick();
					await nextFrame();
					await this.#postersDecoded(board, source.body);
				},
				unmountPosters: () => board.showPictures(null),
				translate,
			});
			this.fileId = result.fileId;
			this.filename = result.filename;
			this.missing = result.missingPosters;
			this.noticeOpen = result.missingPosters.length > 0;
			this.status = "done";
			await (this.#deps.download ?? startAuthenticatedDownload)(
				`/api/chat/files/${encodeURIComponent(result.fileId)}/download`,
				result.filename,
			);
		} catch (error) {
			this.failure = failureOf(error);
			this.status = "error";
		}
	}

	/** What each poster-needing block is drawn as during a picture: its poster, or a card that says it has none. */
	#picturesFor(
		body: CanvasBody,
		translate: Parameters<typeof posterPlaceholder>[1],
	): Map<string, BlockPicture> {
		const pictures = new Map<string, BlockPicture>();
		for (const node of body.nodes) {
			if (!needsPoster(node.type)) continue;
			const poster = posterOf(node.data);
			pictures.set(
				node.id,
				poster
					? {
							kind: "poster",
							url: `/api/chat/files/${encodeURIComponent(poster.fileId)}/preview`,
						}
					: { kind: "placeholder", ...posterPlaceholder(node.data, translate) },
			);
		}
		return pictures;
	}

	/** The poster images are in the picture only once the browser has decoded them. */
	async #postersDecoded(board: PicturesBoard, body: CanvasBody): Promise<void> {
		const images: HTMLImageElement[] = [];
		for (const node of body.nodes) {
			const image = board
				.nodeContentElement(node.id)
				?.querySelector<HTMLImageElement>(".canvas-node__poster");
			if (image) images.push(image);
		}
		await Promise.all(
			images.map((image) =>
				Promise.race([
					image.decode().catch(() => undefined),
					new Promise((resolve) => setTimeout(resolve, 3000)),
				]),
			),
		);
	}

	dismissNotice(): void {
		this.noticeOpen = false;
	}

	/** Back to idle, so the Download offers the picture again. */
	reset(): void {
		if (this.status === "working") return;
		this.status = "idle";
		this.failure = null;
	}

	destroy(): void {
		this.#destroyed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}
}
