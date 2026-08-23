import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, showToast } from "$lib/stores/toast";
import Toast from "./Toast.svelte";

describe("Toast", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearToasts();
	});

	afterEach(() => {
		clearToasts();
		vi.useRealTimers();
	});

	it("renders nothing when there are no active toasts", () => {
		render(Toast);

		expect(screen.queryByTestId("toast-entry")).not.toBeInTheDocument();
	});

	it("renders a pushed success toast with an accessible status role", async () => {
		render(Toast);

		showToast({ type: "success", message: "Copied to clipboard" });
		await tick();

		const entry = screen.getByRole("status");
		expect(entry).toHaveTextContent("Copied to clipboard");
	});

	it("renders a pushed error toast with an accessible alert role", async () => {
		render(Toast);

		showToast({ type: "error", message: "Couldn't copy to clipboard" });
		await tick();

		const entry = screen.getByRole("alert");
		expect(entry).toHaveTextContent("Couldn't copy to clipboard");
	});

	it("auto-dismisses a toast after its duration elapses", async () => {
		render(Toast);

		showToast({ type: "success", message: "Bye soon", duration: 1000 });
		await tick();
		expect(screen.getByTestId("toast-entry")).toBeInTheDocument();

		vi.advanceTimersByTime(1000);
		await tick();

		expect(screen.queryByTestId("toast-entry")).not.toBeInTheDocument();
	});

	it("dismisses a toast via its manual close button", async () => {
		render(Toast);

		showToast({ type: "success", message: "Close me", duration: 0 });
		await tick();
		const closeButton = screen.getByRole("button", { name: "Close" });

		await fireEvent.click(closeButton);

		expect(screen.queryByTestId("toast-entry")).not.toBeInTheDocument();
	});
});
