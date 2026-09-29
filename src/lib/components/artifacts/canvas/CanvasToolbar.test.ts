import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { Tool } from "./_lib/annotations";
import CanvasToolbar from "./CanvasToolbar.svelte";

beforeEach(() => {
	uiLanguage.set("en");
});

function mount(
	props: Partial<{
		tool: Tool;
		ink: string;
		compact: boolean;
		canUndo: boolean;
		canRedo: boolean;
		disabled: boolean;
	}> = {},
) {
	const callbacks = {
		ontoolchange: vi.fn(),
		oninkchange: vi.fn(),
		onundo: vi.fn(),
		onredo: vi.fn(),
		oninsert: vi.fn(),
	};
	const view = render(CanvasToolbar, {
		tool: "select",
		ink: "var(--ink-blue)",
		canUndo: true,
		canRedo: true,
		...callbacks,
		...props,
	});
	return { ...view, ...callbacks };
}

const toolbar = () => screen.getByRole("toolbar", { name: "Canvas tools" });

describe("the toolbar", () => {
	it("shows the drawing tools only while a tool that draws is on", () => {
		const off = mount({ tool: "select" });
		expect(screen.queryByTestId("canvas-draw-tray")).toBeNull();
		off.unmount();
		mount({ tool: "pen" });
		expect(screen.getByTestId("canvas-draw-tray")).toBeTruthy();
	});

	it("offers the seven marks and the eraser, each a button that says whether it is on", () => {
		mount({ tool: "highlighter" });
		const tray = screen.getByRole("group", { name: "Drawing tools" });
		const names = [
			"Pen",
			"Highlighter",
			"Line",
			"Arrow",
			"Rectangle",
			"Ellipse",
			"Text",
			"Eraser",
		];
		for (const name of names) {
			const button = within(tray).getByRole("button", { name });
			expect(button.getAttribute("aria-pressed")).toBe(
				name === "Highlighter" ? "true" : "false",
			);
		}
	});

	it("offers the four inks, and says which one is on", () => {
		mount({ tool: "pen", ink: "var(--ink-red)" });
		for (const name of ["Blue ink", "Red ink", "Green ink", "Graphite ink"]) {
			expect(
				screen.getByRole("button", { name }).getAttribute("aria-pressed"),
			).toBe(name === "Red ink" ? "true" : "false");
		}
	});

	it("hands over the tool and the ink that were picked", async () => {
		const { ontoolchange, oninkchange } = mount({ tool: "pen" });
		await fireEvent.click(screen.getByRole("button", { name: "Eraser" }));
		expect(ontoolchange).toHaveBeenCalledWith("eraser");
		await fireEvent.click(screen.getByRole("button", { name: "Green ink" }));
		expect(oninkchange).toHaveBeenCalledWith("var(--ink-green)");
	});

	it("turns Draw on with the tool it was last drawing with, and off again to Select", async () => {
		const { ontoolchange, rerender } = mount({ tool: "highlighter" });
		const draw = screen.getByRole("button", { name: "Draw" });
		expect(draw.getAttribute("aria-pressed")).toBe("true");
		await fireEvent.click(draw);
		expect(ontoolchange).toHaveBeenLastCalledWith("select");
		await rerender({ tool: "select" });
		expect(
			screen.getByRole("button", { name: "Draw" }).getAttribute("aria-pressed"),
		).toBe("false");
		await fireEvent.click(screen.getByRole("button", { name: "Draw" }));
		expect(ontoolchange).toHaveBeenLastCalledWith("highlighter");
	});

	it("starts Draw on the pen", async () => {
		const { ontoolchange } = mount({ tool: "select" });
		await fireEvent.click(screen.getByRole("button", { name: "Draw" }));
		expect(ontoolchange).toHaveBeenCalledWith("pen");
	});

	it("keeps the tools between Draw and Undo in the tab order, one stop per button", () => {
		mount({ tool: "pen", canUndo: true, canRedo: true });
		const names = within(toolbar())
			.getAllByRole("button")
			.map(
				(button) =>
					button.getAttribute("aria-label") ?? button.textContent?.trim(),
			);
		expect(names.slice(0, 3)).toEqual(["Select", "Pan", "Draw"]);
		expect(names.slice(3, 11)).toEqual([
			"Pen",
			"Highlighter",
			"Line",
			"Arrow",
			"Rectangle",
			"Ellipse",
			"Text",
			"Eraser",
		]);
		expect(names.slice(11, 15)).toEqual([
			"Blue ink",
			"Red ink",
			"Green ink",
			"Graphite ink",
		]);
		expect(names[15]).toMatch(/^Undo/);
		expect(names[16]).toMatch(/^Redo/);
		expect(names[17]).toBe("Insert");
		for (const button of within(toolbar()).getAllByRole("button")) {
			expect(button.getAttribute("tabindex")).not.toBe("0");
		}
	});

	it("names undo and redo as the reader's OWN steps, so they cannot be taken for undoing Alfy's change", () => {
		mount();
		expect(
			screen.getByRole("button", { name: /^Undo your last step/ }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /^Redo your step/ }),
		).toBeTruthy();
	});

	it("says the same in Hungarian", () => {
		uiLanguage.set("hu");
		mount({ tool: "pen" });
		expect(screen.getByRole("button", { name: "Rajzolás" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Radír" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Kék tinta" })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /^Saját lépés visszavonása/ }),
		).toBeTruthy();
	});

	it("drops Pan on a narrow board (a finger already pans) and keeps Draw", () => {
		mount({ compact: true });
		expect(screen.queryByRole("button", { name: "Pan" })).toBeNull();
		expect(screen.getByRole("button", { name: "Draw" })).toBeTruthy();
	});

	it("turns every tool off when the board cannot change", () => {
		mount({ tool: "select", disabled: true });
		expect(
			(screen.getByRole("button", { name: "Draw" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: /^Undo/ }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
});
