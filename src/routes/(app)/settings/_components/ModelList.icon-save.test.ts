import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ModelList from "./ModelList.svelte";

function modelFixture(capabilitiesJson: string) {
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
		capabilitiesJson,
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

const SEEING = JSON.stringify({
	imageMessageParts: {
		state: "manual_override",
		supported: true,
		source: "manual_override",
	},
});

// The icon is saved from inside the open model form: the admin system pane then
// hands ModelList `modelIconAssetSaved`, and ModelList gives the form a new model
// object that carries the new icon.
describe("ModelList: saving a model icon while the model form is open", () => {
	it.each([
		{ edit: "tick", stored: "{}", ticked: true },
		{ edit: "untick", stored: SEEING, ticked: false },
	])("keeps an unsaved $edit of Can see images", async ({ stored, ticked }) => {
		const model = modelFixture(stored);
		const { getByRole, rerender } = render(ModelList, {
			providerId: "provider-1",
			models: [model],
			allModels: [model],
			allProviders: [],
			modelIconAssetSaved: null,
			onIconFile: vi.fn(),
			onRefresh: vi.fn(),
		});
		await fireEvent.click(getByRole("button", { name: "Edit GPT Example" }));
		const box = () => getByRole("checkbox", { name: /Can see images/ });

		await fireEvent.click(box());
		await rerender({
			modelIconAssetSaved: { modelId: model.id, assetId: "asset-1" },
		});

		// The form did get the new model object (it shows the new icon) ...
		expect(
			document.querySelector('img[src="/api/campaign-assets/asset-1/content"]'),
		).not.toBeNull();
		// ... and the admin's edit is still there.
		if (ticked) expect(box()).toBeChecked();
		else expect(box()).not.toBeChecked();
	});
});
