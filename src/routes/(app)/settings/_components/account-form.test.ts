import { describe, expect, it } from "vitest";
import {
	type AccountBaseline,
	type AccountFormValues,
	formatCompactCount,
	formatSavedAt,
	isAccountDirty,
	isPasswordStarted,
	isProfileDirty,
	planAccountSave,
} from "./account-form";

const baseline: AccountBaseline = {
	name: "Admin User",
	email: "admin@local",
};

function values(overrides: Partial<AccountFormValues> = {}): AccountFormValues {
	return {
		name: baseline.name,
		email: baseline.email,
		currentPassword: "",
		newPassword: "",
		confirmPassword: "",
		...overrides,
	};
}

describe("isProfileDirty", () => {
	it("is false when name and email match what was last saved", () => {
		expect(isProfileDirty(values(), baseline)).toBe(false);
	});

	it("ignores surrounding whitespace on both sides of the comparison", () => {
		expect(isProfileDirty(values({ name: "  Admin User  " }), baseline)).toBe(
			false,
		);
	});

	it("is true when the name changed", () => {
		expect(isProfileDirty(values({ name: "Admin" }), baseline)).toBe(true);
	});

	it("is true when the email changed", () => {
		expect(isProfileDirty(values({ email: "other@local" }), baseline)).toBe(
			true,
		);
	});
});

describe("isPasswordStarted", () => {
	it("is false while all three boxes are empty", () => {
		expect(isPasswordStarted(values())).toBe(false);
	});

	it.each([
		["currentPassword" as const],
		["newPassword" as const],
		["confirmPassword" as const],
	])("is true once %s has anything in it", (field) => {
		expect(isPasswordStarted(values({ [field]: "x" }))).toBe(true);
	});
});

describe("isAccountDirty", () => {
	it("is false for an untouched card", () => {
		expect(isAccountDirty(values(), baseline)).toBe(false);
	});

	it("is true for a changed name alone", () => {
		expect(isAccountDirty(values({ name: "New" }), baseline)).toBe(true);
	});

	it("is true for a started password alone", () => {
		expect(isAccountDirty(values({ newPassword: "x" }), baseline)).toBe(true);
	});
});

describe("planAccountSave — one Save, optional password", () => {
	it("refuses a Save that would change nothing", () => {
		expect(planAccountSave(values(), baseline)).toEqual({
			ok: false,
			errorKey: "profileTab.nothingToSave",
		});
	});

	it("saves ONLY the profile when the password boxes are left empty", () => {
		expect(planAccountSave(values({ name: "New Name" }), baseline)).toEqual({
			ok: true,
			saveProfile: true,
			savePassword: false,
			successKey: "settings_profileUpdated",
		});
	});

	it("saves ONLY the password when the name and email are untouched", () => {
		const plan = planAccountSave(
			values({
				currentPassword: "old-password",
				newPassword: "new-password-123",
				confirmPassword: "new-password-123",
			}),
			baseline,
		);

		expect(plan).toEqual({
			ok: true,
			saveProfile: false,
			savePassword: true,
			successKey: "settings_passwordChanged",
		});
	});

	it("saves BOTH under the same Save, and says so", () => {
		const plan = planAccountSave(
			values({
				email: "new@local",
				currentPassword: "old-password",
				newPassword: "new-password-123",
				confirmPassword: "new-password-123",
			}),
			baseline,
		);

		expect(plan).toEqual({
			ok: true,
			saveProfile: true,
			savePassword: true,
			successKey: "profileTab.accountUpdated",
		});
	});

	it("asks for the current password before changing it", () => {
		expect(
			planAccountSave(values({ newPassword: "new-password-123" }), baseline),
		).toEqual({ ok: false, errorKey: "profileTab.passwordNeedsCurrent" });
	});

	it("asks for a new password when only the current one was typed", () => {
		expect(
			planAccountSave(values({ currentPassword: "old" }), baseline),
		).toEqual({ ok: false, errorKey: "profileTab.passwordNeedsNew" });
	});

	it("rejects a mismatched confirmation", () => {
		expect(
			planAccountSave(
				values({
					currentPassword: "old",
					newPassword: "password-one",
					confirmPassword: "password-two",
				}),
				baseline,
			),
		).toEqual({ ok: false, errorKey: "settings_passwordMismatch" });
	});

	it("rejects a password under 8 characters", () => {
		expect(
			planAccountSave(
				values({
					currentPassword: "old",
					newPassword: "short",
					confirmPassword: "short",
				}),
				baseline,
			),
		).toEqual({ ok: false, errorKey: "settings_passwordTooShort" });
	});

	it("reports the mismatch before the length, so the message names the box in front of you", () => {
		expect(
			planAccountSave(
				values({
					currentPassword: "old",
					newPassword: "short",
					confirmPassword: "other",
				}),
				baseline,
			),
		).toEqual({ ok: false, errorKey: "settings_passwordMismatch" });
	});

	it("does not let a valid profile change smuggle an invalid password through", () => {
		expect(
			planAccountSave(
				values({
					name: "New Name",
					currentPassword: "old",
					newPassword: "short",
					confirmPassword: "short",
				}),
				baseline,
			),
		).toEqual({ ok: false, errorKey: "settings_passwordTooShort" });
	});
});

describe("formatSavedAt", () => {
	it("renders a 24-hour wall-clock time", () => {
		const label = formatSavedAt(new Date(2026, 8, 11, 12, 2), "en");
		expect(label).toMatch(/^12[.:]02$/);
	});

	it("follows the UI language rather than the browser's", () => {
		const label = formatSavedAt(new Date(2026, 8, 11, 9, 5), "hu");
		expect(label).toMatch(/9[.:]05/);
	});
});

describe("formatCompactCount", () => {
	it.each([
		[0, "0"],
		[-5, "0"],
		[42, "42"],
		[9999, "9999"],
		[12_800, "12.8K"],
		[1_000_000, "1M"],
		[18_400_000, "18.4M"],
		[2_500_000_000, "2.5B"],
	])("formats %s as %s", (input, expected) => {
		expect(formatCompactCount(input)).toBe(expected);
	});
});
