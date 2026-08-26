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

describe("settings page profile/password feedback goes through the shared toast (B3)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearToasts();
	});

	afterEach(() => {
		cleanup();
		clearToasts();
	});

	it("shows a success toast (no inline duplicate) when saving the profile succeeds", async () => {
		mockUpdateProfile.mockResolvedValue(undefined);
		renderSettingsPage();

		await fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({ type: "success" });
		expect(screen.queryByText("Profile updated.")).not.toBeInTheDocument();
	});

	it("shows a failure toast (no inline duplicate) when saving the profile fails", async () => {
		mockUpdateProfile.mockRejectedValue(new Error("Email already in use"));
		renderSettingsPage();

		await fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Email already in use",
		});
		expect(screen.queryByText("Email already in use")).not.toBeInTheDocument();
	});

	it("shows a success toast (no inline duplicate) when changing the password succeeds", async () => {
		mockUpdatePassword.mockResolvedValue(undefined);
		renderSettingsPage();

		await fillPasswordForm();
		await fireEvent.click(
			screen.getByRole("button", { name: "Change Password" }),
		);

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({ type: "success" });
		expect(screen.queryByText("Password changed.")).not.toBeInTheDocument();
	});

	it("shows a failure toast for a client-side mismatch without calling the server", async () => {
		renderSettingsPage();

		await fillPasswordForm({ next: "password-one", confirm: "password-two" });
		await fireEvent.click(
			screen.getByRole("button", { name: "Change Password" }),
		);

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

	it("shows a failure toast for a too-short password without calling the server", async () => {
		renderSettingsPage();

		await fillPasswordForm({ next: "short", confirm: "short" });
		await fireEvent.click(
			screen.getByRole("button", { name: "Change Password" }),
		);

		await waitFor(() => {
			expect(get(toasts)).toHaveLength(1);
		});
		expect(get(toasts)[0]).toMatchObject({
			type: "error",
			message: "Password must be at least 8 characters.",
		});
		expect(mockUpdatePassword).not.toHaveBeenCalled();
	});

	it("shows a failure toast (no inline duplicate) when the server rejects the password change", async () => {
		mockUpdatePassword.mockRejectedValue(
			new Error("Current password is incorrect"),
		);
		renderSettingsPage();

		await fillPasswordForm();
		await fireEvent.click(
			screen.getByRole("button", { name: "Change Password" }),
		);

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
});
