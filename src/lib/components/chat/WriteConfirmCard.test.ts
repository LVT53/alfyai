import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingWrite } from "$lib/server/services/connections/pending-write-dto";
import { uiLanguage } from "$lib/stores/settings";
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

// ── Everyday redesign: the approved dialog chassis ───────────────────
describe("WriteConfirmCard on the dialog chassis", () => {
	beforeEach(() => {
		uiLanguage.set("en");
		vi.unstubAllGlobals();
	});

	function setViewportWidth(width: number) {
		vi.stubGlobal("innerWidth", width);
	}

	it("puts the negative on the left and the positive on the right", () => {
		const { getByTestId } = render(WriteConfirmCard, { write: makeWrite() });
		const decline = getByTestId("write-confirm-decline");
		const approve = getByTestId("write-confirm-approve");
		// The old card drew Confirm first, which is where the accidental
		// confirm came from.
		expect(
			decline.compareDocumentPosition(approve) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("names what the positive button does rather than saying Confirm", () => {
		const { getByTestId } = render(WriteConfirmCard, { write: makeWrite() });
		expect(getByTestId("write-confirm-approve")).toHaveTextContent("Save it");
		expect(getByTestId("write-confirm-decline")).toHaveTextContent("Don't");
	});

	it("turns the positive red — and changes what it says — only when destructive", () => {
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({
				preview: {
					title: "Delete 3 photos from Immich",
					detail: "photos.delete — IMG_2291, IMG_2292, IMG_2294",
					reversible: false,
					destructive: true,
					withinAllowlist: true,
					warnings: ["Immich has no trash on this server."],
				},
			}),
		});
		const approve = getByTestId("write-confirm-approve");
		expect(approve).toHaveClass("dialog-btn--destructive");
		expect(approve).not.toHaveClass("dialog-btn--positive");
		expect(approve).toHaveTextContent("Yes, go ahead");
	});

	it("keeps the benign save on the tinted-outline positive", () => {
		const { getByTestId } = render(WriteConfirmCard, { write: makeWrite() });
		const approve = getByTestId("write-confirm-approve");
		expect(approve).toHaveClass("dialog-btn--positive");
		expect(approve).not.toHaveClass("dialog-btn--destructive");
	});

	it("says where the confirmation ref will appear, before it exists", () => {
		const { getByText } = render(WriteConfirmCard, { write: makeWrite() });
		expect(
			getByText("Confirmation ref appears here once it is written."),
		).toBeInTheDocument();
	});

	it("raises a pending write as a bottom sheet on a phone", () => {
		setViewportWidth(390);
		const { getByTestId } = render(WriteConfirmCard, { write: makeWrite() });
		expect(getByTestId("write-confirm-sheet")).toBeInTheDocument();
		expect(getByTestId("dialog-sheet-grabber")).toBeInTheDocument();
	});

	it("stays an inline card on a phone once the write is terminal", () => {
		setViewportWidth(390);
		const { queryByTestId, getByRole } = render(WriteConfirmCard, {
			write: makeWrite({ status: "executed", etag: "abc123" }),
		});
		expect(queryByTestId("write-confirm-sheet")).toBeNull();
		expect(
			getByRole("article", { name: "Pending write: Save note.txt to /AlfyAI" }),
		).toBeInTheDocument();
	});

	it("backing out of the sheet is not a decision — the card stays pending", async () => {
		setViewportWidth(390);
		const onCancel = vi.fn();
		const { getByTestId, getByRole } = render(WriteConfirmCard, {
			write: makeWrite(),
			onCancel,
		});

		await fireEvent.click(getByTestId("dialog-sheet-grabber"));

		// Nothing was cancelled server-side, and the decision is still in the
		// conversation where it was raised.
		expect(onCancel).not.toHaveBeenCalled();
		expect(
			getByRole("article", { name: "Pending write: Save note.txt to /AlfyAI" }),
		).toBeInTheDocument();
	});

	it("stays a centred inline card above the breakpoint", () => {
		setViewportWidth(1200);
		const { queryByTestId } = render(WriteConfirmCard, { write: makeWrite() });
		expect(queryByTestId("write-confirm-sheet")).toBeNull();
	});
});
