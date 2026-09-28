import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChangeBar from "./ChangeBar.svelte";

afterEach(() => {
	cleanup();
});

function callbacks() {
	return { onKeep: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() };
}

describe("ChangeBar", () => {
	it('shows "Alfy · Keep · Undo" with no comment badge when there are no comments', () => {
		render(ChangeBar, callbacks());
		const bar = screen.getByTestId("alfy-change-bar");
		expect(bar).toHaveTextContent("Alfy");
		expect(bar).toHaveTextContent("Keep");
		expect(bar).toHaveTextContent("Undo");
		expect(screen.queryByText("3")).not.toBeInTheDocument();
	});

	it("is a role=group named after the changed block", () => {
		render(ChangeBar, { ...callbacks(), blockLabel: "Book the hotel by Friday" });
		expect(
			screen.getByRole("group", {
				name: "Alfy's change: Book the hotel by Friday",
			}),
		).toBeInTheDocument();
	});

	it("shows the comment count for the block when there is one", () => {
		render(ChangeBar, { ...callbacks(), commentCount: 3 });
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("calls onKeep when Keep is clicked", async () => {
		const onKeep = vi.fn();
		render(ChangeBar, { ...callbacks(), onKeep });
		await fireEvent.click(
			screen.getByRole("button", { name: "Keep Alfy's change" }),
		);
		expect(onKeep).toHaveBeenCalledOnce();
	});

	it("calls onUndo when Undo is clicked", async () => {
		const onUndo = vi.fn();
		render(ChangeBar, { ...callbacks(), onUndo });
		await fireEvent.click(
			screen.getByRole("button", { name: "Undo Alfy's change" }),
		);
		expect(onUndo).toHaveBeenCalledOnce();
	});

	it('shows "Kept" once kept, in place of the Keep/Undo actions', () => {
		render(ChangeBar, { ...callbacks(), status: "kept" });
		expect(screen.getByTestId("alfy-change-bar")).toHaveTextContent("Kept");
		expect(
			screen.queryByRole("button", { name: "Keep Alfy's change" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Undo Alfy's change" }),
		).not.toBeInTheDocument();
	});

	it('shows "Undone" plus a Redo action once undone', () => {
		render(ChangeBar, { ...callbacks(), status: "undone" });
		const bar = screen.getByTestId("alfy-change-bar");
		expect(bar).toHaveTextContent("Undone");
		expect(
			screen.getByRole("button", { name: "Redo Alfy's change" }),
		).toBeInTheDocument();
	});

	it("calls onRedo when Redo is clicked", async () => {
		const onRedo = vi.fn();
		render(ChangeBar, { ...callbacks(), status: "undone", onRedo });
		await fireEvent.click(
			screen.getByRole("button", { name: "Redo Alfy's change" }),
		);
		expect(onRedo).toHaveBeenCalledOnce();
	});
});
