import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MobileToolbar from "./MobileToolbar.svelte";
import { DOCUMENT_TOOLBAR_ACTIONS } from "./toolbar-actions";

// DialogShell's backdrop/panel transitions are reduced-motion-aware
// (`reducedMotionAware`), not instant by default — the same reason
// `DialogShell.test.ts` itself never asserts DOM removal after a close.
// Stubbing `prefers-reduced-motion: reduce` here collapses them to 0ms so a
// close is reflected in the DOM by the very next `tick()`/render flush,
// exactly like every other reduced-motion-aware component test in this repo.
function stubReducedMotion() {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		})),
	);
}

beforeEach(() => {
	stubReducedMotion();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function pressEscape() {
	window.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		}),
	);
}

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
			.querySelectorAll(".mobile-toolbar-sheet-item").length;
		// Every click closes the sheet (T11's own contract), which DESTROYS and
		// re-creates its button elements on the next open — so each iteration
		// re-queries the dialog fresh at a fixed index rather than reusing a
		// stale element reference from an earlier render.
		for (let index = 0; index < sheetButtonCount; index += 1) {
			if (index > 0) await fireEvent.click(moreButton);
			const button = screen
				.getByRole("dialog")
				.querySelectorAll(".mobile-toolbar-sheet-item")[index];
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

	it("disables every action while the editor is not ready", () => {
		render(MobileToolbar, { disabled: true, onAction: vi.fn() });
		const toolbar = screen.getByRole("toolbar", { name: "Document" });
		for (const button of Array.from(toolbar.querySelectorAll("button"))) {
			expect(button).toBeDisabled();
		}
	});

	// Redesign §5.2/§9.3: the More sheet is DialogShell (phonePresentation
	// "sheet"), not a hand-rolled dialog — its own focus trap/Escape/backdrop
	// behaviour is DialogShell's own tested contract (DialogShell.test.ts);
	// these tests cover the INTEGRATION — the title, the sheet shape on a
	// phone, and that this component's own action/close wiring still works
	// through it.
	describe('the More sheet (DialogShell, phonePresentation="sheet")', () => {
		it("has a title naming it, and closing it returns focus to the More button", async () => {
			render(MobileToolbar, { onAction: vi.fn() });
			const moreButton = screen.getByRole("button", { name: "More" });

			await fireEvent.click(moreButton);
			const dialog = screen.getByRole("dialog", { name: "More formatting" });
			expect(dialog).toBeInTheDocument();

			pressEscape();
			await tick();
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(moreButton).toHaveFocus();
		});

		// Regression: this toolbar (and the sheet it opens) lives inside
		// DocumentWorkspace.svelte's mobile shell, whose own
		// `.workspace-mobile-backdrop` paints at z-index 95. DialogShell's
		// default z-50 rendered the sheet BEHIND that backdrop — invisible in a
		// real browser even though every other check (role, text, geometry)
		// passed, since jsdom does not paint. Caught only by looking at an
		// actual screenshot; asserted here so the override can't silently
		// regress back to the default.
		it("renders above the document workspace's own mobile backdrop (z-index 95)", async () => {
			render(MobileToolbar, { onAction: vi.fn() });
			await fireEvent.click(screen.getByRole("button", { name: "More" }));
			// zIndexClass lands on DialogShell's own fixed backdrop wrapper, the
			// dialog's parent — not on the role="dialog" element itself.
			expect(screen.getByRole("dialog").parentElement?.className).toContain(
				"z-[150]",
			);
		});

		it("renders as a bottom sheet with a grabber (a real close affordance) on a phone", async () => {
			vi.stubGlobal("innerWidth", 390);
			render(MobileToolbar, { onAction: vi.fn() });
			await fireEvent.click(screen.getByRole("button", { name: "More" }));

			const dialog = screen.getByRole("dialog");
			expect(dialog.className).toContain("dialog-sheet");
			expect(screen.getByTestId("dialog-sheet-grabber")).toBeInTheDocument();
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

		it("clicking the scrim closes the sheet without firing an action", async () => {
			const onAction = vi.fn();
			render(MobileToolbar, { onAction });
			await fireEvent.click(screen.getByRole("button", { name: "More" }));

			await fireEvent.click(screen.getByRole("button", { name: "Close" }));

			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(onAction).not.toHaveBeenCalled();
		});
	});
});
