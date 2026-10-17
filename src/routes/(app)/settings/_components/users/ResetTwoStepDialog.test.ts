import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";
import ResetTwoStepDialog from "./ResetTwoStepDialog.svelte";

function renderDialog(overrides: Record<string, unknown> = {}) {
	return render(ResetTwoStepDialog, {
		props: {
			userName: "Dóra",
			adminHasTwoStep: false,
			onClose: vi.fn(),
			onConfirm: vi.fn().mockResolvedValue(undefined),
			...overrides,
		},
	});
}

describe("ResetTwoStepDialog", () => {
	it("names the person, and the copy uses their, not a gendered pronoun", () => {
		renderDialog();

		expect(
			screen.getByText("Reset Dóra's two-step sign-in?"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"This turns it off, deletes their backup codes and signs them out everywhere. They can sign in with their password, then turn it on again.",
			),
		).toBeInTheDocument();
	});

	it("asks for the admin's password, and never for a code the admin does not have", () => {
		renderDialog();

		expect(screen.getByLabelText("Your password")).toBeInTheDocument();
		expect(screen.queryByLabelText("Your code")).not.toBeInTheDocument();
	});

	it("asks for the admin's code when the admin has a factor", () => {
		renderDialog({ adminHasTwoStep: true });

		expect(screen.getByLabelText("Your code")).toBeInTheDocument();
	});

	it("submits the password and the code it was given", async () => {
		const onConfirm = vi.fn().mockResolvedValue(undefined);
		renderDialog({ adminHasTwoStep: true, onConfirm });

		await fireEvent.input(screen.getByLabelText("Your password"), {
			target: { value: "admin-password" },
		});
		await fireEvent.input(screen.getByLabelText("Your code"), {
			target: { value: "123456" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Reset" }));

		await waitFor(() =>
			expect(onConfirm).toHaveBeenCalledWith({
				password: "admin-password",
				code: "123456",
			}),
		);
	});

	it("shows the server's refusal and stays open", async () => {
		const onClose = vi.fn();
		const onConfirm = vi.fn().mockRejectedValue(
			new ApiError("That code didn't work.", {
				status: 401,
				errorKey: "profileTab.twoStepWrongCode",
			}),
		);
		renderDialog({ onConfirm, onClose });

		await fireEvent.input(screen.getByLabelText("Your password"), {
			target: { value: "admin-password" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Reset" }));

		expect(
			await screen.findByText("That code didn't work."),
		).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});
});
