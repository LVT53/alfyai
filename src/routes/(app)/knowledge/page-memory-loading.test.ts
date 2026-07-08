import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import type { Component } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";
import type { MemoryProfilePublicPayload } from "$lib/types";

const mockPageState = vi.hoisted(() => ({
	page: {
		url: new URL("http://localhost/knowledge"),
		state: {},
	},
}));

vi.mock("$app/environment", () => ({
	browser: true,
	building: false,
	dev: false,
	version: "test",
}));

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
	replaceState: vi.fn(),
}));

vi.mock("$app/state", () => mockPageState);

vi.mock("$lib/client/api/knowledge", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/client/api/knowledge")
	>("$lib/client/api/knowledge");
	return {
		...actual,
		fetchMemoryProfile: vi.fn(),
		fetchKnowledgeMemory: vi.fn(),
		fetchKnowledgeMemoryOverview: vi.fn(),
		fetchMemoryProfileItemDetail: vi.fn(),
		fetchMemorySummary: vi.fn(),
		fetchMemoryTimeline: vi.fn(),
		recordDocumentWorkspaceOpen: vi.fn(),
		submitKnowledgeMemoryAction: vi.fn(),
		submitMemoryV2Action: vi.fn(),
	};
});

import {
	fetchKnowledgeMemory,
	fetchKnowledgeMemoryOverview,
	fetchMemoryProfile,
	fetchMemoryProfileItemDetail,
	fetchMemorySummary,
	fetchMemoryTimeline,
	submitKnowledgeMemoryAction,
} from "$lib/client/api/knowledge";
import Page from "./+page.svelte";

const memoryProfilePayload = {
	resetGeneration: 1,
	projectionRevision: 7,
	categories: [
		{
			category: "about_you",
			items: [
				{
					id: "item-about",
					itemKey: "about-you",
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
			items: [],
		},
		{
			category: "goals_ongoing_work",
			items: [],
		},
		{
			category: "constraints_boundaries",
			items: [],
		},
	],
	review: {
		visibleItems: [
			{
				id: "review-1",
				subject: "Remember Hungarian labels.",
				question: "Should this be remembered?",
				reason: "Repeated in settings work.",
				canAccept: true,
			},
		],
		openCount: 1,
		overflowCount: 0,
	},
} satisfies MemoryProfilePublicPayload;

function pageData(): {
	documents: [];
	library: {
		documents: [];
		results: [];
		workflows: [];
		query: string;
		sort: { key: "date"; direction: "desc" };
		pagination: {
			page: number;
			pageSize: number;
			totalItems: number;
			totalPages: number;
		};
	};
	userDisplayName: string;
	initialTab: "memory" | "documents";
} {
	return {
		documents: [],
		library: {
			documents: [],
			results: [],
			workflows: [],
			query: "",
			sort: { key: "date" as const, direction: "desc" as const },
			pagination: {
				page: 1,
				pageSize: 20,
				totalItems: 0,
				totalPages: 0,
			},
		},
		userDisplayName: "Test User",
		initialTab: "memory",
	};
}

const KnowledgePage = Page as unknown as Component<{
	data: ReturnType<typeof pageData>;
}>;

describe("Knowledge page memory loading", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPageState.page.url = new URL("http://localhost/knowledge");
		vi.mocked(fetchMemoryProfile).mockResolvedValue(memoryProfilePayload);
		vi.mocked(fetchKnowledgeMemory).mockResolvedValue(memoryProfilePayload);
		vi.mocked(fetchMemoryProfileItemDetail).mockResolvedValue({
			...memoryProfilePayload.categories[0].items[0],
			sourceChips: [],
			whyRemembered: null,
		});
		vi.mocked(submitKnowledgeMemoryAction).mockResolvedValue(
			memoryProfilePayload,
		);
		vi.mocked(fetchMemorySummary).mockResolvedValue({ summary: null });
		vi.mocked(fetchMemoryTimeline).mockResolvedValue({ reports: [] });
		vi.mocked(fetchKnowledgeMemoryOverview).mockResolvedValue({
			memoryEnabled: true,
			processing: { active: false, pendingCount: 0 },
		} as Awaited<ReturnType<typeof fetchKnowledgeMemoryOverview>>);
		Object.defineProperty(document, "hidden", {
			configurable: true,
			value: false,
		});
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			callback(0);
			return 0;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("loads the projection-backed memory profile on entry and makes it the first tab", async () => {
		render(KnowledgePage, { data: pageData() });

		await waitFor(() => {
			expect(fetchMemoryProfile).toHaveBeenCalledWith();
		});
		// The projection profile is the primary source; the overview is fetched
		// best-effort only for the "memory is processing" notice (Task 3). The
		// legacy full-memory endpoint stays unused.
		expect(fetchKnowledgeMemory).not.toHaveBeenCalled();

		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(2);
		expect(tabs[0]).toHaveTextContent("Memory Profile");
		expect(tabs[0]).toHaveTextContent("1");
		expect(tabs[1]).toHaveTextContent("Documents");
		expect(
			screen.getByText("Levi prefers concise memory behavior."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /refresh|reload/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/Focus Continuity|task memory|raw/i),
		).not.toBeInTheDocument();
	});

	it("selects the documents tab from the SvelteKit route URL query", async () => {
		mockPageState.page.url = new URL("http://localhost/knowledge?q=report");

		render(KnowledgePage, { data: pageData() });
		await Promise.resolve();
		await Promise.resolve();

		expect(screen.getByRole("tab", { name: "Documents" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(
			screen.getByRole("tabpanel", { name: "Documents" }),
		).toBeInTheDocument();
		expect(fetchMemoryProfile).not.toHaveBeenCalled();
	});

	it("refreshes the memory profile when switching from Documents back to Memory Profile", async () => {
		mockPageState.page.url = new URL(
			"http://localhost/knowledge?tab=documents",
		);

		render(KnowledgePage, { data: pageData() });
		await Promise.resolve();
		await Promise.resolve();
		expect(fetchMemoryProfile).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole("tab", { name: "Memory Profile" }));

		await waitFor(() => {
			expect(fetchMemoryProfile).toHaveBeenCalledTimes(1);
		});
	});

	it("submits review item accept actions from the Needs Review controls", async () => {
		render(KnowledgePage, { data: pageData() });

		await waitFor(() => {
			expect(
				screen.getByText("Remember Hungarian labels."),
			).toBeInTheDocument();
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Remember this item" }),
		);

		expect(submitKnowledgeMemoryAction).toHaveBeenCalledWith({
			target: "review_item",
			action: "accept",
			itemId: "review-1",
			expectedProjectionRevision: 7,
		});
	});

	it("reloads the memory profile after stale projection conflicts", async () => {
		vi.mocked(submitKnowledgeMemoryAction).mockRejectedValueOnce(
			new ApiError("stale projection", {
				code: "stale_projection",
				status: 409,
			}),
		);
		render(KnowledgePage, { data: pageData() });

		await waitFor(() => {
			expect(
				screen.getByText("Remember Hungarian labels."),
			).toBeInTheDocument();
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Remember this item" }),
		);

		await waitFor(() => {
			expect(fetchMemoryProfile).toHaveBeenCalledTimes(2);
		});
		expect(
			screen.getByText(
				"Memory profile was updated. Review the latest profile and try again.",
			),
		).toBeInTheDocument();
	});

	it("shows stale projection feedback inside an open memory item dialog", async () => {
		vi.mocked(submitKnowledgeMemoryAction).mockRejectedValueOnce(
			new ApiError("stale projection", {
				code: "stale_projection",
				status: 409,
			}),
		);
		render(KnowledgePage, { data: pageData() });

		await waitFor(() => {
			expect(
				screen.getByText("Levi prefers concise memory behavior."),
			).toBeInTheDocument();
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Edit memory item" }),
		);

		const dialog = screen.getByRole("dialog", { name: "Memory item" });
		const textarea = within(dialog).getByLabelText("Statement");
		await fireEvent.input(textarea, {
			target: {
				value:
					"Levi prefers concise memory behavior with local stale feedback.",
			},
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Save memory item" }),
		);

		await waitFor(() => {
			expect(fetchMemoryProfile).toHaveBeenCalledTimes(2);
		});
		expect(
			screen.getByRole("dialog", { name: "Memory item" }),
		).toBeInTheDocument();
		expect(within(dialog).getByRole("alert")).toHaveTextContent(
			"Memory profile was updated. Review the latest profile and try again.",
		);
	});

	it("shows stale projection feedback inside an open review edit dialog", async () => {
		vi.mocked(submitKnowledgeMemoryAction).mockRejectedValueOnce(
			new ApiError("stale projection", {
				code: "stale_projection",
				status: 409,
			}),
		);
		render(KnowledgePage, { data: pageData() });

		await waitFor(() => {
			expect(
				screen.getByText("Remember Hungarian labels."),
			).toBeInTheDocument();
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Edit review item" }),
		);

		const dialog = screen.getByRole("dialog", { name: "Edit review item" });
		const textarea = within(dialog).getByLabelText("Statement");
		await fireEvent.input(textarea, {
			target: { value: "Remember Hungarian labels in UI settings." },
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Save review item" }),
		);

		await waitFor(() => {
			expect(fetchMemoryProfile).toHaveBeenCalledTimes(2);
		});
		expect(
			screen.getByRole("dialog", { name: "Edit review item" }),
		).toBeInTheDocument();
		expect(within(dialog).getByRole("alert")).toHaveTextContent(
			"Memory profile was updated. Review the latest profile and try again.",
		);
	});
});
