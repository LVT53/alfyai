<script lang="ts">
import { untrack } from "svelte";
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import type {
	Provider,
	ProviderModel,
	ProviderModelUpdate,
} from "$lib/client/api/admin";
import {
	getProviderModelFallbackOptions,
	type FallbackCompatibilityReason,
} from "./model-fallback";
import {
	fetchPriceWindows,
	savePriceWindows,
	type PriceWindow,
	type PriceWindowInput,
} from "$lib/client/api/admin";

const tVal = get(t);

type ProviderModelWithAliases = ProviderModel & { aliases?: unknown };
type ProviderModelUpdateWithAliases = ProviderModelUpdate & {
	name?: string;
	aliases: string[];
};

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		onClose?.();
	}
}

let {
	providerId,
	model = null,
	allModels = [],
	allProviders = [],
	saving = false,
	error = "",
	onSave,
	onClose,
	onIconFile,
}: {
	providerId: string;
	model?: ProviderModel | null;
	allModels?: ProviderModel[];
	allProviders?: Provider[];
	saving?: boolean;
	error?: string;
	onSave?: (data: ProviderModelUpdate) => void | Promise<void>;
	onClose?: () => void;
	onIconFile?: (event: Event) => void;
} = $props();

let isCreate = $derived(model === null);

let formName = $state(untrack(() => (isCreate ? "" : (model?.name ?? ""))));
let formDisplayName = $state(untrack(() => model?.displayName ?? ""));
let formIconAssetId = $state(untrack(() => model?.iconAssetId ?? null));
$effect(() => {
	formIconAssetId = model?.iconAssetId ?? null;
});
let formGuideNoteEn = $state(untrack(() => model?.guideNoteEn ?? ""));
$effect(() => {
	formGuideNoteEn = model?.guideNoteEn ?? "";
});
let formGuideNoteHu = $state(untrack(() => model?.guideNoteHu ?? ""));
$effect(() => {
	formGuideNoteHu = model?.guideNoteHu ?? "";
});
let formGuideBadge = $state(untrack(() => model?.guideBadge ?? ""));
$effect(() => {
	formGuideBadge = model?.guideBadge ?? "";
});
let formGuideNoCost = $state(untrack(() => model?.guideNoCost ?? false));
$effect(() => {
	formGuideNoCost = model?.guideNoCost ?? false;
});
let formAliases = $state<string[]>(untrack(() => readModelAliases(model)));
$effect(() => {
	formAliases = readModelAliases(model);
});
let formEstimatedTokensPerSecond = $state(
	untrack(() => numToString(model?.estimatedTokensPerSecond)),
);
$effect(() => {
	formEstimatedTokensPerSecond = numToString(model?.estimatedTokensPerSecond);
});
let formFallbackProviderModelId = $state(
	untrack(() => model?.fallbackProviderModelId ?? ""),
);
$effect(() => {
	formFallbackProviderModelId = model?.fallbackProviderModelId ?? "";
});
let formMaxModelContext = $state(
	untrack(() => numToString(model?.maxModelContext)),
);
let formMaxMessageLength = $state(
	untrack(() => numToString(model?.maxMessageLength)),
);
let formMaxTokens = $state(untrack(() => numToString(model?.maxTokens)));
let formReasoningEffort = $state(untrack(() => model?.reasoningEffort ?? ""));
let formThinkingType = $state(untrack(() => model?.thinkingType ?? ""));
let formCapabilitiesJson = $state(
	untrack(() => model?.capabilitiesJson ?? "{}"),
);
let formInputUsdPer1m = $state(
	untrack(() => microsToDollars(model?.inputUsdMicrosPer1m)),
);
let formCachedInputUsdPer1m = $state(
	untrack(() => microsToDollars(model?.cachedInputUsdMicrosPer1m)),
);
let formCacheMissUsdPer1m = $state(
	untrack(() => microsToDollars(model?.cacheMissUsdMicrosPer1m)),
);
let formOutputUsdPer1m = $state(
	untrack(() => microsToDollars(model?.outputUsdMicrosPer1m)),
);
let formEnabled = $state(untrack(() => model?.enabled ?? true));
let localError = $state("");

let visibleError = $derived(error || localError);

function numToString(value: number | null | undefined): string {
	if (value === null || value === undefined) return "";
	return String(value);
}

function stringToNum(value: string | number | null | undefined): number | null {
	if (value == null) return null;
	if (typeof value === "number") return Number.isNaN(value) ? null : value;
	const trimmed = String(value).trim();
	if (trimmed === "") return null;
	const num = Number(trimmed);
	if (Number.isNaN(num)) return null;
	return num;
}

function microsToDollars(micros: number | null | undefined): string {
	if (micros == null) return "";
	return (micros / 1_000_000).toString();
}

function dollarsToMicros(dollars: string | number | null | undefined): number {
	const num = stringToNum(dollars);
	if (num == null) return 0;
	return Math.round(num * 1_000_000);
}

function readModelAliases(
	providerModel: ProviderModel | null | undefined,
): string[] {
	const aliases = (providerModel as ProviderModelWithAliases | null | undefined)
		?.aliases;
	if (!Array.isArray(aliases)) return [];
	return aliases.filter((alias): alias is string => typeof alias === "string");
}

function addAliasRow() {
	formAliases = [...formAliases, ""];
}

function removeAliasRow(index: number) {
	formAliases = formAliases.filter((_, aliasIndex) => aliasIndex !== index);
}

function normalizedAliases(): string[] {
	const aliases: string[] = [];
	const seen = new Set<string>();

	for (const alias of formAliases) {
		const trimmed = alias.trim();
		if (!trimmed) continue;

		const key = trimmed.toLocaleLowerCase();
		if (seen.has(key)) continue;

		seen.add(key);
		aliases.push(trimmed);
	}

	return aliases;
}

function canonicalModelName(): string {
	return (isCreate ? formName : (model?.name ?? formName)).trim();
}

function validateRequiredModelFields(): boolean {
	if (isCreate && !formName.trim()) {
		localError = $t("admin.fillRequiredFields");
		return false;
	}

	if (!formDisplayName.trim()) {
		localError = $t("admin.fillRequiredBuiltIn");
		return false;
	}

	return true;
}

function validateAliases(aliases: string[]): boolean {
	const canonicalName = canonicalModelName().toLocaleLowerCase();
	if (
		canonicalName &&
		aliases.some((alias) => alias.toLocaleLowerCase() === canonicalName)
	) {
		localError = $t("admin.modelAliasCanonicalCollision");
		return false;
	}

	return true;
}

function trimmedOrNull(value: string): string | null {
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function valueOrNull(value: string | null): string | null {
	return value ? value : null;
}

function guideBadgeValue(): "intelligent" | "simple" | null {
	if (formGuideBadge === "intelligent") return "intelligent";
	if (formGuideBadge === "simple") return "simple";
	return null;
}

function fallbackProviderModelIdValue(): string | null | undefined {
	if (isCreate || !model) return undefined;
	return formFallbackProviderModelId ? formFallbackProviderModelId : null;
}

function buildModelUpdateData(
	maxContext: number | null,
	aliases: string[],
): ProviderModelUpdateWithAliases {
	return {
		displayName: formDisplayName.trim(),
		iconAssetId: valueOrNull(formIconAssetId),
		guideNoteEn: trimmedOrNull(formGuideNoteEn),
		guideNoteHu: trimmedOrNull(formGuideNoteHu),
		guideBadge: guideBadgeValue(),
		guideNoCost: formGuideNoCost,
		estimatedTokensPerSecond: stringToNum(formEstimatedTokensPerSecond),
		maxModelContext: maxContext,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: stringToNum(formMaxMessageLength),
		maxTokens: stringToNum(formMaxTokens),
		reasoningEffort: valueOrNull(formReasoningEffort),
		thinkingType: valueOrNull(formThinkingType),
		aliases,
		fallbackProviderModelId: fallbackProviderModelIdValue(),
		capabilitiesJson: valueOrNull(formCapabilitiesJson),
		inputUsdMicrosPer1m: dollarsToMicros(formInputUsdPer1m),
		cachedInputUsdMicrosPer1m: dollarsToMicros(formCachedInputUsdPer1m),
		cacheHitUsdMicrosPer1m: dollarsToMicros(formCachedInputUsdPer1m),
		cacheMissUsdMicrosPer1m: dollarsToMicros(formCacheMissUsdPer1m),
		outputUsdMicrosPer1m: dollarsToMicros(formOutputUsdPer1m),
		enabled: formEnabled,
	};
}

function fallbackReasonLabel(reason: FallbackCompatibilityReason): string {
	if (reason.kind === "disabled-target") {
		return $t("admin.modelFallbackReasonDisabledTarget");
	}

	if (reason.kind === "capability") {
		const key =
			reason.role === "source"
				? "admin.modelFallbackReasonCapabilitySource"
				: "admin.modelFallbackReasonCapabilityFallback";
		return $t(key, {
			capability: $t(`admin.capability.${reason.capability}`),
		});
	}

	if (reason.kind === "unknown-source-capability") {
		return $t("admin.modelFallbackReasonUnknownSourceCapability", {
			capability: $t(`admin.capability.${reason.capability}`),
		});
	}

	return $t("admin.modelFallbackReasonGeneric");
}

function fallbackOptions() {
	if (isCreate || !model) return [];
	return getProviderModelFallbackOptions(model, allModels);
}

function providerDisplayName(providerModel: ProviderModel): string {
	return (
		allProviders.find((provider) => provider.id === providerModel.providerId)
			?.displayName ?? providerModel.providerId
	);
}

function fallbackOptionLabel(providerModel: ProviderModel): string {
	return `${providerDisplayName(providerModel)} - ${providerModel.displayName || providerModel.name}`;
}

function hasCompatibleFallbackOption(): boolean {
	return fallbackOptions().some((option) => option.compatible);
}

function handleSave() {
	localError = "";

	if (!validateRequiredModelFields()) return;
	const maxContext = stringToNum(formMaxModelContext);
	const aliases = normalizedAliases();
	if (!validateAliases(aliases)) return;

	const data = buildModelUpdateData(maxContext, aliases);

	if (isCreate) {
		data.name = formName.trim();
	}

	onSave?.(data);
}

// --- Optional time-slot (peak/off-peak) pricing ---------------------------
// Utilitarian admin-only editor. Windows are defined in UTC and OVERRIDE the
// flat rates above while active. Managed and saved independently of the model
// (its own API + Save button) so it stays decoupled from the main form.
type WindowRow = {
	label: string;
	days: boolean[];
	start: string;
	end: string;
	inputUsd: string;
	cachedInputUsd: string;
	cacheMissUsd: string;
	outputUsd: string;
	enabled: boolean;
};

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

let priceWindowRows = $state<WindowRow[]>([]);
let priceWindowsLoaded = $state(false);
let priceWindowsLoading = $state(false);
let priceWindowsSaving = $state(false);
let priceWindowsError = $state("");
let priceWindowsSaved = $state(false);

function minuteToHHMM(minute: number): string {
	const clamped = ((minute % 1440) + 1440) % 1440;
	const h = Math.floor(clamped / 60);
	const m = clamped % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function hhmmToMinute(value: string): number {
	const [h, m] = value.split(":");
	const hours = Number(h);
	const minutes = Number(m);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
	return Math.max(0, Math.min(1439, hours * 60 + minutes));
}

function microsToDollarsMaybe(micros: number | null): string {
	if (micros == null) return "";
	return (micros / 1_000_000).toString();
}

function dollarsToMicrosMaybe(dollars: string): number | null {
	const num = stringToNum(dollars);
	if (num == null) return null;
	return Math.round(num * 1_000_000);
}

function windowToRow(window: PriceWindow): WindowRow {
	return {
		label: window.label,
		days: DAY_LABELS.map((_, day) => window.daysOfWeek.includes(String(day))),
		start: minuteToHHMM(window.startMinute),
		end: minuteToHHMM(window.endMinute),
		inputUsd: microsToDollarsMaybe(window.inputUsdMicrosPer1m),
		cachedInputUsd: microsToDollarsMaybe(window.cachedInputUsdMicrosPer1m),
		cacheMissUsd: microsToDollarsMaybe(window.cacheMissUsdMicrosPer1m),
		outputUsd: microsToDollarsMaybe(window.outputUsdMicrosPer1m),
		enabled: window.enabled,
	};
}

function rowToInput(row: WindowRow): PriceWindowInput {
	const days = row.days.map((on, day) => (on ? String(day) : "")).join("");
	const cachedInputMicros = dollarsToMicrosMaybe(row.cachedInputUsd);
	return {
		label: row.label.trim(),
		daysOfWeek: days || "0123456",
		startMinute: hhmmToMinute(row.start),
		endMinute: hhmmToMinute(row.end),
		inputUsdMicrosPer1m: dollarsToMicrosMaybe(row.inputUsd),
		cachedInputUsdMicrosPer1m: cachedInputMicros,
		// Mirror cached-input onto the legacy cache-hit rate, matching the flat
		// pricing fields above.
		cacheHitUsdMicrosPer1m: cachedInputMicros,
		cacheMissUsdMicrosPer1m: dollarsToMicrosMaybe(row.cacheMissUsd),
		outputUsdMicrosPer1m: dollarsToMicrosMaybe(row.outputUsd),
		enabled: row.enabled,
	};
}

function emptyWindowRow(): WindowRow {
	return {
		label: "",
		days: DAY_LABELS.map(() => true),
		start: "00:00",
		end: "08:00",
		inputUsd: "",
		cachedInputUsd: "",
		cacheMissUsd: "",
		outputUsd: "",
		enabled: true,
	};
}

async function loadPriceWindows() {
	if (isCreate || !model?.id || priceWindowsLoaded || priceWindowsLoading) {
		return;
	}
	priceWindowsLoading = true;
	priceWindowsError = "";
	try {
		const windows = await fetchPriceWindows(providerId, model.id);
		priceWindowRows = windows.map(windowToRow);
		priceWindowsLoaded = true;
	} catch (err) {
		priceWindowsError =
			err instanceof Error ? err.message : "Failed to load price windows";
	} finally {
		priceWindowsLoading = false;
	}
}

function handlePriceWindowsToggle(event: Event) {
	if ((event.currentTarget as HTMLDetailsElement).open) {
		void loadPriceWindows();
	}
}

function addPriceWindowRow() {
	priceWindowRows = [...priceWindowRows, emptyWindowRow()];
	priceWindowsSaved = false;
}

function removePriceWindowRow(index: number) {
	priceWindowRows = priceWindowRows.filter((_, i) => i !== index);
	priceWindowsSaved = false;
}

async function handleSavePriceWindows() {
	if (isCreate || !model?.id) return;
	for (const row of priceWindowRows) {
		if (!row.label.trim()) {
			priceWindowsError = "Each time-slot window needs a label.";
			return;
		}
	}
	priceWindowsSaving = true;
	priceWindowsError = "";
	priceWindowsSaved = false;
	try {
		const saved = await savePriceWindows(
			providerId,
			model.id,
			priceWindowRows.map(rowToInput),
		);
		priceWindowRows = saved.map(windowToRow);
		priceWindowsSaved = true;
	} catch (err) {
		priceWindowsError =
			err instanceof Error ? err.message : "Failed to save price windows";
	} finally {
		priceWindowsSaving = false;
	}
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-overlay" role="dialog" aria-modal="true" aria-label={isCreate ? $t('admin.addModel') : $t('admin.editModel')}>
	<div class="modal-card">
		<div class="modal-header">
			<h2 class="modal-title">{isCreate ? $t('admin.addModel') : $t('admin.editModel')}</h2>
			<button class="modal-close" onclick={onClose} aria-label={$t('common.close')}>&times;</button>
		</div>
		<div class="modal-body">
			<div class="flex flex-col gap-3">
				<div>
					<label class="settings-label" for="model-form-name">{$t('admin.modelName')}</label>
					<input
						id="model-form-name"
						type="text"
						class="settings-input"
						bind:value={formName}
						placeholder={$t('admin.modelNamePlaceholderProvider')}
						disabled={!isCreate}
					/>
					{#if isCreate}
						<p class="mt-1 text-xs text-text-muted">{$t('admin.nameIdDescription')}</p>
					{/if}
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<h3 class="text-sm font-medium text-text-primary">{$t('admin.modelAliases')}</h3>
							<p class="text-xs text-text-muted">{$t('admin.modelAliasesDescription')}</p>
						</div>
						<button
							type="button"
							class="btn-secondary shrink-0 text-xs"
							onclick={addAliasRow}
						>
							{$t('admin.addModelAlias')}
						</button>
					</div>
					{#if formAliases.length > 0}
						<div class="mt-3 space-y-2">
							{#each formAliases as _alias, index (index)}
								<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
									<div>
										<label class="sr-only" for={`model-form-alias-${index}`}>
											{$t('admin.modelAliasInputA11y', { number: index + 1 })}
										</label>
										<input
											id={`model-form-alias-${index}`}
											type="text"
											class="settings-input"
											bind:value={formAliases[index]}
											placeholder={$t('admin.modelAliasPlaceholder')}
										/>
									</div>
									<button
										type="button"
										class="btn-secondary h-10 w-10 px-0"
										aria-label={$t('admin.removeModelAliasA11y', { number: index + 1 })}
										onclick={() => removeAliasRow(index)}
									>
										&times;
									</button>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<div>
					<div class="flex items-end gap-3">
						<div class="min-w-0 flex-1">
							<label class="settings-label" for="model-form-display-name">{$t('admin.displayName')}</label>
							<input
								id="model-form-display-name"
								type="text"
								class="settings-input"
								bind:value={formDisplayName}
								placeholder={$t('admin.displayNamePlaceholder')}
							/>
						</div>
						<label
							class="relative mb-2 inline-flex cursor-pointer items-center"
							title={formEnabled ? $t('admin.enabled') : $t('admin.disabled')}
							aria-label={formEnabled ? $t('admin.enabled') : $t('admin.disabled')}
						>
							<input
								id="model-form-enabled"
								type="checkbox"
								class="peer sr-only"
								bind:checked={formEnabled}
							/>
							<div
								class="peer h-5 w-9 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"
							></div>
						</label>
					</div>
				</div>

				<div>
					<label class="settings-label" for="model-form-icon">{$t('admin.modelIcon')}</label>
					<div class="flex items-center gap-3">
						{#if formIconAssetId}
							<img
								src={`/api/campaign-assets/${encodeURIComponent(formIconAssetId)}/content`}
								alt=""
								class="h-10 w-10 rounded object-cover"
							/>
						{/if}
						{#if onIconFile}
							<input
								id="model-form-icon"
								type="file"
								accept="image/*"
								class="settings-input"
								onchange={onIconFile}
							/>
						{/if}
					</div>
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.modelGuide')}</h3>
					<p class="text-xs text-text-muted">{$t('admin.modelGuideDescription')}</p>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-guide-badge">{$t('admin.modelGuideBadge')}</label>
							<select
								id="model-form-guide-badge"
								class="settings-input"
								bind:value={formGuideBadge}
							>
								<option value="">{$t('admin.none')}</option>
								<option value="intelligent">{$t('modelSelector.badge.intelligent')}</option>
								<option value="simple">{$t('modelSelector.badge.simple')}</option>
							</select>
						</div>
						<div>
							<label class="settings-label" for="model-form-estimated-speed">{$t('admin.modelEstimatedSpeed')}</label>
							<input
								id="model-form-estimated-speed"
								type="number"
								class="settings-input"
								bind:value={formEstimatedTokensPerSecond}
								placeholder={$t('admin.modelEstimatedSpeedPlaceholder')}
								min="0"
								step="1"
							/>
							<p class="mt-1 text-xs text-text-muted">{$t('admin.modelEstimatedSpeedDescription')}</p>
						</div>
						<label class="flex items-center gap-3 rounded border border-border px-3 py-2 text-sm text-text-primary">
							<input
								id="model-form-guide-no-cost"
								type="checkbox"
								bind:checked={formGuideNoCost}
							/>
							<span>
								<span class="block font-medium">{$t('admin.modelGuideNoCost')}</span>
								<span class="block text-xs text-text-muted">{$t('admin.modelGuideNoCostDescription')}</span>
							</span>
						</label>
						<div>
							<label class="settings-label" for="model-form-guide-note-en">{$t('admin.modelGuideNoteEn')}</label>
							<textarea
								id="model-form-guide-note-en"
								class="settings-input min-h-20"
								bind:value={formGuideNoteEn}
								maxlength="180"
								placeholder={$t('admin.modelGuideNotePlaceholder')}
							></textarea>
						</div>
						<div class="md:col-span-2">
							<label class="settings-label" for="model-form-guide-note-hu">{$t('admin.modelGuideNoteHu')}</label>
							<textarea
								id="model-form-guide-note-hu"
								class="settings-input min-h-20"
								bind:value={formGuideNoteHu}
								maxlength="180"
								placeholder={$t('admin.modelGuideNotePlaceholder')}
							></textarea>
						</div>
					</div>
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.contextLimits')}</h3>
					<p class="text-xs text-text-muted">{$t('admin.contextLimitsDescription')}</p>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-max-context">{$t('admin.maxModelContextLabel')}</label>
							<input
								id="model-form-max-context"
								type="number"
								class="settings-input"
								bind:value={formMaxModelContext}
								placeholder={$t('admin.maxModelContextRequired')}
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-max-msg">{$t('admin.maxMessageLengthLabel')}</label>
							<input
								id="model-form-max-msg"
								type="number"
								class="settings-input"
								bind:value={formMaxMessageLength}
								placeholder=""
								min="0"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-max-tokens">{$t('admin.maxTokens')}</label>
							<input
								id="model-form-max-tokens"
								type="number"
								class="settings-input"
								bind:value={formMaxTokens}
								placeholder={$t('admin.maxTokensPlaceholder')}
								min="0"
							/>
						</div>
					</div>
				</div>

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.reasoningEffort')}</h3>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-reasoning">{$t('admin.reasoningEffort')}</label>
							<select
								id="model-form-reasoning"
								class="settings-input"
								bind:value={formReasoningEffort}
							>
								<option value="">{$t('admin.providerDefault')}</option>
								<option value="none">{$t('admin.none')}</option>
								<option value="minimal">{$t('admin.minimal')}</option>
								<option value="low">{$t('admin.low')}</option>
								<option value="medium">{$t('admin.medium')}</option>
								<option value="high">{$t('admin.high')}</option>
								<option value="max">{$t('admin.max')}</option>
								<option value="xhigh">{$t('admin.xHigh')}</option>
							</select>
						</div>
						<div>
							<label class="settings-label" for="model-form-thinking">{$t('admin.thinkingType')}</label>
							<select
								id="model-form-thinking"
								class="settings-input"
								bind:value={formThinkingType}
							>
								<option value="">{$t('admin.none')}</option>
								<option value="enabled">{$t('admin.enabled')}</option>
								<option value="disabled">{$t('admin.disabled')}</option>
							</select>
						</div>
					</div>
				</div>

				{#if !isCreate}
					<div class="mt-2 border-t border-border pt-3">
						<label class="settings-label" for="model-form-fallback">{$t('admin.modelFallbackLabel')}</label>
						<select
							id="model-form-fallback"
							class="settings-input"
							bind:value={formFallbackProviderModelId}
						>
							<option value="">{ $t('admin.modelFallbackNone') }</option>
							{#each fallbackOptions() as fallbackOption (fallbackOption.model.id)}
								<option
									value={fallbackOption.model.id}
									disabled={!fallbackOption.compatible}
								>
									{fallbackOptionLabel(fallbackOption.model)}
									{#if !fallbackOption.compatible}
										{" — "}
										{fallbackReasonLabel(
											fallbackOption.reason ?? {
												kind: "unparsed",
												message: $t("admin.modelFallbackReasonGeneric"),
											},
										)}
									{/if}
								</option>
							{/each}
						</select>
						{#if !hasCompatibleFallbackOption()}
							<p class="mt-1 text-xs text-danger">
								{$t('admin.modelFallbackNoCompatibleOptions')}
							</p>
						{/if}
					</div>
				{/if}

				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary">{$t('admin.pricing')}</h3>
					<p class="text-xs text-text-muted">{$t('admin.pricingPer1m')}</p>
					<div class="mt-3 grid gap-3 md:grid-cols-2">
						<div>
							<label class="settings-label" for="model-form-input-price">{$t('admin.inputPrice')}</label>
							<input
								id="model-form-input-price"
								type="number"
								class="settings-input"
								bind:value={formInputUsdPer1m}
								placeholder="0"
								min="0"
								step="0.000001"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-cached-input">{$t('admin.cachedInputPrice')}</label>
							<input
								id="model-form-cached-input"
								type="number"
								class="settings-input"
								bind:value={formCachedInputUsdPer1m}
								placeholder="0"
								min="0"
								step="0.000001"
							/>
						</div>
						<div>
							<label class="settings-label" for="model-form-output-price">{$t('admin.outputPrice')}</label>
							<input
								id="model-form-output-price"
								type="number"
								class="settings-input"
								bind:value={formOutputUsdPer1m}
								placeholder="0"
								min="0"
								step="0.000001"
							/>
						</div>
					</div>
					<details class="mt-3 rounded-md border border-border bg-surface-page px-3 py-2">
						<summary class="cursor-pointer text-xs font-medium text-text-secondary">
							{$t('admin.advancedCachePricing')}
						</summary>
						<p class="mt-2 text-xs text-text-muted">
							{$t('admin.advancedCachePricingDescription')}
						</p>
						<div class="mt-3">
							<label class="settings-label" for="model-form-cache-miss">{$t('admin.cacheWriteMissPrice')}</label>
							<input
								id="model-form-cache-miss"
								type="number"
								class="settings-input"
								bind:value={formCacheMissUsdPer1m}
								placeholder={$t('admin.cacheWriteMissPlaceholder')}
								min="0"
								step="0.000001"
							/>
						</div>
					</details>
				</div>

				{#if !isCreate && model?.id}
					<div class="mt-2 border-t border-border pt-3">
						<details
							class="rounded-md border border-border bg-surface-page px-3 py-2"
							ontoggle={handlePriceWindowsToggle}
						>
							<summary class="cursor-pointer text-sm font-medium text-text-primary">
								Time-slot pricing (optional)
							</summary>
							<p class="mt-2 text-xs text-text-muted">
								Optional UTC peak/off-peak windows that override the flat rates
								above while active. Leave a rate blank to inherit the flat rate.
								Times are UTC. Saved separately from the model.
							</p>

							{#if priceWindowsLoading}
								<p class="mt-3 text-xs text-text-muted">Loading…</p>
							{:else}
								<div class="mt-3 space-y-4">
									{#each priceWindowRows as _row, index (index)}
										<div class="rounded border border-border p-3">
											<div class="flex items-end gap-3">
												<div class="min-w-0 flex-1">
													<label class="settings-label" for={`price-window-label-${index}`}>Label</label>
													<input
														id={`price-window-label-${index}`}
														type="text"
														class="settings-input"
														bind:value={priceWindowRows[index].label}
														placeholder="off-peak"
													/>
												</div>
												<label
													class="mb-2 inline-flex cursor-pointer items-center gap-2 text-xs text-text-secondary"
												>
													<input
														type="checkbox"
														bind:checked={priceWindowRows[index].enabled}
													/>
													Enabled
												</label>
												<button
													type="button"
													class="btn-secondary mb-1 h-9 px-2 text-xs"
													aria-label={`Remove time-slot window ${index + 1}`}
													onclick={() => removePriceWindowRow(index)}
												>
													Remove
												</button>
											</div>

											<div class="mt-2">
												<span class="settings-label">Days (UTC)</span>
												<div class="flex flex-wrap gap-2">
													{#each DAY_LABELS as dayLabel, day (day)}
														<label class="inline-flex items-center gap-1 text-xs text-text-secondary">
															<input
																type="checkbox"
																aria-label={`Window ${index + 1} ${dayLabel}`}
																bind:checked={priceWindowRows[index].days[day]}
															/>
															{dayLabel}
														</label>
													{/each}
												</div>
											</div>

											<div class="mt-2 grid gap-3 md:grid-cols-2">
												<div>
													<label class="settings-label" for={`price-window-start-${index}`}>Start (UTC)</label>
													<input
														id={`price-window-start-${index}`}
														type="time"
														class="settings-input"
														bind:value={priceWindowRows[index].start}
													/>
												</div>
												<div>
													<label class="settings-label" for={`price-window-end-${index}`}>End (UTC)</label>
													<input
														id={`price-window-end-${index}`}
														type="time"
														class="settings-input"
														bind:value={priceWindowRows[index].end}
													/>
												</div>
											</div>

											<div class="mt-2 grid gap-3 md:grid-cols-2">
												<div>
													<label class="settings-label" for={`price-window-input-${index}`}>Input override ($/1M)</label>
													<input
														id={`price-window-input-${index}`}
														type="number"
														class="settings-input"
														bind:value={priceWindowRows[index].inputUsd}
														placeholder="inherit"
														min="0"
														step="0.000001"
													/>
												</div>
												<div>
													<label class="settings-label" for={`price-window-cached-${index}`}>Cached input override ($/1M)</label>
													<input
														id={`price-window-cached-${index}`}
														type="number"
														class="settings-input"
														bind:value={priceWindowRows[index].cachedInputUsd}
														placeholder="inherit"
														min="0"
														step="0.000001"
													/>
												</div>
												<div>
													<label class="settings-label" for={`price-window-miss-${index}`}>Cache miss override ($/1M)</label>
													<input
														id={`price-window-miss-${index}`}
														type="number"
														class="settings-input"
														bind:value={priceWindowRows[index].cacheMissUsd}
														placeholder="inherit"
														min="0"
														step="0.000001"
													/>
												</div>
												<div>
													<label class="settings-label" for={`price-window-output-${index}`}>Output override ($/1M)</label>
													<input
														id={`price-window-output-${index}`}
														type="number"
														class="settings-input"
														bind:value={priceWindowRows[index].outputUsd}
														placeholder="inherit"
														min="0"
														step="0.000001"
													/>
												</div>
											</div>
										</div>
									{/each}
								</div>

								<div class="mt-3 flex items-center gap-3">
									<button
										type="button"
										class="btn-secondary text-xs"
										onclick={addPriceWindowRow}
									>
										Add time-slot window
									</button>
									<button
										type="button"
										class="btn-primary text-xs"
										onclick={handleSavePriceWindows}
										disabled={priceWindowsSaving}
									>
										{priceWindowsSaving ? "Saving…" : "Save time-slot pricing"}
									</button>
									{#if priceWindowsSaved}
										<span class="text-xs text-text-muted">Saved.</span>
									{/if}
								</div>
							{/if}

							{#if priceWindowsError}
								<p class="mt-2 text-xs text-danger">{priceWindowsError}</p>
							{/if}
						</details>
					</div>
				{/if}

			</div>
		</div>
		<div class="modal-footer">
			{#if visibleError}
				<p class="text-sm text-danger">{visibleError}</p>
			{/if}
			<button class="btn-primary flex-1" onclick={handleSave} disabled={saving}>
				{saving ? $t('common.saving') : $t('admin.saveChanges')}
			</button>
			<button class="btn-secondary" onclick={onClose}>{$t('common.cancel')}</button>
		</div>
	</div>
</div>

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.45);
		backdrop-filter: blur(4px);
	}
	.modal-card {
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		width: min(36rem, calc(100vw - 2rem));
		max-height: calc(100vh - 4rem);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border-default);
	}
	.modal-title {
		font-size: 1.1rem;
		font-weight: 600;
	}
	.modal-close {
		font-size: 1.5rem;
		line-height: 1;
		padding: 0.25rem;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-muted);
	}
	.modal-body {
		padding: 1.25rem;
		overflow-y: auto;
	}
	.modal-footer {
		position: sticky;
		bottom: 0;
		z-index: 1;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		flex-shrink: 0;
		align-items: center;
		padding: 1rem 1.25rem;
		border-top: 1px solid var(--border-default);
		background: var(--surface-overlay);
	}
</style>
