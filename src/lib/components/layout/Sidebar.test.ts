import { fireEvent, render, screen } from "@testing-library/svelte";
import { readable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sidebarCollapsed } from "$lib/stores/ui";
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
