import { ApiError } from "$lib/client/api/http";
import type { I18nKey } from "$lib/i18n";

/**
 * The server's two-step refusals Settings can translate. An allowlist, like
 * the login page's: a response body cannot choose an arbitrary dictionary
 * entry. Anything else is shown as the server's own (English) sentence.
 */
const LOCALIZED_TWO_STEP_ERROR_KEYS: readonly string[] = [
	"profileTab.twoStepWrongCode",
	"profileTab.twoStepTooManyAttempts",
	"profileTab.twoStepUnavailable",
	"profileTab.twoStepNotOn",
	"profileTab.twoStepNoSetup",
	"profileTab.twoStepAlreadyOn",
	"profileTab.twoStepCodeRequired",
	"profileTab.twoStepAuthenticatorCodeRequired",
	"profileTab.twoStepOneCodeOnly",
	"profileTab.currentPasswordWrong",
	"profileTab.currentPasswordTooManyAttempts",
];

export function twoStepErrorMessage(
	error: unknown,
	translate: (key: I18nKey) => string,
): string {
	if (error instanceof ApiError && error.errorKey) {
		if (LOCALIZED_TWO_STEP_ERROR_KEYS.includes(error.errorKey)) {
			const translated = translate(error.errorKey as I18nKey);
			if (translated !== error.errorKey) return translated;
		}
	}
	return error instanceof Error
		? error.message
		: translate("login.unexpectedError");
}

/**
 * A typed code or backup code, as the request body wants it. Six digits are an
 * authenticator code; anything else is treated as a backup code, whose format
 * the server normalizes.
 */
export function codeOrBackupInput(value: string): {
	code?: string;
	backupCode?: string;
} {
	const trimmed = value.trim();
	return /^\d{6}$/.test(trimmed) ? { code: trimmed } : { backupCode: trimmed };
}
