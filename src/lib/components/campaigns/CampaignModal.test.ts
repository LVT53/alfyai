import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign } from "$lib/client/api/campaigns";
import {
	deregisterDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import CampaignModal from "./CampaignModal.svelte";

const campaign: Campaign = {
	id: "campaign-1",
	type: "first_run_onboarding",
	status: "published",
	name: "Welcome tour",
	slides: [
		{
			id: "slide-setup",
			layoutType: "setup",
			sortOrder: 1,
			title: { en: "Set up AlfyAI", hu: "AlfyAI beállítása" },
			body: { en: "Choose your defaults.", hu: "Válaszd ki az alapokat." },
			altText: { en: "Setup screenshot", hu: "Beállítás képernyőkép" },
			desktopCropAssetId: "asset-desktop-1",
			mobileCropAssetId: "asset-mobile-1",
			setupControls: ["ui_language", "theme", "model_default", "ai_style"],
		},
		{
			id: "slide-feature",
			layoutType: "standard",
			sortOrder: 2,
			title: { en: "Start chatting", hu: "Kezdj beszélgetni" },
			body: { en: "Ask a question.", hu: "Tegyél fel egy kérdést." },
			altText: { en: "Chat screenshot", hu: "Chat képernyőkép" },
			desktopCropAssetId: "asset-desktop-2",
			mobileCropAssetId: "asset-mobile-2",
			actionLabel: { en: "Open chat", hu: "Chat megnyitása" },
			actionDestination: "/chat",
		},
	],
};

describe("CampaignModal", () => {
	it("lets users navigate, records viewed slides, skips, and finishes", async () => {
		const onSlideView = vi.fn();
		const onSkip = vi.fn();
		const onFinish = vi.fn();

		render(CampaignModal, {
			props: {
				campaign,
				locale: "en",
				onSlideView,
				onSkip,
				onFinish,
			},
		});

		const firstImage = screen.getByRole("img", { name: "Setup screenshot" });
		expect(firstImage).toHaveAttribute(
			"src",
			"/api/campaign-assets/asset-desktop-1/content",
		);
		expect(firstImage.closest(".campaign-image-frame")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Set up AlfyAI" }),
		).toBeInTheDocument();
		expect(screen.queryByText("Setup")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();

		await waitFor(() => {
			expect(onSlideView).toHaveBeenCalledWith(
				expect.objectContaining({ id: "slide-setup" }),
				0,
			);
		});

		await fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(
			screen.getByRole("heading", { name: "Start chatting" }),
		).toBeInTheDocument();
		const secondImage = screen.getByRole("img", { name: "Chat screenshot" });
		expect(secondImage).toHaveAttribute(
			"src",
			"/api/campaign-assets/asset-desktop-2/content",
		);
		expect(secondImage).not.toBe(firstImage);
		expect(screen.getByRole("link", { name: "Open chat" })).toHaveClass(
			"campaign-action-link",
		);
		expect(
			screen.queryByRole("button", { name: "Skip" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Finish" })).toBeInTheDocument();
		await waitFor(() => {
			expect(onSlideView).toHaveBeenCalledWith(
				expect.objectContaining({ id: "slide-feature" }),
				1,
			);
		});

		await fireEvent.click(screen.getByRole("button", { name: "Finish" }));
		expect(onFinish).toHaveBeenCalledTimes(1);
		expect(onSkip).not.toHaveBeenCalled();
	});

	it("uses app-native fallback images with empty alt text when a slide has no uploaded image", () => {
		const fallbackCampaign: Campaign = {
			id: "campaign-fallback",
			type: "release_update",
			status: "published",
			name: "Fallback images",
			slides: [
				{
					id: "slide-no-image",
					layoutType: "standard",
					sortOrder: 1,
					title: { en: "New release", hu: "Új kiadás" },
					body: {
						en: "No screenshot needed.",
						hu: "Nincs szükség képernyőképre.",
					},
					altText: { en: "", hu: "" },
				},
			],
		};

		const { container } = render(CampaignModal, {
			props: {
				campaign: fallbackCampaign,
				locale: "en",
			},
		});

		const image = container.querySelector("img");
		const source = container.querySelector("source");
		expect(image).not.toBeNull();
		expect(source).not.toBeNull();
		if (
			!(image instanceof HTMLImageElement) ||
			!(source instanceof HTMLSourceElement)
		) {
			throw new Error("Expected fallback campaign media elements to render.");
		}
		expect(image).toHaveAttribute(
			"src",
			"/campaign-fallbacks/alfyai-brand-desktop.png",
		);
		expect(image).toHaveAttribute("alt", "");
		expect(source).toHaveAttribute(
			"srcset",
			"/campaign-fallbacks/alfyai-brand-mobile.png",
		);
	});

	it("treats close as skip and renders setup controls through preference callbacks", async () => {
		const onSkip = vi.fn();
		const onChangeUiLanguage = vi.fn();
		const onChangeTheme = vi.fn();
		const onChangeModel = vi.fn();
		const onChangePersonality = vi.fn();

		render(CampaignModal, {
			props: {
				campaign,
				locale: "en",
				onSkip,
				setupPreferences: {
					availableModels: [
						{ id: "model1", displayName: "Model 1" },
						{ id: "model2", displayName: "Model 2" },
					],
					effectiveModel: "model2",
					systemDefaultModel: "model2",
					selectedModel: null,
					selectedTheme: "system",
					selectedUiLanguage: "en",
					personalityProfiles: [
						{ id: "concise", name: "Concise", description: "Short answers" },
					],
					selectedPersonalityId: null,
					onChangeUiLanguage,
					onChangeTheme,
					onChangeModel,
					onChangePersonality,
				},
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Hungarian" }));
		await fireEvent.click(screen.getByRole("button", { name: "Dark" }));
		await fireEvent.change(
			screen.getByRole("combobox", { name: "Default model" }),
			{
				target: { value: "model1" },
			},
		);
		await fireEvent.change(
			screen.getByRole("combobox", { name: "Default style" }),
			{
				target: { value: "concise" },
			},
		);
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));

		expect(onChangeUiLanguage).toHaveBeenCalledWith("hu");
		expect(onChangeTheme).toHaveBeenCalledWith("dark");
		expect(onChangeModel).toHaveBeenCalledWith("model1");
		expect(onChangePersonality).toHaveBeenCalledWith("concise");
		expect(onSkip).toHaveBeenCalledTimes(1);
	});

	it("keeps keyboard focus inside the dialog and restores focus when Escape skips it", async () => {
		const user = userEvent.setup();
		// The app shell removes the modal the moment it is skipped
		// (`finishActiveCampaign` clears the active campaign), so the test's
		// parent does the same; focus goes back to the opener as it leaves.
		let removeModal = () => {};
		const onSkip = vi.fn(() => removeModal());
		const opener = document.createElement("button");
		opener.textContent = "Open campaign";
		document.body.append(opener);
		opener.focus();

		({ unmount: removeModal } = render(CampaignModal, {
			props: {
				campaign,
				locale: "en",
				onSkip,
			},
		}));

		const dialog = screen.getByRole("dialog", {
			name: "Campaign announcement",
		});
		const closeButton = screen.getByRole("button", { name: "Close" });

		await waitFor(() => {
			expect(closeButton).toHaveFocus();
		});

		closeButton.focus();
		await user.keyboard("{Shift>}{Tab}{/Shift}");
		expect(dialog).toContainElement(document.activeElement as HTMLElement);

		await user.keyboard("{Escape}");

		expect(onSkip).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(opener).toHaveFocus();
		});
		opener.remove();
	});

	function actionCampaign(actionDestination: string): Campaign {
		return {
			id: "campaign-action",
			type: "release_update",
			status: "published",
			name: "Action slide",
			slides: [
				{
					id: "slide-action",
					layoutType: "standard",
					sortOrder: 1,
					title: { en: "Take a look", hu: "Nézd meg" },
					body: { en: "Something new.", hu: "Valami új." },
					altText: { en: "Screenshot", hu: "Képernyőkép" },
					desktopCropAssetId: "asset-desktop-1",
					mobileCropAssetId: "asset-mobile-1",
					actionLabel: { en: "Go", hu: "Menj" },
					actionDestination,
				},
			],
		};
	}

	it("hands the campaign's internal action to the app instead of navigating", async () => {
		const onInternalAction = vi.fn();
		render(CampaignModal, {
			props: {
				campaign: actionCampaign("internal:chatgpt-import"),
				locale: "en",
				onInternalAction,
			},
		});

		expect(screen.queryByRole("link", { name: "Go" })).not.toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Go" }));
		expect(onInternalAction).toHaveBeenCalledWith("chatgpt-import");
	});

	it("renders a stored destination that is not allow-listed as an inert button", async () => {
		// Publishing rejects these, but a row written before the allow-list
		// existed — or straight into the database — must not become an href.
		for (const destination of [
			"javascript:alert(1)",
			"https://evil.example.com",
			"//evil.example.com",
			"/settings/../../etc/passwd",
			"internal:something-else",
			"INTERNAL:chatgpt-import",
		]) {
			const onInternalAction = vi.fn();
			const { unmount } = render(CampaignModal, {
				props: {
					campaign: actionCampaign(destination),
					locale: "en",
					onInternalAction,
				},
			});

			const link = screen.getByRole("link", { name: "Go" });
			expect(link).toHaveAttribute("href", "#");
			expect(link).toHaveAttribute("aria-disabled", "true");
			const click = new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
			});
			link.dispatchEvent(click);
			expect(click.defaultPrevented).toBe(true);
			expect(onInternalAction).not.toHaveBeenCalled();
			unmount();
		}
	});

	it("leaves Escape to a dialog opened on top of it", async () => {
		const onSkip = vi.fn();
		render(CampaignModal, {
			props: { campaign, locale: "en", onSkip },
		});

		// The ChatGPT import modal a campaign's internal action opens is a
		// DialogShell, which registers on the shared open-dialog stack.
		const topmost = Symbol("dialog-on-top");
		registerDialog(topmost);
		await userEvent.keyboard("{Escape}");
		expect(onSkip).not.toHaveBeenCalled();

		deregisterDialog(topmost);
		await userEvent.keyboard("{Escape}");
		expect(onSkip).toHaveBeenCalledTimes(1);
	});

	it("keeps an allow-listed path, query string included, as the link target", () => {
		render(CampaignModal, {
			props: {
				campaign: actionCampaign("/knowledge?tab=documents"),
				locale: "en",
			},
		});

		expect(screen.getByRole("link", { name: "Go" })).toHaveAttribute(
			"href",
			"/knowledge?tab=documents",
		);
	});
});

// Presses a key the way the browser delivers it to whatever holds focus, and
// hands back the event so a test can ask whether its default was cancelled —
// the trap's contract for Tab is "focus moved AND the default was prevented".
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

describe("CampaignModal focus containment", () => {
	let opener: HTMLButtonElement;

	beforeEach(() => {
		opener = document.createElement("button");
		opener.textContent = "Open campaign";
		document.body.append(opener);
		opener.focus();
	});

	afterEach(() => {
		opener.remove();
	});

	// Renders the announcement and waits for its deferred first focus, so a
	// test that moves focus itself never races the mount.
	async function renderOpen(props: Record<string, unknown> = {}) {
		const view = render(CampaignModal, {
			props: { campaign, locale: "en", ...props },
		});
		const closeButton = screen.getByRole("button", { name: "Close" });
		await waitFor(() => expect(closeButton).toHaveFocus());
		return { ...view, closeButton };
	}

	it("wraps Tab from the last control to the first, and Shift+Tab from the first to the last", async () => {
		const { closeButton } = await renderOpen();
		const next = screen.getByRole("button", { name: "Next" });

		next.focus();
		const forward = pressKey("Tab");
		expect(closeButton).toHaveFocus();
		expect(forward.defaultPrevented).toBe(true);

		const backward = pressKey("Tab", { shiftKey: true });
		expect(next).toHaveFocus();
		expect(backward.defaultPrevented).toBe(true);
	});

	it("leaves Tab between the two ends to the browser", async () => {
		await renderOpen();
		const skip = screen.getByRole("button", { name: "Skip" });

		skip.focus();
		const event = pressKey("Tab");

		expect(skip).toHaveFocus();
		expect(event.defaultPrevented).toBe(false);
	});

	it("pulls focus that sits outside the dialog back to the first control", async () => {
		const { closeButton } = await renderOpen();

		opener.focus();
		const forward = pressKey("Tab");
		expect(closeButton).toHaveFocus();
		expect(forward.defaultPrevented).toBe(true);

		opener.focus();
		const backward = pressKey("Tab", { shiftKey: true });
		expect(closeButton).toHaveFocus();
		expect(backward.defaultPrevented).toBe(true);
	});

	it("treats Escape as a skip: onSkip, then onClose, and the key is cancelled", async () => {
		const calls: string[] = [];
		await renderOpen({
			onSkip: () => calls.push("skip"),
			onClose: () => calls.push("close"),
		});

		const event = pressKey("Escape");

		expect(event.defaultPrevented).toBe(true);
		expect(calls).toEqual(["skip", "close"]);
	});

	it("returns focus to the opener when the dialog is removed", async () => {
		const { unmount } = await renderOpen();
		expect(opener).not.toHaveFocus();

		unmount();

		await waitFor(() => expect(opener).toHaveFocus());
	});

	it("leaves Tab to a dialog opened on top of it, and traps again once that dialog closes", async () => {
		const { closeButton } = await renderOpen();
		const next = screen.getByRole("button", { name: "Next" });
		const topmost = Symbol("dialog-on-top");

		registerDialog(topmost);
		try {
			next.focus();
			const atTheEnd = pressKey("Tab");
			expect(atTheEnd.defaultPrevented).toBe(false);
			expect(next).toHaveFocus();

			// Focus that belongs to the dialog on top is not pulled back in.
			opener.focus();
			const stray = pressKey("Tab");
			expect(stray.defaultPrevented).toBe(false);
			expect(opener).toHaveFocus();
		} finally {
			deregisterDialog(topmost);
		}

		next.focus();
		const afterwards = pressKey("Tab");
		expect(afterwards.defaultPrevented).toBe(true);
		expect(closeButton).toHaveFocus();
	});

	it("does nothing to focus or keys when rendered inline as a preview", async () => {
		const onSkip = vi.fn();
		const { unmount } = render(CampaignModal, {
			props: { campaign, locale: "en", inline: true, preview: true, onSkip },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(opener).toHaveFocus();

		const next = screen.getByRole("button", { name: "Next" });
		next.focus();
		const tab = pressKey("Tab");
		expect(tab.defaultPrevented).toBe(false);
		expect(next).toHaveFocus();
		const escapeKey = pressKey("Escape");
		expect(escapeKey.defaultPrevented).toBe(false);
		expect(onSkip).not.toHaveBeenCalled();

		unmount();
		expect(opener).not.toHaveFocus();
	});
});
