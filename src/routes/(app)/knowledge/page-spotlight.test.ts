import { render, screen } from "@testing-library/svelte";
import type { Component } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayoutForSpotlight } from "$lib/actions/spotlight.test-helpers";
import {
	pendingSpotlight,
	requestSpotlight,
	spotlightRequest,
} from "$lib/stores/spotlight";

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

const ringing = () => [...document.querySelectorAll(".spotlight-ring")];

// The Feature Guide's Show me for Memory and for the Knowledge Base's
// Documents: the page names the two spots on its tabs (`knowledgeTabs`), and
// the tab bar (`PageSwitcher`) carries the marker. The page opens on Documents.
describe("Knowledge page — the guide's Show me", () => {
	let restoreLayout: () => void = () => undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		mockPageState.page.url = new URL("http://localhost/knowledge");
		// The ring waits one animation frame; the test steps it by hand.
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		restoreLayout = stubLayoutForSpotlight();
		spotlightRequest.set(null);
	});

	afterEach(() => {
		restoreLayout();
		vi.useRealTimers();
		spotlightRequest.set(null);
	});

	it("rings the Memory tab when Show me asks for Memory", () => {
		requestSpotlight("knowledge.memory");

		render(KnowledgePage, { data: pageData() });

		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		const tab = screen.getByRole("tab", { name: "Memory Profile" });
		expect(ringing()).toEqual([tab]);
		expect(vi.mocked(tab.scrollIntoView).mock.contexts).toEqual([tab]);
		// It is the other tab that is open, and the ring is on the one asked for.
		expect(screen.getByRole("tab", { name: "Documents" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("rings the Documents tab when Show me asks for the Knowledge Base", () => {
		requestSpotlight("knowledge.library");

		render(KnowledgePage, { data: pageData() });

		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		const tab = screen.getByRole("tab", { name: "Documents" });
		expect(ringing()).toEqual([tab]);
		expect(vi.mocked(tab.scrollIntoView).mock.contexts).toEqual([tab]);
	});

	it("leaves a request for another control waiting", () => {
		requestSpotlight("settings.data");

		render(KnowledgePage, { data: pageData() });
		vi.advanceTimersToNextFrame();

		expect(ringing()).toEqual([]);
		expect(pendingSpotlight(get(spotlightRequest))).toBe("settings.data");
	});
});
