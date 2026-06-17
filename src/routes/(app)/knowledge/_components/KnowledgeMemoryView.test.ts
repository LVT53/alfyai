import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { MemoryProfilePublicPayload } from "$lib/types";
import KnowledgeMemoryView from "./KnowledgeMemoryView.svelte";

const profile = {
	resetGeneration: 1,
	projectionRevision: 7,
	categories: [
		{
			category: "about_you",
			items: [
				{
					id: "item-about",
					itemKey: "about",
					category: "about_you",
					statement: "Levi prefers concise memory behavior.",
					scope: { type: "global" },
					status: "active",
					revision: 1,
					updatedAt: "2026-06-17T09:00:00.000Z",
					canEdit: true,
					canDelete: true,
					canSuppress: true,
				},
			],
		},
		{
			category: "preferences",
			items: [
				{
					id: "item-preference",
					itemKey: "preference",
					category: "preferences",
					statement: "Levi likes compact, actionable UI.",
					scope: { type: "project", id: "project-1" },
					status: "active",
					revision: 1,
					updatedAt: "2026-06-17T09:00:00.000Z",
					canEdit: true,
					canDelete: true,
					canSuppress: true,
				},
			],
		},
		{ category: "goals_ongoing_work", items: [] },
		{ category: "constraints_boundaries", items: [] },
	],
	review: {
		items: [
			{
				id: "review-1",
				subject: "Remember Hungarian labels.",
				question: "Should this be remembered?",
				reason: "Repeated in settings work.",
			},
			{
				id: "review-2",
				subject: "Prefer icon actions.",
				question: "Should this be remembered?",
				reason: "UI guidance.",
			},
			{
				id: "review-3",
				subject: "Avoid diagnostic memory tables.",
				question: "Should this be remembered?",
				reason: "Product decision.",
			},
			{
				id: "review-4",
				subject: "Open documents from search.",
				question: "Should this be remembered?",
				reason: "Workflow signal.",
			},
		],
		visibleItems: [
			{
				id: "review-1",
				subject: "Remember Hungarian labels.",
				question: "Should this be remembered?",
				reason: "Repeated in settings work.",
			},
			{
				id: "review-2",
				subject: "Prefer icon actions.",
				question: "Should this be remembered?",
				reason: "UI guidance.",
			},
			{
				id: "review-3",
				subject: "Avoid diagnostic memory tables.",
				question: "Should this be remembered?",
				reason: "Product decision.",
			},
		],
		openCount: 4,
		overflowCount: 1,
	},
} satisfies MemoryProfilePublicPayload;

function renderMemoryView(overrides = {}) {
	return render(KnowledgeMemoryView, {
		props: {
			profile,
			memoryLoading: false,
			memoryLoaded: true,
			memoryLoadError: "",
			pendingActionKey: null,
			onRetryLoadMemory: vi.fn(),
			onAction: vi.fn(),
			...overrides,
		},
	});
}

describe("KnowledgeMemoryView", () => {
	it("renders four projection categories and limits Needs Review to three visible items", () => {
		renderMemoryView();

		expect(screen.getByRole("heading", { name: "About You" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Goals & Ongoing Work" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Constraints & Boundaries" }),
		).toBeInTheDocument();
		expect(screen.getByText("Levi prefers concise memory behavior.")).toBeInTheDocument();
		expect(screen.getByText("Levi likes compact, actionable UI.")).toBeInTheDocument();
		expect(screen.queryByText("Global")).not.toBeInTheDocument();
		expect(screen.getByText("Project")).toBeInTheDocument();

		const review = screen.getByRole("heading", { name: "Needs Review" }).closest("div");
		expect(review).not.toBeNull();
		expect(screen.getByText("Remember Hungarian labels.")).toBeInTheDocument();
		expect(screen.getByText("Prefer icon actions.")).toBeInTheDocument();
		expect(screen.getByText("Avoid diagnostic memory tables.")).toBeInTheDocument();
		expect(screen.queryByText("Open documents from search.")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "+1 more" })).toBeInTheDocument();
		expect(
			screen.queryByText(/Focus Continuity|task memory|raw/i),
		).not.toBeInTheDocument();
	});

	it("sends projection revision protected actions from icon controls", async () => {
		const onAction = vi.fn();
		renderMemoryView({ onAction });

		const aboutSection = screen.getByRole("heading", { name: "About You" }).closest("section");
		expect(aboutSection).not.toBeNull();
		const deleteButton = within(aboutSection as HTMLElement).getByRole("button", {
			name: "Delete memory item",
		});
		await fireEvent.click(deleteButton);

		expect(onAction).toHaveBeenCalledWith({
			target: "profile_item",
			action: "delete",
			itemId: "item-about",
			expectedProjectionRevision: 7,
		});
	});

	it("sends review target actions from inline and overflow icon controls", async () => {
		const onAction = vi.fn();
		renderMemoryView({ onAction });

		await fireEvent.click(
			screen.getAllByRole("button", { name: "Remember this item" })[0],
		);
		expect(onAction).toHaveBeenCalledWith({
			target: "review_item",
			action: "accept",
			itemId: "review-1",
			expectedProjectionRevision: 7,
		});

		await fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
		const dialog = screen.getByRole("dialog", { name: "Needs Review" });
		expect(within(dialog).getByText("Open documents from search.")).toBeInTheDocument();

		await fireEvent.click(
			within(dialog).getAllByRole("button", {
				name: "Do not remember review item",
			})[3],
		);
		expect(onAction).toHaveBeenCalledWith({
			target: "review_item",
			action: "suppress",
			itemId: "review-4",
			expectedProjectionRevision: 7,
		});
	});
});
