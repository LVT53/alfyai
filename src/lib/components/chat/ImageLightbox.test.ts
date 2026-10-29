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

	it("with a single image keeps Tab between Close and the zoom controls", async () => {
		renderOpen({ images: [IMAGES[0]], index: 0 });
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);
		const close = screen.getByRole("button", { name: "Close" });
		const zoomIn = screen.getByRole("button", { name: "Zoom in" });
		zoomIn.focus();

		const forward = pressKey("Tab");
		expect(forward.defaultPrevented).toBe(true);
		expect(close).toHaveFocus();

		const backward = pressKey("Tab", { shiftKey: true });
		expect(backward.defaultPrevented).toBe(true);
		expect(zoomIn).toHaveFocus();
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

// ---------------------------------------------------------------------------
// Enlarging (plan 2b Task 22): the viewer zooms and pans the one picture. The
// arithmetic is `image-lightbox-zoom.ts`'s (tested there); here, that the
// controls and keys reach it, and the picture's own shape and see-through look.
// ---------------------------------------------------------------------------

describe("ImageLightbox zoom", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	const picture = () => {
		const image = screen
			.getByTestId("image-lightbox")
			.querySelector<HTMLImageElement>("[data-zoom-target]");
		if (!image) throw new Error("missing zoom target");
		return image;
	};

	it("names its zoom controls", () => {
		renderOpen({ images: [IMAGES[0]], index: 0 });

		expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Zoom out" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Fit to screen/ }),
		).toBeInTheDocument();
	});

	it("zooms in on + and =, out on -, and back to fit on 0", async () => {
		renderOpen({ images: [IMAGES[0]], index: 0 });
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);

		expect(pressKey("+").defaultPrevented).toBe(true);
		expect(picture().style.transform).toContain("scale(1.25)");
		pressKey("=");
		expect(picture().style.transform).toContain("scale(1.5625)");
		pressKey("-");
		expect(picture().style.transform).toContain("scale(1.25)");
		pressKey("0");
		expect(picture().style.transform).toBe("");
	});

	it("leaves Ctrl and Cmd with + to the browser's own zoom", async () => {
		renderOpen({ images: [IMAGES[0]], index: 0 });
		await waitFor(() =>
			expect(screen.getByTestId("image-lightbox")).toHaveFocus(),
		);
		const event = new KeyboardEvent("keydown", {
			key: "+",
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		document.activeElement?.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(picture().style.transform).toBe("");
	});

	it("zooms from its buttons", async () => {
		renderOpen({ images: [IMAGES[0]], index: 0 });

		await fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		expect(picture().style.transform).toContain("scale(1.25)");
		await fireEvent.click(
			screen.getByRole("button", { name: /Fit to screen/ }),
		);
		expect(picture().style.transform).toBe("");
	});

	it("starts a picture it pages to at fit", async () => {
		const { rerender } = renderOpen({ images: IMAGES, index: 0 });
		await fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		expect(picture().style.transform).toContain("scale(1.25)");

		await rerender({ index: 1 });

		expect(picture().style.transform).toBe("");
	});

	it("reserves the picture's shape when it is known, and lays a see-through one on the checkerboard", () => {
		renderOpen({
			images: [
				{
					src: "/api/images/files/f1",
					alt: "Logo",
					width: 1024,
					height: 512,
					checkerboard: true,
				},
			],
			index: 0,
		});

		expect(picture()).toHaveAttribute("width", "1024");
		expect(picture()).toHaveAttribute("height", "512");
		expect(picture()).toHaveClass("image-checkerboard");
	});

	it("closes on a click beside the picture on the stage", async () => {
		const { onClose } = renderOpen({ images: [IMAGES[0]], index: 0 });

		await fireEvent.click(picture());
		expect(onClose).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByTestId("image-lightbox-stage"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

// Fix round 1, I2 (MOTION-PARITY 4): the full-size file can take seconds on a
// phone; its box is there from the first frame, and it fades in once loaded.
describe("ImageLightbox reserves the picture's box and fades it in", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	const shown = () =>
		screen.getByTestId("image-lightbox-image") as HTMLImageElement;

	it("sizes the box from the picture's known shape before a byte arrives", () => {
		renderOpen({
			images: [
				{ src: "/api/images/files/f1", alt: "Logo", width: 1248, height: 832 },
			],
			index: 0,
		});
		const image = shown();
		expect(image).toHaveClass("has-size");
		expect(image.style.getPropertyValue("--picture-ratio")).toBe("1.5");
		expect(image.style.getPropertyValue("--picture-width")).toBe("1248px");
		expect(image).not.toHaveClass("is-loaded");
	});

	it("shows the picture once it has loaded, and a picture paged to waits for its own load", async () => {
		renderOpen({ images: IMAGES, index: 0 });
		const first = shown();
		expect(first).not.toHaveClass("is-loaded");
		await fireEvent.load(first);
		expect(shown()).toHaveClass("is-loaded");

		await fireEvent.click(screen.getByRole("button", { name: "Next image" }));
		// A host that pages hands in the next index; the same element waits again.
	});

	it("leaves a picture of unknown size to its own shape", () => {
		renderOpen({ images: [IMAGES[0]], index: 0 });
		expect(shown()).not.toHaveClass("has-size");
	});
});
