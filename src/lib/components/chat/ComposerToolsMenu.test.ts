import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailableModelsResponse } from "$lib/client/api/models";
import ComposerToolsMenu from "./ComposerToolsMenu.svelte";
import ModelSelector from "./ModelSelector.svelte";

// The Model row renders a real ModelSelector, which only draws its picker
// once the model list has arrived — so the sheet-inside-a-sheet case needs
// one provider to exist.
const fetchAvailableModelsMock = vi.hoisted(() =>
	vi.fn(
		async (): Promise<AvailableModelsResponse> => ({
			providers: [
				{
					id: "p1",
					name: "local",
					displayName: "Local",
					iconAssetId: null,
					iconUrl: null,
					processingRegionCode: null,
					privacyPolicyUrl: null,
					models: [
						{
							id: "model-1",
							displayName: "Model 1",
							iconUrl: null,
							guideNoteEn: null,
							guideNoteHu: null,
							guideBadge: null,
							guideNoCost: false,
							estimatedTokensPerSecond: null,
							maxModelContext: null,
							inputUsdMicrosPer1m: 0,
							outputUsdMicrosPer1m: 0,
							supportsReasoningControls: true,
						},
					],
				},
			],
		}),
	),
);

vi.mock("$lib/client/api/models", () => ({
	fetchAvailableModels: fetchAvailableModelsMock,
}));

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
	// ModelSelector reads the tier through viewport.svelte's store, which
	// needs matchMedia as well as a width — jsdom ships neither, and without
	// this the nested picker silently stays in its desktop presentation.
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: isPhone && query.includes("hover: none"),
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}),
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

	// One scrim per screen, not one per sheet.
	//
	// `--scrim` is a single token so two surfaces cannot disagree about how
	// dark "dimmed" is — and two of them laid over each other disagree with
	// both: 0.32 over 0.32 reads as 0.54. Worse, the model picker's scrim
	// (z 99) sat ABOVE this menu's sheet (z 60), so the menu you opened the
	// picker from went dark behind it — the one thing the board rules out
	// ("the thing they were anchored to stays visible above the scrim").
	it("does not add a second scrim when the model picker opens from the sheet", async () => {
		stubPhone(true);
		render(ComposerToolsMenu, baseProps());

		await waitFor(() =>
			expect(screen.getByTestId("model-selector-trigger")).toBeTruthy(),
		);
		await fireEvent.click(screen.getByTestId("model-selector-trigger"));
		await waitFor(() =>
			expect(screen.getByTestId("model-sheet-grabber")).toBeTruthy(),
		);

		expect(document.querySelectorAll(".model-selector__scrim")).toHaveLength(0);
		expect(screen.getAllByTestId("composer-tools-menu-scrim")).toHaveLength(1);
	});

	// The other half of the same rule: suppressing the picker's scrim is the
	// MENU's call, not a capability the picker lost. Rendered on its own it
	// still dims the page, so the next surface to host it inherits a sheet
	// that works rather than one that silently has no backdrop.
	it("still draws its own scrim when the model picker is not inside a sheet", async () => {
		stubPhone(true);
		render(ModelSelector, { onSelect: vi.fn() });

		await waitFor(() =>
			expect(screen.getByTestId("model-selector-trigger")).toBeTruthy(),
		);
		await fireEvent.click(screen.getByTestId("model-selector-trigger"));

		await waitFor(() =>
			expect(document.querySelectorAll(".model-selector__scrim")).toHaveLength(
				1,
			),
		);
	});
});
