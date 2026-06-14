import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	KnowledgeMemoryOverviewPayload,
	KnowledgeMemoryPayload,
} from "$lib/types";

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

vi.mock("$app/state", () => ({
	page: {
		url: new URL("http://localhost/knowledge"),
		state: {},
	},
}));

vi.mock("$lib/client/api/knowledge", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/client/api/knowledge")
	>("$lib/client/api/knowledge");
	return {
		...actual,
		fetchKnowledgeMemory: vi.fn(),
		fetchKnowledgeMemoryOverview: vi.fn(),
		recordDocumentWorkspaceOpen: vi.fn(),
	};
});

import {
	fetchKnowledgeMemory,
	fetchKnowledgeMemoryOverview,
} from "$lib/client/api/knowledge";
import Page from "./+page.svelte";

const memoryOverviewPayload = {
	summary: {
		personaCount: 2,
		taskCount: 0,
		focusContinuityCount: 0,
		activeConstraintCount: 0,
		currentProjectContextCount: 0,
		overview: "The user prefers concise memory behavior.",
		overviewBullets: ["The user prefers concise memory behavior."],
		overviewSource: "honcho_scoped",
		overviewStatus: "ready",
		overviewUpdatedAt: 1_700_000_000_000,
		overviewLastAttemptAt: 1_700_000_000_000,
		durablePersonaCount: 2,
	},
} satisfies KnowledgeMemoryOverviewPayload;

const fallbackMemoryOverviewPayload = {
	summary: {
		...memoryOverviewPayload.summary,
		overview: "Fallback memory.",
		overviewBullets: ["Fallback memory."],
		overviewSource: "persona_fallback",
		overviewStatus: "temporarily_unavailable",
	},
} satisfies KnowledgeMemoryOverviewPayload;

const fullMemoryPayload = {
	personaMemories: [
		{
			id: "persona-1",
			canonicalText: "The user prefers concise responses.",
			rawCanonicalText: "The user prefers concise responses.",
			domain: "persona",
			memoryClass: "long_term_context",
			state: "active",
			salienceScore: 50,
			sourceCount: 1,
			conversationTitles: [],
			firstSeenAt: 1_700_000_000_000,
			lastSeenAt: 1_700_000_000_000,
			pinned: false,
			temporal: null,
			activeConstraint: false,
			topicKey: null,
			topicStatus: "active",
			supersededById: null,
			supersessionReason: null,
			members: [],
		},
	],
	activeConstraints: [],
	currentProjectContext: [],
	taskMemories: [],
	focusContinuities: [],
	summary: memoryOverviewPayload.summary,
} satisfies KnowledgeMemoryPayload;

function pageData() {
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
	};
}

describe("Knowledge page memory loading", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchKnowledgeMemoryOverview).mockResolvedValue(
			memoryOverviewPayload,
		);
		vi.mocked(fetchKnowledgeMemory).mockResolvedValue(fullMemoryPayload);
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

	it("loads the lightweight memory overview first and defers full memory until management opens", async () => {
		render(Page, { data: pageData() });

		await waitFor(() => {
			expect(fetchKnowledgeMemoryOverview).toHaveBeenCalledWith();
		});
		expect(fetchKnowledgeMemory).not.toHaveBeenCalled();
		expect(
			screen.getByText("The user prefers concise memory behavior."),
		).toBeInTheDocument();

		await fireEvent.click(
			screen.getByRole("button", { name: "Manage persona memory" }),
		);

		await waitFor(() => {
			expect(fetchKnowledgeMemory).toHaveBeenCalledTimes(1);
		});
	});

	it("lets the 20 second timer drive live overview polling instead of retrying on state flips", async () => {
		vi.useFakeTimers();
		vi.mocked(fetchKnowledgeMemoryOverview).mockResolvedValue(
			fallbackMemoryOverviewPayload,
		);

		render(Page, { data: pageData() });

		await waitFor(() => {
			expect(fetchKnowledgeMemoryOverview).toHaveBeenCalledTimes(1);
		});

		await vi.advanceTimersByTimeAsync(19_999);
		expect(fetchKnowledgeMemoryOverview).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		await waitFor(() => {
			expect(fetchKnowledgeMemoryOverview).toHaveBeenCalledTimes(2);
		});

		await vi.advanceTimersByTimeAsync(1);
		expect(fetchKnowledgeMemoryOverview).toHaveBeenCalledTimes(2);
	});
});
