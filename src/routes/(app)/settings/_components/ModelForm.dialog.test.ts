import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deregisterDialog,
	hasOpenDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import ModelForm from "./ModelForm.svelte";

function modelFixture() {
	return {
		id: "model-1",
		providerId: "provider-1",
		name: "gpt-example",
		displayName: "GPT Example",
		iconAssetId: null,
		fallbackProviderModelId: null,
		aliases: [],
		maxModelContext: 128_000,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: null,
		maxTokens: null,
		reasoningEffort: null,
		thinkingType: null,
		capabilitiesJson: "{}",
		guideNoteEn: null,
		guideNoteHu: null,
		guideBadge: null,
		guideNoCost: false,
		estimatedTokensPerSecond: null,
		inputUsdMicrosPer1m: 1_000_000,
		cachedInputUsdMicrosPer1m: 100_000,
		cacheHitUsdMicrosPer1m: 999_000,
		cacheMissUsdMicrosPer1m: 0,
		outputUsdMicrosPer1m: 2_000_000,
		enabled: true,
		sortOrder: 0,
		createdAt: "",
		updatedAt: "",
	};
}

function renderForm(onClose = vi.fn()) {
	render(ModelForm, {
		providerId: "provider-1",
		model: modelFixture(),
		onSave: vi.fn(),
		onClose,
	});
	return onClose;
}

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

describe("ModelForm as a dialog: how it closes", () => {
	it("is a modal dialog named for what it does", () => {
		renderForm();

		expect(screen.getByRole("dialog", { name: "Edit Model" })).toHaveAttribute(
			"aria-modal",
			"true",
		);
	});

	it("closes on Escape", () => {
		const onClose = renderForm();

		pressKey("Escape");

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes from its close button and from Cancel", async () => {
		const onClose = renderForm();

		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onClose).toHaveBeenCalledTimes(2);
	});
});

describe("ModelForm among other dialogs", () => {
	it("sits on the open-dialog stack while it is mounted", () => {
		expect(hasOpenDialog()).toBe(false);
		const { unmount } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onClose: vi.fn(),
		});
		expect(hasOpenDialog()).toBe(true);

		unmount();

		expect(hasOpenDialog()).toBe(false);
	});

	it("leaves Escape to a dialog opened on top of it (the icon crop), and answers again once that dialog closes", () => {
		const onClose = renderForm();
		const topmost = Symbol("dialog-on-top");

		registerDialog(topmost);
		try {
			pressKey("Escape");
			expect(onClose).not.toHaveBeenCalled();
		} finally {
			deregisterDialog(topmost);
		}

		pressKey("Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("ModelForm as a modal dialog", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	const dialog = () => screen.getByRole("dialog", { name: "Edit Model" });

	it("takes focus on the dialog itself when it opens", async () => {
		renderForm();

		await waitFor(() => expect(dialog()).toHaveFocus());
	});

	it("wraps Tab from the last control to the first, and Shift+Tab back", async () => {
		renderForm();
		await waitFor(() => expect(dialog()).toHaveFocus());
		const close = screen.getByRole("button", { name: "Close" });
		const cancel = screen.getByRole("button", { name: "Cancel" });

		cancel.focus();
		const forward = pressKey("Tab");
		expect(forward.defaultPrevented).toBe(true);
		expect(close).toHaveFocus();

		const backward = pressKey("Tab", { shiftKey: true });
		expect(backward.defaultPrevented).toBe(true);
		expect(cancel).toHaveFocus();
	});

	it("wraps Shift+Tab pressed on the dialog itself, where focus starts, to the last control", async () => {
		renderForm();
		await waitFor(() => expect(dialog()).toHaveFocus());

		const event = pressKey("Tab", { shiftKey: true });

		expect(event.defaultPrevented).toBe(true);
		expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
	});

	it("pulls focus that has left the dialog back to its first control", async () => {
		renderForm();
		await waitFor(() => expect(dialog()).toHaveFocus());
		const outside = document.createElement("button");
		document.body.append(outside);
		outside.focus();

		const event = pressKey("Tab");

		expect(event.defaultPrevented).toBe(true);
		expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
	});

	it("cancels the Escape key it closes on", () => {
		const onClose = renderForm();

		const event = pressKey("Escape");

		expect(event.defaultPrevented).toBe(true);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("gives focus back to whatever had it when it opened, without scrolling the page behind", async () => {
		const opener = document.createElement("button");
		document.body.append(opener);
		opener.focus();
		const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

		const { unmount } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onClose: vi.fn(),
		});
		await waitFor(() => expect(dialog()).toHaveFocus());
		expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

		unmount();

		expect(opener).toHaveFocus();
		expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
		focusSpy.mockRestore();
	});

	it("leaves Tab to a dialog opened on top of it", async () => {
		renderForm();
		await waitFor(() => expect(dialog()).toHaveFocus());
		const cancel = screen.getByRole("button", { name: "Cancel" });
		cancel.focus();
		const topmost = Symbol("dialog-on-top");

		registerDialog(topmost);
		try {
			const event = pressKey("Tab");
			expect(event.defaultPrevented).toBe(false);
			expect(cancel).toHaveFocus();
		} finally {
			deregisterDialog(topmost);
		}
	});
});
