import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VersionsSheet from "./VersionsSheet.svelte";

const { mockFetchVersions, mockRestoreVersion } = vi.hoisted(() => ({
	mockFetchVersions: vi.fn(),
	mockRestoreVersion: vi.fn(),
}));

vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifactVersions: mockFetchVersions,
	restoreArtifactVersion: mockRestoreVersion,
}));

const VERSIONS = [
	{
		id: "v3",
		versionNumber: 3,
		author: "user",
		summary: "Shortened Saturday",
		createdAt: Date.now(),
	},
	{
		id: "v2",
		versionNumber: 2,
		author: "alfy",
		summary: "Added bookings table",
		createdAt: Date.now() - 60_000,
	},
	{
		id: "v1",
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		createdAt: Date.now() - 120_000,
	},
];

describe("VersionsSheet", () => {
	beforeEach(() => {
		mockFetchVersions.mockReset();
		mockRestoreVersion.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("lists versions newest first, each with author and summary, the newest marked Current", async () => {
		mockFetchVersions.mockResolvedValue(VERSIONS);

		render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

		await waitFor(() => {
			expect(screen.getByText("Shortened Saturday")).toBeInTheDocument();
		});
		expect(screen.getByText("Current")).toBeInTheDocument();
		expect(screen.getAllByText("You")).toHaveLength(1);
		expect(screen.getAllByText("Alfy")).toHaveLength(2);
		// Only the two non-current rows offer Restore.
		expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(2);
	});

	it("restores a version after confirming, and refreshes the list", async () => {
		mockFetchVersions.mockResolvedValue(VERSIONS);
		mockRestoreVersion.mockResolvedValue(4);
		const onRestored = vi.fn();

		render(VersionsSheet, {
			artifactId: "artifact-1",
			conversationId: "conv-1",
			onClose: vi.fn(),
			onRestored,
		});

		await waitFor(() => screen.getByText("Shortened Saturday"));
		const restoreButtons = screen.getAllByRole("button", { name: "Restore" });
		await fireEvent.click(restoreButtons[0]);

		// The confirmation dialog appears before anything is called.
		expect(mockRestoreVersion).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				"Restore this version? The current one is kept as a version.",
			),
		).toBeInTheDocument();

		await fireEvent.click(screen.getByTestId("confirm-delete"));

		await waitFor(() => {
			expect(mockRestoreVersion).toHaveBeenCalledWith(
				"artifact-1",
				"v2",
				"conv-1",
			);
		});
		expect(onRestored).toHaveBeenCalledWith(4);
		// The list reloads after a successful restore.
		expect(mockFetchVersions).toHaveBeenCalledTimes(2);
	});

	it("shows a retry option when loading fails", async () => {
		mockFetchVersions.mockRejectedValueOnce(new Error("network down"));
		mockFetchVersions.mockResolvedValueOnce(VERSIONS);

		render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

		await waitFor(() => {
			expect(
				screen.getByText("Could not load the version history."),
			).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() => {
			expect(screen.getByText("Shortened Saturday")).toBeInTheDocument();
		});
	});

	it("closes via the close button", async () => {
		mockFetchVersions.mockResolvedValue([]);
		const onClose = vi.fn();

		render(VersionsSheet, { artifactId: "artifact-1", onClose });

		await waitFor(() => screen.getByText("No earlier versions yet."));
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});
});
