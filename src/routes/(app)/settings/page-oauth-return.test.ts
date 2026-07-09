import { render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelId } from "$lib/types";
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
	};
});

vi.mock("$lib/client/api/connections", () => ({
	fetchConnections: vi.fn().mockResolvedValue([]),
	updateConnection: vi.fn(),
	disconnectConnection: vi.fn(),
}));

import { fetchConnections } from "$lib/client/api/connections";

const mockFetchConnections = fetchConnections as ReturnType<typeof vi.fn>;

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

function renderAt(url: string) {
	window.history.pushState(null, "", url);
	return render(SettingsPage, {
		data: pageData as unknown as PageData,
		params: {},
		form: null,
	} as unknown as PageProps);
}

describe("settings page OAuth return handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchConnections.mockResolvedValue([]);
		window.history.pushState(null, "", "/settings");
	});

	it("switches to the Connections tab, refetches, shows success, and clears the query params on ?connected=", async () => {
		renderAt("/settings?section=connections&connected=google");

		await waitFor(() => {
			expect(screen.getByText("Connected to Google.")).toBeInTheDocument();
		});
		await waitFor(() => {
			expect(mockFetchConnections).toHaveBeenCalled();
		});
		expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		expect(window.location.search).toBe("");
	});

	it("switches to the Connections tab and shows a translated error on ?error=", async () => {
		renderAt("/settings?section=connections&error=google_oauth_denied");

		await waitFor(() => {
			expect(
				screen.getByText(
					"Couldn't connect: You declined the Google permission request.",
				),
			).toBeInTheDocument();
		});
		expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		expect(window.location.search).toBe("");
	});

	it("falls back to the generic reason for an unrecognized error code", async () => {
		renderAt("/settings?section=connections&error=something_weird");

		await waitFor(() => {
			expect(
				screen.getByText("Couldn't connect: Please try again."),
			).toBeInTheDocument();
		});
	});

	it("clears only the params it consumed, preserving unrelated query params", async () => {
		renderAt(
			"/settings?debug=1&section=connections&connected=google&ref=email",
		);

		await waitFor(() => {
			expect(screen.getByText("Connected to Google.")).toBeInTheDocument();
		});

		const params = new URLSearchParams(window.location.search);
		expect(params.get("section")).toBeNull();
		expect(params.get("connected")).toBeNull();
		expect(params.get("error")).toBeNull();
		expect(params.get("debug")).toBe("1");
		expect(params.get("ref")).toBe("email");
	});

	it("does nothing special for a bare ?section=connections (existing deep link)", async () => {
		renderAt("/settings?section=connections");

		await waitFor(() => {
			expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		});
		expect(screen.queryByText("Connected to Google.")).not.toBeInTheDocument();
	});
});
