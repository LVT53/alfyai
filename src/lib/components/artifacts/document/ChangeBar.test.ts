import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ChangeBar from "./ChangeBar.svelte";

afterEach(() => {
	cleanup();
	uiLanguage.set("en");
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
		render(ChangeBar, {
			...callbacks(),
			blockLabel: "Book the hotel by Friday",
		});
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

	// rd/review-2-5.md:210-216 — Keep/Undo re-mount this widget under a new
	// key, destroying whichever button had focus; "undone" is reachable only
	// via the user's own just-now Undo click, so autofocusing this fresh
	// instance's own Redo button is always correct, never a surprise.
	it("autofocuses its own Redo button once mounted in the undone state", () => {
		render(ChangeBar, { ...callbacks(), status: "undone" });
		expect(screen.getByRole("button", { name: "Redo Alfy's change" })).toBe(
			document.activeElement,
		);
	});

	// G3: the Alfy-change chord (⌘/Ctrl+Alt+Z) can undo a change with the focus
	// still in the text. The pill's Redo button is re-mounted then too, but
	// nothing dropped the focus, so it must not be pulled out of the text.
	it("leaves the focus alone when something else already holds it (an Undo by keyboard from the text)", () => {
		const editor = document.createElement("div");
		editor.tabIndex = 0;
		document.body.appendChild(editor);
		editor.focus();
		expect(document.activeElement).toBe(editor);

		render(ChangeBar, { ...callbacks(), status: "undone" });
		expect(document.activeElement).toBe(editor);
		editor.remove();
	});

	// G3: the documented chords for Alfy's own Undo and Redo, in the tooltip
	// and for assistive technology — the accessible names stay as they were.
	describe("the keyboard shortcut on Undo and Redo", () => {
		const setPlatform = (value: string) =>
			Object.defineProperty(window.navigator, "platform", {
				value,
				configurable: true,
			});
		afterEach(() => {
			Reflect.deleteProperty(window.navigator, "platform");
		});

		it("says Ctrl+Alt+Z in Undo's tooltip and lists it in aria-keyshortcuts, without renaming the button", () => {
			setPlatform("Win32");
			render(ChangeBar, callbacks());
			const undo = screen.getByRole("button", { name: "Undo Alfy's change" });
			expect(undo).toHaveAttribute("title", "Undo Alfy's change (Ctrl+Alt+Z)");
			expect(undo).toHaveAttribute("aria-keyshortcuts", "Control+Alt+Z");
		});

		it("says Ctrl+Alt+Shift+Z on Redo", () => {
			setPlatform("Win32");
			render(ChangeBar, { ...callbacks(), status: "undone" });
			const redo = screen.getByRole("button", { name: "Redo Alfy's change" });
			expect(redo).toHaveAttribute(
				"title",
				"Redo Alfy's change (Ctrl+Alt+Shift+Z)",
			);
			expect(redo).toHaveAttribute("aria-keyshortcuts", "Control+Alt+Shift+Z");
		});

		it("writes the Mac keys on a Mac", () => {
			setPlatform("MacIntel");
			render(ChangeBar, callbacks());
			const undo = screen.getByRole("button", { name: "Undo Alfy's change" });
			expect(undo).toHaveAttribute("title", "Undo Alfy's change (⌥⌘Z)");
			expect(undo).toHaveAttribute("aria-keyshortcuts", "Meta+Alt+Z");
		});

		it("is worded in Hungarian in the Hungarian UI", () => {
			setPlatform("Win32");
			uiLanguage.set("hu");
			render(ChangeBar, callbacks());
			expect(
				screen.getByRole("button", { name: /^Visszavonom/ }),
			).toHaveAttribute("title", "Visszavonom — Alfy módosítása (Ctrl+Alt+Z)");
		});

		it("gives Keep no chord (it is reached with Tab and Enter)", () => {
			render(ChangeBar, callbacks());
			expect(
				screen.getByRole("button", { name: "Keep Alfy's change" }),
			).not.toHaveAttribute("aria-keyshortcuts");
		});
	});

	it("does not steal focus when mounted pending (the common case: a fresh live Alfy edit landing)", () => {
		render(ChangeBar, callbacks());
		expect(screen.getByRole("button", { name: "Keep Alfy's change" })).not.toBe(
			document.activeElement,
		);
	});

	// WCAG 2.5.3 Label in Name — each button's accessible name must literally
	// contain its own visible text, so a voice-control user saying the
	// visible word activates the right control. The Hungarian a11y strings
	// used to name-check "Alfy módosítása" and a DIFFERENT word form of the
	// action ("megtartása"/"visszavonása"/"megismétlése") than the visible
	// buttons ("Megtartom"/"Visszavonom"/"Újra").
	describe("Hungarian accessible names contain their own visible text (WCAG 2.5.3)", () => {
		it("Keep", () => {
			uiLanguage.set("hu");
			render(ChangeBar, callbacks());
			const button = screen.getByRole("button", { name: /^Megtartom/ });
			expect(button).toHaveTextContent("Megtartom");
		});

		it("Undo", () => {
			uiLanguage.set("hu");
			render(ChangeBar, callbacks());
			const button = screen.getByRole("button", { name: /^Visszavonom/ });
			expect(button).toHaveTextContent("Visszavonom");
		});

		it("Redo", () => {
			uiLanguage.set("hu");
			render(ChangeBar, { ...callbacks(), status: "undone" });
			const button = screen.getByRole("button", { name: /^Újra/ });
			expect(button).toHaveTextContent("Újra");
		});
	});
});
