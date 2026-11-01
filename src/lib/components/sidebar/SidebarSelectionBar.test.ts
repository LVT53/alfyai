import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import commonDict from "$lib/i18n/common";
import type { Project } from "$lib/server/services/projects";
import { uiLanguage } from "$lib/stores/settings";
import SidebarSelectionBar from "./SidebarSelectionBar.svelte";

function project(id: string, name: string): Project {
	return {
		id,
		name,
		color: null,
		sortOrder: 0,
		createdAt: 1,
		updatedAt: 1,
		hasInstructions: false,
	};
}

const projects = [project("p1", "Alpha"), project("p2", "Beta")];

type BarProps = ComponentProps<typeof SidebarSelectionBar>;

function renderBar(overrides: Partial<BarProps> = {}) {
	const callbacks = {
		onClose: vi.fn(),
		onSelectAll: vi.fn(),
		onPin: vi.fn(),
		onMove: vi.fn(),
		onDelete: vi.fn(),
	};
	const view = render(SidebarSelectionBar, {
		props: {
			count: 3,
			canSelectAll: true,
			pinAction: "pin",
			projects,
			canRemoveFromProject: false,
			...callbacks,
			...overrides,
		},
	});
	return { ...view, ...callbacks };
}

async function openMoveMenu() {
	await fireEvent.click(screen.getByTestId("selection-move"));
	return screen.getByRole("menu");
}

afterEach(() => {
	uiLanguage.set("en");
});

describe("SidebarSelectionBar", () => {
	describe("the bar", () => {
		it("is a toolbar named for the selected chats, with the count in view and no live region of its own", () => {
			renderBar({ count: 3 });

			const bar = screen.getByTestId("sidebar-selection-bar");
			expect(bar).toBe(screen.getByRole("toolbar", { name: "Selected chats" }));

			// The count is announced by the list's own live region, which is in the
			// page before a selection starts: one that is created together with its
			// text is missed by most screen readers.
			const count = screen.getByTestId("selection-count");
			expect(count).toHaveTextContent("3 selected");
			expect(count).not.toHaveAttribute("aria-live");
			expect(bar.querySelector("[aria-live]")).toBeNull();
		});

		it("follows the count as the selection grows", async () => {
			const { rerender } = renderBar({ count: 1 });
			expect(screen.getByTestId("selection-count")).toHaveTextContent(
				"1 selected",
			);

			await rerender({ count: 12 });
			expect(screen.getByTestId("selection-count")).toHaveTextContent(
				"12 selected",
			);
		});

		it("gives every button a tooltip that is also its accessible name", () => {
			renderBar({ canRemoveFromProject: true });

			const buttons = screen.getAllByRole("button");
			expect(buttons.map((button) => button.dataset.testid)).toEqual([
				"selection-close",
				"selection-select-all",
				"selection-pin",
				"selection-move",
				"selection-delete",
			]);
			for (const button of buttons) {
				const label = button.getAttribute("aria-label");
				expect(label, button.dataset.testid).toBeTruthy();
				expect(button, button.dataset.testid).toHaveAttribute("title", label);
			}
		});

		it("names its buttons in English", () => {
			renderBar();

			expect(screen.getByRole("button", { name: "Cancel selection" })).toBe(
				screen.getByTestId("selection-close"),
			);
			expect(screen.getByRole("button", { name: "Select all" })).toBe(
				screen.getByTestId("selection-select-all"),
			);
			expect(screen.getByRole("button", { name: "Pin to sidebar" })).toBe(
				screen.getByTestId("selection-pin"),
			);
			expect(screen.getByRole("button", { name: "Move to project" })).toBe(
				screen.getByTestId("selection-move"),
			);
			expect(screen.getByRole("button", { name: "Delete" })).toBe(
				screen.getByTestId("selection-delete"),
			);
		});

		it("speaks Hungarian when the UI language is Hungarian", () => {
			uiLanguage.set("hu");
			renderBar({ count: 3 });

			expect(screen.getByTestId("selection-count")).toHaveTextContent(
				"3 kijelölve",
			);
			expect(
				screen.getByRole("toolbar", { name: "Kijelölt beszélgetések" }),
			).toBe(screen.getByTestId("sidebar-selection-bar"));
			expect(
				screen.getByRole("button", { name: "Kijelölés megszüntetése" }),
			).toBe(screen.getByTestId("selection-close"));
			expect(screen.getByRole("button", { name: "Összes kijelölése" })).toBe(
				screen.getByTestId("selection-select-all"),
			);
			expect(screen.getByRole("button", { name: "Rögzítés" })).toBe(
				screen.getByTestId("selection-pin"),
			);
			expect(screen.getByRole("button", { name: "Áthelyezés projektbe" })).toBe(
				screen.getByTestId("selection-move"),
			);
			expect(screen.getByRole("button", { name: "Törlés" })).toBe(
				screen.getByTestId("selection-delete"),
			);
		});
	});

	describe("the buttons", () => {
		it("close, select all, pin and delete each call their callback once", async () => {
			const { onClose, onSelectAll, onPin, onDelete, onMove } = renderBar();

			await fireEvent.click(screen.getByTestId("selection-close"));
			expect(onClose).toHaveBeenCalledTimes(1);

			await fireEvent.click(screen.getByTestId("selection-select-all"));
			expect(onSelectAll).toHaveBeenCalledTimes(1);

			await fireEvent.click(screen.getByTestId("selection-pin"));
			expect(onPin).toHaveBeenCalledTimes(1);

			await fireEvent.click(screen.getByTestId("selection-delete"));
			expect(onDelete).toHaveBeenCalledTimes(1);

			expect(onMove).not.toHaveBeenCalled();
		});

		it("calls them with no arguments, so a list handler never receives the click event", async () => {
			const { onClose, onSelectAll, onPin, onDelete } = renderBar();

			await fireEvent.click(screen.getByTestId("selection-close"));
			await fireEvent.click(screen.getByTestId("selection-select-all"));
			await fireEvent.click(screen.getByTestId("selection-pin"));
			await fireEvent.click(screen.getByTestId("selection-delete"));

			expect(onClose).toHaveBeenCalledWith();
			expect(onSelectAll).toHaveBeenCalledWith();
			expect(onPin).toHaveBeenCalledWith();
			expect(onDelete).toHaveBeenCalledWith();
		});

		it("disables Select all when every shown chat is already selected", async () => {
			const { onSelectAll } = renderBar({ canSelectAll: false });

			const selectAll = screen.getByTestId("selection-select-all");
			expect(selectAll).toBeDisabled();
			// A person's click, which a browser never delivers to a disabled button.
			await userEvent.setup().click(selectAll);
			expect(onSelectAll).not.toHaveBeenCalled();
		});

		it("enables Select all while a shown chat is not yet selected", () => {
			renderBar({ canSelectAll: true });
			expect(screen.getByTestId("selection-select-all")).toBeEnabled();
		});

		// The list ends a selection when its last chat leaves, but for the moment
		// that takes there is nothing for these three to act on.
		it("disables Pin, Move and Delete while nothing is selected, and leaves Close and Select all", async () => {
			const { onPin, onDelete, onMove } = renderBar({ count: 0 });

			for (const id of [
				"selection-pin",
				"selection-move",
				"selection-delete",
			]) {
				expect(screen.getByTestId(id), id).toBeDisabled();
			}
			expect(screen.getByTestId("selection-close")).toBeEnabled();
			expect(screen.getByTestId("selection-select-all")).toBeEnabled();

			const user = userEvent.setup();
			await user.click(screen.getByTestId("selection-pin"));
			await user.click(screen.getByTestId("selection-move"));
			await user.click(screen.getByTestId("selection-delete"));
			expect(onPin).not.toHaveBeenCalled();
			expect(onDelete).not.toHaveBeenCalled();
			expect(onMove).not.toHaveBeenCalled();
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});

		it("enables Pin, Move and Delete as soon as a chat is selected", async () => {
			const { rerender } = renderBar({ count: 0 });

			await rerender({ count: 1 });

			for (const id of [
				"selection-pin",
				"selection-move",
				"selection-delete",
			]) {
				expect(screen.getByTestId(id), id).toBeEnabled();
			}
		});

		it("names the pin button for what it will do", async () => {
			const { rerender } = renderBar({ pinAction: "pin" });
			const pin = screen.getByTestId("selection-pin");
			expect(pin).toHaveAccessibleName("Pin to sidebar");
			expect(pin).toHaveAttribute("title", "Pin to sidebar");
			expect(pin.querySelector(".lucide-pin")).toBeInTheDocument();
			expect(pin.querySelector(".lucide-pin-off")).not.toBeInTheDocument();

			await rerender({ pinAction: "unpin" });
			expect(screen.getByTestId("selection-pin")).toHaveAccessibleName(
				"Unpin from sidebar",
			);
			expect(screen.getByTestId("selection-pin")).toHaveAttribute(
				"title",
				"Unpin from sidebar",
			);
			expect(
				screen.getByTestId("selection-pin").querySelector(".lucide-pin-off"),
			).toBeInTheDocument();
		});

		it("names the pin button in Hungarian for both actions", async () => {
			uiLanguage.set("hu");
			const { rerender } = renderBar({ pinAction: "pin" });
			expect(screen.getByTestId("selection-pin")).toHaveAccessibleName(
				"Rögzítés",
			);

			await rerender({ pinAction: "unpin" });
			expect(screen.getByTestId("selection-pin")).toHaveAccessibleName(
				"Rögzítés feloldása",
			);
		});
	});

	describe("while a bulk action runs", () => {
		it("disables every button, Close included", () => {
			renderBar({ busy: true, canRemoveFromProject: true });

			const buttons = screen.getAllByRole("button");
			expect(buttons).toHaveLength(5);
			for (const button of buttons) {
				expect(button, button.dataset.testid).toBeDisabled();
			}
		});

		it("ignores a person's click on any of them", async () => {
			const { onClose, onSelectAll, onPin, onMove, onDelete } = renderBar({
				busy: true,
			});

			const user = userEvent.setup();
			for (const id of [
				"selection-close",
				"selection-select-all",
				"selection-pin",
				"selection-move",
				"selection-delete",
			]) {
				await user.click(screen.getByTestId(id));
			}

			expect(onClose).not.toHaveBeenCalled();
			expect(onSelectAll).not.toHaveBeenCalled();
			expect(onPin).not.toHaveBeenCalled();
			expect(onMove).not.toHaveBeenCalled();
			expect(onDelete).not.toHaveBeenCalled();
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});

		it("enables the buttons again when the action ends", async () => {
			const { rerender } = renderBar({ busy: true });
			expect(screen.getByTestId("selection-close")).toBeDisabled();

			await rerender({ busy: false });
			expect(screen.getByTestId("selection-close")).toBeEnabled();
			expect(screen.getByTestId("selection-delete")).toBeEnabled();
		});
	});

	// A toolbar is one stop in the Tab order: Left and Right move between its
	// buttons, Home and End go to the first and the last, and the button that has
	// the focus is the one Tab comes back to.
	describe("roving focus", () => {
		const ORDER = [
			"selection-close",
			"selection-select-all",
			"selection-pin",
			"selection-move",
			"selection-delete",
		];

		function button(testId: string): HTMLElement {
			return screen.getByTestId(testId);
		}

		function tabStops(): (string | undefined)[] {
			return screen
				.getAllByRole("button")
				.filter((element) => element.getAttribute("tabindex") === "0")
				.map((element) => element.dataset.testid);
		}

		// The tab stop moves in the update that follows the focus, so a test that
		// moves the focus itself waits for that update before it reads it.
		async function focusButton(testId: string) {
			button(testId).focus();
			await tick();
		}

		function pressOnFocused(key: string, init: KeyboardEventInit = {}) {
			return fireEvent.keyDown(document.activeElement ?? document.body, {
				key,
				...init,
			});
		}

		it("puts the first enabled button in the tab order and every other one out of it", () => {
			renderBar();

			expect(tabStops()).toEqual(["selection-close"]);
			for (const id of ORDER.slice(1)) {
				expect(button(id), id).toHaveAttribute("tabindex", "-1");
			}
		});

		it("moves to the next enabled button on ArrowRight, and the tab stop goes with the focus", async () => {
			renderBar();
			button("selection-close").focus();

			await pressOnFocused("ArrowRight");
			expect(button("selection-select-all")).toHaveFocus();
			expect(tabStops()).toEqual(["selection-select-all"]);

			await pressOnFocused("ArrowRight");
			expect(button("selection-pin")).toHaveFocus();
			await pressOnFocused("ArrowRight");
			expect(button("selection-move")).toHaveFocus();
			await pressOnFocused("ArrowRight");
			expect(button("selection-delete")).toHaveFocus();
			expect(tabStops()).toEqual(["selection-delete"]);
		});

		it("moves back on ArrowLeft", async () => {
			renderBar();
			button("selection-pin").focus();

			await pressOnFocused("ArrowLeft");

			expect(button("selection-select-all")).toHaveFocus();
			expect(tabStops()).toEqual(["selection-select-all"]);
		});

		it("wraps from the first button to the last on ArrowLeft, and from the last to the first on ArrowRight", async () => {
			renderBar();
			button("selection-close").focus();

			await pressOnFocused("ArrowLeft");
			expect(button("selection-delete")).toHaveFocus();

			await pressOnFocused("ArrowRight");
			expect(button("selection-close")).toHaveFocus();
		});

		it("goes to the first button on Home and to the last on End", async () => {
			renderBar();
			button("selection-pin").focus();

			await pressOnFocused("End");
			expect(button("selection-delete")).toHaveFocus();
			expect(tabStops()).toEqual(["selection-delete"]);

			await pressOnFocused("Home");
			expect(button("selection-close")).toHaveFocus();
			expect(tabStops()).toEqual(["selection-close"]);
		});

		it("skips a disabled button on the way", async () => {
			renderBar({ canSelectAll: false });
			expect(button("selection-select-all")).toBeDisabled();
			button("selection-close").focus();

			await pressOnFocused("ArrowRight");
			expect(button("selection-pin")).toHaveFocus();

			await pressOnFocused("ArrowLeft");
			expect(button("selection-close")).toHaveFocus();
		});

		it("takes only the enabled buttons into the wrap, with nothing selected", async () => {
			// Pin, Move and Delete are off: Close and Select all are the whole bar.
			renderBar({ count: 0 });
			button("selection-close").focus();

			await pressOnFocused("ArrowRight");
			expect(button("selection-select-all")).toHaveFocus();
			await pressOnFocused("ArrowRight");
			expect(button("selection-close")).toHaveFocus();
			await pressOnFocused("End");
			expect(button("selection-select-all")).toHaveFocus();
		});

		it("walks a bar that has no Move button", async () => {
			renderBar({ projects: [], canRemoveFromProject: false });
			button("selection-pin").focus();

			await pressOnFocused("ArrowRight");

			expect(button("selection-delete")).toHaveFocus();
		});

		it("keeps the keys it handles from scrolling the list", async () => {
			renderBar();
			button("selection-close").focus();

			for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
				expect(await pressOnFocused(key), key).toBe(false);
			}
		});

		it("leaves other keys, and keys with a modifier, to the browser", async () => {
			renderBar();
			const close = button("selection-close");
			close.focus();

			for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "a"]) {
				expect(await pressOnFocused(key), key).toBe(true);
			}
			// Alt+Left is the browser's Back, and Shift, Ctrl and Cmd with an arrow
			// are not this bar's either.
			for (const init of [
				{ altKey: true },
				{ ctrlKey: true },
				{ metaKey: true },
				{ shiftKey: true },
			]) {
				expect(
					await pressOnFocused("ArrowRight", init),
					JSON.stringify(init),
				).toBe(true);
			}
			expect(close).toHaveFocus();
		});

		it("leaves the arrows alone when the focus is not on the bar", async () => {
			renderBar();
			const elsewhere = document.createElement("button");
			document.body.append(elsewhere);
			try {
				elsewhere.focus();

				expect(await pressOnFocused("ArrowRight")).toBe(true);
				expect(await pressOnFocused("End")).toBe(true);

				expect(elsewhere).toHaveFocus();
			} finally {
				elsewhere.remove();
			}
		});

		it("makes the button that a click focused the tab stop", async () => {
			renderBar();

			await userEvent.setup().click(button("selection-pin"));

			expect(button("selection-pin")).toHaveFocus();
			expect(tabStops()).toEqual(["selection-pin"]);
		});

		it("hands the tab stop to the first enabled button when its own is switched off", async () => {
			const { rerender } = renderBar();
			await focusButton("selection-pin");
			expect(tabStops()).toEqual(["selection-pin"]);

			await rerender({ count: 0 });

			expect(button("selection-pin")).toBeDisabled();
			expect(tabStops()).toEqual(["selection-close"]);
		});

		it("hands the tab stop to the first button when Move goes away", async () => {
			const { rerender } = renderBar({ canRemoveFromProject: true });
			await focusButton("selection-move");
			expect(tabStops()).toEqual(["selection-move"]);

			await rerender({ projects: [], canRemoveFromProject: false });

			expect(screen.queryByTestId("selection-move")).not.toBeInTheDocument();
			expect(tabStops()).toEqual(["selection-close"]);
		});

		it("has no tab stop while a bulk action runs, and gives the same one back after it", async () => {
			const { rerender } = renderBar();
			await focusButton("selection-pin");

			await rerender({ busy: true });
			expect(tabStops()).toEqual([]);

			await rerender({ busy: false });
			expect(tabStops()).toEqual(["selection-pin"]);
		});

		it("is one stop in the Tab order, whichever button holds it", async () => {
			// The bar first, so that the page's order is: before, the bar, after.
			renderBar();
			const before = document.createElement("button");
			const after = document.createElement("button");
			document.body.prepend(before);
			document.body.append(after);
			try {
				const user = userEvent.setup();
				before.focus();

				await user.tab();
				expect(button("selection-close")).toHaveFocus();
				await user.tab();
				expect(after).toHaveFocus();

				// Back in, it is the button that had the focus that Tab comes to.
				await user.tab({ shift: true });
				expect(button("selection-close")).toHaveFocus();
				await pressOnFocused("End");
				await user.tab();
				expect(after).toHaveFocus();
				await user.tab({ shift: true });
				expect(button("selection-delete")).toHaveFocus();
			} finally {
				before.remove();
				after.remove();
			}
		});

		it("leaves the arrows to the Move menu while it is open", async () => {
			renderBar({ canRemoveFromProject: true });
			await openMoveMenu();
			const [alpha, beta] = screen.getAllByTestId("selection-move-option");
			await waitFor(() => expect(alpha).toHaveFocus());

			// Down is the menu's; Left and Right are nobody's while it is open.
			await fireEvent.keyDown(alpha, { key: "ArrowDown" });
			expect(beta).toHaveFocus();
			expect(await fireEvent.keyDown(beta, { key: "ArrowRight" })).toBe(true);
			expect(beta).toHaveFocus();
		});
	});

	// The list asks, when a person acts on the bar, whether the keyboard is what
	// has the focus (it is put on a row afterwards, which scrolls: not for a mouse).
	// jsdom answers `:focus-visible` from its own idea of the last event, so the
	// answer is set; the real browser's is pinned in the e2e spec.
	describe("holdsKeyboardFocus", () => {
		function answerFocusVisible(answer: boolean) {
			const matches = Element.prototype.matches;
			return vi
				.spyOn(Element.prototype, "matches")
				.mockImplementation(function (this: Element, selector: string) {
					return selector === ":focus-visible"
						? answer
						: matches.call(this, selector);
				});
		}

		it("is false while nothing is focused", () => {
			const { component } = renderBar();
			const keyboard = answerFocusVisible(true);
			try {
				expect(component.holdsKeyboardFocus()).toBe(false);
			} finally {
				keyboard.mockRestore();
			}
		});

		it("is true while a button of the bar has the focus the way the keyboard gives it", () => {
			const { component } = renderBar();
			screen.getByTestId("selection-pin").focus();
			const keyboard = answerFocusVisible(true);
			try {
				expect(component.holdsKeyboardFocus()).toBe(true);
			} finally {
				keyboard.mockRestore();
			}
		});

		it("is false while a button of the bar has the focus but the browser does not show it as keyboard focus, as after a mouse press", () => {
			const { component } = renderBar();
			screen.getByTestId("selection-pin").focus();
			const mouse = answerFocusVisible(false);
			try {
				expect(component.holdsKeyboardFocus()).toBe(false);
			} finally {
				mouse.mockRestore();
			}
		});

		it("is false while the keyboard has the focus somewhere else", () => {
			const { component } = renderBar();
			const elsewhere = document.createElement("button");
			document.body.append(elsewhere);
			const keyboard = answerFocusVisible(true);
			try {
				elsewhere.focus();

				expect(component.holdsKeyboardFocus()).toBe(false);
			} finally {
				keyboard.mockRestore();
				elsewhere.remove();
			}
		});
	});

	describe("Move to project", () => {
		it("is absent with no projects and no selected chat in a project", () => {
			renderBar({ projects: [], canRemoveFromProject: false });
			expect(screen.queryByTestId("selection-move")).not.toBeInTheDocument();
		});

		it("is there with no projects when a selected chat is in one", async () => {
			renderBar({ projects: [], canRemoveFromProject: true });

			await openMoveMenu();
			expect(
				screen.queryByTestId("selection-move-option"),
			).not.toBeInTheDocument();
			expect(
				screen.getByTestId("selection-remove-from-project"),
			).toBeInTheDocument();
		});

		it("opens a menu of the projects, one option each, named for the project", async () => {
			renderBar();
			const move = screen.getByTestId("selection-move");
			expect(move).toHaveAttribute("aria-haspopup", "menu");
			expect(move).toHaveAttribute("aria-expanded", "false");

			const menu = await openMoveMenu();
			expect(menu).toHaveAccessibleName("Move to project");
			expect(move).toHaveAttribute("aria-expanded", "true");

			const options = screen.getAllByTestId("selection-move-option");
			expect(options.map((option) => option.dataset.projectId)).toEqual([
				"p1",
				"p2",
			]);
			expect(options.map((option) => option.textContent?.trim())).toEqual([
				"Alpha",
				"Beta",
			]);
			for (const option of options) {
				expect(option).toHaveAttribute("role", "menuitem");
			}
		});

		it("offers Remove from project only when a selected chat is in a project", async () => {
			const { unmount } = renderBar({ canRemoveFromProject: false });
			await openMoveMenu();
			expect(
				screen.queryByTestId("selection-remove-from-project"),
			).not.toBeInTheDocument();
			unmount();

			renderBar({ canRemoveFromProject: true });
			await openMoveMenu();
			expect(
				screen.getByTestId("selection-remove-from-project"),
			).toHaveTextContent("Remove from project");
		});

		it("sends the chosen project and closes the menu", async () => {
			const { onMove } = renderBar();
			await openMoveMenu();

			await fireEvent.click(screen.getAllByTestId("selection-move-option")[1]);

			expect(onMove).toHaveBeenCalledTimes(1);
			expect(onMove).toHaveBeenCalledWith({ projectId: "p2" });
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});

		it("sends a null project for Remove from project and closes the menu", async () => {
			const { onMove } = renderBar({ canRemoveFromProject: true });
			await openMoveMenu();

			await fireEvent.click(
				screen.getByTestId("selection-remove-from-project"),
			);

			expect(onMove).toHaveBeenCalledTimes(1);
			expect(onMove).toHaveBeenCalledWith({ projectId: null });
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});

		it("sends nothing just for opening the menu", async () => {
			const { onMove } = renderBar();
			await openMoveMenu();
			expect(onMove).not.toHaveBeenCalled();
		});

		// The menu-button pattern: whatever closes the menu hands focus back to
		// the button that opened it.
		it("hands focus back to the Move button when a project is chosen", async () => {
			renderBar();
			await openMoveMenu();
			const [alpha, beta] = screen.getAllByTestId("selection-move-option");
			await waitFor(() => expect(alpha).toHaveFocus());

			await fireEvent.click(beta);

			expect(screen.getByTestId("selection-move")).toHaveFocus();
		});

		it("hands focus back to the Move button after Remove from project too", async () => {
			renderBar({ canRemoveFromProject: true });
			await openMoveMenu();
			await waitFor(() =>
				expect(screen.getAllByTestId("selection-move-option")[0]).toHaveFocus(),
			);

			await fireEvent.click(
				screen.getByTestId("selection-remove-from-project"),
			);

			expect(screen.getByTestId("selection-move")).toHaveFocus();
		});

		it("speaks Hungarian in the menu", async () => {
			uiLanguage.set("hu");
			renderBar({ canRemoveFromProject: true });

			const menu = await openMoveMenu();
			expect(menu).toHaveAccessibleName("Áthelyezés projektbe");
			expect(
				screen.getByTestId("selection-remove-from-project"),
			).toHaveTextContent("Eltávolítás a projektből");
		});

		it("draws the menu in the page, outside the bar, so the sidebar cannot clip it", async () => {
			renderBar();
			const menu = await openMoveMenu();

			expect(menu.parentElement).toBe(document.body);
			expect(screen.getByTestId("sidebar-selection-bar")).not.toContainElement(
				menu,
			);
		});

		it("opens above the Move button", async () => {
			const originalGetBoundingClientRect =
				HTMLElement.prototype.getBoundingClientRect;
			const rectSpy = vi
				.spyOn(HTMLElement.prototype, "getBoundingClientRect")
				.mockImplementation(function getBoundingClientRect(this: HTMLElement) {
					if (this.dataset.testid === "selection-move") {
						return {
							x: 150,
							y: 700,
							top: 700,
							right: 178,
							bottom: 728,
							left: 150,
							width: 28,
							height: 28,
							toJSON: () => ({}),
						} as DOMRect;
					}
					return originalGetBoundingClientRect.call(this);
				});
			try {
				renderBar();
				const menu = await openMoveMenu();

				// Anchored by its bottom edge, which has to lie above the button's
				// top edge (y = 700): `bottom` is the gap to the viewport's bottom.
				expect(menu.style.top).toBe("");
				expect(parseFloat(menu.style.bottom)).toBeGreaterThanOrEqual(
					window.innerHeight - 700,
				);
				// And it stays inside the room above the button, scrolling when the
				// list of projects is longer.
				expect(parseFloat(menu.style.maxHeight)).toBeGreaterThan(0);
				expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(700);
				// It never leaves the viewport sideways.
				expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
				expect(
					parseFloat(menu.style.left) + parseFloat(menu.style.width),
				).toBeLessThanOrEqual(window.innerWidth);
			} finally {
				rectSpy.mockRestore();
			}
		});

		describe("closing", () => {
			it("closes on a click outside, and not on one inside the menu", async () => {
				renderBar();
				const menu = await openMoveMenu();

				await fireEvent.click(menu);
				expect(screen.getByRole("menu")).toBeInTheDocument();

				await fireEvent.click(document.body);
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();
				expect(screen.getByTestId("selection-move")).toHaveAttribute(
					"aria-expanded",
					"false",
				);
			});

			it("closes on a click even where the page stops the click from bubbling", async () => {
				renderBar();
				await openMoveMenu();

				const stopper = document.createElement("div");
				stopper.addEventListener("click", (event) => event.stopPropagation());
				document.body.appendChild(stopper);
				try {
					await fireEvent.click(stopper);
					expect(screen.queryByRole("menu")).not.toBeInTheDocument();
				} finally {
					stopper.remove();
				}
			});

			it("closes when the Move button is pressed again", async () => {
				renderBar();
				await openMoveMenu();

				await fireEvent.click(screen.getByTestId("selection-move"));
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();
			});

			it("closes when another button of the bar is used, and that button still acts", async () => {
				const { onDelete } = renderBar();
				await openMoveMenu();

				await fireEvent.click(screen.getByTestId("selection-delete"));

				expect(onDelete).toHaveBeenCalledTimes(1);
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();
			});

			it("closes when a bulk action starts or the bar loses its last way to move", async () => {
				const { rerender } = renderBar({ canRemoveFromProject: true });
				await openMoveMenu();
				await rerender({ busy: true });
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();

				// ... and it does not come back by itself when the action ends.
				await rerender({ busy: false });
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();

				await openMoveMenu();
				await rerender({ projects: [], canRemoveFromProject: false });
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();
				expect(screen.queryByTestId("selection-move")).not.toBeInTheDocument();
			});
		});

		describe("with the keyboard", () => {
			it("moves focus to the first option when it opens", async () => {
				renderBar({ canRemoveFromProject: true });
				await openMoveMenu();

				const options = screen.getAllByTestId("selection-move-option");
				await waitFor(() => expect(options[0]).toHaveFocus());
			});

			it("closes on Escape, hands focus back to the Move button and keeps the press from the rest of the page", async () => {
				renderBar();
				await openMoveMenu();
				await waitFor(() =>
					expect(
						screen.getAllByTestId("selection-move-option")[0],
					).toHaveFocus(),
				);

				// The list ends the selection on Escape through a window listener of
				// its own: it must not see this press.
				const listEscape = vi.fn();
				window.addEventListener("keydown", listEscape);
				try {
					const notCancelled = await fireEvent.keyDown(
						document.activeElement ?? document.body,
						{ key: "Escape" },
					);

					expect(notCancelled).toBe(false);
					expect(listEscape).not.toHaveBeenCalled();
					expect(screen.queryByRole("menu")).not.toBeInTheDocument();
					expect(screen.getByTestId("selection-move")).toHaveFocus();
				} finally {
					window.removeEventListener("keydown", listEscape);
				}
			});

			it("leaves Escape alone while the menu is closed", async () => {
				renderBar();

				const listEscape = vi.fn();
				window.addEventListener("keydown", listEscape);
				try {
					const notCancelled = await fireEvent.keyDown(document.body, {
						key: "Escape",
					});

					expect(notCancelled).toBe(true);
					expect(listEscape).toHaveBeenCalledTimes(1);
				} finally {
					window.removeEventListener("keydown", listEscape);
				}
			});

			it("walks the options with the arrow keys, Home and End, wrapping at both ends", async () => {
				renderBar({ canRemoveFromProject: true });
				await openMoveMenu();
				const [alpha, beta, remove] = [
					...screen.getAllByTestId("selection-move-option"),
					screen.getByTestId("selection-remove-from-project"),
				];
				await waitFor(() => expect(alpha).toHaveFocus());

				await fireEvent.keyDown(alpha, { key: "ArrowDown" });
				expect(beta).toHaveFocus();
				await fireEvent.keyDown(beta, { key: "ArrowDown" });
				expect(remove).toHaveFocus();
				await fireEvent.keyDown(remove, { key: "ArrowDown" });
				expect(alpha).toHaveFocus();

				await fireEvent.keyDown(alpha, { key: "ArrowUp" });
				expect(remove).toHaveFocus();
				await fireEvent.keyDown(remove, { key: "ArrowUp" });
				expect(beta).toHaveFocus();

				await fireEvent.keyDown(beta, { key: "Home" });
				expect(alpha).toHaveFocus();
				await fireEvent.keyDown(alpha, { key: "End" });
				expect(remove).toHaveFocus();
			});

			it("keeps the arrow keys from scrolling the list behind the menu", async () => {
				renderBar();
				await openMoveMenu();
				const [alpha] = screen.getAllByTestId("selection-move-option");
				await waitFor(() => expect(alpha).toHaveFocus());

				expect(await fireEvent.keyDown(alpha, { key: "ArrowDown" })).toBe(
					false,
				);
			});

			it("closes on Tab and hands focus to the Move button, so Tab goes on from there", async () => {
				renderBar();
				await openMoveMenu();
				const [alpha] = screen.getAllByTestId("selection-move-option");
				await waitFor(() => expect(alpha).toHaveFocus());

				const notCancelled = await fireEvent.keyDown(alpha, { key: "Tab" });

				expect(notCancelled).toBe(true);
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();
				expect(screen.getByTestId("selection-move")).toHaveFocus();
			});
		});
	});
});

describe("sidebar selection copy", () => {
	// Hand-copied from the spec's copy table (docs/plans/sidebar-multi-select/
	// design.md), so a reworded string shows up here and not only on screen.
	const spec = {
		"sidebar.select": ["Select", "Kijelölés"],
		"sidebar.selectionToolbar": ["Selected chats", "Kijelölt beszélgetések"],
		"sidebar.selectionCount": ["{count} selected", "{count} kijelölve"],
		"sidebar.selectionClose": ["Cancel selection", "Kijelölés megszüntetése"],
		"sidebar.selectAll": ["Select all", "Összes kijelölése"],
		"sidebar.deleteConversationsTitle": [
			"Delete {count} {count, plural, one {chat} other {chats}}?",
			"Törölsz {count} beszélgetést?",
		],
		"sidebar.deleteConversationsMessage": [
			"Their messages, files, reports, and the Documents and pictures made in them are deleted too. This can't be undone.",
			"Az üzeneteik, fájljaik, jelentéseik, valamint a bennük készült dokumentumok és képek is törlődnek. Ez nem vonható vissza.",
		],
		"sidebar.bulkDeleteFailed": [
			"Couldn't delete {count} {count, plural, one {chat} other {chats}}. Try again.",
			"{count} beszélgetést nem sikerült törölni. Próbáld újra.",
		],
		"sidebar.bulkMoveFailed": [
			"Couldn't move {count} {count, plural, one {chat} other {chats}}. Try again.",
			"{count} beszélgetést nem sikerült áthelyezni. Próbáld újra.",
		],
		"sidebar.bulkPinFailed": [
			"Couldn't update the pin on {count} {count, plural, one {chat} other {chats}}. Try again.",
			"{count} beszélgetés rögzítését nem sikerült frissíteni. Próbáld újra.",
		],
	} as const;

	const rows = Object.entries(spec).map(([key, [english, hungarian]]) => ({
		key: key as keyof typeof commonDict.en,
		english,
		hungarian,
	}));

	it.each(rows)("$key is in both languages, worded as the spec says", ({
		key,
		english,
		hungarian,
	}) => {
		expect(commonDict.en[key]).toBe(english);
		expect(commonDict.hu[key]).toBe(hungarian);
	});

	it("fills in the count and picks the singular or the plural in English", () => {
		const text = get(t);

		expect(text("sidebar.deleteConversationsTitle", { count: 1 })).toBe(
			"Delete 1 chat?",
		);
		expect(text("sidebar.deleteConversationsTitle", { count: 3 })).toBe(
			"Delete 3 chats?",
		);
		expect(text("sidebar.bulkDeleteFailed", { count: 1 })).toBe(
			"Couldn't delete 1 chat. Try again.",
		);
		expect(text("sidebar.bulkMoveFailed", { count: 2 })).toBe(
			"Couldn't move 2 chats. Try again.",
		);
		expect(text("sidebar.bulkPinFailed", { count: 1 })).toBe(
			"Couldn't update the pin on 1 chat. Try again.",
		);
	});

	it("fills in the count in Hungarian, with no plural to pick", () => {
		uiLanguage.set("hu");
		const text = get(t);

		expect(text("sidebar.deleteConversationsTitle", { count: 3 })).toBe(
			"Törölsz 3 beszélgetést?",
		);
		expect(text("sidebar.bulkDeleteFailed", { count: 2 })).toBe(
			"2 beszélgetést nem sikerült törölni. Próbáld újra.",
		);
		expect(text("sidebar.bulkMoveFailed", { count: 1 })).toBe(
			"1 beszélgetést nem sikerült áthelyezni. Próbáld újra.",
		);
		expect(text("sidebar.bulkPinFailed", { count: 4 })).toBe(
			"4 beszélgetés rögzítését nem sikerült frissíteni. Próbáld újra.",
		);
	});
});
