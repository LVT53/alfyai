// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import MemoryQuarantineReview from "./MemoryQuarantineReview.svelte";

const api = vi.hoisted(() => ({
	fetchMemoryQuarantine: vi.fn(),
	saveMemoryQuarantine: vi.fn(),
}));
vi.mock("$lib/client/api/memory", () => api);

it("requires a separate review opt-in and keeps only the edited candidate", async () => {
	api.fetchMemoryQuarantine.mockResolvedValue({
		status: "idle",
		candidates: [],
	});
	const candidate = {
		id: "candidate-1",
		text: "The owner prefers a blue lamp.",
		scope: { kind: "project", projectId: "project-1" },
		source: {
			conversationId: "chat-1",
			messageId: "message-1",
			assertedAt: "2026-10-01T10:00:00.000Z",
		},
	};
	api.saveMemoryQuarantine
		.mockResolvedValueOnce({ status: "pending", candidates: [candidate] })
		.mockResolvedValueOnce({ status: "complete", candidates: [] });

	render(MemoryQuarantineReview, {
		projects: [{ id: "project-1", name: "Office" }],
		memoryOff: false,
	});
	await fireEvent.click(
		await screen.findByRole("button", { name: "Review earlier chats" }),
	);
	expect(api.saveMemoryQuarantine).not.toHaveBeenCalled();
	await fireEvent.click(
		screen.getByRole("button", { name: "Start reviewing" }),
	);
	await screen.findByText(candidate.text);
	expect(screen.getByText("Office")).toBeVisible();
	expect(
		screen.getByRole("link", { name: "Open original message" }),
	).toHaveAttribute("href", expect.stringContaining("message-1"));
	await fireEvent.click(screen.getByRole("button", { name: "Edit and keep" }));
	await fireEvent.input(screen.getByRole("textbox", { name: "Memory" }), {
		target: { value: "The owner prefers a reading lamp." },
	});
	await fireEvent.click(
		screen.getByRole("button", { name: "Keep edited memory" }),
	);
	await waitFor(() => {
		expect(api.saveMemoryQuarantine).toHaveBeenLastCalledWith({
			action: "resolve",
			id: candidate.id,
			decision: "keep",
			text: "The owner prefers a reading lamp.",
			requestId: expect.any(String),
		});
	});
	expect(await screen.findByText("Review complete")).toBeVisible();
	expect(screen.queryByText(candidate.text)).not.toBeInTheDocument();
});

it("discards one suggestion in Hungarian and retries the same decision after a lost response", async () => {
	const { uiLanguage } = await import("$lib/stores/settings");
	const candidate = {
		id: "candidate-2",
		text: "Szeretek olvasni.",
		scope: { kind: "personal" },
		source: {
			conversationId: "chat",
			messageId: "one",
			assertedAt: "2026-07-01T14:00:00.000Z",
		},
	};
	api.fetchMemoryQuarantine.mockResolvedValue({
		status: "pending",
		candidates: [candidate],
	});
	api.saveMemoryQuarantine
		.mockRejectedValueOnce(new Error("connection dropped"))
		.mockResolvedValueOnce({ status: "complete", candidates: [] });
	uiLanguage.set("hu");
	try {
		const kept = vi.fn();
		render(MemoryQuarantineReview, {
			projects: [],
			memoryOff: false,
			onKeep: kept,
		});
		await fireEvent.click(
			await screen.findByRole("button", {
				name: "Korábbi beszélgetések áttekintése",
			}),
		);
		expect(screen.getByText("Személyes")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "Elvetés" }));
		expect(await screen.findByRole("alert")).toBeVisible();
		expect(screen.getByText(candidate.text)).toBeVisible();
		const first = api.saveMemoryQuarantine.mock.lastCall?.[0];
		expect(first).toMatchObject({
			action: "resolve",
			id: candidate.id,
			decision: "discard",
		});
		await fireEvent.click(screen.getByRole("button", { name: "Újrapróbálás" }));
		expect(await screen.findByText("Az áttekintés befejeződött")).toBeVisible();
		expect(api.saveMemoryQuarantine).toHaveBeenLastCalledWith(first);
		expect(kept).not.toHaveBeenCalled();
	} finally {
		uiLanguage.set("en");
	}
});

it("shows an existing failed Keep and retries only its original approval while preparing", async () => {
	const approval = {
		id: "approval",
		text: "I prefer a blue reading lamp.",
		status: "failed",
		retryable: true,
	};
	api.fetchMemoryQuarantine.mockResolvedValue({
		status: "complete",
		candidates: [],
		approvals: [approval],
	});
	api.saveMemoryQuarantine.mockResolvedValue({
		status: "complete",
		candidates: [],
		approvals: [{ ...approval, status: "queued", retryable: false }],
	});
	render(MemoryQuarantineReview, {
		projects: [],
		memoryOff: false,
		preparing: true,
	});
	await fireEvent.click(
		await screen.findByRole("button", { name: "Review earlier chats" }),
	);
	expect(screen.getByText(approval.text)).toBeVisible();
	expect(screen.getByText("Could not add this memory.")).toBeVisible();
	expect(
		screen.getByText(
			"Approved memories become available in chat after the Memory switch.",
		),
	).toBeVisible();
	await fireEvent.click(
		screen.getByRole("button", { name: "Retry adding memory" }),
	);
	expect(api.saveMemoryQuarantine).toHaveBeenLastCalledWith({
		action: "retry",
		id: "approval",
	});
	expect(
		await screen.findByText("Waiting to be added to Memory."),
	).toBeVisible();
});
