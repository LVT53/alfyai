import { derived } from "svelte/store";
import { uiLanguage } from "$lib/stores/settings";
import chatDict from "./chat";
import commonDict from "./common";
import knowledgeDict from "./knowledge";
import settingsDict from "./settings";
import skillsDict from "./skills";

/**
 * Key Naming Convention
 * --------------------
 * All i18n keys use dot-separated hierarchical naming:
 *   {group}.{subgroup}.{specificName}
 *
 * Examples:
 *   sidebar.newChat        -> sidebar New Chat button
 *   analytics.stats.messagesSent  -> analytics stats label
 *   settings.avatar        -> settings Avatar section
 *   login.welcomeBack      -> login page welcome text
 *   common.confirm         -> shared confirm button
 *   common.cancel          -> shared cancel button
 *
 * Group categories:
 *   - sidebar, header, layout (navigation/layout)
 *   - chat, messageArea, messageInput (chat components)
 *   - knowledge, filePreview (knowledge components)
 *   - settings, settingsProfile, settingsAnalytics, settingsAdministration (settings)
 *   - admin (admin panel)
 *   - analytics (analytics tab)
 *   - login (login page)
 *   - common (shared UI components like ConfirmDialog, ErrorMessage)
 *   - fileProduction (job-backed produced-file components)
 *   - pageTitle (HTML <title> tags)
 *
 * All keys must exist in BOTH en and hu dictionaries.
 */

const dictionary = {
	en: {
		...commonDict.en,
		...chatDict.en,
		...knowledgeDict.en,
		...settingsDict.en,
		...skillsDict.en,
	},
	hu: {
		...commonDict.hu,
		...chatDict.hu,
		...knowledgeDict.hu,
		...settingsDict.hu,
		...skillsDict.hu,
	},
} as const;

export type I18nKey = keyof typeof dictionary.en;

export const t = derived(uiLanguage, ($uiLanguage) => {
	const lang = dictionary[$uiLanguage] ?? dictionary.en;
	return (key: I18nKey, params?: Record<string, string | number>) => {
		let value: string = lang[key] ?? dictionary.en[key] ?? key;
		for (const [name, replacement] of Object.entries(params ?? {})) {
			// Minimal ICU-style plural: {name, plural, one {...} other {...}}.
			const count = Number(replacement);
			value = value.replace(
				new RegExp(
					`\\{${name}, plural, one \\{([^{}]*)\\} other \\{([^{}]*)\\}\\}`,
					"g",
				),
				(_, one: string, other: string) => (count === 1 ? one : other),
			);
			value = value.replaceAll(`{${name}}`, String(replacement));
		}
		return value;
	};
});
