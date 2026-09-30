// A picture of the whole board, and above all what a failed one leaves behind:
// nothing. The camera goes back where the reader had it and every poster comes
// off, whichever step throws, and a block drawn as a card is named.
import { describe, expect, it, vi } from "vitest";
import type { I18nKey } from "$lib/i18n";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import { emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";
import {
	type Camera,
	cameraForBounds,
	EXPORT_MAX,
	EXPORT_MIN,
	ExportError,
	type ExportInput,
	exportBoardPng,
	exportSize,
	unionRects,
} from "./export-png";

const translate = (key: I18nKey) => key;

const POSTER = { fileId: "poster-1", width: 400, height: 300, capturedAt: 1 };

function sticky(id: string, x: number, y: number): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 190,
		data: { kind: "sticky", text: id, tone: "yellow" },
	};
}
function app(id: string, x: number, y: number, poster = false): CanvasNode {
	return {
		id,
		type: "app",
		position: { x, y },
		width: 400,
		height: 340,
		data: {
			kind: "app",
			artifactId: `app-${id}`,
			title: `App ${id}`,
			...(poster ? { poster: POSTER } : {}),
		},
	};
}
function map(id: string, x: number, y: number): CanvasNode {
	return {
		id,
		type: "map",
		position: { x, y },
		width: 360,
		data: { kind: "map", route: "Cork → Kinsale", map: {} as never },
	};
}

function board(nodes: CanvasNode[]): CanvasBody {
	return { ...emptyCanvasBody(), nodes };
}

const rectsOf = (nodes: CanvasNode[]) =>
	nodes.map((node) => ({
		x: node.position.x,
		y: node.position.y,
		width: node.width ?? 190,
		height: node.height ?? 84,
	}));

/** A board whose camera really moves, so "restored" means something. */
function harness(
	overrides: Partial<ExportInput> & { nodes?: CanvasNode[] } = {},
) {
	const nodes = overrides.nodes ?? [
		sticky("a", 0, 0),
		app("b", 400, 100, true),
	];
	let camera: Camera = { x: 12, y: 34, zoom: 0.7 };
	const cameras: Camera[] = [];
	const events: string[] = [];
	const input: ExportInput = {
		body: board(nodes),
		rects: rectsOf(nodes),
		artifactId: "board-1",
		conversationId: "conv-1",
		viewportEl: document.createElement("div"),
		setViewport: vi.fn(async (next: Camera) => {
			events.push(`camera ${next.zoom.toFixed(2)}`);
			camera = { ...next };
			cameras.push({ ...next });
		}),
		getViewport: () => camera,
		mountPosters: vi.fn(async (missing: string[]) => {
			events.push(`mount ${missing.join(",")}`);
		}),
		unmountPosters: vi.fn(() => {
			events.push("unmount");
		}),
		translate,
		toPng: vi.fn(async () => {
			events.push("draw");
			return "data:image/png;base64,AAAA";
		}) as never,
		nextFrame: async () => {
			events.push("frame");
		},
		upload: vi.fn(async () => {
			events.push("upload");
			return { ok: true as const, fileId: "export-1", width: 800, height: 600 };
		}),
		...overrides,
	};
	return { input, events, cameras, camera: () => camera };
}

describe("the size of the picture", () => {
	it("is the board's own, clamped between 800 x 600 and 2,400 x 1,800", () => {
		const at = (width: number, height: number) =>
			exportSize({ x: 0, y: 0, width, height });
		expect(at(100, 50)).toEqual({
			width: EXPORT_MIN.width,
			height: EXPORT_MIN.height,
		});
		expect(at(1000, 700)).toEqual({ width: 1000, height: 700 });
		expect(at(9000, 9000)).toEqual({
			width: EXPORT_MAX.width,
			height: EXPORT_MAX.height,
		});
		expect(at(9000, 100)).toEqual({
			width: EXPORT_MAX.width,
			height: EXPORT_MIN.height,
		});
		expect(EXPORT_MIN).toEqual({ width: 800, height: 600 });
		expect(EXPORT_MAX).toEqual({ width: 2400, height: 1800 });
	});

	it("puts the whole content in it, centred, with room around, and no nearer than double or further than a fifth", () => {
		const bounds = { x: 100, y: 50, width: 1000, height: 500 };
		const size = exportSize(bounds);
		const camera = cameraForBounds(bounds, size);
		// The content's centre is the picture's centre.
		expect(100 + 500 + camera.x / camera.zoom).toBeCloseTo(
			size.width / 2 / camera.zoom,
			5,
		);
		expect(bounds.width * camera.zoom).toBeLessThan(size.width);
		expect(bounds.height * camera.zoom).toBeLessThan(size.height);
		expect(
			cameraForBounds({ x: 0, y: 0, width: 10, height: 10 }, size).zoom,
		).toBe(2);
		expect(
			cameraForBounds({ x: 0, y: 0, width: 90_000, height: 90_000 }, size).zoom,
		).toBe(0.2);
	});

	it("takes the union of blocks and marks", () => {
		expect(unionRects([])).toBeNull();
		expect(
			unionRects([
				{ x: 0, y: 0, width: 10, height: 10 },
				{ x: 50, y: -20, width: 10, height: 10 },
			]),
		).toEqual({ x: 0, y: -20, width: 60, height: 30 });
	});
});

describe("exporting a board", () => {
	it("goes in the order: camera, posters, picture, undo, keep", async () => {
		const { input, events, camera } = harness();
		const result = await exportBoardPng(input);
		expect(events).toEqual([
			"camera 0.91",
			"frame",
			"mount ",
			"frame",
			"draw",
			"unmount",
			"camera 0.70",
			"upload",
		]);
		expect(result).toMatchObject({
			fileId: "export-1",
			width: 800,
			height: 600,
		});
		expect(camera()).toEqual({ x: 12, y: 34, zoom: 0.7 });
	});

	it("draws the viewport's own element at the picture's size, from the camera that fits the content, on the page's colour", async () => {
		const { input } = harness();
		await exportBoardPng(input);
		const [element, options] = (input.toPng as ReturnType<typeof vi.fn>).mock
			.calls[0] as [
			HTMLElement,
			Record<string, unknown> & { style: Record<string, string> },
		];
		expect(element).toBe(input.viewportEl);
		expect(options).toMatchObject({ width: 800, height: 600, pixelRatio: 1 });
		expect(typeof options.backgroundColor).toBe("string");
		expect(options.style.width).toBe("800px");
		expect(options.style.transform).toMatch(/^translate\(.+px, .+px\) scale\(/);
		expect(typeof options.filter).toBe("function");
	});

	it("names every block drawn as a card, and tells the board which ones", async () => {
		const nodes = [
			sticky("a", 0, 0),
			app("b", 400, 0),
			map("c", 900, 0),
			app("d", 0, 400, true),
		];
		const { input, events } = harness({ nodes });
		const result = await exportBoardPng(input);
		expect(result.missingPosters).toEqual([
			{ nodeId: "b", title: "App b" },
			{ nodeId: "c", title: "Cork → Kinsale" },
		]);
		expect(events).toContain("mount b,c");
	});

	it("has nothing to name when every block that needs one has its poster", async () => {
		const { input } = harness();
		expect((await exportBoardPng(input)).missingPosters).toEqual([]);
	});

	it("includes the marks in what it draws", async () => {
		const nodes = [sticky("a", 0, 0)];
		const { input } = harness({ nodes });
		input.body.annotations = [
			{
				id: "pen-1",
				kind: "pen",
				color: "var(--ink-blue)",
				size: 4,
				points: [
					{ x: 3000, y: 2000 },
					{ x: 3100, y: 2100 },
				],
			},
		];
		await exportBoardPng(input);
		const options = (
			(input.toPng as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[]
		)[1] as { style: { transform: string } };
		// The camera is far from the origin only if the far mark is part of the bounds.
		expect(options.style.transform).toMatch(/scale\(0\.[0-9]+\)/);
	});

	it("refuses an empty board rather than saving a blank picture, and touches nothing", async () => {
		const { input, events } = harness({ nodes: [] });
		await expect(exportBoardPng(input)).rejects.toMatchObject({
			reason: "empty",
		});
		expect(events).toEqual([]);
		expect(input.upload).not.toHaveBeenCalled();
	});
});

describe("a picture that fails leaves the board as it was", () => {
	const remembered: Camera = { x: 12, y: 34, zoom: 0.7 };

	it("puts the camera back and takes the posters off when the renderer throws", async () => {
		const { input, events, camera } = harness({
			toPng: (async () => {
				throw new Error("Failed to clone iframe");
			}) as never,
		});
		await expect(exportBoardPng(input)).rejects.toMatchObject({
			reason: "draw",
		});
		expect(camera()).toEqual(remembered);
		expect(input.getViewport()).toEqual(remembered);
		expect(input.unmountPosters).toHaveBeenCalledOnce();
		expect(events.at(-1)).toBe("camera 0.70");
		expect(input.upload).not.toHaveBeenCalled();
	});

	it("puts the camera back and takes the posters off when mounting them throws", async () => {
		const { input, camera } = harness({
			mountPosters: vi.fn(async () => {
				throw new Error("no poster layer");
			}),
		});
		await expect(exportBoardPng(input)).rejects.toBeInstanceOf(ExportError);
		expect(camera()).toEqual(remembered);
		expect(input.unmountPosters).toHaveBeenCalledOnce();
	});

	it("puts the camera back when moving it throws half way", async () => {
		let moves = 0;
		const { input, camera } = harness();
		const original = input.setViewport;
		input.setViewport = vi.fn(async (next: Camera, options) => {
			moves += 1;
			await original(next, options);
			if (moves === 1) throw new Error("interrupted");
		});
		await expect(exportBoardPng(input)).rejects.toBeInstanceOf(ExportError);
		expect(camera()).toEqual(remembered);
		expect(input.unmountPosters).toHaveBeenCalledOnce();
	});

	it("still takes the camera back when taking the posters off throws", async () => {
		const { input, camera } = harness({
			unmountPosters: vi.fn(() => {
				throw new Error("gone already");
			}),
		});
		await expect(exportBoardPng(input)).rejects.toThrow("gone already");
		expect(camera()).toEqual(remembered);
	});

	it("does not leave the board rearranged when the picture could not be kept", async () => {
		const { input, camera } = harness({
			upload: vi.fn(async () => ({
				ok: false as const,
				reason: "too_large" as const,
			})),
		});
		await expect(exportBoardPng(input)).rejects.toMatchObject({
			reason: "upload",
			uploadReason: "too_large",
		});
		expect(camera()).toEqual(remembered);
		expect(input.unmountPosters).toHaveBeenCalledOnce();
	});
});
