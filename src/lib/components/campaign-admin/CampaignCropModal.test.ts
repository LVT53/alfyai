import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
