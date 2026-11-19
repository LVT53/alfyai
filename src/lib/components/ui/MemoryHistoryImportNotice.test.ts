import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemoryHistoryImportNotice from "./MemoryHistoryImportNotice.svelte";

const api = vi.hoisted(() => ({
	fetchMemoryHistoryImport: vi.fn(),
	saveMemoryHistoryImport: vi.fn(),
}));
vi.mock("$lib/client/api/memory", () => api);
vi.mock("svelte/transition", () => ({
	fly: () => ({ duration: 0 }),
	fade: () => ({ duration: 0 }),
	scale: () => ({ duration: 0 }),
}));
const state = {
	available: true,
	shouldPrompt: true,
	choice: null,
	cutoff: null,
	decidedAt: null,
	policyVersion: "v1",
	status: "not_requested",
};
beforeEach(() => {
	vi.clearAllMocks();
	api.fetchMemoryHistoryImport.mockResolvedValue(state);
	api.saveMemoryHistoryImport.mockResolvedValue({
		...state,
		shouldPrompt: false,
		choice: "decline",
	});
});
describe("historical import choice", () => {
	it("does not prompt an account that has not enrolled in the replacement", async () => {
		api.fetchMemoryHistoryImport.mockResolvedValue({
			...state,
			available: false,
			shouldPrompt: false,
		});
		render(MemoryHistoryImportNotice);
		await waitFor(() =>
			expect(api.fetchMemoryHistoryImport).toHaveBeenCalled(),
		);
		expect(
			screen.queryByTestId("memory-history-notice"),
		).not.toBeInTheDocument();
	});
	it("records Not now and does not prompt again after reload", async () => {
		render(MemoryHistoryImportNotice);
		await fireEvent.click(
			await screen.findByRole("button", { name: "Not now" }),
		);
		await waitFor(() =>
			expect(api.saveMemoryHistoryImport).toHaveBeenCalledWith(
				"decline",
				expect.any(String),
			),
		);
	});
	it("does not submit include merely by opening the optional explanation", async () => {
		render(MemoryHistoryImportNotice);
		await fireEvent.click(
			await screen.findByRole("button", { name: "Change choice" }),
		);
		expect(await screen.findByRole("dialog")).toHaveTextContent(
			"Private chats and details you asked Alfy to forget stay excluded",
		);
		expect(api.saveMemoryHistoryImport).not.toHaveBeenCalled();
	});
	it("offers a later change in Profile after declining", async () => {
		api.fetchMemoryHistoryImport.mockResolvedValue({
			...state,
			choice: "decline",
			shouldPrompt: false,
		});
		render(MemoryHistoryImportNotice, { profile: true });
		expect(await screen.findByText("Earlier chats not included")).toBeVisible();
		expect(screen.getByRole("button", { name: "Change choice" })).toBeVisible();
	});
});

it("dismissing the introductory dialog records Not now, while Profile cancel preserves its choice", async () => {
	const view = render(MemoryHistoryImportNotice);
	await fireEvent.click(
		await screen.findByRole("button", { name: "Change choice" }),
	);
	await fireEvent.keyDown(window, { key: "Escape" });
	await waitFor(() =>
		expect(api.saveMemoryHistoryImport).toHaveBeenCalledWith(
			"decline",
			expect.any(String),
		),
	);
	view.unmount();
	vi.clearAllMocks();
	api.fetchMemoryHistoryImport.mockResolvedValue({
		...state,
		choice: "decline",
		shouldPrompt: false,
	});
	render(MemoryHistoryImportNotice, { profile: true });
	await fireEvent.click(
		await screen.findByRole("button", { name: "Change choice" }),
	);
	await fireEvent.keyDown(window, { key: "Escape" });
	expect(api.saveMemoryHistoryImport).not.toHaveBeenCalled();
});

it("closes the introductory dialog offline and retries the same decline without trapping the page", async () => {
	api.saveMemoryHistoryImport.mockRejectedValueOnce(new Error("offline"));
	render(MemoryHistoryImportNotice);
	await fireEvent.click(
		await screen.findByRole("button", { name: "Change choice" }),
	);
	await fireEvent.keyDown(window, { key: "Escape" });
	await waitFor(() =>
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
	);
	expect(screen.queryByTestId("memory-history-notice")).not.toBeInTheDocument();
	await fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
	expect(api.saveMemoryHistoryImport.mock.calls[1]).toEqual(
		api.saveMemoryHistoryImport.mock.calls[0],
	);
});

it("closes an open introductory editor when another tab has decided", async () => {
	render(MemoryHistoryImportNotice);
	await fireEvent.click(
		await screen.findByRole("button", { name: "Change choice" }),
	);
	api.fetchMemoryHistoryImport.mockResolvedValue({
		...state,
		choice: "include",
		shouldPrompt: false,
	});
	window.dispatchEvent(new Event("memory-history-choice"));
	await waitFor(() =>
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
	);
	await fireEvent.keyDown(window, { key: "Escape" });
	expect(api.saveMemoryHistoryImport).not.toHaveBeenCalled();
});
