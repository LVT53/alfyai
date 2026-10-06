import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "$lib/client/api/models";
import {
	deregisterDialog,
	hasOpenDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { uiLanguage } from "$lib/stores/settings";
import ModelSelectionGuideModal from "./ModelSelectionGuideModal.svelte";

function model(index: number): ModelProvider["models"][number] {
	return {
		id: `model-${index}`,
		displayName: `Guide Model ${index}`,
		iconUrl: null,
		guideNoteEn: `Short guidance note ${index}.`,
		guideNoteHu: null,
		guideBadge: index % 2 === 0 ? "simple" : "intelligent",
		guideNoCost: index === 1,
		estimatedTokensPerSecond: index === 12 ? 1_000 : index % 3 === 0 ? 150 : 45,
		maxModelContext:
			index === 12 ? 1_000_000 : index % 3 === 0 ? 256_000 : 64_000,
		inputUsdMicrosPer1m: index * 500_000,
		outputUsdMicrosPer1m: index * 1_000_000,
		supportsReasoningControls: true,
	};
}

function providers(): ModelProvider[] {
	return [
		{
			id: "provider-eu",
			name: "provider-eu",
			displayName: "Provider EU",
			iconAssetId: null,
			iconUrl: null,
			processingRegionCode: "NL",
			privacyPolicyUrl: "https://example.com/privacy",
			models: Array.from({ length: 6 }, (_, index) => model(index + 1)),
		},
		{
			id: "provider-us",
			name: "provider-us",
			displayName: "Provider US",
			iconAssetId: null,
			iconUrl: null,
			processingRegionCode: "US",
			privacyPolicyUrl: null,
			models: Array.from({ length: 6 }, (_, index) => model(index + 7)),
		},
	];
}

describe("ModelSelectionGuideModal", () => {
	it("renders a compact informational guide for a dozen enabled models", async () => {
		uiLanguage.set("en");
		const onClose = vi.fn();
		render(ModelSelectionGuideModal, {
			providers: providers(),
			onClose,
		});

		expect(screen.getByRole("dialog", { name: "Model guide" })).toBeTruthy();
		expect(document.body.querySelectorAll(".model-guide-row")).toHaveLength(12);
		expect(screen.getByText("Provider EU")).toBeTruthy();
		expect(screen.getByText("🇳🇱")).toHaveAttribute(
			"title",
			"Processing region: Netherlands",
		);
		expect(screen.getByText("🇳🇱")).toHaveAttribute(
			"data-tooltip",
			"Processing region: Netherlands",
		);
		expect(
			screen.getByRole("link", { name: "Provider privacy policy" }),
		).toHaveAttribute("href", "https://example.com/privacy");
		expect(screen.getAllByText("Simpler").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Intelligent").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Normal").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
		expect(screen.getByText("Ludicrous")).toBeTruthy();
		expect(screen.getByText("No cost")).toBeTruthy();
		expect(screen.getAllByText("Large context").length).toBeGreaterThan(0);
		expect(screen.getByText("Massive context")).toBeTruthy();
		expect(document.body.querySelector(".model-guide-rows")).toBeTruthy();
		expect(
			document.body.querySelector(
				'[data-tooltip="Input/Output per 1M tokens: $1.0000 / $2.0000"]',
			),
		).toBeTruthy();
		expect(
			document.body.querySelector(
				'[data-tooltip="Estimated speed: 150 tokens/sec"]',
			),
		).toBeTruthy();
		expect(
			document.body.querySelector(
				'.model-guide-cost--no-cost[data-tooltip="Input/Output per 1M tokens: $0.0000 / $0.0000"]',
			),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Guide Model 1" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("keeps the modal open for inside clicks and closes from the backdrop", async () => {
		uiLanguage.set("en");
		const onClose = vi.fn();
		render(ModelSelectionGuideModal, {
			providers: providers(),
			onClose,
		});

		await fireEvent.mouseDown(
			screen.getByRole("dialog", { name: "Model guide" }),
		);
		await fireEvent.click(screen.getByRole("dialog", { name: "Model guide" }));
		expect(onClose).not.toHaveBeenCalled();

		const privacyLink = screen.getByRole("link", {
			name: "Provider privacy policy",
		});
		await fireEvent.mouseDown(privacyLink);
		await fireEvent.click(privacyLink);
		expect(onClose).not.toHaveBeenCalled();

		const backdrop = document.body.querySelector(".model-guide-backdrop");
		expect(backdrop).toBeTruthy();
		await fireEvent.mouseDown(backdrop as HTMLElement);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// The guide as a modal dialog. It is opened from the "+" menu's Model row and
// from the phone picker, so it has to take the keyboard, hand it back, and
// leave the layers under it alone.
// ---------------------------------------------------------------------------

// Presses a key the way the browser delivers it to whatever holds focus, and
// hands back the event so a test can ask whether its default was cancelled.
function pressKey(key: string, options: { shiftKey?: boolean } = {}) {
	const event = new KeyboardEvent("keydown", {
		key,
		shiftKey: options.shiftKey ?? false,
		bubbles: true,
		cancelable: true,
	});
	(document.activeElement ?? document.body).dispatchEvent(event);
	return event;
}

function renderGuide(onClose = vi.fn()) {
	uiLanguage.set("en");
	const view = render(ModelSelectionGuideModal, {
		providers: providers(),
		onClose,
	});
	return { ...view, onClose };
}

describe("ModelSelectionGuideModal where it lives", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("moves its backdrop to the body, so its fixed position means the viewport, and takes it away again", () => {
		const host = document.createElement("div");
		document.body.append(host);
		const { unmount } = render(
			ModelSelectionGuideModal,
			{ providers: providers(), onClose: vi.fn() },
			{ target: host },
		);

		const backdrop = document.querySelector(".model-guide-backdrop");
		expect(backdrop?.parentElement).toBe(document.body);

		unmount();

		expect(document.querySelector(".model-guide-backdrop")).toBeNull();
	});

	it("closes on Escape", () => {
		const { onClose } = renderGuide();

		pressKey("Escape");

		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("ModelSelectionGuideModal as a modal dialog", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("takes focus on the dialog itself when it opens", async () => {
		renderGuide();

		await waitFor(() =>
			expect(screen.getByRole("dialog", { name: "Model guide" })).toHaveFocus(),
		);
	});

	it("wraps Tab from the last control to the first, and Shift+Tab back", async () => {
		renderGuide();
		const dialog = screen.getByRole("dialog", { name: "Model guide" });
		await waitFor(() => expect(dialog).toHaveFocus());
		const close = screen.getByRole("button", { name: "Close" });
		const policy = screen.getByRole("link", {
			name: "Provider privacy policy",
		});

		policy.focus();
		const forward = pressKey("Tab");
		expect(forward.defaultPrevented).toBe(true);
		expect(close).toHaveFocus();

		const backward = pressKey("Tab", { shiftKey: true });
		expect(backward.defaultPrevented).toBe(true);
		expect(policy).toHaveFocus();
	});

	it("wraps Shift+Tab pressed on the dialog itself, where focus starts, to the last control", async () => {
		renderGuide();
		const dialog = screen.getByRole("dialog", { name: "Model guide" });
		await waitFor(() => expect(dialog).toHaveFocus());

		const event = pressKey("Tab", { shiftKey: true });

		expect(event.defaultPrevented).toBe(true);
		expect(
			screen.getByRole("link", { name: "Provider privacy policy" }),
		).toHaveFocus();
	});

	it("pulls focus that has left the dialog back to its first control", async () => {
		renderGuide();
		await waitFor(() =>
			expect(screen.getByRole("dialog", { name: "Model guide" })).toHaveFocus(),
		);
		const outside = document.createElement("button");
		document.body.append(outside);
		outside.focus();

		const event = pressKey("Tab");

		expect(event.defaultPrevented).toBe(true);
		expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
	});

	it("cancels the Escape key it closes on", () => {
		const { onClose } = renderGuide();

		const event = pressKey("Escape");

		expect(event.defaultPrevented).toBe(true);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("gives focus back to whatever had it when it opened, without scrolling the page", async () => {
		const opener = document.createElement("button");
		document.body.append(opener);
		opener.focus();
		const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

		const { unmount } = renderGuide();
		await waitFor(() =>
			expect(screen.getByRole("dialog", { name: "Model guide" })).toHaveFocus(),
		);
		expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

		unmount();

		expect(opener).toHaveFocus();
		expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
		focusSpy.mockRestore();
	});

	it("sits on the open-dialog stack while it is mounted", () => {
		expect(hasOpenDialog()).toBe(false);
		const { unmount } = renderGuide();
		expect(hasOpenDialog()).toBe(true);

		unmount();

		expect(hasOpenDialog()).toBe(false);
	});

	it("leaves Escape and Tab to a dialog opened on top of it, and answers again once that dialog closes", async () => {
		const { onClose } = renderGuide();
		await waitFor(() =>
			expect(screen.getByRole("dialog", { name: "Model guide" })).toHaveFocus(),
		);
		const policy = screen.getByRole("link", {
			name: "Provider privacy policy",
		});
		policy.focus();
		const topmost = Symbol("dialog-on-top");

		registerDialog(topmost);
		try {
			expect(pressKey("Escape").defaultPrevented).toBe(false);
			expect(pressKey("Tab").defaultPrevented).toBe(false);
			expect(onClose).not.toHaveBeenCalled();
			expect(policy).toHaveFocus();
		} finally {
			deregisterDialog(topmost);
		}

		pressKey("Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
