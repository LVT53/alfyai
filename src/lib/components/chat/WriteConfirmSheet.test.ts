import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingWrite } from "$lib/server/services/connections/pending-write-dto";
import { uiLanguage } from "$lib/stores/settings";
import WriteConfirmSheet from "./WriteConfirmSheet.svelte";

function write(
	id: string,
	subject: string,
	overrides: Partial<PendingWrite> = {},
): PendingWrite {
	return {
		id,
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		status: "pending",
		provider: "nextcloud",
		createdAt: 1_700_000_000,
		preview: {
			title: `Save ${subject}`,
			detail: `files.put — /AlfyAI/${subject}`,
			reversible: true,
			destructive: false,
			withinAllowlist: true,
			warnings: [],
		},
		card: {
			kind: "files.save",
			subject,
			facts: [{ key: "folder", value: "/AlfyAI" }],
			message: null,
			risks: [],
			danger: false,
		},
		...overrides,
	};
}

// The sheet slides away, so it leaves the page a moment after it is told to.
async function expectSheetGone() {
	await waitFor(() => {
		expect(screen.queryByTestId("write-confirm-sheet")).toBeNull();
	});
}

describe("WriteConfirmSheet", () => {
	beforeEach(() => {
		uiLanguage.set("en");
		vi.stubGlobal("innerWidth", 390);
		// jsdom never finishes a sheet's slide: with motion off it has none.
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => ({
				matches: query.includes("prefers-reduced-motion"),
				media: query,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("raises nothing above the phone breakpoint, where the card in the reply is enough", () => {
		vi.stubGlobal("innerWidth", 1200);
		render(WriteConfirmSheet, { writes: [write("pw-1", "a.txt")] });

		expect(screen.queryByTestId("write-confirm-sheet")).toBeNull();
	});

	it("raises one sheet however many writes wait, oldest first, and says how many more", () => {
		render(WriteConfirmSheet, {
			writes: [
				write("pw-1", "a.txt"),
				write("pw-2", "b.txt"),
				write("pw-3", "c.txt"),
			],
		});

		expect(screen.getAllByTestId("write-confirm-sheet")).toHaveLength(1);
		expect(screen.getAllByTestId("dialog-sheet-grabber")).toHaveLength(1);
		expect(screen.getByText("a.txt")).toBeInTheDocument();
		expect(screen.queryByText("b.txt")).toBeNull();
		expect(screen.getByText("2 more waiting")).toBeInTheDocument();
	});

	it("says nothing about others when this is the only one", () => {
		render(WriteConfirmSheet, { writes: [write("pw-1", "a.txt")] });

		expect(screen.queryByText(/more waiting/)).toBeNull();
	});

	it("moves to the next write when the page reports an answer, and leaves after the last", async () => {
		const first = write("pw-1", "a.txt");
		const second = write("pw-2", "b.txt");
		const view = render(WriteConfirmSheet, { writes: [first, second] });

		await view.rerender({
			writes: [{ ...first, status: "executed" as const }, second],
		});
		expect(screen.getByText("b.txt")).toBeInTheDocument();
		expect(screen.queryByText("a.txt")).toBeNull();

		await view.rerender({
			writes: [
				{ ...first, status: "executed" as const },
				{ ...second, status: "cancelled" as const },
			],
		});
		await expectSheetGone();
	});

	it("wires both answers to the write on show", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(WriteConfirmSheet, {
			writes: [write("pw-1", "a.txt"), write("pw-2", "b.txt")],
			onConfirm,
			onCancel,
		});
		await waitFor(() => {
			expect(screen.getByTestId("write-confirm-approve")).toBeEnabled();
		});

		await fireEvent.click(screen.getByTestId("write-confirm-approve"));
		await fireEvent.click(screen.getByTestId("write-confirm-decline"));

		expect(onConfirm).toHaveBeenCalledWith("pw-1");
		expect(onCancel).toHaveBeenCalledWith("pw-1");
	});

	// A double tap on "Save" must not also answer the delete behind it.
	it("keeps each new question's buttons off for a moment, without saying it is working", async () => {
		vi.useFakeTimers();
		try {
			const first = write("pw-1", "a.txt");
			const second = write("pw-2", "b.txt");
			const view = render(WriteConfirmSheet, { writes: [first, second] });
			const approve = () => screen.getByTestId("write-confirm-approve");

			expect(approve()).toBeDisabled();
			expect(approve()).toHaveTextContent("Save");
			await vi.advanceTimersByTimeAsync(400);
			expect(approve()).toBeEnabled();

			await view.rerender({
				writes: [{ ...first, status: "executed" as const }, second],
			});
			expect(approve()).toBeDisabled();
			await vi.advanceTimersByTimeAsync(400);
			expect(approve()).toBeEnabled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not take the buttons away again when the same question is read back", async () => {
		vi.useFakeTimers();
		try {
			const first = write("pw-1", "a.txt");
			const view = render(WriteConfirmSheet, { writes: [first] });
			await vi.advanceTimersByTimeAsync(400);

			await view.rerender({ writes: [{ ...first }] });

			expect(screen.getByTestId("write-confirm-approve")).toBeEnabled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows the page's state for the write on show, and stays on it through an error", () => {
		render(WriteConfirmSheet, {
			writes: [write("pw-1", "a.txt")],
			actionState: {
				"pw-1": { busy: true, error: "That didn't work. Try again." },
			},
		});

		expect(screen.getByTestId("write-confirm-approve")).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"That didn't work. Try again.",
		);
	});

	it("backing out decides nothing, for this write or the ones behind it", async () => {
		const onCancel = vi.fn();
		render(WriteConfirmSheet, {
			writes: [write("pw-1", "a.txt"), write("pw-2", "b.txt")],
			onCancel,
		});

		await fireEvent.click(screen.getByTestId("dialog-sheet-grabber"));

		expect(onCancel).not.toHaveBeenCalled();
		await expectSheetGone();
	});

	it("only a new write raises the sheet again after backing out", async () => {
		const first = write("pw-1", "a.txt");
		const view = render(WriteConfirmSheet, { writes: [first] });
		await fireEvent.click(screen.getByTestId("dialog-sheet-grabber"));
		await expectSheetGone();

		await view.rerender({ writes: [{ ...first }] });
		await expectSheetGone();

		await view.rerender({ writes: [first, write("pw-2", "b.txt")] });
		expect(screen.getByText("b.txt")).toBeInTheDocument();
	});

	it("waits for the turn: nothing rises over a reply still being written", async () => {
		const view = render(WriteConfirmSheet, {
			writes: [write("pw-1", "a.txt")],
			held: true,
		});
		expect(screen.queryByTestId("write-confirm-sheet")).toBeNull();

		await view.rerender({ held: false });

		expect(screen.getByTestId("write-confirm-sheet")).toBeInTheDocument();
	});

	it.each([
		"executing",
		"executed",
		"cancelled",
		"expired",
		"failed",
	] as const)("raises nothing for a write that is %s: there is no decision left", (status) => {
		render(WriteConfirmSheet, {
			writes: [write("pw-1", "a.txt", { status })],
		});

		expect(screen.queryByTestId("write-confirm-sheet")).toBeNull();
	});
});
