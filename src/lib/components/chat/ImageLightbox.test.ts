import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deregisterDialog,
	hasOpenDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import ImageLightbox from "./ImageLightbox.svelte";

const IMAGES = [
	{ src: "https://example.com/a.jpg", alt: "First picture" },
	{ src: "https://example.com/b.jpg", alt: "Second picture" },
	{ src: "https://example.com/c.jpg", alt: "" },
];

describe("ImageLightbox", () => {
	it("renders nothing when index is null", () => {
		render(ImageLightbox, {
			props: {
				images: IMAGES,
				index: null,
				onClose: vi.fn(),
				onNavigate: vi.fn(),
			},
		});

		expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument();
	});

	it("opens at the given index, sourcing the image, its alt, and a 1-based counter", () => {
		render(ImageLightbox, {
			props: {
				images: IMAGES,
				index: 1,
				onClose: vi.fn(),
				onNavigate: vi.fn(),
			},
		});

		const overlay = screen.getByTestId("image-lightbox");
		const image = overlay.querySelector("img");
		expect(image).toHaveAttribute("src", "https://example.com/b.jpg");
		expect(image).toHaveAttribute("alt", "Second picture");
		expect(screen.getByText("Second picture")).toBeInTheDocument();
		expect(screen.getByTestId("image-lightbox-counter")).toHaveTextContent(
			"2 / 3",
		);
	});

	it("omits the caption when the image has no alt text", () => {
		render(ImageLightbox, {
			props: {
				images: IMAGES,
				index: 2,
				onClose: vi.fn(),
				onNavigate: vi.fn(),
			},
		});

		// The two named images' alts must not leak in; the empty-alt image shows
		// no caption element at all.
		expect(screen.queryByText("First picture")).not.toBeInTheDocument();
		expect(screen.queryByText("Second picture")).not.toBeInTheDocument();
	});

	it("calls onClose from the close button", async () => {
		const onClose = vi.fn();
		render(ImageLightbox, {
			props: { images: IMAGES, index: 0, onClose, onNavigate: vi.fn() },
		});

		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("closes on a backdrop click but not on an image click", async () => {
		const onClose = vi.fn();
		render(ImageLightbox, {
			props: { images: IMAGES, index: 0, onClose, onNavigate: vi.fn() },
		});

		const overlay = screen.getByTestId("image-lightbox");
		const image = overlay.querySelector("img");
		if (!image) throw new Error("missing lightbox image");

		await fireEvent.click(image);
		expect(onClose).not.toHaveBeenCalled();

		await fireEvent.click(overlay);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		render(ImageLightbox, {
			props: { images: IMAGES, index: 0, onClose, onNavigate: vi.fn() },
		});

		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});

	it("navigates next/prev with wraparound via buttons and arrow keys", async () => {
		const onNavigate = vi.fn();
		render(ImageLightbox, {
			props: {
				images: [IMAGES[0], IMAGES[1]],
				index: 1,
				onClose: vi.fn(),
				onNavigate,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Next image" }));
		expect(onNavigate).toHaveBeenLastCalledWith(0);

		await fireEvent.click(
			screen.getByRole("button", { name: "Previous image" }),
		);
		expect(onNavigate).toHaveBeenLastCalledWith(0);

		await fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(onNavigate).toHaveBeenLastCalledWith(0);

		await fireEvent.keyDown(window, { key: "ArrowLeft" });
		expect(onNavigate).toHaveBeenLastCalledWith(0);
	});

	it("hides prev/next controls and the counter for a single image", () => {
		render(ImageLightbox, {
			props: {
				images: [IMAGES[0]],
				index: 0,
				onClose: vi.fn(),
				onNavigate: vi.fn(),
			},
		});

		expect(
			screen.queryByRole("button", { name: "Previous image" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Next image" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("image-lightbox-counter"),
		).not.toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// What the lightbox does besides showing a picture: it holds the page still,
// answers the arrow keys, and (below) behaves as a modal dialog among others.
// ---------------------------------------------------------------------------

// Presses a key the way the browser delivers it to whatever holds focus, and
// hands back the event so a test can ask whether its default was cancelled.
function pressKey(key: string, options: { shiftKey?: boolean } = {}) {
	const event = new KeyboardEvent("keydown", {
		key,
		shiftKey: options.shiftKey ?? false,
		bubbles: true,
		cancelable: true,
	});
	(document.activeElement ?? document.body).dispatchEvent(event);
	return event;
}

function renderOpen(props: Record<string, unknown> = {}) {
	const onClose = vi.fn();
	const onNavigate = vi.fn();
	const view = render(ImageLightbox, {
		props: { images: IMAGES, index: 1, onClose, onNavigate, ...props },
	});
	return { ...view, onClose, onNavigate };
}

describe("ImageLightbox page scroll", () => {
	afterEach(() => {
		document.body.style.overflow = "";
	});

	it("holds the page still while it is open and gives the prior value back when it goes", async () => {
		document.body.style.overflow = "auto";
		const { unmount } = renderOpen();
		await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

		unmount();

		expect(document.body.style.overflow).toBe("auto");
	});

	it("leaves the page alone when it is closed", () => {
		document.body.style.overflow = "auto";
		renderOpen({ index: null });

		expect(document.body.style.overflow).toBe("auto");
	});
});

describe("ImageLightbox keys while closed", () => {
	it("answers neither the arrows nor Escape", () => {
		const { onClose, onNavigate } = renderOpen({ index: null });

		pressKey("ArrowRight");
		pressKey("ArrowLeft");
		pressKey("Escape");

		expect(onNavigate).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe("ImageLightbox as a modal dialog", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("takes focus itself when it opens", async () => {
		renderOpen();

		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);
	});

	it("wraps Tab from the last control to the first, and Shift+Tab back", async () => {
		renderOpen();
		const dialog = screen.getByTestId("image-lightbox");
		await waitFor(() => expect(dialog).toHaveFocus());
		const close = screen.getByRole("button", { name: "Close" });
		const next = screen.getByRole("button", { name: "Next image" });

		next.focus();
		const forward = pressKey("Tab");
		expect(forward.defaultPrevented).toBe(true);
		expect(close).toHaveFocus();

		const backward = pressKey("Tab", { shiftKey: true });
		expect(backward.defaultPrevented).toBe(true);
		expect(next).toHaveFocus();
	});

	it("leaves Tab between the two ends to the browser", async () => {
		renderOpen();
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);
		screen.getByRole("button", { name: "Previous image" }).focus();

		const event = pressKey("Tab");

		expect(event.defaultPrevented).toBe(false);
	});

	it("wraps Shift+Tab pressed on the dialog itself, where focus starts, to the last control", async () => {
		renderOpen();
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);

		const event = pressKey("Tab", { shiftKey: true });

		expect(event.defaultPrevented).toBe(true);
		expect(screen.getByRole("button", { name: "Next image" })).toHaveFocus();
	});

	it("pulls focus that has left the dialog back to its first control", async () => {
		renderOpen();
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);
		const outside = document.createElement("button");
		document.body.append(outside);
		outside.focus();

		const event = pressKey("Tab");

		expect(event.defaultPrevented).toBe(true);
		expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
	});

	it("with a single image has one control, and Tab stays on it", async () => {
		renderOpen({ images: [IMAGES[0]], index: 0 });
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);
		const close = screen.getByRole("button", { name: "Close" });
		close.focus();

		const forward = pressKey("Tab");
		const backward = pressKey("Tab", { shiftKey: true });

		expect(forward.defaultPrevented).toBe(true);
		expect(backward.defaultPrevented).toBe(true);
		expect(close).toHaveFocus();
	});

	it("closes on Escape and cancels the key", () => {
		const { onClose } = renderOpen();

		const event = pressKey("Escape");

		expect(event.defaultPrevented).toBe(true);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("gives focus back to whatever had it when it opened, without scrolling the page", async () => {
		const opener = document.createElement("button");
		document.body.append(opener);
		opener.focus();
		const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

		const { unmount } = renderOpen();
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);
		expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

		unmount();

		expect(opener).toHaveFocus();
		expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
		focusSpy.mockRestore();
	});

	it("sits on the open-dialog stack while it is open and not while it is closed", () => {
		expect(hasOpenDialog()).toBe(false);
		renderOpen({ index: null });
		expect(hasOpenDialog()).toBe(false);

		const { unmount } = renderOpen();
		expect(hasOpenDialog()).toBe(true);

		unmount();
		expect(hasOpenDialog()).toBe(false);
	});

	it("leaves Escape, Tab and the arrows to a dialog opened on top of it, and answers again once that dialog closes", async () => {
		const { onClose, onNavigate } = renderOpen();
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);
		const next = screen.getByRole("button", { name: "Next image" });
		next.focus();
		const topmost = Symbol("dialog-on-top");

		registerDialog(topmost);
		try {
			expect(pressKey("Escape").defaultPrevented).toBe(false);
			expect(pressKey("Tab").defaultPrevented).toBe(false);
			pressKey("ArrowRight");
			expect(onClose).not.toHaveBeenCalled();
			expect(onNavigate).not.toHaveBeenCalled();
			expect(next).toHaveFocus();
		} finally {
			deregisterDialog(topmost);
		}

		pressKey("ArrowRight");
		expect(onNavigate).toHaveBeenCalledWith(2);
		pressKey("Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
