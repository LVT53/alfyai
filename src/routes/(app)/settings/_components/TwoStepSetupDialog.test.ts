import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";

const mockSetup = vi.hoisted(() => vi.fn());
const mockConfirm = vi.hoisted(() => vi.fn());

vi.mock("$lib/client/api/settings", () => ({
	setupTwoStep: mockSetup,
	confirmTwoStepSetup: mockConfirm,
}));

import TwoStepSetupDialog from "./TwoStepSetupDialog.svelte";

const KEY = "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP";
const CODES = [
	"7KQ4M-2XWPD",
	"R8D2T-9MZQA",
	"H3NV6-K7PLE",
	"W2C8J-4TRFX",
	"P9Q5R-6STUV",
	"A1B2C-3D4EF",
	"G5H6J-7K8LM",
	"N9P0Q-1R2ST",
	"V3W4X-5Y6Z7",
	"B8C9D-0E1F2",
];

function renderDialog(overrides: Record<string, unknown> = {}) {
	return render(TwoStepSetupDialog, {
		props: {
			onClose: vi.fn(),
			onConfirmed: vi.fn(),
			...overrides,
		},
	});
}

async function goToCodeStep() {
	await screen.findByText("Scan this code");
	await fireEvent.click(screen.getByRole("button", { name: "Next" }));
	return screen.getByLabelText("Code");
}

beforeEach(() => {
	vi.clearAllMocks();
	mockSetup.mockResolvedValue({
		qrSvg: '<svg viewBox="0 0 10 10"></svg>',
		key: KEY,
	});
	mockConfirm.mockResolvedValue({
		backupCodes: CODES,
		signedOutOtherDevices: 2,
	});
});

describe("TwoStepSetupDialog", () => {
	it("step 1 shows the server's QR and the key in groups of four", async () => {
		renderDialog();

		expect(await screen.findByText("Scan this code")).toBeInTheDocument();
		expect(screen.getByTestId("two-step-qr")).toBeInTheDocument();
		expect(screen.getByText(KEY)).toBeInTheDocument();
		expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
	});

	it("step 2 does not finish on a wrong code", async () => {
		mockConfirm.mockRejectedValue(
			new ApiError("That code didn't work.", {
				status: 401,
				errorKey: "profileTab.twoStepWrongCode",
			}),
		);
		const onConfirmed = vi.fn();
		renderDialog({ onConfirmed });

		const input = await goToCodeStep();
		await fireEvent.input(input, { target: { value: "000000" } });
		await fireEvent.click(screen.getByRole("button", { name: "Verify" }));

		expect(
			await screen.findByText("That code didn't work."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Enter the code from your app"),
		).toBeInTheDocument();
		expect(onConfirmed).not.toHaveBeenCalled();
	});

	it("a working code leads to the codes and the other-devices notice", async () => {
		const onConfirmed = vi.fn();
		renderDialog({ onConfirmed });

		const input = await goToCodeStep();
		await fireEvent.input(input, { target: { value: "123456" } });
		await fireEvent.click(screen.getByRole("button", { name: "Verify" }));

		expect(
			await screen.findByText("Save your backup codes"),
		).toBeInTheDocument();
		expect(screen.getByText(CODES[0])).toBeInTheDocument();
		expect(
			screen.getByText("You were signed out on your other devices."),
		).toBeInTheDocument();
		expect(onConfirmed).toHaveBeenCalledWith(
			expect.objectContaining({ signedOutOtherDevices: 2 }),
		);
	});

	it("Done stays off until the box is ticked", async () => {
		const onClose = vi.fn();
		renderDialog({ onClose });

		const input = await goToCodeStep();
		await fireEvent.input(input, { target: { value: "123456" } });
		await fireEvent.click(screen.getByRole("button", { name: "Verify" }));
		await screen.findByText("Save your backup codes");

		const done = screen.getByRole("button", { name: "Done" });
		expect(done).toBeDisabled();
		await fireEvent.click(
			screen.getByLabelText("I've saved them somewhere safe"),
		);
		expect(done).toBeEnabled();
		await fireEvent.click(done);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("the codes can be copied and downloaded as a .txt", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const createObjectURL = vi.fn(() => "blob:codes");
		const revokeObjectURL = vi.fn();
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});

		try {
			renderDialog();
			const input = await goToCodeStep();
			await fireEvent.input(input, { target: { value: "123456" } });
			await fireEvent.click(screen.getByRole("button", { name: "Verify" }));
			await screen.findByText("Save your backup codes");

			await fireEvent.click(screen.getByRole("button", { name: "Copy" }));
			expect(writeText).toHaveBeenCalledWith(CODES.join("\n"));

			await fireEvent.click(screen.getByRole("button", { name: "Download" }));
			expect(createObjectURL).toHaveBeenCalledOnce();
			expect(click).toHaveBeenCalledOnce();
		} finally {
			click.mockRestore();
		}
	});
});
