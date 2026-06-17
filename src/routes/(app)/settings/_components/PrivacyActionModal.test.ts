import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import PrivacyActionModal from "./PrivacyActionModal.svelte";

describe("PrivacyActionModal", () => {
	it("requires a password before confirming an archive download", async () => {
		const onConfirm = vi.fn();

		render(PrivacyActionModal, {
			action: "archive",
			password: "",
			showPassword: false,
			onConfirm,
			onCancel: vi.fn(),
		});

		expect(
			screen.getByRole("heading", { name: "Download my data" }),
		).toBeInTheDocument();
		const confirmButton = screen.getByRole("button", {
			name: "Download my data",
		});
		expect(confirmButton).toBeDisabled();

		await fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "pw" },
		});
		await fireEvent.click(confirmButton);

		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("offers data download before destructive confirmation without blocking deletion", async () => {
		const onConfirm = vi.fn();
		const onDownloadArchive = vi.fn();

		render(PrivacyActionModal, {
			action: "deleteAccount",
			password: "pw",
			showPassword: false,
			onConfirm,
			onCancel: vi.fn(),
			onDownloadArchive,
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Download my data" }),
		);
		expect(onDownloadArchive).toHaveBeenCalledOnce();

		await fireEvent.click(
			screen.getByRole("button", { name: "Delete account" }),
		);
		expect(onConfirm).toHaveBeenCalledOnce();
	});
});
