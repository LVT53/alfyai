import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { readable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	conversations,
	markConversationAtlasBadgeSeen,
} from "$lib/stores/conversations";
import { currentConversationId, sidebarCollapsed } from "$lib/stores/ui";
import Sidebar from "./Sidebar.svelte";

// Deterministic desktop/non-touch viewport so the expanded search pill (and
// its kbd hint chip) render regardless of the host machine's jsdom defaults.
const mockViewportStore = { touch: false, tier: "desktop" };
vi.mock("$lib/utils/viewport.svelte", () => ({
	get viewportStore() {
		return mockViewportStore;
	},
	isTouchDevice: () => false,
}));

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
}));

vi.mock("$app/stores", () => ({
	navigating: readable(null),
	page: readable({ url: new URL("http://localhost/") }),
}));

vi.mock("$lib/client/api/workspace-search", () => ({
	fetchWorkspaceSearch: vi.fn().mockResolvedValue({
		mode: "default",
		query: "",
		conversations: [],
		documents: [],
	}),
}));

function conv(id: string, unseen = false) {
	return {
		id,
		title: id,
		updatedAt: 1,
		atlasBadge: unseen
			? { jobId: `job-${id}`, status: "succeeded", completedAt: 5 }
			: undefined,
	} as never;
}

describe("Sidebar — Cmd/Ctrl+K Workspace Search shortcut (Task 6 / A3)", () => {
	beforeEach(() => {
		// Expanded sidebar so the search pill (and its kbd hint) render instead
		// of the icon-only collapsed rail.
		sidebarCollapsed.set(false);
	});

	it("opens Workspace Search on Ctrl+K from anywhere in the app", async () => {
		render(Sidebar, { open: true });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await fireEvent.keyDown(window, { key: "k", ctrlKey: true });

		expect(
			screen.getByRole("dialog", { name: "Search workspace" }),
		).toBeInTheDocument();
	});

	it("opens Workspace Search on Cmd+K (metaKey, mac)", async () => {
		render(Sidebar, { open: true });

		await fireEvent.keyDown(window, { key: "k", metaKey: true });

		expect(
			screen.getByRole("dialog", { name: "Search workspace" }),
		).toBeInTheDocument();
	});

	it("opens Workspace Search on Ctrl+K even when a text input is focused", async () => {
		// A modifier chord never collides with ordinary typing, unlike the bare
		// `/` shortcut — the chat composer textarea is the primary focus target
		// on this page, so ⌘K/Ctrl+K must still fire from inside it (Slack,
		// Linear, Notion, VS Code all open their palette from a focused input).
		render(Sidebar, { open: true });
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		await fireEvent.keyDown(input, { key: "k", ctrlKey: true });

		expect(
			screen.getByRole("dialog", { name: "Search workspace" }),
		).toBeInTheDocument();
		document.body.removeChild(input);
	});

	it("opens Workspace Search on Ctrl+K even when focus is inside a contenteditable element", async () => {
		render(Sidebar, { open: true });
		const editable = document.createElement("div");
		// jsdom doesn't implement the contenteditable editing spec (setting the
		// `contentEditable` attribute never makes `isContentEditable` true), so
		// the getter is stubbed directly to exercise that exact branch.
		Object.defineProperty(editable, "isContentEditable", {
			value: true,
			configurable: true,
		});
		document.body.appendChild(editable);
		editable.focus();

		await fireEvent.keyDown(editable, { key: "k", ctrlKey: true });

		expect(
			screen.getByRole("dialog", { name: "Search workspace" }),
		).toBeInTheDocument();
		document.body.removeChild(editable);
	});

	it("does not call preventDefault again while the modal is already open", async () => {
		render(Sidebar, { open: true });

		await fireEvent.keyDown(window, { key: "k", ctrlKey: true });
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		const notPrevented = await fireEvent.keyDown(window, {
			key: "k",
			ctrlKey: true,
		});

		expect(notPrevented).toBe(true);
	});

	it("shows a Ctrl+K hint chip inside the search pill", () => {
		render(Sidebar, { open: true });

		expect(screen.getByTestId("search-shortcut-hint")).toHaveTextContent(
			"Ctrl+K",
		);
	});

	it("shows a ⌘K hint chip on a mac platform", () => {
		const originalDescriptor = Object.getOwnPropertyDescriptor(
			window.navigator,
			"platform",
		);
		Object.defineProperty(window.navigator, "platform", {
			value: "MacIntel",
			configurable: true,
		});

		try {
			render(Sidebar, { open: true });
			expect(screen.getByTestId("search-shortcut-hint")).toHaveTextContent(
				"⌘K",
			);
		} finally {
			if (originalDescriptor) {
				Object.defineProperty(window.navigator, "platform", originalDescriptor);
			}
		}
	});
});

describe("Sidebar — collapsed-rail active-conversation indicator (Task 11 / A4, ADR-0043 #3)", () => {
	beforeEach(() => {
		// Force desktop tier so `isCollapsed` can be driven purely by
		// `sidebarCollapsed` (precedent: viewport.test.ts's tier stubbing).
		mockViewportStore.tier = "desktop";
	});

	afterEach(() => {
		sidebarCollapsed.set(false);
		currentConversationId.set(null);
	});

	it("shows no dot when collapsed with a chat open but nothing unseen", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");
		conversations.set([conv("conversation-123")]);

		render(Sidebar, { open: true });

		expect(
			screen.queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
		const logoButton = screen.getByTestId("sidebar-logo");
		expect(logoButton).toHaveAttribute("aria-label", "Expand sidebar");
		expect(logoButton).toHaveAttribute("title", "Expand sidebar");
	});

	it("shows a decorative dot on the logo button when another conversation has an unseen badge", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");
		conversations.set([conv("conversation-123"), conv("other", true)]);

		render(Sidebar, { open: true });

		const indicator = screen.getByTestId("unseen-activity-indicator");
		expect(indicator).toHaveAttribute("aria-hidden", "true");
		expect(indicator).not.toHaveAttribute("role");
		expect(indicator).not.toHaveAttribute("aria-label");
		const logoButton = screen.getByTestId("sidebar-logo");
		expect(logoButton).toContainElement(indicator);
		expect(logoButton).toHaveAttribute(
			"aria-label",
			"Expand sidebar — new activity",
		);
	});

	it("drops the dot once the badge is seen", async () => {
		sidebarCollapsed.set(true);
		conversations.set([conv("other", true)]);

		render(Sidebar, { open: true });
		expect(screen.getByTestId("unseen-activity-indicator")).toBeInTheDocument();

		markConversationAtlasBadgeSeen("other");
		await tick();

		expect(
			screen.queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
	});

	it("does not count a badge on the conversation being viewed", async () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("other");
		conversations.set([conv("other", true)]);

		render(Sidebar, { open: true });
		await tick();

		expect(
			screen.queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
	});

	it("does not show the indicator (or reintroduce it as a border) on the New Chat button", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");

		render(Sidebar, { open: true });

		const newChatButton = screen.getByTestId("new-conversation");
		expect(
			within(newChatButton).queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
		expect(newChatButton).not.toHaveClass("active-conversation-dot");
	});

	it("still does not render the conversation list when collapsed", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");

		render(Sidebar, { open: true, conversationsData: [] });

		// The "Chats" section header is unconditionally rendered by
		// ConversationList (ADR-0043 #3: "the Chats header never vanishes"),
		// so its absence proves the list itself isn't mounted.
		expect(screen.queryByText("Chats")).not.toBeInTheDocument();
	});

	it("does not show the corner dot when expanded, even with an unseen badge", () => {
		sidebarCollapsed.set(false);
		currentConversationId.set("conversation-123");
		conversations.set([conv("other", true)]);

		render(Sidebar, { open: true });

		expect(
			screen.queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
	});
});
