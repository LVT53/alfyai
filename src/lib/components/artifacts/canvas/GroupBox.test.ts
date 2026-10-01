import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { uiLanguage } from "$lib/stores/settings";
import GroupBox from "./GroupBox.svelte";

// The box round several picked blocks, on its own, on a board whose screen and board
// coordinates are the same (zoom 1, no pan). What a real finger and a real pointer do
// to it, and that the library's own marquee and drag stay out of its way, is the
// e2e's (artifact-canvas-multi-select.spec.ts); the arithmetic is group-scale.test.ts.

beforeEach(() => {
	uiLanguage.set("en");
	// jsdom has neither pointer capture nor PointerEvent.
	Element.prototype.setPointerCapture = vi.fn();
	if (!("PointerEvent" in globalThis)) {
		class TestPointerEvent extends MouseEvent {
			pointerId: number;
			pointerType: string;
			constructor(type: string, init: Record<string, unknown> = {}) {
				super(type, init as MouseEventInit);
				this.pointerId = (init.pointerId as number | undefined) ?? 1;
				this.pointerType = (init.pointerType as string | undefined) ?? "mouse";
			}
		}
		Object.assign(globalThis, { PointerEvent: TestPointerEvent });
	}
});
afterEach(() => cleanup());

function sticky(
	id: string,
	x: number,
	y: number,
	selected: boolean,
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 200,
		height: 100,
		measured: { width: 200, height: 100 },
		selected,
		data: { kind: "sticky", text: id, tone: "yellow" },
	} as CanvasNode;
}

const BOARD = [
	sticky("a", 100, 100, true),
	sticky("b", 400, 100, true),
	sticky("c", 100, 300, true),
	sticky("d", 700, 700, false),
];

function mount(props: Record<string, unknown> = {}) {
	const callbacks = {
		onresizestart: vi.fn(),
		onresize: vi.fn(),
		onresizeend: vi.fn(),
		ondelete: vi.fn(),
		onclear: vi.fn(),
		onannounce: vi.fn(),
	};
	const view = render(GroupBox, {
		nodes: BOARD,
		viewport: { x: 0, y: 0, zoom: 1 },
		size: { width: 1000, height: 800 },
		coarse: false,
		...callbacks,
		...props,
	} as never);
	return { ...view, ...callbacks };
}

const handle = (name: string) =>
	screen.getByTestId(`canvas-group-handle-${name}`);

function pointer(
	element: Element,
	type: "pointerDown" | "pointerMove" | "pointerUp",
	at: { x: number; y: number },
) {
	return fireEvent[type](element, {
		clientX: at.x,
		clientY: at.y,
		pointerId: 1,
		pointerType: "mouse",
		button: 0,
	});
}

describe("the box", () => {
	it("is drawn round the picked blocks with eight handles, a count and a Delete", () => {
		mount();
		expect(screen.getByTestId("canvas-group-box")).toBeTruthy();
		for (const name of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
			expect(handle(name)).toBeTruthy();
		}
		expect(
			screen.getByRole("toolbar", { name: "3 blocks selected" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Delete 3 blocks" }),
		).toBeTruthy();
	});

	it("is nothing for one block, or none", () => {
		mount({ nodes: [sticky("a", 0, 0, true), sticky("b", 300, 0, false)] });
		expect(screen.queryByTestId("canvas-group-box")).toBeNull();
		expect(screen.queryByRole("toolbar")).toBeNull();
	});

	it("tells a screen reader how many are picked, once per change", async () => {
		const { onannounce, rerender } = mount();
		await tick();
		expect(onannounce).toHaveBeenCalledWith("3 blocks selected");
		onannounce.mockClear();
		await rerender({
			nodes: BOARD.map((node) =>
				node.id === "d" ? { ...node, selected: true } : node,
			),
		});
		expect(onannounce).toHaveBeenCalledWith("4 blocks selected");
	});

	it("on a finger has no edge handle on a side too short for two fingertips", () => {
		// Two blocks 500 px wide and 100 tall: wide enough for top and bottom, not for the sides.
		mount({
			coarse: true,
			nodes: [sticky("a", 100, 100, true), sticky("b", 400, 100, true)],
		});
		expect(screen.queryByTestId("canvas-group-handle-n")).toBeTruthy();
		expect(screen.queryByTestId("canvas-group-handle-w")).toBeNull();
		expect(screen.queryByTestId("canvas-group-handle-se")).toBeTruthy();
	});

	it("Delete hands over every picked id", async () => {
		const { ondelete } = mount();
		await fireEvent.click(
			screen.getByRole("button", { name: "Delete 3 blocks" }),
		);
		expect(ondelete).toHaveBeenCalledWith(["a", "b", "c"]);
	});
});

describe("a handle", () => {
	it("scales the blocks with the pointer, from where it was taken, and ends as one gesture", async () => {
		const { onresizestart, onresize, onresizeend } = mount();
		const grip = handle("se");
		await pointer(grip, "pointerDown", { x: 600, y: 400 });
		expect(onresizestart).toHaveBeenCalledTimes(1);
		await pointer(grip, "pointerMove", { x: 750, y: 500 });
		// The box was x 100..600, y 100..400 (500 x 300): 650 x 400 is x1.3 and x1.333.
		const patches = onresize.mock.lastCall?.[0] as Map<
			string,
			{ width: number }
		>;
		expect(patches.get("a")?.width).toBe(260);
		expect(patches.get("b")?.width).toBe(260);
		expect(patches.has("d")).toBe(false);
		expect(onresizeend).not.toHaveBeenCalled();
		await pointer(grip, "pointerUp", { x: 750, y: 500 });
		expect(onresizeend).toHaveBeenCalledTimes(1);
		// A further move after the let-go does nothing.
		onresize.mockClear();
		await pointer(grip, "pointerMove", { x: 900, y: 600 });
		expect(onresize).not.toHaveBeenCalled();
	});

	it("takes an edge handle's drag one way only", async () => {
		const { onresize } = mount();
		await pointer(handle("s"), "pointerDown", { x: 350, y: 400 });
		await pointer(handle("s"), "pointerMove", { x: 900, y: 500 });
		const patches = onresize.mock.lastCall?.[0] as Map<
			string,
			{ width: number; height: number }
		>;
		expect(patches.get("a")?.width).toBe(200);
		expect(patches.get("a")?.height).toBe(133);
	});

	it("Escape in the drag puts every block back as it was and ends the gesture", async () => {
		const { onresize, onresizeend, onclear } = mount();
		const grip = handle("se");
		await pointer(grip, "pointerDown", { x: 600, y: 400 });
		await pointer(grip, "pointerMove", { x: 750, y: 500 });
		await fireEvent.keyDown(window, { key: "Escape" });
		const restored = onresize.mock.lastCall?.[0] as Map<
			string,
			{ position: { x: number; y: number }; width: number; height: number }
		>;
		expect(restored.get("b")).toEqual({
			position: { x: 400, y: 100 },
			width: 200,
			height: 100,
		});
		expect(onresizeend).toHaveBeenCalledTimes(1);
		// Escape cancelled the gesture and nothing more: the selection stays.
		expect(onclear).not.toHaveBeenCalled();
	});

	it("puts a block that had no size of its own back without one", async () => {
		const bare = BOARD.map((node) => ({
			...node,
			width: undefined,
			height: undefined,
		}));
		const { onresize } = mount({ nodes: bare });
		await pointer(handle("se"), "pointerDown", { x: 600, y: 400 });
		await pointer(handle("se"), "pointerMove", { x: 700, y: 450 });
		await fireEvent.keyDown(window, { key: "Escape" });
		const restored = onresize.mock.lastCall?.[0] as Map<
			string,
			{ width: number | undefined }
		>;
		expect(restored.get("a")?.width).toBeUndefined();
	});
});

describe("Escape", () => {
	it("puts the selection down when no handle is held", async () => {
		const { onclear } = mount();
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onclear).toHaveBeenCalledTimes(1);
	});

	it("is the text field's own when the reader is typing in one", async () => {
		const field = document.createElement("textarea");
		document.body.append(field);
		const { onclear } = mount();
		await fireEvent.keyDown(field, { key: "Escape" });
		expect(onclear).not.toHaveBeenCalled();
		field.remove();
	});
});
