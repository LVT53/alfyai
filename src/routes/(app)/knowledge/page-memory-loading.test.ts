// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { Component } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	page: { url: new URL("http://localhost/knowledge"), state: {} },
}));
const read = vi.hoisted(() => vi.fn());
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
vi.mock("$app/state", () => state);
vi.mock("$lib/client/api/memory", () => ({
	fetchMemoryPage: read,
	fetchMemoryDetail: vi.fn(),
	fetchMemoryOperation: vi.fn(),
	submitMemoryAction: vi.fn(),
}));

import Page from "./+page.svelte";

function pageData(memoryEnabled?: boolean): {
	memoryEnabled?: boolean;
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
} {
	return {
		...(memoryEnabled === undefined ? {} : { memoryEnabled }),
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
	};
}

const KnowledgePage = Page as unknown as Component<{
	data: ReturnType<typeof pageData>;
}>;

describe("Knowledge replacement boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.page.url = new URL("http://localhost/knowledge");
		read.mockResolvedValue({
			authority: "hindsight",
			scope: { kind: "personal" },
			generation: "g",
			rows: [],
			total: 0,
			status: "ready",
			nextCursor: null,
		});
	});
	it("loads Memory only when its tab is opened, keeping Documents as the default", async () => {
		render(KnowledgePage, { data: pageData(true) });
		expect(screen.getByRole("tab", { name: "Documents" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(read).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
		await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
		expect(
			screen.getByRole("heading", { name: "What Alfy remembers" }),
		).toBeVisible();
	});
	it("opens the new view directly without fetching portrait or review data", async () => {
		state.page.url = new URL("http://localhost/knowledge?tab=memory");
		render(KnowledgePage, { data: pageData(false) });
		await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
		expect(screen.getByTestId("memory-off-notice")).toBeVisible();
		expect(screen.queryByText("Needs Review")).not.toBeInTheDocument();
	});
});
