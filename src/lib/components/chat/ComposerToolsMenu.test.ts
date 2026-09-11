import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ComposerToolsMenu from "./ComposerToolsMenu.svelte";

/**
 * The "+" menu, as a phone sheet.
 *
 * Everything here is about the consequence of `use:portalToBody`: on a phone
 * the sheet and its sub-pickers are moved to `document.body`, which takes
 * them out of the subtree the menu's own outside-click handler asks about.
 */

function stubPhone(isPhone: boolean) {
	const width = isPhone ? 390 : 1440;
	vi.stubGlobal("innerWidth", width);
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		writable: true,
		value: width,
	});
}

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		canAttach: true,
		attachmentsEnabled: true,
		onClose: vi.fn(),
		onAttach: vi.fn(),
		thinkingAvailable: true,
		thinkingOn: false,
		onToggleThinking: vi.fn(),
		atlasAvailability: {
			enabled: true,
			configured: true,
			reasonCode: null,
		},
		atlasProfile: null,
		onAtlasProfileChange: vi.fn(),
		connections: [],
		flippedIds: new Set<string>(),
		...overrides,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("ComposerToolsMenu phone sheet", () => {
	it("draws a scrim so the composer stays visible behind the sheet", async () => {
		stubPhone(true);
		render(ComposerToolsMenu, baseProps());

		expect(screen.getByTestId("composer-tools-menu-scrim")).toBeTruthy();
		expect(screen.getByTestId("composer-tools-menu-grabber")).toBeTruthy();
	});

	it("has no scrim and no grabber on a wide viewport", () => {
		stubPhone(false);
		render(ComposerToolsMenu, baseProps());

		expect(screen.queryByTestId("composer-tools-menu-scrim")).toBeNull();
		expect(screen.queryByTestId("composer-tools-menu-grabber")).toBeNull();
	});

	it("moves the sheet to the body so its fixed position means the viewport", () => {
		stubPhone(true);
		const { container } = render(ComposerToolsMenu, baseProps());

		const menu = screen.getByTestId("composer-tools-menu");
		expect(menu.parentElement).toBe(document.body);
		expect(container.contains(menu)).toBe(false);
	});

	// The bug the portal introduced and this exemption fixes: the Atlas cards
	// are portalled out of the menu, so a pointerdown on one looked like a
	// click "somewhere else" and closed the menu before the click that chooses
	// a profile ever landed.
	it("does not close when a pointer lands on a portalled sub-picker", async () => {
		stubPhone(true);
		const onClose = vi.fn();
		render(ComposerToolsMenu, baseProps({ onClose }));

		await fireEvent.click(screen.getByTestId("composer-menu-atlas"));
		const picker = document.querySelector(".atlas-profile-picker");
		expect(picker).not.toBeNull();

		await fireEvent.mouseDown(picker as Element);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("still closes when the pointer lands on the page outside it", async () => {
		stubPhone(true);
		const onClose = vi.fn();
		render(ComposerToolsMenu, baseProps({ onClose }));

		const outside = document.createElement("div");
		document.body.appendChild(outside);
		await fireEvent.mouseDown(outside);

		expect(onClose).toHaveBeenCalled();
	});
});
