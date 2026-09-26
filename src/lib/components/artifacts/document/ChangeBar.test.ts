import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChangeBar from "./ChangeBar.svelte";

afterEach(() => {
	cleanup();
});

describe("ChangeBar", () => {
	it('shows "Alfy · Keep · Undo" with no comment badge when there are no comments', () => {
		render(ChangeBar, { onKeep: vi.fn(), onUndo: vi.fn() });
		const bar = screen.getByTestId("alfy-change-bar");
		expect(bar).toHaveTextContent("Alfy");
		expect(bar).toHaveTextContent("Keep");
		expect(bar).toHaveTextContent("Undo");
		expect(screen.queryByText("3")).not.toBeInTheDocument();
	});

	it("shows the comment count for the block when there is one", () => {
		render(ChangeBar, { commentCount: 3, onKeep: vi.fn(), onUndo: vi.fn() });
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("calls onKeep when Keep is clicked", async () => {
		const onKeep = vi.fn();
		render(ChangeBar, { onKeep, onUndo: vi.fn() });
		await fireEvent.click(screen.getByRole("button", { name: "Keep" }));
		expect(onKeep).toHaveBeenCalledOnce();
	});

	it("calls onUndo when Undo is clicked", async () => {
		const onUndo = vi.fn();
		render(ChangeBar, { onKeep: vi.fn(), onUndo });
		await fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		expect(onUndo).toHaveBeenCalledOnce();
	});

	it('shows "Kept." once kept, in place of the Keep/Undo actions', () => {
		render(ChangeBar, { status: "kept", onKeep: vi.fn(), onUndo: vi.fn() });
		expect(screen.getByTestId("alfy-change-bar")).toHaveTextContent("Kept.");
		expect(
			screen.queryByRole("button", { name: "Keep" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Undo" }),
		).not.toBeInTheDocument();
	});

	it("shows the undone notice once undone", () => {
		render(ChangeBar, { status: "undone", onKeep: vi.fn(), onUndo: vi.fn() });
		expect(screen.getByTestId("alfy-change-bar")).toHaveTextContent(
			"Undone — your text is back.",
		);
	});
});
