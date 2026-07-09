import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
		fetchAnalytics: vi.fn().mockResolvedValue(null),
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

// ADR 0044 Decision 5: the privacy policy has ONE surface, the public
// /privacy route — no in-app modal (an early build added one; the product
// owner asked to remove it). The Data & Privacy entry row is a plain link.
describe("settings page — Privacy policy entry row links to /privacy (ADR 0044 Decision 5)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders the entry row as a link to the public /privacy route, with no in-app modal", () => {
		render(SettingsPage, {
			data: pageData as unknown as PageData,
			params: {},
			form: null,
		} as unknown as PageProps);

		const row = screen.getByLabelText("Privacy policy");
		expect(row.tagName).toBe("A");
		expect(row).toHaveAttribute("href", "/privacy");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
