// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SidebarReorderRowWrapper from "./SidebarReorderRowWrapper.test.svelte";

describe("SidebarReorderRow", () => {
	it("starts pointer reorder from the whole row", async () => {
		const onDragStart = vi.fn();
		const onDragEnd = vi.fn();
		render(SidebarReorderRowWrapper, {
			onDragStart,
			onDragEnd,
		});

		const row = screen.getByTestId("sidebar-reorder-row");
		await fireEvent.dragStart(row);
		await fireEvent.dragEnd(row);

		expect(onDragStart).toHaveBeenCalledWith({ id: "row-1" });
		expect(onDragEnd).toHaveBeenCalledWith({ id: "row-1" });
		expect(screen.getByTestId("row-content")).toBeInTheDocument();
	});

	it("does not render separate reorder buttons", () => {
		render(SidebarReorderRowWrapper);

		expect(
			screen.queryByRole("button", { name: /Move Quarterly plan/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Reorder Quarterly plan/i }),
		).not.toBeInTheDocument();
	});

	it("forwards row drag-over and drop events", async () => {
		const onDragOver = vi.fn();
		const onDrop = vi.fn();
		render(SidebarReorderRowWrapper, {
			onDragOver,
			onDrop,
		});

		const row = screen.getByTestId("sidebar-reorder-row");
		await fireEvent.dragOver(row);
		await fireEvent.drop(row);

		expect(onDragOver).toHaveBeenCalledOnce();
		expect(onDrop).toHaveBeenCalledOnce();
	});
});
