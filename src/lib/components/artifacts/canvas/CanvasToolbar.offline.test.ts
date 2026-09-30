import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import CanvasToolbar from "./CanvasToolbar.svelte";

// The menu of blocks loads the first time it is opened. When its code cannot be
// fetched (the network went away, or a deploy replaced it) the menu must not
// stand open and empty: it closes, and the next press tries again.
vi.mock("./InsertMenu.svelte", () => {
	throw new Error("Failed to fetch dynamically imported module");
});

beforeEach(() => {
	uiLanguage.set("en");
});

describe("the toolbar when the menu of blocks cannot be fetched", () => {
	it("closes the menu again instead of leaving it open with nothing in it", async () => {
		render(CanvasToolbar, {
			tool: "select",
			ink: "var(--ink-blue)",
			canUndo: false,
			canRedo: false,
			Tray: null,
			ontoolchange: vi.fn(),
			oninkchange: vi.fn(),
			onundo: vi.fn(),
			onredo: vi.fn(),
			oninsert: vi.fn(),
			onask: vi.fn(),
		});
		const insert = screen.getByRole("button", { name: "Insert" });
		await fireEvent.click(insert);
		await waitFor(() =>
			expect(insert.getAttribute("aria-expanded")).toBe("false"),
		);
		expect(screen.queryByTestId("canvas-insert-menu")).toBeNull();
		// Nothing was left unhandled: the button still answers.
		await fireEvent.click(insert);
		await waitFor(() =>
			expect(insert.getAttribute("aria-expanded")).toBe("false"),
		);
	});
});
