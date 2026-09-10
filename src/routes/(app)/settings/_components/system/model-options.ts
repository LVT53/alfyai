// One option list for every model select on the System screen.
//
// The old pane had four near-identical builders (`adminModelOptions`,
// `memoryModelOptions`, `timeoutFailoverTargetModelOptions`,
// `defaultNewUserModelOptions`) with slightly different fallback rules, so the
// same model could be offered in one select and missing from the next. This is
// the single builder; the differences that were real — the failover target must
// name a concrete model, and a stale configured id must stay selectable — are
// options rather than separate functions.

import type { Provider, ProviderModel } from "$lib/client/api/admin";
import type { ModelId } from "$lib/model-types";

export interface ModelOption {
	id: ModelId;
	label: string;
	/** Right-hand hint: pricing, or the provider for a built-in. */
	hint?: string;
}

export interface ModelOptionGroup {
	label: string;
	options: ModelOption[];
}

export interface ModelOptionInput {
	availableModels: Array<{ id: ModelId; displayName: string }>;
	providers: Provider[];
	providerModels: ProviderModel[];
	adminConfig: Record<string, string>;
	/** Localised word for a model that costs nothing; shown as its price hint. */
	freeLabel?: string;
	/** Include the `provider:<id>` entries that mean "this provider's model". */
	includeProviderLevel?: boolean;
	/**
	 * Keep these values selectable even when they match nothing else. Every
	 * select that shares one group list must contribute its own configured id:
	 * one rescued id is not enough, and a stale id with no option silently
	 * renders as whichever model happens to be first.
	 */
	configuredValues?: ReadonlyArray<string | undefined>;
}

export function isExplicitProviderModelId(modelId: string): boolean {
	return modelId.startsWith("provider:") && modelId.split(":").length >= 3;
}

function priceHint(
	model: ProviderModel,
	freeLabel: string,
): string | undefined {
	const format = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
	if (!model.inputUsdMicrosPer1m && !model.outputUsdMicrosPer1m) {
		return freeLabel;
	}
	return `${format(model.inputUsdMicrosPer1m)} / ${format(model.outputUsdMicrosPer1m)}`;
}

function builtInLabel(
	name: "model1" | "model2",
	adminConfig: Record<string, string>,
): string {
	const key =
		name === "model1" ? "MODEL_1_DISPLAY_NAME" : "MODEL_2_DISPLAY_NAME";
	return adminConfig[key] || (name === "model1" ? "Model 1" : "Model 2");
}

/**
 * Grouped options: built-ins first, then one group per enabled provider. Every
 * id that could previously be chosen is still here.
 */
export function buildModelOptionGroups(
	input: ModelOptionInput,
): ModelOptionGroup[] {
	const {
		availableModels,
		providers,
		providerModels,
		adminConfig,
		freeLabel = "free",
		includeProviderLevel = true,
		configuredValues = [],
	} = input;

	const seen = new Set<string>();
	const groups: ModelOptionGroup[] = [];

	const builtIns: ModelOption[] = [];
	const pushBuiltIn = (name: "model1" | "model2") => {
		if (name === "model2" && adminConfig.MODEL_2_ENABLED === "false") return;
		if (seen.has(name)) return;
		seen.add(name);
		const fromAvailable = availableModels.find((model) => model.id === name);
		builtIns.push({
			id: name,
			label: fromAvailable?.displayName || builtInLabel(name, adminConfig),
		});
	};
	pushBuiltIn("model1");
	pushBuiltIn("model2");
	if (builtIns.length > 0) {
		groups.push({ label: "", options: builtIns });
	}

	for (const provider of providers) {
		if (!provider.enabled) continue;
		const options: ModelOption[] = [];

		if (includeProviderLevel) {
			const providerId = `provider:${provider.id}` as ModelId;
			if (!seen.has(providerId)) {
				seen.add(providerId);
				options.push({ id: providerId, label: provider.displayName });
			}
		}

		for (const model of providerModels) {
			if (model.providerId !== provider.id) continue;
			// A disabled model was never offered by the old builders (they read the
			// already-filtered available-models list) and must not start being.
			if (!model.enabled) continue;
			const id = `provider:${provider.id}:${model.id}` as ModelId;
			const fromAvailable = availableModels.find((entry) => entry.id === id);
			if (seen.has(id)) continue;
			seen.add(id);
			options.push({
				id,
				label: fromAvailable?.displayName || model.displayName || model.name,
				hint: priceHint(model, freeLabel),
			});
		}

		if (options.length > 0) {
			groups.push({ label: provider.displayName, options });
		}
	}

	// Anything the models endpoint knows about that the provider tables did not
	// produce — never drop an option the old builders offered.
	const leftovers = availableModels.filter((model) => {
		if (seen.has(model.id)) return false;
		if (!includeProviderLevel && !isExplicitProviderModelId(model.id)) {
			return false;
		}
		return true;
	});
	for (const model of leftovers) {
		seen.add(model.id);
	}
	if (leftovers.length > 0) {
		groups.push({
			label: "",
			options: leftovers.map((model) => ({
				id: model.id,
				label: model.displayName,
			})),
		});
	}

	const rescued: ModelOption[] = [];
	for (const configured of configuredValues) {
		if (!configured || seen.has(configured)) continue;
		seen.add(configured);
		rescued.push({ id: configured as ModelId, label: configured });
	}
	if (rescued.length > 0) {
		groups.push({ label: "", options: rescued });
	}

	return groups;
}

export function flattenModelOptions(groups: ModelOptionGroup[]): ModelOption[] {
	return groups.flatMap((group) => group.options);
}

/**
 * The value a select should show: the configured one when it is offered, else
 * the first option — never an empty, index -1 select.
 */
export function resolveModelValue(
	groups: ModelOptionGroup[],
	configured: string | undefined,
	fallback: ModelId = "model1",
): ModelId {
	const options = flattenModelOptions(groups);
	if (configured && options.some((option) => option.id === configured)) {
		return configured as ModelId;
	}
	return options[0]?.id ?? fallback;
}
