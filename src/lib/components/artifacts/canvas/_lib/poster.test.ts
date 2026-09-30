// The still image of a block: which kinds want one, what a block with none is
// drawn as, what a picture leaves out, and that a failed capture never throws
// past its own error type or leaves anything kept.
import { describe, expect, it, vi } from "vitest";
import type { I18nKey } from "$lib/i18n";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { BLOCK_META, needsPoster } from "./block-meta";
import {
	blockName,
	capturePoster,
	imagesSettled,
	keepInPicture,
	POSTER_HEIGHT,
	POSTER_WIDTH,
	PosterError,
	posterOf,
	posterPixelRatio,
	posterPlaceholder,
	renderPoster,
	stillify,
	withTimeout,
} from "./poster";

const words: Partial<Record<I18nKey, string>> = {
	"artifacts.canvas.insert.app": "App",
	"artifacts.canvas.insert.map": "Map",
	"artifacts.canvas.insert.liveweb": "Live web",
	"artifacts.canvas.insert.photo": "Photos",
	"artifacts.canvas.blockMissingKind": "Unknown block",
	"artifacts.canvas.export.stillApp": "App: live version not in the image",
	"artifacts.canvas.export.stillMap": "Map: basemap not in the image",
	"artifacts.canvas.export.stillPhoto": "Photos: not in the image",
	"artifacts.canvas.export.stillWeb": "Web: not in the image",
	"artifacts.canvas.export.stillOther": "Not in the image",
	"artifacts.canvas.mapNotLive": "Basemap not live",
};
const translate = (key: I18nKey) => words[key] ?? key;

const app: CanvasBlockData = {
	kind: "app",
	artifactId: "a-1",
	title: "Tip calculator",
};
const map: CanvasBlockData = {
	kind: "map",
	route: "Cork → Kinsale",
	map: {} as never,
};
const live: CanvasBlockData = {
	kind: "liveweb",
	query: "cork weather",
	sources: [],
	fetchedAt: 0,
};
const photo: CanvasBlockData = { kind: "photo", items: [] };

function element(width = 400, height = 300): HTMLElement {
	const el = document.createElement("div");
	Object.defineProperty(el, "offsetWidth", { value: width });
	Object.defineProperty(el, "offsetHeight", { value: height });
	return el;
}

describe("which blocks want a poster", () => {
	it("is exactly the App, the map, photos and live web", () => {
		const wanted = Object.keys(BLOCK_META).filter((kind) => needsPoster(kind));
		expect(wanted.sort()).toEqual(["app", "liveweb", "map", "photo"]);
		expect(needsPoster("not-a-kind")).toBe(false);
	});
});

describe("a block with no poster", () => {
	it("is drawn as a card that names it and says its live version is not in the image", () => {
		expect(posterPlaceholder(app, translate)).toEqual({
			title: "Tip calculator",
			subtitle: "App: live version not in the image",
		});
		expect(posterPlaceholder(map, translate)).toEqual({
			title: "Cork → Kinsale",
			subtitle: "Map: basemap not in the image",
		});
		expect(posterPlaceholder(live, translate).title).toBe("cork weather");
		expect(posterPlaceholder(photo, translate)).toEqual({
			title: "Photos",
			subtitle: "Photos: not in the image",
		});
	});

	it("still has a name when its own is empty", () => {
		expect(blockName({ ...app, title: "" }, translate)).toBe("App");
		expect(blockName({ ...map, route: "" }, translate)).toBe("Map");
		expect(blockName({ ...live, query: "" }, translate)).toBe("Live web");
	});

	it("reads a poster off the four kinds that carry one, and off no other", () => {
		const poster = { fileId: "f", width: 1, height: 1, capturedAt: 1 };
		expect(posterOf({ ...app, poster })).toEqual(poster);
		expect(posterOf(app)).toBeUndefined();
		expect(posterOf({ kind: "text", text: "hi" })).toBeUndefined();
	});
});

describe("what a picture leaves out", () => {
	function tagged(markup: string): Element {
		const host = document.createElement("div");
		host.innerHTML = markup;
		return host.firstElementChild as Element;
	}

	it("leaves out the reader's tools and every layer that is not the board's content", () => {
		for (const markup of [
			"<span data-export-skip></span>",
			'<div class="comment-pins"></div>',
			'<div data-testid="canvas-comment-catcher"></div>',
			'<div data-testid="alfy-change-layer"></div>',
			'<div data-testid="canvas-drawing-layer"></div>',
			"<g data-annotation-chrome></g>",
			'<g class="mark mark--sweep"></g>',
			'<input class="annotation-text">',
			'<div class="svelte-flow__handle"></div>',
			'<div class="svelte-flow__resize-control"></div>',
			'<div class="svelte-flow__nodesselection"></div>',
		]) {
			expect(keepInPicture(tagged(markup)), markup).toBe(false);
		}
	});

	it("keeps the board's own content: a block, a mark, its text", () => {
		for (const markup of [
			'<div data-testid="canvas-node"></div>',
			'<g class="mark" data-annotation-id="pen-1"></g>',
			'<p class="canvas-node__title">Lunch</p>',
			'<div class="svelte-flow__node"></div>',
		]) {
			expect(keepInPicture(tagged(markup)), markup).toBe(true);
		}
		expect(keepInPicture(document.createTextNode("hello"))).toBe(true);
	});
});

describe("the size a poster is drawn at", () => {
	it("fits the poster box, is never enlarged past twice and never shrunk under half", () => {
		expect(posterPixelRatio(400, 300)).toBeCloseTo(POSTER_HEIGHT / 300, 5);
		expect(posterPixelRatio(360, 250)).toBeCloseTo(1.6, 5);
		expect(posterPixelRatio(100, 60)).toBe(2);
		expect(posterPixelRatio(4000, 3000)).toBe(0.5);
		expect(posterPixelRatio(0, 0)).toBe(1);
		expect(POSTER_WIDTH).toBe(640);
		expect(POSTER_HEIGHT).toBe(400);
	});
});

describe("drawing a poster", () => {
	const fonts = async () => "";

	it("draws the block's content at the poster scale, on the page's elevated surface, without the reader's tools", async () => {
		const draw = vi.fn(async () => "data:image/png;base64,AAAA");
		const result = await renderPoster(element(400, 300), {
			toPng: draw as never,
			fonts,
		});
		expect(result).toMatchObject({
			dataUrl: "data:image/png;base64,AAAA",
			width: Math.round(400 * (400 / 300)),
			height: 400,
		});
		expect(draw).toHaveBeenCalledOnce();
		const options = (draw.mock.calls[0] as unknown[])[1] as Record<
			string,
			unknown
		>;
		expect(options).toMatchObject({
			width: 400,
			height: 300,
			pixelRatio: 400 / 300,
			filter: keepInPicture,
		});
		expect(typeof options.backgroundColor).toBe("string");
	});

	it("draws a picture that comes out too heavy once more at half the scale, then gives up", async () => {
		const heavy = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
		const draw = vi.fn(async () => heavy);
		await expect(
			renderPoster(element(), { toPng: draw as never, fonts }),
		).rejects.toMatchObject({ name: "PosterError", reason: "too_large" });
		expect(draw).toHaveBeenCalledTimes(2);
		const ratios = draw.mock.calls.map(
			(call) => ((call as unknown[])[1] as { pixelRatio: number }).pixelRatio,
		);
		expect(ratios[1]).toBeCloseTo(ratios[0] / 2, 5);
	});

	it("says the picture could not be drawn, whatever the renderer threw", async () => {
		const draw = vi.fn(async () => {
			throw new Error("Failed to clone iframe");
		});
		await expect(
			renderPoster(element(), { toPng: draw as never, fonts }),
		).rejects.toBeInstanceOf(PosterError);
	});
});

describe("capturing a poster", () => {
	const fonts = async () => "";
	const input = {
		artifactId: "board-1",
		conversationId: "conv-1",
		nodeId: "app-1",
		element: element(),
	};

	it("keeps the picture and returns the reference for the block's data, sized as the server read it", async () => {
		const upload = vi.fn(async () => ({
			ok: true as const,
			fileId: "file-9",
			width: 533,
			height: 400,
			filename: "canvas-poster-board-1-app-1.png",
		}));
		const ref = await capturePoster(input, {
			toPng: (async () => "data:image/png;base64,AAAA") as never,
			fonts,
			upload,
			now: () => 1234,
		});
		expect(ref).toEqual({
			fileId: "file-9",
			width: 533,
			height: 400,
			capturedAt: 1234,
		});
		expect(upload).toHaveBeenCalledWith(
			expect.objectContaining({
				artifactId: "board-1",
				conversationId: "conv-1",
				source: "canvas-poster",
				nodeId: "app-1",
				dataUrl: "data:image/png;base64,AAAA",
			}),
		);
	});

	it("rejects, and uploads nothing, when the picture could not be drawn", async () => {
		const upload = vi.fn();
		await expect(
			capturePoster(input, {
				toPng: (async () => {
					throw new Error("boom");
				}) as never,
				fonts,
				upload: upload as never,
			}),
		).rejects.toMatchObject({ reason: "render" });
		expect(upload).not.toHaveBeenCalled();
	});

	it("rejects when the server would not keep it", async () => {
		await expect(
			capturePoster(input, {
				toPng: (async () => "data:image/png;base64,AAAA") as never,
				fonts,
				upload: (async () => ({
					ok: false as const,
					reason: "too_large" as const,
				})) as never,
			}),
		).rejects.toMatchObject({ reason: "upload" });
	});
});

describe("the copy of a block a picture is drawn from", () => {
	function copyOf(markup: string): HTMLElement {
		const el = document.createElement("div");
		el.className = "canvas-node__content";
		el.innerHTML = markup;
		return el;
	}

	it("has nothing live in it: no frame, no bitmap, no script", () => {
		const copy = copyOf(
			'<iframe src="/app"></iframe><canvas></canvas><video></video><script>1</script><p>text</p>',
		);
		stillify(copy, photo, translate);
		expect(copy.querySelectorAll("iframe, canvas, video, script")).toHaveLength(
			0,
		);
		expect(copy.textContent).toBe("text");
	});

	it("loads the thumbnails a browser would load only when scrolled to", () => {
		const copy = copyOf(
			'<img loading="lazy" src="/a.jpg"><img loading="lazy" src="/b.jpg">',
		);
		stillify(copy, photo, translate);
		expect(
			[...copy.querySelectorAll("img")].map((image) => image.loading),
		).toEqual(["eager", "eager"]);
	});

	it("draws an App as a card with its name and the words that it is not in the image, never as nothing", () => {
		const copy = copyOf(
			'<div data-testid="canvas-app"><iframe class="app-frame" src="/app"></iframe></div>',
		);
		stillify(copy, app, translate);
		const card = copy.querySelector('[data-testid="canvas-app"]');
		expect(card?.querySelector("iframe")).toBeNull();
		expect(card?.textContent).toContain("Tip calculator");
		expect(card?.textContent).toContain("App: live version not in the image");
	});

	it("draws a map from the card's own route drawing, without the live map and its markers, and says the basemap is not live", () => {
		const copy = copyOf(
			`<div class="map-route-card"><div class="map-route-card__body">
				<div class="map-route-card__map"><canvas></canvas><div class="maplibregl-marker">pin</div></div>
				<svg class="map-route-card__fallback map-route-card__fallback--screen-hidden" data-testid="map-route-fallback"></svg>
			</div></div>`,
		);
		stillify(copy, map, translate);
		expect(copy.querySelector(".map-route-card__map")).toBeNull();
		expect(copy.querySelector(".maplibregl-marker")).toBeNull();
		const route = copy.querySelector('[data-testid="map-route-fallback"]');
		expect(
			route?.classList.contains("map-route-card__fallback--screen-hidden"),
		).toBe(false);
		expect(copy.querySelector(".map-route-card__body")?.textContent).toContain(
			"Basemap not live",
		);
	});

	it("says the basemap is not live on a map that had no live map to begin with", () => {
		const copy = copyOf(
			'<div class="map-route-card__body"><svg class="map-route-card__fallback" data-testid="map-route-fallback"></svg></div>',
		);
		stillify(copy, map, translate);
		expect(copy.textContent).toContain("Basemap not live");
	});

	it("leaves the block it was copied from as it was", () => {
		const source = copyOf(
			'<div data-testid="canvas-app"><iframe src="/app"></iframe></div>',
		);
		const copy = source.cloneNode(true) as HTMLElement;
		stillify(copy, app, translate);
		expect(source.querySelectorAll("iframe")).toHaveLength(1);
	});
});

describe("waiting for a copy's images", () => {
	it("is done at once when there is nothing to wait for", async () => {
		const root = document.createElement("div");
		root.innerHTML = "<p>no images</p>";
		await expect(imagesSettled(root)).resolves.toBeUndefined();
	});

	it("is done when the last image has loaded or failed", async () => {
		const root = document.createElement("div");
		root.innerHTML = '<img src="/a.jpg"><img src="/b.jpg">';
		const [first, second] = [...root.querySelectorAll("img")];
		Object.defineProperty(first, "complete", { value: false });
		Object.defineProperty(second, "complete", { value: false });
		let done = false;
		void imagesSettled(root, 10_000).then(() => {
			done = true;
		});
		first.dispatchEvent(new Event("load"));
		await Promise.resolve();
		expect(done).toBe(false);
		second.dispatchEvent(new Event("error"));
		await Promise.resolve();
		await Promise.resolve();
		expect(done).toBe(true);
	});

	it("gives up after a while: a poster is drawn with what arrived", async () => {
		vi.useFakeTimers();
		try {
			const root = document.createElement("div");
			root.innerHTML = '<img src="/never.jpg">';
			const image = root.querySelector("img") as HTMLImageElement;
			Object.defineProperty(image, "complete", { value: false });
			const settled = imagesSettled(root, 500);
			await vi.advanceTimersByTimeAsync(600);
			await expect(settled).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a picture that hangs", () => {
	it("is given up on after the time it was given, with what the caller says", async () => {
		vi.useFakeTimers();
		try {
			const never = new Promise<string>(() => undefined);
			const result = withTimeout(never, 1000, () => new Error("too slow"));
			const settled = expect(result).rejects.toThrow("too slow");
			await vi.advanceTimersByTimeAsync(1001);
			await settled;
			const quick = withTimeout(
				Promise.resolve("ok"),
				1000,
				() => new Error("too slow"),
			);
			await expect(quick).resolves.toBe("ok");
			const failing = withTimeout(
				Promise.reject(new Error("boom")),
				1000,
				() => new Error("too slow"),
			);
			await expect(failing).rejects.toThrow("boom");
		} finally {
			vi.useRealTimers();
		}
	});

	it("is a poster that could not be drawn, not a hang", async () => {
		vi.useFakeTimers();
		try {
			const draw = vi.fn(() => new Promise<string>(() => undefined));
			const result = renderPoster(element(), {
				toPng: draw as never,
				fonts: async () => "",
				drawTimeoutMs: 500,
			});
			const settled = expect(result).rejects.toMatchObject({
				reason: "render",
			});
			await vi.advanceTimersByTimeAsync(600);
			await settled;
		} finally {
			vi.useRealTimers();
		}
	});
});
