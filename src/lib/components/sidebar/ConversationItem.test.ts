import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationListItem } from "$lib/server/services/conversations";
import type { Project } from "$lib/server/services/projects";
import { uiLanguage } from "$lib/stores/settings";
import ConversationItemWrapper from "./ConversationItemWrapper.test.svelte";

vi.mock("svelte/transition", () => ({
	fade: () => ({}),
	// DialogShell (pulled in transitively) wraps `fly` too, for the phone
	// bottom-sheet presentation — a module-level call, so it has to exist on
	// the mock even though nothing in this test plays it.
	fly: () => ({}),
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

	afterEach(() => {
		vi.restoreAllMocks();
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

	// Incognito redesign — the sidebar row draws a mask before the title when
	// memory is off for the conversation, in the leading slot the fork and
	// Atlas marks use, never on the trailing side where the three dots live.
	describe("incognito mark", () => {
		it("draws a mask before the title, named by its title like the fork mark", () => {
			render(ConversationItemWrapper, {
				conversation: { ...mockConversation, memoryIncognito: true },
			});

			const mark = screen.getByTestId("conversation-incognito-mark");
			expect(mark).toHaveAttribute("role", "img");
			expect(mark).toHaveAttribute("aria-label", "Incognito — not remembered");
			expect(mark).toHaveAttribute("title", "Incognito — not remembered");
			expect(mark).toHaveClass("incognito-mark");
			// Nothing hand-drawn: a custom tooltip inside the overflow-hidden
			// title column was clipped away, so the native title is the tooltip.
			expect(mark.querySelector(".fork-indicator-tooltip")).toBeNull();
			expect(mark.tagName.toLowerCase()).not.toBe("button");

			// Leading, not trailing: the mark comes before the title in the DOM
			// and the three-dots button is still there after it.
			const title = screen.getByText("Test Conversation");
			expect(
				mark.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			const menuButton = screen.getByRole("button", {
				name: "Conversation options",
			});
			expect(menuButton).toBeInTheDocument();
			expect(
				mark.compareDocumentPosition(menuButton) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		});

		it("draws nothing when memory is on or the flag is missing", () => {
			const { unmount } = render(ConversationItemWrapper, {
				conversation: { ...mockConversation, memoryIncognito: false },
			});
			expect(
				screen.queryByTestId("conversation-incognito-mark"),
			).not.toBeInTheDocument();
			unmount();

			render(ConversationItemWrapper, { conversation: mockConversation });
			expect(
				screen.queryByTestId("conversation-incognito-mark"),
			).not.toBeInTheDocument();
		});

		it("sits after the fork and Atlas marks when all three are present", () => {
			render(ConversationItemWrapper, {
				conversation: {
					...mockConversation,
					memoryIncognito: true,
					forkSummary: {
						sourceTitle: "Source title",
						forkSequence: 2,
						sourceConversationId: "source-conv",
						sourceConversationIdAvailable: true,
					},
					atlasBadge: {
						status: "succeeded",
						label: "Completed Atlas report",
					},
				},
			});

			const fork = screen.getByLabelText("Fork of Source title, fork 2");
			const atlas = screen.getByLabelText("Completed Atlas report");
			const mask = screen.getByTestId("conversation-incognito-mark");
			expect(fork.parentElement).toBe(mask.parentElement);
			expect(atlas.parentElement).toBe(mask.parentElement);
			const marks = Array.from(mask.parentElement?.children ?? []);
			expect(marks.indexOf(fork)).toBeLessThan(marks.indexOf(atlas));
			expect(marks.indexOf(atlas)).toBeLessThan(marks.indexOf(mask));
			// The title still follows all three, and still truncates.
			const titleBox = screen
				.getByText("Test Conversation")
				.closest(".truncate");
			expect(titleBox).not.toBeNull();
			expect(marks.indexOf(mask)).toBeLessThan(
				marks.indexOf(titleBox?.parentElement as Element),
			);
			expect(
				screen.getByRole("button", { name: "Conversation options" }),
			).toBeInTheDocument();
		});

		it("localizes the mark", () => {
			uiLanguage.set("hu");
			try {
				render(ConversationItemWrapper, {
					conversation: { ...mockConversation, memoryIncognito: true },
				});
				expect(
					screen.getByTestId("conversation-incognito-mark"),
				).toHaveAttribute("title", "Inkognitó — nem marad meg");
			} finally {
				uiLanguage.set("en");
			}
		});
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

	it("recalculates the overflow menu after the portal menu has a measured height", async () => {
		const restoreViewport = stubViewportAndTriggerRect();
		const originalOffsetHeight = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"offsetHeight",
		);
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			configurable: true,
			get() {
				return this.getAttribute("role") === "menu" ? 190 : 0;
			},
		});
		try {
			render(ConversationItemWrapper, {
				conversation: mockConversation,
			});

			await fireEvent.click(screen.getByLabelText("Conversation options"));

			const menu = screen.getByRole("menu");
			await waitFor(() => {
				expect(parseFixedMenuTop(menu)).toBeLessThanOrEqual(18);
			});
		} finally {
			restoreViewport();
			if (originalOffsetHeight) {
				Object.defineProperty(
					HTMLElement.prototype,
					"offsetHeight",
					originalOffsetHeight,
				);
			} else {
				delete (HTMLElement.prototype as unknown as Record<string, unknown>)
					.offsetHeight;
			}
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

		it("opens the single delete dialog with the focus on Delete, as it always has", async () => {
			render(ConversationItemWrapper, { conversation: mockConversation });

			await fireEvent.click(screen.getByLabelText("Conversation options"));
			await fireEvent.click(screen.getByText("Delete"));

			await waitFor(() =>
				expect(screen.getByTestId("confirm-delete")).toHaveFocus(),
			);
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

	describe("selecting several chats", () => {
		const projects: Project[] = [
			{
				id: "p1",
				name: "Alpha",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
				hasInstructions: false,
			},
		];
		const forkSummary = {
			sourceTitle: "Source title",
			forkSequence: 2,
			sourceConversationId: "source-conv",
			sourceConversationIdAvailable: true,
		};

		function menuLabels(): (string | undefined)[] {
			return screen
				.getAllByRole("menuitem")
				.map((item) => item.textContent?.trim());
		}

		describe("before a selection is open", () => {
			it("toggles the chat on a Cmd-click and does not open it", async () => {
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					onSelect,
					onSelectionToggle,
				});

				await fireEvent.click(screen.getByTestId("conversation-item"), {
					metaKey: true,
				});

				expect(onSelectionToggle).toHaveBeenCalledTimes(1);
				expect(onSelectionToggle).toHaveBeenCalledWith({
					id: "conv-1",
					range: false,
				});
				expect(onSelect).not.toHaveBeenCalled();
			});

			it("toggles the chat on a Ctrl-click and does not open it", async () => {
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					onSelect,
					onSelectionToggle,
				});

				await fireEvent.click(screen.getByTestId("conversation-item"), {
					ctrlKey: true,
				});

				expect(onSelectionToggle).toHaveBeenCalledTimes(1);
				expect(onSelectionToggle).toHaveBeenCalledWith({
					id: "conv-1",
					range: false,
				});
				expect(onSelect).not.toHaveBeenCalled();
			});

			it("extends from the anchor on a Shift-click and does not open the chat", async () => {
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					onSelect,
					onSelectionToggle,
				});

				await fireEvent.click(screen.getByTestId("conversation-item"), {
					shiftKey: true,
				});

				expect(onSelectionToggle).toHaveBeenCalledTimes(1);
				expect(onSelectionToggle).toHaveBeenCalledWith({
					id: "conv-1",
					range: true,
				});
				expect(onSelect).not.toHaveBeenCalled();
			});

			it("opens the chat on a plain click and selects nothing", async () => {
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					onSelect,
					onSelectionToggle,
				});

				await fireEvent.click(screen.getByTestId("conversation-item"));

				expect(onSelect).toHaveBeenCalledTimes(1);
				expect(onSelect).toHaveBeenCalledWith({ id: "conv-1" });
				expect(onSelectionToggle).not.toHaveBeenCalled();
			});

			// Ctrl-click is a right-click on macOS: the browser sends a
			// `contextmenu` and no `click`, so the row must not read it as a pick.
			it("opens the row menu on the contextmenu of a Ctrl-click and selects nothing", async () => {
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					onSelect,
					onSelectionToggle,
				});

				const notCancelled = await fireEvent.contextMenu(
					screen.getByTestId("conversation-item"),
					{ ctrlKey: true, clientX: 48, clientY: 72 },
				);

				expect(screen.getByRole("menu")).toBeInTheDocument();
				// The row's menu stands in for the browser's own.
				expect(notCancelled).toBe(false);
				expect(onSelectionToggle).not.toHaveBeenCalled();
				expect(onSelect).not.toHaveBeenCalled();
			});

			it("keeps Shift from selecting the page's text", async () => {
				render(ConversationItemWrapper, { conversation: mockConversation });
				const item = screen.getByTestId("conversation-item");

				// `fireEvent` answers false when the handler called preventDefault.
				expect(await fireEvent.mouseDown(item, { shiftKey: true })).toBe(false);
				expect(await fireEvent.mouseDown(item)).toBe(true);
			});

			it("offers Select in the row menu, after Move to project and before Delete", async () => {
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					projects,
				});

				await fireEvent.click(screen.getByLabelText("Conversation options"));

				expect(menuLabels()).toEqual([
					"Pin to sidebar",
					"Rename",
					"Move to project",
					"Select",
					"Delete",
				]);
				expect(screen.getByTestId("select-option")).toHaveTextContent("Select");
			});

			it("offers Select with no project to move to", async () => {
				render(ConversationItemWrapper, { conversation: mockConversation });

				await fireEvent.click(screen.getByLabelText("Conversation options"));

				expect(menuLabels()).toEqual([
					"Pin to sidebar",
					"Rename",
					"Select",
					"Delete",
				]);
			});

			it("starts a selection with this chat from the Select item, and closes the menu", async () => {
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					onSelect,
					onSelectionToggle,
				});
				await fireEvent.click(screen.getByLabelText("Conversation options"));

				await fireEvent.click(screen.getByTestId("select-option"));

				expect(onSelectionToggle).toHaveBeenCalledTimes(1);
				expect(onSelectionToggle).toHaveBeenCalledWith({
					id: "conv-1",
					range: false,
				});
				expect(onSelect).not.toHaveBeenCalled();
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();
			});

			it("puts focus on its own row after Select, which takes the menu and its button away", async () => {
				render(ConversationItemWrapper, { conversation: mockConversation });
				await fireEvent.click(screen.getByLabelText("Conversation options"));
				const select = screen.getByTestId("select-option");
				select.focus();
				expect(select).toHaveFocus();

				await fireEvent.click(select);

				await waitFor(() =>
					expect(screen.getByTestId("conversation-item")).toHaveFocus(),
				);
			});

			it("puts focus on its row after Select in the right-click menu too", async () => {
				render(ConversationItemWrapper, { conversation: mockConversation });
				await fireEvent.contextMenu(screen.getByTestId("conversation-item"), {
					clientX: 48,
					clientY: 72,
				});

				await fireEvent.click(screen.getByTestId("select-option"));

				await waitFor(() =>
					expect(screen.getByTestId("conversation-item")).toHaveFocus(),
				);
			});

			it("starts a selection from the right-click menu too", async () => {
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					onSelectionToggle,
				});
				await fireEvent.contextMenu(screen.getByTestId("conversation-item"), {
					clientX: 48,
					clientY: 72,
				});

				await fireEvent.click(screen.getByTestId("select-option"));

				expect(onSelectionToggle).toHaveBeenCalledWith({
					id: "conv-1",
					range: false,
				});
			});

			it("saves a rename on Enter and neither opens the chat nor selects it", async () => {
				const onRename = vi.fn();
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					onRename,
					onSelect,
					onSelectionToggle,
				});
				await fireEvent.click(screen.getByLabelText("Conversation options"));
				await fireEvent.click(screen.getByTestId("rename-option"));

				const input = screen.getByTestId("title-input");
				await fireEvent.input(input, { target: { value: "New Title" } });
				await fireEvent.keyDown(input, { key: "Enter" });

				expect(onRename).toHaveBeenCalledWith({
					id: "conv-1",
					title: "New Title",
				});
				expect(onSelect).not.toHaveBeenCalled();
				expect(onSelectionToggle).not.toHaveBeenCalled();
			});

			it("says Select in Hungarian", async () => {
				uiLanguage.set("hu");
				try {
					render(ConversationItemWrapper, { conversation: mockConversation });
					await fireEvent.click(
						screen.getByLabelText("Beszélgetés beállításai"),
					);

					expect(screen.getByTestId("select-option")).toHaveTextContent(
						"Kijelölés",
					);
				} finally {
					uiLanguage.set("en");
				}
			});

			it("draws no box and keeps its drag setting", () => {
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					dragEnabled: true,
				});

				const item = screen.getByTestId("conversation-item");
				expect(
					screen.queryByTestId("conversation-select-checkbox"),
				).not.toBeInTheDocument();
				expect(item).not.toHaveAttribute("data-selected");
				expect(item).not.toHaveAttribute("aria-pressed");
				expect(item).toHaveAttribute("draggable", "true");
			});
		});

		describe("while a selection is open", () => {
			it("stays a button and says whether it is ticked with aria-pressed", async () => {
				const { rerender } = render(ConversationItemWrapper, {
					conversation: mockConversation,
					selecting: true,
					selected: false,
				});
				const item = screen.getByTestId("conversation-item");

				expect(item).toHaveAttribute("role", "button");
				expect(item).toHaveAttribute("aria-pressed", "false");
				expect(item).toHaveAttribute("data-selected", "false");

				await rerender({ selected: true });
				expect(item).toHaveAttribute("aria-pressed", "true");
				expect(item).toHaveAttribute("data-selected", "true");

				await rerender({ selecting: false });
				expect(item).not.toHaveAttribute("aria-pressed");
				expect(item).not.toHaveAttribute("data-selected");
			});

			it("toggles the chat on a plain click and never opens it", async () => {
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					selecting: true,
					onSelect,
					onSelectionToggle,
				});

				await fireEvent.click(screen.getByTestId("conversation-item"));

				expect(onSelectionToggle).toHaveBeenCalledTimes(1);
				expect(onSelectionToggle).toHaveBeenCalledWith({
					id: "conv-1",
					range: false,
				});
				expect(onSelect).not.toHaveBeenCalled();
			});

			it("extends from the anchor on a Shift-click and toggles on a Cmd or Ctrl click", async () => {
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					selecting: true,
					onSelectionToggle,
				});
				const item = screen.getByTestId("conversation-item");

				await fireEvent.click(item, { shiftKey: true });
				await fireEvent.click(item, { metaKey: true });
				await fireEvent.click(item, { ctrlKey: true });

				expect(onSelectionToggle.mock.calls).toEqual([
					[{ id: "conv-1", range: true }],
					[{ id: "conv-1", range: false }],
					[{ id: "conv-1", range: false }],
				]);
			});

			it("toggles on Space, keeping the page from scrolling, and on Enter", async () => {
				const onSelect = vi.fn();
				const onSelectionToggle = vi.fn();
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					selecting: true,
					onSelect,
					onSelectionToggle,
				});
				const item = screen.getByTestId("conversation-item");

				expect(await fireEvent.keyDown(item, { key: " " })).toBe(false);
				expect(onSelectionToggle).toHaveBeenCalledTimes(1);
				expect(onSelectionToggle).toHaveBeenLastCalledWith({
					id: "conv-1",
					range: false,
				});

				await fireEvent.keyDown(item, { key: "Enter" });
				expect(onSelectionToggle).toHaveBeenCalledTimes(2);
				expect(onSelectionToggle).toHaveBeenLastCalledWith({
					id: "conv-1",
					range: false,
				});

				// Any other key is left to the page.
				await fireEvent.keyDown(item, { key: "a" });
				expect(onSelectionToggle).toHaveBeenCalledTimes(2);
				expect(onSelect).not.toHaveBeenCalled();
			});

			it("has no options button and no context menu", async () => {
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					selecting: true,
				});

				expect(
					screen.queryByLabelText("Conversation options"),
				).not.toBeInTheDocument();

				const notCancelled = await fireEvent.contextMenu(
					screen.getByTestId("conversation-item"),
					{ clientX: 48, clientY: 72 },
				);
				expect(screen.queryByRole("menu")).not.toBeInTheDocument();
				// Nothing of the row's is in the way of the browser's own menu.
				expect(notCancelled).toBe(true);
			});

			// A selection can start while a title is being edited (it starts from
			// another row); the keys typed into that field are still the field's.
			it("leaves the keys of a rename field to the field", async () => {
				const onSelectionToggle = vi.fn();
				const { rerender } = render(ConversationItemWrapper, {
					conversation: mockConversation,
					onSelectionToggle,
				});
				await fireEvent.click(screen.getByLabelText("Conversation options"));
				await fireEvent.click(screen.getByTestId("rename-option"));
				const input = screen.getByTestId("title-input");
				await rerender({ selecting: true });

				const notCancelled = await fireEvent.keyDown(input, { key: " " });

				expect(notCancelled).toBe(true);
				expect(onSelectionToggle).not.toHaveBeenCalled();
			});

			it("cannot be dragged, even where dragging is on", async () => {
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					selecting: true,
					dragEnabled: true,
				});
				const item = screen.getByTestId("conversation-item");

				expect(item).toHaveAttribute("draggable", "false");
				// A drag that starts anyway is cancelled.
				expect(await fireEvent.dragStart(item)).toBe(false);
			});

			it("draws a box, hidden from assistive tech, before the title", () => {
				render(ConversationItemWrapper, {
					conversation: mockConversation,
					selecting: true,
					selected: false,
				});

				const checkbox = screen.getByTestId("conversation-select-checkbox");
				expect(checkbox).toHaveAttribute("aria-hidden", "true");
				const title = screen.getByText("Test Conversation");
				expect(
					checkbox.compareDocumentPosition(title) &
						Node.DOCUMENT_POSITION_FOLLOWING,
				).toBeTruthy();
			});

			it("ticks the box when the chat is selected and not when it is not", async () => {
				const { rerender } = render(ConversationItemWrapper, {
					conversation: mockConversation,
					selecting: true,
					selected: false,
				});
				const checkbox = screen.getByTestId("conversation-select-checkbox");
				expect(checkbox.querySelector("svg")).not.toBeInTheDocument();

				await rerender({ selected: true });
				expect(checkbox.querySelector("svg")).toBeInTheDocument();
			});

			it("keeps its fork, Atlas and incognito marks, after the box", () => {
				render(ConversationItemWrapper, {
					conversation: {
						...mockConversation,
						memoryIncognito: true,
						forkSummary,
						atlasBadge: {
							status: "succeeded",
							label: "Completed Atlas report",
						},
					},
					selecting: true,
				});

				const checkbox = screen.getByTestId("conversation-select-checkbox");
				const marks = [
					screen.getByLabelText("Fork of Source title, fork 2"),
					screen.getByLabelText("Completed Atlas report"),
					screen.getByTestId("conversation-incognito-mark"),
				];
				for (const mark of marks) {
					expect(mark).toBeInTheDocument();
					expect(
						checkbox.compareDocumentPosition(mark) &
							Node.DOCUMENT_POSITION_FOLLOWING,
					).toBeTruthy();
				}
				expect(checkbox.parentElement).toBe(marks[0].parentElement);
			});
		});
	});
});
