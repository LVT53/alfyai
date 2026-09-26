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

	it("renaming persists the new title and leaves every other tab byte-identical", async () => {
		const onChange = vi.fn();
		const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Trip Plan");
		render(Tabs, {
			tabs: tabs("Plan", "Budget"),
			activeTabId: "tab-0",
			onActivate: vi.fn(),
			onChange,
		});
		await fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
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

	it("deleting a tab asks first, via the shared confirm dialog", async () => {
		const onChange = vi.fn();
		render(Tabs, {
			tabs: tabs("Plan", "Budget"),
			activeTabId: "tab-0",
			onActivate: vi.fn(),
			onChange,
		});
		const deleteButtons = screen.getAllByRole("button", { name: "Delete tab" });
		await fireEvent.click(deleteButtons[1]);
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByTestId("confirm-delete")).toBeInTheDocument();
	});

	it("confirming delete removes exactly that tab; the others are byte-identical", async () => {
		const onChange = vi.fn();
		render(Tabs, {
			tabs: tabs("Plan", "Budget", "Packing"),
			activeTabId: "tab-0",
			onActivate: vi.fn(),
			onChange,
		});
		const deleteButtons = screen.getAllByRole("button", { name: "Delete tab" });
		await fireEvent.click(deleteButtons[1]);
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
		const deleteButtons = screen.getAllByRole("button", { name: "Delete tab" });
		await fireEvent.click(deleteButtons[0]);
		await fireEvent.click(screen.getByTestId("confirm-delete"));
		expect(onActivate).toHaveBeenCalledExactlyOnceWith("tab-1");
	});
});
