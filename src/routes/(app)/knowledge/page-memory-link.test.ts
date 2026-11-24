import { render, screen, waitFor } from "@testing-library/svelte";
import type { Component } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A link from Workspace Search lands on /knowledge?tab=memory&memoryScope=…
// &memoryEntry=…&memoryQuery=…: the Memory tab on that entry, and then an
// address that is just ?tab=memory, so a reload or Back shows the plain tab.
// `goto` here moves the address the way SvelteKit does, so the test reads the
// address that results, not the call.
const state = vi.hoisted(() => ({
	page: { url: new URL("http://localhost/knowledge"), state: {} },
}));
const api = vi.hoisted(() => ({
	fetchMemoryPage: vi.fn(),
	fetchMemoryDetail: vi.fn(),
}));
const goto = vi.hoisted(() => vi.fn());
vi.mock("$app/environment", () => ({
	browser: true,
	building: false,
	dev: false,
	version: "test",
}));
vi.mock("$app/navigation", () => ({
	goto,
	invalidateAll: vi.fn(),
	replaceState: vi.fn(),
}));
vi.mock("$app/state", () => state);
vi.mock("$lib/client/api/memory", () => ({
	fetchMemoryPage: api.fetchMemoryPage,
	fetchMemoryDetail: api.fetchMemoryDetail,
	fetchMemoryOperation: vi.fn(),
	fetchMemoryQuarantine: vi.fn().mockResolvedValue({
		status: "unavailable",
		candidates: [],
	}),
	submitMemoryAction: vi.fn(),
}));

import Page from "./+page.svelte";

const ref = {
	scope: { kind: "personal" },
	generation: "g1",
	rowId: "kayak",
} as const;
const row = {
	ref,
	text: "You own a green touring kayak.",
	updatedAt: "2026-11-18T09:00:00Z",
	sourceCount: 1,
};
const memoryPage = {
	authority: "hindsight",
	scope: { kind: "personal" },
	generation: "g1",
	rows: [row],
	total: 1,
	status: "ready",
	nextCursor: null,
};

function pageData() {
	return {
		memoryEnabled: true,
		library: {
			documents: [],
			results: [],
			workflows: [],
			query: "",
			sort: { key: "date" as const, direction: "desc" as const },
			pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
		},
	};
}

const KnowledgePage = Page as unknown as Component<{
	data: ReturnType<typeof pageData>;
}>;

const LINK =
	"http://localhost/knowledge?tab=memory&memoryScope=personal&memoryEntry=kayak&memoryQuery=green%20kayak";

describe("a Memory link on the Knowledge page", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.page.url = new URL("http://localhost/knowledge");
		goto.mockImplementation(async (target: string) => {
			state.page.url = new URL(target, state.page.url);
		});
		api.fetchMemoryPage.mockResolvedValue(memoryPage);
		api.fetchMemoryDetail.mockResolvedValue({
			row,
			sources: [],
			versions: [],
			canEdit: true,
			canRemove: true,
		});
	});

	it("opens the linked entry on the Memory tab and leaves the address at ?tab=memory", async () => {
		state.page.url = new URL(LINK);
		render(KnowledgePage, { data: pageData() });

		expect(await screen.findByTestId("memory-detail")).toBeVisible();
		expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await waitFor(() => expect(state.page.url.search).toBe("?tab=memory"));
		expect(state.page.url.pathname).toBe("/knowledge");
		expect(api.fetchMemoryDetail).toHaveBeenCalledTimes(1);
	});

	it("shows the filled-in list, and the plain address, when the entry has changed", async () => {
		api.fetchMemoryPage.mockImplementation(
			async (request: { query?: string }) =>
				request.query
					? memoryPage
					: {
							...memoryPage,
							rows: [{ ...row, ref: { ...ref, rowId: "other" } }],
						},
		);
		state.page.url = new URL(
			LINK.replace("memoryEntry=kayak", "memoryEntry=gone"),
		);
		const { container } = render(KnowledgePage, { data: pageData() });

		expect(
			await screen.findByRole("button", { name: /You own a green/ }),
		).toBeVisible();
		expect(
			container.querySelector<HTMLInputElement>("[data-memory-search]")?.value,
		).toBe("green kayak");
		expect(screen.queryByTestId("memory-detail")).toBeNull();
		await waitFor(() => expect(state.page.url.search).toBe("?tab=memory"));
	});

	it("leaves a plain Memory address alone", async () => {
		state.page.url = new URL("http://localhost/knowledge?tab=memory");
		render(KnowledgePage, { data: pageData() });
		await waitFor(() => expect(api.fetchMemoryPage).toHaveBeenCalled());
		expect(api.fetchMemoryDetail).not.toHaveBeenCalled();
		expect(goto).not.toHaveBeenCalled();
		expect(state.page.url.search).toBe("?tab=memory");
	});

	it("takes a link that names no scope, or a Documents address, for what it was", async () => {
		state.page.url = new URL(
			"http://localhost/knowledge?tab=memory&memoryEntry=kayak",
		);
		render(KnowledgePage, { data: pageData() });
		await waitFor(() => expect(api.fetchMemoryPage).toHaveBeenCalled());
		expect(api.fetchMemoryDetail).not.toHaveBeenCalled();
		expect(goto).not.toHaveBeenCalled();
	});
});
