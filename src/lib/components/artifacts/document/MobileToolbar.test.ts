import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import MobileToolbar from "./MobileToolbar.svelte";
import { DOCUMENT_TOOLBAR_ACTIONS } from "./toolbar-actions";

afterEach(() => {
	cleanup();
});

describe("MobileToolbar", () => {
	it("puts exactly 6 primary actions on the row, plus the More trigger", () => {
		render(MobileToolbar, { onAction: vi.fn() });
		const toolbar = screen.getByRole("toolbar", { name: "Document" });
		const buttons = toolbar.querySelectorAll("button");
		// 6 primary + 1 "More" trigger.
		expect(buttons).toHaveLength(7);
	});

	// T11.2: every action id in the desktop toolbar must be reachable from
	// mobile too — asserted on IDS, not labels, so the two toolbars cannot
	// silently drift apart. Clicking through the row (minus "More") and then
	// every sheet item and collecting the ids `onAction` actually received is
	// a direct proof, not just a structural count.
	it("makes every desktop toolbar action id reachable, split between the row and the sheet", async () => {
		const onAction = vi.fn();
		render(MobileToolbar, { onAction });

		const moreButton = screen.getByRole("button", { name: "More" });
		const rowButtons = Array.from(
			screen
				.getByRole("toolbar", { name: "Document" })
				.querySelectorAll("button"),
		).filter((button) => button !== moreButton);
		for (const button of rowButtons) {
			await fireEvent.click(button);
		}

		await fireEvent.click(moreButton);
		const sheetButtonCount = screen
			.getByRole("dialog")
			.querySelectorAll("button").length;
		// Every click closes the sheet (T11's own contract), which DESTROYS and
		// re-creates its button elements on the next open — so each iteration
		// re-queries the dialog fresh at a fixed index rather than reusing a
		// stale element reference from an earlier render.
		for (let index = 0; index < sheetButtonCount; index += 1) {
			if (index > 0) await fireEvent.click(moreButton);
			const button = screen.getByRole("dialog").querySelectorAll("button")[
				index
			];
			await fireEvent.click(button);
		}

		const reachedIds = new Set(onAction.mock.calls.map((call) => call[0]));
		const allIds = new Set(DOCUMENT_TOOLBAR_ACTIONS.map((action) => action.id));
		expect(reachedIds).toEqual(allIds);
		// The two lists partition the full set: no id doubles up as both a row
		// button and a sheet item.
		expect(rowButtons.length + sheetButtonCount).toBe(
			DOCUMENT_TOOLBAR_ACTIONS.length,
		);
	});

	it("opens the sheet on More, and closing it returns focus to the More button", async () => {
		render(MobileToolbar, { onAction: vi.fn() });
		const moreButton = screen.getByRole("button", { name: "More" });

		await fireEvent.click(moreButton);
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(moreButton).toHaveFocus();
	});

	it("clicking an overflow action fires onAction with that action's id and closes the sheet", async () => {
		const onAction = vi.fn();
		render(MobileToolbar, { onAction });
		await fireEvent.click(screen.getByRole("button", { name: "More" }));

		// "Table" is not one of the 6 primary actions, so it must be in the sheet.
		await fireEvent.click(screen.getByRole("button", { name: "Table" }));
		expect(onAction).toHaveBeenCalledExactlyOnceWith("table");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("clicking the backdrop closes the sheet without firing an action", async () => {
		const onAction = vi.fn();
		const { container } = render(MobileToolbar, { onAction });
		await fireEvent.click(screen.getByRole("button", { name: "More" }));

		const backdrop = container.querySelector(".mobile-toolbar-sheet-backdrop");
		expect(backdrop).toBeTruthy();
		if (backdrop) await fireEvent.click(backdrop);

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(onAction).not.toHaveBeenCalled();
	});

	it("disables every action while the editor is not ready", () => {
		render(MobileToolbar, { disabled: true, onAction: vi.fn() });
		const toolbar = screen.getByRole("toolbar", { name: "Document" });
		for (const button of Array.from(toolbar.querySelectorAll("button"))) {
			expect(button).toBeDisabled();
		}
	});

	// RV-1B: the UI states contract ("Focus and keyboard order") requires "The
	// More sheet traps focus while open" — the sheet renders
	// role="dialog" aria-modal="true", but nothing enforced it: there was no
	// Tab handling at all, so a sighted keyboard user could Tab straight
	// through the "modal" sheet into the primary toolbar row sitting behind
	// it. Mirrors `DialogShell.svelte`'s own `trapTabNavigation` test shape
	// (`DialogShell.test.ts`'s "Tab focus trap" describe block): a positive
	// assertion that Tab/Shift+Tab actively wraps, not just that nothing
	// visibly breaks (jsdom has no native Tab-moves-focus behavior at all, so
	// the only way to prove trapping is to prove the component's OWN handler
	// moves focus).
	describe("the More sheet's focus trap", () => {
		it("wraps Shift+Tab from the sheet's first action to its last action", async () => {
			render(MobileToolbar, { onAction: vi.fn() });
			await fireEvent.click(screen.getByRole("button", { name: "More" }));
			const dialog = screen.getByRole("dialog");
			const sheetButtons = Array.from(
				dialog.querySelectorAll("button"),
			) as HTMLButtonElement[];
			expect(sheetButtons.length).toBeGreaterThan(1);
			const [first] = sheetButtons;
			const last = sheetButtons[sheetButtons.length - 1];

			first.focus();
			expect(first).toHaveFocus();
			await fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
			expect(last).toHaveFocus();
		});

		it("wraps Tab from the sheet's last action back to its first action", async () => {
			render(MobileToolbar, { onAction: vi.fn() });
			await fireEvent.click(screen.getByRole("button", { name: "More" }));
			const dialog = screen.getByRole("dialog");
			const sheetButtons = Array.from(
				dialog.querySelectorAll("button"),
			) as HTMLButtonElement[];
			const [first] = sheetButtons;
			const last = sheetButtons[sheetButtons.length - 1];

			last.focus();
			expect(last).toHaveFocus();
			await fireEvent.keyDown(dialog, { key: "Tab" });
			expect(first).toHaveFocus();
		});

		it("pulls focus back into the sheet if it somehow lands outside it", async () => {
			render(MobileToolbar, { onAction: vi.fn() });
			const moreButton = screen.getByRole("button", { name: "More" });
			await fireEvent.click(moreButton);
			const dialog = screen.getByRole("dialog");
			const sheetButtons = Array.from(
				dialog.querySelectorAll("button"),
			) as HTMLButtonElement[];
			const [first] = sheetButtons;

			// The trigger behind the backdrop still exists in the DOM and is a
			// real focusable element, so a stray Tab landing back on it (a race
			// with the sheet's own opening focus-move, or a programmatic focus
			// call elsewhere) must be pulled back into the sheet, not left there.
			moreButton.focus();
			await fireEvent.keyDown(dialog, { key: "Tab" });
			expect(first).toHaveFocus();
		});
	});
});
