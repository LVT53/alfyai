import { writable } from "svelte/store";
import { updateUserPreferences } from "$lib/client/api/settings";
import type { ModelId, UserModelPreference } from "$lib/model-types";
import {
	type ReasoningDepth,
	thinkingModeToReasoningDepth,
} from "$lib/reasoning-depth-types";
import { canUseStorage, persist, read } from "./_local-storage";

export type TitleLanguage = "auto" | "en" | "hu";
export type UiLanguage = "en" | "hu";
export type { ModelId };

export const selectedModel = writable<ModelId>("model1");
const titleLanguage = writable<TitleLanguage>("auto");
export const uiLanguage = writable<UiLanguage>("en");
export const selectedReasoningDepth = writable<ReasoningDepth>("auto");

const SELECTED_MODEL_KEY = "selectedModel";
const TITLE_LANGUAGE_KEY = "titleLanguage";
const UI_LANGUAGE_KEY = "uiLanguage";
const REASONING_DEPTH_KEY = "reasoningDepth";
const LEGACY_THINKING_MODE_KEY = "thinkingMode";

export function initSettings(serverPrefs?: {
	model?: ModelId;
	titleLanguage?: TitleLanguage;
	uiLanguage?: UiLanguage;
}): void {
	if (!canUseStorage()) {
		return;
	}

	if (serverPrefs?.model) {
		selectedModel.set(serverPrefs.model);
		persist(SELECTED_MODEL_KEY, serverPrefs.model);
	} else {
		const storedModel = read<ModelId | null>(
			SELECTED_MODEL_KEY,
			null,
			(v): v is ModelId =>
				v === "model1" ||
				v === "model2" ||
				(typeof v === "string" && v.startsWith("provider:")),
		);
		if (storedModel) {
			selectedModel.set(storedModel);
		}
	}

	if (serverPrefs?.titleLanguage !== undefined) {
		titleLanguage.set(serverPrefs.titleLanguage);
		persist(TITLE_LANGUAGE_KEY, serverPrefs.titleLanguage);
	} else {
		const storedTitleLang = read<TitleLanguage | null>(
			TITLE_LANGUAGE_KEY,
			null,
			(v): v is TitleLanguage => v === "auto" || v === "en" || v === "hu",
		);
		if (storedTitleLang) {
			titleLanguage.set(storedTitleLang);
		}
	}

	if (serverPrefs?.uiLanguage !== undefined) {
		uiLanguage.set(serverPrefs.uiLanguage);
		persist(UI_LANGUAGE_KEY, serverPrefs.uiLanguage);
	} else {
		const storedUiLanguage = read<UiLanguage | null>(
			UI_LANGUAGE_KEY,
			null,
			(v): v is UiLanguage => v === "en" || v === "hu",
		);
		if (storedUiLanguage) {
			uiLanguage.set(storedUiLanguage);
		}
	}

	const storedReasoningDepth = read<ReasoningDepth | null>(
		REASONING_DEPTH_KEY,
		null,
		(v): v is ReasoningDepth => v === "auto" || v === "max" || v === "off",
	);
	if (storedReasoningDepth) {
		selectedReasoningDepth.set(storedReasoningDepth);
	} else {
		const legacyThinkingMode = read<"auto" | "on" | "off">(
			LEGACY_THINKING_MODE_KEY,
			"auto",
			(v): v is "auto" | "on" | "off" =>
				v === "auto" || v === "on" || v === "off",
		);
		selectedReasoningDepth.set(
			thinkingModeToReasoningDepth(legacyThinkingMode),
		);
	}
}

export function setSelectedModel(model: ModelId): void {
	selectedModel.set(model);
	persist(SELECTED_MODEL_KEY, model);
}

export function setSelectedReasoningDepth(depth: ReasoningDepth): void {
	selectedReasoningDepth.set(depth);
	persist(REASONING_DEPTH_KEY, depth);
}

export async function setSelectedModelAndSync(model: ModelId): Promise<void> {
	setSelectedModel(model);
	try {
		await updateUserPreferences({ preferredModel: model });
	} catch {
		// Non-fatal: local preference already applied
	}
}

export async function setModelPreferenceAndSync(
	preference: UserModelPreference,
	effectiveModel: ModelId,
): Promise<void> {
	setSelectedModel(effectiveModel);
	try {
		await updateUserPreferences({ preferredModel: preference });
	} catch {
		// Non-fatal: local effective model already applied
	}
}

export async function setTitleLanguageAndSync(
	lang: TitleLanguage,
): Promise<void> {
	titleLanguage.set(lang);
	persist(TITLE_LANGUAGE_KEY, lang);
	try {
		await updateUserPreferences({ titleLanguage: lang });
	} catch {
		// Non-fatal
	}
}

export async function setUiLanguageAndSync(lang: UiLanguage): Promise<void> {
	uiLanguage.set(lang);
	persist(UI_LANGUAGE_KEY, lang);
	try {
		await updateUserPreferences({ uiLanguage: lang });
	} catch {
		// Non-fatal
	}
}
