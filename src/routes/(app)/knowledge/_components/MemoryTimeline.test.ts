import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { MemoryTimelineReport } from "$lib/types";
import MemoryTimeline from "./MemoryTimeline.svelte";

const reports: MemoryTimelineReport[] = [
	{
		id: "report-old",
		status: "completed",
		summaryText: "Renewed 1 memory, nothing else to tidy.",
		createdAt: "2026-07-01T02:00:00.000Z",
		actions: [
			{
				type: "renewed",
				itemIds: ["item-1"],
				description: "Renewed “Working toward a spring launch.”",
				undo: [
					{
						itemId: "item-1",
						prevStatus: "active",
						prevStatement: "Working toward a spring launch.",
						prevExpiresAt: "2026-07-08T00:00:00.000Z",
					},
				],
			},
		],
	},
	{
		id: "report-new",
		status: "failed",
		summaryText: "Merged 2 duplicates, then stopped early.",
		createdAt: "2026-07-05T02:00:00.000Z",
		actions: [
			{
				type: "merged",
				itemIds: ["item-2", "item-3"],
				resultItemId: "item-4",
				description: "Merged two coffee preferences into one.",
				undo: [
					{
						itemId: "item-2",
						prevStatus: "active",
						prevStatement: "Prefers dark roast.",
					},
					{
						itemId: "item-3",
						prevStatus: "active",
						prevStatement: "Drinks coffee black.",
					},
				],
			},
			{
				type: "expired",
				itemIds: ["item-5"],
				description: "Expired “Visiting Berlin next week.”",
				undo: [
					{
						itemId: "item-5",
						prevStatus: "active",
						prevStatement: "Visiting Berlin next week.",
					},
				],
			},
		],
	},
];

function renderTimeline(overrides = {}) {
	return render(MemoryTimeline, {
		props: {
			reports,
			onUndo: vi.fn(),
			...overrides,
		},
	});
}

describe("MemoryTimeline", () => {
	it("renders report summaries newest first", () => {
		renderTimeline();

		const rows = screen.getAllByRole("listitem");
		expect(rows.length).toBe(2);
		expect(rows[0].textContent).toContain(
			"Merged 2 duplicates, then stopped early.",
		);
		expect(rows[1].textContent).toContain(
			"Renewed 1 memory, nothing else to tidy.",
		);
	});

	it("marks failed reports with a warning-tone status", () => {
		renderTimeline();

		const rows = screen.getAllByRole("listitem");
		expect(within(rows[0]).getByText("Failed")).toBeInTheDocument();
		expect(within(rows[1]).queryByText("Failed")).not.toBeInTheDocument();
	});

	it("expanding a report shows each action description with an Undo button", async () => {
		renderTimeline();

		const newest = screen.getAllByRole("listitem")[0];
		await fireEvent.click(
			within(newest).getByText("Merged 2 duplicates, then stopped early."),
		);

		expect(
			within(newest).getByText("Merged two coffee preferences into one."),
		).toBeInTheDocument();
		expect(
			within(newest).getByText("Expired “Visiting Berlin next week.”"),
		).toBeInTheDocument();
		expect(
			within(newest).getAllByRole("button", { name: "Undo" }),
		).toHaveLength(2);
	});

	it("Undo click calls onUndo(reportId, actionIndex)", async () => {
		const onUndo = vi.fn();
		renderTimeline({ onUndo });

		const newest = screen.getAllByRole("listitem")[0];
		await fireEvent.click(
			within(newest).getByText("Merged 2 duplicates, then stopped early."),
		);
		const undoButtons = within(newest).getAllByRole("button", { name: "Undo" });
		await fireEvent.click(undoButtons[1]);

		expect(onUndo).toHaveBeenCalledWith("report-new", 1);
	});

	it("disables the Undo button whose action is pending", async () => {
		renderTimeline({ pendingActionKey: "report-new:1:undo" });

		const newest = screen.getAllByRole("listitem")[0];
		await fireEvent.click(
			within(newest).getByText("Merged 2 duplicates, then stopped early."),
		);
		const undoButtons = within(newest).getAllByRole("button", { name: "Undo" });

		expect(undoButtons[1]).toBeDisabled();
		expect(undoButtons[0]).not.toBeDisabled();
	});

	it("renders a quiet empty state when there are no reports", () => {
		renderTimeline({ reports: [] });

		expect(
			screen.getByText("No memory maintenance has run yet."),
		).toBeInTheDocument();
	});

	it("is a single-open accordion: opening one report collapses the other", async () => {
		renderTimeline();

		const [newest, oldest] = screen.getAllByRole("listitem");
		await fireEvent.click(
			within(newest).getByText("Merged 2 duplicates, then stopped early."),
		);
		expect(
			within(newest).getByText("Merged two coffee preferences into one."),
		).toBeInTheDocument();

		// Opening the older report collapses the newer one.
		await fireEvent.click(
			within(oldest).getByText("Renewed 1 memory, nothing else to tidy."),
		);
		expect(
			within(oldest).getByText("Renewed “Working toward a spring launch.”"),
		).toBeInTheDocument();
		expect(
			within(newest).queryByText("Merged two coffee preferences into one."),
		).not.toBeInTheDocument();
	});

	it("shows the merge/supersede target statement when present", async () => {
		const targeted: MemoryTimelineReport[] = [
			{
				id: "report-target",
				status: "completed",
				summaryText: "Tidied up two overlapping facts.",
				createdAt: "2026-07-06T02:00:00.000Z",
				actions: [
					{
						type: "merged",
						itemIds: ["a", "b"],
						resultItemId: "c",
						resultStatement: "Prefers dark roast, black.",
						description: "Merged two coffee notes.",
						undo: [],
					},
					{
						type: "superseded",
						itemIds: ["d"],
						resultItemId: "e",
						resultStatement: "Now based in Berlin.",
						description: "Replaced an outdated location.",
						undo: [],
					},
				],
			},
		];
		renderTimeline({ reports: targeted });

		await fireEvent.click(screen.getByText("Tidied up two overlapping facts."));

		expect(
			screen.getByText(/Merged into:.*Prefers dark roast, black\./),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Superseded by:.*Now based in Berlin\./),
		).toBeInTheDocument();
	});
});
