import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { readable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("does not open when a text input is focused", async () => {
		render(Sidebar, { open: true });
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		await fireEvent.keyDown(input, { key: "k", ctrlKey: true });

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		document.body.removeChild(input);
	});

	it("does not open when focus is inside a contenteditable element", async () => {
		render(Sidebar, { open: true });
		const editable = document.createElement("div");
		// jsdom doesn't implement the contenteditable editing spec (setting the
		// `contentEditable` attribute never makes `isContentEditable` true), so
		// the getter is stubbed directly to exercise that exact guard branch.
		Object.defineProperty(editable, "isContentEditable", {
			value: true,
			configurable: true,
		});
		document.body.appendChild(editable);
		editable.focus();

		await fireEvent.keyDown(editable, { key: "k", ctrlKey: true });

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

	it("shows a decorative corner dot on the LogoMark/expand-toggle when collapsed with an active conversation", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");

		render(Sidebar, { open: true });

		const indicator = screen.getByTestId("active-conversation-indicator");
		expect(indicator).toBeInTheDocument();
		// The dot is decorative: no live region, no separate label. It gets
		// re-mounted on every hasActiveConversation toggle, so a role="status"
		// here would fire spurious announcements on ordinary navigation.
		expect(indicator).toHaveAttribute("aria-hidden", "true");
		expect(indicator).not.toHaveAttribute("role");
		expect(indicator).not.toHaveAttribute("aria-label");

		// Anchored on the logo/expand-toggle button — the sidebar-identity
		// element — not on New Chat. The button itself (a stable node, not
		// remounted on toggle) conveys the active-conversation state via its
		// label instead.
		const logoButton = screen.getByTestId("sidebar-logo");
		expect(logoButton.tagName).toBe("BUTTON");
		expect(logoButton).toContainElement(indicator);
		expect(logoButton).toHaveAttribute(
			"aria-label",
			"Expand sidebar — Active conversation open",
		);
		expect(logoButton).toHaveAttribute(
			"title",
			"Expand sidebar — Active conversation open",
		);
	});

	it("does not show the indicator when collapsed with no active conversation", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set(null);

		render(Sidebar, { open: true });

		expect(
			screen.queryByTestId("active-conversation-indicator"),
		).not.toBeInTheDocument();
		// No active conversation: the logo/expand-toggle button keeps its
		// plain expand-sidebar label.
		const logoButton = screen.getByTestId("sidebar-logo");
		expect(logoButton).toHaveAttribute("aria-label", "Expand sidebar");
		expect(logoButton).toHaveAttribute("title", "Expand sidebar");
	});

	it("does not show the indicator (or reintroduce it as a border) on the New Chat button", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");

		render(Sidebar, { open: true });

		const newChatButton = screen.getByTestId("new-conversation");
		expect(
			within(newChatButton).queryByTestId("active-conversation-indicator"),
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

	it("does not show the corner dot when expanded, even with an active conversation", () => {
		sidebarCollapsed.set(false);
		currentConversationId.set("conversation-123");

		render(Sidebar, { open: true });

		expect(
			screen.queryByTestId("active-conversation-indicator"),
		).not.toBeInTheDocument();
	});
});
