import { fireEvent, render, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudScrubber from "./ReadAloudScrubber.svelte";

const NOTCHES = [0, 0.3, 0.7];

function scrubber(extra: Record<string, unknown> = {}) {
	const props = {
		notches: NOTCHES,
		progress: 0.4,
		sentence: 1,
		count: 3,
		disabled: false,
		preview: vi.fn((i: number) => `${i + 1}/3 · Sentence number ${i + 1}…`),
		onDragStart: vi.fn(),
		onDragMove: vi.fn(),
		onDragEnd: vi.fn(),
		onStep: vi.fn(),
		...extra,
	};
	const result = render(ReadAloudScrubber, { props });
	const slider = within(result.container).getByRole("slider");
	// jsdom lays nothing out: the scrubber is 200 px wide, from x = 0.
	vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
		left: 0,
		top: 0,
		width: 200,
		height: 40,
		right: 200,
		bottom: 40,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect);
	return { ...result, slider, props };
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeEach(() => {
	uiLanguage.set("en");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ReadAloudScrubber", () => {
	it("is a slider over the sentences", () => {
		const { slider } = scrubber();
		expect(slider.getAttribute("aria-label")).toBe("Sentence");
		expect(slider.getAttribute("aria-valuemin")).toBe("1");
		expect(slider.getAttribute("aria-valuemax")).toBe("3");
		expect(slider.getAttribute("aria-valuenow")).toBe("2");
		expect(slider.getAttribute("aria-valuetext")).toBe("Sentence 2 of 3");
		expect(slider.getAttribute("tabindex")).toBe("0");
	});

	it("places a notch at each sentence's text share", () => {
		const { container } = scrubber();
		const notches = [
			...container.querySelectorAll(".read-aloud-notch"),
		] as HTMLElement[];
		expect(notches.map((notch) => notch.style.left)).toEqual([
			"0%",
			"30%",
			"70%",
		]);
		expect(
			(container.querySelector(".read-aloud-fill") as HTMLElement).style.width,
		).toBe("40%");
	});

	it("steps with the arrows and jumps with Home and End", async () => {
		const { slider, props } = scrubber();
		await fireEvent.keyDown(slider, { key: "ArrowLeft" });
		expect(props.onStep).toHaveBeenLastCalledWith(0);
		await fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(props.onStep).toHaveBeenLastCalledWith(2);
		await fireEvent.keyDown(slider, { key: "Home" });
		expect(props.onStep).toHaveBeenLastCalledWith(0);
		await fireEvent.keyDown(slider, { key: "End" });
		expect(props.onStep).toHaveBeenLastCalledWith(2);
		const first = scrubber({ sentence: 0 });
		await fireEvent.keyDown(first.slider, { key: "ArrowLeft" });
		expect(first.props.onStep).not.toHaveBeenCalled();
	});

	it("a drag reports the sentence under the pointer and lands on its notch", async () => {
		const { slider, props, container } = scrubber();
		await fireEvent.pointerDown(slider, { clientX: 10, pointerId: 1 });
		expect(props.onDragStart).toHaveBeenCalledTimes(1);
		await fireEvent.pointerMove(slider, { clientX: 150, pointerId: 1 });
		await frame();
		await tick();
		expect(props.onDragMove).toHaveBeenLastCalledWith(2);
		// The handle and the fill follow the pointer exactly, and the landing notch lights up.
		expect(
			(container.querySelector(".read-aloud-handle") as HTMLElement).style.left,
		).toBe("75%");
		expect(
			(container.querySelector(".read-aloud-fill") as HTMLElement).style.width,
		).toBe("75%");
		expect(
			[...container.querySelectorAll(".read-aloud-notch")].map((n) =>
				n.classList.contains("on"),
			),
		).toEqual([false, false, true]);
		await fireEvent.pointerUp(slider, { clientX: 150, pointerId: 1 });
		expect(props.onDragEnd).toHaveBeenCalledWith(2);
		expect(
			container
				.querySelector(".read-aloud-scrubber")
				?.classList.contains("settling"),
		).toBe(true);
	});

	it("a tap jumps like a drag", async () => {
		const { slider, props } = scrubber();
		await fireEvent.pointerDown(slider, { clientX: 100, pointerId: 1 });
		await fireEvent.pointerUp(slider, { clientX: 100, pointerId: 1 });
		expect(props.onDragStart).toHaveBeenCalledTimes(1);
		expect(props.onDragEnd).toHaveBeenCalledWith(1);
	});

	it('the bubble says "4/9 · …"', async () => {
		const { slider, props, container } = scrubber();
		expect(
			container.querySelector(".read-aloud-bubble")?.textContent?.trim() ?? "",
		).toBe("");
		await fireEvent.pointerDown(slider, { clientX: 150, pointerId: 1 });
		await fireEvent.pointerMove(slider, { clientX: 155, pointerId: 1 });
		await frame();
		await tick();
		expect(props.preview).toHaveBeenCalledWith(2);
		expect(
			container.querySelector(".read-aloud-bubble")?.textContent,
		).toContain("3/3 · Sentence number 3…");
	});

	it("keeps the bubble inside the player at both ends, from the handle's place and the bubble's width (C1)", async () => {
		// A 375 px phone: the player runs from x = 8 to 367 and its scrubber from 60 to
		// 315; the bubble's words are 200 px wide.
		const box = (left: number, width: number) =>
			({
				left,
				width,
				right: left + width,
				top: 0,
				bottom: 40,
				height: 40,
				x: left,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect;
		const player = document.createElement("div");
		player.setAttribute("data-read-aloud-player", "");
		document.body.appendChild(player);
		vi.spyOn(player, "getBoundingClientRect").mockReturnValue(box(8, 359));
		const result = render(ReadAloudScrubber, {
			target: player,
			props: {
				notches: NOTCHES,
				progress: 0.4,
				sentence: 1,
				count: 3,
				disabled: false,
				preview: (i: number) => `${i + 1}/3 · Sentence number ${i + 1}…`,
				onDragStart: vi.fn(),
				onDragMove: vi.fn(),
				onDragEnd: vi.fn(),
				onStep: vi.fn(),
			},
		});
		const slider = within(result.container).getByRole("slider");
		vi.spyOn(slider, "getBoundingClientRect").mockReturnValue(box(60, 255));
		const bubble = result.container.querySelector(
			".read-aloud-bubble",
		) as HTMLElement;
		Object.defineProperty(bubble, "offsetWidth", {
			configurable: true,
			get: () => 200,
		});
		// What a browser measures while the bubble's transform is still moving: the
		// bubble where its handle is, without the shift that was just asked for.
		vi.spyOn(bubble, "getBoundingClientRect").mockImplementation(() =>
			box(60 + (Number.parseFloat(bubble.style.left) / 100) * 255 - 100, 200),
		);
		const shift = () => bubble.style.getPropertyValue("--bubble-shift");

		// At the start: the handle is at 60, so the bubble would begin at -40; it
		// moves right to begin 6 px inside the player, at 14.
		await fireEvent.pointerDown(slider, { clientX: 60, pointerId: 1 });
		await tick();
		await frame();
		expect(shift()).toBe("54px");

		// In the middle it needs no shift.
		await fireEvent.pointerMove(slider, { clientX: 187, pointerId: 1 });
		await frame();
		await tick();
		expect(shift()).toBe("0px");

		// At the end: the bubble would end at 415; it moves left to end at 361.
		await fireEvent.pointerMove(slider, { clientX: 315, pointerId: 1 });
		await frame();
		await tick();
		expect(shift()).toBe("-54px");
		await fireEvent.pointerUp(slider, { clientX: 315, pointerId: 1 });
		player.remove();
	});

	it("does nothing while disabled", async () => {
		const { slider, props } = scrubber({ disabled: true });
		expect(slider.getAttribute("aria-disabled")).toBe("true");
		await fireEvent.keyDown(slider, { key: "ArrowRight" });
		await fireEvent.pointerDown(slider, { clientX: 150, pointerId: 1 });
		await fireEvent.pointerUp(slider, { clientX: 150, pointerId: 1 });
		expect(props.onStep).not.toHaveBeenCalled();
		expect(props.onDragStart).not.toHaveBeenCalled();
		expect(props.onDragEnd).not.toHaveBeenCalled();
	});
});
