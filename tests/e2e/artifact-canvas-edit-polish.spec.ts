import { expect, test } from "@playwright/test";
import { click } from "./artifact-canvas-edit-helpers";
import {
	centreOf,
	expectCamera,
	openBoard,
	settledCamera,
} from "./artifact-canvas-helpers";

// The loose ends of CV-B (Feature 2 · Canvas, CV-B2). Every flow here is real input:
// a mouse, a finger, the keyboard and the wheel as a laptop's touchpad sends it.

test.describe("the wheel over a note being typed in", () => {
	test("pans the board, and a pinch zooms it, from over the text the reader is typing in", async ({
		page,
	}) => {
		await openBoard(page, "Wheel over a note being typed in");
		const at = await centreOf(page, "note-2");
		await click(page, "mouse", at, 2);
		const field = page.locator('.svelte-flow__node[data-id="note-2"] textarea');
		await expect(field).toBeFocused();
		const start = await settledCamera(page);

		// A two-finger scroll with the pointer on the words being edited (the field's own box, which is only as tall as its words): the board pans.
		const box = await field.boundingBox();
		if (!box) throw new Error("no field");
		const over = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		expect(
			await page.evaluate(
				({ x, y }) => document.elementFromPoint(x, y)?.tagName,
				over,
			),
		).toBe("TEXTAREA");
		await page.mouse.move(over.x, over.y);
		await page.mouse.wheel(40, 90);
		const moved = await settledCamera(page);
		expectCamera(
			moved,
			{ ...start, x: start.x - 40, y: start.y - 90 },
			"a scroll over the field",
		);
		// The reader is still typing where they were.
		await expect(field).toBeFocused();
		await page.keyboard.type("!");
		await expect(field).toHaveValue("Note 2!");

		// A pinch over it zooms the board about the pointer (and not the page).
		await page.keyboard.down("Control");
		await page.mouse.wheel(0, -8);
		await page.keyboard.up("Control");
		const zoomed = await settledCamera(page);
		expect(zoomed.zoom).toBeGreaterThan(moved.zoom * 1.05);
		await expect(field).toBeFocused();
	});
});

test.describe("Safari's pinch", () => {
	test("a trackpad pinch, which Safari reports as a gesture, zooms the board about the pointer and not the page", async ({
		page,
	}) => {
		await openBoard(page, "Safari's pinch");
		const pane = await page.locator(".svelte-flow__pane").boundingBox();
		if (!pane) throw new Error("no pane");
		const at = {
			x: Math.round(pane.x + pane.width - 90),
			y: Math.round(pane.y + 90),
		};
		const start = await settledCamera(page);

		// Chromium has no trackpad gestures of Safari's kind, so this is the one flow whose
		// event is made by the page: a plain event with what Safari's carries (the scale of
		// the gesture so far, and the pointer). What it checks is the wiring on the real board.
		const cancelled = await page.evaluate(({ x, y }) => {
			const target = document.elementFromPoint(x, y);
			const send = (type: string, scale: number) => {
				const event = new Event(type, { bubbles: true, cancelable: true });
				Object.assign(event, { scale, rotation: 0, clientX: x, clientY: y });
				target?.dispatchEvent(event);
				return event.defaultPrevented;
			};
			return [
				send("gesturestart", 1),
				send("gesturechange", 1.2),
				send("gesturechange", 1.5),
				send("gestureend", 1.5),
			];
		}, at);
		expect(cancelled).toEqual([true, true, true, true]);

		const zoomed = await settledCamera(page);
		expect(zoomed.zoom).toBeCloseTo(start.zoom * 1.5, 3);
		// The board point under the pointer stays under it.
		const point = (camera: typeof start) => ({
			x: (at.x - pane.x - camera.x) / camera.zoom,
			y: (at.y - pane.y - camera.y) / camera.zoom,
		});
		expect(point(zoomed).x).toBeCloseTo(point(start).x, 1);
		expect(point(zoomed).y).toBeCloseTo(point(start).y, 1);
	});
});
