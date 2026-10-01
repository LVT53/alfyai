import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { uiLanguage } from "$lib/stores/settings";
import CanvasSelectionPill from "./CanvasSelectionPill.svelte";

// The pill a selection of blocks raises ("Ask Alfy · Comment"), on its own, on a
// board whose screen and board coordinates are the same. That it sits clear of the
// block's own toolbar and that Ask really opens the composer is the e2e's
// (artifact-canvas-selection.spec.ts).

beforeEach(() => {
	uiLanguage.set("en");
	// Ctrl is the command key off a Mac.
	vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function sticky(
	id: string,
	x: number,
	y: number,
	extra: Partial<CanvasNode> = {},
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 200,
		height: 100,
		data: { kind: "sticky", text: `note ${id}`, tone: "yellow" },
		...extra,
	};
}

const NODES: CanvasNode[] = [
	sticky("a", 100, 100),
	sticky("b", 500, 100),
	sticky("c", 300, 300),
];

function mount(props: Record<string, unknown> = {}) {
	const callbacks = { onask: vi.fn(), oncomment: vi.fn() };
	const view = render(CanvasSelectionPill, {
		nodes: NODES.map((node) =>
			node.id === "a" ? { ...node, selected: true } : node,
		),
		viewport: { x: 0, y: 0, zoom: 1 },
		size: { width: 1000, height: 700 },
		tool: "select",
		readonly: false,
		hidden: false,
		askBusy: false,
		...callbacks,
		...props,
	} as never);
	return { ...view, ...callbacks };
}

const pill = () => screen.queryByRole("toolbar", { name: "Selection" });

describe("when it shows", () => {
	it("is a toolbar named Selection with Ask Alfy and Comment, under the selected block", () => {
		mount();
		const bar = screen.getByRole("toolbar", { name: "Selection" });
		expect(screen.getByRole("button", { name: /^Ask Alfy/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Comment/ })).toBeTruthy();
		// Centred under the block: x 100..300 -> 200, and its bottom edge (y 200).
		const anchor = bar.closest<HTMLElement>(
			"[data-testid='canvas-selection-pill']",
		);
		expect(anchor?.style.left).toBe("200px");
		expect(anchor?.style.top).toBe("200px");
	});

	it("holds several selected blocks in one box: under all of them", () => {
		mount({
			nodes: NODES.map((node) =>
				node.id === "c" ? node : { ...node, selected: true },
			),
		});
		const anchor = pill()?.closest<HTMLElement>(
			"[data-testid='canvas-selection-pill']",
		);
		// a: 100..300, b: 500..700 -> centre 400; c is not selected: bottom of the row is 200,
		// and the group box's handles reach 15 px past it (its 9 px gap and their own half).
		expect(anchor?.style.left).toBe("400px");
		expect(anchor?.style.top).toBe("215px");
	});

	it("hangs a fingertip further down from several blocks on a touch screen, clear of the box's handles", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query === "(pointer: coarse)",
			addEventListener() {},
			removeEventListener() {},
		}));
		mount({
			nodes: NODES.map((node) =>
				node.id === "c" ? node : { ...node, selected: true },
			),
		});
		const anchor = pill()?.closest<HTMLElement>(
			"[data-testid='canvas-selection-pill']",
		);
		expect(anchor?.style.top).toBe("233px");
		vi.unstubAllGlobals();
	});

	it("hangs from one block's own edge: it has no group box", () => {
		mount();
		const anchor = pill()?.closest<HTMLElement>(
			"[data-testid='canvas-selection-pill']",
		);
		expect(anchor?.style.top).toBe("200px");
	});

	it("is not there with nothing selected", () => {
		mount({ nodes: NODES });
		expect(pill()).toBeNull();
	});

	it("is not there while a tool other than Select is on, or the board cannot change", () => {
		mount({ tool: "pen" });
		expect(pill()).toBeNull();
		cleanup();
		mount({ readonly: true });
		expect(pill()).toBeNull();
	});

	it("is not there while a block is being dragged, or while the composer it opened is open", () => {
		mount({
			nodes: NODES.map((node) =>
				node.id === "a" ? { ...node, selected: true, dragging: true } : node,
			),
		});
		expect(pill()).toBeNull();
		cleanup();
		mount({ hidden: true });
		expect(pill()).toBeNull();
	});

	it("keeps its size on screen at any zoom", () => {
		mount({ viewport: { x: 0, y: 0, zoom: 0.5 } });
		const layer = document.querySelector<HTMLElement>(".selection-layer");
		expect(layer?.style.getPropertyValue("--inv")).toBe("2");
	});
});

describe("Escape", () => {
	it("hides the pill and keeps the selection, and a different selection brings it back", async () => {
		const { rerender } = mount();
		const event = new KeyboardEvent("keydown", {
			key: "Escape",
			cancelable: true,
			bubbles: true,
		});
		window.dispatchEvent(event);
		await tick();
		expect(event.defaultPrevented).toBe(true);
		expect(pill()).toBeNull();
		await rerender({
			nodes: NODES.map((node) =>
				node.id === "b" ? { ...node, selected: true } : node,
			),
		});
		await tick();
		expect(pill()).not.toBeNull();
	});

	it("is not taken from a text field", async () => {
		mount();
		const field = document.createElement("textarea");
		document.body.append(field);
		field.focus();
		const event = new KeyboardEvent("keydown", {
			key: "Escape",
			cancelable: true,
			bubbles: true,
		});
		field.dispatchEvent(event);
		await tick();
		expect(event.defaultPrevented).toBe(false);
		expect(pill()).not.toBeNull();
		field.remove();
	});

	it("does nothing when there is no pill", () => {
		mount({ nodes: NODES });
		const event = new KeyboardEvent("keydown", {
			key: "Escape",
			cancelable: true,
		});
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});
});

describe("what the buttons do", () => {
	it("Ask Alfy and Comment each hand over the selected blocks, in the board's order", async () => {
		const { onask, oncomment } = mount({
			nodes: NODES.map((node) =>
				node.id === "c" ? node : { ...node, selected: true },
			),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Ask Alfy/ }));
		expect(onask).toHaveBeenCalledWith(["a", "b"]);
		await fireEvent.click(screen.getByRole("button", { name: /^Comment/ }));
		expect(oncomment).toHaveBeenCalledWith(["a", "b"]);
	});

	it("Ask Alfy waits while Alfy is arranging, and says why; Comment does not wait", async () => {
		const { onask, oncomment } = mount({ askBusy: true });
		const ask = screen.getByRole("button", { name: /^Ask Alfy/ });
		expect(ask.hasAttribute("disabled")).toBe(true);
		expect(ask.getAttribute("title")).toContain("still arranging");
		await fireEvent.click(ask);
		expect(onask).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole("button", { name: /^Comment/ }));
		expect(oncomment).toHaveBeenCalledTimes(1);
	});

	it("names its chords for the keyboard, on the button and to assistive technology", () => {
		mount();
		const ask = screen.getByRole("button", { name: /^Ask Alfy/ });
		expect(ask.getAttribute("aria-keyshortcuts")).toBe("Control+Alt+A");
		expect(ask.getAttribute("title")).toContain("Ctrl+Alt+A");
		expect(
			screen
				.getByRole("button", { name: /^Comment/ })
				.getAttribute("aria-keyshortcuts"),
		).toBe("Control+Alt+M");
	});
});

describe("by keyboard", () => {
	function chord(letter: "a" | "m") {
		const event = new KeyboardEvent("keydown", {
			key: letter,
			code: `Key${letter.toUpperCase()}`,
			ctrlKey: true,
			altKey: true,
			cancelable: true,
			bubbles: true,
		});
		window.dispatchEvent(event);
		return event;
	}

	it("Ctrl+Alt+A asks Alfy about the selection and Ctrl+Alt+M comments on it", () => {
		const { onask, oncomment } = mount();
		expect(chord("a").defaultPrevented).toBe(true);
		expect(onask).toHaveBeenCalledWith(["a"]);
		expect(chord("m").defaultPrevented).toBe(true);
		expect(oncomment).toHaveBeenCalledWith(["a"]);
	});

	it("does not ask while Alfy is arranging", () => {
		const { onask } = mount({ askBusy: true });
		chord("a");
		expect(onask).not.toHaveBeenCalled();
	});

	it("does nothing without a selection, and leaves a text field to itself", () => {
		const { onask } = mount({ nodes: NODES });
		expect(chord("a").defaultPrevented).toBe(false);
		expect(onask).not.toHaveBeenCalled();
		cleanup();
		const { oncomment } = mount();
		const field = document.createElement("textarea");
		document.body.append(field);
		field.focus();
		field.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "m",
				code: "KeyM",
				ctrlKey: true,
				altKey: true,
				cancelable: true,
				bubbles: true,
			}),
		);
		expect(oncomment).not.toHaveBeenCalled();
		field.remove();
	});
});

describe("in Hungarian", () => {
	it("says the buttons and the toolbar's name", () => {
		uiLanguage.set("hu");
		mount();
		expect(screen.getByRole("toolbar", { name: "Kijelölés" })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /^Alfy megkérdezése/ }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Megjegyzés/ })).toBeTruthy();
	});
});
