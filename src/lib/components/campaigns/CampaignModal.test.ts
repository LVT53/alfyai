import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Campaign } from "$lib/client/api/campaigns";
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
		const onSkip = vi.fn();
		const opener = document.createElement("button");
		opener.textContent = "Open campaign";
		document.body.append(opener);
		opener.focus();

		render(CampaignModal, {
			props: {
				campaign,
				locale: "en",
				onSkip,
			},
		});

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
