import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelId } from "$lib/model-types";
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
	await fireEvent.input(screen.getByLabelText("Current password"), {
		target: { value: current },
	});
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
		mockUpdateProfile.mockResolvedValue(undefined);
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
		mockUpdatePassword.mockResolvedValue(undefined);
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
		mockUpdateProfile.mockResolvedValue(undefined);
		mockUpdatePassword.mockResolvedValue(undefined);
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
		mockUpdateProfile.mockResolvedValue(undefined);
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

		await fillPasswordForm({ next: "short", confirm: "short" });
		await save();

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Password must be at least 8 characters.",
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
		mockUpdatePassword.mockResolvedValue(undefined);
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
		mockUpdateProfile.mockResolvedValue(undefined);
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
		mockUpdateProfile.mockResolvedValue(undefined);
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
		mockUpdatePassword.mockResolvedValue(undefined);
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
