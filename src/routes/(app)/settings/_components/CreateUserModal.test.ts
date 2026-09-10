import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CreateUserModal from "./CreateUserModal.svelte";

function renderModal(props: Record<string, unknown> = {}) {
	return render(CreateUserModal, {
		props: {
			name: "",
			email: "",
			password: "",
			role: "user",
			showPassword: false,
			onConfirm: vi.fn(),
			onCancel: vi.fn(),
			...props,
		},
	});
}

describe("CreateUserModal", () => {
	it("keeps Create disabled until the email and a long-enough password are set", async () => {
		renderModal();

		const create = screen.getByRole("button", { name: "Create User" });
		expect(create).toBeDisabled();
		// The reason is on screen instead of only being inferred from the button.
		expect(screen.getByText("At least 8 characters")).toBeInTheDocument();

		await fireEvent.input(screen.getByLabelText("Email"), {
			target: { value: "anna.toth@alfy.hu" },
		});
		await fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "short" },
		});
		expect(screen.getByRole("button", { name: "Create User" })).toBeDisabled();

		await fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "long-enough-password" },
		});
		expect(
			screen.getByRole("button", { name: "Create User" }),
		).not.toBeDisabled();
		expect(screen.getByText(/long enough/)).toBeInTheDocument();
	});

	it("generates a password and reveals it", async () => {
		renderModal();

		await fireEvent.click(screen.getByRole("button", { name: "Generate" }));

		const password = screen.getByLabelText("Password") as HTMLInputElement;
		expect(password.value.length).toBeGreaterThanOrEqual(12);
		expect(password.type).toBe("text");
		expect(
			screen.getByRole("button", { name: "Create User" }),
		).toBeDisabled();
	});

	it("states what an admin is allowed to do before the role is chosen", () => {
		renderModal();

		expect(
			screen.getByText(/An admin can read every conversation's metadata/),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Admin" })).toBeInTheDocument();
	});
});
