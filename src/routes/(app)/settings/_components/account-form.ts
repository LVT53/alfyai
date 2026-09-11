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

import type { I18nKey } from "$lib/i18n";

/** Minimum length the server enforces; mirrored here so the user hears it first. */
export const MIN_PASSWORD_LENGTH = 8;

export type AccountFormValues = {
	name: string;
	email: string;
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
		values.email.trim() !== baseline.email.trim()
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
	| { ok: false; errorKey: I18nKey };

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
			return { ok: false, errorKey: "settings_passwordTooShort" };
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
	return when.toLocaleTimeString(locale === "hu" ? "hu-HU" : "en-GB", {
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
