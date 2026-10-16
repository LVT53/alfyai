import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { ApiError } from "$lib/client/api/http";
import {
	clearMemoryAndKnowledge,
	clearWorkspaceData,
	deleteAccount,
	downloadAccountDataArchive,
	saveBlobAsDownload,
} from "$lib/client/api/settings";
import { t } from "$lib/i18n";
import type { ModelId } from "$lib/model-types";
import { uiLanguage } from "$lib/stores/settings";
import SettingsPage from "./+page.svelte";
import type { PageData, PageProps } from "./$types";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
}));

vi.mock("$lib/client/api/admin", () => ({
	fetchPublicPersonalityProfiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("$lib/client/api/settings", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/client/api/settings")
	>("$lib/client/api/settings");
	return {
		...actual,
		clearMemoryAndKnowledge: vi.fn().mockResolvedValue(undefined),
		clearWorkspaceData: vi.fn().mockResolvedValue(undefined),
		deleteAccount: vi.fn().mockResolvedValue(undefined),
		downloadAccountDataArchive: vi.fn().mockResolvedValue({
			blob: new Blob(["zip"], { type: "application/zip" }),
			filename: "AlfyAI Data Archive 2026-06-15.zip",
		}),
		fetchAnalytics: vi.fn().mockResolvedValue(null),
		saveBlobAsDownload: vi.fn(),
		updateUserPreferences: vi.fn().mockResolvedValue(undefined),
	};
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

async function submitPrivacyAction(buttonName: string) {
	cleanup();
	render(SettingsPage, {
		data: pageData as unknown as PageData,
		params: {},
		form: null,
	} as unknown as PageProps);
	await fireEvent.click(screen.getByRole("button", { name: buttonName }));
	await fireEvent.input(screen.getByLabelText("Password"), {
		target: { value: "pw" },
	});
	const confirmButtons = screen.getAllByRole("button", { name: buttonName });
	const confirmButton = confirmButtons.at(-1);
	if (!confirmButton) throw new Error("Confirm button not found");
	await fireEvent.click(confirmButton);
}

describe("settings page privacy controls", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("downloads an account archive from the password-confirmed modal", async () => {
		await submitPrivacyAction("Download my data");

		await waitFor(() => {
			expect(downloadAccountDataArchive).toHaveBeenCalledWith("pw");
		});
		expect(saveBlobAsDownload).toHaveBeenCalledWith(
			expect.any(Blob),
			"AlfyAI Data Archive 2026-06-15.zip",
		);
		expect(goto).not.toHaveBeenCalled();
	});

	it("clears memory and knowledge without signing out", async () => {
		await submitPrivacyAction("Clear memory and knowledge");

		await waitFor(() => {
			expect(clearMemoryAndKnowledge).toHaveBeenCalledWith("pw");
		});
		expect(goto).not.toHaveBeenCalled();
	});

	it("signs out after clearing workspace data or deleting the account", async () => {
		await submitPrivacyAction("Clear workspace data");

		await waitFor(() => {
			expect(clearWorkspaceData).toHaveBeenCalledWith("pw");
		});
		expect(goto).toHaveBeenCalledWith("/login");

		vi.clearAllMocks();
		await submitPrivacyAction("Delete account");

		await waitFor(() => {
			expect(deleteAccount).toHaveBeenCalledWith("pw");
		});
		expect(goto).toHaveBeenCalledWith("/login");
	});
});

// The four actions answer 429 with the Settings throttle's key once wrong
// passwords have used up the account's budget. The modal reads that key in the
// reader's language, as the Profile card does for the email change, instead of
// printing the server's English sentence.
describe("settings page privacy controls: a password the limiter turned away", () => {
	const throttled = () =>
		new ApiError(
			"Too many failed attempts. Please wait a moment and try again.",
			{
				errorKey: "profileTab.currentPasswordTooManyAttempts",
				status: 429,
			},
		);

	const SENTENCE = {
		en: "Too many wrong passwords. Please wait a moment and try again.",
		hu: "Túl sok hibás jelszó. Várj egy pillanatot, majd próbáld újra.",
	} as const;

	const ACTIONS = [
		["archive", "settings_downloadMyData", downloadAccountDataArchive],
		[
			"clear memory",
			"settings_clearMemoryAndKnowledge",
			clearMemoryAndKnowledge,
		],
		["clear workspace", "settings_clearWorkspaceData", clearWorkspaceData],
		["delete account", "settings_deleteAccountPrivacy", deleteAccount],
	] as const;

	async function openModal(language: "en" | "hu", titleKey: string) {
		uiLanguage.set(language);
		const translate = get(t);
		cleanup();
		render(SettingsPage, {
			data: pageData as unknown as PageData,
			params: {},
			form: null,
		} as unknown as PageProps);
		const title = translate(titleKey as Parameters<typeof translate>[0]);
		await fireEvent.click(screen.getByRole("button", { name: title }));
		await fireEvent.input(
			screen.getByLabelText(translate("settings_passwordLabel")),
			{ target: { value: "pw" } },
		);
		return { translate, title };
	}

	afterEach(() => {
		uiLanguage.set("en");
		cleanup();
	});

	for (const language of ["en", "hu"] as const) {
		it.each(
			ACTIONS,
		)(`reads the throttle of %s in the reader's language (${language})`, async (_name, titleKey, call) => {
			vi.mocked(call).mockRejectedValueOnce(throttled());
			const { title } = await openModal(language, titleKey);

			const confirm = screen.getAllByRole("button", { name: title }).at(-1);
			if (!confirm) throw new Error("Confirm button not found");
			await fireEvent.click(confirm);

			expect(
				(await screen.findAllByText(SENTENCE[language])).length,
			).toBeGreaterThan(0);
			expect(
				screen.queryByText(/Too many failed attempts/),
			).not.toBeInTheDocument();
		});
	}

	it("reads it the same way when Download my data is pressed inside a destructive dialog", async () => {
		vi.mocked(downloadAccountDataArchive).mockRejectedValueOnce(throttled());
		const { translate } = await openModal(
			"hu",
			"settings_deleteAccountPrivacy",
		);

		// The Profile tab behind the dialog has a Download my data row of its
		// own; the dialog's button is the last one in the document.
		const download = screen
			.getAllByRole("button", { name: translate("settings_downloadMyData") })
			.at(-1);
		if (!download) throw new Error("Download button not found");
		await fireEvent.click(download);

		expect((await screen.findAllByText(SENTENCE.hu)).length).toBeGreaterThan(0);
	});
});
