import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";
import type { ModelId } from "$lib/model-types";
import { MIN_PASSWORD_LENGTH } from "$lib/shared/password-policy";
import { clearToasts, toasts } from "$lib/stores/toast";
import SettingsPage from "./+page.svelte";
import type { PageData, PageProps } from "./$types";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
}));

vi.mock("$lib/client/api/admin", () => ({
	fetchAdminUsers: vi.fn().mockResolvedValue([]),
	fetchPublicPersonalityProfiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("$lib/client/api/settings", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/settings")>();
	return {
		...actual,
		fetchAnalytics: vi.fn().mockResolvedValue(null),
		updateUserPreferences: vi.fn().mockResolvedValue(undefined),
		updateProfile: vi.fn(),
		updatePassword: vi.fn(),
	};
});

vi.mock("$lib/client/api/connections", () => ({
	fetchConnections: vi.fn().mockResolvedValue([]),
	updateConnection: vi.fn(),
	disconnectConnection: vi.fn(),
}));

import { updatePassword, updateProfile } from "$lib/client/api/settings";

const mockUpdateProfile = updateProfile as ReturnType<typeof vi.fn>;
const mockUpdatePassword = updatePassword as ReturnType<typeof vi.fn>;

// What the client call hands back when the server took the change and there
// was no other device to sign out.
const PASSWORD_CHANGED = { signedOutOtherDevices: 0 };

// What the server answers a profile save, and what the card shows afterwards:
// the name trimmed (blank is none) and the address trimmed and lowercased, as
// the server stores them. The card shows this, not what was typed.
const serverAnswer = async (params: {
	name: string | null;
	email: string;
}) => ({
	name: params.name?.trim() || null,
	email: params.email.trim().toLowerCase(),
});

const pageData = {
	userSettings: {
		id: "user-1",
		email: "user@example.com",
		name: "User",
		role: "user" as const,
		preferences: {
			preferredModel: null,
			effectiveModel: "model1" as ModelId,
			systemDefaultModel: "model1" as ModelId,
			theme: "system" as const,
			titleLanguage: "auto" as const,
			uiLanguage: "en" as const,
			preferredPersonalityId: null,
		},
		profilePicture: null,
	},
	availableModels: [{ id: "model1" as ModelId, displayName: "Model 1" }],
	composerCommandRegistryEnabled: false,
};

function renderSettingsPage() {
	return render(SettingsPage, {
		data: pageData as unknown as PageData,
		params: {},
		form: null,
	} as unknown as PageProps);
}

const save = () => fireEvent.click(screen.getByTestId("account-save"));

async function renameTo(value: string) {
	await fireEvent.input(screen.getByRole("textbox", { name: "Display Name" }), {
		target: { value },
	});
}

async function fillPasswordForm({
	current = "old-password",
	next = "new-password-123",
	confirm = next,
}: {
	current?: string;
	next?: string;
	confirm?: string;
} = {}) {
	// By id: with the email changed there is a second "Current password" box,
	// the one under the email, and this is the password change's own.
	await fireEvent.input(
		document.getElementById("current-pw") as HTMLInputElement,
		{
			target: { value: current },
		},
	);
	await fireEvent.input(screen.getByLabelText("New password"), {
		target: { value: next },
	});
	await fireEvent.input(screen.getByLabelText("Confirm new password"), {
		target: { value: confirm },
	});
}

// The identity card now carries ONE Save for name, email and the optional
// password change. These tests pin what that single press actually does —
// and that its feedback still goes through the shared toast (B3) rather
// than an inline message duplicated next to the form.
describe("settings page — one Save for the identity card", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearToasts();
	});

	afterEach(() => {
		cleanup();
		clearToasts();
	});

	it("refuses to call the server when nothing on the card changed", async () => {
		renderSettingsPage();

		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Nothing to save yet.",
		});
		expect(mockUpdateProfile).not.toHaveBeenCalled();
		expect(mockUpdatePassword).not.toHaveBeenCalled();
	});

	it("saves the profile alone when the password boxes are left empty", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		renderSettingsPage();

		await renameTo("Renamed User");
		await save();

		await waitFor(() => {
			expect(mockUpdateProfile).toHaveBeenCalledWith({
				name: "Renamed User",
				email: "user@example.com",
			});
		});
		expect(mockUpdatePassword).not.toHaveBeenCalled();
		expect(get(toasts)[0]).toMatchObject({ type: "success" });
		expect(screen.queryByText("Profile updated.")).not.toBeInTheDocument();
	});

	it("changes the password alone when the name and email are untouched", async () => {
		mockUpdatePassword.mockResolvedValue(PASSWORD_CHANGED);
		renderSettingsPage();

		await fillPasswordForm();
		await save();

		await waitFor(() => {
			expect(mockUpdatePassword).toHaveBeenCalledWith({
				currentPassword: "old-password",
				newPassword: "new-password-123",
			});
		});
		expect(mockUpdateProfile).not.toHaveBeenCalled();
		expect(get(toasts)[0]).toMatchObject({ type: "success" });
		expect(screen.queryByText("Password changed.")).not.toBeInTheDocument();
	});

	it("does both under the same press, and says so once", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		mockUpdatePassword.mockResolvedValue(PASSWORD_CHANGED);
		renderSettingsPage();

		await renameTo("Renamed User");
		await fillPasswordForm();
		await save();

		await waitFor(() => {
			expect(mockUpdatePassword).toHaveBeenCalledOnce();
		});
		expect(mockUpdateProfile).toHaveBeenCalledOnce();
		expect(get(toasts)).toHaveLength(1);
		expect(get(toasts)[0]).toMatchObject({
			type: "success",
			message: "Profile and password updated.",
		});
	});

	it("stamps the card with the time it last went clean", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		renderSettingsPage();

		expect(screen.queryByTestId("account-saved-at")).toBeNull();

		await renameTo("Renamed User");
		await save();

		await waitFor(() =>
			expect(screen.getByTestId("account-saved-at")).toHaveTextContent(
				/^Saved \d{2}[.:]\d{2}$/,
			),
		);
	});

	it("Discard puts the card back to what the server last confirmed", async () => {
		renderSettingsPage();

		const nameField = screen.getByRole("textbox", {
			name: "Display Name",
		}) as HTMLInputElement;
		const discard = screen.getByTestId("account-discard");
		expect(discard).toBeDisabled();

		await renameTo("Renamed User");
		await fillPasswordForm();
		expect(discard).not.toBeDisabled();

		await fireEvent.click(discard);

		expect(nameField.value).toBe("User");
		expect(
			(screen.getByLabelText("Current password") as HTMLInputElement).value,
		).toBe("");
		expect(mockUpdateProfile).not.toHaveBeenCalled();
	});

	it("reports a failed profile save through the toast, with no inline duplicate", async () => {
		mockUpdateProfile.mockRejectedValue(new Error("Email already in use"));
		renderSettingsPage();

		await renameTo("Renamed User");
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Email already in use",
		});
		expect(screen.queryByText("Email already in use")).not.toBeInTheDocument();
	});

	it("reports a mismatch without calling the server", async () => {
		renderSettingsPage();

		await fillPasswordForm({ next: "password-one", confirm: "password-two" });
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "New passwords do not match.",
		});
		expect(mockUpdatePassword).not.toHaveBeenCalled();
		expect(
			screen.queryByText("New passwords do not match."),
		).not.toBeInTheDocument();
	});

	it("reports a too-short password without calling the server", async () => {
		renderSettingsPage();

		const oneShort = "x".repeat(MIN_PASSWORD_LENGTH - 1);
		await fillPasswordForm({ next: oneShort, confirm: oneShort });
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		// Names the minimum from the one number, not from a copy of it in the text.
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
		});
		expect(mockUpdatePassword).not.toHaveBeenCalled();
	});

	it("asks for the current password before it will change one, without calling the server", async () => {
		renderSettingsPage();

		await fillPasswordForm({ current: "" });
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Enter your current password to change it.",
		});
		expect(mockUpdatePassword).not.toHaveBeenCalled();
	});

	it("does not send the profile half when the password half is invalid", async () => {
		renderSettingsPage();

		await renameTo("Renamed User");
		await fillPasswordForm({ next: "short", confirm: "short" });
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(mockUpdateProfile).not.toHaveBeenCalled();
		expect(mockUpdatePassword).not.toHaveBeenCalled();
	});

	it("empties the password boxes once the server has taken the change", async () => {
		mockUpdatePassword.mockResolvedValue(PASSWORD_CHANGED);
		renderSettingsPage();

		await fillPasswordForm();
		await save();

		await waitFor(() => expect(mockUpdatePassword).toHaveBeenCalledOnce());
		for (const label of [
			"Current password",
			"New password",
			"Confirm new password",
		]) {
			await waitFor(() =>
				expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(
					"",
				),
			);
		}
	});

	it("keeps the printed name and email in step with what was saved", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		renderSettingsPage();

		// The card prints the identity above the boxes that edit it. Before the
		// save it is the loaded one; after it, the saved one — `data.userSettings`
		// is never re-fetched, so reading it there would leave the old name
		// standing over an input that already says something else.
		expect(screen.getByText("User")).toBeInTheDocument();

		await renameTo("Renamed User");
		expect(screen.getByText("User")).toBeInTheDocument();

		await save();

		await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(screen.getByText("Renamed User")).toBeInTheDocument(),
		);
	});

	it("reports a server-rejected password change through the toast", async () => {
		mockUpdatePassword.mockRejectedValue(
			new Error("Current password is incorrect"),
		);
		renderSettingsPage();

		await fillPasswordForm();
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Current password is incorrect",
		});
		expect(
			screen.queryByText("Current password is incorrect"),
		).not.toBeInTheDocument();
	});

	// One Save can still be half a save: the two calls go to two endpoints and
	// the second one can be refused after the first has already landed. What
	// the card must not do is claim the whole press worked. It reports the half
	// that failed, keeps the password boxes filled so the retry is one word of
	// typing, and — because the name really did save — sends only the password
	// the second time.
	it("reports the half that failed and offers the retry, when the profile saved but the password did not", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		mockUpdatePassword.mockRejectedValue(
			new Error("Current password is incorrect"),
		);
		renderSettingsPage();

		await renameTo("Renamed User");
		await fillPasswordForm();
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Current password is incorrect",
		});
		// Both halves were attempted, in that order.
		expect(mockUpdateProfile).toHaveBeenCalledTimes(1);
		expect(mockUpdatePassword).toHaveBeenCalledTimes(1);
		// No "Saved hh:mm": the press did not finish.
		expect(screen.queryByTestId("account-saved-at")).toBeNull();
		// The name that DID save is what the card now prints above the boxes.
		expect(screen.getByText("Renamed User")).toBeInTheDocument();
		// The password boxes still hold what was typed, so the retry is the one
		// box that was wrong.
		expect(
			(screen.getByLabelText("New password") as HTMLInputElement).value,
		).toBe("new-password-123");

		// Second press: the profile half is clean now, so only the password
		// goes — the name is not written to the server twice.
		clearToasts();
		mockUpdatePassword.mockResolvedValue(PASSWORD_CHANGED);
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "success",
			message: "Password changed.",
		});
		expect(mockUpdateProfile).toHaveBeenCalledTimes(1);
		expect(mockUpdatePassword).toHaveBeenCalledTimes(2);
	});
});

const EMAIL_PASSWORD_BOX = "email-change-password";

async function changeEmailTo(value: string) {
	await fireEvent.input(
		screen.getByRole("textbox", { name: "Email Address" }),
		{
			target: { value },
		},
	);
}

function emailInput(): HTMLInputElement {
	return screen.getByRole("textbox", {
		name: "Email Address",
	}) as HTMLInputElement;
}

function emailPasswordInput(): HTMLInputElement {
	return within(screen.getByTestId(EMAIL_PASSWORD_BOX)).getByLabelText(
		"Current password",
	) as HTMLInputElement;
}

// Changing the email asks for the account password, in a box that exists only
// while the email differs from the saved address. A rename asks for nothing.
describe("settings page — changing the email asks for the password", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearToasts();
	});

	afterEach(() => {
		cleanup();
		clearToasts();
	});

	it("shows the password box only while the email differs from the saved one", async () => {
		renderSettingsPage();

		expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();

		await changeEmailTo("new@example.com");
		expect(screen.getByTestId(EMAIL_PASSWORD_BOX)).toBeInTheDocument();

		await changeEmailTo("user@example.com");
		expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
	});

	it("names the box 'Current password', like the password change's own", async () => {
		renderSettingsPage();

		await changeEmailTo("new@example.com");

		expect(screen.getAllByLabelText("Current password")).toHaveLength(2);
		expect(emailPasswordInput()).toHaveAttribute(
			"autocomplete",
			"current-password",
		);
	});

	it("will not call the server for an email change without the password", async () => {
		renderSettingsPage();

		await changeEmailTo("new@example.com");
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Enter your current password to change your email.",
		});
		expect(mockUpdateProfile).not.toHaveBeenCalled();
	});

	it("sends the password along with the new address, and puts the box away", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		renderSettingsPage();

		await changeEmailTo("new@example.com");
		await fireEvent.input(emailPasswordInput(), {
			target: { value: "old-password" },
		});
		await save();

		await waitFor(() => {
			expect(mockUpdateProfile).toHaveBeenCalledWith({
				name: "User",
				email: "new@example.com",
				currentPassword: "old-password",
			});
		});
		expect(mockUpdatePassword).not.toHaveBeenCalled();
		expect(get(toasts)[0]).toMatchObject({
			type: "success",
			message: "Profile updated.",
		});
		// The address is the saved one now, so the box is gone and the next
		// change starts with an empty one.
		await waitFor(() => {
			expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
		});
		await changeEmailTo("again@example.com");
		expect(emailPasswordInput().value).toBe("");
	});

	it("sends no password for a rename, even with the email still the saved one", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		renderSettingsPage();

		await renameTo("Renamed User");
		await save();

		await waitFor(() => {
			expect(mockUpdateProfile).toHaveBeenCalledWith({
				name: "Renamed User",
				email: "user@example.com",
			});
		});
	});

	// The server lowercases an address and does not call the same address in
	// other letters a change. The card reads it the same way, and after a save it
	// shows what the server answered.
	it("treats the same address in other letters as no change: no box, nothing to save", async () => {
		renderSettingsPage();

		await changeEmailTo("USER@Example.com");

		expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
		await save();
		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Nothing to save yet.",
		});
		expect(mockUpdateProfile).not.toHaveBeenCalled();
	});

	it("shows the address and name the server answered after a save, not the ones typed", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		renderSettingsPage();

		await renameTo("  Renamed User ");
		await changeEmailTo("  New@Example.COM ");
		await fireEvent.input(emailPasswordInput(), {
			target: { value: "old-password" },
		});
		await save();

		await waitFor(() => {
			expect(mockUpdateProfile).toHaveBeenCalledOnce();
		});
		await waitFor(() => {
			expect(emailInput().value).toBe("new@example.com");
		});
		expect(
			(
				screen.getByRole("textbox", {
					name: "Display Name",
				}) as HTMLInputElement
			).value,
		).toBe("Renamed User");
		// The identity printed above the boxes is the saved one, too.
		expect(screen.getByText("new@example.com")).toBeInTheDocument();
		expect(screen.getByText("Renamed User")).toBeInTheDocument();
	});

	it("shows the address the server holds when a rename carried the same address in other letters", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		renderSettingsPage();

		await renameTo("Renamed User");
		await changeEmailTo("USER@EXAMPLE.COM");
		expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
		await save();

		await waitFor(() => {
			expect(mockUpdateProfile).toHaveBeenCalledWith({
				name: "Renamed User",
				email: "USER@EXAMPLE.COM",
			});
		});
		// Not the capitals that were typed: the address the card prints and the
		// box holds is the one the server answered, which it kept as it was.
		await waitFor(() => {
			expect(emailInput().value).toBe("user@example.com");
		});
		expect(screen.getByText("user@example.com")).toBeInTheDocument();
		expect(screen.queryByText("USER@EXAMPLE.COM")).toBeNull();
	});

	// The card sends no password for an address it sees as unchanged. If the
	// server disagrees (the email was changed in another tab, so the address
	// this page holds is not the stored one any more), its answer is that the
	// email needs the password. The page then shows the box that answer is about,
	// instead of an error about a box that is not there.
	it("shows the password box when the server says the email needs one, though the page saw no change", async () => {
		mockUpdateProfile.mockRejectedValueOnce(
			new ApiError("password_required", {
				errorKey: "profileTab.emailNeedsPassword",
				status: 400,
			}),
		);
		renderSettingsPage();

		await renameTo("Renamed User");
		expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
		await save();

		await waitFor(() => {
			expect(screen.getByTestId(EMAIL_PASSWORD_BOX)).toBeInTheDocument();
		});
		expect(get(toasts)).toHaveLength(1);
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Enter your current password to change your email.",
		});

		// The box is asked for like any other: no call without it, and the retry
		// carries it.
		clearToasts();
		await save();
		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(mockUpdateProfile).toHaveBeenCalledTimes(1);

		mockUpdateProfile.mockImplementation(serverAnswer);
		await fireEvent.input(emailPasswordInput(), {
			target: { value: "old-password" },
		});
		await save();

		await waitFor(() => {
			expect(mockUpdateProfile).toHaveBeenLastCalledWith({
				name: "Renamed User",
				email: "user@example.com",
				currentPassword: "old-password",
			});
		});
		// Taken: the box goes away again, with its password.
		await waitFor(() => {
			expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
		});
	});

	it("shows no box for a refusal that is not the email asking for its password", async () => {
		mockUpdateProfile.mockRejectedValueOnce(
			new ApiError("Email already in use", { status: 409 }),
		);
		renderSettingsPage();

		await renameTo("Renamed User");
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
	});

	it("Discard takes the box away that the server asked for", async () => {
		mockUpdateProfile.mockRejectedValueOnce(
			new ApiError("password_required", {
				errorKey: "profileTab.emailNeedsPassword",
				status: 400,
			}),
		);
		renderSettingsPage();

		await renameTo("Renamed User");
		await save();
		await waitFor(() => {
			expect(screen.getByTestId(EMAIL_PASSWORD_BOX)).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByTestId("account-discard"));

		expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
	});

	it("keeps the password box filled when the server says it was wrong, so the retry is one retyping", async () => {
		mockUpdateProfile.mockRejectedValue(
			new ApiError("Current password is incorrect", {
				errorKey: "profileTab.currentPasswordWrong",
				status: 401,
			}),
		);
		renderSettingsPage();

		await changeEmailTo("new@example.com");
		await fireEvent.input(emailPasswordInput(), {
			target: { value: "typo-password" },
		});
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Current password is incorrect.",
		});
		// Not saved: the address is still pending and so is its box.
		expect(emailPasswordInput().value).toBe("typo-password");
		expect(screen.queryByTestId("account-saved-at")).toBeNull();
	});

	it("reads a refusal in the reader's language when the server sent a key the dictionary knows", async () => {
		mockUpdateProfile.mockRejectedValue(
			new ApiError(
				"Too many failed attempts. Please wait a moment and try again.",
				{
					errorKey: "profileTab.currentPasswordTooManyAttempts",
					status: 429,
				},
			),
		);
		renderSettingsPage();

		await changeEmailTo("new@example.com");
		await fireEvent.input(emailPasswordInput(), {
			target: { value: "old-password" },
		});
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Too many wrong passwords. Please wait a moment and try again.",
		});
	});

	it("shows the server's own sentence for a refusal it has no key for", async () => {
		mockUpdateProfile.mockRejectedValue(
			new ApiError("Email already in use", { status: 409 }),
		);
		renderSettingsPage();

		await changeEmailTo("taken@example.com");
		await fireEvent.input(emailPasswordInput(), {
			target: { value: "old-password" },
		});
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Email already in use",
		});
	});

	it("Discard puts the address back and empties the box", async () => {
		renderSettingsPage();

		await changeEmailTo("new@example.com");
		await fireEvent.input(emailPasswordInput(), {
			target: { value: "old-password" },
		});
		await fireEvent.click(screen.getByTestId("account-discard"));

		expect(
			(
				screen.getByRole("textbox", {
					name: "Email Address",
				}) as HTMLInputElement
			).value,
		).toBe("user@example.com");
		expect(screen.queryByTestId(EMAIL_PASSWORD_BOX)).toBeNull();
		await changeEmailTo("new@example.com");
		expect(emailPasswordInput().value).toBe("");
	});

	it("does both under one Save: the new address with its password, then the password change", async () => {
		mockUpdateProfile.mockImplementation(serverAnswer);
		mockUpdatePassword.mockResolvedValue(PASSWORD_CHANGED);
		renderSettingsPage();

		await changeEmailTo("new@example.com");
		await fireEvent.input(emailPasswordInput(), {
			target: { value: "old-password" },
		});
		await fillPasswordForm();
		await save();

		await waitFor(() => {
			expect(mockUpdatePassword).toHaveBeenCalledOnce();
		});
		expect(mockUpdateProfile).toHaveBeenCalledWith({
			name: "User",
			email: "new@example.com",
			currentPassword: "old-password",
		});
		expect(mockUpdatePassword).toHaveBeenCalledWith({
			currentPassword: "old-password",
			newPassword: "new-password-123",
		});
		expect(get(toasts)).toHaveLength(1);
		expect(get(toasts)[0]).toMatchObject({
			type: "success",
			message: "Profile and password updated.",
		});
	});
});

// A password change signs the person out on their other devices. The server
// says how many; the card names it, so a phone that quietly stopped working is
// not a surprise.
describe("settings page — the other devices a password change signs out", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearToasts();
	});

	afterEach(() => {
		cleanup();
		clearToasts();
	});

	it("says so under the Save row once the server has signed other devices out", async () => {
		mockUpdatePassword.mockResolvedValue({ signedOutOtherDevices: 2 });
		renderSettingsPage();

		expect(screen.queryByTestId("account-signed-out-others")).toBeNull();

		await fillPasswordForm();
		await save();

		await waitFor(() =>
			expect(screen.getByTestId("account-signed-out-others")).toHaveTextContent(
				"You were signed out on your other devices.",
			),
		);
	});

	it("says nothing when this was the only device", async () => {
		mockUpdatePassword.mockResolvedValue(PASSWORD_CHANGED);
		renderSettingsPage();

		await fillPasswordForm();
		await save();

		await waitFor(() => expect(mockUpdatePassword).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(get(toasts)[0]).toMatchObject({ type: "success" }),
		);
		expect(screen.queryByTestId("account-signed-out-others")).toBeNull();
	});

	it("puts the line away with the next Save", async () => {
		mockUpdatePassword.mockResolvedValue({ signedOutOtherDevices: 1 });
		mockUpdateProfile.mockImplementation(serverAnswer);
		renderSettingsPage();

		await fillPasswordForm();
		await save();
		await waitFor(() =>
			expect(
				screen.getByTestId("account-signed-out-others"),
			).toBeInTheDocument(),
		);

		// The next press only renames: no password went, so nobody was signed out.
		await renameTo("Renamed User");
		await save();

		await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(screen.queryByTestId("account-signed-out-others")).toBeNull(),
		);
	});

	it("puts the line away when the card is discarded", async () => {
		mockUpdatePassword.mockResolvedValue({ signedOutOtherDevices: 3 });
		renderSettingsPage();

		await fillPasswordForm();
		await save();
		await waitFor(() =>
			expect(
				screen.getByTestId("account-signed-out-others"),
			).toBeInTheDocument(),
		);

		await renameTo("Renamed User");
		await fireEvent.click(screen.getByTestId("account-discard"));

		expect(screen.queryByTestId("account-signed-out-others")).toBeNull();
	});
});
