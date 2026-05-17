import { writable } from 'svelte/store';
import { updateUserPreferences } from '$lib/client/api/settings';
import type { ModelId, ThinkingMode, UserModelPreference } from '$lib/types';
import { canUseStorage, persist, read } from './_local-storage';

export type TitleLanguage = 'auto' | 'en' | 'hu';
export type UiLanguage = 'en' | 'hu';
export type { ModelId };

export const selectedModel = writable<ModelId>('model1');
export const titleLanguage = writable<TitleLanguage>('auto');
export const uiLanguage = writable<UiLanguage>('en');
export const selectedThinkingMode = writable<ThinkingMode>('auto');

const SELECTED_MODEL_KEY = 'selectedModel';
const TITLE_LANGUAGE_KEY = 'titleLanguage';
const UI_LANGUAGE_KEY = 'uiLanguage';
const THINKING_MODE_KEY = 'thinkingMode';

export function initSettings(serverPrefs?: { model?: ModelId; titleLanguage?: TitleLanguage; uiLanguage?: UiLanguage }): void {
	if (!canUseStorage()) {
		return;
	}

	if (serverPrefs?.model) {
		selectedModel.set(serverPrefs.model);
		persist(SELECTED_MODEL_KEY, serverPrefs.model);
	} else {
		const storedModel = read<ModelId>(SELECTED_MODEL_KEY, null as ModelId | null, (v): v is ModelId =>
			v === 'model1' || v === 'model2' || (typeof v === 'string' && v.startsWith('provider:'))
		);
		if (storedModel) {
			selectedModel.set(storedModel);
		}
	}

	if (serverPrefs?.titleLanguage !== undefined) {
		titleLanguage.set(serverPrefs.titleLanguage);
		persist(TITLE_LANGUAGE_KEY, serverPrefs.titleLanguage);
	} else {
		const storedTitleLang = read<TitleLanguage>(TITLE_LANGUAGE_KEY, null as TitleLanguage | null, (v): v is TitleLanguage =>
			v === 'auto' || v === 'en' || v === 'hu'
		);
		if (storedTitleLang) {
			titleLanguage.set(storedTitleLang);
		}
	}

	if (serverPrefs?.uiLanguage !== undefined) {
		uiLanguage.set(serverPrefs.uiLanguage);
		persist(UI_LANGUAGE_KEY, serverPrefs.uiLanguage);
	} else {
		const storedUiLanguage = read<UiLanguage>(UI_LANGUAGE_KEY, null as UiLanguage | null, (v): v is UiLanguage =>
			v === 'en' || v === 'hu'
		);
		if (storedUiLanguage) {
			uiLanguage.set(storedUiLanguage);
		}
	}

	const storedThinkingMode = read<ThinkingMode>(
		THINKING_MODE_KEY,
		'auto',
		(v): v is ThinkingMode => v === 'auto' || v === 'on' || v === 'off'
	);
	selectedThinkingMode.set(storedThinkingMode);
}

export function setSelectedModel(model: ModelId): void {
	selectedModel.set(model);
	persist(SELECTED_MODEL_KEY, model);
}

export function setSelectedThinkingMode(mode: ThinkingMode): void {
	selectedThinkingMode.set(mode);
	persist(THINKING_MODE_KEY, mode);
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

export async function setTitleLanguageAndSync(lang: TitleLanguage): Promise<void> {
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
