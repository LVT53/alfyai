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
// of a width, a window of a size, a screen that is or is not a touch screen.
// What a browser does with the numbers is the e2e spec's
// (tests/e2e/context-usage-ring-placement.spec.ts).

const COARSE_QUERY = "(hover: none) and (pointer: coarse)";
const NARROW_QUERY = "(max-width: 767px)";

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

/** The screen: which of the two questions the component asks `matchMedia` answers yes. */
const screenState = { touch: false, narrow: false };

function stubScreen(state: { touch?: boolean; narrow?: boolean }) {
	screenState.touch = state.touch ?? false;
	screenState.narrow = state.narrow ?? false;
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches:
				(query === COARSE_QUERY && screenState.touch) ||
				(query === NARROW_QUERY && screenState.narrow),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
	});
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
	Reflect.deleteProperty(window, "matchMedia");
	document.body.innerHTML = "";
});

describe("ContextUsageRing popup on a desktop", () => {
	it("hangs off the ring inside the composer, by CSS", () => {
		stubScreen({});
		const { container } = renderRing();

		expect(container.contains(popup())).toBe(true);
		expect(popup().classList.contains("ring-popover--fixed")).toBe(false);
		expect(popup().getAttribute("style")).toBeNull();
	});

	it("is shown by a press on the ring, and a second press puts it away", async () => {
		stubScreen({});
		renderRing();
		expect(isVisible()).toBe(false);

		await fireEvent.click(ring());
		expect(isVisible()).toBe(true);

		await fireEvent.click(ring());
		expect(isVisible()).toBe(false);
	});

	it("is shown by a mouse over the ring for as long as the mouse stays, but not by a finger's", async () => {
		stubScreen({});
		renderRing();

		ring().dispatchEvent(pointer("pointerenter", "touch"));
		await tick();
		expect(isVisible()).toBe(false);

		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		await tick();
		expect(isVisible()).toBe(true);

		ring().dispatchEvent(pointer("pointerleave", "mouse"));
		await tick();
		expect(isVisible()).toBe(false);
	});

	it("is put away by a press on the ring even while the mouse is still over it", async () => {
		stubScreen({});
		renderRing();

		ring().dispatchEvent(pointer("pointerenter", "mouse"));
		await fireEvent.click(ring());
		expect(isVisible()).toBe(true);

		await fireEvent.click(ring());
		expect(isVisible()).toBe(false);
	});

	it("is shown by the keyboard's focus on the ring, not by the focus a click gives it", async () => {
		stubScreen({});
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
		stubScreen({});
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
		stubScreen({});
		renderRing();
		await fireEvent.click(ring());

		await fireEvent.keyDown(window, { key: "Enter" });

		expect(isVisible()).toBe(true);
	});

	it("shuts on a press outside it and stays open on a press inside it", async () => {
		stubScreen({});
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
		stubScreen({});
		renderRing();

		expect(ring().getAttribute("aria-haspopup")).toBe("dialog");
		expect(popup().id).not.toBe("");
		expect(ring().getAttribute("aria-controls")).toBe(popup().id);
		expect(ring().getAttribute("aria-expanded")).toBe("false");

		await fireEvent.click(ring());
		expect(ring().getAttribute("aria-expanded")).toBe("true");
	});
});

// The defect: the home page centres its composer with a transform, which makes
// a `position: fixed` box inside it relative to that layer.
describe("ContextUsageRing popup on a phone", () => {
	it("is painted in <body>, outside whatever layers the composer sits in", async () => {
		stubScreen({ narrow: true });
		stubGeometry({
			window: { width: 390, height: 844 },
			ring: { left: 221, top: 440, width: 48, height: 48 },
		});
		const { container } = renderRing();

		await waitFor(() => expect(popup().parentElement).toBe(document.body));
		expect(container.contains(popup())).toBe(false);
		expect(popup().classList.contains("ring-popover--fixed")).toBe(true);
	});

	it("is painted in <body> on a touch screen of any width", async () => {
		stubScreen({ touch: true });
		stubGeometry({
			window: { width: 1024, height: 768 },
			ring: { left: 321, top: 452, width: 44, height: 44 },
		});
		renderRing();

		await waitFor(() => expect(popup().parentElement).toBe(document.body));
	});

	it("hangs above the ring, as wide as the window less 4px a side, from the ring's rectangle", async () => {
		stubScreen({ narrow: true });
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
	});

	it("keeps to the 30rem the phone sheet always kept when there is more room than that", async () => {
		stubScreen({ narrow: true });
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
		stubScreen({ narrow: true });
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
		stubScreen({ touch: true });
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
	});

	it("is not placed or followed while it is closed", async () => {
		stubScreen({ narrow: true });
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
		stubScreen({ narrow: true });
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

	it("is handed back to the composer when the window is wide again, and taken out again when it is narrow", async () => {
		stubScreen({ narrow: true });
		stubGeometry({
			window: { width: 390, height: 844 },
			ring: { left: 221, top: 440, width: 48, height: 48 },
		});
		const { container } = renderRing();
		await fireEvent.click(ring());
		await waitFor(() => expect(popup().parentElement).toBe(document.body));

		stubScreen({});
		setWindow(1100, 800);
		await fireEvent(window, new Event("resize"));
		await waitFor(() => expect(container.contains(popup())).toBe(true));
		expect(popup().classList.contains("ring-popover--fixed")).toBe(false);
		expect(popup().getAttribute("style")).toBeNull();
		// A resize is not a press: it is still open.
		expect(isVisible()).toBe(true);

		stubScreen({ narrow: true });
		setWindow(390, 844);
		await fireEvent(window, new Event("resize"));
		await waitFor(() => expect(popup().parentElement).toBe(document.body));
	});

	it("leaves nothing of itself in the page when the ring goes", async () => {
		stubScreen({ narrow: true });
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

	it("takes a press on it, a tap off it and Escape like a popup on a desktop does", async () => {
		stubScreen({ touch: true, narrow: true });
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
