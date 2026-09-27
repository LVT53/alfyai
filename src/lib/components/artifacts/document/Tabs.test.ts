import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import Tabs from "./Tabs.svelte";

afterEach(() => {
	cleanup();
});

function tabs(...titles: string[]): DocumentTab[] {
	return titles.map((title, i) => ({
		id: `tab-${i}`,
		title,
		startBlockId: `p${i}`,
	}));
}

/** Opens the ⋯ menu for whichever tab is currently active — the only tab with one (redesign §5.2/§9.2). */
async function openActiveTabMenu(): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name: "Tab options" }));
}

describe("Tabs", () => {
	it("hides the strip for a single-tab document (T9.3)", () => {
		render(Tabs, {
			tabs: tabs("Plan"),
			activeTabId: "tab-0",
			onActivate: vi.fn(),
			onChange: vi.fn(),
		});
		expect(screen.queryByTestId("document-tabs")).not.toBeInTheDocument();
		expect(screen.getByTestId("document-tabs-single")).toBeInTheDocument();
	});

	it("renders every tab in order with the first marked active by default", () => {
		render(Tabs, {
			tabs: tabs("Plan", "Budget", "Packing"),
			activeTabId: "tab-0",
			onActivate: vi.fn(),
			onChange: vi.fn(),
		});
		const tablist = screen.getAllByRole("tab");
		expect(tablist.map((el) => el.textContent?.trim())).toEqual([
			"Plan",
			"Budget",
			"Packing",
		]);
		expect(tablist[0]).toHaveAttribute("aria-selected", "true");
		expect(tablist[1]).toHaveAttribute("aria-selected", "false");
	});

	it("gives only the active tab a 0 tabindex, the rest -1 (roving tabindex)", () => {
		render(Tabs, {
			tabs: tabs("Plan", "Budget", "Packing"),
			activeTabId: "tab-1",
			onActivate: vi.fn(),
			onChange: vi.fn(),
		});
		const tablist = screen.getAllByRole("tab");
		expect(tablist.map((el) => el.getAttribute("tabindex"))).toEqual([
			"-1",
			"0",
			"-1",
		]);
	});

	it("shows a badge only for a tab whose id has a positive count", () => {
		render(Tabs, {
			tabs: tabs("Plan", "Budget", "Packing"),
			activeTabId: "tab-0",
			onActivate: vi.fn(),
			onChange: vi.fn(),
			badgeCounts: { "tab-1": 3 },
		});
		expect(screen.getByText("3")).toBeInTheDocument();
		const budgetTab = screen.getByRole("tab", { name: /Budget/ });
		expect(budgetTab).toHaveTextContent("3");
		const planTab = screen.getByRole("tab", { name: "Plan" });
		expect(planTab).not.toHaveTextContent(/\d/);
	});

	it("renders the sliding underline element once", () => {
		const { container } = render(Tabs, {
			tabs: tabs("Plan", "Budget"),
			activeTabId: "tab-0",
			onActivate: vi.fn(),
			onChange: vi.fn(),
		});
		expect(container.querySelectorAll(".document-tabs-ink")).toHaveLength(1);
	});

	it("notifies onActivate when a different tab is clicked, without mutating the list", async () => {
		const onActivate = vi.fn();
		const onChange = vi.fn();
		render(Tabs, {
			tabs: tabs("Plan", "Budget"),
			activeTabId: "tab-0",
			onActivate,
			onChange,
		});
		await fireEvent.click(screen.getAllByRole("tab")[1]);
		expect(onActivate).toHaveBeenCalledExactlyOnceWith("tab-1");
		expect(onChange).not.toHaveBeenCalled();
	});

	describe("arrow-key navigation (WAI-ARIA tabs pattern, automatic activation)", () => {
		it("ArrowRight activates and focuses the next tab, wrapping past the last", async () => {
			const onActivate = vi.fn();
			render(Tabs, {
				tabs: tabs("Plan", "Budget", "Packing"),
				activeTabId: "tab-2",
				onActivate,
				onChange: vi.fn(),
			});
			const tablist = screen.getByRole("tablist");
			await fireEvent.keyDown(tablist, { key: "ArrowRight" });
			expect(onActivate).toHaveBeenCalledExactlyOnceWith("tab-0");
			expect(screen.getByRole("tab", { name: "Plan" })).toHaveFocus();
		});

		it("ArrowLeft activates and focuses the previous tab, wrapping past the first", async () => {
			const onActivate = vi.fn();
			render(Tabs, {
				tabs: tabs("Plan", "Budget", "Packing"),
				activeTabId: "tab-0",
				onActivate,
				onChange: vi.fn(),
			});
			const tablist = screen.getByRole("tablist");
			await fireEvent.keyDown(tablist, { key: "ArrowLeft" });
			expect(onActivate).toHaveBeenCalledExactlyOnceWith("tab-2");
			expect(screen.getByRole("tab", { name: "Packing" })).toHaveFocus();
		});

		it("ignores every other key", async () => {
			const onActivate = vi.fn();
			render(Tabs, {
				tabs: tabs("Plan", "Budget"),
				activeTabId: "tab-0",
				onActivate,
				onChange: vi.fn(),
			});
			await fireEvent.keyDown(screen.getByRole("tablist"), { key: "Enter" });
			expect(onActivate).not.toHaveBeenCalled();
		});
	});

	it("adding a tab appends an empty section and activates it", async () => {
		const onChange = vi.fn();
		const onActivate = vi.fn();
		render(Tabs, {
			tabs: tabs("Plan", "Budget"),
			activeTabId: "tab-0",
			onActivate,
			onChange,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Add a tab" }));
		expect(onChange).toHaveBeenCalledOnce();
		const nextTabs = onChange.mock.calls[0][0] as DocumentTab[];
		expect(nextTabs).toHaveLength(3);
		expect(nextTabs[0]).toEqual(tabs("Plan", "Budget")[0]);
		expect(nextTabs[1]).toEqual(tabs("Plan", "Budget")[1]);
		expect(nextTabs[2].title).toBe("New section");
		expect(onActivate).toHaveBeenCalledExactlyOnceWith(nextTabs[2].id);
	});

	it("adding a tab is reachable even from a single-tab document", async () => {
		const onChange = vi.fn();
		render(Tabs, {
			tabs: tabs("Plan"),
			activeTabId: "tab-0",
			onActivate: vi.fn(),
			onChange,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Add a tab" }));
		expect(onChange).toHaveBeenCalledOnce();
	});

	describe("the active tab's ⋯ menu (redesign §5.2: rename/delete move off every tab)", () => {
		it("shows the ⋯ menu trigger only for the active tab", () => {
			render(Tabs, {
				tabs: tabs("Plan", "Budget"),
				activeTabId: "tab-0",
				onActivate: vi.fn(),
				onChange: vi.fn(),
			});
			expect(
				screen.getAllByRole("button", { name: "Tab options" }),
			).toHaveLength(1);
		});

		it("opens a menu with Rename and Delete, closed until then", async () => {
			render(Tabs, {
				tabs: tabs("Plan", "Budget"),
				activeTabId: "tab-0",
				onActivate: vi.fn(),
				onChange: vi.fn(),
			});
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
			await openActiveTabMenu();
			const menu = screen.getByRole("menu");
			expect(
				screen.getByRole("menuitem", { name: "Rename" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("menuitem", { name: "Delete tab" }),
			).toBeInTheDocument();
			expect(menu).toBeInTheDocument();
		});

		it("renaming persists the new title and leaves every other tab byte-identical", async () => {
			const onChange = vi.fn();
			const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Trip Plan");
			render(Tabs, {
				tabs: tabs("Plan", "Budget"),
				activeTabId: "tab-0",
				onActivate: vi.fn(),
				onChange,
			});
			await openActiveTabMenu();
			await fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
			expect(onChange).toHaveBeenCalledOnce();
			const nextTabs = onChange.mock.calls[0][0] as DocumentTab[];
			expect(nextTabs[0]).toEqual({
				id: "tab-0",
				title: "Trip Plan",
				startBlockId: "p0",
			});
			expect(nextTabs[1]).toEqual(tabs("Plan", "Budget")[1]);
			promptSpy.mockRestore();
		});

		it("double-clicking a tab renames it too", async () => {
			const onChange = vi.fn();
			const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Trip Plan");
			render(Tabs, {
				tabs: tabs("Plan", "Budget"),
				activeTabId: "tab-0",
				onActivate: vi.fn(),
				onChange,
			});
			await fireEvent.dblClick(screen.getByRole("tab", { name: "Plan" }));
			expect(onChange).toHaveBeenCalledOnce();
			promptSpy.mockRestore();
		});

		it("deleting a tab asks first, via the shared confirm dialog", async () => {
			const onChange = vi.fn();
			render(Tabs, {
				// tab-1 is the target, so it must be the active one to have a menu.
				tabs: tabs("Plan", "Budget"),
				activeTabId: "tab-1",
				onActivate: vi.fn(),
				onChange,
			});
			await openActiveTabMenu();
			await fireEvent.click(
				screen.getByRole("menuitem", { name: "Delete tab" }),
			);
			expect(onChange).not.toHaveBeenCalled();
			expect(screen.getByTestId("confirm-delete")).toBeInTheDocument();
		});

		it("confirming delete removes exactly that tab; the others are byte-identical", async () => {
			const onChange = vi.fn();
			render(Tabs, {
				tabs: tabs("Plan", "Budget", "Packing"),
				activeTabId: "tab-1",
				onActivate: vi.fn(),
				onChange,
			});
			await openActiveTabMenu();
			await fireEvent.click(
				screen.getByRole("menuitem", { name: "Delete tab" }),
			);
			await fireEvent.click(screen.getByTestId("confirm-delete"));
			expect(onChange).toHaveBeenCalledExactlyOnceWith([
				tabs("Plan", "Budget", "Packing")[0],
				tabs("Plan", "Budget", "Packing")[2],
			]);
		});

		it("deleting the active tab activates a remaining one", async () => {
			const onActivate = vi.fn();
			render(Tabs, {
				tabs: tabs("Plan", "Budget"),
				activeTabId: "tab-0",
				onActivate,
				onChange: vi.fn(),
			});
			await openActiveTabMenu();
			await fireEvent.click(
				screen.getByRole("menuitem", { name: "Delete tab" }),
			);
			await fireEvent.click(screen.getByTestId("confirm-delete"));
			expect(onActivate).toHaveBeenCalledExactlyOnceWith("tab-1");
		});
	});
});
