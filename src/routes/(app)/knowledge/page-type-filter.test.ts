import { render, screen } from "@testing-library/svelte";
import type { Component } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import Page from "./+page.svelte";

function pageData() {
	return {
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

// Live on ai.dev (Task 20): any `?type=` crashed the page with a 500 —
// "Cannot access 'KIND_FILTER_VALUES' before initialization" — because the
// filter's `$state` initialiser read the allowlist before its `const` line
// ran. The allowlist also lacked "image", which the server accepts.
describe("Knowledge page ?type= filter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		"document",
		"canvas",
		"app",
		"image",
		"uploaded",
	])("?type=%s opens with its chip active", (type) => {
		mockPageState.page.url = new URL(`http://localhost/knowledge?type=${type}`);

		render(KnowledgePage, { data: pageData() });

		expect(screen.getByTestId(`documents-filter-chip-${type}`)).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	// The file-family allowlist had the same ordering bug for `?family=`.
	it("renders for a ?family= link instead of crashing", () => {
		mockPageState.page.url = new URL("http://localhost/knowledge?family=pdf");

		expect(() => render(KnowledgePage, { data: pageData() })).not.toThrow();
	});

	it("ignores an unrecognised ?type= value and opens on All", () => {
		mockPageState.page.url = new URL(
			"http://localhost/knowledge?type=nonsense",
		);

		render(KnowledgePage, { data: pageData() });

		expect(screen.getByTestId("documents-filter-chip-all")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});
});
