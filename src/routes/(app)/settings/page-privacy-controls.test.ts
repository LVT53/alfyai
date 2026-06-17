import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import {
	clearMemoryAndKnowledge,
	clearWorkspaceData,
	deleteAccount,
	downloadAccountDataArchive,
	saveBlobAsDownload,
} from "$lib/client/api/settings";
import type { ModelId } from "$lib/types";
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
		fetchHonchoHealth: vi.fn().mockResolvedValue(null),
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
			avatarId: null,
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
