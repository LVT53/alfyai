import { fireEvent, render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	landingIncognitoArmed,
	landingIncognitoArmVisible,
	searchModalOpenRequested,
} from "$lib/stores/ui";
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

// Incognito, one-way (docs/plans/incognito-one-way-spec.md §2). The phone
// header's mask button mirrors the landing page's own visibility rule
// (landing route, no conversation yet) via the shared
// landingIncognitoArmVisible store, and arms the SAME landingIncognitoArmed
// store the desktop button arms.
describe("Header — incognito", () => {
	beforeEach(() => {
		landingIncognitoArmed.set(false);
		landingIncognitoArmVisible.set(false);
	});

	it("draws no mask button when the landing page has not asked for one", () => {
		render(Header, {});

		expect(
			screen.queryByTestId("incognito-arm-phone"),
		).not.toBeInTheDocument();
	});

	it("draws the mask button once the landing page says it is visible, and arms the shared flag", async () => {
		landingIncognitoArmVisible.set(true);
		render(Header, {});

		const button = screen.getByTestId("incognito-arm-phone");
		expect(button).toBeInTheDocument();
		expect(get(landingIncognitoArmed)).toBe(false);

		await fireEvent.click(button);

		expect(get(landingIncognitoArmed)).toBe(true);
	});

	it("shows the mask mark before the title for an incognito conversation", () => {
		render(Header, {
			conversationTitle: "Salary negotiation script",
			conversationIsIncognito: true,
		});

		expect(
			screen.getByLabelText("Incognito — not remembered"),
		).toBeInTheDocument();
	});

	it("draws no mask mark for a normal conversation", () => {
		render(Header, {
			conversationTitle: "Q3 budget reconciliation",
			conversationIsIncognito: false,
		});

		expect(
			screen.queryByLabelText("Incognito — not remembered"),
		).not.toBeInTheDocument();
	});
});
