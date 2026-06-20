import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationListItem } from "$lib/types";
import ConversationItemWrapper from "./ConversationItemWrapper.test.svelte";

vi.mock("svelte/transition", () => ({
	fade: () => ({}),
	scale: () => ({}),
	slide: () => ({}),
}));

if (typeof Element !== "undefined") {
	Element.prototype.animate = vi.fn().mockImplementation(() => {
		const animation = {
			finished: Promise.resolve(),
			cancel: vi.fn(),
			play: vi.fn(),
			onfinish: null as Animation["onfinish"],
		} as unknown as Animation;
		setTimeout(() => {
			animation.onfinish?.call(
				animation,
				new Event("finish") as AnimationPlaybackEvent,
			);
		}, 0);
		return animation;
	});
}

describe("ConversationItem Component", () => {
	const mockConversation: ConversationListItem = {
		id: "conv-1",
		title: "Test Conversation",
		updatedAt: Date.parse("2026-05-14T10:00:00.000Z"),
		projectId: null,
		sidebarPinned: false,
		sidebarSortOrder: null,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function parseFixedMenuTop(element: HTMLElement): number {
		const match = /top:\s*([\d.]+)px/.exec(element.getAttribute("style") ?? "");
		if (!match) throw new Error("Expected menu style to include a fixed top.");
		return Number(match[1]);
	}

	function stubViewportAndTriggerRect() {
		const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
		const originalHeight = Object.getOwnPropertyDescriptor(
			window,
			"innerHeight",
		);
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 320,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: 220,
		});
		const originalGetBoundingClientRect =
			HTMLElement.prototype.getBoundingClientRect;
		const rectSpy = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(function getBoundingClientRect(this: HTMLElement) {
				if (this.getAttribute("aria-label") === "Conversation options") {
					return {
						x: 260,
						y: 174,
						top: 174,
						right: 304,
						bottom: 202,
						left: 276,
						width: 28,
						height: 28,
						toJSON: () => ({}),
					} as DOMRect;
				}
				return originalGetBoundingClientRect.call(this);
			});

		return () => {
			rectSpy.mockRestore();
			if (originalWidth)
				Object.defineProperty(window, "innerWidth", originalWidth);
			if (originalHeight)
				Object.defineProperty(window, "innerHeight", originalHeight);
		};
	}

	it("renders conversation title without timestamp metadata", () => {
		render(ConversationItemWrapper, { conversation: mockConversation });
		expect(screen.getByText("Test Conversation")).toBeInTheDocument();
		expect(screen.queryByText("2 mins ago")).not.toBeInTheDocument();
	});

	it("renders a compact non-interactive fork indicator for fork conversations", async () => {
		render(ConversationItemWrapper, {
			conversation: {
				...mockConversation,
				forkSummary: {
					sourceTitle: "Source title",
					forkSequence: 2,
					sourceConversationId: "source-conv",
					sourceConversationIdAvailable: true,
				},
			},
		});

		const indicator = screen.getByLabelText("Fork of Source title, fork 2");
		expect(indicator).toBeInTheDocument();
		expect(indicator).toHaveAttribute("title", "Fork of Source title, fork 2");
		expect(indicator.tagName.toLowerCase()).not.toBe("button");
		expect(indicator).not.toHaveAttribute("type");
		expect(indicator).not.toHaveAttribute("tabindex");
		expect(indicator.tabIndex).toBe(-1);
		expect(
			screen.queryByRole("button", { name: "Fork of Source title, fork 2" }),
		).not.toBeInTheDocument();
		expect(indicator.getAttribute("role")).toBe("img");
		expect(screen.queryByRole("tree")).not.toBeInTheDocument();
	});

	it("renders a compact completed Atlas badge without replacing the hover menu", () => {
		render(ConversationItemWrapper, {
			conversation: {
				...mockConversation,
				atlasBadge: {
					status: "succeeded",
					label: "Completed Atlas report",
				},
			},
		});

		const indicator = screen.getByLabelText("Completed Atlas report");
		expect(indicator).toBeInTheDocument();
		expect(indicator).toHaveAttribute("role", "img");
		expect(
			screen.getByRole("button", { name: "Conversation options" }),
		).toBeInTheDocument();
	});

	it("does not render the completed Atlas badge on the active conversation", () => {
		render(ConversationItemWrapper, {
			active: true,
			conversation: {
				...mockConversation,
				atlasBadge: {
					jobId: "atlas-job-1",
					status: "succeeded",
					label: "Completed Atlas report",
					completedAt: 1_789_000,
					updatedAt: 1_789_000,
				},
			},
		});

		expect(
			screen.queryByLabelText("Completed Atlas report"),
		).not.toBeInTheDocument();
		expect(screen.getByText("Test Conversation")).toBeInTheDocument();
	});

	it("dispatches select event when clicked", async () => {
		const mockSelect = vi.fn();
		const { container } = render(ConversationItemWrapper, {
			conversation: mockConversation,
			onSelect: mockSelect,
		});

		const wrapper = container.querySelector('[role="button"]') as HTMLElement;
		await fireEvent.click(wrapper);

		expect(mockSelect).toHaveBeenCalledWith(
			expect.objectContaining({ id: "conv-1" }),
		);
	});

	it("offers pinning as the first overflow menu action", async () => {
		const onTogglePin = vi.fn();
		render(ConversationItemWrapper, {
			conversation: mockConversation,
			onTogglePin,
		});

		await fireEvent.click(screen.getByLabelText("Conversation options"));

		const menuActions = screen
			.getAllByRole("menuitem")
			.map((button) => button.textContent?.trim());
		expect(menuActions[0]).toBe("Pin to sidebar");

		await fireEvent.click(
			screen.getByRole("menuitem", { name: "Pin to sidebar" }),
		);

		expect(onTogglePin).toHaveBeenCalledWith({ id: "conv-1", pinned: true });
	});

	it("flips the overflow menu above bottom sidebar rows instead of clipping it", async () => {
		const restoreViewport = stubViewportAndTriggerRect();
		try {
			render(ConversationItemWrapper, {
				conversation: mockConversation,
			});

			await fireEvent.click(screen.getByLabelText("Conversation options"));

			const menu = screen.getByRole("menu");
			expect(parseFixedMenuTop(menu)).toBeLessThan(174);
		} finally {
			restoreViewport();
		}
	});

	it("opens the same menu on right-click without selecting the conversation", async () => {
		const onSelect = vi.fn();
		const onTogglePin = vi.fn();
		const { container } = render(ConversationItemWrapper, {
			conversation: {
				...mockConversation,
				sidebarPinned: true,
			},
			onSelect,
			onTogglePin,
		});

		await fireEvent.contextMenu(
			container.querySelector(
				'[data-testid="conversation-item"]',
			) as HTMLElement,
			{
				clientX: 48,
				clientY: 72,
			},
		);

		expect(onSelect).not.toHaveBeenCalled();
		await fireEvent.click(
			screen.getByRole("menuitem", { name: "Unpin from sidebar" }),
		);

		expect(onTogglePin).toHaveBeenCalledWith({ id: "conv-1", pinned: false });
	});

	describe("Rename flow", () => {
		it("shows input when rename is clicked and dispatches rename on enter", async () => {
			const mockRename = vi.fn();
			render(ConversationItemWrapper, {
				conversation: mockConversation,
				onRename: mockRename,
			});

			const menuButton = screen.getByLabelText("Conversation options");
			await fireEvent.click(menuButton);

			const renameButton = screen.getByText("Rename");
			await fireEvent.click(renameButton);

			const input = screen.getByDisplayValue(
				"Test Conversation",
			) as HTMLInputElement;
			expect(input).toBeInTheDocument();

			await fireEvent.input(input, { target: { value: "New Title" } });
			await fireEvent.keyDown(input, { key: "Enter" });

			expect(mockRename).toHaveBeenCalledWith(
				expect.objectContaining({ id: "conv-1", title: "New Title" }),
			);
		});

		it("cancels rename on escape", async () => {
			const mockRename = vi.fn();
			render(ConversationItemWrapper, {
				conversation: mockConversation,
				onRename: mockRename,
			});

			await fireEvent.click(screen.getByLabelText("Conversation options"));
			await fireEvent.click(screen.getByText("Rename"));

			const input = screen.getByDisplayValue("Test Conversation");
			await fireEvent.input(input, { target: { value: "New Title" } });
			await fireEvent.keyDown(input, { key: "Escape" });

			expect(mockRename).not.toHaveBeenCalled();
			expect(screen.queryByDisplayValue("New Title")).not.toBeInTheDocument();
			expect(screen.getByText("Test Conversation")).toBeInTheDocument();
		});
	});

	describe("Delete flow with confirmation", () => {
		it("shows confirmation dialog when delete is clicked", async () => {
			render(ConversationItemWrapper, { conversation: mockConversation });

			await fireEvent.click(screen.getByLabelText("Conversation options"));

			await fireEvent.click(screen.getByText("Delete"));

			expect(screen.getByText("Delete this conversation?")).toBeInTheDocument();
			expect(
				screen.getByText(
					"Are you sure you want to delete this conversation? This action cannot be undone.",
				),
			).toBeInTheDocument();
		});

		it("dispatches delete event when confirmation is accepted", async () => {
			const mockDelete = vi.fn();
			render(ConversationItemWrapper, {
				conversation: mockConversation,
				onDelete: mockDelete,
			});

			await fireEvent.click(screen.getByLabelText("Conversation options"));
			await fireEvent.click(screen.getByText("Delete"));

			const confirmButton = screen.getByRole("button", { name: "Delete" });
			await fireEvent.click(confirmButton);

			expect(mockDelete).toHaveBeenCalledWith(
				expect.objectContaining({ id: "conv-1" }),
			);

			await waitFor(() => {
				expect(
					screen.queryByText("Delete this conversation?"),
				).not.toBeInTheDocument();
			});
		});

		it("does not dispatch delete and closes dialog when cancelled", async () => {
			const mockDelete = vi.fn();
			render(ConversationItemWrapper, {
				conversation: mockConversation,
				onDelete: mockDelete,
			});

			await fireEvent.click(screen.getByLabelText("Conversation options"));
			await fireEvent.click(screen.getByText("Delete"));

			await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

			expect(mockDelete).not.toHaveBeenCalled();

			await waitFor(() => {
				expect(
					screen.queryByText("Delete this conversation?"),
				).not.toBeInTheDocument();
			});
		});
	});
});
