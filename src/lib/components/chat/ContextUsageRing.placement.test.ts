import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContextUsageRing from "./ContextUsageRing.svelte";

vi.mock("$lib/i18n", () => ({
	t: {
		subscribe: vi.fn((cb: (v: (key: string) => string) => void) => {
			const fn = (key: string) => key;
			cb(fn);
			return vi.fn();
		}),
	},
}));

// Where the popup stands and what shows it (FX-R). jsdom measures nothing, so
// these tests give it the geometry it does not have: a ring at a place, a popup
// of a width, a window of a size. What a browser does with the numbers is the
// e2e spec's (tests/e2e/context-usage-ring-placement.spec.ts).

type Box = { left: number; top: number; width: number; height: number };

function rectOf(box: Box): DOMRect {
	return {
		...box,
		x: box.left,
		y: box.top,
		right: box.left + box.width,
		bottom: box.top + box.height,
		toJSON: () => ({}),
	} as DOMRect;
}

function setWindow(width: number, height: number) {
	for (const [key, value] of [
		["innerWidth", width],
		["innerHeight", height],
	] as const) {
		Object.defineProperty(window, key, {
			configurable: true,
			writable: true,
			value,
		});
	}
}

/** Gives the ring a place and the popup a width and a content height. Returns the ring's box, to be moved. */
function stubGeometry(options: {
	window: { width: number; height: number };
	ring: Box;
	popupWidth?: number;
	contentHeight?: number;
}) {
	setWindow(options.window.width, options.window.height);
	const state = { ring: options.ring };
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			if (this.dataset.testid === "context-usage-ring") {
				return rectOf(state.ring);
			}
			if (this.dataset.testid === "context-usage-popover") {
				return rectOf({
					left: 0,
					top: 0,
					width: options.popupWidth ?? 382,
					height: options.contentHeight ?? 80,
				});
			}
			return rectOf({ left: 0, top: 0, width: 0, height: 0 });
		},
	);
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return this.dataset.testid === "context-usage-popover"
				? (options.contentHeight ?? 80)
				: 0;
		},
	);
	return state;
}

/** What `:focus-visible` answers for the ring: true after a Tab, false after a click. */
function stubFocusVisible(answer: () => boolean) {
	const original = Element.prototype.matches;
	vi.spyOn(Element.prototype, "matches").mockImplementation(function (
		this: Element,
		selector: string,
	) {
		if (selector === ":focus-visible") return answer();
		return original.call(this, selector);
	});
}

/** A pointer event of a given kind: jsdom's `fireEvent` does not carry `pointerType` for every build. */
function pointer(type: "pointerenter" | "pointerleave", pointerType: string) {
	const event = new Event(type);
	Object.defineProperty(event, "pointerType", { value: pointerType });
	return event;
}

const ring = () => screen.getByTestId("context-usage-ring");
const popup = () => screen.getByTestId("context-usage-popover");
const isVisible = () =>
	popup().classList.contains("ring-popover--visible") &&
	ring().getAttribute("aria-expanded") === "true";

function renderRing() {
	return render(ContextUsageRing, {
		props: { contextStatus: null, attachedArtifacts: [] },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	setWindow(1024, 768);
	document.body.innerHTML = "";
});

describe("ContextUsageRing popup: what shows it", () => {
	it("is shown by a press on the ring, and a second press puts it away", async () => {
		renderRing();
		expect(isVisible()).toBe(false);

		await fireEvent.click(ring());
		expect(isVisible()).toBe(true);

		await fireEvent.click(ring());
		expect(isVisible()).toBe(false);
	});

	it("is shown by a mouse over the ring for as long as the mouse stays, but not by a finger's", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		renderRing();

		ring().dispatchEvent(pointer("pointerenter", "touch"));
		await tick();
		expect(isVisible()).toBe(false);

		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		await tick();
		expect(isVisible()).toBe(true);

		ring().dispatchEvent(pointer("pointerleave", "mouse"));
		await vi.advanceTimersByTimeAsync(250);
		expect(isVisible()).toBe(false);
	});

	it("is put away by a press on the ring even while the mouse is still over it", async () => {
		renderRing();

		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		await fireEvent.click(ring());
		expect(isVisible()).toBe(true);

		await fireEvent.click(ring());
		expect(isVisible()).toBe(false);
	});

	it("is shown by the keyboard's focus on the ring, not by the focus a click gives it", async () => {
		let keyboard = true;
		stubFocusVisible(() => keyboard);
		renderRing();

		ring().focus();
		await tick();
		expect(isVisible()).toBe(true);

		ring().blur();
		await tick();
		expect(isVisible()).toBe(false);

		keyboard = false;
		ring().focus();
		await tick();
		expect(isVisible()).toBe(false);
	});

	it("is put away by Escape, whatever showed it, until it is asked for again", async () => {
		stubFocusVisible(() => true);
		renderRing();

		await fireEvent.click(ring());
		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		ring().focus();
		await tick();
		expect(isVisible()).toBe(true);

		await fireEvent.keyDown(window, { key: "Escape" });
		expect(isVisible()).toBe(false);

		// Only the ring asks for it again.
		await fireEvent.click(ring());
		expect(isVisible()).toBe(true);
	});

	it("lets other keys alone", async () => {
		renderRing();
		await fireEvent.click(ring());

		await fireEvent.keyDown(window, { key: "Enter" });

		expect(isVisible()).toBe(true);
	});

	it("shuts on a press outside it and stays open on a press inside it", async () => {
		renderRing();
		await fireEvent.click(ring());

		await fireEvent.mouseDown(screen.getByText("contextUsageRing.context"));
		expect(isVisible()).toBe(true);
		await fireEvent.touchStart(popup());
		expect(isVisible()).toBe(true);

		await fireEvent.mouseDown(document.body);
		expect(isVisible()).toBe(false);

		await fireEvent.click(ring());
		await fireEvent.touchStart(document.body);
		expect(isVisible()).toBe(false);
	});

	it("says what the ring controls, and whether it is open", async () => {
		renderRing();

		expect(ring().getAttribute("aria-haspopup")).toBe("dialog");
		expect(popup().id).not.toBe("");
		expect(ring().getAttribute("aria-controls")).toBe(popup().id);
		expect(ring().getAttribute("aria-expanded")).toBe("false");

		await fireEvent.click(ring());
		expect(ring().getAttribute("aria-expanded")).toBe("true");
	});
});

// The popup is in <body>, so the ring's own `:hover` no longer covers it, as it
// did when the popup was the ring's descendant: the mouse is on it when it is on
// the ring or on the popup, with a moment's grace for the 8px between them.
describe("ContextUsageRing popup: the mouse going from the ring to the popup", () => {
	function fakeTimers() {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	}

	it("stays when the mouse crosses the gap from the ring to the popup", async () => {
		fakeTimers();
		renderRing();

		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		await tick();
		expect(isVisible()).toBe(true);

		// Off the ring: not yet put away.
		ring().dispatchEvent(pointer("pointerleave", "mouse"));
		await vi.advanceTimersByTimeAsync(60);
		expect(isVisible()).toBe(true);

		// On the popup within the grace: it stays, for as long as it likes.
		popup().dispatchEvent(pointer("pointerenter", "mouse"));
		await vi.advanceTimersByTimeAsync(2000);
		expect(isVisible()).toBe(true);
	});

	it("stays when the mouse goes back from the popup to the ring", async () => {
		fakeTimers();
		renderRing();
		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		popup().dispatchEvent(pointer("pointerenter", "mouse"));
		ring().dispatchEvent(pointer("pointerleave", "mouse"));

		popup().dispatchEvent(pointer("pointerleave", "mouse"));
		await vi.advanceTimersByTimeAsync(60);
		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		await vi.advanceTimersByTimeAsync(2000);

		expect(isVisible()).toBe(true);
	});

	it("goes a moment after the mouse is on neither, and not before", async () => {
		fakeTimers();
		renderRing();
		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		popup().dispatchEvent(pointer("pointerenter", "mouse"));
		ring().dispatchEvent(pointer("pointerleave", "mouse"));
		popup().dispatchEvent(pointer("pointerleave", "mouse"));

		await vi.advanceTimersByTimeAsync(150);
		expect(isVisible()).toBe(true);

		await vi.advanceTimersByTimeAsync(100);
		expect(isVisible()).toBe(false);
	});

	it("does not let go of a popup the ring pinned, whatever the mouse does", async () => {
		fakeTimers();
		renderRing();
		await fireEvent.click(ring());

		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		ring().dispatchEvent(pointer("pointerleave", "mouse"));
		await vi.advanceTimersByTimeAsync(1000);

		expect(isVisible()).toBe(true);
	});

	it("ignores a finger on the popup", async () => {
		fakeTimers();
		renderRing();

		popup().dispatchEvent(pointer("pointerenter", "touch"));
		await tick();

		expect(isVisible()).toBe(false);
	});

	it("is put away at once by Escape, and the timer left over does not bring anything back", async () => {
		fakeTimers();
		renderRing();
		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		// Counted against what was there before the leave, as the test below
		// does: Svelte 5.56 may hold a timer of its own after a delegated event,
		// which is not the ring's. The ring's hover timer must be gone after
		// Escape (a leaked one would be counted here).
		const beforeLeave = vi.getTimerCount();
		ring().dispatchEvent(pointer("pointerleave", "mouse"));
		expect(vi.getTimerCount()).toBe(beforeLeave + 1);

		await fireEvent.keyDown(window, { key: "Escape" });
		expect(isVisible()).toBe(false);
		expect(vi.getTimerCount()).toBe(beforeLeave);
		await vi.advanceTimersByTimeAsync(1000);
		expect(isVisible()).toBe(false);
	});

	it("leaves no timer behind when the ring goes", async () => {
		fakeTimers();
		const { unmount } = renderRing();
		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		const beforeLeave = vi.getTimerCount();
		ring().dispatchEvent(pointer("pointerleave", "mouse"));
		// Counted against what was there before: Svelte 5.56 may hold a timer of
		// its own after a delegated event, which is not the ring's.
		expect(vi.getTimerCount()).toBe(beforeLeave + 1);

		unmount();

		expect(vi.getTimerCount()).toBe(beforeLeave);
	});
});

// The defect: the home page centres its composer with a transform, which makes
// a `position: fixed` box inside it relative to that layer; and a docked
// document panel painted over the right-hand part of a popup that hung off the
// ring inside the chat's column. In <body> it is neither.
describe("ContextUsageRing popup: where it stands", () => {
	it("is painted in <body>, outside whatever layers the composer sits in, at every width", async () => {
		for (const width of [390, 1024, 1440]) {
			stubGeometry({
				window: { width, height: 900 },
				ring: { left: 221, top: 440, width: 48, height: 48 },
			});
			const { container, unmount } = renderRing();

			await waitFor(() => expect(popup().parentElement).toBe(document.body));
			expect(container.contains(popup())).toBe(false);
			unmount();
			vi.restoreAllMocks();
		}
	});

	it("hangs above the ring, as wide as the window less 4px a side, from the ring's rectangle", async () => {
		stubGeometry({
			window: { width: 390, height: 844 },
			ring: { left: 221, top: 440, width: 48, height: 48 },
			popupWidth: 382,
			contentHeight: 80,
		});
		renderRing();

		await fireEvent.click(ring());

		await waitFor(() => expect(popup().style.left).toBe("4px"));
		// 8px above the ring's top edge, measured from the window's bottom.
		expect(popup().style.bottom).toBe(`${844 - 440 + 8}px`);
		expect(popup().style.top).toBe("");
		// The room above, less the window's margin.
		expect(popup().style.maxHeight).toBe(`${440 - 16}px`);
		// Its content fits: it clips nothing (the tooltip over the context bar can
		// stand partly above it).
		expect(popup().classList.contains("ring-popover--scrolls")).toBe(false);
	});

	it("starts at the ring's left edge on a desktop, 400px wide", async () => {
		stubGeometry({
			window: { width: 1440, height: 900 },
			ring: { left: 529, top: 445, width: 44, height: 44 },
			popupWidth: 400,
			contentHeight: 309,
		});
		renderRing();

		await fireEvent.click(ring());

		await waitFor(() => expect(popup().style.left).toBe("529px"));
		expect(popup().style.bottom).toBe(`${900 - 445 + 8}px`);
	});

	it("keeps to the 30rem the phone sheet always kept when there is more room than that", async () => {
		stubGeometry({
			window: { width: 390, height: 1000 },
			ring: { left: 221, top: 800, width: 48, height: 48 },
			popupWidth: 382,
			contentHeight: 325,
		});
		renderRing();

		await fireEvent.click(ring());

		await waitFor(() => expect(popup().style.maxHeight).toBe("480px"));
	});

	it("drops below the ring when there is no room above it and more room below", async () => {
		stubGeometry({
			window: { width: 390, height: 500 },
			ring: { left: 221, top: 100, width: 48, height: 48 },
			popupWidth: 382,
			contentHeight: 325,
		});
		renderRing();

		await fireEvent.click(ring());

		await waitFor(() => expect(popup().style.top).toBe(`${100 + 48 + 8}px`));
		expect(popup().style.bottom).toBe("");
		// The room below, less the window's margin: never taller than that.
		expect(popup().style.maxHeight).toBe(`${500 - (100 + 48) - 16}px`);
	});

	it("scrolls inside the room it has when the window is shorter than it is", async () => {
		stubGeometry({
			window: { width: 844, height: 390 },
			ring: { left: 203, top: 334, width: 44, height: 44 },
			popupWidth: 400,
			contentHeight: 400,
		});
		renderRing();

		await fireEvent.click(ring());

		await waitFor(() =>
			expect(popup().style.bottom).toBe(`${390 - 334 + 8}px`),
		);
		expect(popup().style.maxHeight).toBe(`${334 - 16}px`);
		expect(popup().style.left).toBe("203px");
		expect(popup().classList.contains("ring-popover--scrolls")).toBe(true);
	});

	it("is not placed or followed while it is closed", async () => {
		stubGeometry({
			window: { width: 390, height: 844 },
			ring: { left: 221, top: 440, width: 48, height: 48 },
		});
		renderRing();
		await tick();

		expect(popup().getAttribute("style")).toBeNull();
		expect(popup().classList.contains("ring-popover--visible")).toBe(false);
	});

	it("goes with its ring when the ring moves, with no event to say so", async () => {
		const geometry = stubGeometry({
			window: { width: 390, height: 844 },
			ring: { left: 221, top: 440, width: 48, height: 48 },
		});
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		renderRing();
		await fireEvent.click(ring());
		await tick();
		expect(popup().style.bottom).toBe(`${844 - 440 + 8}px`);

		// The home page's composer glides, an attachment's pill grows: the ring moves.
		geometry.ring = { left: 221, top: 380, width: 48, height: 48 };
		vi.advanceTimersToNextFrame();
		await tick();

		expect(popup().style.bottom).toBe(`${844 - 380 + 8}px`);
	});

	it("goes with the window when it is resized across the phone's width", async () => {
		stubGeometry({
			window: { width: 390, height: 844 },
			ring: { left: 221, top: 440, width: 48, height: 48 },
		});
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		renderRing();
		await fireEvent.click(ring());
		await tick();
		expect(popup().style.bottom).toBe(`${844 - 440 + 8}px`);

		setWindow(1100, 900);
		vi.advanceTimersToNextFrame();
		await tick();

		expect(popup().parentElement).toBe(document.body);
		expect(popup().style.bottom).toBe(`${900 - 440 + 8}px`);
		expect(isVisible()).toBe(true);
	});

	it("leaves nothing of itself in the page when the ring goes", async () => {
		stubGeometry({
			window: { width: 390, height: 844 },
			ring: { left: 221, top: 440, width: 48, height: 48 },
		});
		const { unmount } = renderRing();
		await waitFor(() => expect(popup().parentElement).toBe(document.body));
		const element = popup();

		unmount();

		expect(document.body.contains(element)).toBe(false);
	});

	it("takes a press on it, a tap off it and Escape like any popup does", async () => {
		stubGeometry({
			window: { width: 390, height: 844 },
			ring: { left: 221, top: 440, width: 48, height: 48 },
		});
		renderRing();
		await fireEvent.click(ring());
		await waitFor(() => expect(popup().parentElement).toBe(document.body));

		// In <body> it is outside the ring's element, and still not "outside".
		await fireEvent.touchStart(popup());
		expect(isVisible()).toBe(true);

		await fireEvent.touchStart(document.body);
		expect(isVisible()).toBe(false);

		await fireEvent.click(ring());
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(isVisible()).toBe(false);
	});
});
