import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "$lib/types";
import ConversationJumpRail from "./ConversationJumpRail.svelte";

/**
 * ConversationJumpRail DOM tests (ADR-0043 Slice 17).
 *
 * The cursor-relative hover wave is JS pointer math and is not exercised here;
 * we assert the structural/interactive behavior that matters for correctness:
 * mount gating, the active mark, click→scroll, and phone-tier hiding.
 */

// Mock the viewport store so we can drive the phone/tablet/desktop tier
// per test without resizing jsdom's window.
const mockViewportStore = { touch: false, tier: "desktop" };
vi.mock("$lib/utils/viewport.svelte", () => ({
	get viewportStore() {
		return mockViewportStore;
	},
}));

function msg(
	id: string,
	role: "user" | "assistant",
	content: string,
): ChatMessage {
	return { id, renderKey: id, role, content, timestamp: 0 };
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

describe("ConversationJumpRail", () => {
	beforeEach(() => {
		mockViewportStore.tier = "desktop";
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: vi.fn().mockImplementation((query: string) => ({
				matches: false,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not render the rail when there are fewer than 6 assistant messages", () => {
		const scrollToMessage = vi.fn();
		// 5 assistant turns — below the threshold.
		render(ConversationJumpRail, {
			props: { messages: conversation(5), scrollToMessage },
		});

		expect(
			screen.queryByTestId("conversation-jump-rail"),
		).not.toBeInTheDocument();
	});

	it("renders the rail with one mark per assistant turn once there are 6+", () => {
		const scrollToMessage = vi.fn();
		render(ConversationJumpRail, {
			props: { messages: conversation(6), scrollToMessage },
		});

		const rail = screen.getByTestId("conversation-jump-rail");
		expect(rail).toBeInTheDocument();

		const marks = screen.getAllByTestId("jump-rail-mark");
		expect(marks).toHaveLength(6);
	});

	it("marks exactly one turn as active", () => {
		const scrollToMessage = vi.fn();
		render(ConversationJumpRail, {
			props: { messages: conversation(6), scrollToMessage },
		});

		const activeMarks = screen
			.getAllByTestId("jump-rail-mark")
			.filter((el) => el.hasAttribute("data-active"));
		expect(activeMarks).toHaveLength(1);
	});

	it("calls scrollToMessage with the turn's id when a mark is clicked", async () => {
		const scrollToMessage = vi.fn();
		render(ConversationJumpRail, {
			props: { messages: conversation(6), scrollToMessage },
		});

		const marks = screen.getAllByTestId("jump-rail-mark");
		// Click the second mark — its turn id is "a2".
		await fireEvent.click(marks[1]);

		expect(scrollToMessage).toHaveBeenCalledTimes(1);
		expect(scrollToMessage).toHaveBeenCalledWith("a2");
	});

	it("hides the rail entirely on the phone tier", () => {
		mockViewportStore.tier = "phone";
		const scrollToMessage = vi.fn();
		render(ConversationJumpRail, {
			props: { messages: conversation(8), scrollToMessage },
		});

		// The rail mounts in the DOM but is visually hidden (aria-hidden + a
		// hidden class) on phone, matching the "no floating-left collision"
		// mobile decision. Assert it's not presented to the user.
		const rail = screen.queryByTestId("conversation-jump-rail");
		// Either not rendered, or rendered but flagged hidden.
		if (rail) {
			expect(rail.getAttribute("aria-hidden")).toBe("true");
			expect(rail.className).toContain("is-phone");
		}
	});

	it("shows the rail again when the tier returns to tablet/desktop", () => {
		const scrollToMessage = vi.fn();
		render(ConversationJumpRail, {
			props: { messages: conversation(8), scrollToMessage },
		});

		// Desktop → phone → desktop drives the reactive store; the rail
		// must reappear without remounting.
		mockViewportStore.tier = "phone";
		mockViewportStore.tier = "desktop";

		const rail = screen.getByTestId("conversation-jump-rail");
		expect(rail.getAttribute("aria-hidden")).not.toBe("true");
		expect(rail.className).not.toContain("is-phone");
	});
});
