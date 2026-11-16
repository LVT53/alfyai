import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudScrubber from "./ReadAloudScrubber.svelte";

const rect = (left: number, top: number, width: number, height: number) =>
	({
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON: () => ({}),
	}) as DOMRect;

/** Nine sentences: where each one starts, as a share of the reply's text. */
const NOTCHES = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.8, 0.9, 0.95];
const TRACK_WIDTH = 400;

function pointer(target: Element, type: string, clientX: number) {
	const Constructor =
		typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
	target.dispatchEvent(
		new Constructor(type, {
			bubbles: true,
			cancelable: true,
			clientX,
			clientY: 0,
			button: 0,
			pointerId: 1,
		} as PointerEventInit),
	);
}

function renderScrubber(overrides: Record<string, unknown> = {}) {
	const handlers = {
		onDragStart: vi.fn(),
		onDragMove: vi.fn(),
		onDragEnd: vi.fn(),
		onStep: vi.fn(),
	};
	const result = render(ReadAloudScrubber, {
		notches: NOTCHES,
		progress: 0.3,
		sentence: 2,
		count: 9,
		disabled: false,
		preview: (i: number) => `${i + 1}/9 · Feed it once a day…`,
		...handlers,
		...overrides,
	});
	const slider = screen.getByRole("slider");
	const track = slider.querySelector(".track") as HTMLElement;
	vi.spyOn(track, "getBoundingClientRect").mockReturnValue(
		rect(0, 0, TRACK_WIDTH, 24),
	);
	return { ...result, ...handlers, slider, track };
}

beforeEach(() => {
	// One animation frame runs at once: moves are coalesced per frame, and the
	// tests ask what the frame did.
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	uiLanguage.set("en");
});

describe("ReadAloudScrubber", () => {
	it("is a slider that names its sentence", () => {
		const { slider } = renderScrubber();
		expect(slider.getAttribute("aria-valuemin")).toBe("1");
		expect(slider.getAttribute("aria-valuemax")).toBe("9");
		expect(slider.getAttribute("aria-valuenow")).toBe("3");
		expect(slider.getAttribute("aria-valuetext")).toBe("Sentence 3 of 9");
		expect(slider.getAttribute("aria-label")).toBe("Sentence");
		expect(slider.getAttribute("tabindex")).toBe("0");
	});

	it("says its sentence in Hungarian", () => {
		uiLanguage.set("hu");
		const { slider } = renderScrubber();
		expect(slider.getAttribute("aria-valuetext")).toBe("3. mondat, összesen 9");
		expect(slider.getAttribute("aria-label")).toBe("Mondat");
	});

	it("places a notch at each sentence's text share", () => {
		const { slider } = renderScrubber();
		const notches = [
			...slider.querySelectorAll("[data-notch]"),
		] as HTMLElement[];
		expect(notches.map((notch) => notch.style.left)).toEqual([
			"0%",
			"10%",
			"25%",
			"40%",
			"55%",
			"70%",
			"80%",
			"90%",
			"95%",
		]);
	});

	it("puts the handle and the fill at the share read", () => {
		const { slider } = renderScrubber();
		expect((slider.querySelector(".handle") as HTMLElement).style.left).toBe(
			"30%",
		);
		expect((slider.querySelector(".fill") as HTMLElement).style.width).toBe(
			"30%",
		);
	});

	it("steps with the arrows and jumps with Home and End", async () => {
		const { slider, onStep } = renderScrubber();
		await fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(onStep).toHaveBeenLastCalledWith(3);
		await fireEvent.keyDown(slider, { key: "ArrowLeft" });
		expect(onStep).toHaveBeenLastCalledWith(1);
		await fireEvent.keyDown(slider, { key: "Home" });
		expect(onStep).toHaveBeenLastCalledWith(0);
		await fireEvent.keyDown(slider, { key: "End" });
		expect(onStep).toHaveBeenLastCalledWith(8);
		expect(onStep).toHaveBeenCalledTimes(4);
	});

	it("stays inside the reply with the arrows", async () => {
		const first = renderScrubber({ sentence: 0 });
		await fireEvent.keyDown(first.slider, { key: "ArrowLeft" });
		expect(first.onStep).toHaveBeenLastCalledWith(0);
		first.unmount();
		const last = renderScrubber({ sentence: 8 });
		await fireEvent.keyDown(last.slider, { key: "ArrowRight" });
		expect(last.onStep).not.toHaveBeenCalled();
	});

	it("a drag reports the sentence under the pointer and lands on its notch", async () => {
		const { slider, onDragStart, onDragMove, onDragEnd } = renderScrubber();
		const handle = slider.querySelector(".handle") as HTMLElement;

		pointer(slider, "pointerdown", 20); // 5%: the first sentence
		pointer(slider, "pointermove", 140); // 35%: the third
		pointer(slider, "pointermove", 230); // 57.5%: the fifth
		await tick();
		// The handle and the fill follow the pointer exactly, and the landing notch lights up.
		expect(handle.style.left).toBe("57.5%");
		expect((slider.querySelector(".fill") as HTMLElement).style.width).toBe(
			"57.5%",
		);
		expect(
			slider.querySelector("[data-notch='4']")?.hasAttribute("data-lit"),
		).toBe(true);
		expect(
			slider.querySelector("[data-notch='2']")?.hasAttribute("data-lit"),
		).toBe(false);

		pointer(slider, "pointerup", 230);
		await tick();
		expect(onDragStart).toHaveBeenCalledTimes(1);
		expect(onDragMove.mock.calls.map((call) => call[0])).toEqual([0, 2, 4]);
		expect(onDragEnd).toHaveBeenCalledTimes(1);
		expect(onDragEnd).toHaveBeenCalledWith(4);
		// It glides onto the notch of the sentence it landed on.
		expect(handle.style.left).toBe("55%");
		expect(slider.hasAttribute("data-dragging")).toBe(false);
	});

	it("a tap jumps like a drag", async () => {
		const { slider, onDragStart, onDragMove, onDragEnd } = renderScrubber();
		pointer(slider, "pointerdown", 360); // 90%: the eighth
		pointer(slider, "pointerup", 360);
		await tick();
		expect(onDragStart).toHaveBeenCalledTimes(1);
		expect(onDragMove).toHaveBeenCalledWith(7);
		expect(onDragEnd).toHaveBeenCalledWith(7);
	});

	it("follows the reading again once the new reading moves", async () => {
		const { slider, component, rerender } = renderScrubber();
		void component;
		pointer(slider, "pointerdown", 360);
		pointer(slider, "pointerup", 360);
		await tick();
		const handle = slider.querySelector(".handle") as HTMLElement;
		expect(handle.style.left).toBe("90%");
		await rerender({ progress: 0.92 });
		expect(handle.style.left).toBe("92%");
	});

	it("keeps a drag inside the track", async () => {
		const { slider, onDragMove, onDragEnd } = renderScrubber();
		pointer(slider, "pointerdown", -50);
		pointer(slider, "pointermove", 900);
		pointer(slider, "pointerup", 900);
		await tick();
		expect(onDragMove.mock.calls.map((call) => call[0])).toEqual([0, 8]);
		expect(onDragEnd).toHaveBeenCalledWith(8);
	});

	it('the bubble says "4/9 · …" above the handle while dragging', async () => {
		const { slider } = renderScrubber();
		expect(screen.queryByTestId("read-aloud-scrubber-bubble")).toBeNull();
		pointer(slider, "pointerdown", 170); // 42.5%: the fourth sentence
		await tick();
		const bubble = screen.getByTestId("read-aloud-scrubber-bubble");
		expect(bubble.textContent?.trim()).toBe("4/9 · Feed it once a day…");
		pointer(slider, "pointerup", 170);
		await tick();
		expect(screen.queryByTestId("read-aloud-scrubber-bubble")).toBeNull();
	});

	it("keeps the bubble 6 px inside the player's edges", async () => {
		const player = document.createElement("div");
		player.setAttribute("data-read-aloud-player", "");
		document.body.append(player);
		vi.spyOn(player, "getBoundingClientRect").mockReturnValue(
			rect(0, 0, 420, 54),
		);
		const { slider } = renderScrubber({});
		player.append(slider.parentElement as HTMLElement);
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
		pointer(slider, "pointerdown", 395); // at the right end of the track
		await tick();
		await tick();
		const bubble = screen.getByTestId("read-aloud-scrubber-bubble");
		// Centred on the handle (x = 395) the bubble would reach 495; the player ends at 420.
		expect(bubble.style.transform).toContain("translateX(-81px)");
		player.remove();
	});

	it("does nothing while disabled", async () => {
		const { slider, onStep, onDragStart } = renderScrubber({ disabled: true });
		expect(slider.getAttribute("aria-disabled")).toBe("true");
		expect(slider.getAttribute("tabindex")).toBe("-1");
		await fireEvent.keyDown(slider, { key: "ArrowRight" });
		pointer(slider, "pointerdown", 100);
		pointer(slider, "pointerup", 100);
		await tick();
		expect(onStep).not.toHaveBeenCalled();
		expect(onDragStart).not.toHaveBeenCalled();
	});
});
