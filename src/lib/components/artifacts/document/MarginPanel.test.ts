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
			screen.getByText("No comments on this tab. Select text to start one."),
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
			expect(screen.getByText("1 comment on text that was removed")).toBeInTheDocument();
			expect(screen.queryByText("Where did this go?")).not.toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: /removed/i }),
			);
			const group = screen.getByTestId("margin-orphaned-group");
			expect(within(group).getByText("Where did this go?")).toBeInTheDocument();
			expect(within(group).queryByText("Still relevant")).not.toBeInTheDocument();
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
			expect(screen.getByRole("button", { name: "1 resolved" })).toBeInTheDocument();
		});

		it("reveals resolved threads (still folded) once toggled to All", async () => {
			renderOneOpenOneResolved();
			await fireEvent.click(screen.getByRole("button", { name: "1 resolved" }));

			expect(screen.getByText("Still open")).toBeInTheDocument();
			// Folded: only the one-line preview shows (its own quote, here — the
			// resolved thread's own BODY text, "All set", stays hidden until peeked).
			expect(screen.queryByText("All set")).not.toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /Show the full thread/i }),
			).toBeInTheDocument();
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
			expect(screen.getByText("1 open · 0 resolved")).toBeInTheDocument();
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

		it("reports its own resolved anchors through onAnchorsChange", () => {
			const onAnchorsChange = vi.fn();
			render(MarginPanel, {
				comments: [makeRoot({ id: "root-1", status: "resolved" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
				onAnchorsChange,
			});
			expect(onAnchorsChange).toHaveBeenCalledWith([
				expect.objectContaining({
					commentId: "root-1",
					blockId: "p1",
					resolved: true,
				}),
			]);
		});
	});

	// RV-1B, Review Focus 7 / hunt item 7: "performance with ~50 comments (no
	// layout thrash on each keystroke)". `measureAnchorTops`'s own comment
	// claims its one-querySelector-per-anchored-block pass is "cheap enough to
	// re-run on every edit, since a Document only ever has a handful of open
	// comment threads at once" — an assumption never checked at the ~50-comment
	// scale the plan itself names. `DocumentBody.svelte`'s `handleUpdate` runs
	// on EVERY keystroke and reassigns `blocks`, and the effect that calls
	// `measureAnchorTops` has no debounce, so — before this test's fix — 10
	// rapid `blocks` updates (a fast typist's 10 keystrokes) each re-ran the
	// full pass, forcing 10 x 50 = 500 `getBoundingClientRect` reflows instead
	// of coalescing into one.
	describe("re-measurement under rapid edits (~50 comments)", () => {
		const BLOCK_COUNT = 50;

		function makeManyBlocks(revision: number) {
			return Array.from({ length: BLOCK_COUNT }, (_, i) =>
				makeBlock(`p${i}`, "paragraph", `Paragraph ${i} rev ${revision}.`),
			);
		}

		function makeManyComments() {
			return Array.from({ length: BLOCK_COUNT }, (_, i) =>
				makeRoot({
					id: `root-${i}`,
					body: `Comment ${i}`,
					anchor: {
						kind: "text",
						blockId: `p${i}`,
						quote: `Paragraph ${i}`,
						prefix: "",
						suffix: " rev 0.",
					},
				}),
			);
		}

		function buildContentEl(): HTMLDivElement {
			const el = document.createElement("div");
			for (let i = 0; i < BLOCK_COUNT; i += 1) {
				const child = document.createElement("p");
				child.dataset.blockId = `p${i}`;
				el.appendChild(child);
			}
			document.body.appendChild(el);
			return el;
		}

		afterEach(() => {
			vi.useRealTimers();
		});

		it("coalesces a burst of rapid blocks updates into one measurement pass instead of one per update", async () => {
			vi.useFakeTimers();
			const contentEl = buildContentEl();
			const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

			const { rerender } = render(MarginPanel, {
				comments: makeManyComments(),
				blocks: makeManyBlocks(0),
				contentEl,
				tabs: NO_TABS,
				activeTabId: "",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			// Let the initial mount's own measurement settle before starting the
			// burst, so only the burst's own calls are counted below.
			await vi.runAllTimersAsync();
			rectSpy.mockClear();

			// A burst of 10 rapid `blocks` reassignments — the exact shape of 10
			// fast keystrokes, each running `DocumentBody.svelte`'s
			// `handleUpdate` → `updateBlocksFromMarkdown` — with NO idle gap
			// between them, matching real typing speed (well under the debounce
			// window between each keystroke).
			const KEYSTROKES = 10;
			for (let revision = 1; revision <= KEYSTROKES; revision += 1) {
				await rerender({
					comments: makeManyComments(),
					blocks: makeManyBlocks(revision),
					contentEl,
					tabs: NO_TABS,
					activeTabId: "",
					onResolve: vi.fn(),
					onSubmitReply: vi.fn(),
				});
			}

			// Still coalescing: nothing has measured yet because the debounce
			// window has not elapsed since the LAST update in the burst.
			expect(rectSpy).not.toHaveBeenCalled();

			// Once the burst ends and the debounce window elapses, exactly one
			// measurement pass runs — not one per keystroke. One pass reads
			// `contentEl`'s own rect once (for `containerTop`) plus one rect per
			// anchored block, so BLOCK_COUNT + 1 calls total; ten un-coalesced
			// keystrokes would have cost 10x that (510, asserted red above).
			await vi.runAllTimersAsync();
			expect(rectSpy.mock.calls.length).toBeLessThanOrEqual(BLOCK_COUNT + 1);

			contentEl.remove();
		});
	});
});
