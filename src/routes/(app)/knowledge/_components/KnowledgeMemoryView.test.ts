import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryProfilePublicPayload } from "$lib/types";
import KnowledgeMemoryView from "./KnowledgeMemoryView.svelte";

const { fetchMemoryProfileItemDetailMock } = vi.hoisted(() => ({
	fetchMemoryProfileItemDetailMock: vi.fn(),
}));

vi.mock("$lib/client/api/knowledge", () => ({
	fetchMemoryProfileItemDetail: fetchMemoryProfileItemDetailMock,
}));

const profile: MemoryProfilePublicPayload = {
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
};

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
	beforeEach(() => {
		fetchMemoryProfileItemDetailMock.mockReset();
		fetchMemoryProfileItemDetailMock.mockImplementation(
			async (itemId: string) => {
				const item = profile.categories
					.flatMap((group) => group.items)
					.find((candidate) => candidate.id === itemId);
				return {
					...(item ?? profile.categories[0]?.items[0]),
					sourceChips: [
						{
							id: "source-1",
							sourceType: "user_statement",
							label: "Chat",
							summary: "User said this directly.",
						},
					],
					whyRemembered: "User said this directly.",
				};
			},
		);
	});

	it("renders the persona summary card above the categories with the summary text", () => {
		renderMemoryView({
			summary: {
				text: "Levi is building AlfyAI and prefers concise answers.",
				updatedAt: "2026-07-06T22:00:00.000Z",
			},
		});

		expect(
			screen.getByRole("heading", { name: "What I remember about you" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Levi is building AlfyAI and prefers concise answers."),
		).toBeInTheDocument();
	});

	it("renders the night-shift timeline section with its reports", () => {
		renderMemoryView({
			timelineReports: [
				{
					id: "report-1",
					status: "completed",
					summaryText: "Renewed one memory overnight.",
					createdAt: "2026-07-05T02:00:00.000Z",
					actions: [],
				},
			],
		});

		expect(
			screen.getByRole("heading", { name: "While you were away" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Renewed one memory overnight."),
		).toBeInTheDocument();
	});

	it("shows a filled confidence dot for stated facts and a hollow one for inferred facts", () => {
		renderMemoryView({
			profile: {
				...profile,
				categories: profile.categories.map((group) =>
					group.category === "about_you"
						? {
								...group,
								items: [
									{ ...group.items[0], confidence: "stated" as const },
									{
										...group.items[0],
										id: "item-inferred",
										itemKey: "inferred",
										statement: "Probably enjoys hiking.",
										confidence: "inferred" as const,
									},
								],
							}
						: group,
				),
			},
		});

		const statedDot = screen.getByRole("img", { name: "Stated by you" });
		const inferredDot = screen.getByRole("img", {
			name: "Inferred from conversation",
		});
		expect(statedDot).toHaveClass("memory-confidence-dot--stated");
		expect(inferredDot).toHaveClass("memory-confidence-dot--inferred");
	});

	it("shows an expiry chip when a fact has expiresAt", () => {
		renderMemoryView({
			profile: {
				...profile,
				categories: profile.categories.map((group) =>
					group.category === "about_you"
						? {
								...group,
								items: [
									{
										...group.items[0],
										expiresAt: "2026-09-01T00:00:00.000Z",
									},
								],
							}
						: group,
				),
			},
		});

		expect(screen.getByText(/expires /)).toBeInTheDocument();
	});

	it("offers Retire in the Remove modal for profile items and dispatches onRetire", async () => {
		const onRetire = vi.fn();
		renderMemoryView({ onRetire });

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		);
		const dialog = screen.getByRole("dialog", { name: "Remove this memory?" });
		await fireEvent.click(
			within(dialog).getByRole("button", { name: /Retire/ }),
		);

		expect(onRetire).toHaveBeenCalledWith("item-about");
		await waitFor(() => {
			expect(
				screen.queryByRole("dialog", { name: "Remove this memory?" }),
			).not.toBeInTheDocument();
		});
	});

	it("keeps the Remove modal open when retire fails", async () => {
		const onRetire = vi.fn().mockResolvedValue(false);
		renderMemoryView({ onRetire });

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		);
		const dialog = screen.getByRole("dialog", { name: "Remove this memory?" });
		await fireEvent.click(
			within(dialog).getByRole("button", { name: /Retire/ }),
		);

		expect(onRetire).toHaveBeenCalledWith("item-about");
		// Failed retire follows the Forget/Delete contract: the modal stays open.
		expect(
			screen.getByRole("dialog", { name: "Remove this memory?" }),
		).toBeInTheDocument();
	});

	it("disables the Retire option while the retire action is pending", async () => {
		renderMemoryView({
			onRetire: vi.fn(),
			pendingActionKey: "item-about:retire",
		});

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		);
		const dialog = screen.getByRole("dialog", { name: "Remove this memory?" });
		expect(
			within(dialog).getByRole("button", { name: /Retire/ }),
		).toBeDisabled();
	});

	it("does not offer Retire without an onRetire handler or for review items", async () => {
		const onRetire = vi.fn();
		renderMemoryView({ onRetire });

		// Review items route through the same modal but must not offer Retire.
		const reviewSection = screen
			.getByRole("heading", { name: "Needs Review" })
			.closest("section");
		await fireEvent.click(
			within(reviewSection as HTMLElement).getAllByRole("button", {
				name: "Remove this memory",
			})[0],
		);
		const dialog = screen.getByRole("dialog", { name: "Remove this memory?" });
		expect(
			within(dialog).queryByRole("button", { name: /Retire/ }),
		).not.toBeInTheDocument();
	});

	it("shows an auto-expiry countdown on review items that carry expiresAt", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
		try {
			renderMemoryView({
				profile: {
					...profile,
					review: {
						...profile.review,
						visibleItems: [
							{
								...profile.review.visibleItems[0],
								expiresAt: "2026-07-16T00:00:00.000Z",
							},
						],
						items: undefined,
						openCount: 1,
						overflowCount: 0,
					},
				},
			});

			expect(screen.getByText("auto-expires in 10 days")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the singular form when the countdown is one day", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
		try {
			renderMemoryView({
				profile: {
					...profile,
					review: {
						...profile.review,
						visibleItems: [
							{
								...profile.review.visibleItems[0],
								expiresAt: "2026-07-07T00:00:00.000Z",
							},
						],
						items: undefined,
						openCount: 1,
						overflowCount: 0,
					},
				},
			});

			expect(screen.getByText("auto-expires in 1 day")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders an explainer hint and settings link beneath each empty category state", () => {
		renderMemoryView();

		// goals_ongoing_work and constraints_boundaries are empty in the fixture.
		const goalsSection = screen
			.getByRole("heading", { name: "Goals & Ongoing Work" })
			.closest("section");
		const constraintsSection = screen
			.getByRole("heading", { name: "Constraints & Boundaries" })
			.closest("section");
		expect(goalsSection).not.toBeNull();
		expect(constraintsSection).not.toBeNull();

		// The generic explainer hint renders below each empty state.
		expect(
			within(goalsSection as HTMLElement).getByText(
				/builds these from your chats/i,
			),
		).toBeInTheDocument();
		expect(
			within(constraintsSection as HTMLElement).getByText(
				/builds these from your chats/i,
			),
		).toBeInTheDocument();

		// A link to the memory settings section is present.
		const goalsLink = within(goalsSection as HTMLElement).getByRole("link", {
			name: /memory settings/i,
		});
		expect(goalsLink).toHaveAttribute("href", "/settings?section=memory");
	});

	it("does not render the explainer hint for categories that have items", () => {
		renderMemoryView();

		// about_you has one item — no empty hint should be shown.
		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		expect(aboutSection).not.toBeNull();
		expect(
			within(aboutSection as HTMLElement).queryByText(
				/builds these from your chats/i,
			),
		).not.toBeInTheDocument();
	});

	it("renders four projection categories and limits Needs Review to three visible items", () => {
		renderMemoryView();

		expect(
			screen.getByRole("heading", { name: "About You" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Preferences" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Goals & Ongoing Work" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Constraints & Boundaries" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Levi prefers concise memory behavior."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Levi likes compact, actionable UI."),
		).toBeInTheDocument();
		expect(screen.queryByText("Global")).not.toBeInTheDocument();
		expect(screen.getByText("Project")).toBeInTheDocument();

		const review = screen
			.getByRole("heading", { name: "Needs Review" })
			.closest("section");
		expect(review).not.toBeNull();
		expect(review).toHaveClass("memory-review-section");
		expect(review?.querySelector(".memory-review-card")).not.toBeNull();
		expect(screen.getByText("Remember Hungarian labels.")).toBeInTheDocument();
		expect(screen.getByText("Prefer icon actions.")).toBeInTheDocument();
		expect(
			screen.getByText("Avoid diagnostic memory tables."),
		).toBeInTheDocument();
		expect(screen.getAllByText("Should this be remembered?")).toHaveLength(3);
		expect(
			screen.queryByText("Open documents from search."),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "+1 more" })).toBeInTheDocument();
		expect(
			screen.queryByText(/Focus Continuity|task memory|raw/i),
		).not.toBeInTheDocument();
	});

	it("defensively caps server-provided visible review items to three", () => {
		renderMemoryView({
			profile: {
				...profile,
				review: {
					...profile.review,
					visibleItems: profile.review.items,
					overflowCount: 0,
				},
			},
		});

		expect(screen.getByText("Remember Hungarian labels.")).toBeInTheDocument();
		expect(screen.getByText("Prefer icon actions.")).toBeInTheDocument();
		expect(
			screen.getByText("Avoid diagnostic memory tables."),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Open documents from search."),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "+1 more" })).toBeInTheDocument();
	});

	it("keeps active category sections visually capped after four items", () => {
		renderMemoryView({
			profile: {
				...profile,
				categories: profile.categories.map((group) =>
					group.category === "about_you"
						? {
								...group,
								items: Array.from({ length: 5 }, (_, index) => ({
									id: `about-${index + 1}`,
									itemKey: `about-${index + 1}`,
									category: "about_you" as const,
									statement: `About memory ${index + 1}.`,
									scope: { type: "global" as const },
									status: "active" as const,
									revision: 1,
									updatedAt: "2026-06-17T09:00:00.000Z",
									canEdit: true,
									canDelete: true,
									canSuppress: true,
								})),
							}
						: group,
				),
			},
		});

		const fifthItem = screen.getByText("About memory 5.");
		const scrollList = fifthItem.closest(".grid");

		expect(fifthItem).toBeInTheDocument();
		expect(scrollList).toHaveClass("overflow-y-auto");
	});

	it("shows a single Remove entry point and no standalone suppress or delete on the row", () => {
		renderMemoryView();

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		expect(aboutSection).not.toBeNull();

		// Exactly one Remove (trash) entry point per inline card.
		expect(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		).toBeInTheDocument();

		// No standalone instant suppress-X or delete-trash on the row.
		expect(
			within(aboutSection as HTMLElement).queryByRole("button", {
				name: "Do not remember memory item",
			}),
		).not.toBeInTheDocument();
		expect(
			within(aboutSection as HTMLElement).queryByRole("button", {
				name: "Delete memory item",
			}),
		).not.toBeInTheDocument();
	});

	it("opens a confirm modal from the Remove button showing the memory and options", async () => {
		renderMemoryView();

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		expect(aboutSection).not.toBeNull();
		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		);

		const dialog = screen.getByRole("dialog", { name: "Remove this memory?" });
		// The memory statement is quoted for context inside the modal.
		expect(
			within(dialog).getByText(/Levi prefers concise memory behavior\./),
		).toBeInTheDocument();
		// Both Forget and Delete permanently are offered for delete-capable items.
		expect(
			within(dialog).getByRole("button", { name: /Forget/ }),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: /Delete permanently/ }),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Cancel" }),
		).toBeInTheDocument();
	});

	it("dispatches suppress on Forget and delete on Delete permanently from the modal", async () => {
		const onAction = vi.fn();
		renderMemoryView({ onAction });

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		expect(aboutSection).not.toBeNull();
		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		);
		const dialog = screen.getByRole("dialog", { name: "Remove this memory?" });

		await fireEvent.click(
			within(dialog).getByRole("button", { name: /Delete permanently/ }),
		);
		expect(onAction).toHaveBeenCalledWith({
			target: "profile_item",
			action: "delete",
			itemId: "item-about",
			expectedProjectionRevision: 7,
		});

		// Cancel the first modal, then verify Forget dispatches suppress.
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);
		await waitFor(() => {
			expect(
				screen.queryByRole("dialog", { name: "Remove this memory?" }),
			).not.toBeInTheDocument();
		});

		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		);
		const reopenedDialog = screen.getByRole("dialog", {
			name: "Remove this memory?",
		});
		await fireEvent.click(
			within(reopenedDialog).getByRole("button", { name: /Forget/ }),
		);
		expect(onAction).toHaveBeenCalledWith({
			target: "profile_item",
			action: "suppress",
			itemId: "item-about",
			expectedProjectionRevision: 7,
		});
	});

	it("closes the confirm modal harmlessly on Cancel without dispatching", async () => {
		const onAction = vi.fn();
		renderMemoryView({ onAction });

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		expect(aboutSection).not.toBeNull();
		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		);
		const dialog = screen.getByRole("dialog", { name: "Remove this memory?" });
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);

		await waitFor(() => {
			expect(
				screen.queryByRole("dialog", { name: "Remove this memory?" }),
			).not.toBeInTheDocument();
		});
		expect(onAction).not.toHaveBeenCalled();
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
		expect(
			within(dialog).getByText("Open documents from search."),
		).toBeInTheDocument();
		expect(within(dialog).getByText("Workflow signal.")).toBeInTheDocument();

		// Review items route their suppress action through the Remove modal.
		await fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Remove this memory",
			}),
		);
		const removeDialog = screen.getByRole("dialog", {
			name: "Remove this memory?",
		});
		// Review items only support Forget (suppress) — Delete is not offered.
		expect(
			within(removeDialog).queryByRole("button", {
				name: /Delete permanently/,
			}),
		).not.toBeInTheDocument();
		await fireEvent.click(
			within(removeDialog).getByRole("button", { name: /Forget/ }),
		);
		expect(onAction).toHaveBeenCalledWith({
			target: "review_item",
			action: "suppress",
			itemId: "review-4",
			expectedProjectionRevision: 7,
		});
	});

	it("shows only additional review items in the overflow dialog", async () => {
		renderMemoryView();

		await fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
		const dialog = screen.getByRole("dialog", { name: "Needs Review" });

		expect(
			within(dialog).queryByText("Remember Hungarian labels."),
		).not.toBeInTheDocument();
		expect(
			within(dialog).queryByText("Prefer icon actions."),
		).not.toBeInTheDocument();
		expect(
			within(dialog).queryByText("Avoid diagnostic memory tables."),
		).not.toBeInTheDocument();
		expect(
			within(dialog).getByText("Open documents from search."),
		).toBeInTheDocument();
		expect(
			within(dialog).getAllByText("Should this be remembered?"),
		).toHaveLength(1);
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
							reason:
								"The intake gate could not safely admit this automatically.",
							canAccept: false,
						},
					],
					visibleItems: [
						{
							id: "review-generic",
							subject: "Document-related memory request",
							question: "Should this be remembered?",
							reason:
								"The intake gate could not safely admit this automatically.",
							canAccept: false,
						},
					],
					openCount: 1,
					overflowCount: 0,
				},
			},
		});

		const reviewSection = screen
			.getByRole("heading", { name: "Needs Review" })
			.closest("section");
		expect(
			screen.queryByRole("button", { name: "Remember this item" }),
		).not.toBeInTheDocument();
		expect(
			within(reviewSection as HTMLElement).getByRole("button", {
				name: "Edit review item",
			}),
		).toBeInTheDocument();
		expect(
			within(reviewSection as HTMLElement).getByRole("button", {
				name: "Remove this memory",
			}),
		).toBeInTheDocument();
	});

	it("keeps the memory item dialog open when an action reports failure", async () => {
		const onAction = vi.fn().mockResolvedValue(false);
		renderMemoryView({ onAction });

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		expect(aboutSection).not.toBeNull();
		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Edit memory item",
			}),
		);

		const dialog = screen.getByRole("dialog", { name: "Memory item" });
		await waitFor(() => {
			expect(
				within(dialog).getByText("Chat: User said this directly."),
			).toBeInTheDocument();
		});
		expect(
			within(dialog).queryByRole("button", { name: "Do not remember" }),
		).not.toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Cancel editing" }),
		).toBeInTheDocument();
		const textarea = within(dialog).getByLabelText("Statement");
		await fireEvent.input(textarea, {
			target: {
				value: "Levi prefers concise memory behavior with stale-safe edits.",
			},
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Save memory item" }),
		);

		expect(onAction).toHaveBeenCalledWith({
			action: "edit",
			itemId: "item-about",
			statement: "Levi prefers concise memory behavior with stale-safe edits.",
			expectedProjectionRevision: 7,
		});
		expect(
			screen.getByRole("dialog", { name: "Memory item" }),
		).toBeInTheDocument();
	});

	it("opens read-only memory item details without edit-only controls", async () => {
		const readOnlyProfile: MemoryProfilePublicPayload = {
			...profile,
			categories: profile.categories.map((group) =>
				group.category === "about_you"
					? {
							...group,
							items: [
								{
									...group.items[0],
									id: "item-readonly",
									statement: "Read-only memory still has detail.",
									scope: { type: "document", id: "doc-1" },
									canEdit: false,
									canDelete: false,
									canSuppress: false,
								},
							],
						}
					: group,
			),
		};
		fetchMemoryProfileItemDetailMock.mockResolvedValueOnce({
			...readOnlyProfile.categories[0].items[0],
			sourceChips: [
				{
					id: "source-1",
					sourceType: "document",
					label: "Project brief",
					summary: "Imported project note.",
				},
			],
			whyRemembered: "Document-specific workflow rule.",
		});

		renderMemoryView({ profile: readOnlyProfile });

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
		expect(aboutSection).not.toBeNull();
		expect(
			within(aboutSection as HTMLElement).queryByRole("button", {
				name: "Edit memory item",
			}),
		).not.toBeInTheDocument();

		await fireEvent.click(
			within(aboutSection as HTMLElement).getByRole("button", {
				name: "Memory item",
			}),
		);

		const dialog = screen.getByRole("dialog", { name: "Memory item" });
		await waitFor(() => {
			expect(
				within(dialog).getByText("Scope: Document doc-1"),
			).toBeInTheDocument();
		});

		expect(
			within(dialog).getByText("Read-only memory still has detail."),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText("Why: Document-specific workflow rule."),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText("Project brief: Imported project note."),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByLabelText("Statement"),
		).not.toBeInTheDocument();
		expect(
			within(dialog).queryByRole("button", { name: "Save memory item" }),
		).not.toBeInTheDocument();
		expect(
			within(dialog).queryByRole("button", { name: "Delete memory item" }),
		).not.toBeInTheDocument();
	});

	it("shows full scope, why summary, and capped expandable sources in the memory item dialog", async () => {
		fetchMemoryProfileItemDetailMock.mockResolvedValueOnce({
			...profile.categories[1].items[0],
			sourceChips: [
				{
					id: "source-1",
					sourceType: "user_statement",
					label: "Chat",
					summary: "User said this directly.",
				},
				{
					id: "source-2",
					sourceType: "document",
					label: "Project brief",
					summary: "Imported project note.",
				},
				{
					id: "source-3",
					sourceType: "conversation",
					label: "Follow-up",
					summary: "Repeated in chat.",
				},
				{
					id: "source-4",
					sourceType: "document",
					label: "Design notes",
					summary: "Confirmed by design notes.",
				},
			],
			whyRemembered: "Repeated preference across UI planning work.",
		});
		renderMemoryView();

		const preferenceSection = screen
			.getByRole("heading", { name: "Preferences" })
			.closest("section");
		expect(preferenceSection).not.toBeNull();
		await fireEvent.click(
			within(preferenceSection as HTMLElement).getByRole("button", {
				name: "Edit memory item",
			}),
		);

		const dialog = screen.getByRole("dialog", { name: "Memory item" });
		await waitFor(() => {
			expect(
				within(dialog).getByText("Scope: Project project-1"),
			).toBeInTheDocument();
		});

		expect(
			within(dialog).getByText(
				"Why: Repeated preference across UI planning work.",
			),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText("Chat: User said this directly."),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText("Project brief: Imported project note."),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText("Follow-up: Repeated in chat."),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByText("Design notes: Confirmed by design notes."),
		).not.toBeInTheDocument();

		expect(within(dialog).getByText("+1 sources")).toBeInTheDocument();
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Show 1 more sources" }),
		);
		expect(
			within(dialog).getByText("Design notes: Confirmed by design notes."),
		).toBeInTheDocument();
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

		expect(
			screen.queryByRole("dialog", { name: "Needs Review" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("dialog", { name: "Edit review item" }),
		).toBeInTheDocument();
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
			expect(
				screen.queryByRole("dialog", { name: "Needs Review" }),
			).not.toBeInTheDocument();
		});
		expect(opener).toHaveFocus();
	});

	it("focuses review edits and restores focus after Escape", async () => {
		renderMemoryView();

		const editButton = screen.getAllByRole("button", {
			name: "Edit review item",
		})[0];
		editButton.focus();
		await fireEvent.click(editButton);

		const dialog = screen.getByRole("dialog", { name: "Edit review item" });
		const textarea = within(dialog).getByLabelText("Statement");
		await waitFor(() => {
			expect(textarea).toHaveFocus();
		});

		await fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => {
			expect(
				screen.queryByRole("dialog", { name: "Edit review item" }),
			).not.toBeInTheDocument();
		});
		expect(editButton).toHaveFocus();
	});

	it("keeps focus inside the memory item dialog and restores it on Escape", async () => {
		renderMemoryView();

		const aboutSection = screen
			.getByRole("heading", { name: "About You" })
			.closest("section");
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
			expect(
				screen.queryByRole("dialog", { name: "Memory item" }),
			).not.toBeInTheDocument();
		});
		expect(editButton).toHaveFocus();
	});

	it("shows an in-progress notice only when processing is active", () => {
		const { rerender } = renderMemoryView({
			processing: { active: false, pendingCount: 0 },
		});
		expect(screen.queryByText(/Updating your memory/i)).not.toBeInTheDocument();

		rerender({
			profile,
			memoryLoading: false,
			memoryLoaded: true,
			memoryLoadError: "",
			pendingActionKey: null,
			actionError: "",
			onRetryLoadMemory: vi.fn(),
			onAction: vi.fn(),
			processing: { active: true, pendingCount: 3 },
		});
		expect(screen.getByText(/3 updates in progress/i)).toBeInTheDocument();
	});

	it("falls back to the single-line notice when operations is an empty array", () => {
		renderMemoryView({
			processing: { active: true, pendingCount: 2, operations: [] },
		});
		expect(screen.getByText(/2 updates in progress/i)).toBeInTheDocument();
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
	});

	it("renders a friendly per-reason line with a count for each processing operation", () => {
		renderMemoryView({
			processing: {
				active: true,
				pendingCount: 2,
				operations: [
					{
						reason: "deferred_intake",
						scope: { type: "conversation", id: "c1" },
						count: 3,
					},
					{
						reason: "possible_conflict",
						scope: { type: "project", id: "p1" },
						count: 1,
					},
				],
			},
		});

		const notice = screen.getByRole("status");
		expect(
			within(notice).getByText(
				/Reviewing new details from your recent conversations/i,
			),
		).toBeInTheDocument();
		expect(within(notice).getByText(/3 items/i)).toBeInTheDocument();
		expect(
			within(notice).getByText(/Resolving a possible conflict/i),
		).toBeInTheDocument();
		// Project-scoped operation gets a scope hint; a count of 1 shouldn't
		// render a redundant "1 items" suffix.
		expect(within(notice).getByText(/for this project/i)).toBeInTheDocument();
		expect(within(notice).queryByText(/1 items/i)).not.toBeInTheDocument();
		expect(within(notice).getByRole("list")).toBeInTheDocument();
	});

	it("does not render raw fact text for processing operations — only reason/scope/count-derived copy", () => {
		renderMemoryView({
			processing: {
				active: true,
				pendingCount: 1,
				operations: [
					{
						reason: "deferred_intake",
						scope: { type: "conversation", id: "c1" },
						count: 1,
					},
				],
			},
		});
		const notice = screen.getByRole("status");
		expect(notice.textContent).not.toContain("c1");
	});
});
