import { render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ConfirmDialog from "./ConfirmDialog.svelte";

// Where the focus is when the dialog opens: one more Enter, or an Enter held
// down from the button that opened it, lands on that button.
describe("ConfirmDialog initial focus", () => {
	const props = {
		title: "Delete 3 chats?",
		message: "This can't be undone.",
		confirmText: "Delete",
		cancelText: "Keep",
		confirmVariant: "danger" as const,
		onConfirm: vi.fn(),
		onCancel: vi.fn(),
	};

	// DialogShell moves the focus to its first focusable child a tick after it
	// opens, unless the dialog's own content already holds it: a settled
	// dialog is the one to look at, not the first frame.
	async function settle() {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("focuses the confirm button by default, as every existing caller expects", async () => {
		render(ConfirmDialog, { props });
		await settle();

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus(),
		);
		expect(screen.getByRole("button", { name: "Keep" })).not.toHaveFocus();
	});

	it("focuses the confirm button when initialFocus is confirm", async () => {
		render(ConfirmDialog, { props: { ...props, initialFocus: "confirm" } });
		await settle();

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus(),
		);
	});

	it("focuses Cancel when initialFocus is cancel", async () => {
		render(ConfirmDialog, { props: { ...props, initialFocus: "cancel" } });
		await settle();

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus(),
		);
		expect(screen.getByRole("button", { name: "Delete" })).not.toHaveFocus();
	});

	it("still confirms and cancels from either button", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(ConfirmDialog, {
			props: { ...props, initialFocus: "cancel", onConfirm, onCancel },
		});

		screen.getByRole("button", { name: "Delete" }).click();
		screen.getByRole("button", { name: "Keep" }).click();

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
