import { describe, expect, it, vi } from "vitest";
import { nextTap, pinchZoom, zoomFrom } from "./pinch-zoom";

describe("zoomFrom", () => {
	it("scales with the distance between the two fingers", () => {
		expect(zoomFrom({ distance: 100, scale: 1 }, { distance: 200 })).toBe(2);
	});

	it("never zooms in past 4x or out past 1x", () => {
		expect(zoomFrom({ distance: 100, scale: 1 }, { distance: 500 })).toBe(4);
		expect(zoomFrom({ distance: 100, scale: 1 }, { distance: 50 })).toBe(1);
	});

	it("starts from the scale the pinch began at", () => {
		expect(zoomFrom({ distance: 100, scale: 2 }, { distance: 150 })).toBe(3);
	});

	it("keeps the scale when the start distance is nothing", () => {
		expect(zoomFrom({ distance: 0, scale: 2 }, { distance: 150 })).toBe(2);
	});
});

describe("pinchZoom", () => {
	function pointer(
		type: string,
		id: number,
		x: number,
		y = 0,
		options: { pointerType?: string; timeStamp?: number } = {},
	): Event {
		const event = new MouseEvent(type, {
			bubbles: true,
			clientX: x,
			clientY: y,
		});
		Object.defineProperty(event, "pointerId", { value: id });
		Object.defineProperty(event, "pointerType", {
			value: options.pointerType ?? "touch",
		});
		if (options.timeStamp !== undefined) {
			Object.defineProperty(event, "timeStamp", { value: options.timeStamp });
		}
		return event;
	}

	const frame = () =>
		new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

	function stage() {
		const node = document.createElement("div");
		const target = document.createElement("div");
		target.dataset.pinchTarget = "";
		node.append(target);
		document.body.append(node);
		return { node, target };
	}

	it("zooms with two fingers, touch-action off on the stage alone, and the pinch stops at the stage", async () => {
		const { node, target } = stage();
		const action = pinchZoom(node, { enabled: true });
		expect(node.style.touchAction).toBe("none");
		const above = vi.fn();
		document.body.addEventListener("pointermove", above);

		node.dispatchEvent(pointer("pointerdown", 1, -40));
		node.dispatchEvent(pointer("pointerdown", 2, 40));
		node.dispatchEvent(pointer("pointermove", 1, -80));
		node.dispatchEvent(pointer("pointermove", 2, 80));
		await frame();
		expect(target.style.transform).toContain("scale(2)");
		expect(above).not.toHaveBeenCalled();

		node.dispatchEvent(pointer("pointerup", 2, 80));
		node.dispatchEvent(pointer("pointerup", 1, -80));
		await frame();
		expect(target.style.transform).toContain("scale(2)");

		document.body.removeEventListener("pointermove", above);
		action.destroy?.();
		expect(node.style.touchAction).toBe("");
		await frame();
		expect(target.style.transform).toBe("");
		node.remove();
	});

	it("goes back to 1x on a double tap, and leaves one finger and a mouse alone", async () => {
		const { node, target } = stage();
		const action = pinchZoom(node, { enabled: true });
		node.dispatchEvent(pointer("pointerdown", 1, -40));
		node.dispatchEvent(pointer("pointerdown", 2, 40));
		node.dispatchEvent(pointer("pointermove", 2, 120));
		node.dispatchEvent(pointer("pointerup", 2, 120));
		node.dispatchEvent(pointer("pointerup", 1, -40));
		await frame();
		const zoomed = target.style.transform;
		expect(zoomed).toContain("scale(");

		// One finger dragging, and a mouse: nothing moves (the Mark tool's).
		node.dispatchEvent(pointer("pointerdown", 3, 0, 0, { timeStamp: 1000 }));
		node.dispatchEvent(pointer("pointermove", 3, 60));
		node.dispatchEvent(pointer("pointerup", 3, 60, 0, { timeStamp: 1100 }));
		node.dispatchEvent(
			pointer("pointerdown", 4, 0, 0, { pointerType: "mouse" }),
		);
		await frame();
		expect(target.style.transform).toBe(zoomed);

		node.dispatchEvent(pointer("pointerdown", 5, 10, 10, { timeStamp: 2000 }));
		node.dispatchEvent(pointer("pointerup", 5, 10, 10, { timeStamp: 2050 }));
		node.dispatchEvent(pointer("pointerdown", 6, 12, 10, { timeStamp: 2200 }));
		node.dispatchEvent(pointer("pointerup", 6, 12, 10, { timeStamp: 2250 }));
		await frame();
		expect(target.style.transform).toBe("");
		expect(target.style.transition).toContain("transform");
		action.destroy?.();
		node.remove();
	});

	it("keeps the zoom on a double tap while the Mark tool has the finger", async () => {
		const { node, target } = stage();
		const action = pinchZoom(node, { enabled: true, doubleTapReset: false });
		node.dispatchEvent(pointer("pointerdown", 1, -40));
		node.dispatchEvent(pointer("pointerdown", 2, 40));
		node.dispatchEvent(pointer("pointermove", 2, 120));
		node.dispatchEvent(pointer("pointerup", 2, 120));
		node.dispatchEvent(pointer("pointerup", 1, -40));
		await frame();
		const zoomed = target.style.transform;
		expect(zoomed).toContain("scale(");
		// Two taps removing two marks: the picture stays where it is.
		node.dispatchEvent(pointer("pointerdown", 5, 10, 10, { timeStamp: 2000 }));
		node.dispatchEvent(pointer("pointerup", 5, 10, 10, { timeStamp: 2050 }));
		node.dispatchEvent(pointer("pointerdown", 6, 12, 10, { timeStamp: 2200 }));
		node.dispatchEvent(pointer("pointerup", 6, 12, 10, { timeStamp: 2250 }));
		await frame();
		expect(target.style.transform).toBe(zoomed);
		// Mark off again: a double tap resets as before.
		action.update?.({ enabled: true, doubleTapReset: true });
		node.dispatchEvent(pointer("pointerdown", 7, 10, 10, { timeStamp: 3000 }));
		node.dispatchEvent(pointer("pointerup", 7, 10, 10, { timeStamp: 3050 }));
		node.dispatchEvent(pointer("pointerdown", 8, 12, 10, { timeStamp: 3200 }));
		node.dispatchEvent(pointer("pointerup", 8, 12, 10, { timeStamp: 3250 }));
		await frame();
		expect(target.style.transform).toBe("");
		action.destroy?.();
		node.remove();
	});

	it("turns on and off with its option", () => {
		const { node } = stage();
		const action = pinchZoom(node, { enabled: false });
		expect(node.style.touchAction).toBe("");
		action.update?.({ enabled: true });
		expect(node.style.touchAction).toBe("none");
		action.update?.({ enabled: false });
		expect(node.style.touchAction).toBe("");
		node.remove();
	});
});

describe("pinchZoom and a new picture", () => {
	it("goes back to 1x when the picture it zooms is another one (a new version landed)", async () => {
		const node = document.createElement("div");
		const target = document.createElement("div");
		target.dataset.pinchTarget = "";
		node.append(target);
		document.body.append(node);
		const action = pinchZoom(node, { enabled: true, resetKey: "file-1" });
		const touch = (type: string, id: number, x: number) => {
			const event = new MouseEvent(type, { bubbles: true, clientX: x });
			Object.defineProperty(event, "pointerId", { value: id });
			Object.defineProperty(event, "pointerType", { value: "touch" });
			node.dispatchEvent(event);
		};
		touch("pointerdown", 1, -40);
		touch("pointerdown", 2, 40);
		touch("pointermove", 2, 120);
		touch("pointerup", 2, 120);
		touch("pointerup", 1, -40);
		await new Promise((resolve) => requestAnimationFrame(resolve));
		expect(target.style.transform).toContain("scale(");

		action.update?.({ enabled: true, resetKey: "file-1" });
		expect(target.style.transform).toContain("scale(");
		action.update?.({ enabled: true, resetKey: "file-2" });
		expect(target.style.transform).toBe("");
		action.destroy?.();
		node.remove();
	});
});

describe("nextTap", () => {
	const at = (time: number, x = 100) => ({ at: time, point: { x, y: 100 } });

	it("makes a double tap of two taps close in time and place, and starts afresh after it", () => {
		const first = nextTap(null, at(0));
		expect(first).toEqual({ double: false, last: at(0) });
		const second = nextTap(first.last, at(200, 110));
		expect(second).toEqual({ double: true, last: null });
	});

	it("does not make a double tap of taps too far apart in time or place", () => {
		expect(nextTap(at(0), at(400)).double).toBe(false);
		expect(nextTap(at(0), at(100, 200)).double).toBe(false);
	});
});
