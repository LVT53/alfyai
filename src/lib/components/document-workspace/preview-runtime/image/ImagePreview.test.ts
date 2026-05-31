import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImagePreview from "./ImagePreview.svelte";

function createImageBlob(label: string) {
	return new Blob([label], { type: "image/png" });
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
});
