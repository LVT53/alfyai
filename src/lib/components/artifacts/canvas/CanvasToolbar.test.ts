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
		askBusy: boolean;
	}> = {},
) {
	const callbacks = {
		ontoolchange: vi.fn(),
		oninkchange: vi.fn(),
		onundo: vi.fn(),
		onredo: vi.fn(),
		oninsert: vi.fn(),
		onask: vi.fn(),
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
		expect(names[15]).toBe("Comment");
		expect(names[16]).toMatch(/^Undo/);
		expect(names[17]).toMatch(/^Redo/);
		expect(names[18]).toBe("Insert");
		// Ask Alfy is the last stop: the tools come first, then the asking.
		expect(names[19]).toBe("Ask Alfy");
		for (const button of within(toolbar()).getAllByRole("button")) {
			expect(button.getAttribute("tabindex")).not.toBe("0");
		}
	});

	it("offers the Comment tool as a mode: pressed while it is on, and it hands over 'comment' when pressed", async () => {
		const { ontoolchange, rerender } = mount({ tool: "select" });
		const button = screen.getByRole("button", { name: "Comment" });
		expect(button.getAttribute("aria-pressed")).toBe("false");
		await fireEvent.click(button);
		expect(ontoolchange).toHaveBeenCalledWith("comment");
		await rerender({ tool: "comment" });
		const on = screen.getByRole("button", { name: "Comment" });
		expect(on.getAttribute("aria-pressed")).toBe("true");
		// It is not a drawing tool: the tray stays shut.
		expect(screen.queryByTestId("canvas-draw-tray")).toBeNull();
		await fireEvent.click(on);
		expect(ontoolchange).toHaveBeenLastCalledWith("select");
	});

	it("keeps the Comment tool on a narrow board, and turns it off with the rest when the board cannot change", () => {
		const narrow = mount({ compact: true });
		expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
		narrow.unmount();
		mount({ disabled: true });
		expect(
			(screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
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
		expect(screen.getByRole("button", { name: "Megjegyzés" })).toBeTruthy();
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

	it("has Ask Alfy at the end, named for what it does, and it asks", async () => {
		const { onask } = mount();
		const ask = screen.getByRole("button", { name: "Ask Alfy" });
		expect(ask).toBe(within(toolbar()).getAllByRole("button").at(-1));
		await fireEvent.click(ask);
		expect(onask).toHaveBeenCalledTimes(1);
	});

	it("waits while Alfy is arranging, and says why", async () => {
		const { onask } = mount({ askBusy: true });
		const ask = screen.getByRole("button", { name: "Ask Alfy" });
		expect(ask.hasAttribute("disabled")).toBe(true);
		expect(ask.getAttribute("title")).toBe(
			"Alfy is still arranging. Try again in a moment.",
		);
		await fireEvent.click(ask);
		expect(onask).not.toHaveBeenCalled();
	});

	it("waits when the board cannot change", () => {
		mount({ disabled: true });
		expect(
			screen.getByRole("button", { name: "Ask Alfy" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("keeps the name and drops the words on a narrow board, like Insert's neighbours", () => {
		mount({ compact: true });
		const ask = screen.getByRole("button", { name: "Ask Alfy" });
		expect(ask.textContent?.trim()).toBe("");
	});

	it("says it in Hungarian", () => {
		uiLanguage.set("hu");
		mount();
		expect(
			screen.getByRole("button", { name: "Alfy megkérdezése" }),
		).toBeTruthy();
	});
});
