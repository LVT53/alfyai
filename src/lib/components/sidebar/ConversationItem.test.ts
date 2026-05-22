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
		} as Animation;
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
		expect(indicator.querySelector("circle")).not.toBeInTheDocument();
		expect(screen.queryByRole("tree")).not.toBeInTheDocument();
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
