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
import type { ModelId } from "$lib/model-types";
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
			// Profile content is rendered (the Profile tab is the default).
			expect(
				screen.getByText("Your account", {
					selector: "h2.settings-card-title",
				}),
			).toBeInTheDocument();
		});

		it("shows the Your Activity card in Profile, with the full analytics one click away", async () => {
			renderPage("user");

			// Profile redesign: the tab carries a Your Activity SUMMARY card and
			// opens the full personal-analytics surface on demand, rather than
			// printing the whole thing inline. The data still loads on first
			// Profile entry (the page's $effect calls loadAnalytics).
			expect(
				screen.getByText("Your Activity", {
					selector: "h2.settings-card-title",
				}),
			).toBeInTheDocument();

			await fireEvent.click(screen.getByTestId("activity-open"));
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

// ────────────────────────────────────────────────────────────────────────────
// The Profile tab's two automatic fetches used to be gated on their own RESULT
// — "no analytics yet", "no styles yet" — and both write the state the gate
// reads. So every answer that was not a success re-armed the condition that
// started the request the instant it settled, and the $effect fired the next
// one. A failing analytics endpoint and, far more commonly, a workspace with
// no conversation styles configured, both turned the default settings screen
// into an unbounded request loop that ran for as long as the tab stayed open.
//
// Each test caps its mock so a regression fails on the count instead of
// hanging the runner: after the cap the mock starts answering successfully,
// which is what a looping gate needs to stop.
// ────────────────────────────────────────────────────────────────────────────
describe("Profile tab loads each thing once, not in a loop", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("asks for analytics once when the endpoint keeps failing", async () => {
		const { fetchAnalytics } = await import("$lib/client/api/settings");
		const mock = fetchAnalytics as unknown as ReturnType<typeof vi.fn>;
		let calls = 0;
		mock.mockImplementation(async () => {
			calls += 1;
			if (calls > 6) return analyticsFixture;
			throw new Error("analytics is down");
		});

		renderPage("user");
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(calls).toBe(1);
		mock.mockResolvedValue(analyticsFixture);
	});

	it("asks for conversation styles once when the list comes back empty", async () => {
		const { fetchPublicPersonalityProfiles } = await import(
			"$lib/client/api/admin"
		);
		const mock = fetchPublicPersonalityProfiles as unknown as ReturnType<
			typeof vi.fn
		>;
		let calls = 0;
		mock.mockImplementation(async () => {
			calls += 1;
			if (calls > 6) return [{ id: "p1", name: "P", description: "d" }];
			return [];
		});

		renderPage("user");
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(calls).toBe(1);
		mock.mockResolvedValue([]);
	});
});
