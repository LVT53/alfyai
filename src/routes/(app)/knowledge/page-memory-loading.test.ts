import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { Component } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	MemoryProfilePublicPayload,
} from "$lib/types";

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
		recordDocumentWorkspaceOpen: vi.fn(),
		submitKnowledgeMemoryAction: vi.fn(),
	};
});

import {
	fetchMemoryProfile,
	fetchKnowledgeMemory,
	fetchKnowledgeMemoryOverview,
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
	honchoEnabled: boolean;
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
		honchoEnabled: true,
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
		vi.mocked(submitKnowledgeMemoryAction).mockResolvedValue(memoryProfilePayload);
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
		expect(fetchKnowledgeMemoryOverview).not.toHaveBeenCalled();
		expect(fetchKnowledgeMemory).not.toHaveBeenCalled();

		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
			"Memory Profile",
			"Documents",
		]);
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

	it("selects the documents tab from the SvelteKit route URL query", () => {
		mockPageState.page.url = new URL("http://localhost/knowledge?q=report");

		render(KnowledgePage, { data: pageData() });

		expect(screen.getByRole("tab", { name: "Documents" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("tabpanel", { name: "Documents" })).toBeInTheDocument();
	});

	it("submits review item accept actions from the Needs Review controls", async () => {
		render(KnowledgePage, { data: pageData() });

		await waitFor(() => {
			expect(screen.getByText("Remember Hungarian labels.")).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByRole("button", { name: "Remember this item" }));

		expect(submitKnowledgeMemoryAction).toHaveBeenCalledWith({
			target: "review_item",
			action: "accept",
			itemId: "review-1",
			expectedProjectionRevision: 7,
		});
	});

});
