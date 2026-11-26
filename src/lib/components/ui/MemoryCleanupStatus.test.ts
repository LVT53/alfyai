// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import MemoryCleanupStatus from "./MemoryCleanupStatus.svelte";

const api = vi.hoisted(() => ({
	fetchMemoryCleanupStatus: vi.fn(),
	retryMemoryCleanup: vi.fn(),
}));
vi.mock("$lib/client/api/settings", () => api);
describe("remote memory cleanup status", () => {
	it("shows pending after reload and only claims completion after the service acknowledges", async () => {
		api.fetchMemoryCleanupStatus
			.mockResolvedValueOnce({
				nativeCleanupPending: true,
				cleanupOperations: [{ id: "erase", status: "failed", retryable: true }],
			})
			.mockResolvedValue({
				nativeCleanupPending: false,
				cleanupOperations: [],
			});
		api.retryMemoryCleanup.mockResolvedValue({
			nativeCleanupPending: true,
			cleanupOperations: [],
		});
		render(MemoryCleanupStatus);
		expect(
			await screen.findByTestId("memory-cleanup-status"),
		).toHaveTextContent("deletion needs another attempt");
		await fireEvent.click(
			screen.getByRole("button", { name: "Retry deletion" }),
		);
		await waitFor(() =>
			expect(api.retryMemoryCleanup).toHaveBeenCalledWith("erase"),
		);
		expect(
			await screen.findByText("Memory deletion is complete."),
		).toBeVisible();
	});
});

it("continues reconciling pending deletion after a transport failure", async () => {
	api.fetchMemoryCleanupStatus
		.mockReset()
		.mockResolvedValueOnce({
			nativeCleanupPending: true,
			cleanupOperations: [],
		})
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ nativeCleanupPending: false, cleanupOperations: [] });
	render(MemoryCleanupStatus);
	await screen.findByTestId("memory-cleanup-status");
	expect(
		await screen.findByText(
			"Memory deletion is complete.",
			{},
			{ timeout: 8000 },
		),
	).toBeVisible();
	expect(screen.queryByTestId("memory-cleanup-status")).not.toBeInTheDocument();
}, 10000);
