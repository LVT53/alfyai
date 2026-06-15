import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "$lib/client/api/models";
import { uiLanguage } from "$lib/stores/settings";
import ModelSelectionGuideModal from "./ModelSelectionGuideModal.svelte";

function model(index: number): ModelProvider["models"][number] {
	return {
		id: `model-${index}`,
		displayName: `Guide Model ${index}`,
		iconUrl: null,
		guideNoteEn: `Short guidance note ${index}.`,
		guideNoteHu: null,
		guideBadge: index % 2 === 0 ? "fast" : "intelligent",
		maxModelContext: index % 3 === 0 ? 256_000 : 64_000,
		inputUsdMicrosPer1m: index * 500_000,
		outputUsdMicrosPer1m: index * 1_000_000,
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
		const { container } = render(ModelSelectionGuideModal, {
			providers: providers(),
			onClose,
		});

		expect(screen.getByRole("dialog", { name: "Model guide" })).toBeTruthy();
		expect(container.querySelectorAll(".model-guide-row")).toHaveLength(12);
		expect(screen.getByText("Provider EU")).toBeTruthy();
		expect(screen.getByText("🇳🇱")).toHaveAttribute(
			"title",
			"Processing region: Netherlands",
		);
		expect(screen.getByRole("link", { name: "Provider privacy policy" }))
			.toHaveAttribute("href", "https://example.com/privacy");
		expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Intelligent").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Large context").length).toBeGreaterThan(0);
		expect(
			container.querySelector('[aria-label="Input $0.5000 / output $1.0000 per 1M tokens"]'),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Guide Model 1" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
