import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import PersonaSummaryCard from "./PersonaSummaryCard.svelte";

const summary = {
	text: "Levi is a Hungarian developer who prefers concise, actionable answers.",
	updatedAt: "2026-07-06T22:15:00.000Z",
};

function renderCard(overrides = {}) {
	return render(PersonaSummaryCard, {
		props: {
			summary,
			busy: false,
			hasFacts: true,
			onEdit: vi.fn(),
			...overrides,
		},
	});
}

describe("PersonaSummaryCard", () => {
	it("renders the heading, summary text and updated stamp", () => {
		renderCard();

		expect(
			screen.getByRole("heading", { name: "What I remember about you" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Levi is a Hungarian developer/),
		).toBeInTheDocument();
		expect(screen.getByText(/Updated /)).toBeInTheDocument();
	});

	it("renders an inviting empty state when summary is null and there are no facts yet", () => {
		renderCard({ summary: null, hasFacts: false });

		expect(
			screen.getByRole("heading", { name: "What I remember about you" }),
		).toBeInTheDocument();
		expect(screen.getByText(/Nothing here yet/i)).toBeInTheDocument();
		// No edit affordance without a summary to edit.
		expect(
			screen.queryByRole("button", { name: "Edit summary" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/Updated /)).not.toBeInTheDocument();
	});

	it("renders a pending-summary message when summary is null but facts already exist", () => {
		renderCard({ summary: null, hasFacts: true });

		expect(
			screen.getByRole("heading", { name: "What I remember about you" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Your portrait will appear the next time/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/Nothing here yet/i)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Edit summary" }),
		).not.toBeInTheDocument();
	});

	it("edit flow: prefills the textarea and saves the new text via onEdit", async () => {
		const onEdit = vi.fn();
		renderCard({ onEdit });

		await fireEvent.click(screen.getByRole("button", { name: "Edit summary" }));

		const textarea = screen.getByRole("textbox");
		expect(textarea).toHaveValue(summary.text);

		await fireEvent.input(textarea, {
			target: { value: "Levi builds AlfyAI and prefers terse summaries." },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Save summary" }));

		expect(onEdit).toHaveBeenCalledWith(
			"Levi builds AlfyAI and prefers terse summaries.",
		);
	});

	it("cancel closes the editor without calling onEdit", async () => {
		const onEdit = vi.fn();
		renderCard({ onEdit });

		await fireEvent.click(screen.getByRole("button", { name: "Edit summary" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "Changed but discarded." },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Cancel summary edit" }),
		);

		expect(onEdit).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(
			screen.getByText(/Levi is a Hungarian developer/),
		).toBeInTheDocument();
	});

	it("keeps the editor and draft when onEdit resolves false", async () => {
		const onEdit = vi.fn().mockResolvedValue(false);
		renderCard({ onEdit });

		await fireEvent.click(screen.getByRole("button", { name: "Edit summary" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "A draft that must survive the failed save." },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Save summary" }));

		expect(onEdit).toHaveBeenCalledWith(
			"A draft that must survive the failed save.",
		);
		// Failed save: the editor stays open and the draft is untouched.
		expect(screen.getByRole("textbox")).toHaveValue(
			"A draft that must survive the failed save.",
		);
	});

	it("closes the editor when onEdit resolves true", async () => {
		const onEdit = vi.fn().mockResolvedValue(true);
		renderCard({ onEdit });

		await fireEvent.click(screen.getByRole("button", { name: "Edit summary" }));
		await fireEvent.click(screen.getByRole("button", { name: "Save summary" }));

		await vi.waitFor(() => {
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		});
	});

	it("disables saving while busy and when the text is empty", async () => {
		renderCard({ busy: true });

		await fireEvent.click(screen.getByRole("button", { name: "Edit summary" }));
		expect(screen.getByRole("button", { name: "Save summary" })).toBeDisabled();
	});
});
