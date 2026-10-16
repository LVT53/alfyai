/**
 * One identity card, one Save.
 *
 * The Profile tab used to carry two forms with two Save buttons and no
 * shared state: name+email in one card, the three password boxes in
 * another. The redesign folds them into a single card under a single
 * Save, with the password boxes explicitly optional — so "save my new
 * display name" and "save my new display name AND change my password"
 * are the same gesture.
 *
 * That makes "what does this Save actually do?" a real question with a
 * real answer, which is what lives here: pure functions the component
 * and the page both read, and the tests can exercise without a DOM.
 */

import { ApiError } from "$lib/client/api/http";
import type { I18nKey } from "$lib/i18n";
import { isSameEmailAddress } from "$lib/shared/email-address";
import { MIN_PASSWORD_LENGTH } from "$lib/shared/password-policy";
import { intlLocale } from "$lib/utils/locale";

export type AccountFormValues = {
	name: string;
	email: string;
	/**
	 * The password typed under the email box. That box exists only while the
	 * email differs from the saved one: changing the address asks for the
	 * account password, apart from the three boxes of the password change.
	 */
	emailPassword: string;
	/**
	 * The server answered that the email needs the account password although
	 * this page saw no change in the address (it was changed from another tab,
	 * so the saved address the page holds is stale). The box stays, and asks,
	 * until a save lands or the card is discarded.
	 */
	emailPasswordWanted?: boolean;
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
};

/** What the server last confirmed — what "dirty" is measured against. */
export type AccountBaseline = {
	name: string;
	email: string;
};

/** True when the name or email differs from what was last saved. */
export function isProfileDirty(
	values: Pick<AccountFormValues, "name" | "email">,
	baseline: AccountBaseline,
): boolean {
	return (
		values.name.trim() !== baseline.name.trim() ||
		isEmailChanged(values.email, baseline.email)
	);
}

/**
 * True when the email box no longer holds the saved address. This is what asks
 * for the account password: the box for it is shown exactly while this is true,
 * and the Save will not go without it.
 *
 * "The same address" is the server's reading (`isSameEmailAddress`, one
 * function for both): case and the spaces around it make no difference. The
 * server keeps the stored address for a change in letters alone and asks for no
 * password, so a card that asked for one would show an address the server does
 * not hold.
 */
export function isEmailChanged(email: string, savedEmail: string): boolean {
	return !isSameEmailAddress(email, savedEmail);
}

/**
 * True while the server's demand for the email's password stands: it made one
 * (`emailPasswordWanted`) and the card still has a name or address to save. With
 * nothing left to save there is nothing to ask the password for, so the box
 * goes, and comes back with the next change.
 */
export function isEmailPasswordWanted(
	values: Pick<AccountFormValues, "name" | "email" | "emailPasswordWanted">,
	baseline: AccountBaseline,
): boolean {
	return (
		values.emailPasswordWanted === true && isProfileDirty(values, baseline)
	);
}

/**
 * True while the email's password box is wanted: the address is a new one, or
 * the server has said it needs the password for it. The box is shown, the Save
 * will not go without its password, and the password is sent with the profile.
 */
export function needsEmailPassword(
	values: Pick<AccountFormValues, "name" | "email" | "emailPasswordWanted">,
	baseline: AccountBaseline,
): boolean {
	return (
		isEmailChanged(values.email, baseline.email) ||
		isEmailPasswordWanted(values, baseline)
	);
}

/**
 * Is this the server saying the email needs the account password (the profile
 * route's `password_required`)? When the page sent no password because it saw
 * no change, this is how it learns it was wrong, and shows the box.
 */
export function isEmailPasswordRequired(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.errorKey === "profileTab.emailNeedsPassword"
	);
}

/**
 * True once ANY password box has something in it. Touching one of the
 * three is the signal that the password is part of this Save; leaving
 * all three empty means it is not.
 */
export function isPasswordStarted(
	values: Pick<
		AccountFormValues,
		"currentPassword" | "newPassword" | "confirmPassword"
	>,
): boolean {
	return (
		values.currentPassword.length > 0 ||
		values.newPassword.length > 0 ||
		values.confirmPassword.length > 0
	);
}

/** True when this Save would change anything at all. */
export function isAccountDirty(
	values: AccountFormValues,
	baseline: AccountBaseline,
): boolean {
	return isProfileDirty(values, baseline) || isPasswordStarted(values);
}

export type AccountSavePlan =
	| {
			ok: true;
			/** Send name/email to the server. */
			saveProfile: boolean;
			/** Send the password change to the server. */
			savePassword: boolean;
			/** Which "it worked" line to show for this particular Save. */
			successKey: I18nKey;
	  }
	| {
			ok: false;
			errorKey: I18nKey;
			/** The numbers the message names, for `$t`, when it names any. */
			errorParams?: { count: number };
	  };

/**
 * Decide what one press of Save does, or why it cannot run.
 *
 * Validation is deliberately ordered so the message names the box the
 * user still has to fill rather than the rule they broke two boxes ago.
 */
export function planAccountSave(
	values: AccountFormValues,
	baseline: AccountBaseline,
): AccountSavePlan {
	const profileDirty = isProfileDirty(values, baseline);
	const passwordStarted = isPasswordStarted(values);

	if (!profileDirty && !passwordStarted) {
		return { ok: false, errorKey: "profileTab.nothingToSave" };
	}

	// First, because the email box is the first box on the card: changing the
	// address needs the account password, apart from the password change's own.
	if (
		needsEmailPassword(values, baseline) &&
		values.emailPassword.length === 0
	) {
		return { ok: false, errorKey: "profileTab.emailNeedsPassword" };
	}

	if (passwordStarted) {
		if (values.currentPassword.length === 0) {
			return { ok: false, errorKey: "profileTab.passwordNeedsCurrent" };
		}
		if (values.newPassword.length === 0) {
			return { ok: false, errorKey: "profileTab.passwordNeedsNew" };
		}
		if (values.newPassword !== values.confirmPassword) {
			return { ok: false, errorKey: "settings_passwordMismatch" };
		}
		if (values.newPassword.length < MIN_PASSWORD_LENGTH) {
			return {
				ok: false,
				errorKey: "settings_passwordTooShort",
				errorParams: { count: MIN_PASSWORD_LENGTH },
			};
		}
	}

	const successKey: I18nKey =
		profileDirty && passwordStarted
			? "profileTab.accountUpdated"
			: passwordStarted
				? "settings_passwordChanged"
				: "settings_profileUpdated";

	return {
		ok: true,
		saveProfile: profileDirty,
		savePassword: passwordStarted,
		successKey,
	};
}

/**
 * "Saved 12:02" — the wall-clock time the card last went clean, in the
 * UI language rather than the browser's, matching the sentence around it.
 */
export function formatSavedAt(when: Date, locale: string): string {
	return when.toLocaleTimeString(intlLocale(locale), {
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Compact token counts for the Your Activity summary: 18_400_000 → "18.4M".
 * Kept here rather than in the analytics component because the summary
 * card is Profile's, and the full analytics view is another surface.
 */
export function formatCompactCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000_000) return `${trimZero(value / 1_000_000_000)}B`;
	if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
	if (value >= 10_000) return `${trimZero(value / 1_000)}K`;
	return String(Math.round(value));
}

function trimZero(value: number): string {
	const fixed = value.toFixed(1);
	return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
