import { fireEvent, render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayoutForSpotlight } from "$lib/actions/spotlight.test-helpers";
import type { SpotlightId } from "$lib/app-places";
import {
	pendingSpotlight,
	requestSpotlight,
	spotlightRequest,
} from "$lib/stores/spotlight";
import PageSwitcher from "./PageSwitcher.svelte";

type Item = {
	id: string;
	label: string;
	href?: string;
	spotlight?: SpotlightId;
};

/** The Knowledge page's two tabs, as links; `spotlight` is what the page adds. */
const linkTabs = (spotlights: Partial<Record<string, SpotlightId>> = {}) =>
	[
		{
			id: "memory",
			label: "Memory",
			href: "/knowledge?tab=memory",
			spotlight: spotlights.memory,
		},
		{
			id: "documents",
			label: "Documents",
			href: "/knowledge",
			spotlight: spotlights.documents,
		},
	] satisfies Item[];

/** The same tabs without an `href`: buttons, as the Settings page draws its own. */
const buttonTabs = (spotlights: Partial<Record<string, SpotlightId>> = {}) =>
	linkTabs(spotlights).map(({ href: _href, ...tab }) => tab);

const tabNamed = (name: string) => screen.getByRole("tab", { name });

describe("PageSwitcher", () => {
	it("calls onChange with the id of the tab that was pressed, whether a tab is a link or a button", async () => {
		const onChange = vi.fn();
		const { unmount } = render(PageSwitcher, {
			items: linkTabs(),
			activeId: "memory",
			ariaLabel: "Knowledge",
			onChange,
		});
		await fireEvent.click(tabNamed("Documents"));
		expect(onChange).toHaveBeenLastCalledWith("documents");
		unmount();

		render(PageSwitcher, {
			items: buttonTabs(),
			activeId: "documents",
			ariaLabel: "Knowledge",
			onChange,
		});
		await fireEvent.click(tabNamed("Memory"));
		expect(onChange).toHaveBeenLastCalledWith("memory");
	});

	it("marks the active tab selected", () => {
		render(PageSwitcher, {
			items: linkTabs(),
			activeId: "documents",
			ariaLabel: "Knowledge",
		});

		expect(tabNamed("Documents")).toHaveAttribute("aria-selected", "true");
		expect(tabNamed("Memory")).toHaveAttribute("aria-selected", "false");
	});
});

// The feature guide's Show me rings the Knowledge page's two tabs. A tab bar
// puts the same markup on every tab, and only some tabs have a Show me pointing
// at them, so an item carries an optional `spotlight`; `spotlightTarget` takes
// no id as "answers to nothing" (`src/lib/actions/spotlight.ts`).
describe("PageSwitcher — the guide's Show me", () => {
	let restoreLayout: () => void = () => undefined;

	beforeEach(() => {
		// The ring waits one animation frame; the test steps it by hand.
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		restoreLayout = stubLayoutForSpotlight();
		spotlightRequest.set(null);
	});

	afterEach(() => {
		restoreLayout();
		vi.useRealTimers();
		spotlightRequest.set(null);
	});

	it("lets a tab carry a spotlight marker", () => {
		// A tab is a link when it has an `href` (the Knowledge page's are) and a
		// button when it has none; both carry the marker.
		for (const [kind, makeTabs] of [
			["a link", linkTabs],
			["a button", buttonTabs],
		] as const) {
			const { unmount } = render(PageSwitcher, {
				items: makeTabs({ memory: "knowledge.memory" }),
				activeId: "documents",
				ariaLabel: "Knowledge",
			});

			requestSpotlight("knowledge.memory");

			expect(get(spotlightRequest), kind).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(tabNamed("Memory"), kind).toHaveClass("spotlight-ring");
			expect(tabNamed("Documents"), kind).not.toHaveClass("spotlight-ring");
			const scrolled = vi.mocked(tabNamed("Memory").scrollIntoView);
			expect(scrolled.mock.contexts.at(-1), kind).toBe(tabNamed("Memory"));
			unmount();
		}
	});

	it.each([
		["links", linkTabs],
		["buttons", buttonTabs],
	])("rings only the tab that the request names (%s)", (_kind, makeTabs) => {
		render(PageSwitcher, {
			items: makeTabs({
				memory: "knowledge.memory",
				documents: "knowledge.library",
			}),
			activeId: "memory",
			ariaLabel: "Knowledge",
		});

		requestSpotlight("knowledge.library");
		vi.advanceTimersToNextFrame();

		expect(tabNamed("Documents")).toHaveClass("spotlight-ring");
		expect(tabNamed("Memory")).not.toHaveClass("spotlight-ring");
	});

	it("rings a tab that is drawn after the request was made", () => {
		// Show me asks first and then navigates: the page that has the tabs is
		// not there yet when the request is made.
		requestSpotlight("knowledge.memory");

		render(PageSwitcher, {
			items: linkTabs({ memory: "knowledge.memory" }),
			activeId: "documents",
			ariaLabel: "Knowledge",
		});
		vi.advanceTimersToNextFrame();

		expect(tabNamed("Memory")).toHaveClass("spotlight-ring");
	});

	it("takes no request for a tab that has no spotlight", () => {
		render(PageSwitcher, {
			items: linkTabs(),
			activeId: "memory",
			ariaLabel: "Knowledge",
		});

		requestSpotlight("knowledge.library");
		vi.advanceTimersToNextFrame();

		for (const tab of screen.getAllByRole("tab")) {
			expect(tab).not.toHaveClass("spotlight-ring");
		}
		// Left for the control that does answer to it.
		expect(pendingSpotlight(get(spotlightRequest))).toBe("knowledge.library");
	});

	it("leaves a request for another control alone", () => {
		render(PageSwitcher, {
			items: linkTabs({ memory: "knowledge.memory" }),
			activeId: "memory",
			ariaLabel: "Knowledge",
		});

		requestSpotlight("settings.data");
		vi.advanceTimersToNextFrame();

		expect(tabNamed("Memory")).not.toHaveClass("spotlight-ring");
		expect(pendingSpotlight(get(spotlightRequest))).toBe("settings.data");
	});

	// The marker's class is a static string plus a `class:` directive, so the
	// ring is not written over when the active tab changes while it shows.
	it("keeps the ring on a tab when the active tab changes meanwhile", async () => {
		const { rerender } = render(PageSwitcher, {
			items: linkTabs({ memory: "knowledge.memory" }),
			activeId: "documents",
			ariaLabel: "Knowledge",
		});
		requestSpotlight("knowledge.memory");
		vi.advanceTimersToNextFrame();
		expect(tabNamed("Memory")).toHaveClass("spotlight-ring");

		await rerender({ activeId: "memory" });

		expect(tabNamed("Memory")).toHaveClass("spotlight-ring");
		expect(tabNamed("Memory")).toHaveClass("page-switcher__item--active");
	});
});
