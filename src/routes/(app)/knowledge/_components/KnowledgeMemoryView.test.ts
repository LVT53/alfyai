import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
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
				canAccept: true,
			},
			{
				id: "review-2",
				subject: "Prefer icon actions.",
				question: "Should this be remembered?",
				reason: "UI guidance.",
				canAccept: true,
			},
			{
				id: "review-3",
				subject: "Avoid diagnostic memory tables.",
				question: "Should this be remembered?",
				reason: "Product decision.",
				canAccept: true,
			},
			{
				id: "review-4",
				subject: "Open documents from search.",
				question: "Should this be remembered?",
				reason: "Workflow signal.",
				canAccept: true,
			},
		],
		visibleItems: [
			{
				id: "review-1",
				subject: "Remember Hungarian labels.",
				question: "Should this be remembered?",
				reason: "Repeated in settings work.",
				canAccept: true,
			},
			{
				id: "review-2",
				subject: "Prefer icon actions.",
				question: "Should this be remembered?",
				reason: "UI guidance.",
				canAccept: true,
			},
			{
				id: "review-3",
				subject: "Avoid diagnostic memory tables.",
				question: "Should this be remembered?",
				reason: "Product decision.",
				canAccept: true,
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
			actionError: "",
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

	it("requires editing for review items without a safe proposed statement", () => {
		renderMemoryView({
			profile: {
				...profile,
				review: {
					...profile.review,
					items: [
						{
							id: "review-generic",
							subject: "Document-related memory request",
							question: "Should this be remembered?",
							reason: "The intake gate could not safely admit this automatically.",
							canAccept: false,
						},
					],
					visibleItems: [
						{
							id: "review-generic",
							subject: "Document-related memory request",
							question: "Should this be remembered?",
							reason: "The intake gate could not safely admit this automatically.",
							canAccept: false,
						},
					],
					openCount: 1,
					overflowCount: 0,
				},
			},
		});

		expect(screen.queryByRole("button", { name: "Remember this item" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edit review item" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Do not remember review item" }),
		).toBeInTheDocument();
	});

	it("keeps the memory item dialog open when an action reports failure", async () => {
		const onAction = vi.fn().mockResolvedValue(false);
		renderMemoryView({ onAction });

		const aboutSection = screen.getByRole("heading", { name: "About You" }).closest("section");
		expect(aboutSection).not.toBeNull();
		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Edit memory item",
			}),
		);

		const dialog = screen.getByRole("dialog", { name: "Memory item" });
		const textarea = within(dialog).getByLabelText("Statement");
		await fireEvent.input(textarea, {
			target: { value: "Levi prefers concise memory behavior with stale-safe edits." },
		});
		await fireEvent.click(within(dialog).getByRole("button", { name: "Save memory item" }));

		expect(onAction).toHaveBeenCalledWith({
			action: "edit",
			itemId: "item-about",
			statement: "Levi prefers concise memory behavior with stale-safe edits.",
			expectedProjectionRevision: 7,
		});
		expect(screen.getByRole("dialog", { name: "Memory item" })).toBeInTheDocument();
	});

	it("closes review overflow before opening a review edit dialog", async () => {
		renderMemoryView();

		await fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
		const overflowDialog = screen.getByRole("dialog", { name: "Needs Review" });
		await fireEvent.click(
			within(overflowDialog).getAllByRole("button", {
				name: "Edit review item",
			})[0],
		);

		expect(screen.queryByRole("dialog", { name: "Needs Review" })).not.toBeInTheDocument();
		expect(screen.getByRole("dialog", { name: "Edit review item" })).toBeInTheDocument();
	});

	it("focuses, traps, closes, and restores focus for the review overflow dialog", async () => {
		renderMemoryView();

		const opener = screen.getByRole("button", { name: "+1 more" });
		opener.focus();
		await fireEvent.click(opener);

		const dialog = screen.getByRole("dialog", { name: "Needs Review" });
		await waitFor(() => {
			expect(dialog).toContainElement(document.activeElement as HTMLElement);
		});

		const buttons = within(dialog)
			.getAllByRole("button")
			.filter((button) => !button.hasAttribute("disabled"));
		const firstButton = buttons[0];
		const lastButton = buttons[buttons.length - 1];
		lastButton.focus();
		await fireEvent.keyDown(window, { key: "Tab" });
		expect(firstButton).toHaveFocus();

		await fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Needs Review" })).not.toBeInTheDocument();
		});
		expect(opener).toHaveFocus();
	});

	it("focuses review edits and restores focus after Escape", async () => {
		renderMemoryView();

		const editButton = screen.getAllByRole("button", { name: "Edit review item" })[0];
		editButton.focus();
		await fireEvent.click(editButton);

		const dialog = screen.getByRole("dialog", { name: "Edit review item" });
		const textarea = within(dialog).getByLabelText("Statement");
		await waitFor(() => {
			expect(textarea).toHaveFocus();
		});

		await fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Edit review item" })).not.toBeInTheDocument();
		});
		expect(editButton).toHaveFocus();
	});

	it("keeps focus inside the memory item dialog and restores it on Escape", async () => {
		renderMemoryView();

		const aboutSection = screen.getByRole("heading", { name: "About You" }).closest("section");
		expect(aboutSection).not.toBeNull();
		const editButton = within(aboutSection as HTMLElement).getByRole("button", {
			name: "Edit memory item",
		});
		editButton.focus();
		await fireEvent.click(editButton);

		const dialog = screen.getByRole("dialog", { name: "Memory item" });
		const textarea = within(dialog).getByLabelText("Statement");
		await waitFor(() => {
			expect(textarea).toHaveFocus();
		});

		const buttons = within(dialog)
			.getAllByRole("button")
			.filter((button) => !button.hasAttribute("disabled"));
		const firstButton = buttons[0];
		const lastButton = buttons[buttons.length - 1];
		lastButton.focus();
		await fireEvent.keyDown(window, { key: "Tab" });
		expect(firstButton).toHaveFocus();

		await fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Memory item" })).not.toBeInTheDocument();
		});
		expect(editButton).toHaveFocus();
	});
});
