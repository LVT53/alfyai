import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ListGridToggle from "./ListGridToggle.svelte";

describe("ListGridToggle", () => {
	beforeEach(() => uiLanguage.set("en"));

	it("says which view is on and asks for the other", async () => {
		const onChange = vi.fn();
		render(ListGridToggle, { view: "list", onChange, testIdPrefix: "x-view" });
		expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		const grid = screen.getByRole("button", { name: "Grid view" });
		expect(grid).toHaveAttribute("aria-pressed", "false");
		expect(grid).toHaveAttribute("data-testid", "x-view-grid");
		await fireEvent.click(grid);
		expect(onChange).toHaveBeenCalledWith("grid");
	});

	it("names itself in Hungarian", async () => {
		uiLanguage.set("hu");
		render(ListGridToggle, {
			view: "grid",
			onChange: vi.fn(),
			testIdPrefix: "x-view",
		});
		await tick();
		expect(screen.getByRole("group", { name: "Nézet" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Listanézet" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Rácsnézet" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});
});
