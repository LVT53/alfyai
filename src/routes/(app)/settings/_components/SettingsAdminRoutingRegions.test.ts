import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsAdminRoutingRegions from "./SettingsAdminRoutingRegions.svelte";

vi.mock("$lib/client/api/admin", () => ({
	fetchRoutingRegions: vi.fn(),
	requestRoutingRegion: vi.fn(),
	retryRoutingRegion: vi.fn(),
	removeRoutingRegion: vi.fn(),
}));

import {
	fetchRoutingRegions,
	removeRoutingRegion,
	requestRoutingRegion,
	retryRoutingRegion,
} from "$lib/client/api/admin";

const mockFetch = fetchRoutingRegions as ReturnType<typeof vi.fn>;
const mockRequest = requestRoutingRegion as ReturnType<typeof vi.fn>;
const mockRetry = retryRoutingRegion as ReturnType<typeof vi.fn>;
const mockRemove = removeRoutingRegion as ReturnType<typeof vi.fn>;

function region(overrides: Record<string, unknown> = {}) {
	return {
		id: "hungary",
		name: "Hungary",
		slug: "hungary",
		pbfUrl: "https://download.geofabrik.de/europe/hungary-latest.osm.pbf",
		status: "ready",
		managed: false,
		baseUrl: "http://127.0.0.1:8088/ors",
		hostPort: null,
		containerName: null,
		pbfSizeBytes: null,
		geocoderStatus: "none",
		error: null,
		requestedBy: null,
		createdAt: "2026-09-05T10:00:00.000Z",
		updatedAt: "2026-09-05T10:00:00.000Z",
		lastUsedAt: "2026-09-05T11:00:00.000Z",
		readyAt: "2026-09-05T10:00:00.000Z",
		...overrides,
	};
}

describe("SettingsAdminRoutingRegions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(window, "confirm").mockReturnValue(true);
	});

	it("lists regions with status and marks the fixed instance", async () => {
		mockFetch.mockResolvedValue({
			configured: true,
			regions: [
				region(),
				region({
					id: "ireland-and-northern-ireland",
					name: "Ireland and Northern Ireland",
					managed: true,
					status: "building",
					baseUrl: "http://127.0.0.1:8300/ors",
					pbfSizeBytes: 250 * 1048576,
				}),
			],
		});
		render(SettingsAdminRoutingRegions);
		await waitFor(() =>
			expect(screen.getByText("Hungary")).toBeInTheDocument(),
		);
		expect(
			screen.getByText("Ireland and Northern Ireland"),
		).toBeInTheDocument();
		expect(screen.getByText("building")).toBeInTheDocument();
		expect(screen.getByText("250 MB")).toBeInTheDocument();
		expect(screen.getByText(/fixed instance/)).toBeInTheDocument();
	});

	it("requests a region by Geofabrik id", async () => {
		mockFetch.mockResolvedValue({ configured: true, regions: [] });
		mockRequest.mockResolvedValue({ kind: "preparing" });
		render(SettingsAdminRoutingRegions);
		await waitFor(() => expect(mockFetch).toHaveBeenCalled());
		const input = screen.getByPlaceholderText(/Geofabrik id/);
		await fireEvent.input(input, { target: { value: "austria" } });
		await fireEvent.click(
			screen.getByRole("button", { name: "Prepare region" }),
		);
		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith({ id: "austria" }),
		);
		expect(
			await screen.findByText("Region queued for download and build."),
		).toBeInTheDocument();
	});

	it("offers retry for failed regions and remove for managed ones", async () => {
		mockFetch.mockResolvedValue({
			configured: true,
			regions: [
				region({
					id: "germany",
					name: "Germany",
					managed: true,
					status: "error",
					error: "extract checksum mismatch",
				}),
			],
		});
		mockRetry.mockResolvedValue(undefined);
		mockRemove.mockResolvedValue(undefined);
		render(SettingsAdminRoutingRegions);
		await waitFor(() =>
			expect(screen.getByText("Germany")).toBeInTheDocument(),
		);
		expect(screen.getByText("extract checksum mismatch")).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(mockRetry).toHaveBeenCalledWith("germany"));
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await waitFor(() => expect(mockRemove).toHaveBeenCalledWith("germany"));
	});

	it("explains when routing is not configured", async () => {
		mockFetch.mockResolvedValue({ configured: false, regions: [] });
		render(SettingsAdminRoutingRegions);
		expect(
			await screen.findByText(/Routing is not configured/),
		).toBeInTheDocument();
	});
});
