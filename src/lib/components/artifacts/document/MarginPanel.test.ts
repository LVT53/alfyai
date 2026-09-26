import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("MarginPanel", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows the empty state with no comments", () => {
		render(MarginPanel, {
			comments: [],
			blocks: [],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("No comments yet.")).toBeInTheDocument();
	});

	it("renders one thread per root comment", () => {
		render(MarginPanel, {
			comments: [
				makeRoot({ id: "root-1", body: "Too early?" }),
				makeRoot({ id: "root-2", body: "Nice choice." }),
			],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Too early?")).toBeInTheDocument();
		expect(screen.getByText("Nice choice.")).toBeInTheDocument();
	});

	it("marks a comment Exact when its quote resolves cleanly", () => {
		render(MarginPanel, {
			comments: [makeRoot()],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Exact")).toBeInTheDocument();
	});

	it("marks a comment Moved when its block changed nearby", () => {
		render(MarginPanel, {
			comments: [makeRoot()],
			blocks: [
				makeBlock("p1", "paragraph", "Reserve the flight for Vienna soon."),
			],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Moved")).toBeInTheDocument();
	});

	// T10.9: the one state a user cannot cause on purpose — never a crash,
	// the body and thread stay visible.
	it("marks a comment Orphaned, keeping its body, once its text is gone", () => {
		render(MarginPanel, {
			comments: [makeRoot({ body: "Too early?" })],
			blocks: [makeBlock("p1", "paragraph", "Nothing about travel here now.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Orphaned")).toBeInTheDocument();
		expect(screen.getByText("Too early?")).toBeInTheDocument();
	});

	// T10.9: a row whose anchor never parsed (a malformed/unparseable Anchor
	// in the DB) is an orphan too, never a crash, and its body/thread survive.
	it("marks a null (unparseable) anchor Orphaned too, without throwing", () => {
		expect(() =>
			render(MarginPanel, {
				comments: [makeRoot({ anchor: null, body: "Still here?" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			}),
		).not.toThrow();
		expect(screen.getByText("Orphaned")).toBeInTheDocument();
		expect(screen.getByText("Still here?")).toBeInTheDocument();
	});

	it("delegates resolve to onResolve with the comment's own id", async () => {
		const onResolve = vi.fn();
		render(MarginPanel, {
			comments: [makeRoot({ id: "root-9" })],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve,
			onSubmitReply: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(onResolve).toHaveBeenCalledWith("root-9", true);
	});

	// Margin placement follow-up: orphaned threads (nowhere to sit beside)
	// render in their own clearly-labelled group, never mixed into the main
	// list the way a plain flat list used to show them.
	it("puts an orphaned comment in its own labelled group, separate from a resolved one", () => {
		render(MarginPanel, {
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
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});

		const orphanedGroup = screen.getByTestId("margin-orphaned-group");
		expect(orphanedGroup).toBeInTheDocument();
		expect(
			within(orphanedGroup).getByText("Where did this go?"),
		).toBeInTheDocument();
		expect(
			within(orphanedGroup).queryByText("Still relevant"),
		).not.toBeInTheDocument();
		expect(screen.getByText("Still relevant")).toBeInTheDocument();
	});

	it("shows no orphaned group at all when every comment resolves cleanly", () => {
		render(MarginPanel, {
			comments: [makeRoot()],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(
			screen.queryByTestId("margin-orphaned-group"),
		).not.toBeInTheDocument();
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
