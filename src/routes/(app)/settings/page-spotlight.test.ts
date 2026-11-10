import { render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayoutForSpotlight } from "$lib/actions/spotlight.test-helpers";
import type { ModelId } from "$lib/model-types";
import {
	pendingSpotlight,
	requestSpotlight,
	SPOTLIGHT_REQUEST_TTL_MS,
	spotlightRequest,
} from "$lib/stores/spotlight";
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

const ringing = () => [...document.querySelectorAll(".spotlight-ring")];

// The Feature Guide's Show me goes to Settings with a request waiting. Profile
// is the tab the page opens on, so its controls ring where they are drawn;
// Connections is a tab of its own, which the page has to bring forward before
// there is anything to ring.
describe("settings page — the guide's Show me", () => {
	let restoreLayout: () => void = () => undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchConnections.mockResolvedValue([]);
		window.history.pushState(null, "", "/settings");
		// The ring waits one animation frame; the test steps it by hand.
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		restoreLayout = stubLayoutForSpotlight();
		spotlightRequest.set(null);
	});

	afterEach(() => {
		restoreLayout();
		vi.useRealTimers();
		spotlightRequest.set(null);
		window.history.pushState(null, "", "/");
	});

	it("opens the Connections tab when Show me asks for connected accounts", async () => {
		requestSpotlight("settings.connections");

		renderAt("/settings");

		await waitFor(() => {
			expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		});
		// The tab was brought forward and its own marker took the request: the
		// page only read it.
		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(ringing()).toEqual([screen.getByTestId("connections-heading")]);
		// And it is the Connections tab that is selected.
		expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.queryByTestId("two-step-row")).toBeNull();
	});

	it("opens on Profile for every other request, and rings that control", async () => {
		requestSpotlight("settings.data");

		renderAt("/settings");
		await tick();

		expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.queryByTestId("connections-empty")).toBeNull();
		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(ringing()).toEqual([
			document.getElementById("settings-section-data-privacy"),
		]);
	});

	it("stays on Profile for a request that no control on the page answers to", async () => {
		// Nothing on Profile takes this one, so it is still waiting when the page
		// has mounted and looks: only connected accounts bring the other tab.
		requestSpotlight("knowledge.memory");

		renderAt("/settings");
		await tick();

		expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.queryByTestId("connections-empty")).toBeNull();
		expect(pendingSpotlight(get(spotlightRequest))).toBe("knowledge.memory");
	});

	it("opens on Profile when nobody asked for anything", async () => {
		renderAt("/settings");
		await tick();

		expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		vi.advanceTimersToNextFrame();
		expect(ringing()).toEqual([]);
	});

	it("does not open the Connections tab for a request that has lapsed", async () => {
		requestSpotlight(
			"settings.connections",
			Date.now() - SPOTLIGHT_REQUEST_TTL_MS - 1,
		);

		renderAt("/settings");
		await tick();

		expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.queryByTestId("connections-empty")).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(ringing()).toEqual([]);
	});

	it("does not take the request itself", async () => {
		// A Connections tab with no layout (it is not on screen) leaves the
		// request where it is, and the page that brought the tab forward
		// does not take it in its place.
		const withLayout = Element.prototype.getClientRects;
		Element.prototype.getClientRects = function (this: Element) {
			return this.closest('[data-testid="connections-heading"]')
				? ([] as unknown as DOMRectList)
				: withLayout.call(this);
		};
		requestSpotlight("settings.connections");

		renderAt("/settings");
		await waitFor(() => {
			expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		});

		expect(pendingSpotlight(get(spotlightRequest))).toBe(
			"settings.connections",
		);
		vi.advanceTimersToNextFrame();
		expect(ringing()).toEqual([]);
	});

	// The page's own deep links are older than the guide and stay as they were.
	it("keeps the ?section=connections deep link, and rings nothing for it", async () => {
		renderAt("/settings?section=connections");

		await waitFor(() => {
			expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		});
		vi.advanceTimersToNextFrame();
		expect(ringing()).toEqual([]);
	});

	it("keeps the ?section=memory deep link and its highlight", async () => {
		// The memory row is rung by the page itself, a frame after it mounts,
		// with `settings-card-highlight` for two seconds.
		renderAt("/settings?section=memory");
		await tick();

		vi.advanceTimersToNextFrame();
		const card = document.getElementById("settings-memory-card");
		expect(card).not.toBeNull();
		expect(card).toHaveClass("settings-card-highlight");
		expect(card).not.toHaveClass("spotlight-ring");
	});
});
