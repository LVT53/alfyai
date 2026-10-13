import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentOutlineEntry } from "$lib/server/services/knowledge/types";
import AttachmentOutline from "./AttachmentOutline.svelte";

function buildOutline(count: number): DocumentOutlineEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		level: index % 2 === 0 ? 1 : 2,
		title: `Section ${index}`,
		offset: index * 10,
		preview: `Preview text for section ${index}`,
	}));
}

describe("AttachmentOutline", () => {
	it("renders nothing when the outline is empty", () => {
		const { container } = render(AttachmentOutline, {
			props: { outline: [], onQuote: vi.fn() },
		});
		expect(container.textContent?.trim()).toBe("");
	});

	it("shows the header with the section count and lists rows", () => {
		const { getByText } = render(AttachmentOutline, {
			props: {
				outline: [
					{ level: 1, title: "Contract", offset: 0, preview: "Text" },
					{ level: 2, title: "Break clause", offset: 20, preview: "More" },
				],
				onQuote: vi.fn(),
			},
		});

		expect(getByText("Outline · 2 sections")).toBeInTheDocument();
		expect(getByText("Contract")).toBeInTheDocument();
		expect(getByText("Break clause")).toBeInTheDocument();
	});

	it("quotes 'Title: preview…' when a row is clicked", async () => {
		const onQuote = vi.fn();
		const { getByText } = render(AttachmentOutline, {
			props: {
				outline: [
					{
						level: 2,
						title: "Section 2.3 Break clause",
						offset: 0,
						preview: "Either party may terminate this agreement",
					},
				],
				onQuote,
			},
		});

		getByText("Section 2.3 Break clause").click();

		expect(onQuote).toHaveBeenCalledWith(
			"Section 2.3 Break clause: Either party may terminate this agreement…",
		);
	});

	it("collapses the row list when the header is clicked", async () => {
		const { getByText, queryByText } = render(AttachmentOutline, {
			props: {
				outline: [{ level: 1, title: "Contract", offset: 0, preview: "Text" }],
				onQuote: vi.fn(),
			},
		});

		expect(getByText("Contract")).toBeInTheDocument();
		await fireEvent.click(getByText("Outline · 1 sections"));
		expect(queryByText("Contract")).toBeNull();
	});

	it("caps the visible rows at 40 and reveals the rest via the 'more' toggle", async () => {
		const outline = buildOutline(45);
		const { getByText, queryByText } = render(AttachmentOutline, {
			props: { outline, onQuote: vi.fn() },
		});

		expect(getByText("Section 0")).toBeInTheDocument();
		expect(getByText("Section 39")).toBeInTheDocument();
		expect(queryByText("Section 40")).toBeNull();

		const moreButton = getByText("… 5 more");
		await fireEvent.click(moreButton);

		expect(getByText("Section 40")).toBeInTheDocument();
		expect(getByText("Section 44")).toBeInTheDocument();
	});
});

// The disclosure's popover (FX-O). It is painted in <body> and placed against
// the window from its button's rectangle and its own size, so these tests give
// jsdom the geometry it does not have: a button at a place, a popover of a
// width, a window of a size. What the browser does with the numbers is the
// e2e spec's (tests/e2e/composer-outline-popover.spec.ts).
describe("AttachmentOutline disclosure popover", () => {
	const OUTLINE: DocumentOutlineEntry[] = [
		{ level: 1, title: "Contract", offset: 0, preview: "Text" },
		{ level: 2, title: "Break clause", offset: 20, preview: "More" },
		{ level: 2, title: "Deposit", offset: 40, preview: "Two months" },
	];

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

	/** Gives the button a place and the popover a width and a list height. Returns the button's box, to be moved. */
	function stubGeometry(options: {
		window: { width: number; height: number };
		button: Box;
		popoverWidth?: number;
		listHeight?: number;
	}) {
		setWindow(options.window.width, options.window.height);
		const state = { button: options.button };
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				if (this.dataset.testid === "attachment-outline-disclosure") {
					return rectOf(state.button);
				}
				if (this.dataset.testid === "attachment-outline-popover") {
					return rectOf({
						left: 0,
						top: 0,
						width: options.popoverWidth ?? 220,
						height: options.listHeight ?? 100,
					});
				}
				return rectOf({ left: 0, top: 0, width: 0, height: 0 });
			},
		);
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.dataset.testid === "attachment-outline-popover"
					? (options.listHeight ?? 100)
					: 0;
			},
		);
		return state;
	}

	async function openDisclosure(
		props: Partial<{ onQuote: (quote: string) => void }> = {},
	) {
		const view = render(AttachmentOutline, {
			props: {
				outline: OUTLINE,
				onQuote: props.onQuote ?? vi.fn(),
				variant: "disclosure",
				disclosureLabel: "Outline of Lease.pdf",
			},
		});
		await fireEvent.click(screen.getByTestId("attachment-outline-disclosure"));
		const popover = await screen.findByTestId("attachment-outline-popover");
		return { ...view, popover };
	}

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		setWindow(1024, 768);
		document.body.innerHTML = "";
	});

	// The defect: the home page centres its composer with a transform, which
	// makes a `position: fixed` box inside it relative to that layer.
	it("is painted in <body>, outside whatever layers the composer sits in", async () => {
		stubGeometry({
			window: { width: 1024, height: 768 },
			button: { left: 300, top: 700, width: 24, height: 24 },
		});
		const { container, popover } = await openDisclosure();

		expect(popover.parentElement).toBe(document.body);
		expect(container.contains(popover)).toBe(false);
	});

	it("leaves the panel variant where it is", async () => {
		const { container } = render(AttachmentOutline, {
			props: { outline: OUTLINE, onQuote: vi.fn() },
		});

		const body = container.querySelector(".attachment-outline-body");
		expect(body).not.toBeNull();
		expect(body?.getAttribute("role")).toBeNull();
		expect(body?.classList.contains("attachment-outline-body--popover")).toBe(
			false,
		);
	});

	it("is a named dialog that its button says it controls", async () => {
		stubGeometry({
			window: { width: 1024, height: 768 },
			button: { left: 300, top: 700, width: 24, height: 24 },
		});
		const { popover } = await openDisclosure();
		const button = screen.getByTestId("attachment-outline-disclosure");

		expect(popover.getAttribute("role")).toBe("dialog");
		expect(popover.getAttribute("aria-label")).toBe("Outline · 3 sections");
		expect(button.getAttribute("aria-haspopup")).toBe("dialog");
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(button.getAttribute("aria-controls")).toBe(popover.id);
		expect(popover.id).not.toBe("");

		await fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.getAttribute("aria-controls")).toBeNull();
	});

	it("hangs above its button with their left edges aligned", async () => {
		stubGeometry({
			window: { width: 1024, height: 768 },
			button: { left: 300, top: 700, width: 24, height: 24 },
		});
		const { popover } = await openDisclosure();

		await waitFor(() => expect(popover.style.left).toBe("300px"));
		// 8px above the button's top edge, measured from the window's bottom.
		expect(popover.style.bottom).toBe(`${768 - 700 + 8}px`);
		expect(popover.style.maxHeight).toBe("260px");
		expect(popover.style.visibility).toBe("");
	});

	// A phone: the popover is pulled back from the right edge by the width it
	// REALLY has. It used to be pulled back by the 320px it might have, and a
	// short outline (220px) stood 250px to the left of its icon.
	it("is pulled back from the window's edge by its own width", async () => {
		stubGeometry({
			window: { width: 390, height: 844 },
			button: { left: 311, top: 747, width: 24, height: 24 },
			popoverWidth: 220,
		});
		const { popover } = await openDisclosure();

		await waitFor(() => expect(popover.style.left).toBe(`${390 - 220 - 16}px`));
	});

	it("keeps its margin from the window's edge when it is as wide as it gets", async () => {
		stubGeometry({
			window: { width: 390, height: 844 },
			button: { left: 311, top: 747, width: 24, height: 24 },
			popoverWidth: 320,
		});
		const { popover } = await openDisclosure();

		await waitFor(() => expect(popover.style.left).toBe(`${390 - 320 - 16}px`));
	});

	it("drops below its button when its list does not fit above and there is more room below", async () => {
		stubGeometry({
			window: { width: 1024, height: 300 },
			button: { left: 300, top: 120, width: 24, height: 24 },
			listHeight: 220,
		});
		const { popover } = await openDisclosure();

		await waitFor(() => expect(popover.style.top).toBe(`${120 + 24 + 8}px`));
		expect(popover.style.bottom).toBe("");
		// The room below, less the window's margin: never taller than that.
		expect(popover.style.maxHeight).toBe(`${300 - (120 + 24) - 16}px`);
	});

	it("keeps to its own 260px cap when there is more room than that", async () => {
		stubGeometry({
			window: { width: 1024, height: 768 },
			button: { left: 300, top: 120, width: 24, height: 24 },
			listHeight: 240,
		});
		const { popover } = await openDisclosure();

		await waitFor(() => expect(popover.style.top).toBe(`${120 + 24 + 8}px`));
		expect(popover.style.maxHeight).toBe("260px");
	});

	it("stays above, scrolling inside the room it has, when below is no roomier", async () => {
		stubGeometry({
			window: { width: 1024, height: 420 },
			button: { left: 300, top: 250, width: 24, height: 24 },
			listHeight: 400,
		});
		const { popover } = await openDisclosure();

		await waitFor(() =>
			expect(popover.style.bottom).toBe(`${420 - 250 + 8}px`),
		);
		expect(popover.style.top).toBe("");
		expect(popover.style.maxHeight).toBe(`${250 - 16}px`);
	});

	it("goes with its button when the button moves, with no event to say so", async () => {
		const geometry = stubGeometry({
			window: { width: 1024, height: 768 },
			button: { left: 300, top: 700, width: 24, height: 24 },
		});
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		const { popover } = await openDisclosure();
		await tick();
		expect(popover.style.bottom).toBe(`${768 - 700 + 8}px`);

		// The home page's composer glides, a pill grows: the button moves.
		geometry.button = { left: 340, top: 600, width: 24, height: 24 };
		vi.advanceTimersToNextFrame();
		await tick();

		expect(popover.style.left).toBe("340px");
		expect(popover.style.bottom).toBe(`${768 - 600 + 8}px`);
	});

	it("shuts on a press outside it and stays open on a press inside it", async () => {
		stubGeometry({
			window: { width: 1024, height: 768 },
			button: { left: 300, top: 700, width: 24, height: 24 },
		});
		const { popover } = await openDisclosure();

		await fireEvent.pointerDown(screen.getByText("Outline · 3 sections"));
		expect(screen.queryByTestId("attachment-outline-popover")).not.toBeNull();

		await fireEvent.pointerDown(document.body);
		await waitFor(() =>
			expect(screen.queryByTestId("attachment-outline-popover")).toBeNull(),
		);
		// Nothing of it is left in the page.
		expect(document.body.contains(popover)).toBe(false);
	});

	it("takes the keyboard in, keeps Tab in the list, and gives the button back on Escape", async () => {
		stubGeometry({
			window: { width: 1024, height: 768 },
			button: { left: 300, top: 700, width: 24, height: 24 },
		});
		const { popover } = await openDisclosure();
		const rows = Array.from(
			popover.querySelectorAll<HTMLButtonElement>(".attachment-outline-row"),
		);
		expect(rows).toHaveLength(3);

		// Painted in <body>, it is not where Tab would go next: focus goes in.
		await waitFor(() => expect(rows[0]).toHaveFocus());

		rows[2].focus();
		await fireEvent.keyDown(rows[2], { key: "Tab" });
		expect(rows[0]).toHaveFocus();
		await fireEvent.keyDown(rows[0], { key: "Tab", shiftKey: true });
		expect(rows[2]).toHaveFocus();

		await fireEvent.keyDown(rows[2], { key: "Escape" });
		await waitFor(() =>
			expect(screen.queryByTestId("attachment-outline-popover")).toBeNull(),
		);
		expect(screen.getByTestId("attachment-outline-disclosure")).toHaveFocus();
	});

	it("quotes a section and closes, as it did before it moved", async () => {
		stubGeometry({
			window: { width: 1024, height: 768 },
			button: { left: 300, top: 700, width: 24, height: 24 },
		});
		const onQuote = vi.fn();
		await openDisclosure({ onQuote });

		await fireEvent.click(screen.getByText("Break clause"));

		expect(onQuote).toHaveBeenCalledWith("Break clause: More…");
		await waitFor(() =>
			expect(screen.queryByTestId("attachment-outline-popover")).toBeNull(),
		);
	});
});
