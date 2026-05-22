import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SidebarReorderControls from "./SidebarReorderControls.svelte";

describe("SidebarReorderControls", () => {
	it("moves an item up and down through accessible controls", async () => {
		const onMove = vi.fn();
		render(SidebarReorderControls, {
			id: "conv-1",
			label: "Quarterly plan",
			index: 1,
			total: 3,
			onMove,
			onDragStart: vi.fn(),
			onDragEnd: vi.fn(),
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Move Quarterly plan up" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Move Quarterly plan down" }),
		);

		expect(onMove).toHaveBeenNthCalledWith(1, {
			id: "conv-1",
			direction: "up",
		});
		expect(onMove).toHaveBeenNthCalledWith(2, {
			id: "conv-1",
			direction: "down",
		});
	});

	it("disables unavailable keyboard reorder directions", () => {
		render(SidebarReorderControls, {
			id: "project-1",
			label: "House tasks",
			index: 0,
			total: 1,
			onMove: vi.fn(),
			onDragStart: vi.fn(),
			onDragEnd: vi.fn(),
		});

		expect(
			screen.getByRole("button", { name: "Move House tasks up" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Move House tasks down" }),
		).toBeDisabled();
	});

	it("starts pointer reorder from the drag handle", async () => {
		const onDragStart = vi.fn();
		const onDragEnd = vi.fn();
		render(SidebarReorderControls, {
			id: "project-1",
			label: "House tasks",
			index: 0,
			total: 2,
			onMove: vi.fn(),
			onDragStart,
			onDragEnd,
		});

		await fireEvent.dragStart(
			screen.getByRole("button", { name: "Reorder House tasks" }),
		);
		await fireEvent.dragEnd(
			screen.getByRole("button", { name: "Reorder House tasks" }),
		);

		expect(onDragStart).toHaveBeenCalledWith({ id: "project-1" });
		expect(onDragEnd).toHaveBeenCalledWith({ id: "project-1" });
	});
});
