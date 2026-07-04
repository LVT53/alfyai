import { render, screen } from "@testing-library/svelte";
import { readable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	currentConversationId,
	sidebarCollapsed,
	sidebarOpen,
} from "$lib/stores/ui";
import Sidebar from "./Sidebar.svelte";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
}));

vi.mock("$app/stores", () => ({
	navigating: readable(null),
}));

vi.mock("$app/environment", () => ({
	browser: true,
}));

vi.mock("$lib/client/api/auth", () => ({
	logout: vi.fn(),
}));

vi.mock("$lib/client/session-boundary", () => ({
	clearClientAccountState: vi.fn(),
}));

vi.mock("$lib/client/conversation-session", () => ({
	markPreviousConversationId: vi.fn(),
}));

function renderSidebar() {
	return render(Sidebar, {
		props: {
			open: true,
			conversationsData: [],
			projectsData: [],
			user: null,
		},
	});
}

describe("Sidebar collapsed-rail active-conversation indicator", () => {
	beforeEach(() => {
		// Simulate a wide desktop viewport + collapsed rail.
		Object.defineProperty(window, "innerWidth", {
			writable: true,
			configurable: true,
			value: 1280,
		});
		window.dispatchEvent(new Event("resize"));
		sidebarCollapsed.set(true);
		sidebarOpen.set(true);
	});

	it("renders a distinct active indicator that is NOT the compose button when a conversation is active", async () => {
		currentConversationId.set("conv-123");
		renderSidebar();

		const indicator = screen.queryByTestId("collapsed-rail-active-indicator");
		expect(
			indicator,
			"a dedicated active indicator should exist",
		).not.toBeNull();

		const compose = screen.getByTestId("new-conversation");
		// The indicator must NOT be a descendant of the compose button.
		expect(
			compose.contains(indicator),
			"active indicator must not live on the compose button",
		).toBe(false);
		// The compose button must not carry the active styling class.
		expect(compose.classList.contains("compose-btn-active")).toBe(false);
	});

	it("does not render the active indicator when no conversation is active", () => {
		currentConversationId.set(null);
		renderSidebar();

		expect(screen.queryByTestId("collapsed-rail-active-indicator")).toBeNull();
	});
});
