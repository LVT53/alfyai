import { fireEvent, render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchModalOpenRequested } from "$lib/stores/ui";
import Header from "./Header.svelte";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
}));

vi.mock("$lib/utils/viewport.svelte", () => ({
	viewportStore: { touch: false, tier: "phone" },
}));

describe("Header — mobile menu Search entry (Task 6 / A3)", () => {
	beforeEach(() => {
		searchModalOpenRequested.set(false);
	});

	async function openMobileMenu() {
		render(Header, {});
		await fireEvent.click(
			screen.getByRole("button", { name: "Open user menu" }),
		);
	}

	it("shows a Search row in the mobile header menu", async () => {
		await openMobileMenu();

		expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
	});

	it("requests Workspace Search open and closes the menu when Search is clicked", async () => {
		await openMobileMenu();
		expect(get(searchModalOpenRequested)).toBe(false);

		await fireEvent.click(screen.getByRole("button", { name: "Search" }));

		expect(get(searchModalOpenRequested)).toBe(true);
		expect(
			screen.queryByRole("button", { name: "Search" }),
		).not.toBeInTheDocument();
	});
});
