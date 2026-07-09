import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { PendingWrite } from "$lib/types";
import WriteConfirmCard from "./WriteConfirmCard.svelte";

function makeWrite(overrides: Partial<PendingWrite> = {}): PendingWrite {
	return {
		id: "pw-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		status: "pending",
		provider: "nextcloud",
		createdAt: 1_700_000_000,
		preview: {
			title: "Save note.txt to /AlfyAI",
			detail: "files.put — /AlfyAI/note.txt",
			reversible: true,
			destructive: false,
			withinAllowlist: true,
			warnings: [],
		},
		...overrides,
	};
}

describe("WriteConfirmCard", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("renders the preview title/detail and Confirm/Cancel actions, wiring callbacks by id", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();

		render(WriteConfirmCard, { write: makeWrite(), onConfirm, onCancel });

		expect(
			screen.getByRole("article", {
				name: "Pending write: Save note.txt to /AlfyAI",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("Save note.txt to /AlfyAI")).toBeInTheDocument();
		expect(
			screen.getByText("files.put — /AlfyAI/note.txt"),
		).toBeInTheDocument();

		const confirmButton = screen.getByRole("button", {
			name: "Confirm: Save note.txt to /AlfyAI",
		});
		const cancelButton = screen.getByRole("button", {
			name: "Cancel: Save note.txt to /AlfyAI",
		});
		expect(confirmButton).toBeInTheDocument();
		expect(cancelButton).toBeInTheDocument();

		await fireEvent.click(confirmButton);
		await fireEvent.click(cancelButton);

		expect(onConfirm).toHaveBeenCalledWith("pw-1");
		expect(onCancel).toHaveBeenCalledWith("pw-1");
	});

	it("renders warnings prominently and applies destructive treatment", () => {
		render(WriteConfirmCard, {
			write: makeWrite({
				preview: {
					title: "Delete a calendar event",
					detail: "calendar.delete_event — calendar event",
					reversible: false,
					destructive: true,
					withinAllowlist: null,
					warnings: [
						"This will overwrite/delete and may not be recoverable",
						"This deletes the ENTIRE recurring series, not a single occurrence.",
					],
				},
			}),
		});

		expect(
			screen.getByText("This will overwrite/delete and may not be recoverable"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"This deletes the ENTIRE recurring series, not a single occurrence.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Destructive")).toBeInTheDocument();
		expect(screen.getByText("Not reversible")).toBeInTheDocument();
		// Warnings are announced via a live region.
		expect(screen.getByRole("status")).toHaveTextContent(
			"This will overwrite/delete and may not be recoverable",
		);
	});

	it("moves to the confirmed state when status is 'executed' (incl. after alreadyExecuted) and hides the action buttons", () => {
		render(WriteConfirmCard, {
			write: makeWrite({ status: "executed", etag: '"e-42"' }),
		});

		expect(screen.getByText("Done — this was saved.")).toBeInTheDocument();
		expect(screen.getByText('Confirmation ref: "e-42"')).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Confirm/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Cancel/ }),
		).not.toBeInTheDocument();
	});

	it("moves to the cancelled state and hides the action buttons", () => {
		render(WriteConfirmCard, { write: makeWrite({ status: "cancelled" }) });

		expect(
			screen.getByText("Cancelled — this was not saved."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Confirm/ }),
		).not.toBeInTheDocument();
	});

	it("a card fetched already-executed (e.g. after reload) renders terminal, not actionable", () => {
		// Simulates GET pending-writes returning a write that was confirmed in
		// a prior session — the card must never show as actionable just
		// because it was freshly fetched into the client.
		render(WriteConfirmCard, {
			write: makeWrite({ status: "executed", etag: null }),
		});

		expect(screen.getByText("Done — this was saved.")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows an inline error and disables the buttons while busy", () => {
		render(WriteConfirmCard, {
			write: makeWrite(),
			busy: true,
			error: "Failed to confirm the write.",
			onConfirm: vi.fn(),
			onCancel: vi.fn(),
		});

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Failed to confirm the write.",
		);
		const confirmButton = screen.getByRole("button", {
			name: "Confirm: Save note.txt to /AlfyAI",
		});
		expect(confirmButton).toBeDisabled();
		expect(confirmButton).toHaveTextContent("Working…");
		expect(
			screen.getByRole("button", { name: "Cancel: Save note.txt to /AlfyAI" }),
		).toBeDisabled();
	});

	it("uses Hungarian labels", () => {
		uiLanguage.set("hu");

		render(WriteConfirmCard, {
			write: makeWrite(),
			onConfirm: vi.fn(),
			onCancel: vi.fn(),
		});

		expect(
			screen.getByRole("button", { name: /Jóváhagyás/ }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Mégse/ })).toBeInTheDocument();
	});
});
