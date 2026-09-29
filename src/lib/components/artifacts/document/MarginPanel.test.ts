import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import { makeBlock } from "$lib/shared/artifact-document/blocks";
import MarginPanel from "./MarginPanel.svelte";

function makeRoot(overrides: Partial<ArtifactComment> = {}): ArtifactComment {
	return {
		id: "root-1",
		artifactId: "artifact-1",
		parentId: null,
		anchor: {
			kind: "text",
			blockId: "p1",
			quote: "the flight",
			prefix: "Book ",
			suffix: " to Vienna.",
		},
		author: "user",
		body: "Too early?",
		status: "open",
		createdAt: Date.now(),
		replies: [],
		...overrides,
	};
}

/** Every test below has exactly one implicit tab unless it says otherwise — `mapBlocksToTabs` treats 0-1 tabs as "no scoping", the same shape the pre-redesign suite always ran under. */
const NO_TABS: DocumentTab[] = [];

describe("MarginPanel (the redesign's rail, Wave 2.5 Step 7)", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows the empty state with no comments", () => {
		render(MarginPanel, {
			comments: [],
			blocks: [],
			tabs: NO_TABS,
			activeTabId: "",
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(
			screen.getByText("No comments yet. Select text to start one."),
		).toBeInTheDocument();
	});

	it("renders one thread per root comment", () => {
		render(MarginPanel, {
			comments: [
				makeRoot({ id: "root-1", body: "Too early?" }),
				makeRoot({ id: "root-2", body: "Nice choice." }),
			],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			tabs: NO_TABS,
			activeTabId: "",
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Too early?")).toBeInTheDocument();
		expect(screen.getByText("Nice choice.")).toBeInTheDocument();
	});

	it("shows no moved suffix when the quote resolves cleanly (exact)", () => {
		render(MarginPanel, {
			comments: [makeRoot()],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			tabs: NO_TABS,
			activeTabId: "",
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.queryByText(/moved/i)).not.toBeInTheDocument();
	});

	it("shows a moved suffix when the block changed nearby", () => {
		render(MarginPanel, {
			comments: [makeRoot()],
			blocks: [
				makeBlock("p1", "paragraph", "Reserve the flight for Vienna soon."),
			],
			tabs: NO_TABS,
			activeTabId: "",
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText(/moved/i)).toBeInTheDocument();
	});

	// T10.9: the one state a user cannot cause on purpose — never a crash,
	// the body and thread stay visible, in the removed-text group.
	it("keeps an orphaned comment's body visible, in the removed-text group", async () => {
		render(MarginPanel, {
			comments: [makeRoot({ body: "Too early?" })],
			blocks: [makeBlock("p1", "paragraph", "Nothing about travel here now.")],
			tabs: NO_TABS,
			activeTabId: "",
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		const group = screen.getByTestId("margin-orphaned-group");
		await fireEvent.click(within(group).getByRole("button"));
		expect(within(group).getByText("Too early?")).toBeInTheDocument();
	});

	// T10.9: a row whose anchor never parsed (a malformed/unparseable Anchor
	// in the DB) is an orphan too, never a crash, and its body/thread survive.
	it("treats a null (unparseable) anchor as orphaned too, without throwing", async () => {
		expect(() =>
			render(MarginPanel, {
				comments: [makeRoot({ anchor: null, body: "Still here?" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			}),
		).not.toThrow();
		const group = screen.getByTestId("margin-orphaned-group");
		await fireEvent.click(within(group).getByRole("button"));
		expect(within(group).getByText("Still here?")).toBeInTheDocument();
	});

	it("delegates resolve to onResolve with the comment's own id", async () => {
		const onResolve = vi.fn();
		render(MarginPanel, {
			comments: [makeRoot({ id: "root-9" })],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			tabs: NO_TABS,
			activeTabId: "",
			onResolve,
			onSubmitReply: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(onResolve).toHaveBeenCalledWith("root-9", true);
	});

	// Margin placement follow-up: orphaned threads (nowhere to sit beside)
	// render in their own foldable, count-labelled group, never mixed into
	// the main list the way a plain flat list used to show them.
	describe("the removed-text group", () => {
		function renderWithOneFoundOneGone() {
			return render(MarginPanel, {
				comments: [
					makeRoot({
						id: "found",
						body: "Still relevant",
						anchor: {
							kind: "text",
							blockId: "p1",
							quote: "the flight",
							prefix: "Book ",
							suffix: " to Vienna.",
						},
					}),
					makeRoot({ id: "gone", body: "Where did this go?", anchor: null }),
				],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
		}

		it("names the count, and is collapsed until clicked", async () => {
			renderWithOneFoundOneGone();
			expect(
				screen.getByText("1 comment on text that was removed"),
			).toBeInTheDocument();
			expect(screen.queryByText("Where did this go?")).not.toBeInTheDocument();

			await fireEvent.click(screen.getByRole("button", { name: /removed/i }));
			const group = screen.getByTestId("margin-orphaned-group");
			expect(within(group).getByText("Where did this go?")).toBeInTheDocument();
			expect(
				within(group).queryByText("Still relevant"),
			).not.toBeInTheDocument();
			expect(screen.getByText("Still relevant")).toBeInTheDocument();
		});

		it("shows no orphaned group at all when every comment resolves cleanly", () => {
			render(MarginPanel, {
				comments: [makeRoot()],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.queryByTestId("margin-orphaned-group"),
			).not.toBeInTheDocument();
		});
	});

	// Ruling 61: Open by default, with a quiet "N resolved" toggle to All —
	// never the mockup's own two-button "Open 4 | All 6" filter.
	describe("ruling 61: the Open/All filter", () => {
		function renderOneOpenOneResolved() {
			return render(MarginPanel, {
				comments: [
					makeRoot({ id: "open-1", body: "Still open", status: "open" }),
					makeRoot({
						id: "resolved-1",
						body: "All set",
						status: "resolved",
						anchor: {
							kind: "text",
							blockId: "p2",
							quote: "the hotel",
							prefix: "Book ",
							suffix: " too.",
						},
					}),
				],
				blocks: [
					makeBlock("p1", "paragraph", "Book the flight to Vienna."),
					makeBlock("p2", "paragraph", "Book the hotel too."),
				],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
		}

		it("hides resolved threads by default, with a quiet count toggle", () => {
			renderOneOpenOneResolved();
			expect(screen.getByText("Still open")).toBeInTheDocument();
			expect(screen.queryByText("All set")).not.toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "1 resolved" }),
			).toBeInTheDocument();
		});

		it("reveals resolved threads (still folded) once toggled to All", async () => {
			renderOneOpenOneResolved();
			await fireEvent.click(screen.getByRole("button", { name: "1 resolved" }));

			expect(screen.getByText("Still open")).toBeInTheDocument();
			// Folded to one line that reads the thread's first words (the
			// mockup's fold line); the thread's own actions stay hidden until
			// it is peeked.
			const fold = screen.getByRole("button", {
				name: /Show the full thread/i,
			});
			expect(fold).toHaveTextContent("All set");
			expect(
				screen.queryByRole("button", { name: "Reopen" }),
			).not.toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Show open only" }),
			).toBeInTheDocument();
		});

		it("never shows the toggle at all with nothing resolved", () => {
			render(MarginPanel, {
				comments: [makeRoot({ status: "open" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.queryByText(/resolved/i)).not.toBeInTheDocument();
		});
	});

	// Ruling 61's third point ("tabs show only their own section") applied to
	// the rail: a comment anchored in another tab's own blocks summarizes
	// into "in other tabs" instead of appearing in the main list.
	describe("per-tab scoping", () => {
		const tabs: DocumentTab[] = [
			{ id: "tab-a", title: "Vienna", startBlockId: "p1" },
			{ id: "tab-b", title: "Prague", startBlockId: "p2" },
		];
		const blocks = [
			makeBlock("p1", "paragraph", "Book the flight to Vienna."),
			makeBlock("p2", "paragraph", "Book the train to Prague."),
		];

		it("shows only the active tab's own comment, summarizing the other tab", () => {
			render(MarginPanel, {
				comments: [
					makeRoot({ id: "in-a", body: "About Vienna" }),
					makeRoot({
						id: "in-b",
						body: "About Prague",
						anchor: {
							kind: "text",
							blockId: "p2",
							quote: "the train",
							prefix: "Book ",
							suffix: " to Prague.",
						},
					}),
				],
				blocks,
				tabs,
				activeTabId: "tab-a",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.getByText("About Vienna")).toBeInTheDocument();
			expect(screen.queryByText("About Prague")).not.toBeInTheDocument();
			expect(screen.getByText("In other tabs")).toBeInTheDocument();
			expect(screen.getByText("Prague")).toBeInTheDocument();
			expect(screen.getByText("1 open")).toBeInTheDocument();
			expect(screen.queryByText(/0 resolved/)).not.toBeInTheDocument();
		});

		it("switches the active tab when an other-tab row is clicked", async () => {
			const onActivateTab = vi.fn();
			render(MarginPanel, {
				comments: [
					makeRoot({
						id: "in-b",
						body: "About Prague",
						anchor: {
							kind: "text",
							blockId: "p2",
							quote: "the train",
							prefix: "Book ",
							suffix: " to Prague.",
						},
					}),
				],
				blocks,
				tabs,
				activeTabId: "tab-a",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
				onActivateTab,
			});
			await fireEvent.click(screen.getByRole("button", { name: /Prague/ }));
			expect(onActivateTab).toHaveBeenCalledWith("tab-b");
		});
	});

	// Two-way linking (redesign §3.2): hover/focus on a thread's own card here
	// links it to its words in the text; the reverse direction (a click on
	// those words) is `focusRequest`.
	describe("two-way linking", () => {
		it("reports hover/focus on a thread's card through onActiveCommentChange", async () => {
			const onActiveCommentChange = vi.fn();
			render(MarginPanel, {
				comments: [makeRoot({ id: "root-1" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
				onActiveCommentChange,
			});
			const article = screen.getByTestId("margin-comment");
			await fireEvent.mouseEnter(article);
			expect(onActiveCommentChange).toHaveBeenCalledWith("root-1");
			await fireEvent.mouseLeave(article);
			expect(onActiveCommentChange).toHaveBeenCalledWith(null);
		});

		it("marks the active comment's own card is-active", () => {
			render(MarginPanel, {
				comments: [makeRoot({ id: "root-1" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				activeCommentId: "root-1",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.getByTestId("margin-comment").className).toContain(
				"is-active",
			);
		});

		it("scrolls to and focuses the matching card once focusRequest names it", async () => {
			const scrollIntoView = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoView;
			const { rerender } = render(MarginPanel, {
				comments: [makeRoot({ id: "root-1" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(scrollIntoView).not.toHaveBeenCalled();

			await rerender({
				comments: [makeRoot({ id: "root-1" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				focusRequest: { commentId: "root-1", token: 1 },
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(scrollIntoView).toHaveBeenCalled();
			expect(document.activeElement).toBe(screen.getByTestId("margin-comment"));
		});
	});

	// The owner's walk-through: cards floating at their anchors' heights with
	// uneven gaps read as awkward, and scrolled away with the text. The list
	// is a plain, evenly spaced stack in document order now.
	describe("a plain list in document order", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Book the flight to Vienna."),
			makeBlock("p2", "paragraph", "Then a long lunch at the Cafe Sperl."),
		];
		function thread(
			id: string,
			blockId: string,
			quote: string,
			overrides: Partial<ArtifactComment> = {},
		): ArtifactComment {
			return makeRoot({
				id,
				body: `body of ${id}`,
				anchor: { kind: "text", blockId, quote, prefix: "", suffix: "" },
				...overrides,
			});
		}
		function listedIds(): (string | null)[] {
			return screen
				.getAllByTestId("margin-comment")
				.map((el) => el.getAttribute("data-comment-id"));
		}

		it("lists threads in the order their words appear, not the order they were written", () => {
			render(MarginPanel, {
				comments: [
					thread("second-block", "p2", "lunch", { createdAt: 1 }),
					thread("first-block", "p1", "flight", { createdAt: 2 }),
				],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(listedIds()).toEqual(["first-block", "second-block"]);
		});

		it("orders two threads in one block by where their words start", () => {
			render(MarginPanel, {
				comments: [
					thread("hotel", "p1", "Vienna", { createdAt: 1 }),
					thread("flight", "p1", "flight", { createdAt: 2 }),
				],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(listedIds()).toEqual(["flight", "hotel"]);
		});

		it("never places a card at an anchor's height: no inline offsets", () => {
			render(MarginPanel, {
				comments: [thread("a", "p1", "flight"), thread("b", "p2", "lunch")],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			for (const card of screen.getAllByTestId("margin-comment")) {
				expect(card.getAttribute("style") ?? "").not.toMatch(/top/);
				expect(card.className).not.toContain("positioned");
			}
		});

		it("keeps every card, the removed-text group and the other-tab rows inside one scrolling list", () => {
			render(MarginPanel, {
				comments: [
					thread("placed", "p1", "flight"),
					thread("gone", "p1", "words that are gone"),
				],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			const list = screen.getByTestId("margin-panel-list");
			expect(within(list).getByTestId("margin-comment")).toBeInTheDocument();
			expect(
				within(list).getByTestId("margin-orphaned-group"),
			).toBeInTheDocument();
		});
	});

	describe("the header", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Book the flight to Vienna."),
			makeBlock("p2", "paragraph", "Book the train to Prague."),
		];
		const tabs: DocumentTab[] = [
			{ id: "tab-a", title: "Vienna", startBlockId: "p1" },
			{ id: "tab-b", title: "Prague", startBlockId: "p2" },
		];

		it("names the column and counts the open threads, readable as text", () => {
			render(MarginPanel, {
				comments: [
					makeRoot({ id: "one" }),
					makeRoot({ id: "two" }),
					makeRoot({ id: "done", status: "resolved" }),
				],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.getByRole("heading", { level: 2, name: "Comments" }),
			).toBeInTheDocument();
			expect(screen.getByText("2 open comments")).toBeInTheDocument();
		});

		it("shows no count at all with nothing open", () => {
			render(MarginPanel, {
				comments: [makeRoot({ status: "resolved" })],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.queryByText(/open comment/)).not.toBeInTheDocument();
		});

		it("counts the tab's open threads the way the tab's own badge does, orphaned ones included", () => {
			render(MarginPanel, {
				comments: [
					makeRoot({ id: "placed" }),
					// The words are gone but the block still sits in this tab.
					makeRoot({
						id: "orphan",
						anchor: {
							kind: "text",
							blockId: "p1",
							quote: "words that are gone",
							prefix: "",
							suffix: "",
						},
					}),
				],
				blocks,
				tabs,
				activeTabId: "tab-a",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.getByText("2 open comments")).toBeInTheDocument();
		});
	});

	describe("empty states", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Book the flight to Vienna."),
			makeBlock("p2", "paragraph", "Book the train to Prague."),
		];

		it("names the document, not a tab, when it has one section", () => {
			render(MarginPanel, {
				comments: [],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.getByText("No comments yet. Select text to start one."),
			).toBeInTheDocument();
		});

		it("names the tab when there are several", () => {
			render(MarginPanel, {
				comments: [],
				blocks,
				tabs: [
					{ id: "tab-a", title: "Vienna", startBlockId: "p1" },
					{ id: "tab-b", title: "Prague", startBlockId: "p2" },
				],
				activeTabId: "tab-a",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.getByText("No comments on this tab. Select text to start one."),
			).toBeInTheDocument();
		});

		it("says everything is resolved, not that there are none, when only resolved threads exist", () => {
			render(MarginPanel, {
				comments: [makeRoot({ status: "resolved" })],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.getByText("Every comment here is resolved."),
			).toBeInTheDocument();
		});
	});

	describe("the other-tab rows", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Book the flight to Vienna."),
			makeBlock("p2", "paragraph", "Book the train to Prague."),
			makeBlock("p3", "paragraph", "Book the boat to Bratislava."),
		];
		const tabs: DocumentTab[] = [
			{ id: "tab-a", title: "Vienna", startBlockId: "p1" },
			{ id: "tab-b", title: "Prague", startBlockId: "p2" },
			{ id: "tab-c", title: "Bratislava", startBlockId: "p3" },
		];
		function onBlock(
			id: string,
			blockId: string,
			extra: Partial<ArtifactComment>,
		) {
			return makeRoot({
				id,
				anchor: {
					kind: "text",
					blockId,
					quote: "Book",
					prefix: "",
					suffix: "",
				},
				...extra,
			});
		}

		it("shows only the counts that are not zero, joined with a dot", () => {
			render(MarginPanel, {
				comments: [
					onBlock("b-open", "p2", {}),
					onBlock("b-done", "p2", { status: "resolved" }),
					onBlock("c-done", "p3", { status: "resolved" }),
				],
				blocks,
				tabs,
				activeTabId: "tab-a",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.getByText("1 open · 1 resolved")).toBeInTheDocument();
			expect(screen.getByText("1 resolved")).toBeInTheDocument();
			expect(screen.queryByText(/\b0 /)).not.toBeInTheDocument();
		});

		it("counts an orphaned thread in another tab the way that tab's badge does", () => {
			render(MarginPanel, {
				comments: [
					onBlock("b-placed", "p2", {}),
					// Its words are gone, but its block still sits in Prague.
					makeRoot({
						id: "b-orphan",
						anchor: {
							kind: "text",
							blockId: "p2",
							quote: "words that are gone",
							prefix: "",
							suffix: "",
						},
					}),
				],
				blocks,
				tabs,
				activeTabId: "tab-a",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.getByText("2 open")).toBeInTheDocument();
		});

		it("leaves out a tab with no comments", () => {
			render(MarginPanel, {
				comments: [onBlock("b-open", "p2", {})],
				blocks,
				tabs,
				activeTabId: "tab-a",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.queryByText("Bratislava")).not.toBeInTheDocument();
		});
	});

	// Scroll-follow: the caller names the thread the reader is on; the list
	// brings its card into view — and keeps its hands off while the reader is
	// using the list.
	describe("bringing the followed thread into view", () => {
		const blocks = [makeBlock("p1", "paragraph", "Book the flight to Vienna.")];
		function props(extra: Record<string, unknown> = {}) {
			return {
				comments: [makeRoot({ id: "root-1" })],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
				...extra,
			};
		}

		it("scrolls the named card into view without moving keyboard focus", async () => {
			const scrollIntoView = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoView;
			const { rerender } = render(MarginPanel, props());
			await rerender(
				props({ revealRequest: { commentId: "root-1", token: 1 } }),
			);
			expect(scrollIntoView).toHaveBeenCalledTimes(1);
			expect(document.activeElement).not.toBe(
				screen.getByTestId("margin-comment"),
			);
		});

		it("leaves the list where it is while the pointer is over it", async () => {
			const scrollIntoView = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoView;
			const { rerender } = render(MarginPanel, props());
			await fireEvent.pointerEnter(screen.getByTestId("margin-panel-list"));
			await rerender(
				props({ revealRequest: { commentId: "root-1", token: 1 } }),
			);
			expect(scrollIntoView).not.toHaveBeenCalled();
		});

		it("leaves the list where it is while focus is inside it", async () => {
			const scrollIntoView = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoView;
			const { rerender } = render(MarginPanel, props());
			await fireEvent.focusIn(screen.getByTestId("margin-panel-list"));
			await rerender(
				props({ revealRequest: { commentId: "root-1", token: 1 } }),
			);
			expect(scrollIntoView).not.toHaveBeenCalled();
		});

		it("follows again once the pointer has left", async () => {
			const scrollIntoView = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoView;
			const { rerender } = render(MarginPanel, props());
			const list = screen.getByTestId("margin-panel-list");
			await fireEvent.pointerEnter(list);
			await fireEvent.pointerLeave(list);
			await rerender(
				props({ revealRequest: { commentId: "root-1", token: 1 } }),
			);
			expect(scrollIntoView).toHaveBeenCalledTimes(1);
		});

		it("a forced request (a card that was just created) ignores that guard", async () => {
			const scrollIntoView = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoView;
			const { rerender } = render(MarginPanel, props());
			await fireEvent.pointerEnter(screen.getByTestId("margin-panel-list"));
			await rerender(
				props({
					revealRequest: { commentId: "root-1", token: 1, force: true },
				}),
			);
			expect(scrollIntoView).toHaveBeenCalledTimes(1);
		});

		it("does not replay a request it has already applied", async () => {
			const scrollIntoView = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoView;
			const request = { commentId: "root-1", token: 1 };
			const { rerender } = render(MarginPanel, props());
			await rerender(props({ revealRequest: request }));
			await rerender(
				props({ revealRequest: { ...request }, activeCommentId: "root-1" }),
			);
			expect(scrollIntoView).toHaveBeenCalledTimes(1);
		});
	});

	describe("a click on the card", () => {
		const blocks = [makeBlock("p1", "paragraph", "Book the flight to Vienna.")];
		function renderOne(extra: Record<string, unknown> = {}) {
			return render(MarginPanel, {
				comments: [makeRoot({ id: "root-1" })],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
				...extra,
			});
		}

		it("takes the reader to the thread's words", async () => {
			const onGotoAnchor = vi.fn();
			renderOne({ onGotoAnchor });
			await fireEvent.click(screen.getByText("Too early?"));
			expect(onGotoAnchor).toHaveBeenCalledWith(
				"p1",
				expect.any(Number),
				expect.any(Number),
			);
		});

		it("leaves clicks on the card's own controls to those controls", async () => {
			const onGotoAnchor = vi.fn();
			const onResolve = vi.fn();
			renderOne({ onGotoAnchor, onResolve });
			await fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
			expect(onResolve).toHaveBeenCalled();
			expect(onGotoAnchor).not.toHaveBeenCalled();
		});

		it("does not jump while the reader is selecting the card's text", async () => {
			const onGotoAnchor = vi.fn();
			renderOne({ onGotoAnchor });
			const spy = vi
				.spyOn(window, "getSelection")
				.mockReturnValue({ toString: () => "Too" } as unknown as Selection);
			await fireEvent.click(screen.getByText("Too early?"));
			spy.mockRestore();
			expect(onGotoAnchor).not.toHaveBeenCalled();
		});

		it("goes nowhere for a thread whose words are gone", async () => {
			const onGotoAnchor = vi.fn();
			render(MarginPanel, {
				comments: [makeRoot({ id: "gone", anchor: null, body: "Lost" })],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
				onGotoAnchor,
			});
			await fireEvent.click(screen.getByRole("button", { name: /removed/i }));
			await fireEvent.click(screen.getByText("Lost"));
			expect(onGotoAnchor).not.toHaveBeenCalled();
		});
	});

	describe("the refusal card", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Book the flight to Vienna."),
			makeBlock("p2", "paragraph", "Book the hotel in Vienna."),
			makeBlock("p3", "paragraph", "Book the train to Prague."),
		];
		function refusalOn(
			blockId: string | null,
			extra: Record<string, unknown> = {},
		) {
			return {
				blockId,
				message: "Alfy left one part alone because you had changed it.",
				items: [{ label: "Book the hotel", reason: "you changed it" }],
				askAgainLabel: "Ask again",
				onAskAgain: vi.fn(),
				dismissLabel: "Dismiss",
				onDismiss: vi.fn(),
				...extra,
			};
		}
		function onBlock(id: string, blockId: string): ArtifactComment {
			return makeRoot({
				id,
				anchor: {
					kind: "text",
					blockId,
					quote: "Book",
					prefix: "",
					suffix: "",
				},
			});
		}
		function listOrder(): (string | null)[] {
			const list = screen.getByTestId("margin-panel-list");
			return within(list)
				.getAllByTestId(/margin-comment|refusal-notice/)
				.map((el) => el.getAttribute("data-comment-id") ?? "refusal");
		}

		it("sits at its line's position among the threads, one of the comment family", () => {
			render(MarginPanel, {
				comments: [onBlock("on-p1", "p1"), onBlock("on-p3", "p3")],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				refusal: refusalOn("p2"),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(listOrder()).toEqual(["on-p1", "refusal", "on-p3"]);
		});

		it("comes before the threads on the same line", () => {
			render(MarginPanel, {
				comments: [onBlock("on-p1", "p1"), onBlock("on-p2", "p2")],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				refusal: refusalOn("p2"),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(listOrder()).toEqual(["on-p1", "refusal", "on-p2"]);
		});

		it("sits at the end when its line is below every thread", () => {
			render(MarginPanel, {
				comments: [onBlock("on-p1", "p1")],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				refusal: refusalOn("p3"),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(listOrder()).toEqual(["on-p1", "refusal"]);
		});

		it("sits at the top when its line is in another tab, so it can still be seen", () => {
			render(MarginPanel, {
				comments: [onBlock("on-p1", "p1")],
				blocks,
				tabs: [
					{ id: "tab-a", title: "Vienna", startBlockId: "p1" },
					{ id: "tab-b", title: "Prague", startBlockId: "p3" },
				],
				activeTabId: "tab-a",
				refusal: refusalOn("p3"),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(listOrder()).toEqual(["refusal", "on-p1"]);
		});

		it("shows the refusal even when there is no thread to sit beside", () => {
			render(MarginPanel, {
				comments: [],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				refusal: refusalOn("p2"),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.getByTestId("refusal-notice")).toBeInTheDocument();
			expect(screen.queryByText(/No comments yet/)).not.toBeInTheDocument();
		});

		it("hands its actions to the card", async () => {
			const refusal = refusalOn("p2");
			render(MarginPanel, {
				comments: [],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				refusal,
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			await fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
			await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
			expect(refusal.onAskAgain).toHaveBeenCalledTimes(1);
			expect(refusal.onDismiss).toHaveBeenCalledTimes(1);
		});
	});

	// The phone sheet and the narrow drawer have no text beside them: refusal
	// first, then every tab's threads under its name, then removed text.
	describe("the grouped layout (phone sheet and narrow drawer)", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Book the flight to Vienna."),
			makeBlock("p2", "paragraph", "Book the train to Prague."),
		];
		const tabs: DocumentTab[] = [
			{ id: "tab-a", title: "Vienna", startBlockId: "p1" },
			{ id: "tab-b", title: "Prague", startBlockId: "p2" },
		];
		function onBlock(id: string, blockId: string): ArtifactComment {
			return makeRoot({
				id,
				body: `body of ${id}`,
				anchor: {
					kind: "text",
					blockId,
					quote: "Book",
					prefix: "",
					suffix: "",
				},
			});
		}
		const refusal = {
			blockId: "p2",
			message: "Alfy left one part alone because you had changed it.",
			items: [],
		};

		it("puts the refusal note first, then each tab's threads under the tab's name", () => {
			render(MarginPanel, {
				comments: [onBlock("in-b", "p2"), onBlock("in-a", "p1")],
				blocks,
				tabs,
				activeTabId: "tab-b",
				layout: "grouped",
				refusal,
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			const list = screen.getByTestId("margin-panel-list");
			const order = within(list)
				.getAllByTestId(/margin-comment|refusal-notice/)
				.map((el) => el.getAttribute("data-comment-id") ?? "refusal");
			expect(order).toEqual(["refusal", "in-a", "in-b"]);
			const headings = within(list)
				.getAllByRole("heading", { level: 3 })
				.map((h) => h.textContent);
			expect(headings).toEqual(["Vienna", "Prague"]);
		});

		it("lists every tab, so it has no 'in other tabs' summary", () => {
			render(MarginPanel, {
				comments: [onBlock("in-a", "p1"), onBlock("in-b", "p2")],
				blocks,
				tabs,
				activeTabId: "tab-a",
				layout: "grouped",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.queryByText("In other tabs")).not.toBeInTheDocument();
			expect(screen.getByText("body of in-b")).toBeInTheDocument();
		});

		it("has no tab headings for a document with one section", () => {
			render(MarginPanel, {
				comments: [onBlock("in-a", "p1")],
				blocks,
				tabs: NO_TABS,
				activeTabId: "",
				layout: "grouped",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
			expect(screen.getByText("body of in-a")).toBeInTheDocument();
		});

		it("keeps the removed-text group at the very end", () => {
			render(MarginPanel, {
				comments: [
					makeRoot({ id: "gone", anchor: null, body: "Lost words" }),
					onBlock("in-a", "p1"),
				],
				blocks,
				tabs,
				activeTabId: "tab-a",
				layout: "grouped",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			const list = screen.getByTestId("margin-panel-list");
			const last = list.lastElementChild;
			expect(last?.getAttribute("data-testid")).toBe("margin-orphaned-group");
		});
	});

	describe("the close button", () => {
		it("appears only when the caller can be closed, and calls it", async () => {
			const onClose = vi.fn();
			const { rerender } = render(MarginPanel, {
				comments: [],
				blocks: [],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.queryByRole("button", { name: "Close" }),
			).not.toBeInTheDocument();
			await rerender({
				comments: [],
				blocks: [],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
				onClose,
			});
			await fireEvent.click(screen.getByRole("button", { name: "Close" }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});
