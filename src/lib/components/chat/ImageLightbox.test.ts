import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
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
