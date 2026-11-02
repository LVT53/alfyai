import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "$lib/server/services/messages-types";
import ConversationJumpRail from "./ConversationJumpRail.svelte";

/**
 * Chat Scroller DOM tests (ADR-0043 Slice 17, redrawn as a ruler and a capsule).
 *
 * The layout itself (the 13 ticks' height, the sheet above the composer) is
 * measured in tests/e2e/chat-scroller.spec.ts; here the structure and the
 * behaviour: mount gating, the tick count and the mark's place, the list's
 * hover and press rules, keyboard use, the capsule and the sheet.
 */

function msg(
	id: string,
	role: "user" | "assistant",
	content: string,
	railSummary?: string,
): ChatMessage {
	return {
		id,
		renderKey: id,
		role,
		content,
		timestamp: 0,
		...(railSummary !== undefined ? { railSummary } : {}),
	};
}

/** Build a conversation with `count` user→assistant turn pairs. */
function conversation(count: number): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (let i = 1; i <= count; i += 1) {
		messages.push(msg(`u${i}`, "user", `Question ${i}`));
		messages.push(msg(`a${i}`, "assistant", `Answer ${i}`.repeat(8)));
	}
	return messages;
}

function trigger() {
	return screen.getByTestId("jump-rail-trigger");
}

function nav() {
	return screen.getByTestId("conversation-jump-rail");
}

function rows() {
	return screen.queryAllByTestId("jump-rail-row");
}

describe("ConversationJumpRail", () => {
	beforeEach(() => {
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			// Reduced motion, so the dialog's fade-out is instant and a closed
			// sheet is gone from the page as soon as it closes.
			value: vi.fn().mockImplementation((query: string) => ({
				matches: query.includes("prefers-reduced-motion"),
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("does not render when there are fewer than 6 assistant messages", () => {
		render(ConversationJumpRail, {
			props: { messages: conversation(5), scrollToMessage: vi.fn() },
		});

		expect(
			screen.queryByTestId("conversation-jump-rail"),
		).not.toBeInTheDocument();
		expect(screen.queryByTestId("jump-rail-capsule")).not.toBeInTheDocument();
	});

	it("is one Tab stop and has an accessible name", () => {
		render(ConversationJumpRail, {
			props: { messages: conversation(30), scrollToMessage: vi.fn() },
		});

		expect(nav()).toHaveAccessibleName("Conversation navigation");
		expect(within(nav()).getAllByRole("button")).toHaveLength(1);
	});

	describe("the ruler", () => {
		it("draws one tick per turn from 6 to 13 turns", () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(6), scrollToMessage: vi.fn() },
			});

			expect(screen.getAllByTestId("jump-rail-tick")).toHaveLength(6);
		});

		it("never draws more than 13 ticks, however long the chat is", () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(40), scrollToMessage: vi.fn() },
			});

			expect(screen.getAllByTestId("jump-rail-tick")).toHaveLength(13);
		});

		it("puts the mark on the last tick when the reader is on the last turn", () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(30), scrollToMessage: vi.fn() },
			});

			expect(
				screen
					.getByTestId("jump-rail-needle")
					.parentElement?.getAttribute("style"),
			).toContain("--needle: 12");
		});

		it("scales the reader's place on a long chat onto the ticks", () => {
			// Turn 16 of 30: 15 / 29 of the way down, so tick round(0.517 * 12) = 6.
			render(ConversationJumpRail, {
				props: {
					messages: conversation(30),
					scrollToMessage: vi.fn(),
					activeTurnId: "a16",
				},
			});

			expect(
				screen
					.getByTestId("jump-rail-needle")
					.parentElement?.getAttribute("style"),
			).toContain("--needle: 6");
		});

		it("puts the mark on the first tick at the first turn", () => {
			render(ConversationJumpRail, {
				props: {
					messages: conversation(30),
					scrollToMessage: vi.fn(),
					activeTurnId: "a1",
				},
			});

			expect(
				screen
					.getByTestId("jump-rail-needle")
					.parentElement?.getAttribute("style"),
			).toContain("--needle: 0");
		});

		it("puts the mark on the matching tick when there is one tick per turn", () => {
			// Six turns, six ticks: turn 3 is tick 2.
			render(ConversationJumpRail, {
				props: {
					messages: conversation(6),
					scrollToMessage: vi.fn(),
					activeTurnId: "a3",
				},
			});

			expect(
				screen
					.getByTestId("jump-rail-needle")
					.parentElement?.getAttribute("style"),
			).toContain("--needle: 2");
		});
	});

	describe("the list", () => {
		it("is closed until asked for", () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});

			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();
			expect(trigger()).toHaveAttribute("aria-expanded", "false");
		});

		it("opens 120 ms after the pointer rests on it and closes 180 ms after it leaves", async () => {
			vi.useFakeTimers();
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});

			await fireEvent.pointerEnter(nav(), { pointerType: "mouse" });
			await vi.advanceTimersByTimeAsync(119);
			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();
			await vi.advanceTimersByTimeAsync(1);
			await tick();
			expect(screen.getByTestId("jump-rail-list")).toBeInTheDocument();

			await fireEvent.pointerLeave(nav(), { pointerType: "mouse" });
			await vi.advanceTimersByTimeAsync(179);
			expect(screen.getByTestId("jump-rail-list")).toBeInTheDocument();
			await vi.advanceTimersByTimeAsync(1);
			await tick();
			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();
		});

		it("does nothing when the pointer only crosses the ruler", async () => {
			vi.useFakeTimers();
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});

			await fireEvent.pointerEnter(nav(), { pointerType: "mouse" });
			await vi.advanceTimersByTimeAsync(60);
			await fireEvent.pointerLeave(nav(), { pointerType: "mouse" });
			await vi.advanceTimersByTimeAsync(500);
			await tick();

			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();
		});

		it("keeps the list when the pointer comes back before it closes", async () => {
			vi.useFakeTimers();
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});

			await fireEvent.pointerEnter(nav(), { pointerType: "mouse" });
			await vi.advanceTimersByTimeAsync(120);
			await tick();
			await fireEvent.pointerLeave(nav(), { pointerType: "mouse" });
			await vi.advanceTimersByTimeAsync(100);
			await fireEvent.pointerEnter(nav(), { pointerType: "mouse" });
			await vi.advanceTimersByTimeAsync(500);
			await tick();

			expect(screen.getByTestId("jump-rail-list")).toBeInTheDocument();
		});

		it("does not open on a touch pointer's hover, only on its press", async () => {
			vi.useFakeTimers();
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});

			await fireEvent.pointerEnter(nav(), { pointerType: "touch" });
			await vi.advanceTimersByTimeAsync(300);
			await tick();
			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();

			await fireEvent.click(trigger(), { detail: 1 });
			expect(screen.getByTestId("jump-rail-list")).toBeInTheDocument();
			// The tap's pointer then leaves: a pressed list stays.
			await fireEvent.pointerLeave(nav(), { pointerType: "touch" });
			await vi.advanceTimersByTimeAsync(500);
			await tick();
			expect(screen.getByTestId("jump-rail-list")).toBeInTheDocument();
		});

		it("toggles on a press of the trigger", async () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});

			await fireEvent.click(trigger(), { detail: 1 });
			expect(screen.getByTestId("jump-rail-list")).toBeInTheDocument();
			expect(trigger()).toHaveAttribute("aria-expanded", "true");

			await fireEvent.click(trigger(), { detail: 1 });
			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();
		});

		it("lists every turn by its label, the current one marked", async () => {
			const messages = conversation(8);
			messages[1] = msg(
				"a1",
				"assistant",
				"Long answer",
				"Summary of the first",
			);
			render(ConversationJumpRail, {
				props: { messages, scrollToMessage: vi.fn(), activeTurnId: "a3" },
			});

			await fireEvent.click(trigger(), { detail: 1 });

			expect(rows()).toHaveLength(8);
			expect(rows()[0]).toHaveTextContent("Summary of the first");
			expect(rows()[1]).toHaveTextContent("Question 2");
			const current = rows().filter((row) => row.hasAttribute("aria-current"));
			expect(current).toHaveLength(1);
			expect(current[0]).toHaveTextContent("Question 3");
			expect(current[0]).toHaveAttribute("aria-current", "true");
		});

		it("takes the last turn as current when no turn is given", async () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});

			await fireEvent.click(trigger(), { detail: 1 });

			const current = rows().find((row) => row.hasAttribute("aria-current"));
			expect(current).toHaveTextContent("Question 8");
		});

		it("jumps and closes when a row is chosen", async () => {
			const scrollToMessage = vi.fn();
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage },
			});
			await fireEvent.click(trigger(), { detail: 1 });

			await fireEvent.click(rows()[2]);

			expect(scrollToMessage).toHaveBeenCalledWith("a3");
			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();
		});

		it("closes on a press outside it, and not on a press inside it", async () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});
			await fireEvent.click(trigger(), { detail: 1 });

			await fireEvent.pointerDown(screen.getByTestId("jump-rail-list"));
			expect(screen.getByTestId("jump-rail-list")).toBeInTheDocument();

			await fireEvent.pointerDown(document.body);
			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();
		});
	});

	describe("from the keyboard", () => {
		it("moves focus to the current row when opened with Enter", async () => {
			render(ConversationJumpRail, {
				props: {
					messages: conversation(8),
					scrollToMessage: vi.fn(),
					activeTurnId: "a4",
				},
			});

			// A click with no pointer position (detail 0) is what Enter or Space makes.
			await fireEvent.click(trigger(), { detail: 0 });
			await tick();

			expect(document.activeElement).toBe(rows()[3]);
		});

		it("moves between rows with Up and Down, and to the ends with Home and End", async () => {
			render(ConversationJumpRail, {
				props: {
					messages: conversation(8),
					scrollToMessage: vi.fn(),
					activeTurnId: "a4",
				},
			});
			await fireEvent.click(trigger(), { detail: 0 });
			await tick();

			await fireEvent.keyDown(document.activeElement as Element, {
				key: "ArrowDown",
			});
			expect(document.activeElement).toBe(rows()[4]);
			await fireEvent.keyDown(document.activeElement as Element, {
				key: "ArrowUp",
			});
			await fireEvent.keyDown(document.activeElement as Element, {
				key: "ArrowUp",
			});
			expect(document.activeElement).toBe(rows()[2]);
			await fireEvent.keyDown(document.activeElement as Element, {
				key: "End",
			});
			expect(document.activeElement).toBe(rows()[7]);
			await fireEvent.keyDown(document.activeElement as Element, {
				key: "Home",
			});
			expect(document.activeElement).toBe(rows()[0]);
			// It stops at the ends.
			await fireEvent.keyDown(document.activeElement as Element, {
				key: "ArrowUp",
			});
			expect(document.activeElement).toBe(rows()[0]);
		});

		it("closes on Esc and returns focus to the trigger", async () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});
			await fireEvent.click(trigger(), { detail: 0 });
			await tick();

			await fireEvent.keyDown(document.activeElement as Element, {
				key: "Escape",
			});

			expect(screen.queryByTestId("jump-rail-list")).not.toBeInTheDocument();
			expect(document.activeElement).toBe(trigger());
		});

		it("keeps the rows out of the Tab order", async () => {
			render(ConversationJumpRail, {
				props: { messages: conversation(8), scrollToMessage: vi.fn() },
			});
			await fireEvent.click(trigger(), { detail: 1 });

			for (const row of rows()) expect(row).toHaveAttribute("tabindex", "-1");
		});
	});

	describe("a narrow chat", () => {
		it("draws no ruler, and no capsule until the reader has left the bottom", () => {
			render(ConversationJumpRail, {
				props: {
					messages: conversation(30),
					scrollToMessage: vi.fn(),
					compact: true,
					showLatest: false,
				},
			});

			expect(
				screen.queryByTestId("conversation-jump-rail"),
			).not.toBeInTheDocument();
			expect(screen.queryByTestId("jump-rail-capsule")).not.toBeInTheDocument();
		});

		it("draws the capsule with the reader's place once they have left the bottom", () => {
			render(ConversationJumpRail, {
				props: {
					messages: conversation(30),
					scrollToMessage: vi.fn(),
					activeTurnId: "a11",
					compact: true,
					showLatest: true,
				},
			});

			expect(
				screen.queryByTestId("conversation-jump-rail"),
			).not.toBeInTheDocument();
			const capsule = screen.getByTestId("jump-rail-capsule");
			expect(capsule).toHaveTextContent("11 / 30");
		});

		it("takes the reader back to the latest message from the chevron", async () => {
			const onLatest = vi.fn();
			render(ConversationJumpRail, {
				props: {
					messages: conversation(30),
					scrollToMessage: vi.fn(),
					compact: true,
					showLatest: true,
					onLatest,
				},
			});

			await fireEvent.click(screen.getByTestId("jump-rail-capsule-latest"));

			expect(
				screen.getByTestId("jump-rail-capsule-latest"),
			).toHaveAccessibleName("Jump to latest");
			expect(onLatest).toHaveBeenCalledTimes(1);
		});

		it("opens the list as a dialog from the number, at the current row", async () => {
			render(ConversationJumpRail, {
				props: {
					messages: conversation(30),
					scrollToMessage: vi.fn(),
					activeTurnId: "a11",
					compact: true,
					showLatest: true,
				},
			});

			await fireEvent.click(screen.getByTestId("jump-rail-capsule-where"));

			const dialog = await screen.findByRole("dialog");
			expect(dialog).toHaveAccessibleName("Jump to turn");
			expect(within(dialog).getAllByTestId("jump-rail-row")).toHaveLength(30);
			const current = within(dialog)
				.getAllByTestId("jump-rail-row")
				.filter((row) => row.hasAttribute("aria-current"));
			expect(current).toHaveLength(1);
			expect(current[0]).toHaveTextContent("Question 11");
			// The dialog puts the focus on its first control unless it is already
			// inside, and on the first row that scrolls the list back to the top.
			await waitFor(() => expect(current[0]).toHaveFocus());
		});

		it("jumps and closes the sheet when a row is chosen", async () => {
			const scrollToMessage = vi.fn();
			render(ConversationJumpRail, {
				props: {
					messages: conversation(30),
					scrollToMessage,
					compact: true,
					showLatest: true,
				},
			});
			await fireEvent.click(screen.getByTestId("jump-rail-capsule-where"));
			const dialog = await screen.findByRole("dialog");

			await fireEvent.click(within(dialog).getAllByTestId("jump-rail-row")[4]);

			expect(scrollToMessage).toHaveBeenCalledWith("a5");
			// The dialog fades out before it leaves the page.
			await waitFor(() =>
				expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
			);
		});

		it("closes the sheet when the chat becomes wide enough for the ruler", async () => {
			const { rerender } = render(ConversationJumpRail, {
				props: {
					messages: conversation(30),
					scrollToMessage: vi.fn(),
					compact: true,
					showLatest: true,
				},
			});
			await fireEvent.click(screen.getByTestId("jump-rail-capsule-where"));
			await screen.findByRole("dialog");

			await rerender({
				messages: conversation(30),
				scrollToMessage: vi.fn(),
				compact: false,
				showLatest: true,
			});
			await tick();

			await waitFor(() =>
				expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
			);
			expect(screen.getByTestId("conversation-jump-rail")).toBeInTheDocument();
		});
	});
});
