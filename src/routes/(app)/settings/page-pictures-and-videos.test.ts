// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateUserPreferences } from "$lib/client/api/settings";
import type { ModelId } from "$lib/model-types";
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
		fetchAnalytics: vi.fn().mockResolvedValue(null),
		updateUserPreferences: vi.fn().mockResolvedValue(undefined),
	};
});

function renderPage(picturesAndVideosEnabled?: boolean) {
	cleanup();
	render(SettingsPage, {
		data: {
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
					...(picturesAndVideosEnabled === undefined
						? {}
						: { picturesAndVideosEnabled }),
				},
				profilePicture: null,
			},
			availableModels: [{ id: "model1" as ModelId, displayName: "Model 1" }],
			composerCommandRegistryEnabled: false,
		} as unknown as PageData,
		params: {},
		form: null,
	} as unknown as PageProps);
	return screen.getByRole("switch", { name: "Pictures and videos" });
}

describe("settings page: the Pictures and videos switch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("starts from the person's saved switch, on when nothing is saved", () => {
		expect(renderPage(false)).toHaveAttribute("aria-checked", "false");
		expect(renderPage(true)).toHaveAttribute("aria-checked", "true");
		expect(renderPage()).toHaveAttribute("aria-checked", "true");
	});

	it("saves the switch for the person and shows it at once", async () => {
		const toggle = renderPage(true);

		await fireEvent.click(toggle);

		expect(toggle).toHaveAttribute("aria-checked", "false");
		await waitFor(() =>
			expect(updateUserPreferences).toHaveBeenCalledWith({
				picturesAndVideosEnabled: false,
			}),
		);
	});

	it("puts the switch back when the save fails", async () => {
		vi.mocked(updateUserPreferences).mockRejectedValueOnce(
			new Error("Failed to update preferences"),
		);
		const toggle = renderPage(false);

		await fireEvent.click(toggle);

		await waitFor(() =>
			expect(toggle).toHaveAttribute("aria-checked", "false"),
		);
		expect(updateUserPreferences).toHaveBeenCalledWith({
			picturesAndVideosEnabled: true,
		});
		expect(toggle).not.toBeDisabled();
	});
});
