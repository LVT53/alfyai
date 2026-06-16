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
		guideBadge: index % 2 === 0 ? "simple" : "intelligent",
		guideNoCost: index === 1,
		estimatedTokensPerSecond: index === 12 ? 1_000 : index % 3 === 0 ? 150 : 45,
		maxModelContext:
			index === 12 ? 1_000_000 : index % 3 === 0 ? 256_000 : 64_000,
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
