import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import CampaignCropModal from "./CampaignCropModal.svelte";

describe("CampaignCropModal", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("renders a fixed-ratio campaign crop dialog with zoom, reset, cancel, and save controls", () => {
		render(CampaignCropModal, {
			props: {
				imageSrc: "data:image/png;base64,c291cmNl",
				ratio: 16 / 10,
				variant: "desktop",
				onSave: vi.fn(),
				onCancel: vi.fn(),
			},
		});

		expect(
			screen.getByRole("dialog", { name: "Crop campaign screenshot" }),
		).toBeInTheDocument();
		expect(screen.getByText("16:10 desktop crop")).toBeInTheDocument();
		expect(screen.getByRole("slider", { name: "Zoom" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Save crop" }),
		).toBeInTheDocument();
	});

	it("calls the cancel callback from the modal controls", async () => {
		const onCancel = vi.fn();
		render(CampaignCropModal, {
			props: {
				imageSrc: "data:image/png;base64,c291cmNl",
				ratio: 9 / 16,
				variant: "mobile",
				onCancel,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("localizes the cropper chrome and mobile crop metadata", () => {
		uiLanguage.set("hu");

		render(CampaignCropModal, {
			props: {
				imageSrc: "data:image/png;base64,c291cmNl",
				ratio: 9 / 16,
				variant: "mobile",
				onSave: vi.fn(),
				onCancel: vi.fn(),
			},
		});

		expect(
			screen.getByRole("dialog", { name: "Kampány képernyőkép kivágása" }),
		).toBeInTheDocument();
		expect(screen.getByText("9:16 mobil kivágás")).toBeInTheDocument();
		expect(
			screen.getByRole("slider", { name: "Nagyítás" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Visszaállítás" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Mégse" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Kivágás mentése" }),
		).toBeInTheDocument();
	});

	it("does not scroll the settings page when trapping and restoring focus", async () => {
		const opener = document.createElement("button");
		document.body.append(opener);
		opener.focus();
		const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

		const { unmount } = render(CampaignCropModal, {
			props: {
				imageSrc: "data:image/png;base64,c291cmNl",
				ratio: 9 / 16,
				variant: "mobile",
				onSave: vi.fn(),
				onCancel: vi.fn(),
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

		unmount();
		expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
		opener.remove();
		focusSpy.mockRestore();
	});
});

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

describe("CampaignCropModal keyboard and focus", () => {
	const imageSrc = "data:image/png;base64,c291cmNl";

	beforeEach(() => {
		uiLanguage.set("en");
		// jsdom has no canvas: hand the preview and the save path a context that
		// accepts the draw calls. `toBlob` is left to the tests that save.
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			clearRect: vi.fn(),
			drawImage: vi.fn(),
		} as unknown as RenderingContext);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function renderCrop(props: Record<string, unknown> = {}) {
		return render(CampaignCropModal, {
			props: {
				imageSrc,
				ratio: 16 / 10,
				variant: "desktop",
				onSave: vi.fn(),
				onCancel: vi.fn(),
				...props,
			},
		});
	}

	// The crop controls only become usable once the image has loaded and
	// reported a size.
	async function loadImage(container: HTMLElement) {
		const image = container.querySelector("img");
		if (!(image instanceof HTMLImageElement)) {
			throw new Error("Expected the crop image to render.");
		}
		Object.defineProperty(image, "naturalWidth", {
			configurable: true,
			value: 1600,
		});
		Object.defineProperty(image, "naturalHeight", {
			configurable: true,
			value: 1000,
		});
		await fireEvent.load(image);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Save crop" })).toBeEnabled(),
		);
	}

	it("puts focus on the dialog panel itself when it opens", async () => {
		renderCrop();
		const dialog = screen.getByRole("dialog", {
			name: "Crop campaign screenshot",
		});

		await waitFor(() => expect(dialog).toHaveFocus());
	});

	it("cancels on Escape and cancels the key", async () => {
		const onCancel = vi.fn();
		renderCrop({ onCancel });

		const event = pressKey("Escape");

		expect(event.defaultPrevented).toBe(true);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("ignores Escape while a crop is being saved", async () => {
		// `toBlob` never calls back, so the save stays in flight.
		vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
			() => {},
		);
		const onCancel = vi.fn();
		const { container } = renderCrop({ onCancel });
		await loadImage(container);

		await fireEvent.click(screen.getByRole("button", { name: "Save crop" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled(),
		);
		pressKey("Escape");

		expect(onCancel).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("wraps Tab from the last enabled control to the first, and Shift+Tab back", async () => {
		const { container } = renderCrop();
		await loadImage(container);
		const close = screen.getByRole("button", { name: "Close" });
		const save = screen.getByRole("button", { name: "Save crop" });

		save.focus();
		const forward = pressKey("Tab");
		expect(close).toHaveFocus();
		expect(forward.defaultPrevented).toBe(true);

		const backward = pressKey("Tab", { shiftKey: true });
		expect(save).toHaveFocus();
		expect(backward.defaultPrevented).toBe(true);
	});

	it("takes the ends from the enabled controls only", async () => {
		// Before the image loads Reset, the slider and Save are disabled, so
		// Cancel is the last stop.
		renderCrop();
		const close = screen.getByRole("button", { name: "Close" });
		const cancel = screen.getByRole("button", { name: "Cancel" });

		cancel.focus();
		const forward = pressKey("Tab");
		expect(close).toHaveFocus();
		expect(forward.defaultPrevented).toBe(true);

		const backward = pressKey("Tab", { shiftKey: true });
		expect(cancel).toHaveFocus();
		expect(backward.defaultPrevented).toBe(true);
	});

	it("leaves Tab between the two ends to the browser", async () => {
		const { container } = renderCrop();
		await loadImage(container);
		const reset = screen.getByRole("button", { name: "Reset" });

		reset.focus();
		const event = pressKey("Tab");

		expect(reset).toHaveFocus();
		expect(event.defaultPrevented).toBe(false);
	});
});
