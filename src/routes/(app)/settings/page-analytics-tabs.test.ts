import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto, invalidate } from "$app/navigation";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import type { ModelId } from "$lib/types";
import SettingsPage from "./+page.svelte";
import type { PageData, PageProps } from "./$types";

// vi.hoisted runs before vi.mock factories so the fixture can be referenced
// safely inside the hoisted mock below (avoids TDZ on top-level consts).
const { analyticsFixture } = vi.hoisted(() => {
	const fixture = {
		availableMonths: ["2026-06"],
		personal: {
			byModel: [],
			byProvider: [],
			totalMessages: 5,
			avgGenerationMs: 1000,
			totalTokens: 500,
			promptTokens: 400,
			cachedInputTokens: 0,
			outputTokens: 100,
			reasoningTokens: 0,
			totalCostUsd: 1,
			favoriteModel: "model1",
			chatCount: 2,
		},
		system: {
			byModel: [],
			byProvider: [],
			totalMessages: 50,
			avgGenerationMs: 1000,
			totalTokens: 5000,
			promptTokens: 4000,
			cachedInputTokens: 0,
			outputTokens: 1000,
			reasoningTokens: 0,
			totalCostUsd: 10,
			totalUsers: 3,
			totalConversations: 9,
		},
		perUser: [],
		systemAvailableMonths: ["2026-06"],
	};
	return { analyticsFixture: fixture as unknown as AnalyticsResponse };
});

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
}));

vi.mock("$lib/client/api/admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/client/api/admin")>();
	return {
		...actual,
		fetchAdminUsers: vi.fn().mockResolvedValue([]),
		fetchPublicPersonalityProfiles: vi.fn().mockResolvedValue([]),
		fetchPersonalityProfiles: vi.fn().mockResolvedValue([]),
		fetchProviderList: vi.fn().mockResolvedValue([]),
		fetchProviderModels: vi.fn().mockResolvedValue([]),
	};
});

vi.mock("$lib/client/api/settings", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/settings")>();
	return {
		...actual,
		fetchAnalytics: vi.fn().mockResolvedValue(analyticsFixture),
		updateUserPreferences: vi.fn().mockResolvedValue(undefined),
	};
});

function buildPageData(role: "user" | "admin") {
	return {
		userSettings: {
			id: role === "admin" ? "admin-1" : "user-1",
			email: role === "admin" ? "admin@example.com" : "user@example.com",
			name: role === "admin" ? "Admin" : "User",
			role,
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
}

function renderPage(role: "user" | "admin") {
	cleanup();
	render(SettingsPage, {
		data: buildPageData(role) as unknown as PageData,
		params: {},
		form: null,
	} as unknown as PageProps);
}

describe("settings page analytics merge (ADR-0043 slice 18c)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe("normal user", () => {
		it("does NOT show an Analytics tab", () => {
			renderPage("user");

			// No Analytics tab in the tab list (and the single-tab switcher is
			// hidden for normal users, so there is no tablist at all).
			expect(
				screen.queryByRole("tab", { name: "Analytics" }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("tab", { name: "Administration" }),
			).not.toBeInTheDocument();
			// Profile content is rendered (the Profile tab is the default and,
			// being the only tab, the switcher is omitted but the content shows).
			expect(screen.getByText("Account")).toBeInTheDocument();
		});

		it("shows the Your Activity section in Profile with personal analytics", async () => {
			renderPage("user");

			// The personal analytics data loads asynchronously after first Profile
			// entry (the page's $effect calls loadAnalytics), so the stats settle
			// after a tick. The section label is always present.
			expect(screen.getByText("Your Activity")).toBeInTheDocument();
			await waitFor(() =>
				expect(screen.getByText("Messages sent")).toBeInTheDocument(),
			);
		});
	});

	describe("admin user", () => {
		it("does NOT show a standalone Analytics tab (system analytics is under Administration)", () => {
			renderPage("admin");

			expect(
				screen.queryByRole("tab", { name: "Analytics" }),
			).not.toBeInTheDocument();
			expect(screen.getByRole("tab", { name: "Profile" })).toBeInTheDocument();
			expect(
				screen.getByRole("tab", { name: "Administration" }),
			).toBeInTheDocument();
		});

		it("shows system analytics as a sub-pane under Administration", async () => {
			renderPage("admin");

			await fireEvent.click(
				screen.getByRole("tab", { name: "Administration" }),
			);

			// The admin pane hosts a "System analytics" sub-pane button.
			expect(
				screen.getByRole("button", { name: "System analytics" }),
			).toBeInTheDocument();
		});
	});

	// Sanity: the goto mock from $app/navigation is wired (page imports it).
	it("exposes the navigation mock for the page", () => {
		expect(typeof goto).toBe("function");
		expect(typeof invalidate).toBe("function");
	});
});
