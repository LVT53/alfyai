import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	afterPress,
	HOLD_MS,
	type TouchSelectionApi,
	watchTouchSelection,
} from "./touch-select";

describe("afterPress", () => {
	it("a long press adds the block, and never takes one out", () => {
		expect(afterPress(["a"], "b", true)).toEqual(["a", "b"]);
		expect(afterPress(["a", "b"], "b", true)).toEqual(["a", "b"]);
	});

	it("a tap in the picking mode adds an unpicked block and takes out a picked one", () => {
		expect(afterPress(["a"], "b", false)).toEqual(["a", "b"]);
		expect(afterPress(["a", "b"], "a", false)).toEqual(["b"]);
		expect(afterPress(["a"], "a", false)).toEqual([]);
	});
});

describe("watchTouchSelection", () => {
	let root: HTMLElement;
	let picked: string[];
	let api: TouchSelectionApi;
	let stop: () => void;

	function finger(
		target: Element,
		type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
		at = { x: 10, y: 10 },
		pointerType = "touch",
	) {
		const event = new MouseEvent(type, {
			bubbles: true,
			clientX: at.x,
			clientY: at.y,
		});
		Object.defineProperty(event, "pointerType", { value: pointerType });
		Object.defineProperty(event, "isPrimary", { value: true });
		target.dispatchEvent(event);
	}

	const blockEl = (id: string) =>
		root.querySelector(`[data-id="${id}"] .inner`) as Element;

	/** What the library does before the lift: it replaces the selection with the touched block. */
	function press(id: string, holdMs: number, at = { x: 10, y: 10 }) {
		finger(blockEl(id), "pointerdown", at);
		picked = [id];
		vi.advanceTimersByTime(holdMs);
		finger(blockEl(id), "pointerup", at);
		vi.advanceTimersByTime(5);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		root = document.createElement("div");
		root.innerHTML = ["a", "b", "c"]
			.map(
				(id) =>
					`<div class="svelte-flow__node" data-id="${id}"><div class="inner"><button class="tick">x</button></div></div>`,
			)
			.join("");
		document.body.append(root);
		picked = [];
		api = {
			selected: () => picked,
			select: vi.fn((ids: string[]) => {
				picked = ids;
			}),
			enabled: () => true,
			announce: vi.fn(),
			hint: () => "Selection started.",
		};
		stop = watchTouchSelection(root, api);
	});

	afterEach(() => {
		stop();
		root.remove();
		vi.useRealTimers();
	});

	it("leaves a plain tap to the library", () => {
		picked = ["a"];
		press("b", 50);
		expect(api.select).not.toHaveBeenCalled();
	});

	it("starts a selection with a long press, adding to what was picked, and says so", () => {
		picked = ["a"];
		press("b", HOLD_MS + 20);
		expect(api.announce).toHaveBeenCalledWith("Selection started.");
		expect(api.select).toHaveBeenLastCalledWith(["a", "b"]);
		expect(picked).toEqual(["a", "b"]);
	});

	it("then a tap adds a block, and a tap on a picked one takes it out", () => {
		picked = ["a"];
		press("b", HOLD_MS + 20);
		press("c", 40);
		expect(picked).toEqual(["a", "b", "c"]);
		press("b", 40);
		expect(picked).toEqual(["a", "c"]);
	});

	it("ends the mode when nothing is picked any more: a tap is the library's again", () => {
		picked = [];
		press("a", HOLD_MS + 20);
		expect(picked).toEqual(["a"]);
		// The board puts everything down (a tap on the empty board does).
		picked = [];
		(api.select as ReturnType<typeof vi.fn>).mockClear();
		press("b", 40);
		expect(api.select).not.toHaveBeenCalled();
	});

	it("takes a finger that travels for a drag, never a pick", () => {
		picked = [];
		finger(blockEl("a"), "pointerdown", { x: 10, y: 10 });
		finger(blockEl("a"), "pointermove", { x: 10, y: 40 });
		vi.advanceTimersByTime(HOLD_MS + 50);
		finger(blockEl("a"), "pointerup", { x: 10, y: 40 });
		vi.advanceTimersByTime(5);
		expect(api.announce).not.toHaveBeenCalled();
		expect(api.select).not.toHaveBeenCalled();
	});

	it("ignores a mouse, a press on a control, and a board that cannot change", () => {
		finger(blockEl("a"), "pointerdown", { x: 1, y: 1 }, "mouse");
		vi.advanceTimersByTime(HOLD_MS + 50);
		finger(blockEl("a"), "pointerup", { x: 1, y: 1 }, "mouse");
		const tick = root.querySelector('[data-id="b"] .tick') as Element;
		finger(tick, "pointerdown");
		vi.advanceTimersByTime(HOLD_MS + 50);
		finger(tick, "pointerup");
		api.enabled = () => false;
		finger(blockEl("c"), "pointerdown");
		vi.advanceTimersByTime(HOLD_MS + 50);
		finger(blockEl("c"), "pointerup");
		vi.advanceTimersByTime(5);
		expect(api.select).not.toHaveBeenCalled();
		expect(api.announce).not.toHaveBeenCalled();
	});

	it("lets go of the board when it is stopped", () => {
		stop();
		finger(blockEl("a"), "pointerdown");
		vi.advanceTimersByTime(HOLD_MS + 50);
		finger(blockEl("a"), "pointerup");
		vi.advanceTimersByTime(5);
		expect(api.announce).not.toHaveBeenCalled();
	});
});
