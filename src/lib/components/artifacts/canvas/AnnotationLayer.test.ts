import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "$lib/shared/artifacts/canvas";
import { MAX_ANNOTATIONS_PER_BOARD } from "$lib/shared/artifacts/canvas-body";
import { uiLanguage } from "$lib/stores/settings";
import type { Tool } from "./_lib/annotations";
import AnnotationLayer from "./AnnotationLayer.svelte";

// The layer is drawn on its own here, on a board whose screen and board
// coordinates are the same (identity conversion, zoom 1): what a pointer does
// to it is what it hands the board, and what it looks like to the keyboard and
// a screen reader. The stacking against real blocks and the pad's coverage of a
// real pane are the e2e's (artifact-canvas-draw.spec.ts).

beforeAll(() => {
	// jsdom has no pointer capture; the layer asks for it on the pad and on a mark.
	Element.prototype.setPointerCapture = vi.fn();
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
	uiLanguage.set("en");
});

const pen = (id: string, from: number, to: number): Annotation => ({
	id,
	kind: "pen",
	color: "var(--ink-blue)",
	size: 4,
	points: [
		{ x: from, y: 100 },
		{ x: (from + to) / 2, y: 100 },
		{ x: to, y: 100 },
	],
});

const text = (id: string): Annotation => ({
	id,
	kind: "text",
	color: "var(--ink-red)",
	size: 20,
	at: { x: 50, y: 60 },
	text: "Ferry at 9",
});

function mount(
	props: Partial<{
		annotations: Annotation[];
		tool: Tool;
		ink: string;
		readonly: boolean;
		viewport: { x: number; y: number; zoom: number };
		paneSize: { width: number; height: number };
	}> = {},
) {
	const callbacks = {
		onchange: vi.fn(),
		ontoolchange: vi.fn(),
		onannounce: vi.fn(),
		onlimit: vi.fn(),
	};
	const view = render(AnnotationLayer, {
		annotations: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		paneSize: { width: 800, height: 600 },
		tool: "select",
		ink: "var(--ink-blue)",
		toBoard: (point: { x: number; y: number }) => point,
		...callbacks,
		...props,
	});
	return { ...view, ...callbacks };
}

const layer = () => screen.getByRole("application", { name: "Drawing layer" });

function pointer(
	type: "pointerDown" | "pointerMove" | "pointerUp",
	x: number,
	y: number,
	id = 1,
) {
	return fireEvent[type](layer(), {
		clientX: x,
		clientY: y,
		pointerId: id,
		pointerType: "mouse",
		button: 0,
		isPrimary: true,
	});
}

describe("the pad", () => {
	it("leaves the pointer to the board while Select is active, and takes it while a tool draws", async () => {
		const select = mount({ tool: "select" });
		// Inline, on the element that owns it: a rule written from an ancestor never matches a portal's content.
		expect(layer().style.pointerEvents).toBe("none");
		select.unmount();
		mount({ tool: "pen" });
		expect(layer().style.pointerEvents).toBe("auto");
	});

	it("stays out of the way when the board cannot change, whatever the tool", () => {
		mount({ tool: "pen", readonly: true });
		expect(layer().style.pointerEvents).toBe("none");
	});

	it("sits above a frame's children (z-index 2), where the library puts them at 1", () => {
		mount({ tool: "pen" });
		expect(layer().style.zIndex).toBe("2");
		const root = screen.getByTestId("canvas-annotations");
		expect(root.style.zIndex).toBe("2");
	});

	it("is sized from the visible pane and the camera, in board units, and reaches a little past it", () => {
		mount({
			tool: "pen",
			viewport: { x: -200, y: -100, zoom: 2 },
			paneSize: { width: 800, height: 600 },
		});
		// The pane shows board x 100..500, y 50..350; a 24 px margin at zoom 2 is 12 board units.
		expect(layer().style.left).toBe("88px");
		expect(layer().style.top).toBe("38px");
		expect(layer().style.width).toBe("424px");
		expect(layer().style.height).toBe("324px");
	});

	it("falls back to the whole box until the pane has been measured", () => {
		mount({ tool: "pen", paneSize: { width: 0, height: 0 } });
		expect(layer().style.width).toBe("100%");
		expect(layer().style.height).toBe("100%");
	});
});

describe("the layer as one place for the keyboard and a screen reader", () => {
	it("is an application region with a name, and says how many marks it holds", () => {
		mount({ annotations: [pen("a", 0, 40), pen("b", 0, 40)], tool: "select" });
		const description = layer().getAttribute("aria-describedby");
		expect(description).toBeTruthy();
		expect(document.getElementById(description as string)?.textContent).toBe(
			"2 marks drawn on the board.",
		);
	});

	it("is exactly one tab stop, and only while there is something for it to do", () => {
		const empty = mount({ tool: "select" });
		expect(layer().getAttribute("tabindex")).toBe("-1");
		empty.unmount();
		const withMarks = mount({ annotations: [pen("a", 0, 40)], tool: "select" });
		expect(layer().getAttribute("tabindex")).toBe("0");
		expect(
			screen
				.getByTestId("canvas-annotations")
				.querySelectorAll('[tabindex="0"]'),
		).toHaveLength(1);
		withMarks.unmount();
		mount({ tool: "pen" });
		expect(layer().getAttribute("tabindex")).toBe("0");
	});
});

describe("drawing", () => {
	it("hands over a pen stroke whole, once, when the pointer lets go: one gesture, not one point", async () => {
		const { onchange } = mount({ tool: "pen" });
		await pointer("pointerDown", 10, 10);
		for (let i = 1; i <= 12; i += 1)
			await pointer("pointerMove", 10 + i * 6, 10 + i * 2);
		expect(onchange).not.toHaveBeenCalled();
		await pointer("pointerUp", 82, 34);
		expect(onchange).toHaveBeenCalledTimes(1);
		const [next] = onchange.mock.calls[0] as [Annotation[]];
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({
			kind: "pen",
			color: "var(--ink-blue)",
			size: 4,
		});
		expect(next[0].id).toMatch(/^pen-/);
		expect(next[0].points?.length).toBeGreaterThan(6);
		expect(next[0].points?.[0]).toEqual({ x: 10, y: 10 });
	});

	it("draws in the ink it was given, at the size of the tool", async () => {
		const { onchange } = mount({
			tool: "highlighter",
			ink: "var(--ink-green)",
		});
		await pointer("pointerDown", 10, 10);
		await pointer("pointerMove", 60, 10);
		await pointer("pointerUp", 60, 10);
		const [next] = onchange.mock.calls[0] as [Annotation[]];
		expect(next[0]).toMatchObject({
			kind: "highlighter",
			color: "var(--ink-green)",
			size: 14,
		});
	});

	it("leaves a dot for a click with the pen", async () => {
		const { onchange } = mount({ tool: "pen" });
		await pointer("pointerDown", 30, 40);
		await pointer("pointerUp", 30, 40);
		const [next] = onchange.mock.calls[0] as [Annotation[]];
		expect(next[0].points).toEqual([{ x: 30, y: 40 }]);
	});

	it("draws a shape from the corner it began at to the one it ended at, and leaves nothing for a click", async () => {
		const { onchange } = mount({ tool: "rect" });
		await pointer("pointerDown", 10, 20);
		await pointer("pointerMove", 90, 70);
		await pointer("pointerUp", 90, 70);
		const [next] = onchange.mock.calls[0] as [Annotation[]];
		expect(next[0]).toMatchObject({
			kind: "rect",
			from: { x: 10, y: 20 },
			to: { x: 90, y: 70 },
		});

		onchange.mockClear();
		await pointer("pointerDown", 200, 200);
		await pointer("pointerUp", 201, 200);
		expect(onchange).not.toHaveBeenCalled();
	});

	it("drops the stroke when a second finger lands: that is a pinch, and it leaves no mark", async () => {
		const { onchange } = mount({ tool: "pen" });
		await pointer("pointerDown", 10, 10, 1);
		await pointer("pointerMove", 40, 30, 1);
		await pointer("pointerDown", 200, 200, 2);
		await pointer("pointerMove", 60, 40, 1);
		await pointer("pointerUp", 60, 40, 1);
		await pointer("pointerUp", 200, 200, 2);
		expect(onchange).not.toHaveBeenCalled();
	});

	it("ignores the middle and right buttons, which pan", async () => {
		const { onchange } = mount({ tool: "pen" });
		await fireEvent.pointerDown(layer(), {
			clientX: 10,
			clientY: 10,
			pointerId: 1,
			pointerType: "mouse",
			button: 1,
		});
		await fireEvent.pointerUp(layer(), {
			clientX: 10,
			clientY: 10,
			pointerId: 1,
			pointerType: "mouse",
			button: 1,
		});
		expect(onchange).not.toHaveBeenCalled();
	});

	it("says so, and adds nothing, when the board holds as many marks as it may", async () => {
		const full = Array.from({ length: MAX_ANNOTATIONS_PER_BOARD }, (_, i) =>
			pen(`p${i}`, 0, 10),
		);
		const { onchange, onlimit } = mount({ tool: "pen", annotations: full });
		await pointer("pointerDown", 10, 10);
		await pointer("pointerMove", 60, 10);
		await pointer("pointerUp", 60, 10);
		expect(onchange).not.toHaveBeenCalled();
		expect(onlimit).toHaveBeenCalledTimes(1);
	});

	it("draws nothing at all on a board that cannot change", async () => {
		const { onchange } = mount({ tool: "pen", readonly: true });
		await pointer("pointerDown", 10, 10);
		await pointer("pointerUp", 60, 10);
		expect(onchange).not.toHaveBeenCalled();
	});
});

describe("erasing", () => {
	it("removes every whole mark the sweep crossed, and only those, as one change", async () => {
		const marks = [pen("a", 0, 100), pen("b", 0, 100)];
		marks[1] = {
			...marks[1],
			points: marks[1].points?.map((p) => ({ ...p, y: 300 })),
		};
		const { onchange } = mount({ tool: "eraser", annotations: marks });
		await pointer("pointerDown", 50, 80);
		await pointer("pointerMove", 50, 120);
		expect(onchange).not.toHaveBeenCalled();
		await pointer("pointerUp", 50, 120);
		expect(onchange).toHaveBeenCalledTimes(1);
		expect(
			(onchange.mock.calls[0][0] as Annotation[]).map((m) => m.id),
		).toEqual(["b"]);
	});

	it("changes nothing for a sweep that crossed nothing", async () => {
		const { onchange } = mount({
			tool: "eraser",
			annotations: [pen("a", 0, 100)],
		});
		await pointer("pointerDown", 500, 500);
		await pointer("pointerMove", 520, 520);
		await pointer("pointerUp", 520, 520);
		expect(onchange).not.toHaveBeenCalled();
	});
});

describe("the keyboard", () => {
	it("takes Escape first: it leaves a drawing tool, and the panel only closes when the layer has nothing to give up", async () => {
		const { ontoolchange } = mount({ tool: "pen" });
		layer().focus();
		const consumed = !(await fireEvent.keyDown(layer(), { key: "Escape" }));
		expect(consumed).toBe(true);
		expect(ontoolchange).toHaveBeenCalledWith("select");
	});

	it("gives up a stroke in progress before it gives up the tool", async () => {
		const { onchange, ontoolchange } = mount({ tool: "pen" });
		await pointer("pointerDown", 10, 10);
		await pointer("pointerMove", 60, 40);
		await fireEvent.keyDown(layer(), { key: "Escape" });
		await pointer("pointerUp", 60, 40);
		expect(onchange).not.toHaveBeenCalled();
		expect(ontoolchange).not.toHaveBeenCalled();
	});

	it("lets Escape through when there is nothing to give up, so the panel can close", async () => {
		mount({ tool: "select", annotations: [pen("a", 0, 40)] });
		const consumed = !(await fireEvent.keyDown(layer(), { key: "Escape" }));
		expect(consumed).toBe(false);
	});

	it("picks a mark by pressing on it, nudges it by one (ten with Shift), and deletes it", async () => {
		const marks = [pen("a", 0, 100)];
		const { onchange, onannounce } = mount({
			tool: "select",
			annotations: marks,
		});
		const hit = document.querySelector(
			'[data-annotation-id="a"] .hit',
		) as SVGElement;
		expect(hit).toBeTruthy();
		await fireEvent.pointerDown(hit, {
			clientX: 50,
			clientY: 100,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
		});
		await fireEvent.pointerUp(hit, {
			clientX: 50,
			clientY: 100,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
		});
		expect(document.querySelector("[data-annotation-chrome]")).toBeTruthy();
		expect(layer()).toHaveFocus();
		expect(onchange).not.toHaveBeenCalled();

		await fireEvent.keyDown(layer(), { key: "ArrowRight" });
		expect((onchange.mock.calls[0][0] as Annotation[])[0].points?.[0]).toEqual({
			x: 1,
			y: 100,
		});
		await fireEvent.keyDown(layer(), { key: "ArrowDown", shiftKey: true });
		expect((onchange.mock.calls[1][0] as Annotation[])[0].points?.[0]).toEqual({
			x: 0,
			y: 110,
		});

		await fireEvent.keyDown(layer(), { key: "Delete" });
		expect(onchange.mock.calls[2][0]).toEqual([]);
		expect(onannounce).toHaveBeenCalledWith("Mark removed.");
		expect(document.querySelector("[data-annotation-chrome]")).toBeNull();
	});

	it("moves a mark by dragging it, as one change when it is let go", async () => {
		const { onchange } = mount({
			tool: "select",
			annotations: [pen("a", 0, 100)],
		});
		const hit = document.querySelector(
			'[data-annotation-id="a"] .hit',
		) as SVGElement;
		await fireEvent.pointerDown(hit, {
			clientX: 50,
			clientY: 100,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
		});
		await fireEvent.pointerMove(hit, {
			clientX: 90,
			clientY: 130,
			pointerId: 1,
			pointerType: "mouse",
		});
		expect(onchange).not.toHaveBeenCalled();
		await fireEvent.pointerUp(hit, {
			clientX: 90,
			clientY: 130,
			pointerId: 1,
			pointerType: "mouse",
		});
		expect(onchange).toHaveBeenCalledTimes(1);
		expect((onchange.mock.calls[0][0] as Annotation[])[0].points?.[0]).toEqual({
			x: 40,
			y: 130,
		});
	});

	it("does not offer to pick, move or delete anything on a board that cannot change", () => {
		mount({ tool: "select", annotations: [pen("a", 0, 100)], readonly: true });
		expect(document.querySelector('[data-annotation-id="a"] .hit')).toBeNull();
	});
});

describe("text", () => {
	it("places words where the pointer went down, on Enter", async () => {
		const { onchange } = mount({ tool: "text" });
		await pointer("pointerDown", 120, 80);
		await pointer("pointerUp", 120, 80);
		const field = screen.getByRole("textbox", { name: "Text on the board" });
		expect(field).toHaveFocus();
		await fireEvent.input(field, { target: { value: "Ferry at 9" } });
		await fireEvent.keyDown(field, { key: "Enter" });
		expect(onchange).toHaveBeenCalledTimes(1);
		expect((onchange.mock.calls[0][0] as Annotation[])[0]).toMatchObject({
			kind: "text",
			text: "Ferry at 9",
			at: { x: 120, y: 80 },
		});
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("places nothing for empty words, and nothing at all on Escape", async () => {
		const { onchange } = mount({ tool: "text" });
		await pointer("pointerDown", 120, 80);
		await pointer("pointerUp", 120, 80);
		await fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await pointer("pointerDown", 120, 80);
		await pointer("pointerUp", 120, 80);
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "never mind" },
		});
		await fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
		expect(onchange).not.toHaveBeenCalled();
	});

	it("edits words that are already there, in place: same mark, new text", async () => {
		const { onchange } = mount({ tool: "select", annotations: [text("t1")] });
		layer().focus();
		const hit = document.querySelector(
			'[data-annotation-id="t1"] .hit',
		) as SVGElement;
		await fireEvent.pointerDown(hit, {
			clientX: 60,
			clientY: 70,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
		});
		await fireEvent.pointerUp(hit, {
			clientX: 60,
			clientY: 70,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
		});
		await fireEvent.keyDown(layer(), { key: "Enter" });
		const field = screen.getByRole("textbox", {
			name: "Text on the board",
		}) as HTMLInputElement;
		expect(field.value).toBe("Ferry at 9");
		await fireEvent.input(field, { target: { value: "Ferry at 9:30" } });
		await fireEvent.keyDown(field, { key: "Enter" });
		expect((onchange.mock.calls[0][0] as Annotation[])[0]).toMatchObject({
			id: "t1",
			text: "Ferry at 9:30",
			at: { x: 50, y: 60 },
		});
	});

	it("removes words that are emptied out", async () => {
		const { onchange } = mount({ tool: "text", annotations: [text("t1")] });
		await pointer("pointerDown", 60, 70);
		await pointer("pointerUp", 60, 70);
		const field = screen.getByRole("textbox");
		await fireEvent.input(field, { target: { value: "   " } });
		await fireEvent.keyDown(field, { key: "Enter" });
		expect(onchange.mock.calls[0][0]).toEqual([]);
	});
});
