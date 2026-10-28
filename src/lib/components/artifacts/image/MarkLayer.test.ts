import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ImageMark, MARK_COLOURS } from "$lib/shared/artifacts/image-body";
import { uiLanguage } from "$lib/stores/settings";
import { MOTION_DURATION } from "$lib/utils/motion";
import MarkLayer from "./MarkLayer.svelte";

/** A pointer event jsdom can carry: a MouseEvent with the pointer's id and type. */
function pointer(
	type: string,
	x: number,
	y: number,
	options: { id?: number; pointerType?: string; isPrimary?: boolean } = {},
): Event {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
		button: 0,
	});
	Object.defineProperty(event, "pointerId", { value: options.id ?? 1 });
	Object.defineProperty(event, "pointerType", {
		value: options.pointerType ?? "mouse",
	});
	Object.defineProperty(event, "isPrimary", {
		value: options.isPrimary ?? (options.id ?? 1) === 1,
	});
	return event;
}

/** The layer is the picture's own rectangle: 400 x 200 at (100, 50). */
function measure(layer: HTMLElement) {
	layer.getBoundingClientRect = () =>
		({
			left: 100,
			top: 50,
			x: 100,
			y: 50,
			width: 400,
			height: 200,
			right: 500,
			bottom: 250,
			toJSON: () => ({}),
		}) as DOMRect;
}

/** Renders the layer the way ImageBody holds it: it owns the marks and hands them down again. */
function renderLayer(props: { active?: boolean; marks?: ImageMark[] } = {}) {
	let marks: ImageMark[] = props.marks ?? [];
	const onChange = vi.fn();
	const onRefused = vi.fn();
	const view = render(MarkLayer, {
		marks,
		active: props.active ?? true,
		onChange: (next: ImageMark[]) => {
			marks = next;
			onChange(next);
			void view.rerender({ marks });
		},
		onRefused,
	});
	const layer = screen.getByTestId("mark-layer");
	measure(layer);
	async function drag(
		from: [number, number],
		to: [number, number],
		options: { pointerType?: string } = {},
	) {
		await fireEvent(layer, pointer("pointerdown", from[0], from[1], options));
		await fireEvent(
			layer,
			pointer(
				"pointermove",
				(from[0] + to[0]) / 2,
				(from[1] + to[1]) / 2,
				options,
			),
		);
		await fireEvent(layer, pointer("pointermove", to[0], to[1], options));
		await fireEvent(layer, pointer("pointerup", to[0], to[1], options));
		await tick();
	}
	async function tap(x: number, y: number) {
		await fireEvent(layer, pointer("pointerdown", x, y));
		await fireEvent(layer, pointer("pointermove", x + 3, y + 2));
		await fireEvent(layer, pointer("pointerup", x + 3, y + 2));
		await tick();
	}
	return { ...view, layer, onChange, onRefused, drag, tap, marks: () => marks };
}

describe("MarkLayer", () => {
	beforeEach(() => uiLanguage.set("en"));

	it("draws A in red and B in blue with two drags, in fractions of the picture", async () => {
		const view = renderLayer();
		await view.drag([140, 70], [300, 170]);
		await view.drag([320, 90], [480, 230]);
		const expected = [
			{ letter: "A", x: 0.1, y: 0.1, w: 0.4, h: 0.5 },
			{ letter: "B", x: 0.55, y: 0.2, w: 0.4, h: 0.7 },
		];
		expect(view.marks().map((mark) => mark.letter)).toEqual(["A", "B"]);
		view.marks().forEach((mark, index) => {
			for (const key of ["x", "y", "w", "h"] as const) {
				expect(mark[key]).toBeCloseTo(expected[index][key], 9);
			}
		});
		const boxes = screen.getAllByTestId("mark-box");
		expect(boxes.map((box) => box.dataset.letter)).toEqual(["A", "B"]);
		expect(boxes[0].style.getPropertyValue("--mark-colour")).toBe(
			MARK_COLOURS.A,
		);
		expect(boxes[1].style.getPropertyValue("--mark-colour")).toBe(
			MARK_COLOURS.B,
		);
		expect(boxes[0].style.left).toBe("10%");
		expect(boxes[0].style.width).toBe("40%");
	});

	it("shows the box being drawn under the pointer as it moves, with no transition", async () => {
		const view = renderLayer();
		await fireEvent(view.layer, pointer("pointerdown", 100, 50));
		await fireEvent(view.layer, pointer("pointermove", 300, 150));
		const draft = screen.getByTestId("mark-draft");
		expect(draft.style.left).toBe("0%");
		expect(draft.style.width).toBe("50%");
		expect(draft.style.height).toBe("50%");
		await fireEvent(view.layer, pointer("pointermove", 500, 250));
		expect(draft.style.width).toBe("100%");
		expect(draft.style.height).toBe("100%");
	});

	it("removes A with a tap on it", async () => {
		const view = renderLayer();
		await view.drag([140, 70], [300, 170]);
		await view.drag([320, 90], [480, 230]);
		await view.tap(200, 100);
		expect(view.marks().map((mark) => mark.letter)).toEqual(["B"]);
	});

	it("takes a press that moves under 6 px for a tap, not a box", async () => {
		const view = renderLayer();
		await view.tap(200, 100);
		expect(view.onChange).not.toHaveBeenCalled();
		expect(screen.queryByTestId("mark-draft")).toBeNull();
	});

	it("gives the next box the first free letter", async () => {
		const view = renderLayer();
		await view.drag([110, 60], [150, 100]);
		await view.drag([200, 60], [250, 100]);
		await view.drag([300, 60], [350, 100]);
		await view.tap(220, 80);
		await view.drag([400, 60], [450, 100]);
		expect(view.marks().map((mark) => mark.letter)).toEqual(["A", "C", "B"]);
	});

	it("refuses a ninth box", async () => {
		const view = renderLayer();
		for (let index = 0; index < 9; index++) {
			const left = 100 + index * 40;
			await view.drag([left + 2, 60], [left + 30, 100]);
		}
		expect(view.marks()).toHaveLength(8);
		expect(view.onRefused).toHaveBeenCalledTimes(1);
	});

	it("draws nothing with Mark off, and leaves the pointer to the picture", async () => {
		const view = renderLayer({ active: false });
		await view.drag([140, 70], [300, 170]);
		expect(view.onChange).not.toHaveBeenCalled();
		expect(view.layer.classList.contains("is-active")).toBe(false);
	});

	it("drops the box being drawn when a second finger comes down (the pinch is the zoom's)", async () => {
		const view = renderLayer();
		const touch = { pointerType: "touch" };
		await fireEvent(view.layer, pointer("pointerdown", 140, 70, touch));
		await fireEvent(view.layer, pointer("pointermove", 300, 170, touch));
		expect(screen.getByTestId("mark-draft")).toBeTruthy();
		await fireEvent(
			view.layer,
			pointer("pointerdown", 400, 200, { ...touch, id: 2 }),
		);
		expect(screen.queryByTestId("mark-draft")).toBeNull();
		await fireEvent(
			view.layer,
			pointer("pointerup", 400, 200, { ...touch, id: 2 }),
		);
		await fireEvent(view.layer, pointer("pointermove", 320, 190, touch));
		await fireEvent(view.layer, pointer("pointerup", 320, 190, touch));
		expect(view.onChange).not.toHaveBeenCalled();
	});

	it("draws on a new press after a pointer whose up never came", async () => {
		const view = renderLayer();
		const touch = { pointerType: "touch" };
		await fireEvent(
			view.layer,
			pointer("pointerdown", 140, 70, { ...touch, id: 7, isPrimary: true }),
		);
		// The up is lost (outside the window, a browser gesture): a new press comes.
		await view.drag([140, 70], [300, 170], touch);
		expect(view.marks().map((mark) => mark.letter)).toEqual(["A"]);
	});

	it("stops a finger's drag from scrolling with a non-passive touchmove while Mark is on", async () => {
		const view = renderLayer();
		const move = new Event("touchmove", { bubbles: true, cancelable: true });
		Object.defineProperty(move, "touches", { value: [{}] });
		view.layer.dispatchEvent(move);
		expect(move.defaultPrevented).toBe(true);
		await view.rerender({ active: false });
		const idle = new Event("touchmove", { bubbles: true, cancelable: true });
		Object.defineProperty(idle, "touches", { value: [{}] });
		view.layer.dispatchEvent(idle);
		expect(idle.defaultPrevented).toBe(false);
	});

	it("names each box as a button that removes it", async () => {
		const view = renderLayer({
			active: false,
			marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.4, h: 0.6 }],
		});
		const button = screen.getByRole("button", {
			name: "Mark A, tap to remove",
		});
		await fireEvent.click(button);
		expect(view.onChange).toHaveBeenCalledWith([]);
	});

	it("names each box in Hungarian", () => {
		uiLanguage.set("hu");
		renderLayer({ marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.4, h: 0.6 }] });
		expect(
			screen.getByRole("button", { name: "A jelölés, koppints a törléshez" }),
		).toBeTruthy();
	});

	it("fades a removed box out on opacity alone, over the standard duration", async () => {
		// jsdom has no animations: this one finishes on the next microtask, as a
		// browser's would at its end, so the outro runs its real keyframes.
		const calls: Array<{
			element: Element;
			keyframes: Keyframe[];
			options: KeyframeAnimationOptions;
		}> = [];
		const animate = vi
			.spyOn(Element.prototype, "animate")
			.mockImplementation(function (
				this: Element,
				keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
				options?: number | KeyframeAnimationOptions,
			) {
				calls.push({
					element: this,
					keyframes: (keyframes ?? []) as Keyframe[],
					options: (options ?? {}) as KeyframeAnimationOptions,
				});
				const animation = {
					onfinish: null as null | (() => void),
					cancel: () => {},
					finished: Promise.resolve(),
					currentTime: 0,
				};
				queueMicrotask(() => animation.onfinish?.());
				return animation as unknown as Animation;
			});
		try {
			const view = renderLayer({
				active: false,
				marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.4, h: 0.6 }],
			});
			const box = screen.getByTestId("mark-box");
			await fireEvent.click(screen.getByRole("button", { name: /Mark A/ }));
			expect(view.marks()).toEqual([]);
			await waitFor(() => expect(screen.queryByTestId("mark-box")).toBeNull());
			const fades = calls.filter(
				(call) => call.element === box && call.keyframes.length > 0,
			);
			expect(fades.length, "the removed box was not faded").toBeGreaterThan(0);
			for (const fadeCall of fades) {
				const properties = new Set(
					fadeCall.keyframes.flatMap((frame) =>
						Object.keys(frame).filter(
							(key) => !["offset", "easing", "composite"].includes(key),
						),
					),
				);
				expect([...properties]).toEqual(["opacity"]);
				expect(fadeCall.options.duration).toBe(MOTION_DURATION.standard);
			}
		} finally {
			animate.mockRestore();
		}
	});

	it("removes a box at once under reduced motion", async () => {
		const original = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: query.includes("reduce"),
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		})) as typeof window.matchMedia;
		try {
			renderLayer({
				active: false,
				marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.4, h: 0.6 }],
			});
			await fireEvent.click(screen.getByRole("button", { name: /Mark A/ }));
			await waitFor(() => expect(screen.queryByTestId("mark-box")).toBeNull());
		} finally {
			window.matchMedia = original;
		}
	});
});
