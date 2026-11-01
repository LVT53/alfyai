import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PendingWrite,
	WriteCard,
} from "$lib/server/services/connections/pending-write-dto";
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
			title: "Save note.txt to /AlfyAI/note.txt",
			detail: "files.put — /AlfyAI/note.txt",
			reversible: true,
			destructive: false,
			withinAllowlist: true,
			warnings: [],
		},
		card: {
			kind: "files.save",
			subject: "note.txt",
			facts: [{ key: "folder", value: "/AlfyAI" }],
			message: null,
			risks: [],
			danger: false,
		},
		...overrides,
	};
}

function card(overrides: Partial<WriteCard>): WriteCard {
	return {
		kind: "files.save",
		subject: "note.txt",
		facts: [],
		message: null,
		risks: [],
		danger: false,
		...overrides,
	};
}

describe("WriteConfirmCard while it asks", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("asks in words and names the file large, with its location in a line of its own", () => {
		render(WriteConfirmCard, { write: makeWrite() });

		expect(
			screen.getByRole("heading", { name: "Save this file?" }),
		).toBeInTheDocument();
		expect(screen.getByText("note.txt")).toHaveClass("write-content__name");
		expect(screen.getByText("/AlfyAI")).toBeInTheDocument();
	});

	it("never prints a whole path, an internal action id or a confirmation reference", () => {
		const { container } = render(WriteConfirmCard, { write: makeWrite() });

		expect(container.textContent).not.toContain("/AlfyAI/note.txt");
		expect(container.textContent).not.toContain("files.put");
		expect(container.textContent).not.toMatch(/confirmation ref/i);
	});

	it("wires both answers to the write's id", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(WriteConfirmCard, { write: makeWrite(), onConfirm, onCancel });

		await fireEvent.click(screen.getByRole("button", { name: "Save: note.txt" }));
		await fireEvent.click(
			screen.getByRole("button", { name: "Cancel: note.txt" }),
		);

		expect(onConfirm).toHaveBeenCalledWith("pw-1");
		expect(onCancel).toHaveBeenCalledWith("pw-1");
	});

	it("puts the negative on the left and the positive on the right", () => {
		const { getByTestId } = render(WriteConfirmCard, { write: makeWrite() });

		expect(
			getByTestId("write-confirm-decline").compareDocumentPosition(
				getByTestId("write-confirm-approve"),
			) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	// The button used to say "Save it" on an email and on a calendar event.
	it.each([
		["email.send", "Send this email?", "Send"],
		["calendar.create_event", "Add this event?", "Add event"],
		["calendar.delete_event", "Delete this event?", "Delete"],
		["files.replace", "Replace this file?", "Replace"],
		["files.rename", "Rename this file?", "Rename"],
		["photos.add_to_album", "Add these photos to the album?", "Add"],
	] as const)("says what %s does", (kind, question, approve) => {
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({ card: card({ kind, subject: "Q3" }) }),
		});

		expect(screen.getByRole("heading", { name: question })).toBeInTheDocument();
		expect(getByTestId("write-confirm-approve")).toHaveTextContent(approve);
	});

	it("turns the positive red only when the reader loses something by it", () => {
		const benign = render(WriteConfirmCard, { write: makeWrite() });
		expect(benign.getByTestId("write-confirm-approve")).toHaveClass(
			"dialog-btn--positive",
		);
		benign.unmount();

		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({
				card: card({ kind: "files.replace", danger: true }),
			}),
		});
		const approve = getByTestId("write-confirm-approve");
		expect(approve).toHaveClass("dialog-btn--destructive");
		expect(approve).not.toHaveClass("dialog-btn--positive");
	});

	it("says what a risk means, in a sentence, announced as it appears", () => {
		render(WriteConfirmCard, {
			write: makeWrite({
				card: card({
					kind: "files.replace",
					danger: true,
					risks: ["replaces_file_for_good"],
				}),
			}),
		});

		expect(screen.getByRole("status")).toHaveTextContent(
			"This replaces the existing file. This Nextcloud keeps no earlier versions, so the old one can't be brought back.",
		);
	});

	it("draws no risk block when there is no risk", () => {
		render(WriteConfirmCard, { write: makeWrite() });

		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows the text going out, and folds a long one behind a press", async () => {
		const body = `Hi Anna,\n\n${"The numbers are in. ".repeat(40)}`;
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({
				card: card({ kind: "email.send", subject: "Q3", message: body }),
			}),
		});

		const message = getByTestId("write-confirm-message");
		expect(message).toHaveTextContent("The numbers are in.");
		expect(message.querySelector("p")).toHaveClass("is-folded");

		await fireEvent.click(screen.getByRole("button", { name: "Show all" }));

		expect(message.querySelector("p")).not.toHaveClass("is-folded");
		expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});

	it("does not fold a message that fits", () => {
		render(WriteConfirmCard, {
			write: makeWrite({ card: card({ message: "Short and sweet." }) }),
		});

		expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
	});

	it("shows an error beside the answers and holds them while busy", () => {
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite(),
			busy: true,
			error: "That didn't work. Try again.",
			onConfirm: vi.fn(),
			onCancel: vi.fn(),
		});

		expect(screen.getByRole("alert")).toHaveTextContent(
			"That didn't work. Try again.",
		);
		expect(getByTestId("write-confirm-approve")).toBeDisabled();
		expect(getByTestId("write-confirm-approve")).toHaveTextContent("Working…");
		expect(getByTestId("write-confirm-decline")).toBeDisabled();
	});

	it("holds its answers while a confirm claimed elsewhere is running", () => {
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({ status: "executing" }),
		});

		expect(getByTestId("write-confirm-approve")).toBeDisabled();
		expect(getByTestId("write-confirm-decline")).toBeDisabled();
	});

	it("asks in Hungarian", () => {
		uiLanguage.set("hu");
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({ card: card({ kind: "email.send", subject: "Q3" }) }),
		});

		expect(
			screen.getByRole("heading", { name: "Elküldjem ezt az e-mailt?" }),
		).toBeInTheDocument();
		expect(getByTestId("write-confirm-approve")).toHaveTextContent("Küldés");
		expect(getByTestId("write-confirm-decline")).toHaveTextContent("Mégse");
	});

	it("makes the question the headline when the write names nothing", () => {
		render(WriteConfirmCard, {
			write: makeWrite({
				provider: "imap",
				card: card({ kind: "email.mark_read", subject: "" }),
			}),
		});

		expect(
			screen.getByRole("heading", { name: "Mark this email as read?" }),
		).toHaveClass("write-content__name");
	});

	it("falls back to the proposed sentence for a write it cannot read", () => {
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({
				card: null,
				preview: {
					title: "Do something new",
					detail: "something.new — target",
					reversible: false,
					destructive: true,
					withinAllowlist: null,
					warnings: ["This may not be recoverable"],
				},
			}),
		});

		expect(
			screen.getByRole("heading", { name: "Do something new" }),
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			"This may not be recoverable",
		);
		expect(getByTestId("write-confirm-approve")).toHaveTextContent("Confirm");
		expect(getByTestId("write-confirm-approve")).toHaveClass(
			"dialog-btn--destructive",
		);
	});
});

// Once decided it is a record of what happened, drawn as every tool call is.
describe("WriteConfirmCard once it is settled", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("folds a done write into an activity row, with no answers left", () => {
		const { getByTestId, queryByRole } = render(WriteConfirmCard, {
			write: makeWrite({ status: "executed", etag: '"e-42"' }),
		});

		expect(getByTestId("write-confirm-settled")).toHaveAttribute(
			"data-status",
			"executed",
		);
		expect(getByTestId("tool-activity-row")).toHaveTextContent("Saved");
		expect(getByTestId("tool-activity-row")).toHaveTextContent("note.txt");
		expect(getByTestId("tool-activity-row")).toHaveAttribute(
			"data-status",
			"done",
		);
		expect(queryByRole("article")).toBeNull();
		expect(screen.queryByTestId("write-confirm-approve")).toBeNull();
		expect(screen.queryByTestId("write-confirm-decline")).toBeNull();
	});

	it("says what was done in the words of the action", () => {
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({
				status: "executed",
				provider: "imap",
				card: card({ kind: "email.send", subject: "Q3 numbers" }),
			}),
		});

		expect(getByTestId("tool-activity-row")).toHaveTextContent("Sent");
	});

	it("keeps a done write's details one press away", async () => {
		const { getByTestId, queryByText } = render(WriteConfirmCard, {
			write: makeWrite({ status: "executed" }),
		});

		expect(queryByText("/AlfyAI")).toBeNull();

		await fireEvent.click(getByTestId("tool-activity-row"));

		expect(queryByText("/AlfyAI")).toBeInTheDocument();
	});

	it("marks a cancelled write as neither done nor failed", () => {
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({ status: "cancelled" }),
		});

		const row = getByTestId("tool-activity-row");
		expect(row).toHaveTextContent("Cancelled");
		expect(row).toHaveAttribute("data-status", "skipped");
		expect(row.querySelector(".act-status")).toHaveClass("skipped");
	});

	it("opens a failed write by itself and says nothing changed", () => {
		const { getByTestId } = render(WriteConfirmCard, {
			write: makeWrite({ status: "failed" }),
		});

		expect(getByTestId("tool-activity-row")).toHaveAttribute(
			"data-status",
			"failed",
		);
		expect(
			screen.getByText("This didn't go through, and nothing was changed."),
		).toBeInTheDocument();
	});

	it("does not repeat a risk that is behind us", () => {
		render(WriteConfirmCard, {
			write: makeWrite({
				status: "failed",
				card: card({
					kind: "files.replace",
					danger: true,
					risks: ["replaces_file_for_good"],
				}),
			}),
		});

		expect(screen.queryByRole("status")).toBeNull();
	});

	it("a write fetched already settled, after a reload, is never a question again", () => {
		const { queryByRole } = render(WriteConfirmCard, {
			write: makeWrite({ status: "executed", etag: null }),
		});

		expect(queryByRole("article")).toBeNull();
		expect(screen.queryByTestId("write-confirm-approve")).toBeNull();
	});
});

// ── The expired state ────────────────────────────────────────────────
// A proposal has a 30-minute TTL. Past it the server refuses the confirm, so a
// live-looking card could only ever produce an error. The person came back to a
// choice they were offered and did not make: the row says it is too late, keeps
// what was proposed in sight, and names the one move left.
describe("WriteConfirmCard when the write has expired", () => {
	beforeEach(() => {
		uiLanguage.set("en");
		vi.unstubAllGlobals();
	});

	it("says the request expired and how to get it back", () => {
		render(WriteConfirmCard, { write: makeWrite({ status: "expired" }) });

		expect(
			screen.getByText("This request expired. Ask again to redo it."),
		).toBeInTheDocument();
	});

	it("keeps what was proposed in sight", () => {
		render(WriteConfirmCard, {
			write: makeWrite({
				status: "expired",
				card: card({
					kind: "email.send",
					subject: "Q3 numbers",
					facts: [{ key: "to", value: "anna@example.com" }],
					message: "Hi Anna",
				}),
			}),
		});

		expect(screen.getByText("Q3 numbers")).toBeInTheDocument();
		expect(screen.getByText("anna@example.com")).toBeInTheDocument();
		expect(screen.getByText("Hi Anna")).toBeInTheDocument();
	});

	it("offers neither answer: nothing here could still reach the server", () => {
		render(WriteConfirmCard, { write: makeWrite({ status: "expired" }) });

		expect(screen.queryByTestId("write-confirm-approve")).toBeNull();
		expect(screen.queryByTestId("write-confirm-decline")).toBeNull();
	});

	it("says it in Hungarian too", () => {
		uiLanguage.set("hu");
		render(WriteConfirmCard, { write: makeWrite({ status: "expired" }) });

		expect(
			screen.getByText("Ez a kérés lejárt. Kérd újra, ha még kell."),
		).toBeInTheDocument();
	});
});
