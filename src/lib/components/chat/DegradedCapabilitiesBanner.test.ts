import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";

vi.mock("$lib/client/api/system", () => ({
	fetchSystemCapabilities: vi.fn(),
}));

import { fetchSystemCapabilities } from "$lib/client/api/system";
import DegradedCapabilitiesBanner from "./DegradedCapabilitiesBanner.svelte";

const mockFetch = fetchSystemCapabilities as ReturnType<typeof vi.fn>;

const degradedResponse = {
	degraded: [
		{
			tool: "image_search",
			backend: "Brave Search",
			since: "2026-09-05T10:00:00.000Z",
		},
		{
			tool: "map_route",
			backend: "OpenRouteService",
			since: "2026-09-05T10:00:00.000Z",
		},
		{
			tool: "map_route",
			backend: "Geocoder (Nominatim)",
			since: "2026-09-05T10:00:00.000Z",
		},
	],
	checkedAt: "2026-09-05T10:00:00.000Z",
};

describe("DegradedCapabilitiesBanner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionStorage.clear();
		mockFetch.mockResolvedValue(degradedResponse);
	});

	afterEach(() => {
		uiLanguage.set("en");
		vi.useRealTimers();
	});

	it("stays hidden when nothing is degraded", async () => {
		mockFetch.mockResolvedValue({ degraded: [], checkedAt: "" });
		render(DegradedCapabilitiesBanner, { pollMs: 0, isAdmin: true });

		await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("stays hidden for members and never polls capability status", async () => {
		render(DegradedCapabilitiesBanner, { pollMs: 0, isAdmin: false });

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("links admins to the tool health section", async () => {
		render(DegradedCapabilitiesBanner, { pollMs: 0, isAdmin: true });

		const link = await screen.findByTestId("degraded-capabilities-admin-link");
		expect(link).toHaveAttribute("href", "/settings?section=tool-health");
		expect(link).toHaveTextContent("Open tool health");
	});

	it("dismisses for the session and stays hidden for the same degraded set", async () => {
		const first = render(DegradedCapabilitiesBanner, {
			pollMs: 0,
			isAdmin: true,
		});
		await screen.findByRole("status");

		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		first.unmount();

		render(DegradedCapabilitiesBanner, { pollMs: 0, isAdmin: true });
		await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("re-shows the banner when a different tool degrades after dismissal", async () => {
		render(DegradedCapabilitiesBanner, { pollMs: 0, isAdmin: true });
		await screen.findByRole("status");
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();

		mockFetch.mockResolvedValue({
			degraded: [
				{
					tool: "research_web",
					backend: "Parallel API",
					since: "2026-09-05T10:05:00.000Z",
				},
			],
			checkedAt: "2026-09-05T10:05:00.000Z",
		});
		render(DegradedCapabilitiesBanner, { pollMs: 0, isAdmin: true });

		const banner = await screen.findByRole("status");
		expect(banner).toHaveTextContent("web research");
	});

	it("polls on the configured interval", async () => {
		vi.useFakeTimers();
		render(DegradedCapabilitiesBanner, { pollMs: 1_000, isAdmin: true });
		expect(mockFetch).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(mockFetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(mockFetch).toHaveBeenCalledTimes(3);
	});

	it("uses Hungarian copy when the UI language is Hungarian", async () => {
		uiLanguage.set("hu");
		render(DegradedCapabilitiesBanner, { pollMs: 0, isAdmin: true });

		const banner = await screen.findByRole("status");
		expect(banner).toHaveTextContent(
			"Néhány képesség korlátozottan működik: képkeresés, útvonaltervezés",
		);
		expect(screen.getByRole("button", { name: "Elrejtés" })).toBeVisible();
	});
});
