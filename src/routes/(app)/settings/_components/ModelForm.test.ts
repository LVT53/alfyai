import { fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ModelForm from "./ModelForm.svelte";

function modelFixture(overrides: Record<string, unknown> = {}) {
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
		...overrides,
	};
}

describe("ModelForm pricing fields", () => {
	it("hides derived context previews and fallback helper copy", () => {
		const { queryByLabelText, queryByText } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave: vi.fn(),
			onClose: vi.fn(),
		});

		expect(queryByLabelText("Compaction UI Threshold (tokens)")).toBeNull();
		expect(queryByLabelText("Target Constructed Context (tokens)")).toBeNull();
		expect(
			queryByText(
				"Choose a compatible model-specific fallback. Incompatible targets are disabled.",
			),
		).toBeNull();
	});

	it("renders the enabled switch without visible label text and keeps actions in the modal footer", () => {
		const { container, getByRole } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave: vi.fn(),
			onClose: vi.fn(),
		});

		const enabledToggle = container.querySelector("#model-form-enabled");
		expect(enabledToggle).not.toBeNull();
		if (!enabledToggle) return;

		expect(enabledToggle.classList.contains("sr-only")).toBe(true);
		expect(enabledToggle.closest("label")?.textContent?.trim()).toBe("");

		const footer = container.querySelector(".modal-footer");
		expect(footer).toBeTruthy();
		expect(
			footer?.contains(getByRole("button", { name: "Save Changes" })),
		).toBe(true);
	});

	it("shows three primary price fields and maps cached input onto the legacy cache-hit rate", async () => {
		const onSave = vi.fn();
		const { getByLabelText, getByRole, queryByLabelText } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave,
			onClose: vi.fn(),
		});

		expect(getByLabelText("Input")).toBeTruthy();
		expect(getByLabelText("Cached Input")).toBeTruthy();
		expect(getByLabelText("Output")).toBeTruthy();
		expect(queryByLabelText("Cache Hit")).toBeNull();
		expect(queryByLabelText("Cache Miss")).toBeNull();

		await fireEvent.input(getByLabelText("Cached Input"), {
			target: { value: "0.25" },
		});
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				cachedInputUsdMicrosPer1m: 250_000,
				cacheHitUsdMicrosPer1m: 250_000,
			}),
		);
	});

	it("keeps cache write/miss pricing behind the advanced disclosure", async () => {
		const onSave = vi.fn();
		const { getByLabelText, getByRole, getByText } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave,
			onClose: vi.fn(),
		});

		expect(getByText("Advanced cache pricing")).toBeTruthy();

		await fireEvent.input(getByLabelText("Cache write / miss"), {
			target: { value: "0.75" },
		});
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				cacheMissUsdMicrosPer1m: 750_000,
			}),
		);
	});

	it("saves guide display metadata", async () => {
		const onSave = vi.fn();
		const { getByLabelText, getByRole } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave,
			onClose: vi.fn(),
		});

		await fireEvent.change(getByLabelText("Guide badge"), {
			target: { value: "simple" },
		});
		await fireEvent.input(getByLabelText("Estimated speed"), {
			target: { value: "150" },
		});
		await fireEvent.click(getByRole("checkbox", { name: /Show as no cost/ }));
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				guideBadge: "simple",
				guideNoCost: true,
				estimatedTokensPerSecond: 150,
			}),
		);
	});
});

describe("ModelForm can see images", () => {
	const IMAGE_OVERRIDE = {
		state: "manual_override",
		supported: true,
		source: "manual_override",
	};
	const seeingJson = JSON.stringify({
		tools: "detected",
		imageMessageParts: IMAGE_OVERRIDE,
	});

	function renderForm(
		model: ReturnType<typeof modelFixture> | null,
		onSave = vi.fn(),
	) {
		return {
			onSave,
			...render(ModelForm, {
				providerId: "provider-1",
				model,
				onSave,
				onClose: vi.fn(),
			}),
		};
	}

	it("is ticked only for a model that carries an explicit seeing capability", () => {
		const blind = renderForm(
			modelFixture({ capabilitiesJson: '{"tools":"detected"}' }),
		);
		expect(
			blind.getByRole("checkbox", { name: /Can see images/ }),
		).not.toBeChecked();
		blind.unmount();

		const seeing = renderForm(modelFixture({ capabilitiesJson: seeingJson }));
		expect(
			seeing.getByRole("checkbox", { name: /Can see images/ }),
		).toBeChecked();
	});

	it("explains what ticking it does", () => {
		const { getByText } = renderForm(modelFixture());

		expect(
			getByText(/Alfy sends this model the images people attach/),
		).toBeInTheDocument();
	});

	// A screen reader says the name on landing on the box and the description
	// after it. A label that wraps the explanation as well makes the whole
	// explanation the name. A string `name` is matched against the whole
	// accessible name, so these fail when the explanation is part of it.
	describe("what a screen reader is told about the box", () => {
		afterEach(() => {
			uiLanguage.set("en");
		});

		it("names it by its label alone and gives the explanation as its description", () => {
			const { getByRole } = renderForm(modelFixture());

			const box = getByRole("checkbox", { name: "Can see images" });
			expect(box).toHaveAccessibleName("Can see images");
			expect(box).toHaveAccessibleDescription(
				/^Alfy sends this model the images people attach\./,
			);
		});

		it("does the same in Hungarian", () => {
			uiLanguage.set("hu");
			const { getByRole } = renderForm(modelFixture());

			const box = getByRole("checkbox", { name: "Lát képeket" });
			expect(box).toHaveAccessibleName("Lát képeket");
			expect(box).toHaveAccessibleDescription(
				/^Alfy elküldi ennek a modellnek a csatolt képeket\./,
			);
		});

		it("is ticked by clicking its name", async () => {
			const { getByRole, getByText } = renderForm(modelFixture());
			expect(
				getByRole("checkbox", { name: "Can see images" }),
			).not.toBeChecked();

			await fireEvent.click(getByText("Can see images"));

			expect(getByRole("checkbox", { name: "Can see images" })).toBeChecked();
		});
	});

	it("saves a manual override and keeps the other capabilities when ticked", async () => {
		const { getByRole, onSave } = renderForm(
			modelFixture({ capabilitiesJson: '{"tools":"detected"}' }),
		);

		await fireEvent.click(getByRole("checkbox", { name: /Can see images/ }));
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(JSON.parse(onSave.mock.calls[0][0].capabilitiesJson)).toEqual({
			tools: "detected",
			imageMessageParts: IMAGE_OVERRIDE,
		});
	});

	it("takes the capability out, never writing false, when unticked", async () => {
		const { getByRole, onSave } = renderForm(
			modelFixture({ capabilitiesJson: seeingJson }),
		);

		await fireEvent.click(getByRole("checkbox", { name: /Can see images/ }));
		expect(getByRole("checkbox", { name: /Can see images/ })).not.toBeChecked();
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(JSON.parse(onSave.mock.calls[0][0].capabilitiesJson)).toEqual({
			tools: "detected",
		});
	});

	it("sends the stored capabilities as they were when the box is left alone", async () => {
		const stored = '{"chat": "detected",  "tools":"detected"}';
		const { getByRole, onSave } = renderForm(
			modelFixture({ capabilitiesJson: stored }),
		);

		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave.mock.calls[0][0].capabilitiesJson).toBe(stored);
	});

	it("sends the override with a new model", async () => {
		const { getByLabelText, getByRole, onSave } = renderForm(null);

		await fireEvent.input(getByLabelText("Model Name"), {
			target: { value: "vision-model" },
		});
		await fireEvent.input(getByLabelText("Display Name"), {
			target: { value: "Vision Model" },
		});
		await fireEvent.click(getByRole("checkbox", { name: /Can see images/ }));
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledTimes(1);
		const saved = onSave.mock.calls[0][0];
		expect(saved.name).toBe("vision-model");
		expect(JSON.parse(saved.capabilitiesJson)).toEqual({
			imageMessageParts: IMAGE_OVERRIDE,
		});
	});

	// Saving a model icon while the form is open makes ModelList hand the form a
	// new model object: the same id, the same stored capabilities, a new
	// iconAssetId. That is no reason to forget what the admin has ticked, and
	// forgetting an untick would leave images going to a model that was meant to
	// stop getting them.
	it.each([
		{
			edit: "tick",
			stored: '{"tools":"detected"}',
			ticked: true,
			saved: { tools: "detected", imageMessageParts: IMAGE_OVERRIDE },
		},
		{
			edit: "untick",
			stored: seeingJson,
			ticked: false,
			saved: { tools: "detected" },
		},
	])("keeps an unsaved $edit when an icon is saved while the form is open", async ({
		stored,
		ticked,
		saved,
	}) => {
		const model = modelFixture({ capabilitiesJson: stored });
		const { getByRole, onSave, rerender } = renderForm(model);
		const box = () => getByRole("checkbox", { name: /Can see images/ });

		await fireEvent.click(box());
		await rerender({ model: { ...model, iconAssetId: "x" } });

		if (ticked) expect(box()).toBeChecked();
		else expect(box()).not.toBeChecked();

		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(JSON.parse(onSave.mock.calls[0][0].capabilitiesJson)).toEqual(saved);
	});

	// A different model, or the same model with other stored capabilities, is a
	// real change of subject: the box follows the stored value and drops what was
	// pending. Each row changes one of the two things the form compares.
	it.each([
		{
			change: "another model with capabilities of its own",
			tickFirst: false,
			next: { id: "model-2", capabilitiesJson: seeingJson },
			ticked: true,
		},
		{
			change: "another model with the same stored capabilities",
			tickFirst: true,
			next: { id: "model-2", capabilitiesJson: '{"tools":"detected"}' },
			ticked: false,
		},
		{
			change: "the same model with other stored capabilities",
			tickFirst: true,
			next: {
				id: "model-1",
				capabilitiesJson: '{"tools":"detected","chat":"detected"}',
			},
			ticked: false,
		},
	])("follows the stored capabilities of $change", async ({
		tickFirst,
		next,
		ticked,
	}) => {
		const { getByRole, rerender } = renderForm(
			modelFixture({ id: "model-1", capabilitiesJson: '{"tools":"detected"}' }),
		);
		const box = () => getByRole("checkbox", { name: /Can see images/ });
		if (tickFirst) await fireEvent.click(box());

		await rerender({ model: modelFixture(next) });

		if (ticked) expect(box()).toBeChecked();
		else expect(box()).not.toBeChecked();
	});

	it("compares against the model it last followed, not the one it opened with", async () => {
		const { getByRole, rerender } = renderForm(
			modelFixture({ id: "model-1", capabilitiesJson: '{"tools":"detected"}' }),
		);
		const box = () => getByRole("checkbox", { name: /Can see images/ });
		const second = modelFixture({
			id: "model-2",
			capabilitiesJson: seeingJson,
		});

		await rerender({ model: second });
		expect(box()).toBeChecked();
		await fireEvent.click(box());
		await rerender({ model: { ...second, iconAssetId: "x" } });

		expect(box()).not.toBeChecked();
	});
});

describe("ModelForm aliases", () => {
	it("renders aliases for an existing model", () => {
		const { getByLabelText } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture({
				aliases: [
					"accounts/fireworks/models/qwen3p7-max",
					"provider/qwen3.7-max",
				],
			}),
			onSave: vi.fn(),
			onClose: vi.fn(),
		});

		expect(getByLabelText("Alias 1")).toHaveValue(
			"accounts/fireworks/models/qwen3p7-max",
		);
		expect(getByLabelText("Alias 2")).toHaveValue("provider/qwen3.7-max");
	});

	it("adds and removes alias rows", async () => {
		const { getByRole, getByLabelText, queryByDisplayValue } = render(
			ModelForm,
			{
				providerId: "provider-1",
				model: modelFixture({
					aliases: ["accounts/fireworks/models/qwen3p7-max"],
				}),
				onSave: vi.fn(),
				onClose: vi.fn(),
			},
		);

		await fireEvent.click(getByRole("button", { name: "Add alias" }));
		await fireEvent.input(getByLabelText("Alias 2"), {
			target: { value: "provider/qwen3.7-max" },
		});

		expect(getByLabelText("Alias 2")).toHaveValue("provider/qwen3.7-max");

		await fireEvent.click(getByRole("button", { name: "Remove alias 1" }));

		expect(
			queryByDisplayValue("accounts/fireworks/models/qwen3p7-max"),
		).toBeNull();
		expect(getByLabelText("Alias 1")).toHaveValue("provider/qwen3.7-max");
	});

	it("dedupes and trims aliases before saving", async () => {
		const onSave = vi.fn();
		const { getByRole, getByLabelText } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave,
			onClose: vi.fn(),
		});

		await fireEvent.click(getByRole("button", { name: "Add alias" }));
		await fireEvent.input(getByLabelText("Alias 1"), {
			target: { value: " accounts/fireworks/models/qwen3p7-max " },
		});
		await fireEvent.click(getByRole("button", { name: "Add alias" }));
		await fireEvent.input(getByLabelText("Alias 2"), {
			target: { value: "ACCOUNTS/fireworks/models/qwen3p7-max" },
		});
		await fireEvent.click(getByRole("button", { name: "Add alias" }));
		await fireEvent.input(getByLabelText("Alias 3"), {
			target: { value: " provider/qwen3.7-max " },
		});

		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				aliases: [
					"accounts/fireworks/models/qwen3p7-max",
					"provider/qwen3.7-max",
				],
			}),
		);
	});

	it("blocks aliases that equal the canonical model name", async () => {
		const onSave = vi.fn();
		const { getByRole, getByLabelText, getByText } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture({ name: "qwen3.7-max" }),
			onSave,
			onClose: vi.fn(),
		});

		await fireEvent.click(getByRole("button", { name: "Add alias" }));
		await fireEvent.input(getByLabelText("Alias 1"), {
			target: { value: " QWEN3.7-MAX " },
		});
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(
			getByText("Alias cannot match the canonical model name."),
		).toBeInTheDocument();
		expect(onSave).not.toHaveBeenCalled();
	});
});

describe("ModelForm reasoning effort", () => {
	it("saves official none and minimal reasoning effort values", async () => {
		const onSave = vi.fn();
		const { getByLabelText, getByRole } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave,
			onClose: vi.fn(),
		});

		const reasoningSelect = getByLabelText(
			"Reasoning Effort",
		) as HTMLSelectElement;
		expect(reasoningSelect.options[0].textContent).toBe("Provider default");

		await fireEvent.change(reasoningSelect, {
			target: { value: "none" },
		});
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		await fireEvent.change(reasoningSelect, {
			target: { value: "minimal" },
		});
		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ reasoningEffort: "none" }),
		);
		expect(onSave).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ reasoningEffort: "minimal" }),
		);
	});
});
