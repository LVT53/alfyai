import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImagePreview from "./ImagePreview.svelte";

function createImageBlob(label: string) {
	return new Blob([label], { type: "image/png" });
}

function mockPreviewLayout(
	imageStage: HTMLElement,
	image: HTMLImageElement,
	{
		stageWidth = 200,
		stageHeight = 150,
		imageWidth = 400,
		imageHeight = 300,
	}: {
		stageWidth?: number;
		stageHeight?: number;
		imageWidth?: number;
		imageHeight?: number;
	} = {},
) {
	vi.spyOn(imageStage, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		bottom: stageHeight,
		right: stageWidth,
		width: stageWidth,
		height: stageHeight,
		toJSON: () => ({}),
	} as DOMRect);
	Object.defineProperty(image, "clientWidth", {
		value: imageWidth,
		configurable: true,
	});
	Object.defineProperty(image, "clientHeight", {
		value: imageHeight,
		configurable: true,
	});
}

describe("ImagePreview", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates an object URL for the current image and revokes stale URLs", async () => {
		const firstBlob = createImageBlob("first");
		const secondBlob = createImageBlob("second");
		const createObjectURL = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValueOnce("blob:first-image")
			.mockReturnValueOnce("blob:second-image");
		const revokeObjectURL = vi
			.spyOn(URL, "revokeObjectURL")
			.mockImplementation(() => undefined);

		const { getByAltText, rerender, unmount } = render(ImagePreview, {
			props: {
				blob: firstBlob,
				filename: "first.png",
			},
		});

		await waitFor(() => {
			expect(getByAltText("first.png")).toHaveAttribute(
				"src",
				"blob:first-image",
			);
		});
		expect(createObjectURL).toHaveBeenCalledWith(firstBlob);

		await rerender({
			blob: secondBlob,
			filename: "second.png",
		});

		await waitFor(() => {
			expect(getByAltText("second.png")).toHaveAttribute(
				"src",
				"blob:second-image",
			);
		});
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-image");

		unmount();

		expect(revokeObjectURL).toHaveBeenCalledWith("blob:second-image");
	});

	it("resets zoom and pan when the image changes", async () => {
		const firstBlob = createImageBlob("first");
		const secondBlob = createImageBlob("second");
		vi.spyOn(URL, "createObjectURL")
			.mockReturnValueOnce("blob:first-image")
			.mockReturnValueOnce("blob:second-image");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId, rerender } = render(
			ImagePreview,
			{
				props: {
					blob: firstBlob,
					filename: "first.png",
				},
			},
		);

		const imageStage = getByTestId("image-preview-stage");

		await waitFor(() => {
			expect(getByAltText("first.png")).toHaveAttribute(
				"src",
				"blob:first-image",
			);
		});
		mockPreviewLayout(
			imageStage,
			getByAltText("first.png") as HTMLImageElement,
		);

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.pointerDown(imageStage, {
			clientX: 10,
			clientY: 10,
			pointerId: 1,
		});
		await fireEvent.pointerMove(imageStage, {
			clientX: 35,
			clientY: 25,
			pointerId: 1,
		});
		await fireEvent.pointerUp(imageStage, { pointerId: 1 });
		expect(getByAltText("first.png")).toHaveAttribute(
			"style",
			expect.stringContaining("translate(25px, 15px) scale(1.25)"),
		);

		await rerender({
			blob: secondBlob,
			filename: "second.png",
		});

		await waitFor(() => {
			expect(getByAltText("second.png")).toHaveAttribute(
				"src",
				"blob:second-image",
			);
		});
		expect(getByAltText("second.png")).toHaveAttribute(
			"style",
			expect.stringContaining("translate(0px, 0px) scale(1)"),
		);
		expect(imageStage).not.toHaveClass("image-preview-stage-panning");
	});

	it("releases pointer capture when the image changes during a drag", async () => {
		const firstBlob = createImageBlob("first");
		const secondBlob = createImageBlob("second");
		vi.spyOn(URL, "createObjectURL")
			.mockReturnValueOnce("blob:first-image")
			.mockReturnValueOnce("blob:second-image");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId, rerender } = render(
			ImagePreview,
			{
				props: {
					blob: firstBlob,
					filename: "first.png",
				},
			},
		);

		const imageStage = getByTestId("image-preview-stage");
		imageStage.setPointerCapture = vi.fn();
		imageStage.releasePointerCapture = vi.fn();

		await waitFor(() => {
			expect(getByAltText("first.png")).toHaveAttribute(
				"src",
				"blob:first-image",
			);
		});

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.pointerDown(imageStage, {
			clientX: 10,
			clientY: 10,
			pointerId: 7,
		});
		expect(imageStage.setPointerCapture).toHaveBeenCalledWith(7);
		expect(imageStage).toHaveClass("image-preview-stage-panning");

		await rerender({
			blob: secondBlob,
			filename: "second.png",
		});

		await waitFor(() => {
			expect(getByAltText("second.png")).toHaveAttribute(
				"src",
				"blob:second-image",
			);
		});
		expect(imageStage.releasePointerCapture).toHaveBeenCalledWith(7);
		expect(imageStage).not.toHaveClass("image-preview-stage-panning");
	});

	it("releases pointer capture when unmounted during a drag", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId, unmount } = render(
			ImagePreview,
			{
				props: {
					blob: createImageBlob("unmount"),
					filename: "unmount.png",
				},
			},
		);

		const imageStage = getByTestId("image-preview-stage");
		imageStage.setPointerCapture = vi.fn();
		imageStage.releasePointerCapture = vi.fn();

		await waitFor(() => {
			expect(getByAltText("unmount.png")).toHaveAttribute(
				"src",
				"blob:image-preview",
			);
		});

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.pointerDown(imageStage, {
			clientX: 10,
			clientY: 10,
			pointerId: 9,
		});

		unmount();

		expect(imageStage.releasePointerCapture).toHaveBeenCalledWith(9);
	});

	it("supports image zoom controls without exposing editing tools", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId, queryByRole } = render(
			ImagePreview,
			{
				props: {
					blob: createImageBlob("controls"),
					filename: "diagram.png",
				},
			},
		);

		await waitFor(() => {
			expect(getByAltText("diagram.png")).toHaveAttribute(
				"src",
				"blob:image-preview",
			);
		});
		expect(getByTestId("preview-toolbar")).toBeInTheDocument();

		await fireEvent.click(getByLabelText("Zoom in"));
		expect(getByAltText("diagram.png")).toHaveAttribute(
			"style",
			expect.stringContaining("scale(1.25)"),
		);

		await fireEvent.click(getByLabelText("Zoom out"));
		expect(getByAltText("diagram.png")).toHaveAttribute(
			"style",
			expect.stringContaining("scale(1)"),
		);

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.click(getByLabelText("Reset zoom"));
		expect(getByAltText("diagram.png")).toHaveAttribute(
			"style",
			expect.stringContaining("translate(0px, 0px) scale(1)"),
		);

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.click(getByLabelText("Fit image"));
		expect(getByAltText("diagram.png")).toHaveAttribute(
			"style",
			expect.stringContaining("translate(0px, 0px) scale(1)"),
		);

		expect(
			queryByRole("button", { name: /crop|rotate|annotate/i }),
		).not.toBeInTheDocument();
	});

	it("lets normal wheel scrolling pass through until the image is zoomed", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByTestId } = render(ImagePreview, {
			props: {
				blob: createImageBlob("wheel"),
				filename: "wheel.png",
			},
		});
		const imageStage = getByTestId("image-preview-stage");

		await waitFor(() => {
			expect(getByAltText("wheel.png")).toHaveAttribute(
				"src",
				"blob:image-preview",
			);
		});

		const normalWheel = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: 120,
		});
		const normalWheelPreventDefault = vi.spyOn(normalWheel, "preventDefault");
		imageStage.dispatchEvent(normalWheel);

		expect(normalWheelPreventDefault).not.toHaveBeenCalled();
		expect(getByAltText("wheel.png")).toHaveAttribute(
			"style",
			expect.stringContaining("scale(1)"),
		);
		expect(imageStage).not.toHaveClass("image-preview-stage-pannable");

		const ctrlWheel = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			ctrlKey: true,
			deltaY: -100,
		});
		const ctrlWheelPreventDefault = vi.spyOn(ctrlWheel, "preventDefault");
		imageStage.dispatchEvent(ctrlWheel);

		expect(ctrlWheelPreventDefault).toHaveBeenCalled();
		await waitFor(() => {
			expect(getByAltText("wheel.png")).toHaveAttribute(
				"style",
				expect.stringContaining("scale(1.25)"),
			);
		});
		expect(imageStage).toHaveClass("image-preview-stage-pannable");

		const zoomedWheel = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: -100,
		});
		const zoomedWheelPreventDefault = vi.spyOn(zoomedWheel, "preventDefault");
		imageStage.dispatchEvent(zoomedWheel);

		expect(zoomedWheelPreventDefault).toHaveBeenCalled();
		await waitFor(() => {
			expect(getByAltText("wheel.png")).toHaveAttribute(
				"style",
				expect.stringContaining("scale(1.5)"),
			);
		});
	});

	it("clamps wheel zoom to the toolbar-supported maximum", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId } = render(ImagePreview, {
			props: {
				blob: createImageBlob("wheel-clamp"),
				filename: "wheel-clamp.png",
			},
		});
		const imageStage = getByTestId("image-preview-stage");
		const image = getByAltText("wheel-clamp.png");

		await waitFor(() => {
			expect(image).toHaveAttribute("src", "blob:image-preview");
		});

		for (let index = 0; index < 12; index += 1) {
			imageStage.dispatchEvent(
				new WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					ctrlKey: true,
					deltaY: -100,
				}),
			);
		}

		await waitFor(() => {
			expect(image).toHaveAttribute(
				"style",
				expect.stringContaining("scale(3)"),
			);
		});
		expect(getByLabelText("Reset zoom")).toHaveTextContent("300%");
		expect(getByLabelText("Zoom in")).toBeDisabled();
	});

	it("pans the image by pointer dragging only after zooming in", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId } = render(ImagePreview, {
			props: {
				blob: createImageBlob("pan"),
				filename: "pan.png",
			},
		});
		const imageStage = getByTestId("image-preview-stage");
		const image = getByAltText("pan.png");

		await waitFor(() => {
			expect(image).toHaveAttribute("src", "blob:image-preview");
		});
		mockPreviewLayout(imageStage, image as HTMLImageElement);

		await fireEvent.pointerDown(imageStage, {
			clientX: 10,
			clientY: 10,
			pointerId: 1,
		});
		await fireEvent.pointerMove(imageStage, {
			clientX: 35,
			clientY: 25,
			pointerId: 1,
		});
		expect(image).toHaveAttribute(
			"style",
			expect.stringContaining("translate(0px, 0px) scale(1)"),
		);
		expect(imageStage).not.toHaveClass("image-preview-stage-panning");

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.pointerDown(imageStage, {
			clientX: 10,
			clientY: 10,
			pointerId: 2,
		});
		expect(imageStage).toHaveClass("image-preview-stage-panning");

		await fireEvent.pointerMove(imageStage, {
			clientX: 35,
			clientY: 25,
			pointerId: 2,
		});
		await fireEvent.pointerUp(imageStage, { pointerId: 2 });

		expect(image).toHaveAttribute(
			"style",
			expect.stringContaining("translate(25px, 15px) scale(1.25)"),
		);
		expect(imageStage).not.toHaveClass("image-preview-stage-panning");
	});

	it("ignores pointer events that do not match the active drag", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId } = render(ImagePreview, {
			props: {
				blob: createImageBlob("active-pointer"),
				filename: "active-pointer.png",
			},
		});
		const imageStage = getByTestId("image-preview-stage");
		const image = getByAltText("active-pointer.png");

		await waitFor(() => {
			expect(image).toHaveAttribute("src", "blob:image-preview");
		});
		mockPreviewLayout(imageStage, image as HTMLImageElement);

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.pointerDown(imageStage, {
			clientX: 10,
			clientY: 10,
			pointerId: 4,
		});
		await fireEvent.pointerMove(imageStage, {
			clientX: 90,
			clientY: 90,
			pointerId: 5,
		});
		await fireEvent.pointerUp(imageStage, { pointerId: 5 });

		expect(image).toHaveAttribute(
			"style",
			expect.stringContaining("translate(0px, 0px) scale(1.25)"),
		);
		expect(imageStage).toHaveClass("image-preview-stage-panning");

		await fireEvent.pointerMove(imageStage, {
			clientX: 25,
			clientY: 20,
			pointerId: 4,
		});
		await fireEvent.pointerUp(imageStage, { pointerId: 4 });

		expect(image).toHaveAttribute(
			"style",
			expect.stringContaining("translate(15px, 10px) scale(1.25)"),
		);
		expect(imageStage).not.toHaveClass("image-preview-stage-panning");
	});

	it("keeps a zoomed image within the preview stage while panning", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId } = render(ImagePreview, {
			props: {
				blob: createImageBlob("bounded-pan"),
				filename: "bounded.png",
			},
		});
		const imageStage = getByTestId("image-preview-stage");
		const image = getByAltText("bounded.png") as HTMLImageElement;

		await waitFor(() => {
			expect(image).toHaveAttribute("src", "blob:image-preview");
		});

		vi.spyOn(imageStage, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			bottom: 80,
			right: 100,
			width: 100,
			height: 80,
			toJSON: () => ({}),
		} as DOMRect);
		Object.defineProperty(image, "clientWidth", {
			value: 100,
			configurable: true,
		});
		Object.defineProperty(image, "clientHeight", {
			value: 80,
			configurable: true,
		});

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.pointerDown(imageStage, {
			clientX: 0,
			clientY: 0,
			pointerId: 3,
		});
		await fireEvent.pointerMove(imageStage, {
			clientX: 200,
			clientY: 170,
			pointerId: 3,
		});
		await fireEvent.pointerUp(imageStage, { pointerId: 3 });

		expect(image).toHaveAttribute(
			"style",
			expect.stringContaining("translate(12.5px, 10px) scale(1.25)"),
		);
	});

	it("does not pan when the preview surface has no measurable layout", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByTestId } = render(ImagePreview, {
			props: {
				blob: createImageBlob("hidden-pan"),
				filename: "hidden.png",
			},
		});
		const imageStage = getByTestId("image-preview-stage");
		const image = getByAltText("hidden.png") as HTMLImageElement;

		await waitFor(() => {
			expect(image).toHaveAttribute("src", "blob:image-preview");
		});

		vi.spyOn(imageStage, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			bottom: 0,
			right: 0,
			width: 0,
			height: 0,
			toJSON: () => ({}),
		} as DOMRect);
		Object.defineProperty(image, "clientWidth", {
			value: 100,
			configurable: true,
		});
		Object.defineProperty(image, "clientHeight", {
			value: 80,
			configurable: true,
		});

		await fireEvent.click(getByLabelText("Zoom in"));
		await fireEvent.pointerDown(imageStage, {
			clientX: 0,
			clientY: 0,
			pointerId: 6,
		});
		await fireEvent.pointerMove(imageStage, {
			clientX: 200,
			clientY: 170,
			pointerId: 6,
		});
		await fireEvent.pointerUp(imageStage, { pointerId: 6 });

		expect(image).toHaveAttribute(
			"style",
			expect.stringContaining("translate(0px, 0px) scale(1.25)"),
		);
	});

	it("shows an accessible load failure and clears it for the next image", async () => {
		vi.spyOn(URL, "createObjectURL")
			.mockReturnValueOnce("blob:broken-image")
			.mockReturnValueOnce("blob:fixed-image");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByRole, queryByAltText, queryByRole, rerender } =
			render(ImagePreview, {
				props: {
					blob: createImageBlob("broken"),
					filename: "broken.png",
				},
			});

		await waitFor(() => {
			expect(getByAltText("broken.png")).toHaveAttribute(
				"src",
				"blob:broken-image",
			);
		});

		await fireEvent.error(getByAltText("broken.png"));

		expect(getByRole("alert")).toHaveTextContent(
			"Failed to load document preview.",
		);
		expect(queryByAltText("broken.png")).not.toBeInTheDocument();

		await rerender({
			blob: createImageBlob("fixed"),
			filename: "fixed.png",
		});

		await waitFor(() => {
			expect(getByAltText("fixed.png")).toHaveAttribute(
				"src",
				"blob:fixed-image",
			);
		});
		expect(queryByRole("alert")).not.toBeInTheDocument();
	});

	it("keeps the load failure visible when reset controls are used on the same broken image", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:broken-image");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

		const { getByAltText, getByLabelText, getByRole } = render(ImagePreview, {
			props: {
				blob: createImageBlob("broken"),
				filename: "broken.png",
			},
		});

		await waitFor(() => {
			expect(getByAltText("broken.png")).toHaveAttribute(
				"src",
				"blob:broken-image",
			);
		});

		await fireEvent.error(getByAltText("broken.png"));
		expect(getByRole("alert")).toHaveTextContent(
			"Failed to load document preview.",
		);

		await fireEvent.click(getByLabelText("Reset zoom"));
		expect(getByRole("alert")).toHaveTextContent(
			"Failed to load document preview.",
		);

		await fireEvent.click(getByLabelText("Fit image"));
		expect(getByRole("alert")).toHaveTextContent(
			"Failed to load document preview.",
		);
	});
});
