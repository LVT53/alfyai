// The one place the app turns its two-value language setting into a BCP 47
// tag for Intl.
//
// The app speaks "en" and "hu". Intl wants a locale, and the bare subtags
// would technically work, but "en" resolves to en-US conventions — 9/17/2026,
// commas for thousands — which is not what this product's English is. "en-GB"
// is, and has been since the connections surfaces picked it. So the mapping
// is a decision, and a decision that existed in three places at once:
// status-grammar.ts had it, the account form had a second copy inline, and
// everywhere else simply hardcoded "en-US" or "en-GB" and got it wrong for
// Hungarian users. One function now, imported by both the client (with
// `$uiLanguage`) and the server (with a generated report's own language).
//
// Deliberately free of Svelte and of $lib/i18n: the PDF and HTML report
// renderers need this inside node, where importing a store module to format
// a number would be absurd.

/** The languages the app ships. Mirrors `UiLanguage` in $lib/stores/settings
 *  and `SupportedLanguage` on the server, without importing either. */
export type FormattingLanguage = "en" | "hu";

const LOCALE_BY_LANGUAGE: Record<FormattingLanguage, string> = {
	en: "en-GB",
	hu: "hu-HU",
};

/**
 * BCP 47 tag for a language the app knows, falling back to English for
 * anything it does not (an unset preference, a legacy row, a `string` that
 * has not been narrowed). Never throws — a formatter is not a place to fail.
 */
export function intlLocale(language: string | null | undefined): string {
	return language === "hu" ? LOCALE_BY_LANGUAGE.hu : LOCALE_BY_LANGUAGE.en;
}
