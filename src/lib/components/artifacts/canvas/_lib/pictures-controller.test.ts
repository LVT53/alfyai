// The controller behind a board's pictures: when a poster is taken and when it is
// not, what a failed one leaves (nothing but a word on the block), and how the
// download reports itself. The renderer and the board are fakes; the timing, the
// copy that is drawn and the state are the real thing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import { emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";
import { ExportError } from "./export-png";
import {
	CanvasPicturesController,
	type PicturesBoard,
	type PicturesDeps,
} from "./pictures-controller.svelte";
import { PosterError } from "./poster";

const POSTER = { fileId: "poster-1", width: 400, height: 300, capturedAt: 5 };

function app(
	id: string,
	title = "Tip calculator",
	extra: Partial<CanvasNode> = {},
): CanvasNode {
	return {
		id,
		type: "app",
		position: { x: 0, y: 0 },
		width: 400,
		height: 340,
		data: { kind: "app", artifactId: `art-${id}`, title },
		...extra,
	};
}
function sticky(id: string): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x: 0, y: 0 },
		data: { kind: "sticky", text: id, tone: "yellow" },
	};
}

/** A block's content region with an App's frame in it, laid out as far as jsdom lays anything out. */
function contentOf(id: string): HTMLElement {
	const el = document.createElement("div");
	el.className = "canvas-node__content";
	el.dataset.owner = id;
	el.innerHTML =
		'<div data-testid="canvas-app"><iframe class="app-frame" src="/app"></iframe></div>';
	Object.defineProperty(el, "offsetWidth", { value: 400 });
	Object.defineProperty(el, "offsetHeight", { value: 300 });
	return el;
}

function fakeBoard(initial: CanvasNode[]) {
	let nodes = initial;
	const contents = new Map<string, HTMLElement>();
	const board = {
		pictureSource: vi.fn(() => ({
			body: { ...emptyCanvasBody(), nodes } as CanvasBody,
			rects: nodes.map(() => ({ x: 0, y: 0, width: 400, height: 340 })),
			viewportEl: document.createElement("div"),
		})),
		nodeContentElement: vi.fn((id: string) => {
			if (!nodes.some((node) => node.id === id)) return null;
			if (!contents.has(id)) contents.set(id, contentOf(id));
			return contents.get(id) ?? null;
		}),
		setBlockPoster: vi.fn((id: string, poster: unknown) => {
			nodes = nodes.map((node) =>
				node.id === id
					? ({ ...node, data: { ...node.data, poster } } as CanvasNode)
					: node,
			);
			return true;
		}),
		showPictures: vi.fn(),
		markPosterFailed: vi.fn(),
		getCamera: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
		setCamera: vi.fn(async () => true),
	} satisfies PicturesBoard;
	return {
		board,
		set(next: CanvasNode[]) {
			nodes = next;
		},
		contents,
	};
}

function make(initial: CanvasNode[], overrides: Partial<PicturesDeps> = {}) {
	const fake = fakeBoard(initial);
	const capture = vi.fn(async (_input: { element: HTMLElement }) => POSTER);
	const controller = new CanvasPicturesController({
		artifactId: "board-1",
		conversationId: "conv-1",
		board: () => fake.board,
		capture: capture as never,
		debounceMs: 800,
		readyTimeoutMs: 1000,
		...overrides,
	});
	return { controller, fake, capture };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("when a poster is taken", () => {
	it("waits out the debounce, then draws it once and puts it on the block", async () => {
		const { controller, fake, capture } = make([app("a")]);
		controller.setNodes([app("a")]);
		await vi.advanceTimersByTimeAsync(799);
		expect(capture).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(300);
		expect(capture).toHaveBeenCalledOnce();
		expect(capture).toHaveBeenCalledWith(
			expect.objectContaining({
				artifactId: "board-1",
				conversationId: "conv-1",
				nodeId: "a",
			}),
		);
		expect(fake.board.setBlockPoster).toHaveBeenCalledWith("a", POSTER);
		expect(fake.board.markPosterFailed).toHaveBeenLastCalledWith(new Set());
	});

	it("takes none for a block a picture can carry as it is", async () => {
		const { controller, capture } = make([sticky("s")]);
		controller.setNodes([sticky("s")]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(capture).not.toHaveBeenCalled();
	});

	it("takes none for a block that already carries one, and none again for data that has not changed", async () => {
		const withPoster = app("a", "Tip calculator");
		(withPoster.data as { poster?: unknown }).poster = POSTER;
		const { controller, capture } = make([withPoster]);
		controller.setNodes([withPoster]);
		controller.setNodes([withPoster]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(capture).not.toHaveBeenCalled();
	});

	it("takes a new one after the block's data changes, and after it is resized", async () => {
		const withPoster = app("a");
		(withPoster.data as { poster?: unknown }).poster = POSTER;
		const { controller, capture } = make([withPoster]);
		controller.setNodes([withPoster]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(capture).not.toHaveBeenCalled();

		const renamed = app("a", "Tip calculator 2");
		(renamed.data as { poster?: unknown }).poster = POSTER;
		controller.setNodes([renamed]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(capture).toHaveBeenCalledTimes(1);

		const resized = { ...renamed, width: 500 };
		controller.setNodes([resized]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(capture).toHaveBeenCalledTimes(2);
	});

	it("makes one poster of a burst of changes, from the last of them", async () => {
		const { controller, capture } = make([app("a")]);
		for (const title of ["T1", "T2", "T3"]) {
			controller.setNodes([app("a", title)]);
			await vi.advanceTimersByTimeAsync(300);
		}
		await vi.advanceTimersByTimeAsync(1000);
		expect(capture).toHaveBeenCalledOnce();
	});

	it("does not put a picture on a block that changed while it was being made", async () => {
		const { controller, capture, fake } = make([app("a", "First")]);
		let release: () => void = () => undefined;
		capture.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve(POSTER);
				}),
		);
		controller.setNodes([app("a", "First")]);
		await vi.advanceTimersByTimeAsync(900);
		expect(capture).toHaveBeenCalledOnce();
		controller.setNodes([app("a", "Second")]);
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.board.setBlockPoster).not.toHaveBeenCalled();
		// It is taken again, of what the block is now.
		await vi.advanceTimersByTimeAsync(1000);
		expect(capture).toHaveBeenCalledTimes(2);
		expect(fake.board.setBlockPoster).toHaveBeenCalledOnce();
	});

	it("forgets a block that left the board", async () => {
		const { controller, capture } = make([app("a")]);
		controller.setNodes([app("a")]);
		controller.setNodes([]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(capture).not.toHaveBeenCalled();
	});
});

describe("the copy a poster is drawn from", () => {
	it("is a copy: the frame on the board is left running and nothing on the board changes", async () => {
		const { controller, capture, fake } = make([app("a")]);
		let seen: HTMLElement | null = null;
		let framesInCopy = -1;
		capture.mockImplementationOnce(async (input: { element: HTMLElement }) => {
			seen = input.element;
			framesInCopy = input.element.querySelectorAll("iframe").length;
			return POSTER;
		});
		controller.setNodes([app("a")]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(seen).not.toBe(fake.contents.get("a"));
		expect(framesInCopy).toBe(0);
		expect(fake.contents.get("a")?.querySelectorAll("iframe")).toHaveLength(1);
		// The copy is drawn off screen and taken away after.
		expect(document.body.querySelectorAll('[aria-hidden="true"]')).toHaveLength(
			0,
		);
		expect(fake.board.showPictures).not.toHaveBeenCalled();
	});

	it("draws the card in place of the App, with its name", async () => {
		const { controller, capture } = make([app("a", "Tip calculator")]);
		let text = "";
		capture.mockImplementationOnce(async (input: { element: HTMLElement }) => {
			text = input.element.textContent ?? "";
			return POSTER;
		});
		controller.setNodes([app("a", "Tip calculator")]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(text).toContain("Tip calculator");
	});

	it("waits for the block's content before drawing it, and gives up after a while", async () => {
		const { controller, capture, fake } = make([app("a")]);
		fake.board.nodeContentElement.mockImplementation(() => null);
		controller.setNodes([app("a")]);
		await vi.advanceTimersByTimeAsync(800 + 500);
		expect(capture).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		expect(capture).not.toHaveBeenCalled();
		expect(fake.board.markPosterFailed).toHaveBeenLastCalledWith(
			new Set(["a"]),
		);
	});
});

describe("a poster that could not be made", () => {
	it("is a word on the block and nothing else: no throw, the block untouched, no second try for the same data", async () => {
		const { controller, capture, fake } = make([app("a")]);
		capture.mockRejectedValue(new PosterError("render"));
		controller.setNodes([app("a")]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.board.markPosterFailed).toHaveBeenLastCalledWith(
			new Set(["a"]),
		);
		expect(fake.board.setBlockPoster).not.toHaveBeenCalled();
		controller.setNodes([app("a")]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(capture).toHaveBeenCalledOnce();
	});

	it("is tried again when the block's data changes, and the word goes when it works", async () => {
		const { controller, capture, fake } = make([app("a")]);
		capture.mockRejectedValueOnce(new PosterError("upload"));
		controller.setNodes([app("a")]);
		await vi.advanceTimersByTimeAsync(1000);
		controller.setNodes([app("a", "Renamed")]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(capture).toHaveBeenCalledTimes(2);
		expect(fake.board.markPosterFailed).toHaveBeenLastCalledWith(new Set());
		expect(fake.board.setBlockPoster).toHaveBeenCalledOnce();
	});

	it("is offered to the board again when the board would not take it yet", async () => {
		const { controller, fake } = make([app("a")]);
		fake.board.setBlockPoster.mockReturnValueOnce(false);
		controller.setNodes([app("a")]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.board.setBlockPoster).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(fake.board.setBlockPoster).toHaveBeenCalledTimes(2);
	});

	it("stops offering after a few refusals", async () => {
		const { controller, fake } = make([app("a")]);
		fake.board.setBlockPoster.mockReturnValue(false);
		controller.setNodes([app("a")]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.board.setBlockPoster.mock.calls.length).toBeLessThanOrEqual(4);
	});
});

describe("once more before a picture of the board", () => {
	it("draws a poster for every block that has none, at once", async () => {
		const { controller, capture, fake } = make([
			app("a"),
			app("b"),
			sticky("s"),
		]);
		await controller.captureMissing();
		expect(capture).toHaveBeenCalledTimes(2);
		expect(fake.board.setBlockPoster).toHaveBeenCalledTimes(2);
	});
});

describe("the download", () => {
	const download = vi.fn(async () => true);
	const result = {
		fileId: "file 1",
		filename: "Board.png",
		width: 800,
		height: 600,
		missingPosters: [] as { nodeId: string; title: string }[],
	};

	beforeEach(() => {
		download.mockClear();
	});

	it("draws, stores and downloads the picture, and says so", async () => {
		const exportPng = vi.fn(async () => result);
		const { controller } = make([app("a")], {
			exportPng: exportPng as never,
			download,
		});
		const running = controller.downloadPng();
		expect(controller.status).toBe("working");
		await vi.advanceTimersByTimeAsync(5000);
		await running;
		expect(controller.status).toBe("done");
		expect(controller.fileId).toBe("file 1");
		expect(controller.noticeOpen).toBe(false);
		expect(download).toHaveBeenCalledWith(
			"/api/chat/files/file%201/download",
			"Board.png",
		);
	});

	it("names the blocks drawn as cards, in a notice the reader may dismiss", async () => {
		const exportPng = vi.fn(async () => ({
			...result,
			missingPosters: [{ nodeId: "a", title: "Tip calculator" }],
		}));
		const { controller } = make([app("a")], {
			exportPng: exportPng as never,
			download,
		});
		const running = controller.downloadPng();
		await vi.advanceTimersByTimeAsync(5000);
		await running;
		expect(controller.missing).toEqual([
			{ nodeId: "a", title: "Tip calculator" },
		]);
		expect(controller.noticeOpen).toBe(true);
		controller.dismissNotice();
		expect(controller.noticeOpen).toBe(false);
	});

	it("mounts each block's poster, or a card for a block with none, and takes them off", async () => {
		const withPoster = app("a");
		(withPoster.data as { poster?: unknown }).poster = POSTER;
		let shown: ReadonlyMap<string, unknown> | null = null;
		const exportPng = vi.fn(
			async (input: {
				mountPosters: (m: string[]) => Promise<void>;
				unmountPosters: () => void;
			}) => {
				await input.mountPosters([]);
				input.unmountPosters();
				return result;
			},
		);
		const { controller, fake } = make([withPoster, app("b", "Second")], {
			exportPng: exportPng as never,
			download,
			capture: vi.fn(async () => {
				throw new PosterError("render");
			}) as never,
		});
		fake.board.showPictures.mockImplementation((next) => {
			if (next) shown = next;
		});
		const running = controller.downloadPng();
		await vi.advanceTimersByTimeAsync(5000);
		await running;
		expect(shown).not.toBeNull();
		const pictures = shown as unknown as ReadonlyMap<
			string,
			{ kind: string; url?: string; title?: string }
		>;
		expect(pictures.get("a")).toEqual({
			kind: "poster",
			url: "/api/chat/files/poster-1/preview",
		});
		expect(pictures.get("b")).toMatchObject({
			kind: "placeholder",
			title: "Second",
		});
		expect(fake.board.showPictures).toHaveBeenLastCalledWith(null);
	});

	it("refuses an empty board without touching it", async () => {
		const exportPng = vi.fn();
		const { controller, fake } = make([], {
			exportPng: exportPng as never,
			download,
		});
		await controller.downloadPng();
		expect(controller.status).toBe("error");
		expect(controller.failure).toBe("empty");
		expect(exportPng).not.toHaveBeenCalled();
		expect(fake.board.setCamera).not.toHaveBeenCalled();
	});

	it("says why a picture could not be kept, by reason", async () => {
		for (const [error, failure] of [
			[new ExportError("upload", "too_large"), "tooLarge"],
			[new ExportError("upload", "no_conversation"), "noConversation"],
			[new ExportError("upload", "failed"), "failed"],
			[new ExportError("draw"), "failed"],
			[new Error("boom"), "failed"],
		] as const) {
			const { controller } = make([app("a")], {
				exportPng: vi.fn(async () => {
					throw error;
				}) as never,
				download,
			});
			const running = controller.downloadPng();
			await vi.advanceTimersByTimeAsync(5000);
			await running;
			expect(controller.status, String(failure)).toBe("error");
			expect(controller.failure).toBe(failure);
			expect(download).not.toHaveBeenCalled();
			// A retry starts clean.
			controller.reset();
			expect(controller.status).toBe("idle");
		}
	});

	it("does not start a second picture while one is being drawn", async () => {
		const exportPng = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			return result;
		});
		const { controller } = make([app("a")], {
			exportPng: exportPng as never,
			download,
		});
		const first = controller.downloadPng();
		await vi.advanceTimersByTimeAsync(10);
		void controller.downloadPng();
		await vi.advanceTimersByTimeAsync(6000);
		await first;
		expect(exportPng).toHaveBeenCalledOnce();
	});
});
